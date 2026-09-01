/* =================================================================
   api/server.js — the deployment control plane
   -----------------------------------------------------------------
   Every route here is thin on purpose. Nothing in this file runs a
   Docker command: an HTTP handler that shells out to docker build
   would hold the request open for minutes, time out at the proxy,
   and leave a deployment whose real state nobody can query. Handlers
   write a row and return; the worker does the work.

   The one exception is reading logs and status, which are cheap and
   must be answerable while a build is still going.
   ================================================================= */
"use strict";

const express = require("express");
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const { cfg, assertProductionReady } = require("../config");
const { query, one, many } = require("../db");
const engine = require("../docker/engine");
const caddy = require("../proxy/caddy");
const capacity = require("../monitor/capacity");
const pipeline = require("../worker/pipeline");
const secrets = require("../secrets");
const auth = require("./auth");
const detect = require("../framework/detect");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

/* ---------- ids ----------
   Prefixed and random. A guessable deployment id is a way to enumerate
   other tenants, and these appear in container names and hostnames. */
const newId = (prefix) => prefix + "_" + crypto.randomBytes(9).toString("hex");

/* ---------- auth ----------
   Real sessions now — see api/auth.js. The placeholder that trusted an
   x-user-id header is gone rather than kept as a fallback: a route that
   accepts either is a route that accepts the weaker one.

   requireUser sets req.user (id, email, wsId) and req.userId. Every route
   below already went through one function, which is what made swapping the
   implementation a single edit instead of an audit of nine handlers. */
const requireUser = auth.requireUser;

/**
 * Ensures the signed-in user exists in THIS database.
 *
 * Identity lives in the main app; the deploy plane only needs a row to hang
 * foreign keys off. Upserting on first use means a new user can deploy
 * immediately without a provisioning step that could fail separately.
 */
async function ensureUser(user) {
  await query(
    "INSERT INTO users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email",
    [user.id, user.email || user.id + "@unknown"]
  );
}

/** Loads a deployment and proves it belongs to the caller. */
async function ownedDeployment(req, res) {
  const dep = await one("SELECT * FROM deployments WHERE id=$1", [req.params.id]);
  if (!dep) { res.status(404).json({ error: "deployment not found" }); return null; }
  if (dep.user_id !== req.userId) {
    // 404, not 403: a 403 confirms the id exists, which is an enumeration
    // oracle across tenants.
    res.status(404).json({ error: "deployment not found" });
    return null;
  }
  return dep;
}

const publicView = (d) => ({
  deploymentId: d.id,
  projectId: d.project_id,
  status: d.status,
  framework: d.framework,
  url: d.domain ? "https://" + d.domain : null,
  domain: d.domain,
  limits: { cpu: Number(d.cpu_limit), memoryMb: d.memory_mb, pids: d.pids_limit },
  error: d.error || null,
  createdAt: d.created_at,
  updatedAt: d.updated_at
});

/* ---------- health & capacity ---------- */

app.get("/health", async (req, res) => {
  const dockerVersion = await engine.version();
  res.json({ ok: true, docker: dockerVersion, caddy: await caddy.health(), host: cfg.hostId });
});

app.get("/capacity", requireUser, async (req, res, next) => {
  try { res.json(await capacity.snapshot()); } catch (e) { next(e); }
});

/**
 * Caddy asks here before issuing a certificate for a hostname.
 *
 * Without this gate anyone could point DNS at this server and make it
 * request certificates on their behalf — an abuse vector, and the fastest
 * possible route to a Let-s-Encrypt rate limit that would then block real
 * customers. 200 means issue; anything else means refuse.
 */
app.get("/internal/tls-ask", auth.requireInternal, async (req, res) => {
  const domain = String(req.query.domain || "").toLowerCase();
  if (!domain) return res.status(400).end();
  const row = await one(
    "SELECT 1 FROM deployments WHERE domain=$1 AND status <> 'DELETED'",
    [domain]
  );
  return row ? res.status(200).end() : res.status(404).end();
});

/* ---------- deployments ---------- */

/**
 * POST /deployments
 * Creates the record and queues it. Returns immediately — the build has
 * not started and will not have started when this responds.
 */
