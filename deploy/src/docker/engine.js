/* =================================================================
   docker/engine.js — every Docker call the platform makes
   -----------------------------------------------------------------
   Two rules this file exists to enforce:

   1. NO SHELL. Every call goes through execFile with an argv array,
      never a concatenated string. User-controlled values reach this
      module, and a single interpolated `docker run ... ${name}` through
      a shell would be command injection with root-equivalent power —
      the Docker socket IS root on the host.

   2. NO ESCALATION. runApp() is the only way a user container is ever
      started, and its flag list is fixed HERE rather than passed in. A
      caller cannot ask for --privileged, a socket mount, or host
      networking, because there is no parameter for any of them.

   The platform worker does talk to the Docker socket — that is what a
   control plane is. The invariant is that no USER container ever does.
   ================================================================= */
"use strict";

const { execFile } = require("child_process");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { cfg } = require("../config");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;

function docker(args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "docker", args,
      { timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: process.env },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.code === undefined ? 1 : err.code) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          timedOut: !!(err && err.killed)
        });
      }
    );
    // Streaming variant: the worker persists build output line by line
    // instead of waiting for a 10-minute build to finish before showing
    // the user anything.
    if (opts.onLine) {
      const feed = (buf, stream) => String(buf).split(/\r?\n/).forEach((l) => l && opts.onLine(l, stream));
      child.stdout && child.stdout.on("data", (b) => feed(b, "stdout"));
      child.stderr && child.stderr.on("data", (b) => feed(b, "stderr"));
    }
  });
}

/* ---------- names ----------
   Derived from the deployment id ONLY, never from user text, so a
   container name can never be anything but [a-zA-Z0-9_.-]. */
const containerName = (id) => "app-" + String(id).replace(/[^a-zA-Z0-9_.-]/g, "");
const imageName = (id) => "platform-app:" + String(id).replace(/[^a-zA-Z0-9_.-]/g, "");

/* ---------- network ----------
   ONE NETWORK PER DEPLOYMENT, and the reason is the spec line "never allow a
   user's application container to access other application containers".

   A single shared app network does not deliver that. --internal stops egress
   off the box, but it says nothing about traffic BETWEEN members: a Docker
   bridge lets any member dial any other member's container port directly, and
   embedded DNS will even resolve the other container's name. Nothing being
   published to the host is irrelevant — the containers are on the same L2.

   So each deployment gets its own --internal bridge whose only other member
   is Caddy, which is attached at deploy time. Two user containers are then
   never on a network together and have no route to each other at all. */
const networkName = (id) => "souqi_app_" + String(id).replace(/[^a-zA-Z0-9_.-]/g, "");

async function ensureDeploymentNetwork(deploymentId) {
  const net = networkName(deploymentId);
  const found = await docker(["network", "ls", "--filter", "name=^" + net + "$", "--format", "{{.Name}}"]);
  if (found.stdout.trim() === net) return { ok: true, existed: true, network: net };
  const made = await docker(["network", "create", "--driver", "bridge", "--internal",
    "--label", "souqi.managed=true", "--label", "souqi.deployment=" + deploymentId, net]);
  return { ok: made.ok, existed: false, network: net, error: made.stderr };
}

/** Attach the proxy to one app's network. Without this the app is unroutable. */
async function connectProxy(deploymentId) {
  const net = networkName(deploymentId);
  const r = await docker(["network", "connect", net, cfg.proxyContainer], { timeoutMs: 20000 });
  // Already-connected is success, not failure — redeploys re-run this.
  if (!r.ok && /already exists|already connected/i.test(r.stderr || "")) return { ok: true, existed: true };
  return { ok: r.ok, error: r.stderr };
}

/**
 * Attach the customer-data Postgres to one app's network.
 *
 * Same mechanism as connectProxy, and for the same reason: the database
 * container is on no network of its own, so this is the only way the app
 * can reach it — and reaching it is all the app can do, because it holds
 * credentials for exactly one database on that cluster.
 */
async function connectUserDb(deploymentId) {
  const net = networkName(deploymentId);
  const r = await docker(["network", "connect", net, cfg.userDbContainer], { timeoutMs: 20000 });
  if (!r.ok && /already exists|already connected/i.test(r.stderr || "")) return { ok: true, existed: true };
  return { ok: r.ok, error: r.stderr };
}

