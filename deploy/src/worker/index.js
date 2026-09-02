/* =================================================================
   worker/index.js — the queue loop
   -----------------------------------------------------------------
   Postgres IS the queue. At ten clients, adding Redis or a broker
   would be a second thing to run, monitor and back up in exchange
   for throughput nobody needs. SELECT ... FOR UPDATE SKIP LOCKED is
   a real work queue: two workers polling the same table never hand
   the same row to both, so scaling out later is starting a second
   process, not swapping the queue.

   The loop also reconciles. Docker is the source of truth for what
   is actually running, and the database drifts from it whenever the
   host reboots or a container is killed out of band.
   ================================================================= */
"use strict";

const path = require("path");
const { cfg } = require("../config");
const { pool, query, many } = require("../db");
const engine = require("../docker/engine");
const caddy = require("../proxy/caddy");
const capacity = require("../monitor/capacity");
const pipeline = require("./pipeline");
const cleanup = require("../monitor/cleanup");

const POLL_MS = 2000;
const RECONCILE_MS = 60000;
const CLEANUP_MS = 15 * 60 * 1000;

let running = true;

/**
 * Claim one queued deployment.
 *
 * FOR UPDATE SKIP LOCKED is the whole reason this is safe to run in more
 * than one process: the row is locked for this transaction, and any other
 * worker looking at the same instant skips past it rather than blocking or
 * double-claiming.
 */
async function claimNext() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM deployments
        WHERE status = 'QUEUED' AND host_id = $1
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [cfg.hostId]
    );
    if (!rows.length) { await client.query("COMMIT"); return null; }
    const dep = rows[0];
    // Move it out of QUEUED inside the same transaction, so a crash between
    // claiming and building cannot leave it invisible to every worker.
    await client.query("UPDATE deployments SET status='BUILDING', updated_at=now() WHERE id=$1", [dep.id]);
    await client.query("COMMIT");
    return dep;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (e2) { /* already gone */ }
    console.error("[worker] claim failed:", e.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Claim one queued lifecycle action, the same way deployments are claimed.
 *
 * These live in the worker rather than the API because they end in docker
 * commands, and the API has no socket to run them against.
 */
async function claimNextAction() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM deployments
        WHERE pending_action IS NOT NULL AND host_id = $1
        ORDER BY updated_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [cfg.hostId]
    );
    if (!rows.length) { await client.query("COMMIT"); return null; }
    const dep = rows[0];
    // Clear it inside the same transaction: a crash mid-action must not leave
    // the row spinning through the same command forever.
    await client.query("UPDATE deployments SET pending_action=NULL WHERE id=$1", [dep.id]);
    await client.query("COMMIT");
    return dep;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (e2) { /* already gone */ }
    console.error("[worker] action claim failed:", e.message);
    return null;
  } finally {
    client.release();
  }
}

const ACTIONS = {
  stop: (dep) => pipeline.stop(dep),
  start: (dep) => pipeline.start(dep),
  restart: (dep) => pipeline.restart(dep),
  destroy: (dep) => pipeline.destroy(dep)
};

async function tickAction() {
  const dep = await claimNextAction();
  if (!dep) return false;
  const fn = ACTIONS[dep.pending_action];
  if (!fn) {
    console.error("[worker] unknown action", dep.pending_action, "on", dep.id);
    return true;
  }
  console.log("[worker]", dep.pending_action, dep.id);
  try {
    const r = await fn(dep);
    console.log("[worker]", dep.id, dep.pending_action, r && r.ok === false ? "-> FAILED " + r.error : "-> ok");
  } catch (e) {
    console.error("[worker]", dep.id, dep.pending_action, "threw:", e.message);
    await pipeline.log(dep.id, "system", dep.pending_action + " failed: " + e.message, "stderr");
  }
  return true;
}

function sourceDirFor(dep) {
  // Phase 1: the API writes the upload here. Phase 2 swaps this for a pull
  // from object storage using dep.source_key — the pipeline takes a
  // directory either way, so only this function changes.
  return path.join(cfg.buildRoot, "src", String(dep.id));
}

async function tick() {
  const dep = await claimNext();
  if (!dep) return false;
  console.log("[worker] deploying", dep.id, "for project", dep.project_id);
  const res = await pipeline.deploy(dep, sourceDirFor(dep));
  console.log("[worker]", dep.id, res.ok ? "-> RUNNING " + res.url : "-> FAILED " + res.error);
  return true;
}

/**
 * Bring the database back in line with Docker.
 *
 * Three drifts matter, and all three are invisible without this:
 *   - a row says RUNNING but the container is gone (host rebooted)
 *   - a container is running but has no proxy route (Caddy restarted)
 *   - a row is stuck in BUILDING (the worker died mid-build)
 */
