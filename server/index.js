/* =================================================================
   Souqi — REST + auth + AI proxy backend (Multi-Database Support)
   -----------------------------------------------------------------
   Implements exactly the contract the front-end Store expects.
   Workspace/DB context is resolved SERVER-SIDE from the signed JWT
   session (via tenantScope middleware) for authenticated requests,
   or from the :wsId path param for public portal routes.
   Client headers never select which database is used.
   ================================================================= */
const path = require("path");
// Explicit path, not the default require("dotenv").config() — that
// resolves .env relative to process.cwd(), which silently does nothing
// (no error, no warning) whenever this is launched from anywhere other
// than server/ itself. Found live: DAYTONA_API_KEY IS set in
// server/.env, but a launcher starting `node server/index.js` from the
// repo root left process.env.DAYTONA_API_KEY undefined, and every build
// failed at sandbox creation with "DAYTONA_API_KEY is not set" — a
// working-directory bug wearing a missing-credentials error message.
require("dotenv").config({ path: path.join(__dirname, ".env") });
const crypto = require("crypto");
const dns = require("dns");
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
const { loginSchema, orderSchema, inquirySchema, microClaimSchema } = require("./lib/schemas");
const { initIdempotency, withIdempotency } = require("./lib/idempotency");
const securityHeaders = require("./middleware/securityHeaders");
const { rateLimit } = require("./middleware/rateLimit");
const { encryptSecret } = require("./lib/crypto");
const requestLog = require("./middleware/requestLog");
const metrics = require("./lib/metrics");
const { writeAudit, writeMasterAudit } = require("./lib/audit");
const { verifyCaptcha } = require("./middleware/captcha");

const app = express();
app.disable("x-powered-by");

// Per-route body limits. Storefront-config routes carry inline data-URL
// images and legitimately run to a few MB; everything else is capped tight
// to shrink the DoS surface.
const jsonBig = express.json({ limit: "12mb" });
const jsonDefault = express.json({ limit: "4mb" });
app.use((req, res, next) => {
  // /api/codeagent/build: a base64-encoded logo upload (see attachLogoIfPresent)
  // can legitimately run to ~4MB even after the client's own 2MB cap on the
  // decoded image — base64 adds ~33%, and this is JSON, not multipart.
  const big = req.path === "/api/storefront/config" || req.path === "/api/codeagent/build"
    || /^\/api\/ws\/[^/]+\/domain$/.test(req.path);
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
const visitLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, key: (req) => req.ip || "" });

// home.html is the public entry point — the marketing page, not login.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "home.html")));

// WebContainers require Cross-Origin Isolation (SharedArrayBuffer).
// These headers ONLY apply to the builder page, not globally — setting
// them site-wide would break third-party embeds on portal/storefront
// pages.
//
// /agent and /agent/:slug are in this list because THEY are the routes a
// user actually lands on; both sendFile code.html. Without them the page
// loads fine, SharedArrayBuffer is undefined, and WebContainer.boot()
// fails — a build that dies for a reason nothing on the page explains.
// (/code and /code.html stay listed: they serve the same document, so
// isolating one entry point and not the others would just move the bug.)
function crossOriginIsolate(req, res, next) {
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}
app.use("/agent", crossOriginIsolate);
app.use("/code", crossOriginIsolate);
app.use("/code.html", crossOriginIsolate);

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
const { requireSession, tenantScope, authorizeCrud, requireAdmin, resolveWsContext } = makeAuth({ JWT_SECRET, getMasterDb });
initIdempotency({ getMasterDb });

// Canonical subscription plans; anything other than "free" is a paying
// "subscriber". Monthly prices drive the MRR estimate (override via env
// PLAN_PRICES as JSON if your pricing differs).
const PLANS = ["free", "pro", "business", "max", "team", "enterprise"];
let PLAN_PRICES = { free: 0, pro: 29, business: 79, max: 149, team: 199, enterprise: 499 };
try { if (process.env.PLAN_PRICES) PLAN_PRICES = Object.assign(PLAN_PRICES, JSON.parse(process.env.PLAN_PRICES)); } catch (e) { /* keep defaults */ }

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
        return next();
      }
      // Not a Sites workspace domain — check Souqi Code's own published
      // projects before falling through. Same trust model, same reason
      // it's safe (see projects.js findByCustomDomain's own comment).
      const codeProject = await projects.findByCustomDomain(host);
      if (codeProject && codeProject.published) {
        return servePublishedSite(req, res, req.path.replace(/^\//, ""), codeProject);
      }
    }
  } catch (e) {
    // Non-fatal — continue without portal context
  }
  next();
});

/* ---- Serve specific frontend pages ----
   The old deterministic site builder (agent.html), the workspace/signup
   flow (signup.html), and the Operations Console (index.html) are gone —
   deleted, not just unrouted. Souqi Code (code.html, at /agent) is the
   only way to build now. Anything that isn't a real product surface
   anymore (/signup, /index, /public/signup, /public/index) is removed
   below rather than left pointing at a 404 sendFile. */
app.get("/home", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "home.html")));
app.get("/agent", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "code.html")));
app.get("/agent/:slug", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "code.html")));
app.get("/build", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "home.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/pricing", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "pricing.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "terms.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "privacy.html")));
app.get("/settings", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "settings.html")));
app.get("/projects", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "projects.html")));
app.get("/checkout", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "checkout.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));
app.get("/portal/:wsId", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "portal.html")));

app.get("/public/login", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));

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

/* =================================================================
   VISIT TRACKING  (public, privacy-preserving)
   Stores a per-visit row with a DAILY-ROTATING hashed visitor id
   (no raw IP/UA persisted), so unique visitors can be counted without
   retaining PII.
   ================================================================= */
app.post("/api/track/visit", visitLimiter, async (req, res) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.json({ ok: true });
    const b = req.body || {};
    const day = new Date().toISOString().slice(0, 10);
    const seed = (req.ip || "") + "|" + (req.headers["user-agent"] || "") + "|" + day + "|" + (process.env.VISIT_SALT || "souqi");
    const vid = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
    const coll = masterDb.collection("visits");
    await coll.insertOne({
      id: idForCollection("audit").replace(/^aud_/, "vis_"),
      ts: new Date().toISOString(),
      createdAt: new Date(),
      day,
      path: String(b.path || "/").slice(0, 200),
      type: b.type === "portal" ? "portal" : "marketing",
      wsId: b.wsId ? String(b.wsId).slice(0, 60) : null,
      ref: b.ref ? String(b.ref).slice(0, 200) : null,
      vid
    });
    // Retain raw visit rows for 180 days (aggregates can be rolled up before
    // expiry); keeps the collection bounded.
    coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true }); // tracking must never break the page
  }
});

/* =================================================================
   PLATFORM SUPER-ADMIN API  (requireSession + requireAdmin)
   Aggregates the master registry (accounts, plans, visits) and each
   tenant's orders (revenue) into a single overview for the console.
   ================================================================= */
const adminGuard = [requireSession, requireAdmin];

function lastNDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

app.get("/api/admin/overview", adminGuard, async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.json({ empty: true });

    const workspaces = await masterDb.collection("workspaces").find({}).toArray();

    // Plan distribution + premium count.
    const byPlan = {};
    PLANS.forEach((p) => { byPlan[p] = 0; });
    let premium = 0, mrr = 0;
    workspaces.forEach((w) => {
      const pl = PLANS.includes(w.plan) ? w.plan : "free";
      byPlan[pl] = (byPlan[pl] || 0) + 1;
      if (pl !== "free") premium++;
      mrr += PLAN_PRICES[pl] || 0;
    });

    // Visits.
    const visitsColl = masterDb.collection("visits");
    const totalVisits = await visitsColl.countDocuments().catch(() => 0);
    const uniqueVisitors = (await visitsColl.distinct("vid").catch(() => [])).length;

    // Per-store revenue (sum each tenant's orders).
    const stores = [];
    for (const w of workspaces) {
      let orders = [];
      try { orders = await dbAdapter.findAll(await resolveWsContext(w.id), "orders"); } catch (e) { orders = []; }
      const revenue = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
      stores.push({
        wsId: w.id, company: w.company || "Untitled", ownerEmail: w.ownerEmail || "",
        plan: PLANS.includes(w.plan) ? w.plan : "free", industry: w.industry || "",
        country: w.country || "", orders: orders.length, revenue: Math.round(revenue * 100) / 100,
        createdAt: w.createdAt || null, customDomain: w.customDomain || null
      });
    }
    stores.sort((a, b) => b.revenue - a.revenue);

    const totalRevenue = Math.round(stores.reduce((s, x) => s + x.revenue, 0) * 100) / 100;
    const totalOrders = stores.reduce((s, x) => s + x.orders, 0);

    // 14-day time series for signups and visits.
    const days = lastNDays(14);
    const signupsByDay = days.map((d) => ({ day: d, count: workspaces.filter((w) => String(w.createdAt || "").slice(0, 10) === d).length }));
    let visitDayRows = [];
    try {
      visitDayRows = await visitsColl.aggregate([
        { $group: { _id: "$day", visits: { $sum: 1 }, uniques: { $addToSet: "$vid" } } }
      ]).toArray();
    } catch (e) { visitDayRows = []; }
    const visitMap = {}; visitDayRows.forEach((r) => { visitMap[r._id] = { visits: r.visits, uniques: (r.uniques || []).length }; });
    const visitsByDay = days.map((d) => ({ day: d, visits: (visitMap[d] || {}).visits || 0, uniques: (visitMap[d] || {}).uniques || 0 }));

    const recentSignups = workspaces
      .slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 12)
      .map((w) => ({ wsId: w.id, company: w.company, ownerEmail: w.ownerEmail, plan: PLANS.includes(w.plan) ? w.plan : "free", industry: w.industry, country: w.country, createdAt: w.createdAt }));

    // Visit split by surface (marketing vs storefront).
    let byType = { marketing: 0, portal: 0 };
    try {
      const typeRows = await visitsColl.aggregate([{ $group: { _id: "$type", n: { $sum: 1 } } }]).toArray();
      typeRows.forEach((r) => { if (r._id === "portal") byType.portal = r.n; else byType.marketing += r.n; });
    } catch (e) { /* empty */ }

    res.json({
      generatedAt: new Date().toISOString(),
      admin: { name: req.session.name || null, email: req.session.email || null },
      totals: { accounts: workspaces.length, premium, subscribers: premium, mrr, arr: mrr * 12, freeAccounts: workspaces.length - premium, visits: totalVisits, uniqueVisitors, revenue: totalRevenue, orders: totalOrders },
      byPlan,
      byType,
      plans: PLANS,
      planPrices: PLAN_PRICES,
      topStores: stores.slice(0, 10),
      recentSignups,
      signupsByDay,
      visitsByDay
    });
  } catch (e) { next(e); }
});

// Full account list (every workspace with plan + revenue) for the drill-down.
app.get("/api/admin/accounts", adminGuard, async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.json({ accounts: [] });
    const workspaces = await masterDb.collection("workspaces").find({}).toArray();
    const accounts = [];
    for (const w of workspaces) {
      let orders = [];
      try { orders = await dbAdapter.findAll(await resolveWsContext(w.id), "orders"); } catch (e) { orders = []; }
      accounts.push({
        wsId: w.id, company: w.company || "Untitled", ownerEmail: w.ownerEmail || "",
        plan: PLANS.includes(w.plan) ? w.plan : "free", industry: w.industry || "",
        country: w.country || "", customDomain: w.customDomain || null,
        orders: orders.length, revenue: Math.round(orders.reduce((s, o) => s + (Number(o.total) || 0), 0) * 100) / 100,
        createdAt: w.createdAt || null
      });
    }
    accounts.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    res.json({ plans: PLANS, accounts });
  } catch (e) { next(e); }
});

// Set a workspace's plan (billing/admin action).
app.post("/api/admin/ws/:id/plan", adminGuard, async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });
    const plan = String((req.body && req.body.plan) || "").toLowerCase();
    if (!PLANS.includes(plan)) return next(httpError(400, "validation_error", "plan must be one of: " + PLANS.join(", ")));
    const r = await masterDb.collection("workspaces").updateOne({ id: req.params.id }, { $set: { plan } });
    if (!r.matchedCount) return next(httpError(404, "not_found", "workspace not found"));
    await writeMasterAudit(masterDb, {
      requestId: req.id, actor: req.session.email, wsId: req.params.id,
      action: "admin.plan.update", entityId: req.params.id, summary: "Plan set to " + plan
    });
    res.json({ ok: true, plan });
  } catch (e) { next(e); }
});