async function disconnectUserDb(deploymentId) {
  const net = networkName(deploymentId);
  const r = await docker(["network", "disconnect", "--force", net, cfg.userDbContainer], { timeoutMs: 20000 });
  // Not attached is the desired end state, not a failure.
  if (!r.ok && /not connected|no such|is not connected/i.test(r.stderr || "")) return { ok: true, existed: false };
  return { ok: r.ok, error: r.stderr };
}

/** Detach every platform member and drop the network. A network with a
    member will not delete, so the disconnects have to happen first —
    and that is now BOTH of them. Leaving the database attached is enough
    to make `network rm` fail with "has active endpoints", which would
    leak one dead network per deleted deployment. */
async function removeDeploymentNetwork(deploymentId) {
  const net = networkName(deploymentId);
  await docker(["network", "disconnect", "--force", net, cfg.proxyContainer], { timeoutMs: 20000 });
  await docker(["network", "disconnect", "--force", net, cfg.userDbContainer], { timeoutMs: 20000 });
  // And now three: an external-database forwarder is a member too, and one
  // held endpoint is enough to make `network rm` fail with "has active
  // endpoints" and leak a dead network per deleted deployment.
  await docker(["network", "disconnect", "--force", net, dbProxyName(deploymentId)], { timeoutMs: 20000 });
  return docker(["network", "rm", net], { timeoutMs: 20000 });
}

/* Kept for the boot path: the shared network still exists for Caddy itself,
   but no user container is placed on it any more. */
async function ensureAppNetwork() {
  const found = await docker(["network", "ls", "--filter", "name=^" + cfg.appNetwork + "$", "--format", "{{.Name}}"]);
  if (found.stdout.trim() === cfg.appNetwork) return { ok: true, existed: true };
  const made = await docker(["network", "create", "--driver", "bridge", "--internal", cfg.appNetwork]);
  return { ok: made.ok, existed: false, error: made.stderr };
}

/* ---------- build ----------
   docker build executes every user build step INSIDE a container. No user
   script ever runs on the host — that is the whole reason the platform
   generates a Dockerfile instead of shelling out to npm in the build dir. */
async function buildImage({ deploymentId, contextDir, onLine, timeoutMs }) {
  return docker([
    "build",
    "--tag", imageName(deploymentId),
    "--force-rm",
    contextDir
  ], { onLine, timeoutMs: timeoutMs || 15 * 60 * 1000 });
}

/* ---------- external database forwarder ----------
   An app's network is --internal, so a database out on the internet is
   unreachable from it. Dropping --internal would hand every app on the box
   unrestricted egress and invalidate the isolation this file exists to
   provide, so instead each deployment with an external database gets its own
   one-target TCP pipe.

   The forwarder sits on two networks: this deployment's --internal one, where
   it becomes the app's only route off-network, and an egress network of its
   own whose only member it is. It holds no credentials — the password stays
   in the app's environment, where it already was.

   It answers to the DATABASE'S OWN HOSTNAME as a network alias rather than a
   generic "dbproxy". That is the load-bearing choice: the app dials the exact
   name in its connection string, so TLS SNI and certificate verification
   still match and sslmode=verify-full keeps working. Rewriting the URL to
   point at a proxy hostname would break verification and invite people to
   downgrade to sslmode=require to make it work again — trading away the
   customer's transport security to accommodate our plumbing. */
const dbProxyName = (id) => "souqi-dbproxy-" + String(id).replace(/[^a-zA-Z0-9_.-]/g, "");
const egressNetworkName = (id) => "souqi_egress_" + String(id).replace(/[^a-zA-Z0-9_.-]/g, "");
const DBPROXY_IMAGE = "souqi-dbproxy:1";

/* Built here rather than pulled from a community socat image, so the only
   registry this platform trusts stays the one the app images already use.
   Pinning the alpine tag pins socat with it. */