async function reconcile() {
  try {
    const rows = await many(
      "SELECT * FROM deployments WHERE host_id=$1 AND status IN ('RUNNING','STARTING','BUILDING')",
      [cfg.hostId]
    );
    const routes = await caddy.listRoutes();
    const routed = new Set(routes.map((r) => (r["@id"] || "").replace(/^route_/, "")));

    for (const dep of rows) {
      // A build that has been going for over 30 minutes is not going to
      // finish — the worker that owned it is gone.
      if (dep.status === "BUILDING" && Date.now() - new Date(dep.updated_at).getTime() > 30 * 60 * 1000) {
        await pipeline.setStatus(dep.id, "FAILED", { error: "the build was interrupted and did not resume" });
        await pipeline.log(dep.id, "system", "FAILED: build interrupted", "stderr");
        continue;
      }
      if (dep.status === "BUILDING") continue;

      const st = await engine.inspectState(dep.id);
      // Record what Docker says, so the API can answer questions about the
      // container without needing a socket it deliberately does not have.
      await query(
        `UPDATE deployments
            SET container_state=$2, container_exit_code=$3, container_restarts=$4, container_seen_at=now()
          WHERE id=$1`,
        [dep.id, st.exists ? st.status : "absent",
         st.exists ? st.exitCode : null, st.exists ? st.restarts : null]
      );
      if (!st.exists) {
        await pipeline.setStatus(dep.id, "STOPPED", { error: "the container is no longer present on this host" });
        await caddy.removeRoute(dep.domain);
        continue;
      }
      if (st.status === "running" && dep.status !== "RUNNING") {
        await pipeline.setStatus(dep.id, "RUNNING", { error: null });
      }
      if (st.status === "exited" && dep.status === "RUNNING") {
        await pipeline.setStatus(dep.id, "STOPPED", { error: "the app exited with code " + st.exitCode });
      }
      // Re-add a route Caddy has forgotten. Cheap, idempotent, and the
      // difference between a working app and a 502 nobody can explain.
      if (st.status === "running" && dep.domain && !routed.has(dep.domain)) {
        await caddy.addRoute(dep.domain, engine.containerName(dep.id), dep.internal_port || 3000);
        console.log("[worker] re-added missing route for", dep.domain);
      }
    }

    // Heartbeat. Cheap, and it is what lets /health distinguish "the worker
    // is fine" from "nothing has processed a deployment for an hour".
    const dockerVersion = await engine.version();
    await query(
      "UPDATE hosts SET docker_version=$2, worker_seen_at=now() WHERE id=$1",
      [cfg.hostId, dockerVersion || null]
    );

    const health = await capacity.alerts();
    for (const a of health.alerts) {
      console.warn("[alert]", a.level, a.metric, a.message);
    }
  } catch (e) {
    console.error("[worker] reconcile failed:", e.message);
  }
}

/**
 * The worker's internal read API.
 *
 * Runtime logs are `docker logs`, and only this process can run it. The api
 * used to call engine.logs() itself, which always failed there for want of a
 * socket and was reported to the user as "the container is not running" — a
 * statement about the api's own permissions dressed up as a fact about their
 * app. So the api asks here instead.
 *
 * Not published, platform network only, and the internal token is required.
 */
function startInternalServer() {
  const express = require("express");
  const app = express();

  app.use((req, res, next) => {
    if (!cfg.internalToken) return res.status(503).json({ error: "internal API is not configured" });
    const given = req.header("x-internal-token") || "";
    const a = Buffer.from(given), b = Buffer.from(cfg.internalToken);
    const crypto = require("crypto");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });

  app.get("/internal/logs/:id", async (req, res) => {
    const tail = Math.min(Number(req.query.tail) || 500, 2000);
    // The id comes from the api, which resolved it from a row the caller
    // owns; engine.logs sanitises it into a container name regardless.
    const l = await engine.logs(String(req.params.id), { tail });
    res.json({ ok: l.ok, out: l.ok ? l.out : "", error: l.ok ? null : "the container has no logs on this host" });
  });

  app.get("/internal/state/:id", async (req, res) => {
    res.json(await engine.inspectState(String(req.params.id)));
  });

  return app.listen(cfg.workerPort, () =>
    console.log("[worker] internal API on :" + cfg.workerPort));
}

async function main() {
  console.log("[worker] host=" + cfg.hostId + " build-root=" + cfg.buildRoot);

  const v = await engine.version();
  if (!v) {
    console.error("[worker] cannot reach the Docker daemon — is the socket mounted?");
    process.exit(1);
  }
  console.log("[worker] docker", v);

  await engine.ensureAppNetwork();

  const internal = startInternalServer();

  const shutdown = () => { running = false; internal.close(); console.log("[worker] draining"); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  setInterval(() => { reconcile().catch(() => {}); }, RECONCILE_MS);
  setInterval(() => { cleanup.run().catch(() => {}); }, CLEANUP_MS);
  reconcile().catch(() => {});

  while (running) {
    let worked = false;
    try {
      // Lifecycle actions first: they are seconds of work, and making a stop
      // wait behind a fifteen-minute build is how a runaway container stays
      // up long after the user asked for it to go away.
      worked = await tickAction();
      if (!worked) worked = await tick();
    }
    catch (e) { console.error("[worker] tick failed:", e.message); }
    // Only idle when there was nothing to do, so a backlog drains at full
    // speed instead of one deployment every two seconds.
    if (!worked) await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await pool.end();
  process.exit(0);
}

if (require.main === module) main();

module.exports = { claimNext, tick, reconcile, sourceDirFor, claimNextAction, tickAction, ACTIONS };
