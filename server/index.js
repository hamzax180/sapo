/* =================================================================
   WeboCloud — REST + auth + AI proxy backend (Multi-Database Support)
   -----------------------------------------------------------------
   Implements exactly the contract the front-end Store expects,
   but dynamically routes all CRUD operations to either MongoDB
   or PostgreSQL depending on headers:
     x-workspace-id
     x-workspace-db-type (mongodb / postgres / neon)
     x-workspace-db-uri
   ================================================================= */
require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { connect } = require("./db"); // default master MongoDB connection
const { testConnection, seedWorkspaceDatabase, dbAdapter } = require("./db-adapters");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Serve specific frontend pages with and without .html / prefix
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "signup.html")));
app.get("/pricing", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "pricing.html")));
app.get("/checkout", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "checkout.html")));
app.get("/index", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.get("/public/login", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/public/signup", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "signup.html")));
app.get("/public/index", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

const origins = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));

// Only these collections may be read/written through the generic CRUD API.
const COLLECTIONS = ["users", "clients", "suppliers", "products", "quotes", "orders", "shipments", "invoices", "purchaseorders", "bills", "payments", "notifications", "audit"];

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret";
const GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

/**
 * Extracts database context from request headers or environment variables
 */
function getWorkspaceContext(req) {
  const workspaceId = req.headers["x-workspace-id"] || "default";
  const dbType = req.headers["x-workspace-db-type"] || "mongodb";
  const dbUri = req.headers["x-workspace-db-uri"] || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
  return { workspaceId, dbType, dbUri };
}

/* ---- health probe (Store hits this to decide LIVE vs DEMO) ---- */
app.get("/health", (req, res) => res.json({ ok: true, service: "webocloud-api", time: new Date().toISOString() }));

/* ---- dynamic db connection testing ---- */
app.post("/api/db/test", async (req, res) => {
  try {
    const { dbType, dbUri } = req.body || {};
    if (!dbType || !dbUri) return res.status(400).json({ error: "dbType and dbUri are required" });
    await testConnection(dbType, dbUri);
    res.json({ ok: true, message: "Connected successfully!" });
  } catch (e) {
    console.error("Test connection failed:", e.message);
    res.status(400).json({ error: e.message });
  }
});

/* ---- dynamic db seeding/provisioning ---- */
app.post("/api/db/seed", async (req, res) => {
  try {
    const { workspaceId, dbType, dbUri } = req.body || {};
    if (!workspaceId || !dbType || !dbUri) return res.status(400).json({ error: "workspaceId, dbType, and dbUri are required" });
    await seedWorkspaceDatabase({ workspaceId, dbType, dbUri });
    res.json({ ok: true, message: "Database schemas and starter templates successfully provisioned!" });
  } catch (e) {
    console.error("Seeding workspace failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---- auth: verify a hashed password, return a token + safe profile ---- */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email and password required" });
    
    const ws = getWorkspaceContext(req);
    // Find user across DB-agnostic adapter
    const users = await dbAdapter.findAll(ws, "users");
    const u = users.find(usr => String(usr.email).toLowerCase() === String(email).toLowerCase());
    
    if (!u || !u.active) return res.status(401).json({ error: "invalid credentials" });

    // Support both hashed (production) and plaintext passwords.
    const hashed = typeof u.password === "string" && u.password.startsWith("$2");
    const ok = hashed ? await bcrypt.compare(password, u.password) : u.password === password;
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    const session = { id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: session });
  } catch (e) {
    console.error("login error:", e.message);
    res.status(500).json({ error: "login failed" });
  }
});

/* ---- AI proxy: keep the Gemini key on the server ---- */
app.post("/ai/chat", async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: "no-key", message: "AI proxy not configured" });
  try {
    const { prompt, contents, generationConfig } = req.body || {};
    const body = {
      contents: contents || [{ parts: [{ text: String(prompt || "") }] }],
      generationConfig: generationConfig || { temperature: 0.5, maxOutputTokens: 900 }
    };
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + encodeURIComponent(GEMINI_KEY);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      let msg = "Gemini error " + r.status;
      try { const e = await r.json(); if (e.error && e.error.message) msg = e.error.message; } catch (x) {}
      return res.status(502).json({ error: msg });
    }
    const j = await r.json();
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts &&
      j.candidates[0].content.parts.map((p) => p.text).join("");
    if (!text) return res.status(502).json({ error: "Empty response from Gemini" });
    res.json({ text });
  } catch (e) {
    console.error("ai proxy error:", e.message);
    res.status(500).json({ error: "ai proxy failed" });
  }
});

/* ---- guard: only allow known collections through the generic CRUD ---- */
function guard(req, res, next) {
  if (!COLLECTIONS.includes(req.params.c)) return res.status(404).json({ error: "unknown collection" });
  next();
}

/* ---- generic CRUD over any allowed collection ---- */
app.get("/:c", guard, async (req, res) => {
  try {
    const ws = getWorkspaceContext(req);
    const docs = await dbAdapter.findAll(ws, req.params.c);
    res.json(docs);
  } catch (e) { 
    console.error(`Error GET /${req.params.c}:`, e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.get("/:c/:id", guard, async (req, res) => {
  try {
    const ws = getWorkspaceContext(req);
    const doc = await dbAdapter.findOne(ws, req.params.c, req.params.id);
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json(doc);
  } catch (e) { 
    console.error(`Error GET /${req.params.c}/${req.params.id}:`, e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.post("/:c", guard, async (req, res) => {
  try {
    const ws = getWorkspaceContext(req);
    const record = Object.assign({}, req.body);
    if (!record.id) record.id = req.params.c.charAt(0).toUpperCase() + "-" + Date.now();
    const saved = await dbAdapter.insertOne(ws, req.params.c, record);
    res.status(201).json(saved);
  } catch (e) { 
    console.error(`Error POST /${req.params.c}:`, e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.put("/:c/:id", guard, async (req, res) => {
  try {
    const ws = getWorkspaceContext(req);
    const patch = Object.assign({}, req.body);
    const updated = await dbAdapter.updateOne(ws, req.params.c, req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(updated);
  } catch (e) { 
    console.error(`Error PUT /${req.params.c}/${req.params.id}:`, e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.delete("/:c/:id", guard, async (req, res) => {
  try {
    const ws = getWorkspaceContext(req);
    const ok = await dbAdapter.deleteOne(ws, req.params.c, req.params.id);
    res.json({ ok });
  } catch (e) { 
    console.error(`Error DELETE /${req.params.c}/${req.params.id}:`, e.message);
    res.status(500).json({ error: e.message }); 
  }
});

const PORT = process.env.PORT || 4000;
connect()
  .then(() => app.listen(PORT, () => console.log("✓ WeboCloud API listening on http://localhost:" + PORT)))
  .catch((e) => { 
    console.warn("✗ Failed to connect to default master MongoDB, starting API server anyway..."); 
    app.listen(PORT, () => console.log("✓ WeboCloud API listening on http://localhost:" + PORT));
  });
