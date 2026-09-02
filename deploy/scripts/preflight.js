/* =================================================================
   scripts/preflight.js — check .env before it reaches a public host
   -----------------------------------------------------------------
   Every finding here is something that is survivable locally and not
   survivable on a box with a public IP. Missing values are the easy
   half; the ones that matter are the values that are present but
   wrong — a dev default that got shipped, a JWT_SECRET that does not
   match the main app, two secrets that are the same string.

     node scripts/preflight.js
     node scripts/preflight.js --generate   # fill EMPTY secrets only

   Exit code is 1 on any error, so ship.sh can gate on it.
   ================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* -------------------------------------------------------------- */

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const eq = l.indexOf("=");
    if (eq === -1) continue;
    // Strip surrounding quotes: people paste them in, and the value that
    // reaches Docker keeps them, which turns a valid hex key into garbage.
    let v = l.slice(eq + 1).trim();
    if (v.length > 1 && /^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    out[l.slice(0, eq).trim()] = v;
  }
  return out;
}

const HEX32 = /^[0-9a-fA-F]{64}$/;
// Values that appear in .env.example, the README or the compose defaults.
// Shipping any of them means the secret is public.
const KNOWN_DEFAULTS = new Set([
  "souqi", "changeme", "change-me", "secret", "password", "postgres",
  "dev", "development", "test", "souqi-dev-secret", "your-secret-here"
]);

function checkSecret(env, key, label) {
  const v = env[key];
  if (!v) { err(key + " is empty. " + label); return; }
  if (KNOWN_DEFAULTS.has(v.toLowerCase())) {
    err(key + " is a well-known default value (\"" + v + "\"). Anyone can guess it.");
    return;
  }
  if (!HEX32.test(v)) {
    warn(key + " is not 32 bytes of hex (" + v.length + " chars). " +
         "It will work, but openssl rand -hex 32 is the format the rest of the stack assumes.");
  }
}

/* -------------------------------------------------------------- */

