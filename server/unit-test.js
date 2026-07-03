/* =================================================================
   WeboCloud API Server - Mocked Unit Tests
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

// 2) Mock db connection before anything else
const db = require("./db");
db.connect = async () => {
  console.log("✓ Mocked MongoDB connected");
  return {};
};

// Load db-adapters and mock its methods to isolate database calls
const dbAdapters = require("./db-adapters");

const mockDatabase = {
  users: [
    { id: "U-001", name: "Mock Owner", email: "owner@test.com", password: "password123", role: "Owner", active: true }
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

console.log("Starting WeboCloud test server...");
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
  return { status, data };
}

// 4) Execute Test Cases
(async () => {
  // Wait a moment for server initialization
  await new Promise(r => setTimeout(r, 1000));
  console.log("\n--- RUNNING API UNIT TESTS ---");

  try {
    // Test 1: Health Check
    let res = await request("/health", { method: "GET" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    pass("GET /health -> 200 OK");

    // Test 2: Database Connection Test endpoint
    res = await request("/api/db/test", {
      method: "POST",
      body: { dbType: "postgres", dbUri: "postgres://localhost" }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    pass("POST /api/db/test (Valid) -> 200 OK");

    res = await request("/api/db/test", {
      method: "POST",
      body: { dbType: "postgres", dbUri: "postgres://fail-connection" }
    });
    assert.strictEqual(res.status, 400);
    pass("POST /api/db/test (Invalid) -> 400 Error");

    // Test 3: Auth Login Correct Credentials
    res = await request("/auth/login", {
      method: "POST",
      body: { email: "owner@test.com", password: "password123" } // plaintext fallback
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.token);
    assert.strictEqual(res.data.user.role, "Owner");
    pass("POST /auth/login (Correct) -> 200 OK with Token");

    // Test 4: Auth Login Wrong Credentials
    res = await request("/auth/login", {
      method: "POST",
      body: { email: "owner@test.com", password: "wrong-password" }
    });
    assert.strictEqual(res.status, 401);
    pass("POST /auth/login (Wrong) -> 401 Unauthorized");

    // Test 5: CRUD - List
    res = await request("/clients", { method: "GET" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.length, 2);
    assert.strictEqual(res.data[0].name, "Client Alpha");
    pass("GET /clients -> 200 OK with list");

    // Test 6: CRUD - Find One
    res = await request("/clients/C-001", { method: "GET" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.name, "Client Alpha");
    pass("GET /clients/:id -> 200 OK with single doc");

    // Test 7: CRUD - Create
    res = await request("/clients", {
      method: "POST",
      body: { id: "C-003", name: "Client Gamma", country: "US", status: "Active" }
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.name, "Client Gamma");
    pass("POST /clients -> 201 Created");

    // Test 8: CRUD - Update
    res = await request("/clients/C-003", {
      method: "PUT",
      body: { status: "Inactive" }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, "Inactive");
    pass("PUT /clients/:id -> 200 OK with updated doc");

    // Test 9: CRUD - Delete
    res = await request("/clients/C-003", { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    pass("DELETE /clients/:id -> 200 OK");

    // Test 10: CRUD - Invalid Collection Blocked
    res = await request("/secrets", { method: "GET" });
    assert.strictEqual(res.status, 404);
    pass("GET /secrets (Guard blocked) -> 404 Not Found");

    // Test 11: Clean URL Frontend Routes
    const pages = ["/login", "/signup", "/pricing", "/checkout", "/index"];
    for (const page of pages) {
      res = await request(page, { method: "GET" });
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.includes("<!DOCTYPE html>"));
      pass(`GET ${page} (Clean URL) -> 200 OK serves HTML`);
    }

    // Test 12: Public Prefix Frontend Routes
    const publicPages = ["/public/login", "/public/signup", "/public/index"];
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
