/* =================================================================
   Souqi — in-memory fixed-window rate limiter
   -----------------------------------------------------------------
   Guards brute-force (login), spam (guest orders/inquiries) and cost
   abuse (AI proxy). Single-process only; for a multi-instance
   deployment back this with Redis (see ARCHITECTURE-PLAN §6). Emits
   standard X-RateLimit-* / Retry-After headers and a 429 envelope.
   ================================================================= */
"use strict";
const { httpError } = require("../lib/errors");

function rateLimit({ windowMs, max, key }) {
  const hits = new Map(); // k -> { count, reset }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref(); // never keep the process alive

  return function (req, res, next) {
    const k = String((key ? key(req) : (req.ip || "ip")));
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    e.count++;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - e.count)));
    if (e.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
      return next(httpError(429, "rate_limited", "too many requests — please slow down"));
    }
    next();
  };
}

module.exports = { rateLimit };