function run() {
  if (!fs.existsSync(ENV_PATH)) {
    err(".env does not exist. Start from .env.example:  cp .env.example .env");
    return report({});
  }

  const env = parseEnv(fs.readFileSync(ENV_PATH, "utf8"));

  // --- secrets ---------------------------------------------------
  checkSecret(env, "SECRET_KEY", "It encrypts project env vars at rest; without it they cannot be stored.");
  checkSecret(env, "INTERNAL_TOKEN", "It guards the Caddy TLS-ask endpoint.");

  const jwt = env.JWT_SECRET;
  if (!jwt) {
    err("JWT_SECRET is empty. It must be COPIED from the main app (server/.env), " +
        "not generated — a different value rejects every session the main app issues.");
  } else if (KNOWN_DEFAULTS.has(jwt.toLowerCase()) || jwt.length < 32) {
    err("JWT_SECRET looks like a development value. In production the API refuses to boot on this.");
  }

  // Reusing one string for two purposes means one leak compromises both.
  const secrets = ["SECRET_KEY", "JWT_SECRET", "INTERNAL_TOKEN", "POSTGRES_PASSWORD"]
    .map((k) => [k, env[k]]).filter(([, v]) => v);
  for (let i = 0; i < secrets.length; i++) {
    for (let j = i + 1; j < secrets.length; j++) {
      if (secrets[i][1] === secrets[j][1]) {
        err(secrets[i][0] + " and " + secrets[j][0] + " are the same string. Give each its own value.");
      }
    }
  }

  // --- database --------------------------------------------------
  const pw = env.POSTGRES_PASSWORD;
  if (!pw) {
    err("POSTGRES_PASSWORD is empty, so compose falls back to \"souqi\".");
  } else if (KNOWN_DEFAULTS.has(pw.toLowerCase())) {
    err("POSTGRES_PASSWORD is a default value. Replace it:  openssl rand -hex 24");
  } else if (pw.length < 16) {
    warn("POSTGRES_PASSWORD is short (" + pw.length + " chars).");
  }

  // --- domain and TLS --------------------------------------------
  const domain = env.APP_DOMAIN;
  if (!domain || domain === "localhost") {
    err("APP_DOMAIN is " + (domain ? "localhost" : "empty") +
        ". Caddy cannot obtain a certificate for that, so every app URL fails TLS.");
  } else if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    err("APP_DOMAIN=\"" + domain + "\" is not a hostname.");
  } else if (domain.startsWith("*.")) {
    err("APP_DOMAIN must be the zone itself (example.com), not the wildcard. " +
        "The wildcard belongs in DNS, not here.");
  }

  const email = env.ACME_EMAIL;
  if (!email) {
    err("ACME_EMAIL is empty. Let's Encrypt needs it, and it is where expiry warnings go.");
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    err("ACME_EMAIL=\"" + email + "\" is not an email address.");
  }

  // --- boot guards -----------------------------------------------
  if (String(env.ALLOW_DEV_AUTH || "0") === "1") {
    err("ALLOW_DEV_AUTH=1 trusts an x-user-id header instead of a session. " +
        "On a public host that lets anyone deploy as anyone.");
  }
  if (env.NODE_ENV !== "production") {
    // Advisory locally, blocking when ship.sh runs it: production is what
    // turns the auth boot guards in src/api/auth.js from warnings into a
    // refusal to start, and a public host wants the refusal.
    const msg = "NODE_ENV is \"" + (env.NODE_ENV || "unset") + "\". On a public host it must be " +
                "production — that is what makes the auth boot guards fatal instead of advisory.";
    if (process.env.PREFLIGHT_TARGET === "server") err(msg); else warn(msg);
  }

  // --- revocation ------------------------------------------------
  const introspect = env.AUTH_INTROSPECT_URL;
  if (!introspect) {
    warn("AUTH_INTROSPECT_URL is unset. Sessions are checked for signature and expiry only, " +
         "so \"sign out other sessions\" does not reach this plane and a revoked token keeps " +
         "working until it expires (up to 12h).");
  } else if (/localhost|127\.0\.0\.1/.test(introspect)) {
    err("AUTH_INTROSPECT_URL points at localhost (" + introspect + "). " +
        "From inside the container that is the container itself, so every revocation check fails.");
  } else if (introspect.startsWith("http://")) {
    warn("AUTH_INTROSPECT_URL is plain http. Session ids will cross the network in the clear.");
  }

  // --- durability ------------------------------------------------
  if (!env.S3_BUCKET) {
    warn("S3_* is unset, so user source archives stay on this VM. Losing the box loses source. " +
         "scripts/backup.sh covers the database, not the archives.");
  }

  // --- networking ------------------------------------------------
  // caddy/caddy.json is plain JSON and cannot read an environment variable,
  // so if the admin IP is overridden in .env the bootstrap file has to be
  // edited to match. When they disagree Caddy cannot bind, crash-loops, and
  // nothing on the platform is routable — worth catching here rather than
  // in the logs of a host that has just gone dark.
  const adminIp = env.CADDY_ADMIN_IP || "10.89.0.10";
  const subnet = env.PLATFORM_SUBNET || "10.89.0.0/24";
  try {
    const bootPath = path.join(ROOT, "caddy", "caddy.json");
    const boot = JSON.parse(fs.readFileSync(bootPath, "utf8"));
    const listen = String((boot.admin && boot.admin.listen) || "");
    if (/^(0\.0\.0\.0|::|\[::\]):/.test(listen)) {
      err("caddy/caddy.json binds the admin API to " + listen + ". Caddy joins every app " +
          "network to proxy to containers, so a wildcard bind exposes the admin API — and " +
          "with it the power to re-route any hostname — to every user container.");
    } else if (listen !== adminIp + ":2019") {
      err("caddy/caddy.json binds " + listen + " but CADDY_ADMIN_IP is " + adminIp +
          ". Caddy cannot bind an address it does not have, so it would crash-loop.");
    }
  } catch (e) {
    err("caddy/caddy.json is missing or not valid JSON — Caddy has no bootstrap config.");
  }

  // The admin IP has to sit inside the platform subnet, or compose refuses
  // to assign it.
  const base = subnet.split("/")[0].split(".").slice(0, 3).join(".");
  if (!adminIp.startsWith(base + ".")) {
    err("CADDY_ADMIN_IP=" + adminIp + " is outside PLATFORM_SUBNET=" + subnet + ".");
  }

  // Every deployment gets its own docker network. Docker's built-in address
  // pools top out around 31 networks, and once they are gone every deploy
  // fails at network creation.
  const maxContainers = Number(env.MAX_CONTAINERS || 40);
  if (maxContainers > 25) {
    warn("MAX_CONTAINERS=" + maxContainers + " and each deployment takes its own docker " +
         "network. Docker's default address pools allow roughly 31 networks in total, so " +
         "the host needs default-address-pools in /etc/docker/daemon.json (provision.js " +
         "writes 10.200.0.0/16 size 24, giving 256). Without it, deploys start failing at " +
         "network creation once the pool runs out.");
  }

  // --- the file itself -------------------------------------------
  if (!envIsIgnored()) {
    err(".env is not gitignored. It holds every secret on this host, and the " +
        "next `git add -A` would commit it. Add `deploy/.env` to .gitignore.");
  }

  report(env);
}

