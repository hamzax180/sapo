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
const { idForCollection } = require("./lib/ids");
const { httpError, errorHandler } = require("./lib/errors");
const requestId = require("./middleware/requestId");
const { makeAuth } = require("./middleware/auth");
const { validateBody } = require("./lib/validate");
const { loginSchema, orderSchema, inquirySchema } = require("./lib/schemas");
const { initIdempotency, withIdempotency } = require("./lib/idempotency");
const securityHeaders = require("./middleware/securityHeaders");
const { rateLimit } = require("./middleware/rateLimit");
const { encryptSecret } = require("./lib/crypto");
const requestLog = require("./middleware/requestLog");
const metrics = require("./lib/metrics");
const { writeAudit, writeMasterAudit } = require("./lib/audit");

const app = express();
app.disable("x-powered-by");

// Per-route body limits. Storefront-config routes carry inline data-URL
// images and legitimately run to a few MB; everything else is capped tight
// to shrink the DoS surface.
const jsonBig = express.json({ limit: "12mb" });
const jsonDefault = express.json({ limit: "4mb" });
app.use((req, res, next) => {
  const big = req.path === "/api/storefront/config" || /^\/api\/ws\/[^/]+\/domain$/.test(req.path);
  return (big ? jsonBig : jsonDefault)(req, res, next);
});

const origins = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));

// Every request gets a unique correlation id (req_...), echoed as X-Request-Id.
app.use(requestId);
// Baseline security headers on every response.
app.use(securityHeaders);
// Structured per-request logging + metrics.
app.use(requestLog);

// Reusable limiters for the abuse-prone endpoints.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, key: (req) => (req.ip || "") + ":" + ((req.body && req.body.email) || "") });
const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, key: (req) => (req.ip || "") + ":" + req.params.wsId });
const inquiryLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => (req.ip || "") + ":" + req.params.wsId });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// The marketing/login page is the public entry point; the app console
// shell (index.html) is reached only after signing in.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));

app.use(express.static(path.join(__dirname, "..", "public")));

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret";
// Fail closed: never boot production with a default/placeholder secret.
if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || JWT_SECRET === "dev-insecure-secret")) {
  console.error("FATAL: JWT_SECRET must be set to a strong secret in production. Refusing to start.");
  process.exit(1);
}
if (JWT_SECRET === "dev-insecure-secret") {
  console.warn("⚠ JWT_SECRET is using the insecure development default — set a strong JWT_SECRET before production.");
}

// Server-authoritative auth / tenancy / RBAC middleware.
const { requireSession, tenantScope, authorizeCrud, resolveWsContext } = makeAuth({ JWT_SECRET, getMasterDb });
initIdempotency({ getMasterDb });

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
  (process.env.PLATFORM_HOST || "app.souqi.site").toLowerCase()
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

/* NOTE: workspace/DB context is no longer derived from client headers.
   Authenticated requests get it from the signed session via the
   tenantScope middleware (server/middleware/auth.js); public portal
   routes resolve it from the :wsId path param via resolvePortalWs().
   The old header-trust helpers were removed to keep that invariant. */

/* ---- health probe ---- */
app.get("/health", (req, res) => res.json({ ok: true, service: "souqi-api", time: new Date().toISOString() }));

