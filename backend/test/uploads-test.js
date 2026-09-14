/* =================================================================
   uploads.js behaviour, driven through the in-memory fallback so it runs
   with no Mongo — which is also the path a dev with no MONGODB_URI hits,
   so exercising it is not a shortcut.

   Run: node server/uploads-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const uploads = require("../lib/uploads");

uploads.init({ getMasterDb: () => null });   // force the in-memory path

let passed = 0;
async function ok(name, fn) {
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

const ANNA = { anonId: "anon-anna", userId: null };
const BOB = { anonId: "anon-bob", userId: null };

const mk = (owner, over) => uploads.create(Object.assign({
  owner: owner, key: "u/k.png", url: "https://cdn/u/k.png", name: "k.png", mime: "image/png", ext: "png"
}, over || {}));

(async () => {
  console.log("\ncreation");

  await ok("starts pending, with a TTL, owned by whoever attached it", async () => {
    const r = await mk(ANNA);
    assert.strictEqual(r.status, "pending");
    assert.strictEqual(r.projectId, null);
    assert.strictEqual(r.ownerAnonId, "anon-anna");
    assert.ok(r.expiresAt instanceof Date, "unused uploads must be reapable");
    assert.match(r.id, /^img_/);
  });

  await ok("client-reported dimensions are kept but not trusted as status", async () => {
    const r = await mk(ANNA, { width: 9999, height: 1 });
    assert.strictEqual(r.width, 9999);
    assert.strictEqual(r.status, "pending", "dimensions must not imply verification");
  });

  console.log("\nownership");

  await ok("either identity is sufficient, neither leaks across people", async () => {
    const r = await mk(ANNA);
    assert.strictEqual(uploads.owns(r, ANNA), true);
    assert.strictEqual(uploads.owns(r, BOB), false);
    const claimed = await uploads.patch(r.id, { ownerUserId: "u1" });
    assert.strictEqual(uploads.owns(claimed, { userId: "u1" }), true);
    // the cookie must keep working after the account claims it
    assert.strictEqual(uploads.owns(claimed, ANNA), true);
  });

  console.log("\nresolving ids for a build");

  await ok("keeps the order the ids were given in", async () => {
    const a = await mk(ANNA, { name: "a.png" });
    const b = await mk(ANNA, { name: "b.png" });
    const c = await mk(ANNA, { name: "c.png" });
    for (const r of [a, b, c]) await uploads.markReady(r.id, { bytes: 10, mime: "image/png" });
    // "use the second one as the hero" has to mean what the composer showed
    const got = await uploads.listForOwner([c.id, a.id, b.id], ANNA);
    assert.deepStrictEqual(got.map((r) => r.name), ["c.png", "a.png", "b.png"]);
  });

  await ok("drops anything still pending", async () => {
    const ready = await mk(ANNA); await uploads.markReady(ready.id, { bytes: 10 });
    const pending = await mk(ANNA);
    const got = await uploads.listForOwner([ready.id, pending.id], ANNA);
    assert.deepStrictEqual(got.map((r) => r.id), [ready.id]);
  });

  await ok("drops someone else's images even when the id is guessed", async () => {
    const hers = await mk(ANNA); await uploads.markReady(hers.id, { bytes: 10 });
    assert.deepStrictEqual(await uploads.listForOwner([hers.id], BOB), []);
  });

  await ok("a failed upload is never usable", async () => {
    const r = await mk(ANNA);
    await uploads.markReady(r.id, { bytes: 10 });
    await uploads.markFailed(r.id, "magic bytes said text/html");
    assert.deepStrictEqual(await uploads.listForOwner([r.id], ANNA), []);
  });

  console.log("\nbecoming permanent");

  await ok("first use clears the TTL and records the project", async () => {
    const r = await mk(ANNA); await uploads.markReady(r.id, { bytes: 10 });
    await uploads.attachToProject([r.id], "pr_1");
    const after = await uploads.get(r.id);
    assert.strictEqual(after.projectId, "pr_1");
    assert.strictEqual(after.expiresAt, null, "a published site must not expire out from under itself");
    assert.ok(after.lastUsedAt);
  });

  await ok("re-use in a second project does not re-point the first", async () => {
    const r = await mk(ANNA); await uploads.markReady(r.id, { bytes: 10 });
    await uploads.attachToProject([r.id], "pr_1");
    await uploads.attachToProject([r.id], "pr_2");
    assert.strictEqual((await uploads.get(r.id)).projectId, "pr_1");
  });

  console.log("\nclaiming an account");

  await ok("signing in carries the images over with the projects", async () => {
    const r = await mk(ANNA); await uploads.markReady(r.id, { bytes: 10 });
    const res = await uploads.claimAnon("anon-anna", "user-7");
    assert.ok(res.claimed >= 1);
    const after = await uploads.get(r.id);
    assert.strictEqual(after.ownerUserId, "user-7");
    assert.strictEqual(after.ownerAnonId, "anon-anna", "the cookie must still work");
    assert.deepStrictEqual((await uploads.listForOwner([r.id], { userId: "user-7" })).length, 1);
  });

  console.log("\ndescription cache");

  await ok("caches what vision saw, and records that it was asked", async () => {
    const r = await mk(BOB);
    assert.strictEqual(r.describedAt, null);
    await uploads.setDescription(r.id, "A warm-lit cafe interior, exposed brick.", 0.0011);
    const after = await uploads.get(r.id);
    assert.match(after.description, /cafe interior/);
    assert.ok(after.describedAt, "describedAt is what stops a re-ask");
    assert.strictEqual(after.describeCostUsd, 0.0011);
  });

  await ok("an empty description still counts as asked", async () => {
    const r = await mk(BOB);
    await uploads.setDescription(r.id, "", 0);   // vision unavailable
    const after = await uploads.get(r.id);
    assert.strictEqual(after.description, "");
    assert.ok(after.describedAt, "a failure must not be retried on every turn");
  });

  await ok("a runaway description cannot flood the prompt", async () => {
    const r = await mk(BOB);
    await uploads.setDescription(r.id, "x".repeat(5000), 0);
    assert.strictEqual((await uploads.get(r.id)).description.length, uploads.MAX_DESCRIPTION);
  });

  console.log("\nquota input");

  await ok("counts this owner's uploads since a date, and nobody else's", async () => {
    const fresh = { anonId: "anon-quota", userId: null };
    await mk(fresh); await mk(fresh); await mk(ANNA);
    const n = await uploads.countSince(fresh, "1970-01-01T00:00:00.000Z");
    assert.strictEqual(n, 2);
    assert.strictEqual(await uploads.countSince(fresh, "2999-01-01T00:00:00.000Z"), 0);
  });

  console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
})();