async function ensureDbProxyImage() {
  const found = await docker(["image", "inspect", DBPROXY_IMAGE, "--format", "{{.Id}}"]);
  if (found.ok) return { ok: true, existed: true };

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "souqi-dbproxy-"));
  try {
    await fsp.writeFile(path.join(dir, "Dockerfile"), [
      "FROM alpine:3.20",
      "RUN apk add --no-cache socat",
      // nobody. The forwarder binds a high port, so it never needs root.
      "USER 65534:65534",
      'ENTRYPOINT ["/usr/bin/socat"]',
      ""
    ].join("\n"), "utf8");
    const built = await docker(["build", "--tag", DBPROXY_IMAGE, "--force-rm", dir],
      { timeoutMs: 5 * 60 * 1000 });
    return { ok: built.ok, existed: false, error: built.stderr };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

/** The one network on this host that is deliberately NOT --internal. Its only
    member is one deployment's forwarder; a shared egress network would put two
    tenants' forwarders on one L2 and undo exactly what the per-deployment app
    networks provide. */
async function ensureEgressNetwork(deploymentId) {
  const net = egressNetworkName(deploymentId);
  const found = await docker(["network", "ls", "--filter", "name=^" + net + "$", "--format", "{{.Name}}"]);
  if (found.stdout.trim() === net) return { ok: true, existed: true, network: net };
  const made = await docker(["network", "create", "--driver", "bridge",
    "--label", "souqi.managed=true", "--label", "souqi.deployment=" + deploymentId, net]);
  return { ok: made.ok, existed: false, network: net, error: made.stderr };
}

/**
 * The argv for a forwarder, as a pure function — same reason buildRunArgs is
 * one. scripts/verify.js asserts on this directly, so "the forwarder is
 * hardened and points at exactly one address" is checked without a daemon.
 *
 * `targetIp` is a resolved literal, never a name. If socat were given the
 * hostname it would ask Docker's embedded DNS, which on the app network
 * answers with the forwarder's own alias — the forwarder would dial itself.
 */
function buildDbProxyArgs({ deploymentId, host, targetIp, port, memoryMb, pids }) {
  const name = dbProxyName(deploymentId);
  const p = Number(port);

  return {
    name: name,
    args: [
      "run", "--detach",
      "--name", name,

      "--cpus", "0.25",
      "--memory", (memoryMb || 32) + "m",
      "--memory-swap", (memoryMb || 32) + "m",
      "--pids-limit", String(pids || 32),
      "--ulimit", "nofile=1024:2048",

      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--read-only",
      "--user", "65534:65534",

      "--network", egressNetworkName(deploymentId),
      // Nothing published, here as everywhere else in this file.
      "--restart", "unless-stopped",
      "--label", "souqi.managed=true",
      "--label", "souqi.deployment=" + deploymentId,
      "--label", "souqi.role=dbproxy",
      /* The name this forwarder is FOR, recorded on the container itself.
         It lets the reconcile loop re-resolve and notice a moved database
         without reading the project row or decrypting the URL to find out
         where it was supposed to point. */
      "--label", "souqi.dbhost=" + String(host || ""),
      "--label", "souqi.dbport=" + String(p),

      DBPROXY_IMAGE,
      // One listener, one target, both fixed when the container is created.
      "TCP-LISTEN:" + p + ",fork,reuseaddr",
      "TCP:" + targetIp + ":" + p
    ]
  };
}

async function runDbProxy({ deploymentId, host, targetIp, port }) {
  const img = await ensureDbProxyImage();
  if (!img.ok) return { ok: false, error: "could not build the forwarder image — " + (img.error || "") };

  const net = await ensureEgressNetwork(deploymentId);
  if (!net.ok) return { ok: false, error: "could not create the egress network — " + (net.error || "") };

  // A previous revision may still be running against a stale address.
  await removeDbProxy(deploymentId, { keepNetwork: true });

  const built = buildDbProxyArgs({ deploymentId, host: host, targetIp: targetIp, port: port });
  const res = await docker(built.args, { timeoutMs: 60000 });
  if (!res.ok) return { ok: false, error: res.stderr.trim() };

  /* The alias is the whole trick: it makes the app's UNCHANGED connection
     string resolve to the forwarder, inside this app's network only. */
  const joined = await docker(["network", "connect", "--alias", host,
    networkName(deploymentId), built.name], { timeoutMs: 20000 });
  if (!joined.ok && !/already exists|already connected/i.test(joined.stderr || "")) {
    return { ok: false, error: joined.stderr.trim() };
  }
  return { ok: true, name: built.name, target: targetIp + ":" + port };
}

async function removeDbProxy(deploymentId, opts) {
  const r = await docker(["rm", "--force", "--volumes", dbProxyName(deploymentId)], { timeoutMs: 30000 });
  if (!(opts && opts.keepNetwork)) {
    await docker(["network", "rm", egressNetworkName(deploymentId)], { timeoutMs: 20000 });
  }
  return { ok: true, removed: r.ok };
}

/** Every forwarder on this host, with the hostname it stands in for and the
    literal address it is currently dialling. Read from labels and argv, so no
    connection string has to be decrypted to answer "has this database
    moved?". */
async function listDbProxies() {
  const r = await docker(["ps", "--filter", "label=souqi.role=dbproxy", "--format",
    "{{.Label \"souqi.deployment\"}}\t{{.Label \"souqi.dbhost\"}}\t{{.Label \"souqi.dbport\"}}"]);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [deploymentId, host, port] = l.split("\t");
    return { deploymentId: deploymentId, host: host, port: Number(port) };
  }).filter((p) => p.deploymentId && p.host);
}

