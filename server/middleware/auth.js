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
          dbUri: ws.dbUri || fallback.dbUri
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
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return next(httpError(401, "unauthorized", "authentication required"));
    try {
      req.session = jwt.verify(token, JWT_SECRET);
      return next();
    } catch (e) {
      return next(httpError(401, "invalid_token", "invalid or expired token"));
    }
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

  return { requireSession, tenantScope, authorizeCrud, resolveWsContext: (wsId) => resolveWsContext(getMasterDb, wsId) };
}

module.exports = { makeAuth, resolveWsContext };
