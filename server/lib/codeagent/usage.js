/* =================================================================
   codeagent/usage.js — per-owner monthly spend, the missing half of
   the platform-wide AI budget (lib/ai/client.js)
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md §9 "Abuse" + Phase 9. The adapter-level
   AI_MONTHLY_BUDGET_USD guard already stops total spend across the
   whole platform from running away — but it is a SHARED pool, and
   nothing stops one anonymous visitor from spending all of it alone
   before anyone else gets a turn. This tracks cost per OWNER (anon
   cookie or user id, same identity projects.js already uses) so that
   can be capped independently of the platform-wide ceiling.

   Same mem-fallback shape as projects.js, for the same reason: the
   agent must still work with no Mongo configured.
   ================================================================= */
"use strict";

const mem = new Map(); // "ownerKey:month" -> { costUsd, builds }

let getMasterDb = () => null;
function init(deps) { getMasterDb = deps.getMasterDb; }

function col() {
  const db = getMasterDb();
  return db ? db.collection("codeagent_usage") : null;
}

async function ensureIndexes() {
  const c = col();
  if (!c) return;
  try {
    await c.createIndex({ owner: 1, month: 1 }, { unique: true });
  } catch (e) { /* indexes are an optimisation, never a hard dependency */ }
}

function monthKey(d) {
  const dt = d || new Date();
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0");
}

/** Same identity projects.js owns a project by — a user is strictly more
    identity than the anon cookie that preceded it, never a separate one. */
function ownerKey(owner) {
  if (owner && owner.userId) return "u:" + owner.userId;
  if (owner && owner.anonId) return "a:" + owner.anonId;
  return null;
}

async function monthSpend(owner) {
  const key = ownerKey(owner);
  if (!key) return 0;
  const month = monthKey();
  const c = col();
  if (c) {
    const row = await c.findOne({ owner: key, month });
    return (row && row.costUsd) || 0;
  }
  const row = mem.get(key + ":" + month);
  return (row && row.costUsd) || 0;
}

/** Best-effort, like writeAudit — a bookkeeping failure must never block
    or corrupt the build it's recording the cost of. */
async function recordSpend(owner, usd) {
  const key = ownerKey(owner);
  if (!key || !usd) return;
  const month = monthKey();
  try {
    const c = col();
    if (c) {
      await c.updateOne(
        { owner: key, month },
        { $inc: { costUsd: usd, builds: 1 }, $set: { updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    } else {
      const k = key + ":" + month;
      const row = mem.get(k) || { costUsd: 0, builds: 0 };
      row.costUsd += usd; row.builds += 1;
      mem.set(k, row);
    }
  } catch (e) { console.error("codeagent usage record failed:", e.message); }
}

module.exports = { init, ensureIndexes, monthSpend, recordSpend, monthKey, ownerKey };
