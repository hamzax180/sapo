/* =================================================================
   microclaim-test.js — the two-field claim, end to end
   -----------------------------------------------------------------
   Phase 6 (docs/AGENT-PARITY-PLAN.md §7): "own it in ten seconds"
   instead of a twelve-field signup. One endpoint creates the account,
   the workspace, AND claims the project's head revision as the live
   storefront — proves the whole chain against a REAL (in-memory)
   MongoDB, including the cases that must NOT be allowed to happen:

     · knowing a project id is not authorisation for anything
     · an email already tied to a workspace can't mint a second one
     · a project already attached to a workspace can't be claimed twice
     · the minted session token actually authenticates afterwards
     · the stored password is bcrypt-hashed, never plaintext

   Skips cleanly if mongodb-memory-server can't provision a binary.
   Run: npm run test:microclaim
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
    console.log("• microclaim-test SKIPPED (mongodb-memory-server not available):", e.message);
    process.exit(0);
  }

  let mongod;
  try { mongod = await MongoMemoryServer.create(); }
  catch (e) {
    console.log("• microclaim-test SKIPPED (could not start in-memory mongod):", e.message);
    process.exit(0);
  }

  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.DB_NAME = "souqi_master";
  process.env.JWT_SECRET = "microclaim-test-secret";
  process.env.PORT = "4097";
  process.env.GEMINI_API_KEY = "";
  process.env.LOG_REQUESTS = "0";

  const base = "http://localhost:4097";
  const pass = (m) => console.log("  ✓ " + m);
  const seedClient = new MongoClient(uri);
  let ok = false;

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
    require("./index.js");
    const deadline = Date.now() + 15000;
    for (;;) {
      try { const r = await fetch(base + "/health"); if (r.ok) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error("server did not come up");
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log("\n--- RUNNING MICRO-CLAIM TESTS ---");

    const alice = browser();
    const bob = browser();

    /* ---- build, anonymously, exactly as the agent page does ---- */
    let res = await alice("/api/projects", {
      method: "POST",
      body: { prompt: "a storefront for my Istanbul coffee roastery called Kahve Co with online ordering" }
    });
    assert.strictEqual(res.status, 201, "create failed: " + JSON.stringify(res.data));
    const projectId = res.data.projectId, slug = res.data.slug;
    assert.strictEqual(res.data.meta.industry, "restaurant");
    pass("anonymous build -> project " + slug + " (restaurant / Kahve Co)");

    /* ---- validation: both fields are required ---- */
    res = await alice("/api/projects/" + slug + "/micro-claim", { method: "POST", body: { email: "kahve@example.com" } });
    assert.strictEqual(res.status, 400, "missing password should 400");
    pass("micro-claim without a password -> 400");

    /* ---- knowing the id/slug is not authorisation ---- */
    res = await bob("/api/projects/" + projectId + "/micro-claim", {
      method: "POST", body: { email: "thief@example.com", password: "stolen1" }
    });
    assert.strictEqual(res.status, 403, "a different anonymous visitor was allowed to micro-claim alice's project");
    pass("micro-claim by id from a different anonymous visitor -> 403");

    /* ---- the real thing: two fields, one call ---- */
    res = await alice("/api/projects/" + slug + "/micro-claim", {
      method: "POST", body: { email: "kahve@example.com", password: "roastery1" }
    });
    assert.strictEqual(res.status, 200, "micro-claim failed: " + JSON.stringify(res.data));
    assert.ok(res.data.wsId, "no wsId returned");
    assert.ok(res.data.token, "no session token returned");
    assert.ok(res.data.editToken, "no edit token returned");
    assert.strictEqual(res.data.user.role, "Owner");
    const wsId = res.data.wsId;
    const editToken = res.data.editToken;
    const claimToken = res.data.token;
    pass("alice claims with just email + password -> 200, session + edit tokens issued");

    /* ---- the workspace now serves the built site ---- */
    const ws = await seedClient.db(process.env.DB_NAME).collection("workspaces").findOne({ id: wsId });
    assert.ok(ws, "workspace was not created");
    assert.strictEqual(ws.ownerEmail, "kahve@example.com");
    assert.strictEqual(ws.industry, "restaurant", "industry should default from the project's meta");
    assert.strictEqual(ws.company, "Kahve Co", "company should default from the project's meta");
    assert.ok(ws.storefrontConfig, "storefrontConfig was not written");
    assert.strictEqual(ws.storefrontEnabled, true);
    pass("workspace provisioned from the project's own meta (no form fields needed) and serving the site");

    /* ---- ownership moved from the anon cookie to the new user ---- */
    const proj = await seedClient.db(process.env.DB_NAME).collection("projects").findOne({ id: projectId });
    assert.strictEqual(proj.wsId, wsId);
    assert.ok(proj.ownerUserId, "project has no owning user after claim");
    assert.strictEqual(proj.expiresAt, null, "a claimed project must not have a TTL any more");
    pass("ownership moved from the anon cookie to the new account, in place");

    /* ---- the password is bcrypt-hashed at rest, never plaintext ---- */
    const userDoc = await seedClient.db("webo_" + wsId).collection("users").findOne({ email: "kahve@example.com" });
    assert.ok(userDoc, "no user record written to the workspace's own DB");
    assert.ok(String(userDoc.password).startsWith("$2"), "password was not bcrypt-hashed");
    assert.ok(bcrypt.compareSync("roastery1", userDoc.password), "stored hash does not match the password that was set");
    pass("the owner's password is bcrypt-hashed at rest");

    /* ---- the minted edit token actually opens the editor for this workspace ---- */
    res = await alice("/api/storefront/edit-token/verify?wsId=" + wsId, { headers: { "x-edit-token": editToken } });
    assert.strictEqual(res.status, 200, "the issued edit token did not verify: " + JSON.stringify(res.data));
    pass("the issued edit token verifies against the new workspace");

    /* ---- the minted session token actually authenticates afterwards, through
       the ordinary /auth/login path (proves the password really got set) ---- */
    res = await alice("/auth/login", { headers: { "x-workspace-id": wsId }, method: "POST", body: { email: "kahve@example.com", password: "roastery1" } });
    assert.strictEqual(res.status, 200, "could not log in with the password set during micro-claim: " + JSON.stringify(res.data));
    pass("the same email + password logs in normally afterwards");

    /* ---- THE regression this file exists to hold ----
       Claiming re-points ownership from the anon cookie to the user, and
       projects.owns() is asymmetric on purpose — so from the moment of claim
       the cookie ALONE is no longer an answer. The agent page must send the
       session token it was handed, or the owner's own project reads as gone
       and the conversation dies at the exact moment they became a customer.
       (docs/AGENT-GAP-AUDIT.md §1.1 + §1.2 — this shipped broken once.) */
    res = await alice("/api/projects/" + slug);
    assert.strictEqual(res.status, 403,
      "cookie-only read of a CLAIMED project should be refused — if this is 200 the asymmetry is gone");
    pass("after claim, the anon cookie alone no longer opens the project -> 403");

    const auth = { Authorization: "Bearer " + claimToken };

    res = await alice("/api/projects/" + slug, { headers: auth });
    assert.strictEqual(res.status, 200, "the owner could not reopen their own claimed project: " + JSON.stringify(res.data));
    assert.strictEqual(res.data.project.claimed, true);
    assert.ok(res.data.turns.length >= 2, "the transcript did not come back");
    assert.ok(res.data.config.pages.main, "the config did not come back");
    pass("with the session token the owner reopens it -> 200, transcript + config replay");

    res = await alice("/api/projects/" + slug + "/preview", { headers: auth });
    assert.strictEqual(res.status, 200, "the live preview 403s for the owner after claim");
    pass("the preview pane still resolves after claim (portal.js sends the token too)");

    res = await alice("/api/projects/" + slug + "/turns", { method: "POST", headers: auth, body: { message: "make it darker" } });
    assert.strictEqual(res.status, 200, "a follow-up on a CLAIMED project failed: " + JSON.stringify(res.data));
    pass("the conversation survives the claim — a follow-up still patches");

    res = await alice("/api/projects/" + slug, { headers: auth });
    assert.ok(res.data.revisions.length >= 2, "the post-claim follow-up did not create a revision");
    pass("that follow-up is on the record as a new revision (" + res.data.revisions.length + " total)");

    /* ---- an email already tied to a workspace can't mint a second one ---- */
    res = await bob("/api/projects", { method: "POST", body: { prompt: "a storefront for my Ankara bakery called Firin Co", industry: "restaurant" } });
    assert.strictEqual(res.status, 201, "bob's build failed: " + JSON.stringify(res.data));
    const bobSlug = res.data.slug;
    res = await bob("/api/projects/" + bobSlug + "/micro-claim", { method: "POST", body: { email: "kahve@example.com", password: "somethingElse1" } });
    assert.strictEqual(res.status, 409, "a second workspace was created for an email that already owns one");
    pass("micro-claim with an email that already owns a workspace -> 409");

    /* ---- a project already attached to a workspace can't be claimed twice —
       claiming re-points ownership from the anon cookie to the new user, so
       by the time this second call arrives alice's anon cookie no longer
       owns the project at all (owns() is asymmetric by design: a claimed
       project answers only to its user, never the anon cookie that made it).
       That surfaces as 403, the same "not your project" the id-based check
       above proves for a stranger's anon cookie — not a separate 409. ---- */
    res = await alice("/api/projects/" + slug + "/micro-claim", { method: "POST", body: { email: "another@example.com", password: "whatever1" } });
    assert.strictEqual(res.status, 403, "an already-claimed project was claimable again through the anon cookie that made it");
    pass("micro-claiming an already-claimed project through the (now stale) anon cookie -> 403");

    console.log("\n✓ ALL MICRO-CLAIM TESTS PASSED");
    ok = true;
  } catch (e) {
    console.error("\n✗ MICRO-CLAIM TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  } finally {
    try { await seedClient.close(); } catch (e) {}
    try { await mongod.stop(); } catch (e) {}
    process.exit(ok ? 0 : 1);
  }
})();
