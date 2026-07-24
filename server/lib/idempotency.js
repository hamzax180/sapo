/* =================================================================
   Souqi — idempotency
   -----------------------------------------------------------------
   Ensures an unsafe POST carrying an `Idempotency-Key` header runs at
   most once per (scope, key) — so a retried or double-submitted
   checkout creates exactly one order.

   Correctness model (master DB available):
     • Atomically RESERVE the key (insert _id=scope:key, state=pending).
       The unique _id makes the first writer win; losers either replay
       the completed result or get 409 while it's still in flight.
     • On a 2xx response, FINALIZE (store status+body). On failure,
       release the reservation so the client may retry.
   A single-process in-memory fallback is used when there is no master
   DB (demo mode). Entries expire after 24h (TTL index / timestamp).
   ================================================================= */
"use strict";
const { httpError } = require("./errors");

let _getMasterDb = null;
const mem = new Map(); // scope:key -> { state, status, body, exp }
const TTL_MS = 24 * 60 * 60 * 1000;
const TTL_S = 24 * 60 * 60;

function initIdempotency({ getMasterDb }) { _getMasterDb = getMasterDb; }

function captureAnd(res, onSuccess, onFailure) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) onSuccess(body);
      else onFailure();
    } catch (e) { /* never let bookkeeping break the response */ }
    return origJson(body);
  };
}

/**
 * Express middleware factory. `scopeFn(req)` returns the tenant/scope
 * (e.g. the workspace id) so keys never collide across tenants.
 */
function withIdempotency(scopeFn) {
  return async function (req, res, next) {
    const key = req.headers["idempotency-key"];
    if (!key || typeof key !== "string" || key.length < 8 || key.length > 200) return next();
    const scope = String((scopeFn && scopeFn(req)) || "default");
    const id = scope + ":" + key;

    const db = _getMasterDb && _getMasterDb();
    if (db) {
      const coll = db.collection("idempotency");
      try {
        await coll.insertOne({ _id: id, state: "pending", createdAt: new Date() });
        coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_S }).catch(() => {});
      } catch (e) {
        // Reservation exists — replay if done, else it's still processing.
        const existing = await coll.findOne({ _id: id }).catch(() => null);
        if (existing && existing.state === "done") {
          res.setHeader("Idempotency-Replayed", "true");
          return res.status(existing.status || 200).json(existing.body);
        }
        return next(httpError(409, "in_progress", "a request with this Idempotency-Key is already being processed"));
      }
      captureAnd(res,
        (body) => { coll.updateOne({ _id: id }, { $set: { state: "done", status: res.statusCode, body, doneAt: new Date() } }).catch(() => {}); },
        () => { coll.deleteOne({ _id: id }).catch(() => {}); }
      );
      return next();
    }

    // In-memory fallback.
    const hit = mem.get(id);
    if (hit && hit.state === "done" && hit.exp > Date.now()) {
      res.setHeader("Idempotency-Replayed", "true");
      return res.status(hit.status).json(hit.body);
    }
    if (hit && hit.state === "pending" && hit.exp > Date.now()) {
      return next(httpError(409, "in_progress", "a request with this Idempotency-Key is already being processed"));
    }
    mem.set(id, { state: "pending", exp: Date.now() + TTL_MS });
    captureAnd(res,
      (body) => { mem.set(id, { state: "done", status: res.statusCode, body, exp: Date.now() + TTL_MS }); },
      () => { mem.delete(id); }
    );
    next();
  };
}

module.exports = { initIdempotency, withIdempotency };
