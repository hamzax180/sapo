/* =================================================================
   Souqi — rate limiter (In-Memory + Upstash Redis / Vercel KV)
   -----------------------------------------------------------------
   Guards brute-force (login), spam (guest orders/inquiries) and cost
   abuse (AI proxy).
   When UPSTASH_REDIS_REST_URL / KV_REST_API_URL is configured, calls
   the REST API via fetch() for distributed serverless rate limiting.
   Otherwise, falls back to the in-memory fixed-window map.
   Emits standard X-RateLimit-* / Retry-After headers and a 429 envelope.
   ================================================================= */
"use strict";
const { httpError } = require("../lib/errors");

const redisUrl = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim().replace(/\/+$/, "");
const redisToken = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "").trim();
const hasRedis = Boolean(redisUrl && redisToken);

function rateLimit({ windowMs, max, key, prefix = "rl" }) {
  const hits = new Map(); // k -> { count, reset }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();

  return async function (req, res, next) {
    const rawKey = String((key ? key(req) : (req.ip || "ip")));
    const now = Date.now();

    if (hasRedis) {
      try {
        const fullKey = prefix + ":" + rawKey;
        const pipeRes = await fetch(redisUrl + "/pipeline", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + redisToken,
            "Content-Type": "application/json"
          },
          body: JSON.stringify([
            ["INCR", fullKey],
            ["PTTL", fullKey]
          ]),
          signal: AbortSignal.timeout(2000)
        });

        if (pipeRes.ok) {
          const results = await pipeRes.json();
          const count = results && results[0] && results[0].result;
          let pttl = results && results[1] && results[1].result;

          if (count === 1 || pttl <= 0) {
            fetch(redisUrl + "/pexpire/" + encodeURIComponent(fullKey) + "/" + windowMs, {
              headers: { "Authorization": "Bearer " + redisToken }
            }).catch(() => {});
            pttl = windowMs;
          }

          const remaining = Math.max(0, max - count);
          const resetSeconds = Math.max(1, Math.ceil((pttl > 0 ? pttl : windowMs) / 1000));

          res.setHeader("X-RateLimit-Limit", String(max));
          res.setHeader("X-RateLimit-Remaining", String(remaining));
          res.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + resetSeconds));

          if (count > max) {
            res.setHeader("Retry-After", String(resetSeconds));
            return next(httpError(429, "rate_limited", "too many requests — please slow down"));
          }
          return next();
        }
      } catch (err) {
        // Fall back to in-memory map below
      }
    }

    let e = hits.get(rawKey);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(rawKey, e); }
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