/* ---- dynamic db connection testing (auth required) ---- */
app.post("/api/db/test", requireSession, async (req, res) => {
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

/* ---- dynamic db seeding/provisioning (auth required) ---- */
app.post("/api/db/seed", requireSession, async (req, res) => {
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
      plan: PLANS.includes(String(req.body && req.body.plan)) ? req.body.plan : "free",
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
    const wsId = req.query && req.query.wsId;
    // Prefer the token from a header (not logged in the request line); fall
    // back to the query param for older edit links.
    const et = req.headers["x-edit-token"] || (req.query && req.query.et);
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

/**
 * POST /api/storefront/edit-token/refresh
 * Rotates a STILL-VALID edit token into a fresh 15-minute one so long
 * editing sessions don't fail at Publish. The current unexpired token is
 * itself the proof of an authorized session — no owner JWT needed on the
 * portal page. An already-expired token cannot be refreshed (reopen from
 * the console).
 */
app.post("/api/storefront/edit-token/refresh", (req, res) => {
  try {
    const et = req.headers["x-edit-token"] || (req.body && req.body.et);
    if (!et) return res.status(400).json({ error: "edit token required" });
    const decoded = jwt.verify(String(et), JWT_SECRET);
    if (decoded.scope !== "portal-edit" || !decoded.wsId) {
      return res.status(403).json({ error: "not an edit token" });
    }
    const editToken = jwt.sign(
      { wsId: decoded.wsId, email: decoded.email, scope: "portal-edit" },
      JWT_SECRET, { expiresIn: "15m" }
    );
    res.json({ editToken, expiresIn: 900 });
  } catch (e) {
    res.status(401).json({ error: "invalid or expired edit token" });
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
  verifyCaptcha(),
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
  verifyCaptcha(),
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
    // When no workspace is named (e.g. the admin panel's email+password
    // login), resolve it from the master registry by owner email.
    let wsId = String(req.headers["x-workspace-id"] || "");
    if (!wsId || wsId === "default") {
      const masterDb = getMasterDb();
      if (masterDb) {
        const owned = await masterDb.collection("workspaces").findOne({ ownerEmail: email });
        if (owned) wsId = owned.id;
      }
    }
    if (!wsId) wsId = "default";
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
    // Also set an httpOnly session cookie so browser clients (e.g. the admin
    // panel) never keep the token in JS-readable storage. httpOnly = not
    // reachable by XSS; SameSite=Lax = not sent on cross-site mutations.
    res.cookie("sq_session", token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000, path: "/"
    });
    res.json({ token, user: session });
  } catch (e) {
    console.error("login error:", e.message);
    res.status(500).json({ error: "login failed" });
  }
});

/* ---- logout: clear the httpOnly session cookie ---- */
app.post("/auth/logout", (req, res) => {
  res.clearCookie("sq_session", { path: "/" });
  res.json({ ok: true });
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

/* =================================================================
   AI SITE BUILDER  ("what will you build?")
   -----------------------------------------------------------------
   A prompt becomes a storefront config. Two hard rules:

     1. Whatever produces the config — the composer today, a
        model tomorrow — its output goes through site-validate.js
        before it is stored or returned. One trust boundary, no
        exceptions. See docs/AI-BUILDER-PLAN.md §3.6.
     2. A draft is NOT a workspace. It has no database, no tenancy and
        no owner, so it can safely exist for an anonymous visitor.
        Claiming one (post-signup) is what creates the real workspace.
   ================================================================= */
const { validateSiteConfig } = require("./lib/site-validate");
const composer = require("./lib/composer");
const { classify, choices } = require("./lib/nlu/classify");
const { extract } = require("./lib/nlu/slots");

/* Labels the visitor sees when we have to ask which industry they meant. */
const INDUSTRY_LABELS = {
  restaurant: "Restaurant / café", fashion: "Fashion & clothing", logistics: "Logistics & freight",
  manufacturing: "Manufacturing", construction: "Construction", services: "Services & bookings",
  wholesale: "Wholesale & trade", retail: "Retail shop"
};

const agentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: (req) => req.ip || "" });

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const draftMemory = new Map();   // fallback when the master DB isn't up

function pruneDrafts() {
  const now = Date.now();
  for (const [id, d] of draftMemory) if (d.expiresAt <= now) draftMemory.delete(id);
  if (draftMemory.size > 500) {
    // hard cap so an unbacked dev server can't grow without bound
    const oldest = [...draftMemory.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    oldest.slice(0, draftMemory.size - 500).forEach(([id]) => draftMemory.delete(id));
  }
}

async function saveDraft(draft) {
  const masterDb = getMasterDb();
  if (masterDb) {
    await masterDb.collection("agent_drafts").insertOne(draft);
    // TTL index is idempotent; expired drafts are reaped by Mongo itself
    masterDb.collection("agent_drafts")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch(() => {});
    return;
  }
  pruneDrafts();
  draftMemory.set(draft.id, draft);
}

async function loadDraft(id) {
  const masterDb = getMasterDb();
  if (masterDb) return masterDb.collection("agent_drafts").findOne({ id: id }, { projection: { _id: 0 } });
  pruneDrafts();
  return draftMemory.get(id) || null;
}

/**
 * POST /api/agent/build
 * Body: { prompt, mode? }   — no auth; this is the free first build.
 * Returns: { draftId, config, meta, issues }
 */
app.post("/api/agent/build", agentLimiter, async (req, res, next) => {
  try {
    const prompt = String((req.body && req.body.prompt) || "").trim();
    if (prompt.length < 3) return res.status(400).json({ error: "prompt is required" });
    if (prompt.length > 2000) return res.status(400).json({ error: "prompt is too long" });

    const mode = String((req.body && req.body.mode) || "").slice(0, 30);
    // set when the visitor answered a "which is closest?" question
    const forcedIndustry = String((req.body && req.body.industry) || "").slice(0, 30);

    /* ---- understand (no model, no network — see NO-API-BUILDER-PLAN §3) ---- */
    const verdictNlu = classify(prompt);
    const slots = extract(prompt, verdictNlu.lang);

    // Guessing confidently wrong is worse than asking. One chip row costs the
    // visitor a tap; it costs us 150ms.
    if (!forcedIndustry && !verdictNlu.certain) {
      return res.json({
        needsAnswer: {
          question: "Which is closest to your business?",
          options: choices(verdictNlu).map((k) => ({ key: k, label: INDUSTRY_LABELS[k] || k }))
        },
        lang: verdictNlu.lang,
        confidence: verdictNlu.confidence
      });
    }

    const industry = forcedIndustry || verdictNlu.industry;

    // Today: the deterministic composer, now fed real slots instead of its own
    // keyword guess. A model pipeline would slot in here and hand its output to
    // the SAME validator below.
    const composed = composer.compose(prompt, {
      mode: mode,
      industry: industry,
      company: slots.company,
      city: slots.city,
      currency: slots.currency,
      colour: slots.colour,
      features: slots.features,
      tone: slots.tone,
      lang: slots.lang
    });
    const verdict = validateSiteConfig(composed.config, { forAgent: true });

    if (!verdict.ok) {
      console.error("agent build failed validation:", verdict.issues.slice(0, 5));
      return res.status(502).json({ error: "could not build a site from that", issues: verdict.issues.slice(0, 5) });
    }

    const now = Date.now();
    const draft = {
      id: "dr_" + crypto.randomBytes(9).toString("base64url"),
      prompt: prompt.slice(0, 2000),
      mode: mode,
      meta: composed.meta,
      config: verdict.config,
      ip: req.ip || "",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DRAFT_TTL_MS)
    };
    await saveDraft(draft);

    res.json({
      draftId: draft.id,
      config: draft.config,
      meta: draft.meta,
      issues: verdict.issues.slice(0, 10),
      expiresInDays: 7
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/agent/claim
 * Body: { draftId, wsId }   Header: Authorization: Bearer <owner JWT>
 *
 * Turns an anonymous draft into the workspace's live storefront. This is the
 * moment a draft stops being a throwaway and becomes the owner's property, so
 * it goes through the SAME ownership check as every other workspace write —
 * knowing a draft id is not authorisation for anything.
 *
 * Returns an edit token so the caller can jump straight into the live editor.
 */
app.post("/api/agent/claim", async (req, res, next) => {
  try {
    const draftId = String((req.body && req.body.draftId) || "");
    const wsId = String((req.body && req.body.wsId) || "");
    if (!/^dr_[A-Za-z0-9_-]{6,40}$/.test(draftId)) return res.status(400).json({ error: "bad draft id" });
    if (!wsId) return res.status(400).json({ error: "wsId is required" });

    const { decoded, masterDb } = await assertOwnsWorkspace(req, wsId);

    const draft = await loadDraft(draftId);
    if (!draft) return res.status(404).json({ error: "draft not found or expired" });

    // Re-validate on the way in. The draft was validated when it was built,
    // but it has been sitting in a database since — never trust stored state
    // that is about to become a published page.
    const verdict = validateSiteConfig(draft.config, { forAgent: true });
    if (!verdict.ok) return res.status(422).json({ error: "draft is no longer valid", issues: verdict.issues.slice(0, 5) });

    await masterDb.collection("workspaces").updateOne(
      { id: wsId },
      { $set: { storefrontConfig: verdict.config, storefrontEnabled: true } }
    );

    // one draft, one claim
    if (getMasterDb()) await masterDb.collection("agent_drafts").deleteOne({ id: draftId });
    draftMemory.delete(draftId);

    const ws = await resolveWsContext(wsId);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.storefront.claim",
      entity: "workspace", entityId: wsId,
      summary: "Agent draft " + draftId + " claimed as the live storefront"
    });

    const editToken = jwt.sign({ wsId: wsId, email: decoded.email, scope: "portal-edit" }, JWT_SECRET, { expiresIn: "15m" });
    res.json({ ok: true, wsId: wsId, editToken: editToken, expiresIn: 900, meta: draft.meta || null });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/* =================================================================
   PROJECTS — the durable object (docs/AGENT-PARITY-PLAN.md §1–3)
   -----------------------------------------------------------------
   A build used to be a throwaway draft. A project survives a reload,
   has a URL, remembers its conversation and keeps every version.
   Owned by an anonymous signed cookie first, by a user after claim.
   ================================================================= */
const projects = require("./lib/projects");
const anon = require("./lib/anon");
projects.init({ getMasterDb });
anon.init({ JWT_SECRET });

const projectLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: (req) => req.ip || "" });
// Micro-claim creates a real account — a tighter budget than the build
// endpoints, since abuse here means spamming workspace/user rows, not just CPU.
const microClaimLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: (req) => req.ip || "" });

/**
 * Run the whole pipeline for a prompt. Shared by create and follow-up, and by
 * both the plain-JSON and SSE response modes below.
 *
 * `onStage(id, state, detail)` is called at REAL boundaries in the actual
 * work — not on a timer. `state` is "start" or "done"; `detail` is only ever
 * present on "done" and is built from data that genuinely exists at that
 * point (see docs/AGENT-PARITY-PLAN.md §5 — a stage is done when it IS done,
 * so a fast pipeline shows a fast build instead of a manufactured 1.5s wait).
 * The default no-op keeps every existing caller — including both integration
 * test suites — behaving exactly as before.
 */
async function buildFromPrompt(prompt, opts, onStage) {
  const emit = onStage || function () {};
  const o = opts || {};
  const t0 = Date.now();

  emit("understand", "start", "Reading your prompt");
  const verdictNlu = classify(prompt);
  const slots = extract(prompt, verdictNlu.lang);

  if (!o.industry && !verdictNlu.certain) {
    emit("understand", "done", "not sure yet");
    return {
      needsAnswer: {
        question: "Which is closest to your business?",
        options: choices(verdictNlu).map((k) => ({ key: k, label: INDUSTRY_LABELS[k] || k }))
      },
      nlu: verdictNlu, ms: Date.now() - t0
    };
  }
  const industry = o.industry || verdictNlu.industry;
  emit("understand", "done", [INDUSTRY_LABELS[industry] || industry, slots.city, slots.tone !== "neutral" ? slots.tone : ""].filter(Boolean).join(" · "));

  emit("structure", "start", "Choosing your sections");
  const composed = composer.compose(prompt, {
    industry: industry, company: o.company || slots.company,
    city: slots.city, currency: slots.currency, colour: slots.colour,
    features: slots.features, tone: slots.tone, lang: slots.lang, mode: o.mode || ""
  });
  const verdict = validateSiteConfig(composed.config, { forAgent: true });
  emit("structure", "done", composed.meta.archetypeLabel || "");

  emit("write", "start", "Writing your pages");
  if (verdict.ok) {
    const pages = Object.keys(verdict.config.pages);
    const blocks = pages.reduce((n, s) => n + ((verdict.config.pages[s].blocks || []).length), 0);
    emit("write", "done", blocks + " sections across " + pages.length + " pages");
  } else {
    emit("write", "done", "");
  }

  return { composed: composed, verdict: verdict, nlu: verdictNlu, slots: slots, ms: Date.now() - t0 };
}

/* ---- SSE plumbing ----
   Native EventSource can only GET, and this endpoint needs a POST body, so
   the client reads a normal streamed fetch() response and parses SSE frames
   itself — the standard workaround for POST-triggered server-sent events.
   Negotiated by Accept, so the exact same route serves plain JSON to any
   client (including both test suites) that doesn't ask for a stream. */
function wantsStream(req) {
  return String(req.headers.accept || "").indexOf("text/event-stream") >= 0;
}
function sseOpen(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"        // nginx/proxies: don't buffer the stream
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}
function sseFrame(res, event, data) {
  res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

/**
 * POST /api/projects
 * Body: { prompt, mode?, industry? }
 * Creates the project AND its first revision. No auth — the anonymous
 * cookie is minted here and owns it until someone claims it.
 */
/** The side effects of a successful create: persisted once, used by both the
    plain-JSON and SSE response paths so they can never drift apart. */
async function finishCreate(built, prompt, owner) {
  const meta = built.composed.meta;
  const project = await projects.create({ title: meta.company, prompt: prompt, meta: meta, owner: owner });
  const revision = await projects.addRevision(project.id, built.verdict.config, "First build");
  await projects.addTurn(project.id, { role: "user", kind: "text", body: prompt });
  await projects.addTurn(project.id, {
    role: "agent", kind: "result", body: summarise(built.verdict.config, meta),
    revisionId: revision.id, ms: built.ms
  });
  await projects.ensureIndexes();
  return {
    projectId: project.id, slug: project.slug, title: project.title,
    config: built.verdict.config, meta: meta, revisionId: revision.id, ms: built.ms
  };
}

app.post("/api/projects", projectLimiter, async (req, res, next) => {
  const prompt = String((req.body && req.body.prompt) || "").trim();
  if (prompt.length < 3) return res.status(400).json({ error: "prompt is required" });
  if (prompt.length > 2000) return res.status(400).json({ error: "prompt is too long" });
  const owner = anon.ownerOf(req, res);
  const opts = { mode: req.body.mode, industry: req.body.industry };

  if (wantsStream(req)) {
    sseOpen(res);
    try {
      const built = await buildFromPrompt(prompt, opts, (id, state, detail) => sseFrame(res, "stage", { id, state, detail }));
      if (built.needsAnswer) {
        sseFrame(res, "needsAnswer", { needsAnswer: built.needsAnswer, lang: built.nlu.lang });
      } else if (!built.verdict.ok) {
        sseFrame(res, "error", { error: "could not build a site from that", issues: built.verdict.issues.slice(0, 5) });
      } else {
        sseFrame(res, "result", await finishCreate(built, prompt, owner));
      }
      sseFrame(res, "done", { ms: built.ms });
    } catch (e) {
      sseFrame(res, "error", { error: "build failed" });
      console.error("SSE /api/projects error:", e.message);
    }
    return res.end();
  }

  try {
    const built = await buildFromPrompt(prompt, opts);
    // Not confident enough to build something good — ask, don't guess. No
    // project is created for a question, so nothing half-made is left behind.
    if (built.needsAnswer) return res.json({ needsAnswer: built.needsAnswer, lang: built.nlu.lang });
    if (!built.verdict.ok) {
      console.error("project build failed validation:", built.verdict.issues.slice(0, 5));
      return res.status(502).json({ error: "could not build a site from that", issues: built.verdict.issues.slice(0, 5) });
    }
    res.status(201).json(await finishCreate(built, prompt, owner));
  } catch (e) {
    next(e);
  }
});

/** GET /api/projects — everything this owner has made.
    ?kind=code filters to Souqi Code projects only (for its own sidebar) —
    filtered here rather than in projects.js's query, so a mixed history
    (Sites + Code) still returns `limit` Code rows even if Sites projects
    are more numerous; fetching a wider page first is the cheap way to
    keep that true without a schema-level index change for one filter. */
app.get("/api/projects", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const kind = String(req.query.kind || "");
    const onlyFavorites = req.query.favorite === "1";
    const limit = Number(req.query.limit) || 30;
    const rows = await projects.list(owner, (kind || onlyFavorites) ? Math.max(limit * 3, 60) : limit);
    let filtered = kind ? rows.filter((p) => (p.meta || {}).kind === kind) : rows;
    if (onlyFavorites) filtered = filtered.filter((p) => !!p.favorite);
    res.json({
      projects: filtered.slice(0, limit).map((p) => ({
        id: p.id, slug: p.slug, title: p.title, prompt: p.prompt,
        industry: (p.meta || {}).industry, accent: (p.meta || {}).accent, kind: (p.meta || {}).kind || null,
        buildType: (p.meta || {}).buildType || null, published: !!p.published, favorite: !!p.favorite,
        claimed: !!p.wsId, updatedAt: p.updatedAt
      }))
    });
  } catch (e) { next(e); }
});

/** POST /api/codeagent/:key/favorite — Body: { favorite: true|false } */
app.post("/api/codeagent/:key/favorite", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    const favorite = !!(req.body && req.body.favorite);
    await projects.patch(project.id, { favorite });
    res.json({ ok: true, favorite });
  } catch (e) { next(e); }
});

/** GET /api/codeagent/usage — this owner's spend this month, for the
    Settings view (reuses the exact tracker the build-time cap already
    checks in POST /build, so the number shown always matches what's
    actually enforced). */
app.get("/api/codeagent/usage", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const spentUsd = await codeAgentUsage.monthSpend(owner);
    res.json({ spentUsd, budgetUsd: CODEAGENT_OWNER_MONTHLY_BUDGET_USD, freeEdits: CODEAGENT_FREE_EDITS, signedIn: !!codeAgentSessionUser(req) });
  } catch (e) { next(e); }
});

