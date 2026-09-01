/* =================================================================
   config.js — one place that reads the environment
   -----------------------------------------------------------------
   Everything else imports from here, so a missing variable surfaces
   as one clear startup failure rather than `undefined` leaking into
   a docker command line halfway through a build.
   ================================================================= */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

const cfg = {
  databaseUrl: process.env.DATABASE_URL || "postgres://souqi:souqi@localhost:5432/souqi_deploy",

  appDomain: (process.env.APP_DOMAIN || "localhost").toLowerCase(),
  acmeEmail: process.env.ACME_EMAIL || "",
  caddyAdmin: (process.env.CADDY_ADMIN || "http://localhost:2019").replace(/\/+$/, ""),

  buildRoot: process.env.BUILD_ROOT || "/opt/platform/builds",

  // Defaults only. Each deployment row stores its own limits, so changing
  // these never resizes anything already running.
  defaults: {
    cpu: num("DEFAULT_CPU", 0.5),
    memoryMb: num("DEFAULT_MEMORY_MB", 512),
    pids: num("DEFAULT_PIDS", 100)
  },

  admission: {
    maxContainers: num("MAX_CONTAINERS", 40),
    maxMemoryPct: num("MAX_MEMORY_PCT", 80),
    maxDiskPct: num("MAX_DISK_PCT", 80)
  },

  secretKey: process.env.SECRET_KEY || "",

  // Sessions. Shared with the main app on purpose: same sq_session JWT,
  // same secret, so being signed in to Souqi means being signed in here.
  jwtSecret: process.env.JWT_SECRET || "dev-insecure-secret",
  // Where to ask whether a session has been revoked. The main app owns the
  // sessionEpoch that answers it; this service cannot read that store.
  authIntrospectUrl: process.env.AUTH_INTROSPECT_URL || "",
  // Shared secret for platform-to-platform calls that have no user behind
  // them (the Caddy TLS ask endpoint, health probes).
  internalToken: process.env.INTERNAL_TOKEN || "",
  // Trusts an x-user-id header. Refuses to boot alongside NODE_ENV=production.
  allowDevAuth: process.env.ALLOW_DEV_AUTH === "1",

  s3: {
    endpoint: process.env.S3_ENDPOINT || "",
    bucket: process.env.S3_BUCKET || "",
    accessKey: process.env.S3_ACCESS_KEY || "",
    secretKey: process.env.S3_SECRET_KEY || ""
  },

  hetzner: {
    token: process.env.HETZNER_TOKEN || "",
    location: process.env.HETZNER_LOCATION || "nbg1",
    serverType: process.env.HETZNER_SERVER_TYPE || "cx32",
    image: process.env.HETZNER_IMAGE || "docker-ce",
    sshKeyId: process.env.HETZNER_SSH_KEY_ID || ""
  },

  // The user-container network. Created with --internal so containers on it
  // cannot reach the internet OR the host — only Caddy, which is attached to
  // both this and the platform network, can reach them.
  appNetwork: "souqi_apps",
  hostId: process.env.HOST_ID || "local",
  apiPort: num("API_PORT", 4500)
};

/** Fails loudly at boot rather than at the first encrypted write. */
function assertProductionReady() {
  const problems = [];
  if (!/^[0-9a-fA-F]{64}$/.test(cfg.secretKey)) {
    problems.push("SECRET_KEY must be 64 hex chars (openssl rand -hex 32)");
  }
  if (cfg.appDomain === "localhost") {
    problems.push("APP_DOMAIN is still localhost — HTTPS certificates cannot be issued");
  }
  if (!cfg.acmeEmail) {
    problems.push("ACME_EMAIL is unset — Let's Encrypt needs a contact address");
  }
  if (!cfg.s3.bucket) {
    problems.push("S3_BUCKET is unset — source archives would live only on the VM");
  }
  return problems;
}

module.exports = { cfg, assertProductionReady };
