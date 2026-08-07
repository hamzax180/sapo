/* =================================================================
   project-test.js — the durable object, end to end
   -----------------------------------------------------------------
   Proves the thing this whole phase exists for: a build survives a
   reload, follow-ups create new revisions without losing old ones,
   ownership is the anonymous cookie until claim, and claiming moves
   it to a real user without ever exposing another visitor's project.

   Against a REAL (in-memory) MongoDB, using cookie jars to act as two
   separate anonymous browsers. Skips cleanly if mongodb-memory-server
   can't provision a binary.

   Run: npm run test:project
   ================================================================= */
"use strict";
const assert = require("assert");
const bcrypt = require("bcryptjs");

(async () => {
  let MongoMemoryServer, MongoClient;
  try {
    ({ MongoMemoryServer } = require("mongodb-memory-server"));
    ({ MongoClient } = require("mongodb"));
  } catch (e) {
    console.log("• project-test SKIPPED (mongodb-memory-server not available):", e.message);
    process.exit(0);
  }

  let mongod;
  try { mongod = await MongoMemoryServer.create(); }
  catch (e) {
    console.log("• project-test SKIPPED (could not start in-memory mongod):", e.message);
    process.exit(0);
  }

  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.DB_NAME = "souqi_master";
  process.env.JWT_SECRET = "project-test-secret";
  process.env.PORT = "4099";
  process.env.GEMINI_API_KEY = "";
  process.env.LOG_REQUESTS = "0";

  const base = "http://localhost:4099";
  const pass = (m) => console.log("  ✓ " + m);
  const seedClient = new MongoClient(uri);
  let ok = false;

  /* A tiny cookie jar so each "browser" keeps its own anonymous identity —
     the whole point of this test is that two visitors must never collide.
     A real browser holds sq_anon AND sq_session at once; this has to MERGE
     Set-Cookie headers by name rather than overwrite the jar with the last
     one, or logging in (which sets sq_session) would silently discard the
     anon cookie that made the project claimable in the first place. */
  function browser() {
    const jar = new Map();
    return async (path, opts = {}) => {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers);
      if (jar.size) opts.headers.Cookie = [...jar].map(([k, v]) => k + "=" + v).join("; ");
      if (opts.body && typeof opts.body === "object") opts.body = JSON.stringify(opts.body);
      const r = await fetch(base + path, opts);
      const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
      raw.forEach((line) => {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
  }

  try {
    await seedClient.connect();
    await seedClient.db(process.env.DB_NAME).collection("workspaces").insertOne(
      { id: "ws_claimer", company: "Claimer Co", ownerEmail: "claimer@example.com", dbType: "local", dbUri: "" });
    await seedClient.db("webo_ws_claimer").collection("users").insertOne(
      { id: "usr_c", name: "Claimer", email: "claimer@example.com", password: bcrypt.hashSync("passC", 10), role: "Owner", active: true });

    require("./index.js");
    const deadline = Date.now() + 15000;
    for (;;) {
      try { const r = await fetch(base + "/health"); if (r.ok) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error("server did not come up");
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log("\n--- RUNNING PROJECT TESTS ---");

    const alice = browser();
    const bob = browser();

    /* ---- create ---- */
    let res = await alice("/api/projects", {
      method: "POST",
      body: { prompt: "a storefront for my Istanbul coffee roastery called Kahve Co with online ordering" }
    });
    assert.strictEqual(res.status, 201, "create failed: " + JSON.stringify(res.data));
    assert.ok(res.data.projectId && res.data.slug, "no id/slug returned");
    assert.strictEqual(res.data.meta.industry, "restaurant");
    const projectId = res.data.projectId, slug = res.data.slug;
    pass("anonymous create -> project " + slug + " (restaurant / Kahve Co)");

    /* ---- THE keystone: it survives a reload, by slug, with no rebuild ---- */
    res = await alice("/api/projects/" + slug);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.project.title, "Kahve Co");
    assert.strictEqual(res.data.turns.length, 2, "expected a user turn + an agent turn");
    assert.strictEqual(res.data.turns[0].role, "user");
    assert.strictEqual(res.data.turns[0].body.indexOf("Kahve Co") >= 0, true);
    assert.ok(res.data.config.pages.main, "reload did not return the built config");
    pass("GET by slug replays the transcript and the config — no rebuild needed");

    res = await alice("/api/projects/" + projectId);
    assert.strictEqual(res.status, 200, "lookup by id failed");
    pass("GET by id works too");

    /* ---- someone else cannot read it ----
       Slugs are scoped per-owner (two visitors can both have "kahve-co"), so
       the slug lookup itself is filtered by the caller's identity — bob's
       query for "kahve-co" correctly finds nothing of HIS, which is 404, not
       403. That's the more secure shape: it never confirms a slug exists
       under someone else's account. The ID lookup below is NOT owner-scoped
       at the query level, so it's what actually proves the 403 check works. */
    res = await bob("/api/projects/" + slug);
    assert.strictEqual(res.status, 404, "slug lookup leaked something about another owner's project");
    pass("a different anonymous cookie querying the same slug -> 404 (scoped per-owner, confirms nothing)");

    res = await bob("/api/projects/" + projectId);
    assert.strictEqual(res.status, 403, "ID lookup let a different anonymous visitor read this project");
    pass("the same visitor, by project id (not owner-scoped at query time) -> 403 from the ownership check");

    /* ---- it shows up in "my projects" ---- */
    res = await alice("/api/projects");
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.projects.some((p) => p.id === projectId), "project missing from the owner's list");
    res = await bob("/api/projects");
    assert.strictEqual(res.data.projects.length, 0, "bob's list is not empty");
    pass("project lists are correctly scoped per anonymous owner");

    /* ---- follow-up: a new revision, the old one intact ---- */
    res = await alice("/api/projects/" + slug + "/turns", { method: "POST", body: { message: "make it green" } });
    assert.strictEqual(res.status, 200, "follow-up failed: " + JSON.stringify(res.data));
    const secondRevision = res.data.revisionId;
    pass("follow-up applied -> new revision " + secondRevision);

    res = await alice("/api/projects/" + slug);
    assert.strictEqual(res.data.revisions.length, 2, "expected 2 revisions after one follow-up");
    assert.strictEqual(res.data.turns.length, 4, "expected 2 more turns after the follow-up");
    pass("history now has 2 revisions and 4 turns — nothing was overwritten");

    /* ---- restore: appends, never rewinds ---- */
    const firstRevision = res.data.revisions[res.data.revisions.length - 1].id;
    res = await alice("/api/projects/" + slug + "/restore", { method: "POST", body: { revisionId: firstRevision } });
    assert.strictEqual(res.status, 200, "restore failed: " + JSON.stringify(res.data));

    res = await alice("/api/projects/" + slug);
    assert.strictEqual(res.data.revisions.length, 3, "restore should ADD a revision, not rewind to 1");
    pass("restore appends a 3rd revision; the one it restored FROM is still there");

    /* ---- claim: knowing the id/slug is not authorisation ---- */
    res = await bob("/auth/login", { method: "POST", headers: { "x-workspace-id": "ws_claimer" }, body: { email: "claimer@example.com", password: "passC" } });
    assert.strictEqual(res.status, 200);
    const bobToken = res.data.token;

    // by slug: scoped per-owner, so bob's lookup finds nothing of his — 404,
    // same reasoning as the read endpoint above.
    res = await bob("/api/projects/" + slug + "/claim", {
      method: "POST", headers: { Authorization: "Bearer " + bobToken }, body: { wsId: "ws_claimer" }
    });
    assert.strictEqual(res.status, 404, "slug-based claim leaked something about another owner's project");
    pass("claim by slug from a different anonymous visitor -> 404 (confirms nothing)");

    // by id: not owner-scoped at lookup time, so this is what actually proves
    // a valid workspace token + a real project id still isn't enough — the
    // anonymous cookie on the request has to match who made it.
    res = await bob("/api/projects/" + projectId + "/claim", {
      method: "POST", headers: { Authorization: "Bearer " + bobToken }, body: { wsId: "ws_claimer" }
    });
    assert.strictEqual(res.status, 403, "bob claimed alice's project with a valid token but the wrong anon cookie");
    pass("claim by id from a different anonymous visitor -> 403, despite a real owner JWT");

    res = await alice("/auth/login", { method: "POST", headers: { "x-workspace-id": "ws_claimer" }, body: { email: "claimer@example.com", password: "passC" } });
    assert.strictEqual(res.status, 200);
    const aliceToken = res.data.token;

    res = await alice("/api/projects/" + slug + "/claim", {
      method: "POST", headers: { Authorization: "Bearer " + aliceToken }, body: { wsId: "ws_claimer" }
    });
    assert.strictEqual(res.status, 200, "the rightful claim failed: " + JSON.stringify(res.data));
    assert.ok(res.data.editToken, "no edit token issued");
    pass("alice (the anon owner) claims her own project -> 200 + edit token");

    const ws = await seedClient.db(process.env.DB_NAME).collection("workspaces").findOne({ id: "ws_claimer" });
    assert.ok(ws.storefrontConfig, "storefrontConfig was not written");
    assert.strictEqual(ws.storefrontEnabled, true);
    pass("the workspace now serves the project's head revision");

    const proj = await seedClient.db(process.env.DB_NAME).collection("projects").findOne({ id: projectId });
    assert.strictEqual(proj.ownerUserId, aliceToken ? JSON.parse(Buffer.from(aliceToken.split(".")[1], "base64").toString()).id : null);
    assert.strictEqual(proj.wsId, "ws_claimer");
    assert.strictEqual(proj.expiresAt, null, "a claimed project must not have a TTL any more");
    pass("ownership moved from the anon cookie to the user, in place — nothing copied");

    /* ---- the public portal serves it ---- */
    res = await alice("/api/portal/ws_claimer/config");
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.storefrontConfig && res.data.storefrontConfig.pages, "portal does not serve the claimed config");
    pass("the public portal serves the claimed storefront");

    /* ---- publish: claim auto-publishes once, then nothing is live again
       until asked (docs/AGENT-GAP-AUDIT.md §1.3) ---- */
    const aliceAuth = { Authorization: "Bearer " + aliceToken };
    res = await alice("/api/projects/" + slug, { headers: aliceAuth });
    const revisionAtClaim = res.data.revisionId;
    assert.strictEqual(res.data.project.publishedRevisionId, revisionAtClaim, "claim should publish the revision it claimed, immediately");
    pass("claiming publishes the head revision as a side effect — publishedRevisionId matches");

    // a follow-up on a CLAIMED project creates a new head — the workspace's
    // live storefrontConfig must NOT move until /publish says so
    res = await alice("/api/projects/" + slug + "/turns", { method: "POST", headers: aliceAuth, body: { message: "make it darker" } });
    assert.strictEqual(res.status, 200, "post-claim follow-up failed: " + JSON.stringify(res.data));
    const revisionAfterPatch = res.data.revisionId;
    const patchedTheme = res.data.config.theme;
    assert.notStrictEqual(revisionAfterPatch, revisionAtClaim, "the follow-up did not move the head");

    let wsRow = await seedClient.db(process.env.DB_NAME).collection("workspaces").findOne({ id: "ws_claimer" });
    assert.notDeepStrictEqual(wsRow.storefrontConfig.theme, patchedTheme, "the live site changed WITHOUT a publish — that is the exact bug this endpoint exists to prevent");
    pass("a post-claim follow-up creates a new revision but does NOT touch the live storefrontConfig — divergence is real, not theoretical");

    // publishing with only the anon cookie (no session token) must fail —
    // projects.owns() is checked BEFORE assertOwnsWorkspace, and it's
    // asymmetric on a claimed project (same property microclaim-test.js
    // proves for GET/turns): the cookie alone no longer owns it, so this
    // is a 403 from the ownership check, never reaching the workspace-auth
    // check that would otherwise 401.
    res = await alice("/api/projects/" + slug + "/publish", { method: "POST" });
    assert.strictEqual(res.status, 403, "publish succeeded with no owner token at all");
    pass("publish with no Authorization header -> 403 (the anon cookie no longer owns a claimed project)");

    res = await alice("/api/projects/" + slug + "/publish", { method: "POST", headers: aliceAuth });
    assert.strictEqual(res.status, 200, "the rightful publish failed: " + JSON.stringify(res.data));
    assert.strictEqual(res.data.publishedRevisionId, revisionAfterPatch);
    pass("publish reconciles the live site with the current head -> 200");

    wsRow = await seedClient.db(process.env.DB_NAME).collection("workspaces").findOne({ id: "ws_claimer" });
    assert.deepStrictEqual(wsRow.storefrontConfig.theme, patchedTheme, "publish did not actually push the patched revision's config live");
    const proj2 = await seedClient.db(process.env.DB_NAME).collection("projects").findOne({ id: projectId });
    assert.strictEqual(proj2.publishedRevisionId, revisionAfterPatch, "publishedRevisionId did not move to the newly published revision");
    pass("the live storefrontConfig and the project's publishedRevisionId both now reflect the follow-up");

    // publishing again with nothing new to publish is a clean no-op, not an error
    res = await alice("/api/projects/" + slug + "/publish", { method: "POST", headers: aliceAuth });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.alreadyPublished, true, "re-publishing an unchanged head should say so, not silently rewrite again");
    pass("publishing with nothing new -> alreadyPublished:true, not a second write");

    /* ---- an unclaimed project has nothing to publish to ---- */
    res = await alice("/api/projects", { method: "POST", body: { prompt: "a storefront for my Izmir bicycle shop called Tekerlek", industry: "retail" } });
    assert.strictEqual(res.status, 201);
    res = await alice("/api/projects/" + res.data.slug + "/publish", { method: "POST" });
    assert.strictEqual(res.status, 400, "publish on an unclaimed project should refuse, not 500 or silently no-op");
    pass("publish on an unclaimed project -> 400, not claimed yet");

    console.log("\n✓ ALL PROJECT TESTS PASSED");
    ok = true;
  } catch (e) {
    console.error("\n✗ PROJECT TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  } finally {
    try { await seedClient.close(); } catch (e) {}
    try { await mongod.stop(); } catch (e) {}
    process.exit(ok ? 0 : 1);
  }
})();
