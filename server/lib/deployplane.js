/* =================================================================
   lib/deployplane.js — talking to the container deployment plane
   -----------------------------------------------------------------
   The deploy plane (repo directory deploy/) builds a user's source in
   Docker, runs it in a hardened container, and routes it over HTTPS.
   It is a separate service with its own Postgres, and it is
   DELIBERATELY not reachable from the internet: in its compose file
   only Caddy publishes ports, and its own test suite asserts that.

   So the browser cannot call it, and neither can this app in the
   general case. Every request goes:

     browser --cookie--> this server --> deploy plane

   which is the same shape as the Gemini proxy in /ai/chat: the
   credential stays server-side and the client only sees the result.

   TWO INDEPENDENT AUTHORISATIONS, on purpose:

     1. This server resolves the Mongo project and checks the caller
        owns it, before it will name a deployment id at all.
     2. The deploy plane verifies the SAME sq_session JWT itself
        (shared JWT_SECRET) and applies its own ownership check.

   Neither trusts the other. A bug in one is not a breach.

   The platform token is a second, coarser gate. In production the
   deploy API is exposed on a control-plane hostname routed by Caddy,
   and that hostname refuses anything without this header — so the API
   is not sitting openly on the internet behind session auth alone.
   ================================================================= */
"use strict";

const BASE = (process.env.DEPLOY_API_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.DEPLOY_PLATFORM_TOKEN || "";

/* A build can take minutes, but no single call here waits on one — the
   deploy plane queues work and the client polls. So a short timeout is
   correct: anything slower than this is a fault, not a slow build. */
const TIMEOUT_MS = 15000;

/**
 * False when the environment has no deploy plane configured, which is
 * the normal state on a laptop that is not running the stack. Callers
 * use this to return a clear "not configured here" instead of a 500
 * that looks like an outage.
 */
function isConfigured() {
  return !!BASE;
}

/**
 * Both error envelopes in this codebase, flattened to a string.
 * Routes that call next(e) produce {error:{code,message}}; plenty of
 * hand-written responses return a flat {error:"..."}. Frontend code
 * already defends against both; so does this.
 */
function messageOf(body, fallback) {
  if (!body) return fallback;
  if (typeof body.error === "string") return body.error;
  if (body.error && body.error.message) return body.error.message;
  return fallback;
}

/**
 * One call to the deploy plane.
 *
 * `cookie` is the caller's raw Cookie header, forwarded so the deploy
 * plane can identify the user for itself. It is not optional in
 * practice — without it every request is anonymous over there.
 */
async function call(method, path, opts) {
  const o = opts || {};
  if (!isConfigured()) {
    return { ok: false, status: 503, error: "the deployment plane is not configured in this environment" };
  }

  const headers = {};
  if (TOKEN) headers["x-platform-token"] = TOKEN;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(BASE + path, {
      method: method,
      headers: headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: AbortSignal.timeout(o.timeoutMs || TIMEOUT_MS)
    });
  } catch (e) {
    // A network failure here is an outage of a dependency, not of this
    // app. Say which, because "500" would send someone debugging the
    // wrong service.
    return { ok: false, status: 502, error: "the deployment service is unreachable (" + e.message + ")" };
  }

  const text = await res.text().catch(function () { return ""; });
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }

  if (!res.ok) {
    return { ok: false, status: res.status, error: messageOf(body, "the deployment service returned " + res.status) };
  }
  return { ok: true, status: res.status, body: body };
}

/* ---------- thin wrappers ----------
   Named so a reader of server/index.js can see what is being asked of
   the deploy plane without holding its URL scheme in their head. */

const health = (cookie) => call("GET", "/health", { cookie });
const capacity = (cookie) => call("GET", "/capacity", { cookie });

const createProject = (cookie, name) => call("POST", "/projects", { cookie, body: { name: name } });

const createDeployment = (cookie, deployProjectId) =>
  call("POST", "/deployments", { cookie, body: { projectId: deployProjectId } });

/* The source upload is the one big payload, so it gets a longer
   timeout than a status poll would ever need. */
const uploadSource = (cookie, deploymentId, files) =>
  call("POST", "/deployments/" + encodeURIComponent(deploymentId) + "/source",
    { cookie, body: { files: files }, timeoutMs: 60000 });

const getDeployment = (cookie, id) => call("GET", "/deployments/" + encodeURIComponent(id), { cookie });
const getStatus = (cookie, id) => call("GET", "/deployments/" + encodeURIComponent(id) + "/status", { cookie });

const getLogs = (cookie, id, phase, tail) =>
  call("GET", "/deployments/" + encodeURIComponent(id) + "/logs?phase=" +
    encodeURIComponent(phase || "build") + "&tail=" + encodeURIComponent(String(tail || 500)), { cookie });

/* Lifecycle actions answer 202 {pending:true} — the deploy plane queues
   them for the worker that holds the Docker socket, because the API
   over there has no socket and never will. So these return "accepted",
   never "done", and the caller must poll for the real outcome. */
const ACTIONS = ["deploy", "redeploy", "stop", "start", "restart"];
function action(cookie, id, name) {
  if (ACTIONS.indexOf(name) < 0) {
    return Promise.resolve({ ok: false, status: 400, error: "unknown action" });
  }
  return call("POST", "/deployments/" + encodeURIComponent(id) + "/" + name, { cookie });
}

const destroy = (cookie, id) => call("DELETE", "/deployments/" + encodeURIComponent(id), { cookie });

const getEnv = (cookie, deployProjectId) =>
  call("GET", "/projects/" + encodeURIComponent(deployProjectId) + "/env", { cookie });
const putEnv = (cookie, deployProjectId, vars) =>
  call("PUT", "/projects/" + encodeURIComponent(deployProjectId) + "/env", { cookie, body: vars });
const deleteEnvKey = (cookie, deployProjectId, key) =>
  call("DELETE", "/projects/" + encodeURIComponent(deployProjectId) + "/env/" + encodeURIComponent(key), { cookie });

/* ---- the app's database ----
   Every deployed project gets a Postgres database on the plane's shared
   customer cluster, injected as SOUQI_DATABASE_URL. getDatabase answers
   with a MASKED credential and never the real one — the connection string
   carries a password, the app is handed it through its environment, and
   nothing in a browser has a reason to read it. */
const dbPath = (id) => "/projects/" + encodeURIComponent(id) + "/database";

const getDatabase = (cookie, deployProjectId) =>
  call("GET", dbPath(deployProjectId), { cookie });
/** {mode:"builtin"} or {mode:"external", url}. The plane validates the URL
    by connecting to it before it will store one. */
const setDatabase = (cookie, deployProjectId, body) =>
  call("PUT", dbPath(deployProjectId), { cookie, body: body });
/** Refreshes the recorded size; answers with the updated view. */
const measureDatabase = (cookie, deployProjectId) =>
  call("POST", dbPath(deployProjectId) + "/measure", { cookie });
/** Drops a built-in database that is being kept after a switch to
    external. 202: queued for the worker, like every other docker action. */
const dropBuiltinDatabase = (cookie, deployProjectId) =>
  call("DELETE", dbPath(deployProjectId), { cookie });

module.exports = {
  isConfigured, call, ACTIONS,
  health, capacity,
  createProject, createDeployment, uploadSource,
  getDeployment, getStatus, getLogs, action, destroy,
  getEnv, putEnv, deleteEnvKey,
  getDatabase, setDatabase, measureDatabase, dropBuiltinDatabase
};
