/* =================================================================
   lib/vercel.js — per-client Vercel deployments via OAuth
   -----------------------------------------------------------------
   Each workspace connects its OWN Vercel account. Deployments land in
   the client's account, against their plan and their limits, under
   their domains — the platform never owns, pays for, or is liable for
   what a client ships. That is the whole reason this is OAuth rather
   than one platform-wide token.

   The access token is a credential belonging to someone else. It is:
     - stored per workspace in the master DB, never in a project doc
       (projects are readable by an anonymous cookie before claim);
     - never sent to the browser — every call that needs it happens
       here, server-side, and the client only ever sees the resulting
       deployment URL;
     - never logged, including in error paths (see deployError()).

   Vercel's API shape is versioned and changes; every endpoint used
   here is pinned to an explicit version so an upstream change surfaces
   as a clear 404 rather than silently altering behaviour.
   ================================================================= */
"use strict";

const crypto = require("crypto");

const VERCEL_API = "https://api.vercel.com";
const OAUTH_AUTHORIZE = "https://vercel.com/oauth/authorize";
const OAUTH_TOKEN = VERCEL_API + "/v2/oauth/access_token";

function isConfigured() {
  return !!(process.env.VERCEL_CLIENT_ID && process.env.VERCEL_CLIENT_SECRET);
}

/** Where Vercel sends the user back. Must match the redirect URI
    registered on the integration exactly, including scheme and port. */
function redirectUri() {
  const base = (process.env.PUBLIC_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
  return base + "/api/integrations/vercel/callback";
}

/**
 * The URL to send a user to in order to connect their Vercel account.
 * `state` is a signed, single-use value the caller stores — it is what
 * ties the callback back to a specific workspace and is the CSRF
 * defence for the whole flow. Without it, anyone could hit the callback
 * with their own code and attach their Vercel account to someone
 * else's workspace.
 */
function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.VERCEL_CLIENT_ID,
    redirect_uri: redirectUri(),
    state: state
  });
  return OAUTH_AUTHORIZE + "?" + params.toString();
}

function newState() {
  return crypto.randomBytes(24).toString("base64url");
}

/** Exchanges the one-time code for an access token. */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: process.env.VERCEL_CLIENT_ID,
    client_secret: process.env.VERCEL_CLIENT_SECRET,
    code: code,
    redirect_uri: redirectUri()
  });
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    // Deliberately does not echo the response body — a failed token
    // exchange can contain the code or client_secret back verbatim.
    throw new Error("Vercel rejected the authorization (HTTP " + res.status + ")");
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("Vercel returned no access token");
  return {
    accessToken: json.access_token,
    // Present when the user installs onto a Vercel Team rather than a
    // personal account; every later API call must carry it or it
    // resolves against the wrong scope.
    teamId: json.team_id || null,
    userId: (json.installation_id || null)
  };
}

/** Never let a token reach a log line or an HTTP response. */
function deployError(status, detail) {
  const safe = String(detail || "").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
  return new Error("Vercel deployment failed (HTTP " + status + "): " + safe.slice(0, 300));
}

/**
 * Creates a deployment from already-built static files.
 *
 * `files` is the same { path: base64 } map the browser's WebContainer
 * produces for self-hosted publishing — the build has already happened
 * client-side, so this is an upload, not a build. `outputDirectory: null`
 * with no framework tells Vercel to serve them as-is rather than trying
 * to detect and re-run a build it has no source for.
 */
async function deployFiles(conn, name, files) {
  const inlineFiles = Object.keys(files).map((p) => ({
    file: p,
    data: files[p],
    encoding: "base64"
  }));
  if (!inlineFiles.length) throw new Error("nothing to deploy — the build produced no files");

  const qs = conn.teamId ? "?teamId=" + encodeURIComponent(conn.teamId) : "";
  const res = await fetch(VERCEL_API + "/v13/deployments" + qs, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + conn.accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: name,
      files: inlineFiles,
      target: "production",
      projectSettings: { framework: null, buildCommand: null, outputDirectory: null }
    })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw deployError(res.status, (json && json.error && json.error.message) || "");
  }
  // `url` comes back without a scheme.
  return {
    url: json.url ? "https://" + json.url : null,
    inspectorUrl: json.inspectorUrl || null,
    id: json.id || null
  };
}

/** Confirms a stored token still works, so the UI can show a real
    connection state instead of assuming one that may have been revoked
    on Vercel's side. */
async function whoami(conn) {
  const qs = conn.teamId ? "?teamId=" + encodeURIComponent(conn.teamId) : "";
  const res = await fetch(VERCEL_API + "/v2/user" + qs, {
    headers: { "Authorization": "Bearer " + conn.accessToken }
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  return (json && json.user) ? { username: json.user.username || json.user.name || null } : null;
}

module.exports = { isConfigured, authorizeUrl, newState, exchangeCode, deployFiles, whoami, redirectUri };
