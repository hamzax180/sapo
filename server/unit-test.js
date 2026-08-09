/* =================================================================
   Souqi API Server - Mocked Unit Tests
   -----------------------------------------------------------------
   Tests all backend routes, CRUD operations, authentication guards,
   and clean URL frontend page serving using a mocked database adapter.
   Does not require a running MongoDB instance.
   ================================================================= */
const path = require("path");
const assert = require("assert");

// 1) Set test environment variables BEFORE loading the server
process.env.PORT = "4099";
process.env.JWT_SECRET = "test-secret-key-12345";
process.env.GEMINI_API_KEY = ""; // disabled for test
process.env.LOG_REQUESTS = "0"; // keep test output clean

// 2) Mock db connection before anything else
const db = require("./db");
db.connect = async () => {
  console.log("✓ Mocked MongoDB connected");
  return {};
};

// Load db-adapters and mock its methods to isolate database calls
const dbAdapters = require("./db-adapters");

// Passwords are stored bcrypt-hashed (plaintext is no longer accepted).
const bcrypt = require("bcryptjs");
const mockDatabase = {
  users: [
    { id: "U-001", name: "Mock Owner", email: "owner@test.com", password: bcrypt.hashSync("password123", 10), role: "Owner", active: true }
  ],
  clients: [
    { id: "C-001", name: "Client Alpha", country: "TR", status: "Active" },
    { id: "C-002", name: "Client Beta", country: "RU", status: "Active" }
  ],
  suppliers: [],
  products: [],
  quotes: [],
  orders: [],
  shipments: [],
  invoices: [],
  purchaseorders: [],
  bills: [],
  payments: [],
  notifications: [],
  audit: []
};

dbAdapters.testConnection = async (type, uri) => {
  if (uri.includes("fail")) throw new Error("Connection failed");
  return true;
};

dbAdapters.seedWorkspaceDatabase = async (ctx) => {
  return true;
};

// Mock all adapter methods
dbAdapters.dbAdapter.findAll = async (ws, collection) => {
  return mockDatabase[collection] || [];
};

dbAdapters.dbAdapter.findOne = async (ws, collection, id) => {
  const items = mockDatabase[collection] || [];
  return items.find(x => x.id === id) || null;
};

dbAdapters.dbAdapter.insertOne = async (ws, collection, doc) => {
  if (!mockDatabase[collection]) mockDatabase[collection] = [];
  mockDatabase[collection].push(doc);
  return doc;
};