/** What address is this deployment's forwarder actually pointed at? Empty when
    there is no forwarder. Used by the reconcile loop to notice that a managed
    database has moved. */
async function dbProxyTarget(deploymentId) {
  const r = await docker(["inspect", "--format", "{{range .Args}}{{.}} {{end}}",
    dbProxyName(deploymentId)], { timeoutMs: 15000 });
  if (!r.ok) return null;
  const m = /TCP:([^\s:]+):(\d+)/.exec(r.stdout);
  return m ? { ip: m[1], port: Number(m[2]) } : null;
}

/* ---------- run ----------
   The hardened flag set. Every line here is load-bearing; read the comment
   before changing one. */
/**
 * The argv for a user container, as a pure function.
 *
 * Split out from runApp so the security properties can be asserted without
 * a Docker daemon: scripts/verify.js calls this directly and checks that no
 * --privileged, no socket mount, no published port and no host network can
 * appear, whatever it is handed. A guarantee you cannot test in CI is a
 * guarantee that quietly stops being true.
 */
function buildRunArgs({ deploymentId, port, cpu, memoryMb, pids, env, readOnly = true }) {
  const name = containerName(deploymentId);

  const args = [
    "run", "--detach",
    "--name", name,

    // Resource ceilings. memory-swap EQUAL to memory disables swap entirely:
    // without it a container at its limit silently swaps and drags the whole
    // host down instead of being OOM-killed in isolation.
    "--cpus", String(cpu),
    "--memory", memoryMb + "m",
    "--memory-swap", memoryMb + "m",
    "--pids-limit", String(pids),

    // A fork bomb is the cheapest denial of service there is, and pids-limit
    // is the only thing that stops it. nofile caps descriptor exhaustion.
    "--ulimit", "nofile=1024:2048",

    // no-new-privileges means even a setuid binary in the image cannot gain
    // capabilities. With cap-drop=ALL this removes the usual escape toolkit.
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",

    // This deployment's OWN --internal network: no route to the host, the
    // internet, the Docker API, or any other user container. Caddy is
    // attached separately and is the only other member.
    "--network", networkName(deploymentId),

    // NOTHING is published. There is no -p flag anywhere in this file.
    // The only path to an app is through the reverse proxy.

    "--restart", "unless-stopped",

    // Labels let the janitor tell platform containers from anything else on
    // the box, so cleanup can never touch something it did not create.
    "--label", "souqi.managed=true",
    "--label", "souqi.deployment=" + deploymentId
  ];

  if (readOnly) {
    // Immutable root filesystem. What the app genuinely needs to write goes
    // to a small noexec tmpfs that is gone on restart, so a compromised app
    // cannot persist anything.
    args.push("--read-only");
    args.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=64m");
    args.push("--tmpfs", "/run:rw,noexec,nosuid,size=8m");
    // nginx creates /var/cache/nginx/client_temp before it binds, so a
    // read-only root stopped every static site from starting at all:
    //   [emerg] mkdir() "/var/cache/nginx/client_temp" failed (30: ...)
    // The root stays immutable; this is scratch that vanishes on restart.
    // Costs nothing for the runtimes that never touch it.
    args.push("--tmpfs", "/var/cache/nginx:rw,noexec,nosuid,size=16m");
  }

  for (const [k, v] of Object.entries(env || {})) {
    // One argv element, so a value containing spaces, quotes or newlines
    // cannot break out into another flag.
    args.push("--env", k + "=" + v);
  }

  args.push("--env", "PORT=" + port);
  args.push(imageName(deploymentId));

  return { args, name };
}

