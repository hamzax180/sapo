/* =================================================================
   worker/pipeline.js — QUEUED -> BUILDING -> STARTING -> RUNNING
   -----------------------------------------------------------------
   The whole deployment in one place, so the state machine is
   readable rather than scattered across request handlers.

   Nothing here runs inside an HTTP request. A build takes minutes;
   holding a request open for it means a proxy timeout mid-build and
   a deployment whose real state nobody knows.

   Every failure path must leave the row in a terminal state with a
   reason attached. A deployment stuck in BUILDING forever is worse
   than one marked FAILED, because the user cannot retry it.
   ================================================================= */
"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { cfg } = require("../config");
const { query } = require("../db");
const engine = require("../docker/engine");
const caddy = require("../proxy/caddy");
const capacity = require("../monitor/capacity");
const detect = require("../framework/detect");
const dockerfiles = require("../framework/dockerfiles");
const secrets = require("../secrets");

/* ---------- logging ----------
   Build output goes to the database, not only to the container, because the
   build container is gone by the time anyone asks what went wrong. */
async function log(deploymentId, phase, line, stream) {
  const text = String(line).slice(0, 4000);
  try {
    await query(
      "INSERT INTO deployment_logs (deployment_id, phase, stream, line) VALUES ($1,$2,$3,$4)",
      [deploymentId, phase, stream || "stdout", text]
    );
  } catch (e) {
    // Losing a log line must never abort a deploy.
    console.error("[worker] log write failed:", e.message);
  }
}

async function setStatus(deploymentId, status, extra) {
  const fields = Object.assign({ status }, extra || {});
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => k + "=$" + (i + 2)).join(", ");
  await query(
    "UPDATE deployments SET " + sets + ", updated_at=now() WHERE id=$1",
    [deploymentId].concat(keys.map((k) => fields[k]))
  );
}

async function fail(deploymentId, reason) {
  await log(deploymentId, "system", "FAILED: " + reason, "stderr");
  await setStatus(deploymentId, "FAILED", { error: String(reason).slice(0, 1000) });
  // Best effort: a half-built container from this attempt must not linger.
  try { await engine.removeContainer(deploymentId); } catch (e) { /* nothing to remove */ }
  return { ok: false, error: reason };
}

/* ---------- env ---------- */
async function projectEnv(projectId) {
  const { rows } = await query("SELECT key, value_enc FROM project_env WHERE project_id=$1", [projectId]);
  const out = {};
  for (const r of rows) {
    // An unreadable secret is skipped and never logged — the value is the
    // thing being protected, and a decrypt error message can leak its shape.
    try { out[r.key] = secrets.decrypt(r.value_enc); } catch (e) { /* skip */ }
  }
  return out;
}

/* ---------- build context ----------
   Source is staged into a directory the platform owns, the generated
   Dockerfile is written beside it, and docker build takes it from there.
   Nothing in the staged source is ever executed by the host. */
async function stageBuildContext(deploymentId, sourceDir) {
  const dest = path.join(cfg.buildRoot, String(deploymentId));
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(sourceDir, dest, { recursive: true, dereference: false, force: true });
  return dest;
}

async function cleanupBuildContext(deploymentId) {
  const dir = path.join(cfg.buildRoot, String(deploymentId));
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (e) { console.error("[worker] could not clean", dir, e.message); }
}

/* ---------- the pipeline ---------- */

/**
 * @param {object} dep        the deployments row
 * @param {string} sourceDir  where the source currently sits on disk
 */