/** GET /api/codeagent/stats — a small dashboard: how many apps this owner
    has built, broken down by the type they picked at build time. */
app.get("/api/codeagent/stats", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const rows = (await projects.list(owner, 200)).filter((p) => (p.meta || {}).kind === "code");
    const byType = {};
    let published = 0;
    rows.forEach((p) => {
      const t = (p.meta || {}).buildType || "website";
      byType[t] = (byType[t] || 0) + 1;
      if (p.published) published += 1;
    });
    res.json({ total: rows.length, published, byType });
  } catch (e) { next(e); }
});

/** GET /api/projects/:idOrSlug — the project, its transcript and head config. */
app.get("/api/projects/:key", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const [turns, revision, revisions] = await Promise.all([
      projects.listTurns(project.id),
      projects.head(project.id),
      projects.listRevisions(project.id)
    ]);

    res.json({
      project: {
        id: project.id, slug: project.slug, title: project.title, prompt: project.prompt,
        meta: project.meta, claimed: !!project.wsId, wsId: project.wsId,
        publishedRevisionId: project.publishedRevisionId || null,
        createdAt: project.createdAt, updatedAt: project.updatedAt
      },
      turns: turns,
      config: revision ? revision.config : null,
      revisionId: revision ? revision.id : null,
      revisions: revisions
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/projects/:key/turns
 * Body: { message, industry? }
 * A follow-up. First tries to PATCH the head revision in place — the six ops
 * in refine/grammar.js + refine/apply.js (docs/AGENT-PARITY-PLAN.md §4) — so
 * "make it darker" doesn't throw away three turns of other changes. Only
 * when nothing in that closed vocabulary matches does it fall back to a full
 * rebuild from the combined description, same as before. Either way the
 * result is a new revision through the SAME validator; nothing bypasses it.
 */
const refineGrammar = require("./lib/refine/grammar");
const { applyOps } = require("./lib/refine/apply");

/** The side effects of a successful rebuild-style follow-up. */
async function finishFollowUp(built, project, message, combined) {
  const meta = built.composed.meta;
  const revision = await projects.addRevision(project.id, built.verdict.config, message.slice(0, 60));
  const body = summarise(built.verdict.config, meta);
  await projects.addTurn(project.id, { role: "agent", kind: "result", body: body, revisionId: revision.id, ms: built.ms });
  // the prompt grows, so the next follow-up still knows everything so far
  await projects.patch(project.id, { prompt: combined.slice(0, 2000), meta: meta, title: meta.company });
  return { kind: "rebuild", config: built.verdict.config, meta: meta, revisionId: revision.id, body: body, ms: built.ms };
}

/**
 * Try to satisfy `message` as a patch against the CURRENT head revision.
 *   undefined → no rule matched; caller should fall back to a full rebuild
 *   {noop:true, reason} → recognised the intent, there was nothing to change
 *   {kind:"patch", …} → applied, validated, stored as a new revision
 */
async function attemptPatch(project, message, onStage) {
  const emit = onStage || function () {};
  const t0 = Date.now();
  emit("understand", "start", "Reading your message");

  const head = await projects.head(project.id);
  if (!head) { emit("understand", "done", "no revision to patch yet"); return undefined; }

  const parsed = refineGrammar.parse(message, head.config, project.meta || {});
  if (!parsed) { emit("understand", "done", "no direct match"); return undefined; }
  emit("understand", "done", parsed.noop ? "nothing to change" : parsed.summary);
  if (parsed.noop) return { noop: true, reason: parsed.reason };

  emit("apply", "start", "Making the change");
  const applied = applyOps(head.config, parsed.ops);
  if (!applied.changed) { emit("apply", "done", "no effect"); return { noop: true, reason: "That didn't change anything." }; }

  const verdict = validateSiteConfig(applied.config, { forAgent: true });
  if (!verdict.ok) { emit("apply", "done", "failed"); return { error: "could not apply that", issues: verdict.issues.slice(0, 5) }; }
  emit("apply", "done", parsed.summary);

  const revision = await projects.addRevision(project.id, verdict.config, parsed.summary.slice(0, 60));
  const body = "Done — " + parsed.summary + ".";
  const ms = Date.now() - t0;
  await projects.addTurn(project.id, { role: "agent", kind: "result", body: body, revisionId: revision.id, ms: ms });
  await projects.patch(project.id, {});   // bump updatedAt only — meta/title are unchanged by a patch
  return { kind: "patch", config: verdict.config, meta: project.meta, revisionId: revision.id, body: body, ms: ms };
}

app.post("/api/projects/:key/turns", projectLimiter, async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const message = String((req.body && req.body.message) || "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });
    if (message.length > 2000) return res.status(400).json({ error: "message is too long" });

    await projects.addTurn(project.id, { role: "user", kind: "text", body: message });
    const combined = (project.prompt ? project.prompt + ". " : "") + message;
    const opts = { industry: req.body.industry };

    if (wantsStream(req)) {
      sseOpen(res);
      try {
        const onStage = (id, state, detail) => sseFrame(res, "stage", { id, state, detail });
        const patch = await attemptPatch(project, message, onStage);
        let ms = 0;

        if (patch && patch.error) {
          sseFrame(res, "error", { error: patch.error, issues: patch.issues });
        } else if (patch && patch.noop) {
          await projects.addTurn(project.id, { role: "agent", kind: "text", body: patch.reason });
          sseFrame(res, "noop", { reason: patch.reason });
        } else if (patch) {
          ms = patch.ms;
          sseFrame(res, "result", patch);
        } else {
          const built = await buildFromPrompt(combined, opts, onStage);
          ms = built.ms;
          if (built.needsAnswer) {
            await projects.addTurn(project.id, { role: "agent", kind: "question", body: built.needsAnswer.question });
            sseFrame(res, "needsAnswer", { needsAnswer: built.needsAnswer });
          } else if (!built.verdict.ok) {
            sseFrame(res, "error", { error: "could not apply that", issues: built.verdict.issues.slice(0, 5) });
          } else {
            sseFrame(res, "result", await finishFollowUp(built, project, message, combined));
          }
        }
        sseFrame(res, "done", { ms: ms });
      } catch (e) {
        sseFrame(res, "error", { error: "build failed" });
        console.error("SSE /turns error:", e.message);
      }
      return res.end();
    }

    const patch = await attemptPatch(project, message);
    if (patch && patch.error) return res.status(502).json(patch);
    if (patch && patch.noop) {
      await projects.addTurn(project.id, { role: "agent", kind: "text", body: patch.reason });
      return res.json({ noop: true, reason: patch.reason });
    }
    if (patch) return res.json(patch);

    const built = await buildFromPrompt(combined, opts);
    if (built.needsAnswer) {
      await projects.addTurn(project.id, { role: "agent", kind: "question", body: built.needsAnswer.question });
      return res.json({ needsAnswer: built.needsAnswer });
    }
    if (!built.verdict.ok) return res.status(502).json({ error: "could not apply that", issues: built.verdict.issues.slice(0, 5) });
    res.json(await finishFollowUp(built, project, message, combined));
  } catch (e) { next(e); }
});

/**
 * GET /api/projects/:key/preview
 * The head revision, in the EXACT shape /api/portal/:wsId/config returns —
 * so public/portal.html can render an unclaimed project through the same
 * renderer (generic-renderer.js) the published storefront runs, with no
 * separate preview code path to keep in sync (docs/AGENT-PARITY-PLAN.md §6).
 * Owner-only: a draft isn't published, so it isn't public like a real portal.
 */
app.get("/api/projects/:key/preview", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const revision = await projects.head(project.id);
    if (!revision) return res.status(404).json({ error: "nothing built yet" });

    res.json({
      id: project.id,
      company: project.title,
      industry: (project.meta || {}).industry || "retail",
      logo: null,
      storefrontEnabled: true,
      storefrontConfig: revision.config
    });
  } catch (e) { next(e); }
});