async function runApp(opts) {
  const built = buildRunArgs(opts);
  const res = await docker(built.args, { timeoutMs: 60000 });
  return { ok: res.ok, containerId: res.stdout.trim(), error: res.stderr.trim(), name: built.name };
}

/* ---------- lifecycle ---------- */
const stop    = (id) => docker(["stop", "--time", "10", containerName(id)], { timeoutMs: 30000 });
const start   = (id) => docker(["start", containerName(id)], { timeoutMs: 30000 });
const restart = (id) => docker(["restart", "--time", "10", containerName(id)], { timeoutMs: 45000 });
const removeContainer = (id) => docker(["rm", "--force", "--volumes", containerName(id)], { timeoutMs: 30000 });
const removeImage = (id) => docker(["rmi", "--force", imageName(id)], { timeoutMs: 60000 });

async function logs(id, opts) {
  const tail = (opts && opts.tail) || 500;
  const r = await docker(["logs", "--tail", String(tail), "--timestamps", containerName(id)], { timeoutMs: 20000 });
  return { ok: r.ok, out: r.stdout + r.stderr };
}

async function inspectState(id) {
  const r = await docker(["inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}", containerName(id)], { timeoutMs: 15000 });
  if (!r.ok) return { exists: false };
  const parts = r.stdout.trim().split("|");
  return { exists: true, status: parts[0], exitCode: Number(parts[1]), restarts: Number(parts[2]) };
}

/** Live CPU/memory for every managed container. Feeds monitoring. */
async function statsAll() {
  const r = await docker(["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"], { timeoutMs: 30000 });
  if (!r.ok) return [];
  return r.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const c = line.split("|");
    return { name: c[0], cpu: c[1], mem: c[2], memPct: c[3] };
  });
}

/**
 * Only containers this platform created — never anything else on the host.
 *
 * Returns NULL, not [], when the daemon could not be reached. The two mean
 * opposite things and callers have to tell them apart: [] is "there are no
 * containers", null is "nobody could look". Returning [] for both is how
 * the api — which has no Docker socket — came to report 0 containers on a
 * host that was running several, and, worse, how its MAX_CONTAINERS
 * admission check came to pass unconditionally.
 */
/**
 * Every container this platform runs an APP in.
 *
 * Both filters matter. `souqi.managed=true` means ours; `souqi.deployment`
 * is only ever set on an app container, and its absence is what keeps the
 * shared user-database container out of this list. That container is
 * managed too, but it belongs to no deployment, and two callers would get
 * it badly wrong: capacity counts this list against MAX_CONTAINERS while
 * the api counts `deployments` rows, so one extra member here silently
 * desyncs admission between them; and the janitor treats anything here
 * without a live deployment row as an orphan, which would delete the
 * customer data cluster every fifteen minutes.
 *
 * Docker has no negative label filter, so the rule is stated positively:
 * an app container is one that names a deployment.
 */
async function listManaged() {
  const r = await docker(["ps", "--all",
    "--filter", "label=souqi.managed=true",
    "--filter", "label=souqi.deployment",
    "--format", "{{.Names}}|{{.State}}|{{.Image}}"], { timeoutMs: 20000 });
  if (!r.ok) return null;
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => {
    const c = l.split("|");
    return { name: c[0], state: c[1], image: c[2] };
  // Belt and braces. Every caller recovers a deployment id by stripping
  // this prefix, so anything without it would be acted on under a name
  // that is not its own.
  }).filter((c) => c.name.startsWith("app-"));
}

async function pruneImages() {
  // Dangling only. A blanket `system prune -a` would delete the base images
  // every build then re-pulls, turning a 20-second build into three minutes.
  return docker(["image", "prune", "--force"], { timeoutMs: 120000 });
}

async function version() {
  const r = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10000 });
  return r.ok ? r.stdout.trim() : null;
}

module.exports = {
  docker, containerName, imageName, ensureAppNetwork, buildImage, runApp, buildRunArgs,
  stop, start, restart, removeContainer, removeImage, logs, inspectState,
  statsAll, listManaged, pruneImages, version,
  networkName, ensureDeploymentNetwork, connectProxy, removeDeploymentNetwork,
  dbProxyName, egressNetworkName, ensureEgressNetwork, buildDbProxyArgs,
  runDbProxy, removeDbProxy, dbProxyTarget, listDbProxies, DBPROXY_IMAGE,
  connectUserDb, disconnectUserDb
};
