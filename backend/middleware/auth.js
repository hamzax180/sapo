/* =================================================================
   Souqi — authentication, tenant scoping & authorization
   -----------------------------------------------------------------
   The security spine for the generic CRUD API. Three middlewares,
   applied in order:

     requireSession  → verifies the JWT, attaches req.session
     tenantScope     → derives the workspace + DB context SERVER-SIDE
                       from the signed session (never from client
                       headers) and attaches req.ws
     authorizeCrud   → enforces the server RBAC for the collection/verb

   The critical invariant: a caller can NEVER change which tenant or
   which database is touched by manipulating a request header. Tenancy
   comes from the signed token; the DB URI is resolved from the master
   DB. The old x-workspace-db-uri / x-workspace-id trust path is gone.
   ================================================================= */
"use strict";
const jwt = require("jsonwebtoken");
const { httpError } = require("../lib/errors");
const rbac = require("../lib/rbac");
const { decryptSecret } = require("../lib/crypto");

// Read a single cookie value without pulling in cookie-parser.
function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf("=");
    if (idx === -1) continue;
    const k = parts[i].slice(0, idx).trim();
    if (k === name) return decodeURIComponent(parts[i].slice(idx + 1).trim());
  }
  return null;
}

/**
 * Resolve the server-owned DB context for a workspace id. Looks the
 * workspace up in the master DB; falls back to the platform's default
 * cluster (per-workspace database name) when there is no explicit,
 * customer-supplied connection string. Client-provided DB URIs are
 * never consulted here.
 */
async function resolveWsContext(getMasterDb, wsId) {
  const fallback = {
    workspaceId: wsId || "default",
    dbType: "mongodb",
    dbUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017"
  };
  try {
    const masterDb = getMasterDb && getMasterDb();
    if (masterDb && wsId) {
      const ws = await masterDb.collection("workspaces").findOne({ id: wsId });
      if (ws) {
        return {
          workspaceId: ws.id,
          dbType: ws.dbType && ws.dbType !== "local" ? ws.dbType : fallback.dbType,
          // Stored connection strings are encrypted at rest; decrypt only
          // here, in memory, right before use.
          dbUri: ws.dbUri ? decryptSecret(ws.dbUri) : fallback.dbUri
        };
      }
    }
  } catch (e) {
    // fall through to platform default
  }
  return fallback;
}

function makeAuth({ JWT_SECRET, getMasterDb }) {
  function requireSession(req, res, next) {
    // Accept the token from the Authorization header OR the httpOnly session
    // cookie. The cookie is SameSite=Lax, so it isn't sent on cross-site POST/
    // PUT/DELETE — mutations remain CSRF-safe.
    let token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) token = readCookie(req, "sq_session") || "";
    if (!token) return next(httpError(401, "unauthorized", "authentication required"));

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return next(httpError(401, "invalid_token", "invalid or expired token"));
    }

    /* A SCOPED TOKEN IS NOT A SESSION.
       This server signs narrow grants with the same secret as sessions —
       { anonId, scope:"anon" } for a visitor who has not signed up, and
       { wsId, email, scope:"portal-edit" } for a fifteen-minute storefront
       edit. Verifying the signature was the only check here, so both of
       them arrived as req.session and every gate downstream read whatever
       claims they happened to carry.

       The anon grant was harmless: no email, no role, refused everywhere.
       The edit grant was not. It carries the workspace owner's EMAIL, and
       requireAdmin compares an email against ADMIN_EMAILS — so on any
       deployment where an admin also owns a workspace, which is the normal
       case and is the case here, a token minted to let someone drag a
       heading around opened GET /api/admin/overview and
       GET /api/admin/accounts: every account on the platform, its plan and
       its revenue. Confirmed against the running server — 200 on both.

       The tenant CRUD survived only by accident: a scoped token has no
       role, and authorizeCrud refuses an unknown one. That is defence in
       depth doing its job, not a reason to leave the front door open.

       401 rather than 403, because the caller has presented something that
       is not a session at all — the answer is "authenticate", not "you may
       not". */
    if (decoded && decoded.scope) {
      return next(httpError(401, "invalid_token", "this token is not a session"));
    }

    req.session = decoded;
    return next();
  }

  async function tenantScope(req, res, next) {
    try {
      const wsId = (req.session && req.session.wsId) || "default";
      req.ws = await resolveWsContext(getMasterDb, wsId);
      return next();
    } catch (e) {
      return next(e);
    }
  }

  function authorizeCrud(req, res, next) {
    const role = req.session && req.session.role;
    const collection = req.params.c;
    const action = rbac.actionForMethod(req.method);
    if (!rbac.can(role, collection, action)) {
      return next(httpError(403, "forbidden", "your role may not " + action + " " + collection));
    }
    return next();
  }

  // Platform super-admin gate: the authenticated identity's email must be in
  // ADMIN_EMAILS. Use AFTER requireSession.
  function requireAdmin(req, res, next) {
    const admins = String(process.env.ADMIN_EMAILS || "")
      .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const email = req.session && String(req.session.email || "").toLowerCase();
    if (!email || admins.indexOf(email) === -1) {
      return next(httpError(403, "forbidden", "platform admin access required"));
    }
    return next();
  }

  return { requireSession, tenantScope, authorizeCrud, requireAdmin, resolveWsContext: (wsId) => resolveWsContext(getMasterDb, wsId) };
}

module.exports = { makeAuth, resolveWsContext };