/** POST /api/projects/:key/restore — go back to a revision, without losing it. */
app.post("/api/projects/:key/restore", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const target = await projects.getRevision(String((req.body && req.body.revisionId) || ""));
    if (!target || target.projectId !== project.id) return res.status(404).json({ error: "revision not found" });

    // Restoring APPENDS a revision rather than rewinding, so the thing you
    // undid is still there if you change your mind again.
    const verdict = validateSiteConfig(target.config, { forAgent: true });
    if (!verdict.ok) return res.status(422).json({ error: "that revision is no longer valid" });

    // Name it after what it restored TO, not the internal revision id — "Restored
    // rv_wvkNLnLa2pU" means nothing to the person looking at their own history.
    const revision = await projects.addRevision(project.id, verdict.config, "Restored: " + (target.label || "an earlier version"));
    await projects.addTurn(project.id, {
      role: "agent", kind: "result", body: "Restored an earlier version.", revisionId: revision.id
    });
    res.json({ config: verdict.config, revisionId: revision.id });
  } catch (e) { next(e); }
});

/** DELETE /api/projects/:key */
app.delete("/api/projects/:key", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    await projects.remove(project.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Accept either a project id or a slug in the URL. */
async function resolveProject(key, owner) {
  const k = String(key || "");
  if (/^pr_[A-Za-z0-9_-]{6,40}$/.test(k)) return projects.get(k);
  return projects.findBySlug(k.toLowerCase(), owner);
}

/** One sentence about what was built, from the config itself. */
function summarise(config, meta) {
  const pages = Object.keys(config.pages || {});
  const blocks = pages.reduce((n, s) => n + ((config.pages[s].blocks || []).length), 0);
  return blocks + " sections across " + pages.length + " page" + (pages.length === 1 ? "" : "s") +
    (meta && meta.industry ? " for a " + meta.industry + " business" : "") + ".";
}

/**
 * The write side of "publish": push ONE revision's config into the
 * workspace's live storefrontConfig. Pure — no ownership changes, no
 * project.patch, no audit — because claim-time publishing and every publish
 * after it need this same write but each layers different bookkeeping on
 * top (see finalizeClaim and POST /publish below). This is what fixes
 * docs/AGENT-GAP-AUDIT.md §1.3: it's the ONE place a project's head
 * revision becomes the live site, called explicitly, not implicitly on
 * every agent turn.
 */
async function publishRevisionToWorkspace({ revision, wsId, masterDb }) {
  // Re-validate on the way in — a revision was validated when it was
  // written, but it has been sitting in a database since.
  const verdict = validateSiteConfig(revision.config, { forAgent: true });
  if (!verdict.ok) {
    const e = new Error("this version is no longer valid");
    e.status = 422; e.issues = verdict.issues.slice(0, 5);
    throw e;
  }
  await masterDb.collection("workspaces").updateOne(
    { id: wsId },
    { $set: { storefrontConfig: verdict.config, storefrontEnabled: true } }
  );
  return verdict;
}

/**
 * The rest of a claim: re-point project ownership to the user and mint an
 * edit token. Shared by the pre-authenticated /claim route and the one-shot
 * micro-claim route below, so "what a claim actually does" only exists in
 * one place. Claiming publishes the head revision as a side effect — that
 * first publish is what makes "claim this site" mean something immediately
 * — but every publish AFTER this one goes through POST /publish instead.
 */
async function finalizeClaim({ project, wsId, userId, email, masterDb, requestId }) {
  const revision = await projects.head(project.id);
  if (!revision) { const e = new Error("project has no build yet"); e.status = 422; throw e; }

  await publishRevisionToWorkspace({ revision, wsId, masterDb });
  await projects.patch(project.id, {
    wsId: wsId, ownerUserId: userId, ownerAnonId: project.ownerAnonId, expiresAt: null,
    publishedRevisionId: revision.id
  });

  const ws = await resolveWsContext(wsId);
  await writeAudit(dbAdapter, ws, {
    requestId: requestId, actor: email, action: "workspace.storefront.claim",
    entity: "workspace", entityId: wsId,
    summary: "Project " + project.id + " (" + project.slug + ") claimed as the live storefront"
  });

  return jwt.sign({ wsId: wsId, email: email, scope: "portal-edit" }, JWT_SECRET, { expiresIn: "15m" });
}

/**
 * POST /api/projects/:key/claim
 * Body: { wsId }   Header: Authorization: Bearer <owner JWT>
 *
 * Turns a project into the workspace's live storefront and moves ownership
 * from the anonymous cookie to the signed-in user — the same row, re-pointed,
 * so nothing is copied and nothing is lost. The anonymous cookie on THIS
 * request must match the project's anonymous owner: knowing a project's slug
 * or id is not authorisation for anything, same as the workspace check below.
 */
app.post("/api/projects/:key/claim", async (req, res, next) => {
  try {
    const wsId = String((req.body && req.body.wsId) || "");
    if (!wsId) return res.status(400).json({ error: "wsId is required" });

    const { decoded, masterDb } = await assertOwnsWorkspace(req, wsId);
    const owner = anon.ownerOf(req, res);

    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });

    const alreadyClaimedByMe = project.ownerUserId && project.ownerUserId === decoded.id;
    const claimableByAnon = !project.ownerUserId && project.ownerAnonId && project.ownerAnonId === owner.anonId;
    if (!alreadyClaimedByMe && !claimableByAnon) {
      return res.status(403).json({ error: "not your project" });
    }
    if (project.wsId && project.wsId !== wsId) {
      return res.status(409).json({ error: "this project is already attached to a different workspace" });
    }

    const editToken = await finalizeClaim({ project, wsId, userId: decoded.id, email: decoded.email, masterDb, requestId: req.id });
    res.json({ ok: true, wsId: wsId, editToken: editToken, expiresIn: 900, meta: project.meta || null });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, issues: e.issues });
    next(e);
  }
});

/**
 * POST /api/projects/:key/publish
 * Header: Authorization: Bearer <owner JWT>
 *
 * Pushes the project's CURRENT head revision live. Claiming already
 * publishes once as a side effect (finalizeClaim) — this is every publish
 * after that. Deliberately its own step rather than automatic on every
 * agent turn: docs/AGENT-GAP-AUDIT.md §1.3 is what happens when a project's
 * revisions and a workspace's storefrontConfig are allowed to drift with no
 * one ever telling the owner they've diverged. This endpoint is the one
 * place that reconciles them, and only when asked to.
 */
app.post("/api/projects/:key/publish", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (!project.wsId) return res.status(400).json({ error: "this project has not been claimed yet — nothing to publish to" });

    const { decoded, masterDb } = await assertOwnsWorkspace(req, project.wsId);
    const revision = await projects.head(project.id);
    if (!revision) return res.status(422).json({ error: "project has no build yet" });

    if (project.publishedRevisionId === revision.id) {
      return res.json({ ok: true, alreadyPublished: true, publishedRevisionId: revision.id });
    }

    await publishRevisionToWorkspace({ revision, wsId: project.wsId, masterDb });
    await projects.patch(project.id, { publishedRevisionId: revision.id });

    const ws = await resolveWsContext(project.wsId);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.storefront.publish",
      entity: "workspace", entityId: project.wsId,
      summary: "Project " + project.id + " (" + project.slug + ") published revision " + revision.id
    });

    res.json({ ok: true, publishedRevisionId: revision.id });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, issues: e.issues });
    next(e);
  }
});

/**
 * POST /api/projects/:key/micro-claim
 * Body: { email, password, company?, industry?, country? }
 *
 * The "own it in ten seconds" path (docs/AGENT-PARITY-PLAN.md §7): two
 * fields instead of the full twelve-field signup, because everything else
 * a workspace needs is already known — the agent extracted the industry
 * and company name while building, and the database defaults to local
 * until the owner says otherwise from the console.
 *
 * Order of operations matters: create the account, then the workspace,
 * then claim, then let the caller redirect. A failure at any step leaves
 * the project exactly as it was — nothing here can lose the work someone
 * just watched being made, it can only fail to attach it yet.
 */
app.post("/api/projects/:key/micro-claim", microClaimLimiter, validateBody(microClaimSchema), async (req, res, next) => {
  try {
    const { email, password, company, industry, country } = req.valid;
    const emailLower = email.toLowerCase();

    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (project.wsId) return res.status(409).json({ error: "this project is already claimed" });

    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });

    const existingWs = await masterDb.collection("workspaces").findOne({ ownerEmail: emailLower });
    if (existingWs) {
      return res.status(409).json({ error: "an account with this email already exists — sign in and claim from there instead" });
    }

    const meta = project.meta || {};
    const wsId = "ws_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    const companyName = String(company || meta.company || project.title || "My Business").slice(0, 120);

    await masterDb.collection("workspaces").insertOne({
      id: wsId,
      company: companyName,
      industry: String(industry || meta.industry || "retail"),
      country: String(country || "TR"),
      ownerEmail: emailLower,
      dbType: "local",
      dbUri: "",
      logo: null,
      tagline: "",
      storefrontEnabled: false,
      plan: "free",
      createdAt: new Date().toISOString()
    });

    const ownerUser = {
      id: "usr_" + crypto.randomBytes(8).toString("base64url"),
      name: emailLower.split("@")[0],
      email: emailLower,
      password: password,              // insertOne() bcrypt-hashes "users" passwords automatically
      role: "Owner", dept: "Management", active: true,
      joined: new Date().toISOString().slice(0, 10)
    };
    const ws = await resolveWsContext(wsId);
    await dbAdapter.insertOne(ws, "users", ownerUser);

    let editToken;
    try {
      editToken = await finalizeClaim({ project, wsId, userId: ownerUser.id, email: emailLower, masterDb, requestId: req.id });
    } catch (claimErr) {
      // Account + workspace exist; the project just isn't attached yet. Say
      // so plainly rather than losing either half of what already happened.
      const status = claimErr.status || 500;
      const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, role: "Owner", dept: "Management", wsId: wsId };
      const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
      return res.status(status).json({
        ok: false, accountCreated: true, wsId: wsId, token: token, user: session,
        error: "your account and workspace were created, but this build could not be attached: " + claimErr.message
      });
    }

    const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, role: "Owner", dept: "Management", wsId: wsId };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.json({ ok: true, wsId: wsId, token: token, user: session, editToken: editToken, expiresIn: 900, meta: project.meta || null });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/* =================================================================
   SOUQI CODE — the code-generating agent (docs/CODE-AGENT-PLAN.md)
   -----------------------------------------------------------------
   A different product line from the site builder above it: this one
   writes real files and runs them in an isolated Daytona sandbox,
   not a storefront config — but it durably persists through the SAME
   `projects.js` object the site builder uses (one `projects` Mongo
   collection, both product lines, differentiated only by
   `meta.kind === "code"`), so it inherits the same owner-scoped
   security model for free: `projects.owns()` gates every read and
   write here exactly as it does for the site builder.

   Two lifetimes, deliberately not conflated:
     - `codeBuilds` (in-memory) tracks a LIVE sandbox for the life of
       this server process — what makes a follow-up fast (reuse, no
       reinstall).
     - `projects` (Mongo) durably stores full file contents per
       revision — what makes a build survive a reload or a server
       restart. If the sandbox is gone but the project isn't, a
       follow-up (or just reopening the page) re-creates a sandbox and
       re-materializes the last known files onto it before doing
       anything new — "resume", not "start over".
   Git commits inside the sandbox (Phase 7's literal ask) are a THIRD,
   shorter-lived layer on top of the first — checkpoints for undo
   within a still-alive session; they die with the sandbox exactly
   like everything else in it, which is why they are not the
   durability mechanism on their own.
   ================================================================= */
