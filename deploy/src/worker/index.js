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

    const health = await capacity.alerts();
    for (const a of health.alerts) {
      console.warn("[alert]", a.level, a.metric, a.message);
    }
  } catch (e) {
    console.error("[worker] reconcile failed:", e.message);
  }
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

  const shutdown = () => { running = false; console.log("[worker] draining"); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  setInterval(() => { reconcile().catch(() => {}); }, RECONCILE_MS);
  setInterval(() => { cleanup.run().catch(() => {}); }, CLEANUP_MS);
  reconcile().catch(() => {});

  while (running) {
    let worked = false;
    try { worked = await tick(); }
    catch (e) { console.error("[worker] tick failed:", e.message); }
    // Only idle when there was nothing to do, so a backlog drains at full
    // speed instead of one deployment every two seconds.
    if (!worked) await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await pool.end();
  process.exit(0);
}

if (require.main === module) main();

module.exports = { claimNext, tick, reconcile, sourceDirFor };
