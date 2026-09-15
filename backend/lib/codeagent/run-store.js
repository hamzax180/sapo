/* =================================================================
   codeagent/run-store.js — MongoDB persistent store for Dynamic Agent
   -----------------------------------------------------------------
   Docs/DYNAMIC-AGENT-PLAN.md §7.
   Provides durable state for agent runs, append-only event logging
   for SSE replay/reconnection, and immutable source checkpoints.
   ================================================================= */
"use strict";

const crypto = require("crypto");

let getMasterDb = () => null;
function init(deps) {
  if (deps && typeof deps.getMasterDb === "function") {
    getMasterDb = deps.getMasterDb;
  }
}

const id = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");

/* ---- collection helpers ------------------------------------------- */

function col(name) {
  const db = getMasterDb();
  return db ? db.collection(name) : null;
}

async function ensureIndexes() {
  const db = getMasterDb();
  if (!db) return;
  try {
    await db.collection("agent_runs").createIndex({ id: 1 }, { unique: true });
    await db.collection("agent_runs").createIndex({ ownerAnonId: 1, updatedAt: -1 });
    await db.collection("agent_runs").createIndex({ ownerUserId: 1, updatedAt: -1 });
    await db.collection("agent_runs").createIndex({ projectId: 1, createdAt: -1 });
    await db.collection("agent_events").createIndex({ runId: 1, seq: 1 }, { unique: true });
    await db.collection("agent_checkpoints").createIndex({ id: 1 }, { unique: true });
    await db.collection("agent_checkpoints").createIndex({ runId: 1, at: -1 });
    await db.collection("agent_steps").createIndex({ runId: 1, stepIndex: 1 });
  } catch (e) {
    /* non-fatal index creation */
  }
}

function owns(run, owner) {
  if (!run || !owner) return false;
  if (run.ownerUserId) return !!owner.userId && run.ownerUserId === owner.userId;
  return !!owner.anonId && run.ownerAnonId === owner.anonId;
}

/* ---- run lifecycle ------------------------------------------------ */

/**
 * Creates a persistent agent run record.
 * Status starts at "queued".
 */
async function createRun({ projectId, owner, prompt, mode, effort, baseFiles, chatId }) {
  const runId = id("run");
  const now = new Date().toISOString();
  const c = col("agent_runs");

  const runDoc = {
    id: runId,
    projectId: projectId || null,
    ownerAnonId: (owner && owner.anonId) || null,
    ownerUserId: (owner && owner.userId) || null,
    chatId: chatId || "",
    prompt: String(prompt || "").trim(),
    mode: mode || "auto",
    effort: effort || "balanced",
    status: "queued", // queued -> running -> waiting_for_check -> succeeded / failed / cancelled / partial
    phase: "init",
    createdAt: now,
    updatedAt: now,
    cancelled: false,
    cancelReason: null,
    latestCheckpointId: null,
    latestError: null,
    costUsd: 0
  };

  if (c) {
    await c.insertOne(runDoc);
  }

  // If initial base files exist, save checkpoint 0
  if (baseFiles && Object.keys(baseFiles).length > 0) {
    await saveCheckpoint(runId, baseFiles, "Initial project baseline");
  }

  // Emit initial event
  await appendEvent(runId, "run_created", { runId, status: "queued", prompt: runDoc.prompt });

  return runDoc;
}

async function getRun(runId, owner) {
  const c = col("agent_runs");
  if (!c) return null;
  const run = await c.findOne({ id: runId }, { projection: { _id: 0 } });
  if (!run) return null;
  if (owner && !owns(run, owner)) return null;
  return run;
}

async function updateRun(runId, updates) {
  const c = col("agent_runs");
  if (!c) return false;
  const patch = Object.assign({}, updates, { updatedAt: new Date().toISOString() });
  const res = await c.updateOne({ id: runId }, { $set: patch });
  return res.modifiedCount > 0;
}

async function cancelRun(runId, owner, reason) {
  const run = await getRun(runId, owner);
  if (!run) return false;
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return false;
  }
  const c = col("agent_runs");
  if (!c) return false;
  const now = new Date().toISOString();
  await c.updateOne({ id: runId }, {
    $set: {
      cancelled: true,
      cancelReason: reason || "Cancelled by user",
      status: "cancelled",
      updatedAt: now
    }
  });
  await appendEvent(runId, "run_cancelled", { runId, reason: reason || "Cancelled by user" });
  return true;
}

/* ---- events (append-only for SSE replay) --------------------------- */

async function appendEvent(runId, type, payload) {
  const c = col("agent_events");
  const now = new Date().toISOString();

  let seq = 1;
  if (c) {
    // Determine next sequence number
    const last = await c.findOne({ runId }, { sort: { seq: -1 }, projection: { seq: 1, _id: 0 } });
    if (last && typeof last.seq === "number") seq = last.seq + 1;
    await c.insertOne({
      runId,
      seq,
      type,
      payload: payload || {},
      at: now
    });
  }

  return { runId, seq, type, payload, at: now };
}

async function getEvents(runId, afterSeq = 0) {
  const c = col("agent_events");
  if (!c) return [];
  const events = await c.find(
    { runId, seq: { $gt: Number(afterSeq) || 0 } },
    { sort: { seq: 1 }, projection: { _id: 0 } }
  ).toArray();
  return events;
}

/* ---- checkpoints (content-addressed snapshots) -------------------- */

async function saveCheckpoint(runId, files, summary) {
  const chkId = id("chk");
  const now = new Date().toISOString();
  const c = col("agent_checkpoints");

  const doc = {
    id: chkId,
    runId,
    files: Object.assign({}, files || {}),
    fileCount: Object.keys(files || {}).length,
    summary: summary || "",
    at: now
  };

  if (c) {
    await c.insertOne(doc);
    const rc = col("agent_runs");
    if (rc) {
      await rc.updateOne({ id: runId }, { $set: { latestCheckpointId: chkId, updatedAt: now } });
    }
  }

  return doc;
}

async function getLatestCheckpoint(runId) {
  const c = col("agent_checkpoints");
  if (!c) return null;
  const chk = await c.findOne({ runId }, { sort: { at: -1 }, projection: { _id: 0 } });
  return chk;
}

/* ---- steps & telemetry -------------------------------------------- */

async function recordStep(runId, stepData) {
  const c = col("agent_steps");
  const now = new Date().toISOString();
  const doc = Object.assign({ runId, at: now }, stepData);
  if (c) {
    await c.insertOne(doc);
  }
  return doc;
}

module.exports = {
  init,
  ensureIndexes,
  owns,
  createRun,
  getRun,
  updateRun,
  cancelRun,
  appendEvent,
  getEvents,
  saveCheckpoint,
  getLatestCheckpoint,
  recordStep
};