const codeAgentRuntimeReg = require("./lib/codeagent/runtime");
const daytonaRuntimeModule = require("./lib/codeagent/runtimes/daytona-runtime"); // registers "daytona"
const { makeTools: makeCodeAgentTools } = require("./lib/codeagent/tools");
const { proposeWithRepair, proposeWithClientBuild, assessPrompt } = require("./lib/codeagent/model-loop");
const codeAgentUsage = require("./lib/codeagent/usage");
codeAgentUsage.init({ getMasterDb });

// A per-instance CACHE of live sandbox handles, not the source of truth.
// It used to be the source of truth, which made every follow-up edit and
// every preview request depend on landing back on the same Node process
// that ran the original build — fine for one long-lived server, fatal on
// serverless (Vercel), where instances are created and discarded freely.
// The durable record is `sandboxId` on each revision (persisted since the
// first build); codeAgentLive() below rebuilds a handle from that when
// this instance has never seen the project. Keeping the cache avoids a
// Daytona API round-trip on the warm path.
const codeBuilds = new Map(); // projectId -> { ws, runtime, tools, createdAt }

/**
 * Resolves a project's LIVE sandbox on any instance, in three steps:
 *   1. this instance's cache (warm path, no network),
 *   2. otherwise re-attach by the sandboxId persisted on the head revision,
 *   3. and in both cases prove it's actually reachable before returning it.
 *
 * Returns null when there is no reachable sandbox — callers already handle
 * that (build resumes from persisted files, preview reports "not running").
 * Health-checking matters as much as the lookup: Daytona's autoStopInterval
 * can reap a sandbox with nothing notifying this process, and a stale handle
 * fails later and less clearly than a null does here.
 */
async function codeAgentLive(project) {
  if (!project) return null;

  const cached = codeBuilds.get(project.id);
  if (cached) {
    try {
      const health = await cached.runtime.run(cached.ws, ["echo", "ok"], 5000);
      if (health.code === 0) return cached;
    } catch (e) { /* fall through to re-attach */ }
    codeBuilds.delete(project.id);
  }

  const head = await projects.head(project.id);
  const sandboxId = head && head.config && head.config.sandboxId;
  if (!sandboxId) return null;

  const runtime = codeAgentRuntimeReg.createRuntime("daytona");
  if (typeof runtime.attach !== "function") return null;
  const ws = await runtime.attach(sandboxId);
  if (!ws) return null;

  try {
    const health = await runtime.run(ws, ["echo", "ok"], 5000);
    if (health.code !== 0) return null;
  } catch (e) { return null; }

  const live = { ws, runtime, tools: makeCodeAgentTools(runtime, ws), createdAt: Date.now() };
  codeBuilds.set(project.id, live);
  return live;
}
const codeAgentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => req.ip || "" });

// WebContainers flow: the SSE handler proposes files and waits for the client
// to build them in the browser. This map holds pending promises keyed by a
// unique buildId — the build-feedback endpoint resolves them.
const pendingBuildResults = new Map(); // buildId -> { resolve, timer }

// The platform-wide AI_MONTHLY_BUDGET_USD (lib/ai/client.js) stops total
// spend across BOTH product lines from running away — but it's a shared
// pool, and that guard alone doesn't stop one visitor from spending all of
// it before anyone else gets a turn. This caps spend per OWNER instead,
// independently of that shared ceiling. 0 disables the check (useful for
// local dev, matching AI_MONTHLY_BUDGET_USD's own "0 = off" convention).
const CODEAGENT_OWNER_MONTHLY_BUDGET_USD = Number(process.env.CODEAGENT_OWNER_MONTHLY_BUDGET_USD || 1);

// First build is always free and anonymous (matches the rest of the funnel
// — no signup wall before someone has seen anything real). Editing it is
// where the product asks for something: sign in for the first few free
// edits, then a paid plan to keep going. Both gates apply ONLY to
// follow-ups, never the first message.
const CODEAGENT_FREE_EDITS = Number(process.env.CODEAGENT_FREE_EDITS || 3);

/** Reads the sq_session cookie directly, scoped to this file rather than
    anon.js's shared userOf() — that one is Authorization-header-only on
    purpose (project-test.js's claim/publish security model depends on a
    stray session cookie NOT counting as ownership proof). Code's own
    sign-in gate below needs the opposite: recognize a visitor who's
    logged in through the site's normal cookie-based flow, since code.html
    has no reason to duplicate Bearer-token plumbing the rest of the site
    doesn't use either. Used ONLY for the gate check, never for project
    ownership — codeBuilds/projects.owns() keep working exactly as before. */
function codeAgentSessionUser(req) {
  const raw = req.headers.cookie || "";
  const m = /(?:^|;\s*)sq_session=([^;]*)/.exec(raw);
  if (!m) return null;
  try {
    const decoded = jwt.verify(decodeURIComponent(m[1]), JWT_SECRET);
    return decoded && decoded.id ? decoded : null;
  } catch (e) { return null; }
}

/**
 * The async half of session verification: everything codeAgentSessionUser
 * can decide from the token alone, PLUS the one thing it can't — whether
 * the token has been revoked since it was signed.
 *
 * POST /api/account/sessions/revoke bumps a per-user `sessionEpoch`; a
 * token minted before that bump carries a stale value and must stop
 * working, which is the entire mechanism by which "sign out other
 * sessions" means anything for stateless JWTs. Kept separate from the
 * sync version deliberately: this costs a DB read, so only the routes
 * where revocation actually matters (settings, account deletion) pay for
 * it, while the hot build path keeps its cheap synchronous check.
 */
async function codeAgentSessionUserVerified(req) {
  const decoded = codeAgentSessionUser(req);
  if (!decoded) return null;
  try {
    const ws = await resolveWsContext(decoded.wsId);
    const users = await dbAdapter.findAll(ws, "users");
    const user = users.find((u) => u.id === decoded.id);
    if (!user || user.active === false) return null;
    // Absent on both sides = never revoked; that's a match, not a mismatch.
    if ((user.sessionEpoch || 0) !== (decoded.sessionEpoch || 0)) return null;
    return decoded;
  } catch (e) {
    return null; // can't prove the token is still valid -> treat as signed out
  }
}

/** Only the truly-degenerate case (empty, or a couple of stray characters)
    is worth rejecting for free — genuine vagueness ("hello", "build me
    something cool") now gets a REAL clarifying question from
    assessPrompt() instead of a canned message, which is strictly better
    and is what this gate used to stand in for before that existed. */
function promptTooVague(prompt) {
  return prompt.length < 3;
}

// Whole-message match only, deliberately — "thanks for the great header but
// also make the button blue" is a real change request that happens to
// start with a pleasantry, and must NOT get caught here.
const CODEAGENT_CHITCHAT_RE = /^(thanks?( you)?|thx|ty|cool|nice|great|awesome|perfect|good( job| one)?|ok(ay)?|sounds good|lol+|ha+h?a*|nvm|never ?mind|no(pe)?|yes|yep|yup|k|👍|🙏|❤️?)[\s.!?]*$/i;
function isCodeAgentChitChat(message) {
  return CODEAGENT_CHITCHAT_RE.test(message.trim());
}
const CODEAGENT_CHITCHAT_REPLIES = [
  "Glad it's working! Tell me what to change whenever you're ready.",
  "You're welcome — happy to keep going whenever you have another change.",
  "Anytime! Just say the word if you want to tweak anything."
];
function codeAgentChitChatReply() {
  return CODEAGENT_CHITCHAT_REPLIES[Math.floor(Math.random() * CODEAGENT_CHITCHAT_REPLIES.length)];
}

/** One line for the transcript — what actually happened, not a template. */
function summariseCodeBuild(fileCount, repaired, rounds) {
  return fileCount + (fileCount === 1 ? " file" : " files") + " written" +
    (repaired ? ", after fixing a build error (" + rounds + " tries)" : "") + ".";
}

/** A safe, short git commit message from a free-text prompt — same escaping
    concern as anywhere else user text reaches a shell-adjacent argument. */
