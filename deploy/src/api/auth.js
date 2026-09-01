/* =================================================================
   api/auth.js — real sessions, replacing the x-user-id placeholder
   -----------------------------------------------------------------
   The deploy plane shares the main app session format rather than
   inventing a second one: the same sq_session JWT, signed with the
   same JWT_SECRET, carrying { id, email, wsId, sessionEpoch }.
   A user who is signed in to Souqi is signed in here.

   TWO CHECKS, because a JWT alone cannot answer the second:

     1. AUTHENTICATION — signature and expiry, verified locally. No
        network call, so a deploy never waits on another service to
        find out who is asking.

     2. REVOCATION — whether that token still counts. Sign-out-other-
        sessions works by bumping a per-user sessionEpoch in Mongo,
        which this service cannot read. So it asks the main app, and
        caches the answer briefly.

   What happens when introspection is unreachable is the interesting
   decision, and it is deliberate: READS continue, MUTATIONS are
   refused. Making the whole plane fail when the main app blips would
   be a worse outage than the risk it prevents, but quietly letting a
   revoked token start containers is exactly the failure mode
   revocation exists to stop. Capability degrades; identity does not.
   ================================================================= */
"use strict";

const jwt = require("jsonwebtoken");
const { cfg } = require("../config");

const COOKIE = "sq_session";

/* ---------- token extraction ----------
   Cookie first (browser dashboard), then Authorization: Bearer (the main
   app calling on a user behalf, and CLI clients). */
function tokenFrom(req) {
  const raw = req.headers.cookie || "";
  const m = /(?:^|;\s*)sq_session=([^;]*)/.exec(raw);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }

  const auth = req.headers.authorization || "";
  const b = /^Bearer\s+(.+)$/i.exec(auth);
  if (b) return b[1].trim();

  return null;
}

/** Signature + expiry + the claims this service actually requires. */
function verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, cfg.jwtSecret);
    if (!decoded || !decoded.id) return null;
    return {
      id: String(decoded.id),
      email: decoded.email || null,
      wsId: decoded.wsId || null,
      role: decoded.role || null,
      sessionEpoch: decoded.sessionEpoch || 0
    };
  } catch (e) {
    // Expired, wrong signature, malformed — all the same answer to a caller.
    return null;
  }
}

/* ---------- revocation ----------
   A tiny TTL cache. The window is short enough that a revoked session stops
   working promptly, and long enough that a burst of status polls during a
   build does not become a burst of calls to the main app. */
const cache = new Map();   // token -> { ok, at }
const TTL_MS = 60 * 1000;
const MAX_CACHE = 5000;

function cacheGet(token) {
  const hit = cache.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(token); return null; }
  return hit;
}

function cacheSet(token, ok) {
  // Bounded so a stream of junk tokens cannot grow this without limit.
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(token, { ok, at: Date.now() });
}

/**
 * @returns {"valid"|"revoked"|"unknown"}  "unknown" means the main app could
 * not be reached, which is a different thing from a rejected session and is
 * treated differently by the middleware below.
 */
async function checkRevocation(token) {
  if (!cfg.authIntrospectUrl) return "valid";   // not configured: local verify only

  const hit = cacheGet(token);
  if (hit) return hit.ok ? "valid" : "revoked";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(cfg.authIntrospectUrl, {
      headers: { cookie: COOKIE + "=" + encodeURIComponent(token) },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) return "unknown";
    const body = await res.json().catch(() => null);
    const ok = !!(body && body.signedIn);
    cacheSet(token, ok);
    return ok ? "valid" : "revoked";
  } catch (e) {
    // Timeout, DNS, connection refused. Not a verdict on the session.
    return "unknown";
  }
}

/** Actions that create work, spend resources, or change what is running. */
function isMutation(req) {
  return req.method !== "GET" && req.method !== "HEAD";
}

/* ---------- development escape hatch ----------
   Off unless explicitly enabled, and it refuses to coexist with
   NODE_ENV=production (see assertAuthConfig). Without it, running the stack
   locally needs a full login flow before a single curl works; with it left
   on by accident in production, anyone could deploy as anyone — which is
   why the check is at boot and fatal, not a warning nobody reads. */
function devUser(req) {
  if (!cfg.allowDevAuth) return null;
  const id = req.header("x-user-id");
  if (!id) return null;
  return { id: String(id), email: String(id) + "@dev.local", wsId: null, role: "dev", sessionEpoch: 0, dev: true };
}

/**
 * Express middleware. Sets req.user and req.sessionToken, or answers 401/403.
 */
async function requireUser(req, res, next) {
  const dev = devUser(req);
  if (dev) { req.user = dev; req.userId = dev.id; return next(); }

  const token = tokenFrom(req);
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: "sign in to continue", code: "not_signed_in" });
  }

  const state = await checkRevocation(token);
  if (state === "revoked") {
    return res.status(401).json({ error: "this session has ended — sign in again", code: "session_revoked" });
  }
  if (state === "unknown" && isMutation(req)) {
    // Reads are still served below; only state-changing calls stop here.
    console.warn("[auth] introspection unavailable — refusing a mutation for", user.id);
    return res.status(503).json({
      error: "cannot verify your session right now — please try again in a moment",
      code: "auth_unavailable",
      retryAfter: 15
    });
  }

  req.user = user;
  req.userId = user.id;
  req.sessionToken = token;
  next();
}

/**
 * Some routes are for the platform itself, not a person — Caddy asking
 * whether a hostname is real, health checks from a monitor. A shared secret
 * is the right shape there: there is no user, and a JWT would be pretending
 * otherwise.
 */
function requireInternal(req, res, next) {
  if (!cfg.internalToken) {
    return res.status(503).json({ error: "internal API is not configured" });
  }
  // Header first. The query parameter exists because Caddy on-demand-TLS
  // "ask" cannot set headers, and that endpoint has to be reachable. It is
  // only ever sent over the internal platform network, and the error handler
  // logs req.path (which excludes the query string), so the secret does not
  // reach a log line.
  const given = req.header("x-internal-token")
    || (req.query && req.query.token)
    || "";
  // Constant-time compare: a length-leaking early return on a shared secret
  // is a timing oracle worth avoiding for the cost of one require.
  const crypto = require("crypto");
  const a = Buffer.from(given);
  const b = Buffer.from(cfg.internalToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "unauthorised" });
  }
  next();
}

/** Boot-time checks. Fatal problems are returned; the caller exits. */
function assertAuthConfig() {
  const fatal = [];
  const warn = [];

  const isProd = process.env.NODE_ENV === "production";

  if (!cfg.jwtSecret || cfg.jwtSecret === "dev-insecure-secret") {
    (isProd ? fatal : warn).push(
      "JWT_SECRET is unset or still the development default — sessions are forgeable"
    );
  }
  if (cfg.allowDevAuth && isProd) {
    fatal.push("ALLOW_DEV_AUTH is on in production — anyone could deploy as any user");
  }
  if (cfg.allowDevAuth) {
    warn.push("ALLOW_DEV_AUTH is on: the x-user-id header is trusted without a session");
  }
  if (!cfg.authIntrospectUrl) {
    warn.push("AUTH_INTROSPECT_URL is unset — revoked sessions stay usable until the token expires");
  }
  if (!cfg.internalToken) {
    warn.push("INTERNAL_TOKEN is unset — internal endpoints are disabled");
  }
  return { fatal, warn };
}

module.exports = {
  requireUser, requireInternal, assertAuthConfig,
  tokenFrom, verifyToken, checkRevocation, isMutation,
  _cache: cache
};
