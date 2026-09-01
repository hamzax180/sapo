/* =================================================================
   monitor/capacity.js — admission control and host health
   -----------------------------------------------------------------
   The spec rule this implements: "the platform should refuse new
   deployments if the server does not have sufficient resources", and
   "do not claim that 10 applications can always run on one VM".

   Refusing a deploy with a clear reason is a far better failure than
   accepting it and having the OOM killer pick a victim at random —
   which, on a shared box, is usually somebody else app.
   ================================================================= */
"use strict";

const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const { cfg } = require("../config");
const engine = require("../docker/engine");
const { one } = require("../db");

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMb: Math.round(total / 1048576),
    usedMb: Math.round((total - free) / 1048576),
    pct: Math.round((total - free) / total * 100)
  };
}

function loadPct() {
  // 1-minute load average against core count. Not the same as CPU% but it is
  // the number that actually predicts contention on a shared box.
  const cores = os.cpus().length || 1;
  return Math.round(os.loadavg()[0] / cores * 100);
}

function disk(pathToCheck) {
  return new Promise((resolve) => {
    if (process.platform === "win32") return resolve(null);   // local dev only
    execFile("df", ["-Pk", pathToCheck || "/"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).trim().split("\n").pop() || "";
      const cols = line.split(/\s+/);
      const totalKb = Number(cols[1]), usedKb = Number(cols[2]);
      if (!Number.isFinite(totalKb) || !totalKb) return resolve(null);
      resolve({ totalGb: +(totalKb / 1048576).toFixed(1), usedGb: +(usedKb / 1048576).toFixed(1), pct: Math.round(usedKb / totalKb * 100) });
    });
  });
}

async function snapshot() {
  const [containers, d] = await Promise.all([engine.listManaged(), disk(cfg.buildRoot)]);
  const running = containers.filter((c) => /running/i.test(c.state)).length;
  return {
    hostId: cfg.hostId,
    memory: memory(),
    cpuPct: loadPct(),
    disk: d,
    containers: { total: containers.length, running },
    at: new Date().toISOString()
  };
}

/**
 * Would one more container of this size fit?
 *
 * Checks committed memory, not just free memory: a box with 6GB free and
 * 10 containers each allowed 512MB is already oversubscribed by 5GB, and
 * free memory tells you nothing until they all get busy at once.
 */
async function canAdmit({ memoryMb }) {
  const snap = await snapshot();
  const reasons = [];

  if (snap.containers.total >= cfg.admission.maxContainers) {
    reasons.push("this server is at its container limit (" + cfg.admission.maxContainers + ")");
  }
  if (snap.memory.pct >= cfg.admission.maxMemoryPct) {
    reasons.push("memory is at " + snap.memory.pct + "% (limit " + cfg.admission.maxMemoryPct + "%)");
  }
  if (snap.disk && snap.disk.pct >= cfg.admission.maxDiskPct) {
    reasons.push("disk is at " + snap.disk.pct + "% (limit " + cfg.admission.maxDiskPct + "%)");
  }

  const committed = await one(
    "SELECT COALESCE(SUM(memory_mb),0)::int AS mb FROM deployments WHERE host_id=$1 AND status IN ('RUNNING','STARTING','BUILDING')",
    [cfg.hostId]
  );
  const wouldCommit = (committed ? committed.mb : 0) + Number(memoryMb || cfg.defaults.memoryMb);
  // Allow deliberate oversubscription up to 1.5x physical — apps are idle
  // most of the time — but not unbounded.
  const ceiling = Math.round(snap.memory.totalMb * 1.5);
  if (wouldCommit > ceiling) {
    reasons.push("committed memory would reach " + wouldCommit + "MB of a " + ceiling + "MB ceiling");
  }

  return { ok: reasons.length === 0, reasons, snapshot: snap, committedMb: wouldCommit };
}

/** Threshold breaches worth alerting on. */
async function alerts() {
  const snap = await snapshot();
  const out = [];
  if (snap.memory.pct > 80) out.push({ level: "warn", metric: "memory", value: snap.memory.pct, message: "memory above 80%" });
  if (snap.cpuPct > 80) out.push({ level: "warn", metric: "cpu", value: snap.cpuPct, message: "sustained load above 80%" });
  if (snap.disk && snap.disk.pct > 80) out.push({ level: "warn", metric: "disk", value: snap.disk.pct, message: "disk above 80%" });
  if (snap.containers.total > cfg.admission.maxContainers * 0.9) {
    out.push({ level: "warn", metric: "containers", value: snap.containers.total, message: "near the container limit" });
  }
  // Crash loops: a container Docker keeps restarting is failing, and the
  // restart policy hides it from every other signal.
  const managed = await engine.listManaged();
  for (const c of managed) {
    const id = c.name.replace(/^app-/, "");
    const st = await engine.inspectState(id);
    if (st.exists && st.restarts >= 5) {
      out.push({ level: "error", metric: "crashloop", value: st.restarts, message: c.name + " has restarted " + st.restarts + " times" });
    }
  }
  return { alerts: out, snapshot: snap };
}

module.exports = { snapshot, canAdmit, alerts, memory, disk, loadPct };