/**
 * git is the authority on this, because the rule can live in the repo root,
 * in deploy/, or in .git/info/exclude — and a text scan of one file would
 * report a false blocker for a .env that is in fact ignored.
 */
function envIsIgnored() {
  try {
    const { execFileSync } = require("child_process");
    execFileSync("git", ["check-ignore", "-q", ENV_PATH], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch (e) {
    // Exit 1 means "not ignored" and is a real answer; anything else (git
    // missing, not a repo — both normal on the server) is not, so fall back.
    if (e && e.status === 1) return false;
  }
  for (const f of [path.join(ROOT, ".gitignore"), path.join(ROOT, "..", ".gitignore")]) {
    if (fs.existsSync(f) && /^\s*(deploy\/)?\.env\s*$/m.test(fs.readFileSync(f, "utf8"))) return true;
  }
  return false;
}

function report(env) {
  const line = "─".repeat(64);
  console.log("\n" + line);
  console.log("PREFLIGHT  " + ENV_PATH);
  console.log(line);

  if (!errors.length && !warnings.length) {
    console.log("\n  All checks passed.\n");
  }
  if (errors.length) {
    console.log("\n\x1b[31mBLOCKING (" + errors.length + ")\x1b[0m\n");
    errors.forEach((e, i) => console.log("  " + (i + 1) + ". " + e + "\n"));
  }
  if (warnings.length) {
    if (errors.length === 0) console.log("");
    console.log("\x1b[33mWARNINGS (" + warnings.length + ")\x1b[0m — will ship, worth knowing\n");
    warnings.forEach((w, i) => console.log("  " + (i + 1) + ". " + w + "\n"));
  }
  console.log(line + "\n");

  if (errors.length) {
    console.log("  Fix the blocking items, then re-run. To fill empty secrets:");
    console.log("    node scripts/preflight.js --generate\n");
    process.exit(1);
  }
}

/* -------------------------------------------------------------- */

function generate() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error("\n  .env does not exist yet.  cp .env.example .env\n");
    process.exit(1);
  }
  let text = fs.readFileSync(ENV_PATH, "utf8");
  const env = parseEnv(text);
  const filled = [];

  // Only ever fills a value that is EMPTY. Overwriting a live SECRET_KEY
  // would make every stored env var undecryptable, and overwriting
  // JWT_SECRET would sign out every user of the main app.
  for (const [key, bytes] of [["SECRET_KEY", 32], ["INTERNAL_TOKEN", 32], ["POSTGRES_PASSWORD", 24]]) {
    if (env[key]) continue;
    const value = crypto.randomBytes(bytes).toString("hex");
    const re = new RegExp("^" + key + "=.*$", "m");
    text = re.test(text) ? text.replace(re, key + "=" + value) : text + "\n" + key + "=" + value;
    filled.push(key);
  }

  if (!filled.length) {
    console.log("\n  Nothing to fill — every generatable secret already has a value.");
    console.log("  This never overwrites one that is already set.\n");
    return;
  }

  fs.writeFileSync(ENV_PATH, text);
  try { fs.chmodSync(ENV_PATH, 0o600); } catch (e) { /* no-op on Windows */ }

  console.log("\n  Generated: " + filled.join(", "));
  if (!env.JWT_SECRET) {
    console.log("\n  JWT_SECRET was NOT generated, on purpose. Copy it from the main app:");
    console.log("    grep JWT_SECRET ../server/.env");
    console.log("  A fresh value would reject every session the main app issues.");
  }
  console.log("");
}

if (process.argv.includes("--generate")) generate();
else run();
