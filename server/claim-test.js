/* =================================================================
   claim-test.js — prompt ➜ draft ➜ owned, published storefront
   -----------------------------------------------------------------
   The claim is where an anonymous draft becomes someone's property, so
   it is the endpoint most worth proving. Against a REAL (in-memory)
   MongoDB this checks the happy path AND, more importantly, that
   knowing a draft id grants nothing:

     · no token            -> 401
     · another owner's token -> 403
     · valid owner         -> config published, edit token issued
     · claiming twice      -> 404 (a draft is single-use)

   Skips cleanly if mongodb-memory-server can't provision a binary.
   Run: npm run test:claim
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
    console.log("• claim-test SKIPPED (mongodb-memory-server not available):", e.message);
    process.exit(0);
  }

  let mongod;
  try { mongod = await MongoMemoryServer.create(); }
  catch (e) {
    console.log("• claim-test SKIPPED (could not start in-memory mongod):", e.message);
    process.exit(0);
  }

  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.DB_NAME = "souqi_master";
  process.env.JWT_SECRET = "claim-test-secret";
  process.env.PORT = "4098";
  process.env.GEMINI_API_KEY = "";
  process.env.LOG_REQUESTS = "0";

  const base = "http://localhost:4098";
  const pass = (m) => console.log("  ✓ " + m);
  const seedClient = new MongoClient(uri);
  let ok = false;

  try {
    await seedClient.connect();

    // Two owners, so "another owner's token" is a real case and not a fiction.
    await seedClient.db(process.env.DB_NAME).collection("workspaces").insertMany([
      { id: "ws_owner1", company: "Owner One", ownerEmail: "one@example.com", dbType: "local", dbUri: "" },
      { id: "ws_owner2", company: "Owner Two", ownerEmail: "two@example.com", dbType: "local", dbUri: "" }
    ]);
    await seedClient.db("webo_ws_owner1").collection("users").insertOne(
      { id: "usr_1", name: "One", email: "one@example.com", password: bcrypt.hashSync("pass1", 10), role: "Owner", active: true });
    await seedClient.db("webo_ws_owner2").collection("users").insertOne(
      { id: "usr_2", name: "Two", email: "two@example.com", password: bcrypt.hashSync("pass2", 10), role: "Owner", active: true });

    require("./index.js");

    const deadline = Date.now() + 15000;
    for (;;) {
      try { const r = await fetch(base + "/health"); if (r.ok) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error("server did not come up");
      await new Promise((r) => setTimeout(r, 250));
    }

    const req = async (path, opts = {}) => {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers);
      if (opts.body && typeof opts.body === "object") opts.body = JSON.stringify(opts.body);
      const r = await fetch(base + path, opts);
      return { status: r.status, data: await r.json().catch(() => null) };
    };

    console.log("\n--- RUNNING AGENT CLAIM TESTS ---");

    /* ---- build a draft, anonymously, exactly as the home page does ---- */
    let res = await req("/api/agent/build", {
      method: "POST",
      body: { prompt: "a storefront for my Istanbul coffee roastery called Kahve Co with online ordering" }
    });
    assert.strictEqual(res.status, 200, "build failed: " + JSON.stringify(res.data));
    assert.ok(res.data.draftId, "no draft id");
    assert.strictEqual(res.data.meta.industry, "restaurant");
    assert.strictEqual(res.data.meta.company, "Kahve Co");
    const draftId = res.data.draftId;
    pass("anonymous build -> draft " + draftId + " (restaurant / Kahve Co)");

    // it persisted to Mongo, not just memory
    const stored = await seedClient.db(process.env.DB_NAME).collection("agent_drafts").findOne({ id: draftId });
    assert.ok(stored, "draft was not written to the master DB");
    assert.ok(stored.expiresAt instanceof Date, "draft has no TTL date");
    pass("draft persisted with a TTL date");

    res = await req("/api/agent/draft/" + draftId);
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.config.pages.main, "draft read back without a home page");
    pass("draft can be read back");

    /* ---- knowing the draft id must grant nothing ---- */
    res = await req("/api/agent/claim", { method: "POST", body: { draftId: draftId, wsId: "ws_owner1" } });
    assert.strictEqual(res.status, 401);
    pass("claim without a token -> 401");

    res = await req("/auth/login", { method: "POST", headers: { "x-workspace-id": "ws_owner1" }, body: { email: "one@example.com", password: "pass1" } });
    assert.strictEqual(res.status, 200);
    const token1 = res.data.token;

    res = await req("/auth/login", { method: "POST", headers: { "x-workspace-id": "ws_owner2" }, body: { email: "two@example.com", password: "pass2" } });
    assert.strictEqual(res.status, 200);
    const token2 = res.data.token;

    // owner two holds a perfectly valid token — for a workspace that is not this one
    res = await req("/api/agent/claim", {
      method: "POST", headers: { Authorization: "Bearer " + token2 },
      body: { draftId: draftId, wsId: "ws_owner1" }
    });
    assert.strictEqual(res.status, 403, "another owner was allowed to claim into ws_owner1");
    pass("claim with another owner's token -> 403");

    // and the draft must still be there afterwards
    assert.ok(await seedClient.db(process.env.DB_NAME).collection("agent_drafts").findOne({ id: draftId }),
      "a rejected claim consumed the draft");
    pass("a rejected claim leaves the draft intact");

    /* ---- the real thing ---- */
    res = await req("/api/agent/claim", {
      method: "POST", headers: { Authorization: "Bearer " + token1 },
      body: { draftId: draftId, wsId: "ws_owner1" }
    });
    assert.strictEqual(res.status, 200, "claim failed: " + JSON.stringify(res.data));
    assert.ok(res.data.editToken, "no edit token issued");
    pass("owner claims the draft -> 200 + edit token");

    const ws = await seedClient.db(process.env.DB_NAME).collection("workspaces").findOne({ id: "ws_owner1" });
    assert.ok(ws.storefrontConfig, "storefrontConfig was not written");
    assert.strictEqual(ws.storefrontEnabled, true, "storefront was not enabled");
    assert.strictEqual(ws.storefrontConfig.themeVersion, 3);
    assert.ok(ws.storefrontConfig.pages.main.blocks.length >= 4, "home page is too thin");
    pass("workspace now serves the built site (" + ws.storefrontConfig.pages.main.blocks.length + " blocks on the home page)");

    // the edit token must actually open the editor for THIS workspace
    res = await req("/api/storefront/edit-token/verify?wsId=ws_owner1", { headers: { "x-edit-token": res.data.editToken } });
    assert.strictEqual(res.status, 200);
    pass("the issued edit token verifies against the workspace");

    /* ---- one draft, one claim ---- */
    res = await req("/api/agent/claim", {
      method: "POST", headers: { Authorization: "Bearer " + token1 },
      body: { draftId: draftId, wsId: "ws_owner1" }
    });
    assert.strictEqual(res.status, 404, "a draft was claimable twice");
    pass("claiming the same draft twice -> 404");

    /* ---- the public portal now serves it ---- */
    res = await req("/api/portal/ws_owner1/config");
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.storefrontConfig && res.data.storefrontConfig.pages, "portal does not serve the config");
    pass("the public portal serves the claimed storefront");

    console.log("\n✓ ALL CLAIM TESTS PASSED");
    ok = true;
  } catch (e) {
    console.error("\n✗ CLAIM TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  } finally {
    try { await seedClient.close(); } catch (e) {}
    try { await mongod.stop(); } catch (e) {}
    process.exit(ok ? 0 : 1);
  }
})();
