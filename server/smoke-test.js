/* End-to-end smoke test: real Express app + real Mongo (in-memory).
   Proves seed → login → CRUD → AI-guard all work. Not part of the app. */
const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawnSync, spawn } = require("child_process");
const path = require("path");

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  const env = Object.assign({}, process.env, { MONGODB_URI: uri, DB_NAME: "merveks_sap_test", PORT: "4099", JWT_SECRET: "test-secret", GEMINI_API_KEY: "" });

  // 1) seed
  const seed = spawnSync("node", ["seed.js", "--force"], { cwd: __dirname, env, encoding: "utf8" });
  process.stdout.write(seed.stdout || "");
  if (seed.status !== 0) { console.error("SEED FAILED", seed.stderr); process.exit(1); }

  // 2) boot the real server
  const srv = spawn("node", ["index.js"], { cwd: __dirname, env });
  let booted = false;
  srv.stdout.on("data", (d) => { if (/listening/.test(d)) booted = true; });
  srv.stderr.on("data", (d) => process.stderr.write(d));
  const base = "http://localhost:4099";
  for (let i = 0; i < 40 && !booted; i++) await new Promise((r) => setTimeout(r, 150));

  const pass = (m) => console.log("  ✓ " + m);
  const fail = (m) => { console.error("  ✗ " + m); srv.kill(); mongod.stop(); process.exit(1); };

  try {
    let r = await fetch(base + "/health"); const h = await r.json();
    h.ok ? pass("GET /health → ok") : fail("health");

    r = await fetch(base + "/clients"); const clients = await r.json();
    Array.isArray(clients) && clients.length === 8 ? pass("GET /clients → " + clients.length + " records (no _id leak: " + !("_id" in clients[0]) + ")") : fail("clients list");

    // wrong password rejected
    r = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@merveks.com", password: "wrong" }) });
    r.status === 401 ? pass("POST /auth/login wrong password → 401") : fail("login should reject");

    // correct password against the HASHED stored value
    r = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@merveks.com", password: "merveks2013" }) });
    const login = await r.json();
    login.token && login.user.role === "Owner" ? pass("POST /auth/login correct → token + Owner profile (bcrypt verified)") : fail("login should succeed");

    // create → read back → update → delete
    r = await fetch(base + "/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "C-TEST", name: "Smoke Test Co", country: "TR", status: "Active" }) });
    const created = await r.json();
    created.id === "C-TEST" ? pass("POST /clients → created C-TEST") : fail("create");

    r = await fetch(base + "/clients/C-TEST"); const got = await r.json();
    got.name === "Smoke Test Co" ? pass("GET /clients/C-TEST → persisted") : fail("read-back");

    r = await fetch(base + "/clients/C-TEST", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "On hold" }) });
    const upd = await r.json();
    upd.status === "On hold" ? pass("PUT /clients/C-TEST → updated") : fail("update");

    r = await fetch(base + "/clients/C-TEST", { method: "DELETE" }); const del = await r.json();
    del.ok ? pass("DELETE /clients/C-TEST → ok") : fail("delete");

    // new user's password gets hashed on insert
    r = await fetch(base + "/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "U-TEST", name: "T", email: "t@x.com", role: "Trade Specialist", active: true, password: "plain123" }) });
    const nu = await r.json();
    nu.password && nu.password.startsWith("$2") ? pass("POST /users → password auto-hashed in DB") : fail("password not hashed");

    // AI proxy correctly reports it's not configured (no key in test env)
    r = await fetch(base + "/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "hi" }) });
    r.status === 503 ? pass("POST /ai/chat (no key) → 503 (offline fallback will engage)") : fail("ai guard");

    // unknown collection rejected
    r = await fetch(base + "/secrets"); r.status === 404 ? pass("GET /secrets → 404 (collection allowlist works)") : fail("allowlist");

    // Test new frontend routes and clean URLs
    const routesToTest = ["/login", "/signup", "/pricing", "/checkout", "/index", "/public/login", "/public/signup", "/public/index"];
    for (const route of routesToTest) {
      r = await fetch(base + route);
      if (r.status !== 200) fail(`GET ${route} -> status ${r.status} (expected 200)`);
      const html = await r.text();
      if (!html.includes("<!DOCTYPE html>")) fail(`GET ${route} did not return HTML`);
      pass(`GET ${route} -> 200 OK (served static HTML correctly)`);
    }

    console.log("\nALL TESTS PASSED ✓");
  } catch (e) { console.error("ERROR", e); srv.kill(); await mongod.stop(); process.exit(1); }
  srv.kill(); await mongod.stop(); process.exit(0);
})();
