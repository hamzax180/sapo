/* =================================================================
   Souqi — tenant-isolation integration test
   -----------------------------------------------------------------
   Proves the P0 fix end-to-end against a REAL (in-memory) MongoDB:

     1. A valid session for workspace A returns only A's data.
     2. Re-using A's token while forging the x-workspace-id header to
        point at workspace B still returns A's data — the header can
        NOT change tenants, because tenancy comes from the signed token.
     3. Unauthenticated CRUD is rejected (401).

   Requires mongodb-memory-server (devDependency). If the mongod binary
   cannot be provisioned (e.g. offline CI cache miss) the test SKIPS
   with a clear message rather than failing the suite.
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
    console.log("• isolation-test SKIPPED (mongodb-memory-server not available):", e.message);
    process.exit(0);
  }

  let mongod;
  try {
    mongod = await MongoMemoryServer.create();
  } catch (e) {
    console.log("• isolation-test SKIPPED (could not start in-memory mongod):", e.message);
    process.exit(0);
  }

  const uri = mongod.getUri();

  // Env must be set BEFORE requiring the server.
  process.env.MONGODB_URI = uri;
  process.env.DB_NAME = "souqi_master";
  process.env.JWT_SECRET = "isolation-test-secret";
  process.env.PORT = "4097";
  process.env.GEMINI_API_KEY = "";
  process.env.LOG_REQUESTS = "0"; // keep test output clean

  const base = "http://localhost:4097";
  const pass = (m) => console.log("  ✓ " + m);

  const seedClient = new MongoClient(uri);
  let ok = false;
  try {
    await seedClient.connect();

    // Master registry: two workspaces on the shared cluster; each gets its
    // own database (webo_<wsId>) because dbUri is empty / dbType local.
    await seedClient.db(process.env.DB_NAME).collection("workspaces").insertMany([
      { id: "ws_A", company: "Alpha Co", ownerEmail: "a@alpha.com", dbType: "local", dbUri: "" },
      { id: "ws_B", company: "Beta Co", ownerEmail: "b@beta.com", dbType: "local", dbUri: "" }
    ]);

    // Tenant A data
    await seedClient.db("webo_ws_A").collection("users").insertOne(
      { id: "usr_A_owner", name: "A Owner", email: "a@alpha.com", password: bcrypt.hashSync("passA", 10), role: "Owner", active: true });
    await seedClient.db("webo_ws_A").collection("clients").insertOne(
      { id: "cli_A1", name: "Alpha Secret Client" });
    await seedClient.db("webo_ws_A").collection("products").insertMany([
      { id: "prd_pub", name: "Public Widget", price: 20, cost: 9, warehouse: "Mersin", wsId: "ws_A", publishedToPortal: true },
      { id: "prd_hidden", name: "Unpublished", price: 5, cost: 2, publishedToPortal: false }
    ]);

    // Tenant B data
    await seedClient.db("webo_ws_B").collection("users").insertOne(
      { id: "usr_B_owner", name: "B Owner", email: "b@beta.com", password: bcrypt.hashSync("passB", 10), role: "Owner", active: true });
    await seedClient.db("webo_ws_B").collection("clients").insertOne(
      { id: "cli_B1", name: "Beta Secret Client" });

    // Boot the real server (connects to the same in-memory cluster).
    require("./index.js");

    // Wait for /health.
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
      const data = await r.json().catch(() => null);
      return { status: r.status, data };
    };

    console.log("\n--- RUNNING TENANT ISOLATION TESTS ---");

    // Unauthenticated CRUD rejected.
    let res = await req("/clients", { method: "GET" });
    assert.strictEqual(res.status, 401);
    pass("GET /clients without token -> 401");

    // Log in to A and B (workspace named via header only at login).
    res = await req("/auth/login", { method: "POST", headers: { "x-workspace-id": "ws_A" }, body: { email: "a@alpha.com", password: "passA" } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.user.wsId, "ws_A");
    const tokenA = res.data.token;
    pass("login ws_A -> token bound to ws_A");

    res = await req("/auth/login", { method: "POST", headers: { "x-workspace-id": "ws_B" }, body: { email: "b@beta.com", password: "passB" } });
    assert.strictEqual(res.status, 200);
    const tokenB = res.data.token;
    pass("login ws_B -> token bound to ws_B");

    // A sees only A's client.
    res = await req("/clients", { method: "GET", headers: { Authorization: "Bearer " + tokenA } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.length, 1);
    assert.strictEqual(res.data[0].name, "Alpha Secret Client");
    pass("token A sees only Alpha's client");

    // B sees only B's client.
    res = await req("/clients", { method: "GET", headers: { Authorization: "Bearer " + tokenB } });
    assert.strictEqual(res.data.length, 1);
    assert.strictEqual(res.data[0].name, "Beta Secret Client");
    pass("token B sees only Beta's client");

    // THE PROOF: A's token + forged x-workspace-id: ws_B header still returns A's data.
    res = await req("/clients", { method: "GET", headers: { Authorization: "Bearer " + tokenA, "x-workspace-id": "ws_B" } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.length, 1);
    assert.strictEqual(res.data[0].name, "Alpha Secret Client");
    pass("forged x-workspace-id header CANNOT cross tenants");

    console.log("\n--- RUNNING VALIDATION + IDEMPOTENCY TESTS ---");

    // Validation: an order without a customer is rejected.
    res = await req("/api/portal/ws_A/orders", { method: "POST", body: { items: [{ name: "X", price: 10, qty: 1 }] } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.error.code, "validation_error");
    pass("order missing customer -> 400 validation_error");

    // Idempotency: the same key creates exactly one order.
    const idemKey = "idem_isolation_" + Date.now();
    const orderBody = { customer: { name: "Sam", email: "sam@x.com" }, items: [{ name: "Widget", price: 9.5, qty: 2 }] };
    res = await req("/api/portal/ws_A/orders", { method: "POST", headers: { "Idempotency-Key": idemKey }, body: orderBody });
    assert.strictEqual(res.status, 201);
    assert.ok(/^ord_/.test(res.data.orderId), "order id is a prefixed ULID");
    const firstOrderId = res.data.orderId;

    res = await req("/api/portal/ws_A/orders", { method: "POST", headers: { "Idempotency-Key": idemKey }, body: orderBody });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.orderId, firstOrderId, "replay returns the same order id");

    const orderCount = await seedClient.db("webo_ws_A").collection("orders").countDocuments();
    assert.strictEqual(orderCount, 1, "exactly one order persisted despite two submits");
    pass("idempotency: duplicate submit -> single order");

    console.log("\n--- RUNNING PUBLIC PROJECTION TESTS ---");

    // Public product feed: allowlist projection + published-only.
    res = await req("/api/portal/ws_A/products", { method: "GET" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.length, 1, "only published products are public");
    const prod = res.data[0];
    assert.strictEqual(prod.name, "Public Widget");
    assert.strictEqual(prod.price, 20);
    assert.strictEqual(prod.cost, undefined, "cost is never exposed");
    assert.strictEqual(prod.warehouse, undefined, "internal fields dropped by allowlist");
    assert.strictEqual(prod.wsId, undefined, "tenancy metadata not leaked");
    pass("public products: allowlist projection, published-only");

    console.log("\n--- RUNNING AUDIT + GDPR TESTS ---");

    // Server-side audit: the guest order above should have written an audit row.
    const auditRows = await seedClient.db("webo_ws_A").collection("audit").find({ action: "order.create" }).toArray();
    assert.ok(auditRows.length >= 1, "server wrote an audit row for the order");
    assert.ok(auditRows[0].requestId && auditRows[0].hash, "audit row carries requestId + integrity hash");
    assert.strictEqual(auditRows[0].source, "server");
    pass("audit: server-side row for guest order");

    // GDPR export (owner-only).
    res = await req("/api/ws/ws_A/export", { method: "GET" });
    assert.strictEqual(res.status, 401);
    res = await req("/api/ws/ws_A/export", { method: "GET", headers: { Authorization: "Bearer " + tokenB } });
    assert.strictEqual(res.status, 403); // B doesn't own A
    res = await req("/api/ws/ws_A/export", { method: "GET", headers: { Authorization: "Bearer " + tokenA } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.collections.clients.length, 1);
    pass("gdpr: owner-only export returns tenant data");

    // GDPR erasure (owner-only) — B can't delete A; B deletes its own.
    res = await req("/api/ws/ws_A", { method: "DELETE", headers: { Authorization: "Bearer " + tokenB } });
    assert.strictEqual(res.status, 403);
    res = await req("/api/ws/ws_B", { method: "DELETE", headers: { Authorization: "Bearer " + tokenB } });
    assert.strictEqual(res.status, 200);
    const gone = await seedClient.db(process.env.DB_NAME).collection("workspaces").findOne({ id: "ws_B" });
    assert.strictEqual(gone, null, "master record removed");
    const bClients = await seedClient.db("webo_ws_B").collection("clients").countDocuments();
    assert.strictEqual(bClients, 0, "tenant data purged");
    const platAudit = await seedClient.db(process.env.DB_NAME).collection("platform_audit").findOne({ action: "workspace.delete", entityId: "ws_B" });
    assert.ok(platAudit, "erasure recorded to platform audit (survives)");
    pass("gdpr: owner-only erasure purges tenant + records platform audit");

    console.log("\n✓ ISOLATION + VALIDATION + IDEMPOTENCY + PROJECTION + AUDIT/GDPR PROVEN");
    ok = true;
  } catch (e) {
    console.error("  ✗ isolation test failed:", e && e.stack || e);
  } finally {
    try { await seedClient.close(); } catch (e) {}
    try { const db = require("./db"); await db.close(); } catch (e) {}
    try { await mongod.stop(); } catch (e) {}
    process.exit(ok ? 0 : 1);
  }
})();
