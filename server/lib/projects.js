/* =================================================================
   projects.js — the durable object the whole agent hangs off
   -----------------------------------------------------------------
   A Project survives a page reload, has a URL you can come back to,
   remembers its conversation, and keeps every version of the site it
   has ever produced. It is owned by an ANONYMOUS id first (a signed
   cookie) and by a real user later, when it is claimed — the same row,
   re-pointed, so nothing is copied and nothing is lost.

     project  ── turns[]      the conversation, in order
              └─ revisions[]  immutable configs; head is the live one

   Revisions store whole configs rather than diffs. A site config is a
   few hundred KB at worst, and storing complete ones makes restore a
   single assignment instead of a replay — which removes an entire
   class of bug.

   See docs/AGENT-PARITY-PLAN.md §2.
   ================================================================= */
"use strict";

const crypto = require("crypto");

const TTL_UNCLAIMED_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const MAX_REVISIONS = 50;
const MAX_TURNS = 400;

/* ---- in-memory fallback, so the agent works with no Mongo ---- */
const mem = { projects: new Map(), turns: new Map(), revisions: new Map() };

let getMasterDb = () => null;
function init(deps) { getMasterDb = deps.getMasterDb; }

const id = (prefix) => prefix + "_" + crypto.randomBytes(8).toString("base64url");

/* ---- collection helpers ------------------------------------------- */

function col(name) {
  const db = getMasterDb();
  return db ? db.collection(name) : null;
}

async function ensureIndexes() {
  const db = getMasterDb();
  if (!db) return;
  try {
    await db.collection("projects").createIndex({ id: 1 }, { unique: true });
    await db.collection("projects").createIndex({ ownerAnonId: 1, updatedAt: -1 });
    await db.collection("projects").createIndex({ ownerUserId: 1, updatedAt: -1 });
    await db.collection("projects").createIndex({ "published.publicSlug": 1 }, { unique: true, sparse: true });
    await db.collection("projects").createIndex({ "published.customDomain": 1 }, { unique: true, sparse: true });
    // TTL only bites while a project is unclaimed — expiresAt is unset on claim
    await db.collection("projects").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("turns").createIndex({ projectId: 1, seq: 1 });
    await db.collection("revisions").createIndex({ projectId: 1, at: -1 });
    await db.collection("revisions").createIndex({ id: 1 }, { unique: true });
  } catch (e) { /* indexes are an optimisation, never a hard dependency */ }
}

/* ---- slugs --------------------------------------------------------- */

function slugify(title) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "site";
}

/** A slug unique within one owner, so two people can both have "kahve-co". */
async function uniqueSlug(title, ownerKey) {
  const base = slugify(title);
  for (let n = 0; n < 50; n++) {
    const candidate = n ? base + "-" + (n + 1) : base;
    const clash = await findBySlug(candidate, ownerKey);
    if (!clash) return candidate;
  }
  return base + "-" + crypto.randomBytes(2).toString("hex");
}

/* ================= projects ================= */

async function create(fields) {
  const now = new Date();
  const project = {
    id: id("pr"),
    slug: await uniqueSlug(fields.title || "site", fields.owner),
    title: String(fields.title || "Untitled site").slice(0, 80),
    ownerAnonId: fields.owner && fields.owner.anonId ? fields.owner.anonId : null,
    ownerUserId: fields.owner && fields.owner.userId ? fields.owner.userId : null,
    wsId: null,
    headRevision: null,
    // The revision currently live at wsId's storefrontConfig — null until the
    // first publish (which happens at claim time). Lets the client answer
    // "is what I'm looking at actually live" without re-diffing configs.
    publishedRevisionId: null,
    prompt: String(fields.prompt || "").slice(0, 2000),
    meta: fields.meta || {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_UNCLAIMED_MS)
  };

  const c = col("projects");
  if (c) await c.insertOne(Object.assign({}, project));
  else mem.projects.set(project.id, project);
  return project;
}