function gitSafeMessage(label) {
  return label.slice(0, 72).replace(/["\\\n]/g, " ").trim() || "Update";
}

/** code.html's type-picker (Website/Web App/Dashboard/Mobile) — kept
    server-side rather than baked into the client's prompt string
    deliberately: `projects.create()` derives the project's title AND
    slug from the raw prompt (`prompt.slice(0, 60)`), and a client-side
    prefix like "Build this as a dashboard-style app…" landed IN that
    slice, ahead of anything the user actually typed — found live, a
    build of "a sales tracker" got the title "Build this as a
    dashboard-style app with stat tiles, a chart" and a matching
    unreadable URL. Applying the hint here, after the raw prompt is
    already captured for storage, keeps the model instruction and the
    human-facing title/slug from fighting over the same 60 characters.
    Every option still produces the same one stack (React/Vite) — this
    only ever changes what gets ASKED FOR, never what gets built. */
const CODEAGENT_TYPE_HINT = {
  webapp: " Build it as an interactive web app (meaningful state, more than one view or section as needed), not a static marketing page.",
  dashboard: " Build it as a dashboard-style app with stat tiles, a chart or table, and realistic example data.",
  portfolio: " Build it as a personal portfolio site with a projects/work grid, short case-study blurbs, and an about section.",
  mobile: " Build it as a mobile-optimized, single-column, touch-friendly layout that feels great on a phone screen.",
  // Honest extensions of the same idea as the four above: every one of
  // these still only ever produces the same React/Vite web app
  // (docs/CODE-AGENT-PLAN.md §1) — just steered toward a different shape
  // of ONE, same as "mobile" biases a layout without promising a native
  // app. Deliberately NOT Replit's full type list: several of theirs
  // (3D Game, Spreadsheet, Slides, Document) are genuinely different
  // output formats their agent builds differently, which this one does
  // not — offering them as selectable options here would promise a
  // capability that doesn't exist behind it.
  landing: " Build it as a single-page marketing landing page: a hero, a few feature/benefit sections, and a clear call to action — not a multi-page app.",
  blog: " Build it as a blog: a post list/index and an individual post view, with realistic example posts, not lorem ipsum.",
  ecommerce: " Build it as a storefront: a product grid, a product detail view, and a cart — with realistic example products, not a payment integration."
};

// docs/pricing.html: Free has no total-app cap (each app gets its own
// CODEAGENT_FREE_EDITS before hitting the subscribe gate, unbounded in
// count) — only Pro and Max cap how many apps you can have at once.
// Checked once, at fresh-build time, so it costs nothing to enforce.
const CODEAGENT_PLAN_APP_LIMITS = { pro: 1, max: 5 };

// data:image/<type>;base64,<data> -> ["png","jpeg","svg+xml","webp"] plus
// the actual payload. Anything else (a non-image mime, no base64 marker,
// malformed) is rejected rather than guessed at.
const LOGO_MIME_RE = /^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,([a-z0-9+/=]+)$/i;
const LOGO_EXT = { png: "png", jpeg: "jpg", jpg: "jpg", "svg+xml": "svg", webp: "webp" };

/**
 * Writes an uploaded logo into a FRESH sandbox before the model's first
 * turn, and returns the sentence to append to its prompt — or "" if there
 * was nothing valid to attach. Called only for !project (a follow-up has
 * no fresh sandbox to seed and no reason to re-attach an asset that's
 * already sitting in the project's files from the first build).
 *
 * The write goes through runtime.writeBinaryFile DIRECTLY, not through
 * tools.write_file — that one asserts a string and treats it as utf8,
 * which would corrupt binary image bytes. Same "server writes raw bytes,
 * the model's own tool surface never does" boundary as readDist.
 */
async function attachLogoIfPresent(req, tools, runtime, ws) {
  const logo = req.body && req.body.logo;
  if (!logo || typeof logo.dataUrl !== "string") return "";

  const m = LOGO_MIME_RE.exec(logo.dataUrl);
  if (!m) return "";

  const base64 = m[2];
  // Decoded size, not the base64 string's length (~33% larger) — matches
  // what actually lands on disk and what the client-side 2MB check means.
  if (Buffer.byteLength(base64, "base64") > 3 * 1024 * 1024) return "";

  const ext = LOGO_EXT[m[1].toLowerCase()] || "png";
  const relPath = "src/assets/logo." + ext;
  if (typeof runtime.writeBinaryFile !== "function") return "";

  try {
    await runtime.writeBinaryFile(ws, relPath, base64);
  } catch (e) {
    return ""; // a failed upload isn't worth failing the whole build over
  }

  return " An image has already been uploaded and saved at " + relPath +
    " — import and use it as the site's logo/brand mark (e.g. in the header) instead of inventing a placeholder.";
}

/* -----------------------------------------------------------------
   Account endpoints backing public/settings.html.
   Every one of these is session-gated via codeAgentSessionUser(): a
   settings page that let an anonymous cookie read a plan or delete an
   account would be a much worse bug than the pages it configures.
   ----------------------------------------------------------------- */

/** GET /api/account/me — who is signed in, and on what plan. */
app.get("/api/account/me", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.json({ signedIn: false });

    let plan = "free", company = "";
    const masterDb = getMasterDb();
    if (masterDb && sessionUser.wsId) {
      const ws = await masterDb.collection("workspaces").findOne({ id: sessionUser.wsId }, { projection: { plan: 1, company: 1 } });
      if (ws) { plan = ws.plan || "free"; company = ws.company || ""; }
    }

    const owner = anon.ownerOf(req, res);
    const spentUsd = await codeAgentUsage.monthSpend(owner);
    res.json({
      signedIn: true, email: sessionUser.email, name: sessionUser.name,
      wsId: sessionUser.wsId, accountId: sessionUser.id, company: company,
      plan: plan, spentUsd: spentUsd, budgetUsd: CODEAGENT_OWNER_MONTHLY_BUDGET_USD,
      freeEdits: CODEAGENT_FREE_EDITS
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/account/sessions/revoke — "sign out other sessions".
 *
 * Sessions here are stateless JWTs, so there is no session table to delete
 * rows from; the only honest way to invalidate tokens already issued is to
 * make them fail verification. Bumping a per-user `sessionEpoch` and
 * checking it at verify time does that: every token minted before the bump
 * carries a stale epoch and is rejected, while THIS request gets a freshly
 * minted cookie so the caller stays signed in — which is exactly the
 * "other sessions" semantics.
 */
app.post("/api/account/sessions/revoke", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });

    const ws = await resolveWsContext(sessionUser.wsId);
    const epoch = Date.now();
    const updated = await dbAdapter.updateOne(ws, "users", sessionUser.id, { sessionEpoch: epoch });
    if (!updated) return res.status(404).json({ error: "account not found" });

    const session = {
      id: sessionUser.id, name: sessionUser.name, email: sessionUser.email,
      role: sessionUser.role, dept: sessionUser.dept, wsId: sessionUser.wsId, sessionEpoch: epoch
    };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.cookie("sq_session", token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000, path: "/"
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * DELETE /api/account — the Danger Zone.
 * Deletes the user's projects (with their turns and revisions), the user
 * record, and the workspace, then clears the cookie. Requires the account's
 * own password in the body: a destructive, irreversible action gated only
 * by an existing cookie is one stolen laptop away from being permanent.
 */
app.delete("/api/account", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const password = String((req.body && req.body.password) || "");
    if (!password) return res.status(400).json({ error: "your password is required to delete this account" });

    const ws = await resolveWsContext(sessionUser.wsId);
    const users = await dbAdapter.findAll(ws, "users");
    const user = users.find((u) => u.id === sessionUser.id);
    if (!user) return res.status(404).json({ error: "account not found" });

    const stored = String(user.password || "");
    const ok = stored.startsWith("$2") ? await bcrypt.compare(password, stored) : false;
    if (!ok) return res.status(401).json({ error: "that password doesn't match" });

    const owner = anon.ownerOf(req, res);
    for (const p of await projects.list(owner, 500)) await projects.remove(p.id);

    await dbAdapter.deleteOne(ws, "users", sessionUser.id);
    const masterDb = getMasterDb();
    if (masterDb && sessionUser.wsId) await masterDb.collection("workspaces").deleteOne({ id: sessionUser.wsId });

    res.clearCookie("sq_session", { path: "/" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** DELETE /api/codeagent/history — clears this owner's builds. Scoped by
    projects.list(owner), so it can only ever reach the caller's own rows. */
app.delete("/api/codeagent/history", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const owner = anon.ownerOf(req, res);
    const mine = (await projects.list(owner, 500)).filter((p) => (p.meta || {}).kind === "code");
    for (const p of mine) await projects.remove(p.id);
    res.json({ ok: true, deleted: mine.length });
  } catch (e) { next(e); }
});

/** Code's version of finalizeClaim (line ~1620) — re-points project
    ownership from the anonymous cookie to a real account, same idea as
    Sites' claim, but skips the Sites-only "publish this as the
    workspace's live storefront" step: a Code project has no
    storefrontConfig, it's a sandboxed app with its own preview/publish
    path, so claiming it just means it stops being anonymous. */
async function finalizeCodeClaim({ project, wsId, userId, email, requestId }) {
  await projects.patch(project.id, { wsId: wsId, ownerUserId: userId, ownerAnonId: project.ownerAnonId });
  const ws = await resolveWsContext(wsId);
  await writeAudit(dbAdapter, ws, {
    requestId: requestId, actor: email, action: "workspace.codeagent.claim",
    entity: "workspace", entityId: wsId,
    summary: "Code project " + project.id + " (" + project.slug + ") claimed"
  });
}

/**
 * POST /api/codeagent/:key/micro-claim
 * Body: { email, password }
 *
 * The account-creation step behind code.html's "sign up to see your app"
 * preview gate: two fields, because a Code visitor has already SEEN their
 * build work — they just need an account to keep it, not a full signup
 * form. Mirrors /api/projects/:key/micro-claim (the Sites equivalent, same
 * schema and rate limiter) but claims through finalizeCodeClaim instead of
 * finalizeClaim, and — unlike Sites, which only mints a short-lived
 * portal-edit token — sets the same httpOnly sq_session cookie /auth/login
 * does, since code.html's own gates (POST /build's edit gate above,
 * codeAgentSessionUser) read sign-in state from that cookie, not a Bearer
 * token.
 */
app.post("/api/codeagent/:key/micro-claim", microClaimLimiter, validateBody(microClaimSchema), async (req, res, next) => {
  try {
    const { email, password, country } = req.valid;
    const emailLower = email.toLowerCase();

    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (project.wsId) return res.status(409).json({ error: "this project is already claimed" });

    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });

    const existingWs = await masterDb.collection("workspaces").findOne({ ownerEmail: emailLower });
    if (existingWs) {
      return res.status(409).json({ error: "an account with this email already exists — sign in instead" });
    }

    const wsId = "ws_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    await masterDb.collection("workspaces").insertOne({
      id: wsId,
      company: String(project.title || "My Apps").slice(0, 120),
      industry: "software",
      // Collected at signup and surfaced by GET /api/admin/accounts, which
      // has always read this field — it just never had a real value to read
      // while this was hardcoded.
      country: String(country || "").toUpperCase().slice(0, 5) || "OT",
      ownerEmail: emailLower,
      dbType: "local",
      dbUri: "",
      logo: null,
      tagline: "",
      storefrontEnabled: false,
      plan: "free",
      createdAt: new Date().toISOString()
    });

    const ownerUser = {
      id: "usr_" + crypto.randomBytes(8).toString("base64url"),
      name: emailLower.split("@")[0],
      email: emailLower,
      password: password,              // insertOne() bcrypt-hashes "users" passwords automatically
      role: "Owner", dept: "Management", active: true,
      joined: new Date().toISOString().slice(0, 10)
    };
    const ws = await resolveWsContext(wsId);
    await dbAdapter.insertOne(ws, "users", ownerUser);

    await finalizeCodeClaim({ project, wsId, userId: ownerUser.id, email: emailLower, requestId: req.id });

    const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, role: "Owner", dept: "Management", wsId: wsId };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.cookie("sq_session", token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000, path: "/"
    });
    res.json({ ok: true, wsId: wsId, token: token, user: session });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/**
 * POST /api/codeagent/build-feedback
 * Body: { buildId, ok, errors?, raw? }
 * Called by code.html after the browser's WebContainer finishes a build.
 * Resolves the pending promise in the SSE handler's repair loop.
 */
app.post("/api/codeagent/build-feedback", express.json({ limit: "1mb" }), (req, res) => {
  const { buildId, ok, errors, raw } = req.body || {};
  if (!buildId) return res.status(400).json({ error: "buildId required" });
  const pending = pendingBuildResults.get(buildId);
  if (!pending) return res.status(404).json({ error: "unknown or expired buildId" });
  pendingBuildResults.delete(buildId);
  clearTimeout(pending.timer);
  pending.resolve({ ok: !!ok, errors: errors || [], raw: raw || "" });
  res.json({ received: true });
});

/**
 * POST /api/codeagent/build
 * Body: { prompt, projectId? }   SSE only.
 *
 * No projectId -> a brand new project. With projectId -> a follow-up:
 * reuses the live sandbox if this process still has one, otherwise spins
 * up a fresh sandbox and re-materializes the project's last known files
 * onto it first (a resume, transparent to the caller — same event shape
 * either way). There is no persisted model conversation (see file
 * header) — a follow-up is seeded with whatever is CURRENTLY on disk
 * plus the new request, so the model re-orients from real state each
 * turn rather than from memory of the first message.
 */
app.post("/api/codeagent/build", codeAgentLimiter, async (req, res) => {
  if (!wantsStream(req)) return res.status(400).json({ error: "this endpoint only supports SSE (Accept: text/event-stream)" });
  const prompt = String((req.body && req.body.prompt) || "").trim();

  // MUST run before sseOpen(): ownerOf() sets the sq_anon cookie the first
  // time a visitor is seen, which needs res.setHeader — writeHead (inside
  // sseOpen) commits the response headers immediately, and calling it
  // after that throws ERR_HTTP_HEADERS_SENT. Found live: that throw came
  // from OUTSIDE this handler's own try/catch, as an unhandled rejection —
  // which crashed the entire Node process, not just this one request, on
  // literally the first anonymous visitor. Same ordering the working
  // POST /api/projects above already uses.
  const owner = anon.ownerOf(req, res);

  sseOpen(res);
  if (prompt.length > 2000) {
    sseFrame(res, "error", { error: "prompt is too long" });
    return res.end();
  }
  if (promptTooVague(prompt)) {
    sseFrame(res, "error", { error: "Tell me a bit more about what to build — e.g. \"a landing page for a coffee shop\" or \"a todo app with categories\"." });
    return res.end();
  }

  const existingKey = String((req.body && req.body.projectId) || "");
  let project = null;
  if (existingKey) {
    project = await resolveProject(existingKey, owner);
    if (!project) { sseFrame(res, "error", { error: "project not found" }); return res.end(); }
    if (!projects.owns(project, owner)) { sseFrame(res, "error", { error: "not your project" }); return res.end(); }
  }
  const isFollowUp = !!project; // fixed at request start — independent of whether the sandbox turns out to still be alive below

  // A follow-up that's just conversational ("thanks!", "nice", "lol") is
  // not a change request — running it through proposeWithRepair would
  // waste a full build cycle on a model trying to interpret "thanks" as
  // an edit. Deterministic and cheap on purpose: unlike a first prompt's
  // near-infinite phrasing space, an acknowledgment is a small, closed
  // set of very short, common phrases — a model call here would be
  // slower AND less reliable than just matching it.
  if (isFollowUp && isCodeAgentChitChat(prompt)) {
    sseFrame(res, "chitchat", { reply: codeAgentChitChatReply() });
    sseFrame(res, "done", {});
    return res.end();
  }

  // Edit gate: the first build stays free and anonymous, exactly like
  // today — this only applies to a follow-up (an actual edit request).
  // Two steps, checked before any sandbox/model cost is incurred:
  //  1. Must be signed in at all — an anonymous cookie can build once but
  //     not iterate indefinitely for free forever.
  //  2. Once signed in, CODEAGENT_FREE_EDITS follow-ups are free; beyond
  //     that, their workspace needs a paid plan. "Workspace" because every
  //     account in this system is one (see /auth/login) — there is no
  //     separate personal-account concept to check a plan against.
  if (isFollowUp) {
    const sessionUser = codeAgentSessionUser(req);
    if (!sessionUser) {
      sseFrame(res, "authRequired", {
        message: "Sign in (it's free) to keep editing this build.",
        loginUrl: "/login", signupUrl: "/login"
      });
      sseFrame(res, "done", {});
      return res.end();
    }
    const priorTurns = await projects.listTurns(project.id);
    const editsUsed = Math.max(0, priorTurns.filter((t) => t.role === "user").length - 1);
    if (editsUsed >= CODEAGENT_FREE_EDITS) {
      const masterDbForPlan = getMasterDb();
      let plan = "free";
      if (sessionUser && sessionUser.wsId && masterDbForPlan) {
        const ws = await masterDbForPlan.collection("workspaces").findOne({ id: sessionUser.wsId }, { projection: { plan: 1 } });
        plan = (ws && ws.plan) || "free";
      }
      if (plan === "free") {
        sseFrame(res, "subscribeRequired", {
          message: "You've used your " + CODEAGENT_FREE_EDITS + " free edits. Subscribe to keep editing this build.",
          pricingUrl: "/pricing"
        });
        sseFrame(res, "done", {});
        return res.end();
      }
    }
  }

  // Per-owner spend cap (§9 "Abuse") — checked AFTER the free chit-chat
  // path (that one costs nothing) but before assessPrompt/proposeWithRepair
  // (both real model calls), and for both a fresh build and a follow-up —
  // a follow-up is exactly as billable as a first build. This is
  // independent of AI_MONTHLY_BUDGET_USD's own check inside lib/ai/client.js:
  // that one protects the whole platform's shared pool from running away in
  // aggregate; this one stops a single owner from being the reason it does.
  if (CODEAGENT_OWNER_MONTHLY_BUDGET_USD > 0) {
    const spent = await codeAgentUsage.monthSpend(owner);
    if (spent >= CODEAGENT_OWNER_MONTHLY_BUDGET_USD) {
      sseFrame(res, "error", { error: "You've used this month's free build budget ($" + CODEAGENT_OWNER_MONTHLY_BUDGET_USD.toFixed(2) + "). It resets next month." });
      sseFrame(res, "done", {});
      return res.end();
    }
  }

  // App-count cap (Pro/Max only, see CODEAGENT_PLAN_APP_LIMITS) — a FRESH
  // build only, and cheaper than assessPrompt (no model call), so it's
  // checked first. Anonymous/free visitors have no session to look a plan
  // up for, so this only ever applies to a signed-in paid owner.
  if (!isFollowUp) {
    const sessionUserForLimit = codeAgentSessionUser(req);
    if (sessionUserForLimit && sessionUserForLimit.wsId) {
      const masterDbForLimit = getMasterDb();
      if (masterDbForLimit) {
        const wsForLimit = await masterDbForLimit.collection("workspaces").findOne({ id: sessionUserForLimit.wsId }, { projection: { plan: 1 } });
        const planForLimit = (wsForLimit && wsForLimit.plan) || "free";
        const appLimit = CODEAGENT_PLAN_APP_LIMITS[planForLimit];
        if (appLimit) {
          const existing = (await projects.list(owner, 200)).filter((p) => (p.meta || {}).kind === "code");
          if (existing.length >= appLimit) {
            sseFrame(res, "error", {
              error: "Your " + planForLimit + " plan is limited to " + appLimit + (appLimit === 1 ? " app" : " apps") + ". Delete one, or upgrade for more at /pricing."
            });
            sseFrame(res, "done", {});
            return res.end();
          }
        }
      }
    }
  }

  // Ask, don't guess — only for a FRESH build. A follow-up already has an
  // established project; re-litigating "is this clear enough" on every
  // small change would be an annoying tax on someone already mid-build,
  // and there's real context (the current files) a follow-up can lean on
  // that a first prompt doesn't have. No sandbox, no project, no cost
  // beyond one cheap model call for a question nobody asked to see built.
  if (!isFollowUp) {
    const assessment = await assessPrompt(prompt);
    if (!assessment.clear) {
      sseFrame(res, "needsAnswer", { reply: assessment.reply });
      sseFrame(res, "done", {});
      return res.end();
    }
  }

  // ---- WebContainers flow: server proposes files, client builds ----
  try {
    sseFrame(res, "stage", { id: "propose", state: "start", detail: project ? "Making the change" : "Writing your app" });
    let effectivePrompt = prompt;
    if (!project) {
      const buildType = String((req.body && req.body.buildType) || "");
      effectivePrompt = prompt + (CODEAGENT_TYPE_HINT[buildType] || "");
      // Logo attachment: with WebContainers, the logo is written client-side.
      // Append the hint if a logo was provided so the model references it.
      const logo = req.body && req.body.logo;
      if (logo && typeof logo.dataUrl === "string" && LOGO_MIME_RE.test(logo.dataUrl)) {
        effectivePrompt += " An image has already been uploaded and saved at src/assets/logo.png" +
          " — import and use it as the site's logo/brand mark (e.g. in the header) instead of inventing a placeholder.";
      }
    }
    if (project) {
      // For follow-ups, include the current App.tsx content from the last revision
      const head = await projects.head(project.id);
      const files = head && head.config && head.config.files;
      let currentApp = "";
      if (files && files["src/App.tsx"]) currentApp = files["src/App.tsx"];
      effectivePrompt = "The current src/App.tsx is:\n\n" + currentApp + "\n\nChange request: " + prompt;
    }

    const result = await proposeWithClientBuild({
      userPrompt: effectivePrompt, maxRounds: 3,
      onFiles: async (calls) => {
        // Send proposed files to the client for WebContainer build
        const filesObj = {};
        for (const c of calls) filesObj[c.path] = c.content;
        const buildId = crypto.randomBytes(16).toString("hex");
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingBuildResults.delete(buildId);
            resolve({ ok: false, errors: [{ file: "", line: 0, col: 0, code: "", message: "build timed out (client did not respond in 3 minutes)" }], raw: "" });
          }, 180000);
          pendingBuildResults.set(buildId, { resolve, timer });
          sseFrame(res, "files", { buildId, files: filesObj });
        });
      },
      onRound: (r) => {
        sseFrame(res, "stage", {
          id: "round-" + r.round, state: "done",
          detail: r.ok ? "Build succeeded" : ("Fixing " + (r.errors ? r.errors.length : 0) + " issue(s)")
        });
      }
    });

    // Record spend regardless of outcome
    await codeAgentUsage.recordSpend(owner, result.costUsd || 0);
    const masterDbForAudit = getMasterDb();
    if (masterDbForAudit) {
      await writeMasterAudit(masterDbForAudit, {
        requestId: req.id, actor: owner.userId || owner.anonId || "anon",
        action: "codeagent.build", entityId: project ? project.id : null,
        summary: (result.ok ? "Build" : "Failed build") + " — $" + (result.costUsd || 0).toFixed(4),
        meta: { costUsd: result.costUsd || 0, ok: result.ok, rounds: result.rounds, isFollowUp }
      });
    }

    if (!result.ok) {
      sseFrame(res, "stage", { id: "propose", state: "done", detail: "Could not finish" });
      sseFrame(res, "error", { error: result.reason || "the agent could not produce a working build" });
      return res.end();
    }
    sseFrame(res, "stage", {
      id: "propose", state: "done",
      detail: result.repaired ? "Fixed it after " + result.rounds + " tries" : "Wrote it in one try"
    });

    // Collect file contents from the last successful proposal for persistence
    const fileContents = {};
    for (const c of result.calls) fileContents[c.path] = c.content;
    const srcFiles = result.calls.map((c) => c.path).filter((f) => f.startsWith("src/"));

    if (!project) {
      const createdBuildType = String((req.body && req.body.buildType) || "website");
      project = await projects.create({ title: prompt.slice(0, 60) || "Untitled app", prompt, meta: { kind: "code", buildType: createdBuildType }, owner });
    }
    await projects.addTurn(project.id, { role: "user", kind: "text", body: prompt });
    const revision = await projects.addRevision(
      project.id,
      { files: fileContents },
      result.repaired ? "Fixed after " + result.rounds + " tries" : (isFollowUp ? "Follow-up" : "First build")
    );
    await projects.addTurn(project.id, {
      role: "agent", kind: "result", body: summariseCodeBuild(srcFiles.length, result.repaired, result.rounds), revisionId: revision.id
    });
    await projects.ensureIndexes();
    await codeAgentUsage.ensureIndexes();

    // Tell the client to start preview (client-side WebContainer handles this)
    sseFrame(res, "result", {
      projectId: project.id, slug: project.slug, files: srcFiles,
      previewUrl: "__webcontainer__", // signal to client: use local WebContainer preview
      repaired: !!result.repaired, rounds: result.rounds, costUsd: result.costUsd || 0
    });
    sseFrame(res, "done", {});
    res.end();
  } catch (e) {
    console.error("codeagent build error:", e.message);
    try { sseFrame(res, "error", { error: "build failed" }); } catch (e2) { /* response may already be gone */ }
    try { res.end(); } catch (e3) { /* already ended */ }
  }
});

