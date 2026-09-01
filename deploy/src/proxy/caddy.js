/* =================================================================
   proxy/caddy.js — routes, added and removed at runtime
   -----------------------------------------------------------------
   Caddy is configured through its admin API rather than a Caddyfile
   on disk, because deployments come and go constantly and rewriting
   a file plus reloading is both slower and racy under concurrent
   deploys. The admin API mutates one route at a time.

   Caddy obtains and renews a certificate per hostname on first
   request (on-demand TLS), which is what makes a wildcard DNS record
   plus arbitrary app-NNN subdomains work without pre-provisioning
   anything.

   The admin endpoint listens on the platform network only. It is
   never published to the internet: anyone who can reach it can route
   any hostname anywhere.
   ================================================================= */
"use strict";

const { cfg } = require("../config");

const SERVER = "srv0";           // the http server Caddy creates by default
const ROUTES = "/config/apps/http/servers/" + SERVER + "/routes";

async function api(method, path, body) {
  // Every network failure becomes a return value, never a throw. Caddy may
  // legitimately not be listening yet — compose depends_on waits for the
  // container, not for the admin API — and an unhandled rejection here
  // crashed the whole API at boot. A route that cannot be added is a
  // degraded deployment; it is not a reason to take the control plane down.
  let res;
  try {
    res = await fetch(cfg.caddyAdmin + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    return { ok: false, status: 0, error: "caddy unreachable: " + e.message };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, status: res.status, error: text.slice(0, 400) };
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* Caddy returns empty on PUT */ }
  return { ok: true, status: res.status, json };
}

/**
 * One route: this hostname goes to that container, by name, over the
 * internal app network. The upstream is a container name — Docker DNS
 * resolves it, and it is never an IP, so a container restart with a new
 * address needs no route update.
 */
function routeFor(domain, containerName, port) {
  return {
    "@id": "route_" + domain,
    match: [{ host: [domain] }],
    handle: [{
      handler: "reverse_proxy",
      upstreams: [{ dial: containerName + ":" + port }],
      headers: {
        request: {
          set: {
            // Without these the app sees Caddy as the client and generates
            // http:// links behind an https:// proxy.
            "X-Forwarded-Proto": ["{http.request.scheme}"],
            "X-Forwarded-Host": ["{http.request.host}"],
            "X-Real-IP": ["{http.request.remote.host}"]
          }
        }
      },
      // A container that is starting should read as "not ready yet", not as
      // a hard failure the user has to interpret.
      handle_response: []
    }]
  };
}

async function addRoute(domain, containerName, port) {
  await removeRoute(domain);                 // idempotent: redeploy replaces
  return api("POST", ROUTES, routeFor(domain, containerName, port));
}

async function removeRoute(domain) {
  const r = await api("DELETE", "/id/route_" + domain);
  // 404 means it was not there, which is the desired end state anyway.
  if (!r.ok && r.status !== 404) return r;
  return { ok: true };
}

async function listRoutes() {
  const r = await api("GET", ROUTES);
  return r.ok && Array.isArray(r.json) ? r.json : [];
}

async function health() {
  try {
    const r = await api("GET", "/config/");
    return r.ok;
  } catch (e) { return false; }
}

/**
 * The base config, applied once at startup. Everything after this is a
 * single-route POST.
 *
 * on_demand TLS is gated by an "ask" endpoint: before Caddy issues a
 * certificate for a hostname it asks the platform API whether that hostname
 * is a real deployment. Without that gate, anyone could point a DNS record
 * at this server and make it request certificates on their behalf, which is
 * both an abuse vector and a fast route to a Let-s-Encrypt rate limit.
 */
function baseConfig(askUrl) {
  const tls = {
    automation: {
      policies: [{
        on_demand: true,
        issuers: cfg.acmeEmail
          ? [{ module: "acme", email: cfg.acmeEmail }]
          : [{ module: "internal" }]        // local dev: self-signed
      }],
      on_demand: { permission: { module: "http", endpoint: askUrl } }
    }
  };
  return {
    admin: { listen: "0.0.0.0:2019" },
    apps: {
      http: {
        servers: {
          [SERVER]: {
            listen: [":80", ":443"],
            routes: [],
            automatic_https: { disable_redirects: false }
          }
        }
      },
      tls: tls
    }
  };
}

async function applyBaseConfig(askUrl) {
  return api("POST", "/load", baseConfig(askUrl));
}

module.exports = { addRoute, removeRoute, listRoutes, health, applyBaseConfig, baseConfig };
