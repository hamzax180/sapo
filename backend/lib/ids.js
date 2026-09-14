/* =================================================================
   Souqi — unique ID system (server-authoritative)
   -----------------------------------------------------------------
   Every identifiable thing gets a prefixed, sortable, collision-proof
   ID:  <prefix>_<ULID>

   ULID = 48-bit millisecond timestamp + 80 bits of randomness, encoded
   as 26 Crockford base32 chars. It is:
     • globally unique without coordination (safe across servers/DBs),
     • lexicographically sortable by creation time,
     • URL-safe and case-insensitive.

   This replaces the old Date.now() / (count+random) schemes, which
   collided under concurrency and were enumerable.
   ================================================================= */
"use strict";
const crypto = require("crypto");

// Crockford base32 — excludes I, L, O, U to avoid ambiguity.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TIME_MAX = Math.pow(2, 48) - 1;

/* ---- prefix registry: the canonical name → short prefix for each type ---- */
const PREFIXES = Object.freeze({
  workspace: "ws",
  user: "usr",
  client: "cli",
  supplier: "sup",
  product: "prd",
  quote: "qte",
  order: "ord",
  shipment: "shp",
  invoice: "inv",
  purchaseorder: "por",
  bill: "bil",
  payment: "pay",
  notification: "ntf",
  audit: "aud",
  request: "req",
  session: "ses",
  edit: "edit",
  idempotency: "idem",
  counter: "cnt"
});

/* ---- map a CRUD collection name → its entity prefix ---- */
const COLLECTION_PREFIX = Object.freeze({
  users: "usr",
  clients: "cli",
  suppliers: "sup",
  products: "prd",
  quotes: "qte",
  orders: "ord",
  shipments: "shp",
  invoices: "inv",
  purchaseorders: "por",
  bills: "bil",
  payments: "pay",
  notifications: "ntf",
  audit: "aud"
});

function encodeTime(now, len) {
  if (!Number.isFinite(now) || now > TIME_MAX || now < 0) {
    throw new Error("ids: time out of range");
  }
  let str = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    str = ENCODING[mod] + str;
    now = Math.floor(now / ENCODING_LEN);
  }
  return str;
}

function encodeRandom(len) {
  // 256 is an exact multiple of 32, so (byte % 32) is a uniform mapping —
  // no modulo bias.
  const bytes = crypto.randomBytes(len);
  let str = "";
  for (let i = 0; i < len; i++) str += ENCODING[bytes[i] % ENCODING_LEN];
  return str;
}

// Monotonic guard: if two ULIDs are requested in the same millisecond we
// keep them strictly increasing (and sortable) by incrementing the random
// component instead of drawing a fresh one.
let _lastTime = 0;
let _lastRandom = "";

function incrementBase32(str) {
  const chars = str.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = ENCODING.indexOf(chars[i]);
    if (idx < ENCODING_LEN - 1) {
      chars[i] = ENCODING[idx + 1];
      return chars.join("");
    }
    chars[i] = ENCODING[0];
  }
  // Overflow (astronomically unlikely within one ms) — draw fresh entropy.
  return encodeRandom(RANDOM_LEN);
}

/** Generate a raw 26-char ULID (monotonic within a millisecond). */
function ulid(now) {
  now = now || Date.now();
  if (now === _lastTime) {
    _lastRandom = incrementBase32(_lastRandom);
  } else {
    _lastTime = now;
    _lastRandom = encodeRandom(RANDOM_LEN);
  }
  return encodeTime(now, TIME_LEN) + _lastRandom;
}

/** Generate a prefixed id, e.g. newId("ord") -> "ord_01J9F3ZK..." */
function newId(prefix) {
  if (!prefix || typeof prefix !== "string") throw new Error("ids.newId: prefix required");
  return prefix + "_" + ulid();
}

/** A fresh request-correlation id. */
function newRequestId() {
  return newId(PREFIXES.request);
}

/** The right prefixed id for a given CRUD collection. */
function idForCollection(collection) {
  const prefix = COLLECTION_PREFIX[collection] || String(collection || "x").slice(0, 3).toLowerCase();
  return newId(prefix);
}

const ID_RE = /^([a-z]{2,6})_([0-9A-HJKMNP-TV-Z]{26})$/;

/** Validate an id; optionally require a specific prefix. */
function isValidId(value, prefix) {
  if (typeof value !== "string") return false;
  const m = ID_RE.exec(value);
  if (!m) return false;
  if (prefix && m[1] !== prefix) return false;
  return true;
}

/** Extract the millisecond timestamp encoded in a ULID (or prefixed id). */
function timestampOf(value) {
  const raw = typeof value === "string" && value.includes("_") ? value.split("_").pop() : value;
  if (typeof raw !== "string" || raw.length < TIME_LEN) return null;
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(raw[i].toUpperCase());
    if (idx < 0) return null;
    t = t * ENCODING_LEN + idx;
  }
  return t;
}

module.exports = {
  PREFIXES,
  COLLECTION_PREFIX,
  ulid,
  newId,
  newRequestId,
  idForCollection,
  isValidId,
  timestampOf
};