/**
 * GET /api/codeagent/:key
 * Replays a code project's transcript on reload — the point of Phase 7.
 * `previewUrl` is always OUR OWN proxy path (see below), never Daytona's
 * raw domain — `sandboxAlive` tells the caller whether that path will
 * actually resolve right now or needs a resume first.
 */
app.get("/api/codeagent/:key", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const [turns, revision] = await Promise.all([projects.listTurns(project.id), projects.head(project.id)]);
    const live = await codeAgentLive(project);
    let sandboxAlive = false;
    if (live) {
      try {
        await live.runtime.getPublicPreviewUrl(live.ws, daytonaRuntimeModule.PREVIEW_PORT, 1800);
        sandboxAlive = true;
      } catch (e) { /* the sandbox died without telling this process — fall through as not-alive */ }
    }

    res.json({
      project: { id: project.id, slug: project.slug, title: project.title, prompt: project.prompt, createdAt: project.createdAt, updatedAt: project.updatedAt },
      turns: turns,
      files: revision && revision.config && revision.config.files ? Object.keys(revision.config.files).filter((f) => f.startsWith("src/")) : [],
      previewUrl: "/api/codeagent/preview/" + encodeURIComponent(project.slug), sandboxAlive: sandboxAlive
    });
  } catch (e) { next(e); }
});

/**
 * GET /api/codeagent/preview/:key(/*)
 * A same-origin reverse proxy onto the sandbox's signed Daytona preview
 * URL — the actual fix for two real problems found live, not a
 * workaround for either:
 *
 *   1. Embedding Daytona's raw *.daytonaproxy01.eu domain directly in an
 *      iframe got silently blocked by local security software treating
 *      an unfamiliar domain as suspicious ("This content is blocked.").
 *      Same-origin content the visitor is already using isn't unfamiliar
 *      to anything.
 *   2. The signed preview URL never has to reach the browser at all now
 *      — this process fetches it server-side and streams the response
 *      back under Souqi's own origin, so a leaked/inspected iframe src
 *      reveals nothing that grants access on its own.
 *
 * Owner-gated exactly like every other project read — knowing a slug is
 * not authorisation, same rule as everywhere else this session.
 */
