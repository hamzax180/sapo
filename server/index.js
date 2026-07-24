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
const { connect, getMasterDb } = require("./db"); // default master MongoDB connection
const { testConnection, seedWorkspaceDatabase, findWorkspaceByDomain, dbAdapter } = require("./db-adapters");

const app = express();
// Storefront configs carry uploaded slideshow/hero images inline as data
// URLs (the editor re-encodes each upload down to ~150 KB first), so the
// config payload can legitimately run to a few megabytes.
app.use(express.json({ limit: "12mb" }));

const origins = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));

// The marketing/login page is the public entry point; the app console
// shell (index.html) is reached only after signing in.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));

app.use(express.static(path.join(__dirname, "..", "public")));

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret";
const GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// Only these collections may be read/written through the generic CRUD API.
const COLLECTIONS = ["users", "clients", "suppliers", "products", "quotes", "orders", "shipments", "invoices", "purchaseorders", "bills", "payments", "notifications", "audit"];

/* =================================================================
   CUSTOM DOMAIN MIDDLEWARE
   Runs on every request. If the Host header matches a workspace's
   customDomain, we attach the workspace context to req.portalWs
   so portal routes can serve the right branded experience.
   ================================================================= */
const PLATFORM_HOSTS = new Set([
  "localhost", "127.0.0.1",
  (process.env.PLATFORM_HOST || "app.webocloud.com").toLowerCase()
]);

app.use(async (req, res, next) => {
  const host = (req.hostname || "").toLowerCase().replace(/^www\./, "");
  if (PLATFORM_HOSTS.has(host)) return next(); // platform itself — no portal lookup
  try {
    const masterDb = getMasterDb();
    if (masterDb) {
      const ws = await findWorkspaceByDomain(masterDb, host);
      if (ws) {
        req.portalWs = ws;
        // If they hit the root of a custom domain, serve the portal directly
        if (req.path === "/" || req.path === "") {
          return res.sendFile(path.join(__dirname, "..", "public", "portal.html"));
        }
      }
    }
  } catch (e) {
    // Non-fatal — continue without portal context
  }
  next();
});

/* ---- Serve specific frontend pages ---- */
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "signup.html")));
app.get("/pricing", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "pricing.html")));
app.get("/checkout", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "checkout.html")));
app.get("/index", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.get("/portal/:wsId", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "portal.html")));

app.get("/public/login", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/public/signup", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "signup.html")));
app.get("/public/index", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

/**
 * Extracts database context from request headers or environment variables
 */
function getWorkspaceContext(req) {
  const workspaceId = req.headers["x-workspace-id"] || "default";
  const dbType = req.headers["x-workspace-db-type"] || "mongodb";
  const dbUri = req.headers["x-workspace-db-uri"] || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
  return { workspaceId, dbType, dbUri };
}

/**
 * Resolve workspace context for portal routes from :wsId param OR req.portalWs (custom domain)
 */
function getPortalContext(req) {
  if (req.portalWs) {
    return {
      workspaceId: req.portalWs.id,
      dbType: req.portalWs.dbType || "mongodb",
      dbUri: req.portalWs.dbUri || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017"
    };
  }
  // Fallback: look up workspace from master DB by wsId param
  return null; // caller handles
}

/* ---- health probe ---- */
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

/* =================================================================
   WORKSPACE DOMAIN MANAGEMENT API
   ================================================================= */

/**
 * Verifies the request carries a valid JWT AND that the signed-in identity
 * (matched by email) actually owns the given workspace. Throws an Error
 * with a `.status` set (401/403/404/503) that route handlers can catch
 * and forward as the HTTP response.
 *
 * Ownership is anchored on `ownerEmail` on the workspace's master-DB
 * record (set at provisioning time by POST /api/ws) rather than embedded
 * in the JWT, since the JWT is minted by whichever DB the caller happens
 * to authenticate against (their own workspace DB or the master DB) and
 * never carries a workspace id.
 */
async function assertOwnsWorkspace(req, wsId) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) { const e = new Error("unauthorized"); e.status = 401; throw e; }

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch (e2) { const e = new Error("invalid or expired token"); e.status = 401; throw e; }

  const masterDb = getMasterDb();
  if (!masterDb) { const e = new Error("Master DB not available"); e.status = 503; throw e; }

  const ws = await masterDb.collection("workspaces").findOne({ id: wsId });
  if (!ws) { const e = new Error("workspace not found"); e.status = 404; throw e; }

  const callerEmail = String(decoded.email || "").toLowerCase();
  const owns = (ws.ownerUserId && ws.ownerUserId === decoded.id) ||
    (ws.ownerEmail && callerEmail && String(ws.ownerEmail).toLowerCase() === callerEmail);
  if (!owns) { const e = new Error("forbidden — you do not own this workspace"); e.status = 403; throw e; }

  return { decoded, ws, masterDb };
}