async function deploy(dep, sourceDir) {
  const id = dep.id;

  try {
    // --- 1. admission -------------------------------------------------
    const admit = await capacity.canAdmit({ memoryMb: dep.memory_mb });
    if (!admit.ok) {
      return fail(id, "this server cannot take another app right now — " + admit.reasons.join("; "));
    }

    // --- 2. detect ----------------------------------------------------
    await setStatus(id, "BUILDING");
    await log(id, "system", "Inspecting the project");

    const spec = detect.detect(sourceDir);
    if (!spec) {
      return fail(id, "could not work out how to build this project — add a deploy.json declaring framework, buildCommand, startCommand and port");
    }
    await log(id, "system", "Detected " + spec.framework + (spec.declared ? " (declared)" : " (auto)"));

    // --- 3. generate the recipe ---------------------------------------
    let recipe;
    try { recipe = dockerfiles.generate(spec); }
    catch (e) { return fail(id, e.message); }

    const ctx = await stageBuildContext(id, sourceDir);
    await fsp.writeFile(path.join(ctx, "Dockerfile"), recipe.dockerfile, "utf8");
    await fsp.writeFile(path.join(ctx, ".dockerignore"), dockerfiles.dockerignore(), "utf8");
    for (const name of Object.keys(recipe.extraFiles)) {
      await fsp.writeFile(path.join(ctx, name), recipe.extraFiles[name], "utf8");
    }

    // --- 4. build (inside a container, never on the host) --------------
    await log(id, "system", "Building the image");
    const built = await engine.buildImage({
      deploymentId: id,
      contextDir: ctx,
      onLine: (line, stream) => log(id, "build", line, stream)
    });
    if (!built.ok) {
      await cleanupBuildContext(id);
      const tail = (built.stderr || built.stdout || "").trim().split("\n").slice(-3).join(" | ");
      return fail(id, built.timedOut ? "the build timed out" : ("the build failed — " + (tail || "see build logs")));
    }

    // --- 5. run -------------------------------------------------------
    await setStatus(id, "STARTING", { image_name: engine.imageName(id), internal_port: spec.port });
    await log(id, "system", "Starting the container");

    // This deployment's own isolated network, so it shares one with no other
    // user container.
    const net = await engine.ensureDeploymentNetwork(id);
    if (!net.ok) {
      await cleanupBuildContext(id);
      return fail(id, "could not create the app network — " + (net.error || "unknown error"));
    }
    // A previous revision may still be up; replacing it is what makes
    // redeploy actually mean redeploy.
    await engine.removeContainer(id);

    const env = await projectEnv(dep.project_id);
    const run = await engine.runApp({
      deploymentId: id,
      port: spec.port,
      cpu: dep.cpu_limit,
      memoryMb: dep.memory_mb,
      pids: dep.pids_limit,
      env: env,
      // A read-only root breaks anything that writes beside its own files.
      // Next caches into .next at runtime, so it gets a writable root; the
      // other three do not need one.
      readOnly: spec.framework !== "nextjs"
    });
    if (!run.ok) {
      await cleanupBuildContext(id);
      return fail(id, "the container did not start — " + (run.error || "unknown error"));
    }

    // --- 6. route -----------------------------------------------------
    // Caddy has to join this app's network before it can dial the container;
    // on its own network the app is reachable by nothing at all.
    const attached = await engine.connectProxy(id);
    if (!attached.ok) {
      await log(id, "system", "WARNING: could not attach the proxy to the app network — " +
        (attached.error || ""), "stderr");
    }

    const routed = await caddy.addRoute(dep.domain, run.name, spec.port);
    if (!routed.ok) {
      // Not fatal. The container is healthy and the route can be reconciled;
      // failing here would mark a working app as broken.
      await log(id, "system", "WARNING: could not add the proxy route — " + (routed.error || ""), "stderr");
    }

    // --- 7. settle ----------------------------------------------------
    const healthy = await waitForRunning(id, 30000);
    if (!healthy.ok) {
      await cleanupBuildContext(id);
      return fail(id, healthy.reason);
    }

    await setStatus(id, "RUNNING", { container_name: run.name, error: null });
    await log(id, "system", "Live at https://" + dep.domain);
    await cleanupBuildContext(id);
    return { ok: true, domain: dep.domain, url: "https://" + dep.domain };

  } catch (e) {
    await cleanupBuildContext(id).catch(() => {});
    return fail(id, e.message || String(e));
  }
}

/**
 * A container that starts and immediately exits is the most common
 * deployment failure there is — a wrong start command, a missing env var, a
 * port mismatch. Watching for a few seconds turns that into a clear FAILED
 * with the exit code, instead of a RUNNING row pointing at a dead container.
 */
async function waitForRunning(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = await engine.inspectState(id);
    last = st;
    if (!st.exists) return { ok: false, reason: "the container disappeared right after starting" };
    if (st.status === "running" && st.restarts === 0) {
      // Hold briefly: a process that crashes on its first request still
      // reports running for a moment.
      await new Promise((r) => setTimeout(r, 2000));
      const again = await engine.inspectState(id);
      if (again.status === "running") return { ok: true };
      last = again;
      continue;
    }
    if (st.status === "exited") {
      const l = await engine.logs(id, { tail: 20 });
      const tail = (l.out || "").trim().split("\n").slice(-3).join(" | ");
      return { ok: false, reason: "the app exited immediately with code " + st.exitCode + (tail ? " — " + tail : "") };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, reason: "the app did not become healthy within 30s (last state: " + (last && last.status) + ")" };
}

/* ---------- lifecycle actions ---------- */

async function stop(dep) {
  await engine.stop(dep.id);
  await caddy.removeRoute(dep.domain);
  await setStatus(dep.id, "STOPPED");
  await log(dep.id, "system", "Stopped");
  return { ok: true };
}

async function start(dep) {
  await setStatus(dep.id, "STARTING");
  const r = await engine.start(dep.id);
  if (!r.ok) return fail(dep.id, "could not start the container — " + r.stderr.trim());
  const healthy = await waitForRunning(dep.id, 30000);
  if (!healthy.ok) return fail(dep.id, healthy.reason);
  await caddy.addRoute(dep.domain, engine.containerName(dep.id), dep.internal_port || 3000);
  await setStatus(dep.id, "RUNNING", { error: null });
  await log(dep.id, "system", "Started");
  return { ok: true };
}

async function restart(dep) {
  await setStatus(dep.id, "STARTING");
  const r = await engine.restart(dep.id);
  if (!r.ok) return fail(dep.id, "could not restart the container — " + r.stderr.trim());
  const healthy = await waitForRunning(dep.id, 30000);
  if (!healthy.ok) return fail(dep.id, healthy.reason);
  await setStatus(dep.id, "RUNNING", { error: null });
  await log(dep.id, "system", "Restarted");
  return { ok: true };
}

/** Full teardown, in the order the spec lays out. */
async function destroy(dep) {
  await caddy.removeRoute(dep.domain);
  await engine.removeContainer(dep.id);
  await engine.removeImage(dep.id);
  // After the container is gone, or the network still has a member and the
  // rm is refused — leaking one dead network per deleted deployment.
  await engine.removeDeploymentNetwork(dep.id);
  await cleanupBuildContext(dep.id);
  await setStatus(dep.id, "DELETED", { container_name: null, image_name: null });
  await log(dep.id, "system", "Deleted");
  return { ok: true };
}

module.exports = {
  deploy, stop, start, restart, destroy,
  setStatus, log, waitForRunning, cleanupBuildContext, projectEnv
};