async function get(projectId) {
  const c = col("projects");
  if (c) return c.findOne({ id: projectId }, { projection: { _id: 0 } });
  return mem.projects.get(projectId) || null;
}

/**
 * Match EITHER identity, not "userId if logged in, else anonId". A signed-in
 * visitor still carries the anon cookie that made their not-yet-claimed
 * projects, and those must keep resolving by it after login — a user is
 * strictly more identity, never less. Getting this wrong means a logged-in
 * owner can no longer find their own unclaimed project by its own slug.
 */
function ownerFilter(owner) {
  const or = [];
  if (owner && owner.userId) or.push({ ownerUserId: owner.userId });
  if (owner && owner.anonId) or.push({ ownerAnonId: owner.anonId });
  if (!or.length) return { id: "__no_owner__" };   // matches nothing
  return or.length === 1 ? or[0] : { $or: or };
}
function ownerMatches(p, owner) {
  return !!((owner.userId && p.ownerUserId === owner.userId) || (owner.anonId && p.ownerAnonId === owner.anonId));
}

async function findBySlug(slug, owner) {
  const q = Object.assign({ slug: slug }, ownerFilter(owner));
  const c = col("projects");
  if (c) return c.findOne(q, { projection: { _id: 0 } });
  for (const p of mem.projects.values()) {
    if (p.slug === slug && ownerMatches(p, owner || {})) return p;
  }
  return null;
}

/** Published sites are public — no owner context to scope the slug within,
    unlike the per-owner editing slug above. Uniqueness is checked GLOBALLY. */
async function findPublished(publicSlug) {
  const c = col("projects");
  if (c) return c.findOne({ "published.publicSlug": publicSlug }, { projection: { _id: 0 } });
  for (const p of mem.projects.values()) {
    if (p.published && p.published.publicSlug === publicSlug) return p;
  }
  return null;
}

/** Same trust model as Sites' own custom domains (db-adapters.js's
    findWorkspaceByDomain): the stored field is the only check, no separate
    ownership-verification flow. This isn't a security gap — setting the
    field is already owner-gated (only the project's owner can call the
    /domain endpoint), and a domain string that ISN'T actually pointed at
    Souqi's DNS does nothing regardless of what's stored, since traffic for
    that domain never reaches this server in the first place. */
async function findByCustomDomain(domain) {
  const c = col("projects");
  const normalized = String(domain || "").toLowerCase().trim();
  if (!normalized) return null;
  if (c) return c.findOne({ "published.customDomain": normalized }, { projection: { _id: 0 } });
  for (const p of mem.projects.values()) {
    if (p.published && p.published.customDomain === normalized) return p;
  }
  return null;
}

async function uniquePublicSlug(title) {
  const base = slugify(title);
  for (let n = 0; n < 50; n++) {
    const candidate = n ? base + "-" + (n + 1) : base;
    const clash = await findPublished(candidate);
    if (!clash) return candidate;
  }
  return base + "-" + crypto.randomBytes(3).toString("hex");
}

async function list(owner, limit) {
  const n = Math.min(limit || 30, 100);
  const q = ownerFilter(owner);
  const c = col("projects");
  if (c) return c.find(q, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(n).toArray();
  return [...mem.projects.values()]
    .filter((p) => ownerMatches(p, owner))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, n);
}

async function patch(projectId, fields) {
  fields.updatedAt = new Date().toISOString();
  const c = col("projects");
  if (c) await c.updateOne({ id: projectId }, { $set: fields });
  else Object.assign(mem.projects.get(projectId) || {}, fields);
  return get(projectId);
}

async function remove(projectId) {
  const c = col("projects");
  if (c) {
    await c.deleteOne({ id: projectId });
    await col("turns").deleteMany({ projectId: projectId });
    await col("revisions").deleteMany({ projectId: projectId });
  } else {
    mem.projects.delete(projectId);
    mem.turns.delete(projectId);
    mem.revisions.delete(projectId);
  }
}

