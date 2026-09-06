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
const memEvents = new Map(); // ownerKey -> [{ at:ms, usd }]  (rolling window fallback)

let getMasterDb = () => null;
function init(deps) { getMasterDb = deps.getMasterDb; }

function col() {
  const db = getMasterDb();
  return db ? db.collection("codeagent_usage") : null;
}

/* One row per billable turn, so spend can be summed over an arbitrary
   window rather than only per calendar month.

   A month total cannot answer "how much in the last five hours", and a
   monthly cap alone lets someone spend the entire allowance in one
   sitting and then find the product dead for three weeks. The rolling
   window is what makes the monthly number last the month. */
function eventCol() {
  const db = getMasterDb();
  return db ? db.collection("codeagent_usage_events") : null;
}

async function ensureIndexes() {
  const c = col();
  if (!c) return;
  try {
    await c.createIndex({ owner: 1, month: 1 }, { unique: true });
  } catch (e) { /* indexes are an optimisation, never a hard dependency */ }
  const ev = eventCol();
  if (!ev) return;
  try {
    await ev.createIndex({ owner: 1, at: -1 });
    /* Events exist to answer "the last N hours" and are useless past a
       day. Mongo expires them itself so this collection cannot grow
       without bound — the monthly totals above remain the durable
       record, and they are stored separately for exactly that reason. */
    await ev.createIndex({ at: 1 }, { expireAfterSeconds: 26 * 3600 });
  } catch (e) { /* same */ }
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

/**
 * Spend inside a ROLLING window ending now — not a fixed bucket.
 *
 * A fixed bucket (every clock hour, every 5 hours from midnight) has an
 * edge you can stand on: spend the cap at 4:59 and the whole cap again at
 * 5:01. Summing backwards from the current moment has no such seam, which
 * is also how the limit people already understand from Claude behaves.
 *
 * Returns { usd, resetAt } — resetAt is when the OLDEST charge in the
 * window ages out, i.e. the first moment more room exists. That is the
 * only honest answer to "when can I build again"; the end of some
 * arbitrary bucket would be a guess.
 */
async function windowSpend(owner, hours) {
  const key = ownerKey(owner);
  if (!key) return { usd: 0, resetAt: null };
  const since = Date.now() - hours * 3600 * 1000;
  const ev = eventCol();
  let rows;
  if (ev) {
    rows = await ev.find({ owner: key, at: { $gte: new Date(since) } })
      .project({ at: 1, usd: 1 }).toArray();
    rows = rows.map((r) => ({ at: new Date(r.at).getTime(), usd: r.usd }));
  } else {
    rows = (memEvents.get(key) || []).filter((e) => e.at >= since);
  }
  if (!rows.length) return { usd: 0, resetAt: null };
  let usd = 0, oldest = Infinity;
  for (const r of rows) { usd += Number(r.usd) || 0; if (r.at < oldest) oldest = r.at; }
  return { usd: usd, resetAt: new Date(oldest + hours * 3600 * 1000).toISOString() };
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

  // The window's own record. Separate try/catch: the monthly total is the
  // billing number and must not be lost because the event write failed.
  try {
    const ev = eventCol();
    if (ev) {
      await ev.insertOne({ owner: key, at: new Date(), usd: usd });
    } else {
      const list = memEvents.get(key) || [];
      const cutoff = Date.now() - 26 * 3600 * 1000;
      list.push({ at: Date.now(), usd: usd });
      memEvents.set(key, list.filter((e) => e.at >= cutoff));
    }
  } catch (e) { console.error("codeagent usage window record failed:", e.message); }
}

module.exports = { init, ensureIndexes, monthSpend, windowSpend, recordSpend, monthKey, ownerKey };