app.post("/deployments", requireUser, async (req, res, next) => {
  try {
    const projectId = String((req.body && req.body.projectId) || "");
    if (!projectId) return res.status(400).json({ error: "projectId is required" });

    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [projectId, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });

    // Admission is checked here as well as in the worker. Here it gives the
    // user an immediate, honest "not now" instead of a queued deployment
    // that fails minutes later.
    const admit = await capacity.canAdmit({ memoryMb: cfg.defaults.memoryMb });
    if (!admit.ok) {
      return res.status(503).json({ error: "no capacity right now — " + admit.reasons.join("; "), retryAfter: 300 });
    }

    const id = newId("dep");
    // Hostname derives from the id, so it inherits the same character set and
    // can never contain anything a DNS label disallows.
    const domain = "app-" + id.split("_")[1].slice(0, 12) + "." + cfg.appDomain;

    const dep = await one(
      `INSERT INTO deployments
         (id, project_id, user_id, status, framework, domain, host_id, cpu_limit, memory_mb, pids_limit)
       VALUES ($1,$2,$3,'QUEUED',$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [id, projectId, req.userId, project.framework || "unknown", domain, cfg.hostId,
       cfg.defaults.cpu, cfg.defaults.memoryMb, cfg.defaults.pids]
    );
    await query("INSERT INTO domains (domain, deployment_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [domain, id]);
    await pipeline.log(id, "system", "Queued");

    res.status(201).json({ deploymentId: id, status: "QUEUED", url: "https://" + domain });
  } catch (e) { next(e); }
});

/**
 * POST /deployments/:id/source
 * Receives the source as a flat {path: content} map and stages it where the
 * worker expects to find it. Kept separate from create so a redeploy can
 * replace the source without allocating a new hostname.
 */
app.post("/deployments/:id/source", requireUser, express.json({ limit: "24mb" }), async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const files = (req.body && req.body.files) || null;
    if (!files || typeof files !== "object") return res.status(400).json({ error: "files is required" });

    const dir = path.join(cfg.buildRoot, "src", dep.id);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });

    for (const rel of Object.keys(files)) {
      // Path traversal check. Without it a file named ../../etc/cron.d/x
      // would be written outside the staging directory as the worker user.
      const clean = String(rel).replace(/\\/g, "/");
      if (clean.startsWith("/") || clean.split("/").includes("..")) {
        return res.status(400).json({ error: "unsafe path in upload: " + clean });
      }
      const dest = path.join(dir, clean);
      if (!dest.startsWith(dir + path.sep)) {
        return res.status(400).json({ error: "unsafe path in upload: " + clean });
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, String(files[rel]), "utf8");
    }

    const spec = detect.detect(dir);
    if (spec) {
      await query("UPDATE deployments SET framework=$2 WHERE id=$1", [dep.id, spec.framework]);
      await query("UPDATE projects SET framework=$2, updated_at=now() WHERE id=$1", [dep.project_id, spec.framework]);
    }
    res.json({ ok: true, files: Object.keys(files).length, detected: spec ? spec.framework : null });
  } catch (e) { next(e); }
});

app.get("/deployments/:id", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    res.json(publicView(dep));
  } catch (e) { next(e); }
});

/** Live state, cheap enough to poll while a build runs. */
app.get("/deployments/:id/status", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const container = dep.status === "RUNNING" || dep.status === "STARTING"
      ? await engine.inspectState(dep.id)
      : { exists: false };
    res.json({
      status: dep.status,
      url: dep.domain ? "https://" + dep.domain : null,
      error: dep.error || null,
      container: container.exists
        ? { state: container.status, exitCode: container.exitCode, restarts: container.restarts }
        : null
    });
  } catch (e) { next(e); }
});

/** Queue a (re)deploy of whatever source is currently staged. */
async function enqueue(req, res) {
  const dep = await ownedDeployment(req, res); if (!dep) return;
  if (dep.status === "QUEUED" || dep.status === "BUILDING") {
    return res.status(409).json({ error: "this deployment is already in progress" });
  }
  await query("UPDATE deployments SET status='QUEUED', error=NULL, updated_at=now() WHERE id=$1", [dep.id]);
  await pipeline.log(dep.id, "system", "Queued");
  res.json({ deploymentId: dep.id, status: "QUEUED" });
}
app.post("/deployments/:id/deploy", requireUser, enqueue);
app.post("/deployments/:id/redeploy", requireUser, enqueue);

/* Lifecycle actions run inline: stop, start and restart are seconds, not
   minutes, so queueing them would add latency and a state to explain for
   no benefit. */
app.post("/deployments/:id/stop", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    await pipeline.stop(dep);
    res.json({ ok: true, status: "STOPPED" });
  } catch (e) { next(e); }
});

app.post("/deployments/:id/start", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const r = await pipeline.start(dep);
    res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true, status: "RUNNING" } : { error: r.error });
  } catch (e) { next(e); }
});

app.post("/deployments/:id/restart", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const r = await pipeline.restart(dep);
    res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true, status: "RUNNING" } : { error: r.error });
  } catch (e) { next(e); }
});

app.delete("/deployments/:id", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    await pipeline.destroy(dep);
    res.json({ ok: true, status: "DELETED" });
  } catch (e) { next(e); }
});

/**
 * GET /deployments/:id/logs
 * Build logs come from the database (the build container is long gone);
 * runtime logs come from Docker. Users never run a docker command — this
 * handler picks the source and the flags.
 */
app.get("/deployments/:id/logs", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const phase = String(req.query.phase || "build");
    const tail = Math.min(Number(req.query.tail) || 500, 2000);

    if (phase === "runtime") {
      const l = await engine.logs(dep.id, { tail });
      return res.json({
        phase: "runtime",
        lines: l.ok ? l.out.split("\n").filter(Boolean) : [],
        note: l.ok ? null : "no runtime logs — the container is not running"
      });
    }

    const rows = await many(
      "SELECT phase, stream, line, at FROM deployment_logs WHERE deployment_id=$1 ORDER BY id DESC LIMIT $2",
      [dep.id, tail]
    );
    res.json({ phase: "build", lines: rows.reverse() });
  } catch (e) { next(e); }
});

/* ---------- project env ----------
   Values go in and are never selected back out. GET returns keys and a
   masked tail only, so a compromised session cannot read the secrets it
   can overwrite. */
app.get("/projects/:id/env", requireUser, async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });
    const rows = await many("SELECT key, value_enc, updated_at FROM project_env WHERE project_id=$1 ORDER BY key", [project.id]);
    res.json({
      env: rows.map((r) => {
        let masked = "••••";
        try { masked = secrets.mask(secrets.decrypt(r.value_enc)); } catch (e) { /* unreadable stays masked */ }
        return { key: r.key, masked: masked, updatedAt: r.updated_at };
      })
    });
  } catch (e) { next(e); }
});

app.put("/projects/:id/env", requireUser, async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });

    const entries = Object.entries((req.body && req.body.env) || {});
    if (!entries.length) return res.status(400).json({ error: "env is required" });

    for (const [k, v] of entries) {
      const ke = secrets.validateKey(k);
      if (ke) return res.status(400).json({ error: k + ": " + ke });
      const ve = secrets.validateValue(v);
      if (ve) return res.status(400).json({ error: k + ": " + ve });
    }
    for (const [k, v] of entries) {
      await query(
        `INSERT INTO project_env (project_id, key, value_enc) VALUES ($1,$2,$3)
         ON CONFLICT (project_id, key) DO UPDATE SET value_enc=EXCLUDED.value_enc, updated_at=now()`,
        [project.id, k, secrets.encrypt(v)]
      );
    }
    res.json({ ok: true, saved: entries.length, note: "redeploy for these to take effect" });
  } catch (e) { next(e); }
});

app.delete("/projects/:id/env/:key", requireUser, async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });
    await query("DELETE FROM project_env WHERE project_id=$1 AND key=$2", [project.id, req.params.key]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- projects ---------- */
app.post("/projects", requireUser, async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "name is required" });
    await ensureUser(req.user);
    const id = newId("prj");
    const p = await one("INSERT INTO projects (id, user_id, name) VALUES ($1,$2,$3) RETURNING *",
      [id, req.userId, name]);
    res.status(201).json({ projectId: p.id, name: p.name });
  } catch (e) { next(e); }
});

app.get("/projects", requireUser, async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT p.*, (
         SELECT row_to_json(d) FROM (
           SELECT id, status, domain FROM deployments
            WHERE project_id = p.id AND status <> 'DELETED'
            ORDER BY created_at DESC LIMIT 1
         ) d
       ) AS latest
       FROM projects p WHERE p.user_id=$1 ORDER BY p.updated_at DESC`,
      [req.userId]
    );
    res.json({ projects: rows });
  } catch (e) { next(e); }
});