// Preview proxy removed — WebContainers serve previews locally in the browser.
// Kept as a stub to avoid 404s from old bookmarks.
app.get("/api/codeagent/preview/:key", (req, res) => res.status(410).send("Preview is now served locally by WebContainers. Open the project in Souqi Code."));
app.get("/api/codeagent/preview/:key/*", (req, res) => res.status(410).send("Preview is now served locally by WebContainers. Open the project in Souqi Code."));

// Total base64 payload kept comfortably under Mongo's 16MB document cap —
// dist/ is model-written text plus whatever assets it references, and
// nothing here bounds what the model could reference, so this is a real
// guard, not a formality.
const PUBLISH_MAX_BYTES = 12 * 1024 * 1024;

/**
 * POST /api/codeagent/:key/publish
 * Builds the project's current files to a static dist/ and stores it
 * directly on the project doc (Phase 8, scoped down: reuse this server as
 * the "CDN" rather than standing up a new object-storage account before
 * one is needed — see docs/CODE-AGENT-PLAN.md §7). Reuses the exact
 * live-check/resume dance POST /build already does, since publishing an
 * idle project needs the same "sandbox may be gone" handling a follow-up
 * does. Once published the site is served by servePublishedSite() below
 * with NO sandbox involved — the whole point of Phase 8.
 */
app.post("/api/codeagent/:key/publish", codeAgentLimiter, express.json({ limit: "12mb" }), async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const distFiles = req.body && req.body.dist;
    if (!Array.isArray(distFiles) || !distFiles.length) {
      return res.status(400).json({ error: "dist files required — build the project first" });
    }

    const totalBytes = distFiles.reduce((n, f) => n + (f.size || 0), 0);
    if (totalBytes > PUBLISH_MAX_BYTES) {
      return res.status(413).json({ error: "this app's build is too large to publish (" + (totalBytes / 1024 / 1024).toFixed(1) + " MB) — trim large assets and try again" });
    }

    const publicSlug = (project.published && project.published.publicSlug) || await projects.uniquePublicSlug(project.slug);
    const filesMap = {};
    for (const f of distFiles) filesMap[f.path] = f.base64;

    await projects.patch(project.id, {
      published: { publicSlug, files: filesMap, publishedAt: new Date().toISOString(), revisionId: project.headRevision }
    });
    await projects.ensureIndexes();

    res.json({ ok: true, url: "/s/" + publicSlug + "/" });
  } catch (e) {
    console.error("codeagent publish error:", e.message);
    next(e);
  }
});

/**
 * POST /api/codeagent/:key/export-android
 * Generates a downloadable Capacitor-wrapped Android project ZIP from
 * the published dist/ files. No Android SDK needed on the server — the
 * ZIP contains everything the user needs to build locally with
 * `npx cap sync && npx cap open android` or on CI with Gradle.
 */
app.post("/api/codeagent/:key/export-android", codeAgentLimiter, async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (!project.published || !project.published.files) {
      return res.status(409).json({ error: "publish this project first, then export as an app" });
    }

    const archiver = require("archiver");
    const appName = project.title || "Souqi App";
    const appId = "com.souqi.app." + (project.slug || "app").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 30);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="' + (project.slug || "app") + '-android.zip"');

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    // package.json with Capacitor deps
    archive.append(JSON.stringify({
      name: appId,
      version: "1.0.0",
      private: true,
      scripts: {
        "cap:init": "npx cap sync android",
        "cap:open": "npx cap open android",
        "cap:build": "cd android && ./gradlew assembleDebug"
      },
      dependencies: {
        "@capacitor/core": "^6.0.0",
        "@capacitor/android": "^6.0.0",
        "@capacitor/cli": "^6.0.0"
      }
    }, null, 2), { name: "package.json" });

    // capacitor.config.ts
    archive.append(`import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: '${appId}',
  appName: ${JSON.stringify(appName)},
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#1aa6df',
      showSpinner: false
    }
  }
};

export default config;
`, { name: "capacitor.config.ts" });

    // tsconfig.json for capacitor.config.ts
    archive.append(JSON.stringify({
      compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "node", esModuleInterop: true }
    }, null, 2), { name: "tsconfig.json" });

    // README with build instructions
    archive.append(`# ${appName} — Android App

This is a Capacitor-wrapped Android project generated by Souqi Code.

## Prerequisites

- **Node.js** 18+ (https://nodejs.org)
- **Android Studio** (https://developer.android.com/studio)
- **Java JDK 17** (usually bundled with Android Studio)

## Quick Start

\`\`\`bash
# 1. Install dependencies
npm install

# 2. Add the Android platform
npx cap add android

# 3. Sync web assets to Android
npx cap sync android

# 4. Open in Android Studio (build + run from there)
npx cap open android
\`\`\`

## Build APK from Command Line

\`\`\`bash
cd android
./gradlew assembleDebug
\`\`\`

The APK will be at: \`android/app/build/outputs/apk/debug/app-debug.apk\`

## Build Release APK

1. Generate a keystore: \`keytool -genkey -v -keystore release.keystore -alias app -keyalg RSA -keysize 2048\`
2. Build: \`cd android && ./gradlew assembleRelease\`

---
Generated by [Souqi Code](https://souqi.site)
`, { name: "README.md" });

    // Write the published dist/ files (decode from base64)
    const pubFiles = project.published.files;
    for (const [filePath, base64Content] of Object.entries(pubFiles)) {
      archive.append(Buffer.from(base64Content, "base64"), { name: "dist/" + filePath });
    }

    await archive.finalize();
  } catch (e) {
    console.error("codeagent export-android error:", e.message);
    if (!res.headersSent) next(e);
  }
});
/**
 * POST /api/codeagent/:key/domain
 * Body: { domain: "app.yourbrand.com" | "" }
 * Set or clear a custom domain for an already-published project. Same
 * trust model as Sites' /api/ws/:id/domain (db-adapters.js's
 * findWorkspaceByDomain) — the stored field is the only check, no separate
 * verification flow, see projects.js's findByCustomDomain for why that's
 * fine: setting it is already owner-gated, and a domain not actually
 * pointed at Souqi's DNS sends this server no traffic regardless of what's
 * stored here.
 */
app.post("/api/codeagent/:key/domain", codeAgentLimiter, async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (!project.published) return res.status(409).json({ error: "publish this project first, then connect a domain" });

    const raw = String((req.body && req.body.domain) || "").toLowerCase().trim();
    if (!raw) {
      await projects.patch(project.id, { published: Object.assign({}, project.published, { customDomain: null }) });
      return res.json({ ok: true, domain: null });
    }
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(raw)) {
      return res.status(400).json({ error: "that doesn't look like a valid domain (e.g. app.yourbrand.com)" });
    }
    const clash = await projects.findByCustomDomain(raw);
    if (clash && clash.id !== project.id) {
      return res.status(409).json({ error: "that domain is already connected to a different project" });
    }
    await projects.patch(project.id, { published: Object.assign({}, project.published, { customDomain: raw }) });
    await projects.ensureIndexes();
    res.json({ ok: true, domain: raw, target: process.env.PLATFORM_HOST || "app.souqi.site" });
  } catch (e) { next(e); }
});

/** GET /api/codeagent/:key/domain/status — a live DNS check, informational
    only (not a security gate, see above) — tells the UI whether the
    domain's DNS has actually started pointing at Souqi yet, for a real
    "waiting for DNS" vs "live" state instead of a static instructions page. */
app.get("/api/codeagent/:key/domain/status", async (req, res, next) => {
  try {
    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    const domain = project.published && project.published.customDomain;
    if (!domain) return res.json({ domain: null, live: false });

    const target = (process.env.PLATFORM_HOST || "app.souqi.site").toLowerCase();
    let live = false;
    try {
      const cnames = await dns.promises.resolveCname(domain).catch(() => []);
      live = cnames.some((r) => r.toLowerCase().replace(/\.$/, "") === target);
      if (!live) {
        // Some DNS providers flatten a CNAME-at-apex into A records instead
        // — compare resolved IPs so a correctly-configured apex domain
        // doesn't read as "not live" just for not literally being a CNAME.
        const [domainIps, targetIps] = await Promise.all([
          dns.promises.resolve4(domain).catch(() => []),
          dns.promises.resolve4(target).catch(() => [])
        ]);
        live = domainIps.length > 0 && targetIps.some((ip) => domainIps.includes(ip));
      }
    } catch (e) { live = false; }
    res.json({ domain, live, target });
  } catch (e) { next(e); }
});

/**
 * GET /s/:slug(/*) — a published Souqi Code app: static files served
 * straight from Mongo, no sandbox involved and no owner check at all —
 * this is the PUBLISHED artifact, same public trust model as Sites'
 * storefront pages (§7: "the published site is static, permanent, and
 * costs ~nothing"). Unknown paths fall back to index.html, matching how
 * a client-side-routed SPA is expected to be served.
 */
const PUBLISHED_MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  // Every generated app is now a PWA (vite-plugin-pwa in the scaffold) — a
  // published site needs the correct manifest MIME or "Add to Home Screen"
  // silently fails to detect it as installable in some browsers.
  ".webmanifest": "application/manifest+json"
};
function mimeForPath(p) {
  const dot = p.lastIndexOf(".");
  return (dot >= 0 && PUBLISHED_MIME[p.slice(dot).toLowerCase()]) || "application/octet-stream";
}
async function servePublishedSite(req, res, subPath, projectOverride) {
  try {
    const project = projectOverride || await projects.findPublished(req.params.slug);
    const files = project && project.published && project.published.files;
    if (!files) return res.status(404).send("Not found");

    let key = subPath || "index.html";
    if (!Object.prototype.hasOwnProperty.call(files, key)) key = "index.html";
    if (!Object.prototype.hasOwnProperty.call(files, key)) return res.status(404).send("Not found");

    res.setHeader("Content-Type", mimeForPath(key));
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(files[key], "base64"));
  } catch (e) {
    console.error("published site serve error:", e.message);
    res.status(500).send("Server error");
  }
}
app.get("/s/:slug", (req, res) => servePublishedSite(req, res, ""));
app.get("/s/:slug/*", (req, res) => servePublishedSite(req, res, req.params[0]));

/** GET /api/agent/draft/:id — read a draft back (reload, share-preview). */
app.get("/api/agent/draft/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!/^dr_[A-Za-z0-9_-]{6,40}$/.test(id)) return res.status(400).json({ error: "bad draft id" });
    const draft = await loadDraft(id);
    if (!draft) return res.status(404).json({ error: "draft not found or expired" });
    res.json({ draftId: draft.id, prompt: draft.prompt, meta: draft.meta, config: draft.config });
  } catch (e) {
    next(e);
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

/* -----------------------------------------------------------------
   Two ways this file runs, one app.
   - Locally / on any long-lived host: listen on a port, as always.
   - On Vercel: api/index.js require()s this module and hands each
     request to the exported `app`. There is no port to listen on there,
     and calling listen() would both fail and leak a handle per cold
     start — so the listen path is gated on NOT being in a serverless
     runtime rather than being the unconditional default it used to be.
   Mongo is connected lazily either way: on Vercel a cold start must not
   block on a DB round-trip before the first response, and the app
   already tolerates getMasterDb() returning null (it did so every time
   the local Mongo was down this session).
   ----------------------------------------------------------------- */
const IS_SERVERLESS = !!process.env.VERCEL;

let connectOnce = null;
function ensureDb() {
  if (!connectOnce) {
    connectOnce = connect().catch((e) => {
      console.warn("✗ Failed to connect to master MongoDB:", e.message);
      connectOnce = null; // let a later request retry rather than caching the failure forever
    });
  }
  return connectOnce;
}

if (IS_SERVERLESS) {
  ensureDb();
} else {
  const PORT = process.env.PORT || 4000;
  ensureDb().finally(() => {
    app.listen(PORT, () => console.log("✓ Souqi API listening on http://localhost:" + PORT));
  });
}

module.exports = app;
