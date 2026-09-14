/* =================================================================
   ratelimit-test.js — the counter is shared, and it is namespaced
   -----------------------------------------------------------------
   Two properties, both of which were once false in production.

   SHARED. The limiter had one distributed backend, Redis, and no Redis
   is configured. Production is serverless, so every limit fell back to
   a Map inside one lambda instance: attempts scattered across instances
   and every counter restarted at zero on the next cold start. A "30 per
   15 minutes" login limit was, in effect, no limit. This asserts the
   count lands somewhere every instance can see it.

   NAMESPACED. In-memory, each limiter owned a private Map and two
   limiters keyed the same way could never interfere. Shared, they can —
   and nothing passed a prefix, so every limiter wrote under "rl". Two
   ip-keyed limiters would have spent each other's budget, and whichever
   was tighter would have begun refusing traffic the looser one used up.

   Talks to the real database, in its own namespace, and cleans up.
   ================================================================= */
"use strict";

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const pass = (m) => console.log("  ✓ " + m);

/* Enough of express's req/res for the middleware. */
function fakeReq(ip) { return { ip: ip, headers: {}, body: {} }; }
function fakeRes() { const h = {}; return { setHeader: (k, v) => { h[k] = v; }, headers: h }; }
function hit(mw, ip) {
  return new Promise((resolve) => {
    mw(fakeReq(ip), fakeRes(), (err) => resolve(err && err.status === 429 ? 429 : 200));
  });
}

(async () => {
  let MongoClient;
  try { ({ MongoClient } = require("mongodb")); require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") }); }
  catch (e) { console.log("• ratelimit-test SKIPPED (" + e.message + ")"); return; }
  if (!process.env.MONGODB_URI) { console.log("• ratelimit-test SKIPPED (no MONGODB_URI)"); return; }

  const db = require("../db");
  await db.connect();
  const { rateLimit } = require("../middleware/rateLimit");

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const rates = client.db(process.env.DB_NAME).collection("ratelimits");
  const clean = () => rates.deleteMany({ _id: { $regex: "^rl-test-" } });
  await clean();

  console.log("\n── rate limiting ──────────────────────────────────────");

  /* ---- it trips, and it trips where it says it does ---- */
  const five = rateLimit({ windowMs: 60000, max: 5, prefix: "rl-test-a", key: (r) => r.ip });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push(await hit(five, "1.2.3.4"));
  if (codes.slice(0, 5).every((c) => c === 200) && codes[5] === 429 && codes[6] === 429) {
    pass("max:5 lets 5 through and refuses the 6th");
  } else fail("expected 5x200 then 429s, got " + codes.join(","));

  /* ---- THE property: the count is in the shared store, not in a Map ---- */
  const row = await rates.findOne({ _id: "rl-test-a:1.2.3.4" });
  if (row && row.count === 7) pass("the count landed in the shared store, where another instance can read it");
  else fail("no shared counter for this limiter — it is running in-process only (row: " + JSON.stringify(row) + ")");

  /* ---- and it expires itself ---- */
  if (row && row.reset instanceof Date && row.reset.getTime() > Date.now()) pass("the row carries its own expiry");
  else fail("the row has no future reset date, so the TTL index will not clear it");
  const idx = await rates.indexes();
  if (idx.some((i) => i.expireAfterSeconds === 0)) pass("a TTL index exists, so counters do not accumulate forever");
  else fail("no TTL index on ratelimits — rows will pile up");

  /* ---- namespaces: same key, two limiters, no interference ---- */
  await clean();
  const strict = rateLimit({ windowMs: 60000, max: 2, prefix: "rl-test-strict", key: (r) => r.ip });
  const loose = rateLimit({ windowMs: 60000, max: 50, prefix: "rl-test-loose", key: (r) => r.ip });
  for (let i = 0; i < 10; i++) await hit(loose, "9.9.9.9");     // burn the loose one
  const after = await hit(strict, "9.9.9.9");                    // strict has seen nothing
  if (after === 200) pass("a busy limiter does not spend another limiter's budget");
  else fail("two limiters on the same key shared a counter — the namespace is not doing its job");

  /* ---- and a limiter with no prefix still gets its own ---- */
  await clean();
  const anonA = rateLimit({ windowMs: 60000, max: 2, key: (r) => r.ip });
  const anonB = rateLimit({ windowMs: 60000, max: 2, key: (r) => r.ip });
  await hit(anonA, "7.7.7.7"); await hit(anonA, "7.7.7.7"); await hit(anonA, "7.7.7.7");
  const bStill = await hit(anonB, "7.7.7.7");
  if (bStill === 200) pass("limiters that declare no prefix are still separated from each other");
  else fail("two unprefixed limiters collided — the automatic namespace is not unique");

  await clean();
  await client.close();
  await db.close();

  if (failures) { console.log("\n✗ " + failures + " RATE-LIMIT CHECK(S) FAILED\n"); process.exit(1); }
  console.log("\n✓ ALL RATE-LIMIT TESTS PASSED\n");
})().catch((e) => { console.error("harness failed: " + (e && e.stack || e)); process.exit(1); });
