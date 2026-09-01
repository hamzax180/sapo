/* =================================================================
   scripts/provision.js — create the Hetzner host (Phase 2)
   -----------------------------------------------------------------
   Creating a server costs real money every hour it exists, so this
   script does NOTHING by default. It prints exactly what it would
   create, with the monthly price, and stops. Only --create actually
   provisions.

   Everything it does is idempotent and label-scoped: re-running finds
   the existing firewall rather than making a second one, and every
   resource is tagged platform=souqi so nothing else in your Hetzner
   project can be touched by mistake.

     node scripts/provision.js            # plan only
     node scripts/provision.js --create   # actually create
     node scripts/provision.js --status   # what exists now
   ================================================================= */
"use strict";

const { cfg } = require("../src/config");
const hetzner = require("../src/providers/hetzner");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function die(msg) { console.error("\n" + msg + "\n"); process.exit(1); }
const line = () => console.log("─".repeat(64));

async function preflight() {
  if (!hetzner.isConfigured()) {
    die("HETZNER_TOKEN is not set.\n" +
        "  Create a read/write API token: Hetzner Console -> Security -> API tokens\n" +
        "  Then: echo 'HETZNER_TOKEN=...' >> deploy/.env");
  }

  // Prove the token works before anything else, so a bad token fails in two
  // seconds rather than halfway through provisioning.
  let keys;
  try { keys = await hetzner.listSshKeys(); }
  catch (e) { die("Could not reach the Hetzner API: " + e.message); }

  if (!keys.length) {
    die("No SSH keys in this Hetzner project.\n" +
        "  A server created without one would only be reachable by a root password\n" +
        "  emailed in plain text, which is exactly what the spec rules out.\n\n" +
        "  Upload your public key: Hetzner Console -> Security -> SSH keys");
  }

  const chosen = cfg.hetzner.sshKeyId
    ? keys.find((k) => k.id === String(cfg.hetzner.sshKeyId))
    : keys[0];
  if (!chosen) {
    die("HETZNER_SSH_KEY_ID=" + cfg.hetzner.sshKeyId + " is not in this project.\n" +
        "  Available: " + keys.map((k) => k.id + " (" + k.name + ")").join(", "));
  }
  return { keys, chosen };
}

async function plan() {
  const { keys, chosen } = await preflight();

  let types = [];
  try { types = await hetzner.listServerTypes(); } catch (e) { /* pricing is a nicety */ }
  const t = types.find((x) => x.name === cfg.hetzner.serverType);

  line();
  console.log("PLAN — nothing has been created");
  line();
  console.log("  server name    souqi-deploy-1");
  console.log("  type           " + cfg.hetzner.serverType +
    (t ? "  (" + t.cores + " vCPU, " + t.memoryGb + "GB RAM, " + t.diskGb + "GB disk)" : ""));
  console.log("  image          " + cfg.hetzner.image + "   (Docker + Compose preinstalled)");
  console.log("  location       " + cfg.hetzner.location);
  console.log("  ssh key        " + chosen.id + " (" + chosen.name + ")");
  console.log("  firewall       souqi-deploy — inbound 22, 80, 443, icmp; nothing else");
  console.log("  cloud-init     password auth off, root login key-only, ufw enabled,");
  console.log("                 docker log rotation, /opt/platform/builds created");
  if (t && t.priceMonthly) {
    console.log("");
    console.log("  cost           EUR " + t.priceMonthly + " / month, billed hourly from creation");
  }
  line();

  if (t && Number(t.memoryGb) < 8) {
    console.log("  NOTE: " + t.memoryGb + "GB is below the 8GB the spec asks for. At 512MB per");
    console.log("        app that is roughly " + Math.floor((Number(t.memoryGb) * 1024 - 1500) / 512) +
                " apps before admission control starts refusing");
    console.log("        deploys. Set HETZNER_SERVER_TYPE to something larger if that is tight.");
    line();
  }

  console.log("\n  To create it:  node scripts/provision.js --create\n");
  return { chosen };
}

async function create() {
  const { chosen } = await preflight();

  console.log("\nEnsuring the firewall...");
  const fw = await hetzner.ensureFirewall("souqi-deploy");
  console.log("  firewall " + fw.id + " (" + (fw.created ? "created" : "already existed") + ")");

  // Re-running must not quietly create a second server; the label filter is
  // what makes that check safe.
  const existing = await hetzner.listServers();
  const already = existing.find((s) => s.name === "souqi-deploy-1");
  if (already) {
    console.log("\n  souqi-deploy-1 already exists: " + already.publicIp + " (" + already.status + ")");
    console.log("  Nothing to do. To replace it, delete it first.\n");
    return already;
  }

  console.log("\nCreating the server...");
  const server = await hetzner.createServer({
    name: "souqi-deploy-1",
    sshKeyId: chosen.id,
    firewallId: fw.id
  });
  console.log("  id " + server.id + " — waiting for boot");

  const ready = await hetzner.waitForRunning(server.id, 240000);

  line();
  console.log("READY");
  line();
  console.log("  ip       " + ready.publicIp);
  console.log("  ssh      ssh root@" + ready.publicIp);
  console.log("");
  console.log("  Next:");
  console.log("    1. Point *." + (cfg.appDomain === "localhost" ? "yourdomain.com" : cfg.appDomain) +
              "  A  " + ready.publicIp);
  console.log("    2. bash scripts/ship.sh " + ready.publicIp);
  line();
  console.log("\n  cloud-init takes another minute or two after boot. If ship.sh");
  console.log("  reports docker missing, wait and re-run it — it is idempotent.\n");
  return ready;
}

async function status() {
  await preflight();
  const servers = await hetzner.listServers();
  line();
  console.log("SERVERS labelled platform=souqi");
  line();
  if (!servers.length) {
    console.log("  none");
  } else {
    for (const s of servers) {
      console.log("  " + s.name.padEnd(20) + s.status.padEnd(12) + (s.publicIp || "-").padEnd(16) +
        (s.cpuCores ? s.cpuCores + " vCPU / " + Math.round(s.memoryMb / 1024) + "GB" : ""));
    }
  }
  line();
}

async function main() {
  try {
    if (has("--status")) return await status();
    if (has("--create")) return await create();
    await plan();
  } catch (e) {
    die("Failed: " + e.message);
  }
}

main();
