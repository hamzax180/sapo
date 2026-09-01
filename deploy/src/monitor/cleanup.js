/* =================================================================
   monitor/cleanup.js — the janitor
   -----------------------------------------------------------------
   Disk is the resource that kills a single-VM deployment host, and
   it does it quietly: images accumulate one per deployment, build
   directories survive crashes, and logs grow without bound. None of
   that shows up in CPU or memory graphs until a build fails with
   "no space left on device" and every other app on the box is
   already degraded.

   Everything here is scoped by the souqi.managed label or by a
   deployment id we own. This process must never delete an image or
   container it did not create.
   ================================================================= */
"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { cfg } = require("../config");
const { query, many } = require("../db");
const engine = require("../docker/engine");
const capacity = require("./capacity");

const LOG_RETENTION_DAYS = 30;
const BUILD_DIR_MAX_AGE_MS = 6 * 60 * 60 * 1000;   // 6h — far longer than any build

/** Build directories left behind by a crash mid-deploy. */
async function sweepBuildDirs() {
  let entries;
  try { entries = await fsp.readdir(cfg.buildRoot, { withFileTypes: true }); }
  catch (e) { return { removed: 0 }; }

  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "src") continue;
    const dir = path.join(cfg.buildRoot, e.name);
    try {
      const st = await fsp.stat(dir);
      if (Date.now() - st.mtimeMs > BUILD_DIR_MAX_AGE_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch (err) { /* raced with a concurrent deploy; leave it */ }
  }
  return { removed };
}

/**
 * Images for deployments that no longer exist or are DELETED.
 *
 * Derived from the database rather than from Docker, so an image is only
 * ever removed because the platform knows its deployment is gone — not
 * because it looked unused at a moment when a build happened to be between
 * stages.
 */
async function sweepImages() {
  const dead = await many(
    "SELECT id FROM deployments WHERE status='DELETED' AND image_name IS NOT NULL"
  );
  let removed = 0;
  for (const d of dead) {
    const r = await engine.removeImage(d.id);
    if (r.ok) {
      await query("UPDATE deployments SET image_name=NULL WHERE id=$1", [d.id]);
      removed++;
    }
  }
  // Dangling layers from replaced builds. Not -a: that would evict the base
  // images every build then re-pulls.
  await engine.pruneImages();
  return { removed };
}

/** Containers on the host with no live row behind them. */
async function sweepOrphanContainers() {
  const managed = await engine.listManaged();
  if (!managed.length) return { removed: 0 };

  const ids = managed.map((c) => c.name.replace(/^app-/, ""));
  const alive = await many(
    "SELECT id FROM deployments WHERE id = ANY($1::text[]) AND status <> 'DELETED'",
    [ids]
  );
  const keep = new Set(alive.map((r) => r.id));

  let removed = 0;
  for (const id of ids) {
    if (keep.has(id)) continue;
    await engine.removeContainer(id);
    await engine.removeImage(id);
    removed++;
    console.log("[cleanup] removed orphan container app-" + id);
  }
  return { removed };
}

/** Log rows past the retention window. */
async function sweepLogs() {
  const r = await query(
    "DELETE FROM deployment_logs WHERE at < now() - ($1 || ' days')::interval",
    [String(LOG_RETENTION_DAYS)]
  );
  return { removed: r.rowCount || 0 };
}

/**
 * When disk is already tight, retention is not enough — trim hardest at the
 * thing that grows fastest. Build logs are chatty and least valuable once a
 * deployment has succeeded.
 */
async function emergencyTrim() {
  const snap = await capacity.snapshot();
  if (!snap.disk || snap.disk.pct < 90) return { trimmed: 0 };
  console.warn("[cleanup] disk at " + snap.disk.pct + "% — trimming build logs early");
  const r = await query(
    `DELETE FROM deployment_logs
      WHERE phase='build'
        AND deployment_id IN (SELECT id FROM deployments WHERE status='RUNNING')
        AND at < now() - interval '2 days'`
  );
  return { trimmed: r.rowCount || 0 };
}

async function run() {
  const out = {};
  try { out.buildDirs = await sweepBuildDirs(); } catch (e) { console.error("[cleanup] build dirs:", e.message); }
  try { out.images = await sweepImages(); } catch (e) { console.error("[cleanup] images:", e.message); }
  try { out.orphans = await sweepOrphanContainers(); } catch (e) { console.error("[cleanup] orphans:", e.message); }
  try { out.logs = await sweepLogs(); } catch (e) { console.error("[cleanup] logs:", e.message); }
  try { out.emergency = await emergencyTrim(); } catch (e) { console.error("[cleanup] trim:", e.message); }
  return out;
}

module.exports = { run, sweepBuildDirs, sweepImages, sweepOrphanContainers, sweepLogs, emergencyTrim };