/**
 * Ownership. An anonymous cookie owns a project until it is claimed; after
 * that only the user does. Checked on every read AND write — a project id is
 * a handle, never a permission.
 */
function owns(project, owner) {
  if (!project || !owner) return false;
  if (project.ownerUserId) return !!owner.userId && project.ownerUserId === owner.userId;
  return !!owner.anonId && project.ownerAnonId === owner.anonId;
}

/* ================= revisions ================= */

async function addRevision(projectId, config, label) {
  const project = await get(projectId);
  const rev = {
    id: id("rv"),
    projectId: projectId,
    parentId: project ? project.headRevision : null,
    config: config,
    label: String(label || "").slice(0, 60),
    at: new Date().toISOString()
  };

  const c = col("revisions");
  if (c) {
    await c.insertOne(Object.assign({}, rev));
    // keep the history bounded; the oldest go first, head is never touched
    const all = await c.find({ projectId: projectId }, { projection: { id: 1, at: 1 } }).sort({ at: -1 }).toArray();
    if (all.length > MAX_REVISIONS) {
      const drop = all.slice(MAX_REVISIONS).map((r) => r.id);
      await c.deleteMany({ id: { $in: drop } });
    }
  } else {
    const arr = mem.revisions.get(projectId) || [];
    arr.push(rev);
    mem.revisions.set(projectId, arr.slice(-MAX_REVISIONS));
  }

  await patch(projectId, { headRevision: rev.id });
  return rev;
}

async function getRevision(revisionId) {
  const c = col("revisions");
  if (c) return c.findOne({ id: revisionId }, { projection: { _id: 0 } });
  for (const arr of mem.revisions.values()) {
    const hit = arr.find((r) => r.id === revisionId);
    if (hit) return hit;
  }
  return null;
}

async function listRevisions(projectId) {
  const c = col("revisions");
  if (c) {
    return c.find({ projectId: projectId }, { projection: { _id: 0, config: 0 } }).sort({ at: -1 }).toArray();
  }
  return (mem.revisions.get(projectId) || []).slice().reverse()
    .map((r) => ({ id: r.id, projectId: r.projectId, parentId: r.parentId, label: r.label, at: r.at }));
}

async function head(projectId) {
  const project = await get(projectId);
  if (!project || !project.headRevision) return null;
  return getRevision(project.headRevision);
}

/* ================= turns ================= */

async function addTurn(projectId, turn) {
  const existing = await listTurns(projectId);
  const row = {
    id: id("tn"),
    projectId: projectId,
    seq: existing.length,
    role: turn.role === "user" ? "user" : "agent",
    kind: turn.kind || "text",
    body: String(turn.body === null || turn.body === undefined ? "" : turn.body).slice(0, 4000),
    detail: turn.detail ? String(turn.detail).slice(0, 300) : "",
    revisionId: turn.revisionId || null,
    ms: typeof turn.ms === "number" ? turn.ms : null,
    at: new Date().toISOString()
  };

  const c = col("turns");
  if (c) await c.insertOne(Object.assign({}, row));
  else {
    const arr = mem.turns.get(projectId) || [];
    arr.push(row);
    mem.turns.set(projectId, arr.slice(-MAX_TURNS));
  }
  await patch(projectId, {});     // bump updatedAt so lists sort correctly
  return row;
}

async function listTurns(projectId) {
  const c = col("turns");
  if (c) return c.find({ projectId: projectId }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray();
  return (mem.turns.get(projectId) || []).slice();
}

module.exports = {
  init, ensureIndexes, owns, slugify,
  create, get, findBySlug, findPublished, findByCustomDomain, uniquePublicSlug, list, patch, remove,
  addRevision, getRevision, listRevisions, head,
  addTurn, listTurns,
  TTL_UNCLAIMED_MS, MAX_REVISIONS
};