dbAdapters.dbAdapter.updateOne = async (ws, collection, id, patch) => {
  const items = mockDatabase[collection] || [];
  const item = items.find(x => x.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  return item;
};

dbAdapters.dbAdapter.deleteOne = async (ws, collection, id) => {
  if (!mockDatabase[collection]) return false;
  const initialLen = mockDatabase[collection].length;
  mockDatabase[collection] = mockDatabase[collection].filter(x => x.id !== id);
  return mockDatabase[collection].length < initialLen;
};

// Helper logger
const pass = (msg) => console.log("  ✓ " + msg);
const fail = (msg, err) => {
  console.error("  ✗ " + msg);
  if (err) console.error(err);
  if (serverInstance) {
    serverInstance.close(() => process.exit(1));
  } else {
    process.exit(1);
  }
};

// 3) Capture the express server instance to close it cleanly later
const express = require("express");
const originalListen = express.application.listen;
let serverInstance = null;
express.application.listen = function(...args) {
  serverInstance = originalListen.apply(this, args);
  return serverInstance;
};

console.log("Starting Souqi test server...");
require("./index.js");

const base = "http://localhost:4099";

// Helper to make requests
async function request(path, options = {}) {
  const url = base + path;
  if (options.body && typeof options.body === "object") {
    options.body = JSON.stringify(options.body);
  }
  if (!options.headers) options.headers = {};
  options.headers["Connection"] = "close";
  if (!options.headers["Content-Type"]) {
    options.headers["Content-Type"] = "application/json";
  }
  
  const res = await fetch(url, options);
  const status = res.status;
  const isHtml = res.headers.get("content-type")?.includes("text/html");
  const data = isHtml ? await res.text() : await res.json().catch(() => null);
  return {
    status, data,
    xRequestId: res.headers.get("x-request-id"),
    nosniff: res.headers.get("x-content-type-options"),
    csp: res.headers.get("content-security-policy")
  };
}

// 4) Execute Test Cases
(async () => {
  // Wait a moment for server initialization
  await new Promise(r => setTimeout(r, 1000));
  console.log("\n--- RUNNING API UNIT TESTS ---");

  try {
    // Unit: ID system (pure logic, no server)
    const ids = require("./lib/ids");
    const idA = ids.newId("ord"), idB = ids.newId("ord");
    assert.ok(/^ord_[0-9A-HJKMNP-TV-Z]{26}$/.test(idA), "prefixed ULID shape");
    assert.notStrictEqual(idA, idB);
    assert.ok(idA < idB, "ULIDs are lexicographically sortable/monotonic");
    assert.ok(ids.isValidId(idA, "ord") && !ids.isValidId("O-123", "ord"));
    pass("ids: unique, prefixed, sortable, validated");

    // Unit: RBAC matrix
    const rbac = require("./lib/rbac");
    assert.ok(rbac.can("Owner", "invoices", "create"));
    assert.ok(!rbac.can("Trade Specialist", "invoices", "create"));
    assert.ok(rbac.can("Trade Specialist", "orders", "create"));
    assert.ok(!rbac.can("Finance Officer", "shipments", "read"));
    assert.ok(rbac.can("Owner", "audit", "read") && !rbac.can("Operations Manager", "audit", "read"));
    assert.ok(!rbac.can("Owner", "audit", "update"));
    pass("rbac: role matrix enforced");

    // Unit: secret encryption round-trip (AES-256-GCM)
    process.env.DB_ENCRYPTION_KEY = "0".repeat(64); // 32 bytes hex
    const { encryptSecret, decryptSecret } = require("./lib/crypto");
    const ct = encryptSecret("mongodb://user:pass@host/db");
    assert.ok(ct.startsWith("enc:v1:"), "dbUri encrypted at rest");
    assert.strictEqual(decryptSecret(ct), "mongodb://user:pass@host/db");
    assert.strictEqual(decryptSecret("legacy-plaintext"), "legacy-plaintext");
    delete process.env.DB_ENCRYPTION_KEY; // no side effects on the rest of the suite
    pass("crypto: dbUri encrypt/decrypt round-trip");

    // Test 1: Health Check
    let res = await request("/health", { method: "GET" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.ok(/^req_/.test(res.xRequestId || ""), "X-Request-Id header present");
    assert.strictEqual(res.nosniff, "nosniff");
    assert.ok(res.csp && res.csp.includes("object-src 'none'"), "CSP header present");
    pass("GET /health -> 200 OK + X-Request-Id + security headers");

    // Metrics endpoint: disabled without token, gated by METRICS_TOKEN.
    res = await request("/metrics", { method: "GET" });
    assert.strictEqual(res.status, 404);
    process.env.METRICS_TOKEN = "mtok";
    res = await request("/metrics", { method: "GET" });
    assert.strictEqual(res.status, 401);
    res = await request("/metrics", { method: "GET", headers: { Authorization: "Bearer mtok" } });
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data.requests === "number" && "byStatus" in res.data);
    delete process.env.METRICS_TOKEN;
    pass("GET /metrics -> gated by METRICS_TOKEN, returns snapshot");

    // Test 3: Auth Login Correct Credentials
    res = await request("/auth/login", {
      method: "POST",
      body: { email: "owner@test.com", password: "password123" } // verified against bcrypt hash
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.token);
    assert.strictEqual(res.data.user.role, "Owner");
    assert.ok(res.data.user.wsId, "session carries a workspace id");
    pass("POST /auth/login (Correct) -> 200 OK with Token");
    const token = res.data.token;
    const auth = { Authorization: "Bearer " + token };

    // Test 2: Database Connection Test endpoint (auth required)
    res = await request("/api/db/test", {
      method: "POST",
      headers: auth,
      body: { dbType: "postgres", dbUri: "postgres://localhost" }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    pass("POST /api/db/test (Valid) -> 200 OK");

    res = await request("/api/db/test", {
      method: "POST",
      headers: auth,
      body: { dbType: "postgres", dbUri: "postgres://fail-connection" }
    });
    assert.strictEqual(res.status, 400);
    pass("POST /api/db/test (Invalid) -> 400 Error");

    // Test 4: Auth Login Wrong Credentials
    res = await request("/auth/login", {
      method: "POST",
      body: { email: "owner@test.com", password: "wrong-password" }
    });
    assert.strictEqual(res.status, 401);
    pass("POST /auth/login (Wrong) -> 401 Unauthorized");

    // Test 4b: login body validation (invalid email shape)
    res = await request("/auth/login", { method: "POST", body: { email: "not-an-email", password: "x" } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.error.code, "validation_error");
    pass("POST /auth/login (bad email) -> 400 validation_error");

    // Test 5: CRUD now requires a valid session
    res = await request("/clients", { method: "GET" });
    assert.strictEqual(res.status, 401);
    pass("GET /clients (no token) -> 401 Unauthorized");

    res = await request("/clients", { method: "GET", headers: { ...auth } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.length, 2);
    assert.strictEqual(res.data[0].name, "Client Alpha");
    pass("GET /clients (token) -> 200 OK with list");

    // Test 6: CRUD - Find One
    res = await request("/clients/C-001", { method: "GET", headers: { ...auth } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.name, "Client Alpha");
    pass("GET /clients/:id (token) -> 200 OK with single doc");

    // Test 7: CRUD - Create (server mints a unique id; client id ignored)
    res = await request("/clients", {
      method: "POST",
      headers: { ...auth },
      body: { id: "C-003", name: "Client Gamma", country: "US", status: "Active" }
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.name, "Client Gamma");
    assert.ok(/^cli_[0-9A-HJKMNP-TV-Z]{26}$/.test(res.data.id), "server-minted ULID id");
    assert.notStrictEqual(res.data.id, "C-003");
    assert.ok(String(res.data.requestId || "").startsWith("req_"), "record linked to request id");
    const createdId = res.data.id;
    pass("POST /clients -> 201 Created with server ULID id + requestId");

    // Test 8: CRUD - Update (by the server-minted id)
    res = await request("/clients/" + createdId, {
      method: "PUT",
      headers: { ...auth },
      body: { status: "Inactive" }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, "Inactive");
    pass("PUT /clients/:id (token) -> 200 OK with updated doc");

    // Test 9: CRUD - Delete
    res = await request("/clients/" + createdId, { method: "DELETE", headers: { ...auth } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    pass("DELETE /clients/:id (token) -> 200 OK");

    // Test 10: CRUD - Invalid Collection Blocked (before auth, so still 404)
    res = await request("/secrets", { method: "GET", headers: { ...auth } });
    assert.strictEqual(res.status, 404);
    pass("GET /secrets (Guard blocked) -> 404 Not Found");

    // Test 11: Clean URL Frontend Routes
    const pages = ["/login", "/pricing", "/checkout"];
    for (const page of pages) {
      res = await request(page, { method: "GET" });
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.includes("<!DOCTYPE html>"));
      pass(`GET ${page} (Clean URL) -> 200 OK serves HTML`);
    }

    // Test 12: Public Prefix Frontend Routes
    const publicPages = ["/public/login"];
    for (const page of publicPages) {
      res = await request(page, { method: "GET" });
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.includes("<!DOCTYPE html>"));
      pass(`GET ${page} (Public Prefix) -> 200 OK serves HTML`);
    }

    console.log("\n✓ ALL UNIT TESTS PASSED SUCCESSFULLY!");
    if (serverInstance) {
      serverInstance.close(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }

  } catch (err) {
    fail("Test failed assertion", err);
  }
})();
