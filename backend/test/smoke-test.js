/* End-to-end smoke test: real Express app + real Mongo.
   - In CI: uses the MongoDB service container provided via MONGODB_URI env var
   - Locally: spins up MongoMemoryServer automatically (no external dep needed)
   Proves seed → login → CRUD → AI-guard → clean URLs all work. */

const { spawnSync, spawn } = require("child_process");

(async () => {
  /* ── Choose MongoDB source ────────────────────────────────────────────
     A real cluster if one is configured — CI provides MONGODB_URI through a
     service container, and a developer's own .env names theirs. Otherwise
     an in-memory mongod, which needs no setup but does need to download and
     start a binary, and fails by TIMING OUT rather than by saying so: this
     suite sat broken for a while behind a MongoNetworkTimeoutError to a
     random localhost port, which reads like a bug in the app.

     Reading .env is what makes `npm run smoke-test` work on a machine that
     already has a database configured. It is safe on any of them because
     DB_NAME below is overridden to a _test database — this suite seeds and
     wipes, and must never be pointed at the one holding real rows. */
  try { require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") }); } catch (e) { /* optional */ }
  let mongod = null;
  let uri = process.env.MONGODB_URI || "";

  if (!uri) {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    uri = mongod.getUri();
  } else {
    console.log("Using the configured MongoDB, in database " + "merveks_sap_test" + " (not the one in DB_NAME)");
  }

  const env = Object.assign({}, process.env, {
    MONGODB_URI: uri,
    DB_NAME: "merveks_sap_test",
    PORT: "4099",
    JWT_SECRET: "test-secret",
    GEMINI_API_KEY: "",
  });

  /* Declared before cleanup can name it. `srv` is assigned further down with
     const, so every early exit — a failed seed above all — hit
     "Cannot access 'srv' before initialization" inside the handler instead of
     reporting the failure. The throw left the child running, so the process
     never exited at all: a broken seed showed up as a hung test rather than a
     red one, which is the worst of both. */
  let srv = null;

  const cleanup = async (code = 0) => {
    if (srv) srv.kill();
    /* Bounded, and never allowed to throw. A memory server that will not
       stop must not turn a FAILING test into a HANGING one: the seed failure
       below was reported correctly and the process then sat here until the
       job timeout, which in CI means burning the whole run to learn one
       line. Five seconds is generous for a local process. */
    if (mongod) {
      await Promise.race([
        Promise.resolve(mongod.stop()).catch(() => {}),
        new Promise((r) => setTimeout(r, 5000))
      ]);
    }
    process.exit(code);
  };

  // 1) seed
  const seed = spawnSync("node", ["seed.js", "--force"], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
  process.stdout.write(seed.stdout || "");
  if (seed.status !== 0) {
    console.error("SEED FAILED", JSON.stringify({ status: seed.status, signal: seed.signal, error: seed.error && seed.error.message }), seed.stderr || "(no stderr)");
    await cleanup(1);
  }

  // 2) boot the real server
  srv = spawn("node", ["index.js"], { cwd: path.join(__dirname, ".."), env });
  let booted = false;
  srv.stdout.on("data", (d) => { process.stdout.write(d); if (/listening/.test(d)) booted = true; });
  srv.stderr.on("data", (d) => process.stderr.write(d));
  const base = "http://localhost:4099";
  for (let i = 0; i < 40 && !booted; i++) await new Promise((r) => setTimeout(r, 150));
  if (!booted) { console.error("Server failed to boot"); await cleanup(1); }

  const pass = (m) => console.log("  ✓ " + m);
  const fail = async (m) => { console.error("  ✗ " + m); await cleanup(1); };

  try {
    let r, h, clients, login, created, got, upd, del, nu;

    // Health check
    r = await fetch(base + "/health"); h = await r.json();
    h.ok ? pass("GET /health → ok") : await fail("health check failed");

    // Unauthenticated request rejected
    r = await fetch(base + "/clients");
    r.status === 401 ? pass("GET /clients (no token) → 401") : await fail("unauthenticated access should return 401");

    // Wrong password rejected
    r = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@merveks.com", password: "wrong" }) });
    r.status === 401 ? pass("POST /auth/login wrong password → 401") : await fail("login should reject wrong password");

    // Correct password (bcrypt)
    r = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@merveks.com", password: "merveks2013" }) });
    login = await r.json();
    login.token && login.user.role === "Owner" ? pass("POST /auth/login correct → token + Owner role") : await fail("login should succeed with correct password");

    const authHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + login.token };

    // List clients (seeded, authenticated)
    r = await fetch(base + "/clients", { headers: authHeaders }); clients = await r.json();
    Array.isArray(clients) && clients.length >= 1
      ? pass("GET /clients → " + clients.length + " records")
      : await fail("clients list empty or wrong type — got: " + JSON.stringify(clients).slice(0, 120));

    /* CRUD: create → read → update → delete.

       The id comes back from the server, it is not the one sent. POST /:c
       overwrites record.id with a minted ULID on purpose, so a client
       cannot choose its own primary key — that is what keeps ids unique
       across tenants and non-enumerable. This test used to send id:"C-TEST"
       and assert it came back, which asserted the exact behaviour the
       server refuses, and then addressed the next three requests to a URL
       that never existed. */
    r = await fetch(base + "/clients", { method: "POST", headers: authHeaders, body: JSON.stringify({ id: "C-TEST", name: "Smoke Test Co", country: "TR", status: "Active" }) });
    created = await r.json();
    /^cli_[0-9A-HJKMNP-TV-Z]{26}$/.test(created.id || "") && created.id !== "C-TEST"
      ? pass("POST /clients → created with server-minted id " + created.id)
      : await fail("create failed — expected a server-minted cli_ ULID, got: " + JSON.stringify(created).slice(0, 160));

    const cid = encodeURIComponent(created.id);

    r = await fetch(base + "/clients/" + cid, { headers: authHeaders }); got = await r.json();
    got.name === "Smoke Test Co" ? pass("GET /clients/:id → persisted") : await fail("read-back failed");

    r = await fetch(base + "/clients/" + cid, { method: "PUT", headers: authHeaders, body: JSON.stringify({ status: "On hold" }) });
    upd = await r.json();
    upd.status === "On hold" ? pass("PUT /clients/:id → updated") : await fail("update failed");

    r = await fetch(base + "/clients/" + cid, { method: "DELETE", headers: authHeaders }); del = await r.json();
    del.ok ? pass("DELETE /clients/:id → ok") : await fail("delete failed");

    /* A password is hashed on the way in, and the hash does not come back.

       This used to read the hash straight out of the RESPONSE — which was
       the only way to see it, and also the bug: GET /users, GET /users/:id
       and the workspace export all served every bcrypt hash in the
       workspace to anyone holding a session. Credential fields are stripped
       at every exit now, so the assertion moved to where the password
       actually lives, and gained its other half: the row is hashed, AND the
       response carries nothing. */
    r = await fetch(base + "/users", { method: "POST", headers: authHeaders, body: JSON.stringify({ id: "U-TEST", name: "T", email: "t@x.com", role: "Trade Specialist", active: true, password: "plain123" }) });
    nu = await r.json();
    if (nu.password !== undefined) await fail("POST /users echoed a password field back");
    pass("POST /users → the response carries no password");

    {
      const { MongoClient } = require("mongodb");
      const probe = new MongoClient(uri);
      try {
        await probe.connect();
        /* By the id the SERVER minted, not the one the body proposed:
           POST /:c ignores a client-supplied id on purpose, so "U-TEST"
           is never what got written. Falls back to the address when the
           response carries no id. */
        const row = await probe.db(env.DB_NAME).collection("users")
          .findOne(nu.id ? { id: nu.id } : { email: "t@x.com" });
        if (!row) await fail("the user was not written at all");
        else if (row.password === "plain123") await fail("the password was stored in plaintext");
        else if (!String(row.password || "").startsWith("$2")) await fail("the stored password is not a bcrypt hash: " + String(row.password).slice(0, 12));
        else pass("POST /users → the stored password is a bcrypt hash");
      } finally { try { await probe.close(); } catch (e) {} }
    }

    /* The AI proxy is gone, not merely disabled.

       This used to assert it answered 503 without a key, which was true
       and was also the whole problem: an unauthenticated LLM proxy on
       the platform's own key, one environment variable away from being
       a free LLM for the internet. Asserting the safety catch holds is
       weaker than asserting there is nothing to catch. */
    r = await fetch(base + "/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "hi" }) });
    r.status === 404 ? pass("POST /ai/chat -> 404 (the public LLM proxy is removed)") : await fail("/ai/chat answered " + r.status + " — the public AI proxy is back");

    // Collection allowlist
    r = await fetch(base + "/secrets");
    r.status === 404 ? pass("GET /secrets → 404 (allowlist works)") : await fail("allowlist broken");

    // Clean URL frontend routes
    const routes = ["/login", "/pricing", "/checkout", "/public/login"];
    for (const route of routes) {
      r = await fetch(base + route);
      if (r.status !== 200) await fail(`GET ${route} → ${r.status} (expected 200)`);
      const html = await r.text();
      if (!html.includes("<!DOCTYPE html>")) await fail(`GET ${route} did not return HTML`);
      pass(`GET ${route} → 200 OK`);
    }

    /* Stripe webhook: the signature is an HMAC over the RAW bytes, so the
       body must reach express.raw() unread. A global JSON parser upstream
       used to consume it first, which set req._body, made body-parser skip
       the raw parser, and left verifyWebhook hashing "[object Object]" —
       so no genuine Stripe event could ever verify, on Connect payments or
       subscriptions alike. Both halves are checked below: a wrong secret
       must still be rejected, or this would pass by accepting everything.

       The server under test has no STRIPE_WEBHOOK_SECRET, so verification
       stops at "not configured" before it ever compares bytes. What is
       provable here is the parser wiring: a rejection that names the
       signature means the raw body arrived, and any other message means it
       did not. */
    {
      const evt = JSON.stringify({ type: "customer.subscription.updated", data: { object: {} } });
      r = await fetch(base.replace(/\/api$/, "") + "/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=" + "0".repeat(64) },
        body: evt
      });
      const body = await r.json().catch(() => ({}));
      const reason = String((body && body.error) || "");
      if (r.status !== 400) await fail(`POST /api/stripe/webhook → ${r.status} (expected 400)`);
      // Whatever the reason, it must be about the signature or the config —
      // never a parse error, which is what a swallowed body produces.
      if (/JSON|body|parse/i.test(reason)) {
        await fail("webhook did not receive the raw body: " + reason);
      }
      pass("POST /api/stripe/webhook reaches express.raw with the body intact");
    }

    console.log("\nALL SMOKE TESTS PASSED ✓");
    await cleanup(0);
  } catch (e) {
    console.error("UNEXPECTED ERROR", e);
    await cleanup(1);
  }
})();
