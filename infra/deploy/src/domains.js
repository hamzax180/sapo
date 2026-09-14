/* =================================================================
   domains.js — what a user is allowed to call their app
   -----------------------------------------------------------------
   Until now every hostname was machine-generated:

     const domain = "app-" + id.split("_")[1].slice(0, 12) + "." + appDomain;

   and the comment above that line is the reason this file exists — the
   name "inherits the same character set [as the id] and can never
   contain anything a DNS label disallows". Once a person types the
   label instead, that guarantee is gone and has to be re-established
   here, before the value reaches Postgres, Caddy or a certificate
   request.

   Two separate jobs, and only the first is cosmetic:

     1. Is it a legal DNS label? Wrong answers produce a route Caddy
        cannot match and a certificate request that fails.

     2. Is it a label this platform is allowed to hand out? That one is
        a security question. config.js's assertProductionReady refuses a
        CONTROL_DOMAIN starting with "app-" precisely because generated
        names always start that way, so the two namespaces could never
        collide. A user-chosen label breaks that reasoning unless the
        reserved set below puts it back.

   Taking "deploy" on souqi.site would put a tenant's container on the
   hostname the platform's own control plane answers on.
   ================================================================= */
"use strict";

/** One DNS label: 1-63 chars, alphanumeric, inner hyphens only. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Names no tenant may take.
 *
 * Split by why, because the two halves age differently: the first is
 * infrastructure that already exists or is one decision away, the
 * second is ordinary namespace hygiene.
 */
const RESERVED = new Set([
  // platform surfaces
  "deploy", "api", "admin", "console", "dashboard", "internal", "control",
  "auth", "login", "signup", "account", "accounts", "billing", "pay",
  "checkout", "status", "health", "metrics", "monitor",
  // things a mail or DNS provider will want later
  "www", "mail", "smtp", "imap", "pop", "ns", "ns1", "ns2", "mx", "autodiscover",
  // brand and docs
  "souqi", "app", "apps", "static", "cdn", "assets", "media", "img", "images",
  "blog", "docs", "help", "support", "about", "legal", "terms", "privacy"
]);

/**
 * Validate a user-chosen subdomain label.
 *
 * @param {string} raw       what the user typed
 * @param {string} appDomain cfg.appDomain, e.g. "souqi.site"
 * @param {string} control   cfg.controlDomain, e.g. "deploy.souqi.site" ("" when unset)
 * @returns {{ok:true, label:string} | {ok:false, error:string}}
 */
function validateSubdomain(raw, appDomain, control) {
  const label = String(raw == null ? "" : raw).trim().toLowerCase();

  if (!label) return { ok: false, error: "choose a name for your app" };
  if (label.length < 3) return { ok: false, error: "a name needs at least 3 characters" };
  if (label.length > 63) return { ok: false, error: "a name can be at most 63 characters" };
  if (!LABEL.test(label)) {
    return { ok: false, error: "use lowercase letters, numbers and hyphens — and don't start or end with a hyphen" };
  }
  // xn-- is the IDNA prefix. Letting one through would let a tenant claim
  // a hostname that renders as somebody else's name in a browser.
  if (label.startsWith("xn--")) {
    return { ok: false, error: "that prefix is reserved" };
  }
  // The generated namespace. Reserving it keeps "is this name generated
  // or chosen?" answerable from the string alone, which is what
  // assertProductionReady's control-domain check relies on.
  if (label.startsWith("app-")) {
    return { ok: false, error: "names starting with \"app-\" are reserved for automatic addresses" };
  }
  if (RESERVED.has(label)) {
    return { ok: false, error: "\"" + label + "\" is reserved — try something more specific to your app" };
  }
  // Belt and braces: if the control plane lives on this same zone, its
  // own label must be unavailable even if the list above drifts.
  if (control) {
    const controlLabel = String(control).toLowerCase().split(".")[0];
    const suffix = "." + String(appDomain || "").toLowerCase();
    if (String(control).toLowerCase().endsWith(suffix) && label === controlLabel) {
      return { ok: false, error: "\"" + label + "\" is reserved" };
    }
  }
  return { ok: true, label: label };
}

/** The full hostname a label resolves to. */
function hostnameFor(label, appDomain) {
  return label + "." + appDomain;
}

/** The generated fallback, unchanged from what POST /deployments always did. */
function generatedHostname(deploymentId, appDomain) {
  return "app-" + String(deploymentId).split("_")[1].slice(0, 12) + "." + appDomain;
}

/** A whole custom domain, e.g. shop.example.com. Shape only — NOT ownership. */
const FQDN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function validateCustomDomain(raw, appDomain) {
  const d = String(raw == null ? "" : raw).trim().toLowerCase().replace(/\.$/, "");
  if (!d) return { ok: false, error: "enter a domain, e.g. shop.yourbrand.com" };
  if (d.length > 253) return { ok: false, error: "that domain is too long" };
  if (!FQDN.test(d)) return { ok: false, error: "that doesn't look like a domain (e.g. shop.yourbrand.com)" };
  // Our own zone is handed out by the subdomain field, not this one.
  // Allowing it here would be a second, unverified route to a hostname
  // the platform already owns.
  const suffix = "." + String(appDomain || "").toLowerCase();
  if (d === String(appDomain || "").toLowerCase() || d.endsWith(suffix)) {
    return { ok: false, error: "use the app name field for " + appDomain + " addresses" };
  }
  return { ok: true, domain: d };
}

/**
 * Every hostname a deployment should answer on.
 *
 * The custom domain is included ONLY when verified, deliberately the same
 * condition /internal/tls-ask applies. The two must agree: routing a hostname
 * we would refuse a certificate for produces an app that answers on :80 and
 * fails on :443, which is worse than not routing it at all.
 *
 * Every caddy.addRoute / removeRoute call goes through this rather than
 * reading dep.domain directly, so a site cannot quietly handle the generated
 * hostname and forget the custom one.
 */
function hostnamesFor(dep) {
  const out = [];
  if (dep && dep.domain) out.push(String(dep.domain).toLowerCase());
  if (dep && dep.custom_domain && dep.custom_domain_verified) {
    out.push(String(dep.custom_domain).toLowerCase());
  }
  return out;
}

module.exports = {
  validateSubdomain, validateCustomDomain, hostnameFor, generatedHostname,
  hostnamesFor, RESERVED, LABEL, FQDN
};
