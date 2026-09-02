/* End-to-end smoke test: real Express app + real Mongo.
   - In CI: uses the MongoDB service container provided via MONGODB_URI env var
   - Locally: spins up MongoMemoryServer automatically (no external dep needed)
   Proves seed → login → CRUD → AI-guard → clean URLs all work. */

const { spawnSync, spawn } = require("child_process");

(async () => {
  // ── Choose MongoDB source ────────────────────────────────────────────
  // CI provides MONGODB_URI via a service container (fast, no download).
  // Locally, we fall back to MongoMemoryServer.
  let mongod = null;
  let uri = process.env.MONGODB_URI || "";

  if (!uri) {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    uri = mongod.getUri();
  } else {
    console.log("Using external MongoDB:", uri);
  }

  const env = Object.assign({}, process.env, {
    MONGODB_URI: uri,
    DB_NAME: "merveks_sap_test",
    PORT: "4099",
    JWT_SECRET: "test-secret",
    GEMINI_API_KEY: "",
  });

  const cleanup = async (code = 0) => {
    srv && srv.kill();
    if (mongod) await mongod.stop();
    process.exit(code);
  };

  // 1) seed
  const seed = spawnSync("node", ["seed.js", "--force"], { cwd: __dirname, env, encoding: "utf8" });
  process.stdout.write(seed.stdout || "");
  if (seed.status !== 0) { console.error("SEED FAILED", seed.stderr); await cleanup(1); }

  // 2) boot the real server
  const srv = spawn("node", ["index.js"], { cwd: __dirname, env });
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

    // Password auto-hashed on user insert
    r = await fetch(base + "/users", { method: "POST", headers: authHeaders, body: JSON.stringify({ id: "U-TEST", name: "T", email: "t@x.com", role: "Trade Specialist", active: true, password: "plain123" }) });
    nu = await r.json();
    nu.password && nu.password.startsWith("$2") ? pass("POST /users → password auto-hashed") : await fail("password not hashed");

    // AI guard (no key → 503)
    r = await fetch(base + "/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "hi" }) });
    r.status === 503 ? pass("POST /ai/chat (no key) → 503") : await fail("AI guard failed");

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

    console.log("\nALL SMOKE TESTS PASSED ✓");
    await cleanup(0);
  } catch (e) {
    console.error("UNEXPECTED ERROR", e);
    await cleanup(1);
  }
})();