/* ---------- errors ----------
   One handler, so no route can leak a stack trace or a query string that
   might carry a secret. */
app.use((err, req, res, next) => {
  console.error("[api]", req.method, req.path, err.message);
  res.status(500).json({ error: "something went wrong on our side" });
});

async function start() {
  // Auth problems are fatal, not advisory. A forgeable session secret or a
  // dev-auth header left on in production is not a configuration smell — it
  // is anyone being able to deploy as anyone, and the only safe response is
  // to refuse to start rather than serve while broken.
  const authCfg = auth.assertAuthConfig();
  for (const w of authCfg.warn) console.warn("[api] " + w);
  if (authCfg.fatal.length) {
    console.error("[api] FATAL — refusing to start:");
    for (const f of authCfg.fatal) console.error("  - " + f);
    process.exit(1);
  }

  const problems = assertProductionReady();
  if (problems.length) {
    console.warn("[api] not production-ready:");
    for (const p of problems) console.warn("  - " + p);
  }
  await fsp.mkdir(path.join(cfg.buildRoot, "src"), { recursive: true }).catch(() => {});

  // Caddy calls this before issuing any certificate, so the URL carries the
  // shared secret as a query parameter — Caddy on-demand ask cannot set a
  // header. It travels only on the internal platform network.
  const askUrl = "http://api:" + cfg.apiPort + "/internal/tls-ask"
    + (cfg.internalToken ? "?token=" + encodeURIComponent(cfg.internalToken) : "");
  const applied = await caddy.applyBaseConfig(askUrl);
  console.log("[api] caddy base config:", applied.ok ? "applied" : "unavailable (" + (applied.error || "") + ")");

  app.listen(cfg.apiPort, () => console.log("[api] listening on :" + cfg.apiPort));
}

if (require.main === module) start();

module.exports = { app, start };