/**
 * GET /api/ws/:id/config
 * Returns public workspace config for the portal (no secrets).
 */
app.get("/api/ws/:id/config", async (req, res) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });
    const ws = await masterDb.collection("workspaces").findOne({ id: req.params.id });
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    // Strip sensitive fields
    const { _id, dbUri, dbType, password, ownerUserId, ownerEmail, ...safe } = ws;
    res.json(safe);
  } catch (e) {
    console.error("GET /api/ws/:id/config error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/ws
 * Provisions (or updates) the master-DB workspace record, establishing
 * ownership. Unauthenticated by design — mirrors /api/db/seed and
 * /api/db/test, which also run pre-login during signup. Ownership is
 * anchored on the email the signup form collected; anyone authenticating
 * later with a JWT for that same email is treated as the owner.
 */
app.post("/api/ws", async (req, res) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });

    const { id, company, industry, country, ownerEmail, dbType, dbUri, logo, tagline } = req.body || {};
    if (!id || !ownerEmail) return res.status(400).json({ error: "id and ownerEmail are required" });

    const patch = {
      id,
      company: company || "My Company",
      industry: industry || "logistics",
      country: country || "",
      ownerEmail: String(ownerEmail).toLowerCase(),
      dbType: dbType || "local",
      dbUri: dbUri || "",
      logo: logo || null,
      tagline: tagline || "",
      storefrontEnabled: true
    };

    await masterDb.collection("workspaces").updateOne(
      { id },
      { $set: patch, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true }
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error("POST /api/ws error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/ws/:id/domain
 * Set or clear the custom domain for a workspace.
 * Body: { domain: "store.example.com" | "" }
 * Requires the caller to own the workspace.
 */
app.post("/api/ws/:id/domain", async (req, res) => {
  try {
    const { masterDb } = await assertOwnsWorkspace(req, req.params.id);

    const { domain, storefrontEnabled, storefrontConfig } = req.body || {};
    const patch = {};
    if (domain !== undefined) patch.customDomain = domain ? String(domain).toLowerCase().trim() : null;
    if (storefrontEnabled !== undefined) patch.storefrontEnabled = !!storefrontEnabled;
    if (storefrontConfig !== undefined) patch.storefrontConfig = storefrontConfig;

    await masterDb.collection("workspaces").updateOne(
      { id: req.params.id },
      { $set: patch },
      { upsert: false }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/ws/:id/domain error:", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * POST /api/storefront/config
 * Persists the full storefront (theme/pages/blocks) config. Requires the
 * caller to own the workspace.
 */
app.post("/api/storefront/config", async (req, res) => {
  try {
    const { wsId, storefrontConfig } = req.body || {};
    if (!wsId) return res.status(400).json({ error: "Missing wsId" });

    const { masterDb } = await assertOwnsWorkspace(req, wsId);

    await masterDb.collection("workspaces").updateOne(
      { id: wsId },
      { $set: { storefrontConfig: storefrontConfig } },
      { upsert: false }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/storefront/config error:", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * POST /api/storefront/edit-token
 * Mints a short-lived, scope-limited token the admin app hands to the
 * portal's live editor (which may run on a different origin/custom
 * domain and can't see the admin app's localStorage). Requires the
 * caller to own the workspace being edited.
 */
app.post("/api/storefront/edit-token", async (req, res) => {
  try {
    const { wsId } = req.body || {};
    if (!wsId) return res.status(400).json({ error: "Missing wsId" });

    const { decoded } = await assertOwnsWorkspace(req, wsId);

    const editToken = jwt.sign(
      { wsId, email: decoded.email, scope: "portal-edit" },
      JWT_SECRET,
      { expiresIn: "15m" }
    );
    res.json({ editToken, expiresIn: 900 });
  } catch (e) {
    console.error("POST /api/storefront/edit-token error:", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * GET /api/storefront/edit-token/verify
 * Called by the portal's live editor on load to confirm an `et` query
 * param is a valid, unexpired edit token scoped to this workspace,
 * before mounting the editor UI.
 */
app.get("/api/storefront/edit-token/verify", async (req, res) => {
  try {
    const { wsId, et } = req.query || {};
    if (!wsId || !et) return res.status(400).json({ ok: false, error: "wsId and et are required" });
    const decoded = jwt.verify(String(et), JWT_SECRET);
    if (decoded.scope !== "portal-edit" || decoded.wsId !== wsId) {
      return res.status(403).json({ ok: false, error: "token not valid for this workspace" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ ok: false, error: "invalid or expired edit token" });
  }
});

/* =================================================================
   PUBLIC PORTAL API  (no auth required — guest access)
   All portal reads use findAllPublic() which strips private fields.
   ================================================================= */

/**
 * Helper: resolve workspace DB context from :wsId.
 * Tries master DB lookup first, falls back to localStorage-style header.
 */
async function resolvePortalWs(wsId) {
  try {
    const masterDb = getMasterDb();
    if (masterDb) {
      const ws = await masterDb.collection("workspaces").findOne({ id: wsId });
      if (ws) return { workspaceId: ws.id, dbType: ws.dbType || "mongodb", dbUri: ws.dbUri || process.env.MONGODB_URI };
    }
  } catch (e) { /* fallback */ }
  return { workspaceId: wsId, dbType: "mongodb", dbUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017" };
}

/**
 * GET /api/portal/:wsId/config
 * Public workspace config for the portal frontend.
 */
app.get("/api/portal/:wsId/config", async (req, res) => {
  try {
    const masterDb = getMasterDb();
    if (masterDb) {
      const ws = await masterDb.collection("workspaces").findOne({ id: req.params.wsId });
      if (ws) {
        const { _id, dbUri, dbType, password, ...safe } = ws;
        return res.json(safe);
      }
    }
    // Fallback: return minimal config so portal can still render
    res.json({ id: req.params.wsId, company: "WeboCloud", industry: "logistics", storefrontEnabled: true });
  } catch (e) {
    console.error("GET /api/portal/:wsId/config error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/portal/:wsId/products
 * Public product/menu/service catalogue (strips cost prices etc.)
 */
app.get("/api/portal/:wsId/products", async (req, res) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const items = await dbAdapter.findAllPublic(ws, "products");
    res.json(items);
  } catch (e) {
    // DB unavailable — return empty so portal falls back to localStorage
    console.warn("GET /api/portal/:wsId/products (no DB):", e.message);
    res.json([]);
  }
});


/**
 * POST /api/portal/:wsId/orders
 * Guest checkout — creates an order in the workspace's orders collection.
 * Body: { customer: { name, email, phone, address }, items: [...], note, type }
 */
app.post("/api/portal/:wsId/orders", async (req, res) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const { customer, items, note, type, payment } = req.body || {};
    if (!customer || !customer.name || !customer.email) {
      return res.status(400).json({ error: "customer.name and customer.email are required" });
    }
    if (!items || !items.length) {
      return res.status(400).json({ error: "items array is required" });
    }
    const total = items.reduce((s, i) => s + (Number(i.price || 0) * Number(i.qty || 1)), 0);
    const ref = "PO-" + Date.now();
    // Demo checkout only — no real payment gateway is wired up. Only the
    // method + a non-reversible {brand,last4} are ever stored; full card
    // numbers/CVCs are validated client-side and never sent here.
    const paymentInfo = payment && ["card", "paypal", "cod", "bank"].includes(payment.method)
      ? { method: payment.method, brand: payment.brand || null, last4: payment.last4 || null }
      : { method: "cod", brand: null, last4: null };
    const order = {
      id: "O-" + Date.now(),
      ref,
      date: new Date().toISOString(),
      status: "Pending",
      source: "portal",
      type: type || "online",
      customer,
      items,
      total,
      payment: paymentInfo,
      note: note || "",
      createdAt: new Date().toISOString()
    };
    await dbAdapter.insertOne(ws, "orders", order);
    res.status(201).json({ ok: true, ref, orderId: order.id });
  } catch (e) {
    console.error("POST /api/portal/:wsId/orders error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/portal/:wsId/track/:ref
 * Shipment / order tracking by reference number. Guest-safe.
 */
app.get("/api/portal/:wsId/track/:ref", async (req, res) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const ref = req.params.ref;

    // Search shipments first, then orders
    const [shipments, orders] = await Promise.all([
      dbAdapter.findAllPublic(ws, "shipments"),
      dbAdapter.findAllPublic(ws, "orders")
    ]);

    const shipment = shipments.find(s => String(s.ref || s.id || "").toLowerCase() === ref.toLowerCase());
    if (shipment) return res.json({ type: "shipment", record: shipment });

    const order = orders.find(o => String(o.ref || o.id || "").toLowerCase() === ref.toLowerCase());
    if (order) return res.json({ type: "order", record: order });

    res.status(404).json({ error: "Reference not found" });
  } catch (e) {
    console.error("GET /api/portal/:wsId/track error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/portal/:wsId/inquiry
 * Quote request / service inquiry form. Creates a lead in clients + a quote.
 * Body: { name, email, phone, message, budget, service }
 */
app.post("/api/portal/:wsId/inquiry", async (req, res) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const { name, email, phone, message, budget, service } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: "name and email are required" });

    const ref = "INQ-" + Date.now();
    const quote = {
      id: "Q-" + Date.now(),
      ref,
      date: new Date().toISOString(),
      status: "Draft",
      source: "portal-inquiry",
      client: name,
      email,
      phone: phone || "",
      service: service || "",
      budget: budget || "",
      notes: message || "",
      createdAt: new Date().toISOString()
    };
    await dbAdapter.insertOne(ws, "quotes", quote);
    res.status(201).json({ ok: true, ref });
  } catch (e) {
    console.error("POST /api/portal/:wsId/inquiry error:", e.message);
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
