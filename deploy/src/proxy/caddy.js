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

// Where the admin API listens. NOT 0.0.0.0: Caddy joins the app networks in
// order to proxy to user containers, and a wildcard bind would put the admin
// API on an interface every untrusted container can reach — which is enough
// to re-route any hostname on the platform. Must match docker-compose.yml.
const ADMIN_LISTEN = process.env.CADDY_ADMIN_LISTEN ||
  ((process.env.CADDY_ADMIN_IP || "10.89.0.10") + ":2019");

// Host values the admin API will answer to. "caddy:2019" is the compose
// service name the api and worker dial. This is a compatibility check, not
// a security control — a Host header is trivially forged, so the bind
// address above is what actually keeps user containers out.
const ADMIN_ORIGINS = ["caddy:2019", ADMIN_LISTEN, "localhost:2019", "127.0.0.1:2019", "[::1]:2019"];

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
      // Origin is explicit because Caddy guards a non-loopback admin endpoint
      // with an origin allowlist, and Node's fetch sends Sec-Fetch-Mode: cors
      // with no Origin header — which Caddy reads as the empty origin and
      // refuses with 403, rather than falling back to Host the way curl and
      // wget get to. Sending it ourselves does not depend on that fallback.
      headers: Object.assign(
        { Origin: cfg.caddyAdmin },
        body ? { "Content-Type": "application/json" } : null
      ),
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
/**
 * The control-plane route: one hostname, straight to this api.
 *
 * It lives in the base config rather than being POSTed like an app route,
 * because app routes come and go with deployments and this must not. A
 * /load replaces the routes array wholesale, so anything added separately
 * would vanish the next time the api restarted.
 *
 * First in the array on purpose. Caddy matches routes in order, and a
 * deployment can never own this hostname anyway — generated names are
 * app-<id>.<appDomain> — but ordering makes that structural rather than a
 * property of the naming scheme someone might later change.
 *
 * There is no auth here. Caddy is a router; the token check belongs in the
 * api, where a constant-time compare and a real 401 body are possible.
 */
function controlRoute(domain, apiPort) {
  return {
    "@id": "route_control_plane",
    match: [{ host: [domain] }],
    handle: [{
      handler: "reverse_proxy",
      upstreams: [{ dial: "api:" + apiPort }],
      headers: {
        request: {
          set: {
            "X-Forwarded-Proto": ["{http.request.scheme}"],
            "X-Forwarded-Host": ["{http.request.host}"],
            "X-Real-IP": ["{http.request.remote.host}"]
          }
        }
      }
    }]
  };
}

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
    // Caddy enforces an origin allowlist on any admin endpoint that is not
    // on loopback, and the check is against the request's Host header. The
    // api and worker reach it cross-container as "caddy:2019", so without
    // this every route call comes back 403 and no app is ever routable.
    admin: { listen: ADMIN_LISTEN, origins: ADMIN_ORIGINS },
    apps: {
      http: {
        servers: {
          [SERVER]: {
            listen: [":80", ":443"],
            routes: cfg.controlDomain
              ? [controlRoute(cfg.controlDomain, cfg.apiPort)]
              : [],
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

module.exports = { addRoute, removeRoute, listRoutes, health, applyBaseConfig, baseConfig, controlRoute };