/* ---- metrics (gated by METRICS_TOKEN; disabled if unset) ---- */
app.get("/metrics", (req, res, next) => {
  const tok = (process.env.METRICS_TOKEN || "").trim();
  if (!tok) return next(httpError(404, "not_found", "metrics disabled"));
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (supplied !== tok) return next(httpError(401, "unauthorized", "metrics token required"));
  res.json(metrics.snapshot());
});

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
app.post("/api/ws", async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });

    const { id, company, industry, country, ownerEmail, dbType, dbUri, logo, tagline } = req.body || {};
    if (!id || !ownerEmail) return res.status(400).json({ error: "id and ownerEmail are required" });
    if (!/^ws_[A-Za-z0-9]{4,}$/.test(id)) return res.status(400).json({ error: "invalid workspace id" });
    const email = String(ownerEmail).toLowerCase();

    const existing = await masterDb.collection("workspaces").findOne({ id });
    if (existing) {
      // Takeover guard: an existing workspace's ownership and database are
      // immutable through this unauthenticated signup endpoint. Only the
      // recorded owner may re-post it, and only display fields update.
      if (existing.ownerEmail && existing.ownerEmail !== email) {
        return next(httpError(403, "forbidden", "workspace already owned by another account"));
      }
      await masterDb.collection("workspaces").updateOne(
        { id },
        { $set: {
          company: company || existing.company,
          industry: industry || existing.industry,
          country: country || existing.country,
          logo: logo != null ? logo : existing.logo,
          tagline: tagline || existing.tagline
        } }
      );
      return res.status(200).json({ ok: true, updated: true });
    }

    await masterDb.collection("workspaces").insertOne({
      id,
      company: company || "My Company",
      industry: industry || "logistics",
      country: country || "",
      ownerEmail: email,
      dbType: dbType || "local",
      dbUri: encryptSecret(dbUri || ""),
      logo: logo || null,
      tagline: tagline || "",
      storefrontEnabled: true,
      createdAt: new Date().toISOString()
    });
    res.status(201).json({ ok: true, created: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/ws/:id/domain
 * Set or clear the custom domain for a workspace.
 * Body: { domain: "store.example.com" | "" }
 * Requires the caller to own the workspace.
 */
app.post("/api/ws/:id/domain", async (req, res, next) => {
  try {
    const { decoded, masterDb } = await assertOwnsWorkspace(req, req.params.id);

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
    const ws = await resolveWsContext(req.params.id);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.domain.update",
      entity: "workspace", entityId: req.params.id,
      summary: "Domain/storefront settings updated"
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/ws/:id/export  — GDPR data portability.
 * Returns every collection for the workspace. Owner-only.
 */
app.get("/api/ws/:id/export", async (req, res, next) => {
  try {
    const { decoded } = await assertOwnsWorkspace(req, req.params.id);
    const ws = await resolveWsContext(req.params.id);
    const collections = {};
    for (const c of COLLECTIONS) {
      collections[c] = await dbAdapter.findAll(ws, c).catch(() => []);
    }
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.export",
      entity: "workspace", entityId: req.params.id, summary: "Full data export"
    });
    res.json({ workspaceId: req.params.id, exportedAt: new Date().toISOString(), collections });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/ws/:id  — GDPR right-to-erasure.
 * Drops the workspace's tenant database and master record. Owner-only.
 * The deletion itself is recorded to the PLATFORM audit (which survives).
 */
app.delete("/api/ws/:id", async (req, res, next) => {
  try {
    const { decoded, masterDb } = await assertOwnsWorkspace(req, req.params.id);
    await writeMasterAudit(masterDb, {
      requestId: req.id, actor: decoded.email, wsId: req.params.id,
      action: "workspace.delete", entityId: req.params.id, summary: "Workspace erased"
    });
    const ws = await resolveWsContext(req.params.id);
    await dbAdapter.purgeWorkspace(ws);
    await masterDb.collection("workspaces").deleteOne({ id: req.params.id });
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/storefront/config
 * Persists the full storefront (theme/pages/blocks) config. Requires the
 * caller to own the workspace.
 */
app.post("/api/storefront/config", async (req, res, next) => {
  try {
    const { wsId, storefrontConfig } = req.body || {};
    if (!wsId) return res.status(400).json({ error: "Missing wsId" });

    const { decoded, masterDb } = await assertOwnsWorkspace(req, wsId);

    await masterDb.collection("workspaces").updateOne(
      { id: wsId },
      { $set: { storefrontConfig: storefrontConfig } },
      { upsert: false }
    );
    const ws = await resolveWsContext(wsId);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.storefront.update",
      entity: "workspace", entityId: wsId, summary: "Storefront config saved"
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
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
 * Helper: resolve the server-owned DB context for a public portal :wsId.
 * Delegates to the same resolver the authenticated CRUD path uses, so
 * "local"/empty dbType normalizes to the platform default and no client
 * value ever selects the database.
 */
async function resolvePortalWs(wsId) {
  return resolveWsContext(wsId);
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
    res.json({ id: req.params.wsId, company: "Souqi", industry: "logistics", storefrontEnabled: true });
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
app.post("/api/portal/:wsId/orders",
  orderLimiter,
  withIdempotency((req) => req.params.wsId),
  validateBody(orderSchema),
  async (req, res, next) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const { customer, items, note, type, payment } = req.valid;
    const total = items.reduce((s, i) => s + (Number(i.price || 0) * Number(i.qty || 1)), 0);
    const orderId = idForCollection("orders");
    const ref = "SQ-ORD-" + new Date().getFullYear() + "-" + orderId.split("_").pop().slice(-8);
    // Demo checkout only — no real payment gateway is wired up. Only the
    // method + a non-reversible {brand,last4} are ever stored; full card
    // numbers/CVCs are validated client-side and never sent here.
    const paymentInfo = payment && ["card", "paypal", "cod", "bank"].includes(payment.method)
      ? { method: payment.method, brand: payment.brand || null, last4: payment.last4 || null }
      : { method: "cod", brand: null, last4: null };
    const order = {
      id: orderId,
      ref,
      wsId: ws.workspaceId,
      requestId: req.id,
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
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: "guest:" + customer.email, action: "order.create",
      entity: "orders", entityId: order.id, summary: "Guest order " + ref + " total " + total
    });
    res.status(201).json({ ok: true, ref, orderId: order.id });
  } catch (e) {
    next(e);
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
app.post("/api/portal/:wsId/inquiry",
  inquiryLimiter,
  withIdempotency((req) => req.params.wsId),
  validateBody(inquirySchema),
  async (req, res, next) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const { name, email, phone, message, budget, service } = req.valid;

    const quoteId = idForCollection("quotes");
    const ref = "SQ-INQ-" + new Date().getFullYear() + "-" + quoteId.split("_").pop().slice(-8);
    const quote = {
      id: quoteId,
      ref,
      wsId: ws.workspaceId,
      requestId: req.id,
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
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: "guest:" + email, action: "inquiry.create",
      entity: "quotes", entityId: quote.id, summary: "Portal inquiry " + ref
    });
    res.status(201).json({ ok: true, ref });
  } catch (e) {
    next(e);
  }
});

/* ---- auth: verify a hashed password, return a token + safe profile ---- */
app.post("/auth/login", loginLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.valid;

    // The workspace being signed into is named by the client; the DB context
    // for it is resolved SERVER-SIDE (never from a client-supplied dbUri).
    const wsId = String(req.headers["x-workspace-id"] || "default");
    const ws = await resolveWsContext(wsId);
    const users = await dbAdapter.findAll(ws, "users");
    const u = users.find(usr => String(usr.email).toLowerCase() === String(email).toLowerCase());

    if (!u || !u.active) return res.status(401).json({ error: "invalid credentials" });

    // Only bcrypt-hashed passwords authenticate. Plaintext is never accepted
    // server-side (the seeder hashes all users at provisioning time).
    const stored = String(u.password || "");
    const ok = stored.startsWith("$2") ? await bcrypt.compare(password, stored) : false;
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    // The signed token carries the workspace id — this is what every later
    // request is scoped by, so tenancy can't be spoofed via a header.
    const session = { id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, wsId: ws.workspaceId };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: session });
  } catch (e) {
    console.error("login error:", e.message);
    res.status(500).json({ error: "login failed" });
  }
});

/* ---- AI proxy: keep the Gemini key on the server ---- */
app.post("/ai/chat", aiLimiter, async (req, res) => {
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

/* ---- generic CRUD over any allowed collection ----
   Every route is: guard (known collection) → requireSession (valid JWT)
   → tenantScope (server-derived workspace + DB) → authorizeCrud (RBAC).
   The workspace is taken from the signed session (req.ws), never from a
   client header, and record ids are minted server-side. ---- */
const crud = [guard, requireSession, tenantScope, authorizeCrud];

app.get("/:c", crud, async (req, res, next) => {
  try {
    const docs = await dbAdapter.findAll(req.ws, req.params.c);
    res.json(docs);
  } catch (e) { next(e); }
});

app.get("/:c/:id", crud, async (req, res, next) => {
  try {
    const doc = await dbAdapter.findOne(req.ws, req.params.c, req.params.id);
    if (!doc) return next(httpError(404, "not_found", "not found"));
    res.json(doc);
  } catch (e) { next(e); }
});

app.post("/:c", crud, async (req, res, next) => {
  try {
    const record = Object.assign({}, req.body);
    // Server-authoritative id + traceability. The client's proposed id is
    // ignored so ids are always globally unique and non-enumerable.
    record.id = idForCollection(req.params.c);
    record.wsId = req.ws.workspaceId;
    record.requestId = req.id;
    const saved = await dbAdapter.insertOne(req.ws, req.params.c, record);
    res.status(201).json(saved);
  } catch (e) { next(e); }
});

app.put("/:c/:id", crud, async (req, res, next) => {
  try {
    const patch = Object.assign({}, req.body);
    // Identity fields are immutable through updates.
    delete patch.id; delete patch.wsId;
    const updated = await dbAdapter.updateOne(req.ws, req.params.c, req.params.id, patch);
    if (!updated) return next(httpError(404, "not_found", "not found"));
    res.json(updated);
  } catch (e) { next(e); }
});

app.delete("/:c/:id", crud, async (req, res, next) => {
  try {
    const ok = await dbAdapter.deleteOne(req.ws, req.params.c, req.params.id);
    res.json({ ok });
  } catch (e) { next(e); }
});

// Central error handler — turns thrown/next(err) into a safe envelope
// { error: { code, message, requestId } } and keeps 5xx details server-side.
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
connect()
  .then(() => app.listen(PORT, () => console.log("✓ Souqi API listening on http://localhost:" + PORT)))
  .catch((e) => { 
    console.warn("✗ Failed to connect to default master MongoDB, starting API server anyway..."); 
    app.listen(PORT, () => console.log("✓ Souqi API listening on http://localhost:" + PORT));
  });
