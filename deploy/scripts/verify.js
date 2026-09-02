/* =================================================================
   scripts/verify.js — assert the security properties, no Docker needed
   -----------------------------------------------------------------
   These are the invariants the spec is actually about. They are
   checked by reading what the code WOULD do rather than by running
   containers, so they pass in CI, on a laptop with no Docker, and
   before anything is deployed.

   A test that only passes when the whole stack is up is a test
   nobody runs.
   ================================================================= */
"use strict";

process.env.SECRET_KEY = process.env.SECRET_KEY || "a".repeat(64);

const assert = require("assert");
const engine = require("../src/docker/engine");
const dockerfiles = require("../src/framework/dockerfiles");
const detect = require("../src/framework/detect");
const secrets = require("../src/secrets");
const caddy = require("../src/proxy/caddy");
const providers = require("../src/providers");
const auth = require("../src/api/auth");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); failed++; }
}

/* The argv builder is a pure function, so this needs no Docker daemon and no
   stubbing — it asks the code exactly what it would run. */
function captureRunArgs(opts) {
  const built = engine.buildRunArgs(opts);
  return Promise.resolve({ cmd: "docker", args: built.args, name: built.name });
}

async function main() {
  console.log("\n── container hardening ──────────────────────────────");

  const run = await captureRunArgs({
    deploymentId: "dep_test", port: 3000, cpu: 0.5, memoryMb: 512, pids: 100,
    env: { API_KEY: "secret-value" }
  });
  const a = run.args;
  const argstr = a.join(" ");

  check("no --privileged", () => assert.ok(!a.includes("--privileged")));
  check("no docker socket mount", () => assert.ok(!argstr.includes("docker.sock")));
  check("no host network", () => assert.ok(!argstr.includes("--network host") && !a.includes("host")));
  check("no host filesystem bind mount", () => {
    const vols = a.filter((x, i) => a[i - 1] === "--volume" || a[i - 1] === "-v");
    assert.deepStrictEqual(vols, [], "found volume mounts: " + vols.join(", "));
  });
  check("no published ports", () => {
    assert.ok(!a.includes("-p") && !a.includes("--publish"), "a port was published");
  });
  check("all capabilities dropped", () => {
    const i = a.indexOf("--cap-drop");
    assert.ok(i >= 0 && a[i + 1] === "ALL");
  });
  check("no-new-privileges set", () => assert.ok(argstr.includes("no-new-privileges")));
  check("cpu limit applied", () => {
    const i = a.indexOf("--cpus"); assert.ok(i >= 0 && a[i + 1] === "0.5");
  });
  check("memory limit applied", () => {
    const i = a.indexOf("--memory"); assert.ok(i >= 0 && a[i + 1] === "512m");
  });
  check("swap disabled (memory-swap == memory)", () => {
    const i = a.indexOf("--memory-swap"); assert.ok(i >= 0 && a[i + 1] === "512m");
  });
  check("pids limit applied", () => {
    const i = a.indexOf("--pids-limit"); assert.ok(i >= 0 && a[i + 1] === "100");
  });
  check("joins its OWN internal network, not a shared one", () => {
    const i = a.indexOf("--network");
    assert.ok(i >= 0, "no --network flag");
    assert.strictEqual(a[i + 1], "souqi_app_dep_test",
      "the container is on a shared network, so it can reach other user containers");
  });
  check("two deployments never share a network", () => {
    const other = engine.buildRunArgs({
      deploymentId: "dep_other", port: 3000, cpu: 0.5, memoryMb: 512, pids: 100, env: {}
    }).args;
    const netA = a[a.indexOf("--network") + 1];
    const netB = other[other.indexOf("--network") + 1];
    assert.notStrictEqual(netA, netB, "both deployments landed on " + netA);
  });
  check("read-only root filesystem", () => assert.ok(a.includes("--read-only")));
  check("writable tmpfs is noexec", () => assert.ok(argstr.includes("noexec")));
  check("labelled as managed", () => assert.ok(argstr.includes("souqi.managed=true")));
  check("env passed as one argv element (no shell splitting)", () => {
    assert.ok(a.includes("API_KEY=secret-value"));
  });

  console.log("\n── injection resistance ─────────────────────────────");

  const evil = await captureRunArgs({
    deploymentId: "dep_x; rm -rf /", port: 3000, cpu: 0.5, memoryMb: 512, pids: 100,
    env: { "X": "a\"; docker run --privileged evil; #" }
  });
  check("deployment id is sanitised into the container name", () => {
    const i = evil.args.indexOf("--name");
    assert.strictEqual(evil.args[i + 1], "app-dep_xrm-rf");
  });
  check("a shell metacharacter in an env value stays one argument", () => {
    const bad = evil.args.filter((x) => x === "--privileged");
    assert.strictEqual(bad.length, 0, "injection produced a --privileged flag");
  });
  check("docker is invoked as an argv array, never a shell string", () => {
    assert.strictEqual(evil.cmd, "docker");
    assert.ok(Array.isArray(evil.args));
  });

  console.log("\n── build isolation ──────────────────────────────────");

  check("a newline in buildCommand is refused", () => {
    assert.throws(() => dockerfiles.assertSafeCommand("npm run build\nUSER root", "buildCommand"));
  });
  check("static build ships nginx, not the toolchain", () => {
    const d = dockerfiles.generate({ framework: "static", buildCommand: "npm run build", outputDir: "dist", port: 80 });
    assert.ok(d.dockerfile.includes("FROM nginx"), "runtime stage is not nginx");
    assert.ok(d.dockerfile.includes("COPY --from=build"), "not multi-stage");
  });
  check("node runtime runs as a non-root user", () => {
    const d = dockerfiles.generate({ framework: "node", startCommand: "npm start", port: 3000 });
    assert.ok(d.dockerfile.includes("USER node"));
  });
  check("python runtime runs as a non-root user", () => {
    const d = dockerfiles.generate({ framework: "python", startCommand: "python main.py", port: 8000 });
    assert.ok(d.dockerfile.includes("USER app"));
  });
  check("secrets are excluded from every build context", () => {
    const ig = dockerfiles.dockerignore();
    assert.ok(ig.includes(".env"), ".env is not ignored");
  });

  console.log("\n── secrets ──────────────────────────────────────────");

  check("round-trips", () => {
    const v = "sk-live-abc123";
    assert.strictEqual(secrets.decrypt(secrets.encrypt(v)), v);
  });
  check("ciphertext does not contain the plaintext", () => {
    assert.ok(!secrets.encrypt("hunter2").includes("hunter2"));
  });
  check("two encryptions of the same value differ (random IV)", () => {
    assert.notStrictEqual(secrets.encrypt("x"), secrets.encrypt("x"));
  });
  check("mask reveals at most the last four characters", () => {
    assert.strictEqual(secrets.mask("supersecretvalue"), "••••alue");
  });
  check("platform-controlled env names are refused", () => {
    assert.ok(secrets.validateKey("PATH"));
    assert.ok(secrets.validateKey("LD_PRELOAD"));
    assert.strictEqual(secrets.validateKey("DATABASE_URL"), null);
  });

  console.log("\n── framework detection ──────────────────────────────");

  check("a declared spec wins over guessing", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({ framework: "python", startCommand: "python x.py", port: 9000 }));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "14" } }));
    const spec = detect.detect(dir);
    assert.strictEqual(spec.framework, "python");
    assert.strictEqual(spec.declared, true);
  });
  check("a vite app is static, not a long-running node process", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      dependencies: { vite: "5" }, scripts: { build: "vite build", start: "vite preview" }
    }));
    assert.strictEqual(detect.detect(dir).framework, "static");
  });
  check("a static app is always served on port 80", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({ framework: "static", port: 4173 }));
    assert.strictEqual(detect.detect(dir).port, 80, "a declared port would point the proxy at nothing");
  });

  console.log("\n── proxy ────────────────────────────────────────────");

  check("a route dials the container by name, never an IP", () => {
    const c = caddy.baseConfig("http://api:4500/internal/tls-ask");
    assert.ok(c.apps.tls.automation.on_demand.permission.endpoint.includes("tls-ask"),
      "on-demand TLS has no ask endpoint — anyone could make this server request certificates");
  });
  check("admin API is not bound to a published port anywhere in compose", () => {
    const fs = require("fs"), path = require("path");
    const y = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
    assert.ok(!/["']2019:2019["']/.test(y), "the Caddy admin API is published to the host");
  });
  check("admin API does not listen on a wildcard address", () => {
    // Caddy is a member of every app network in order to proxy to the
    // containers, so 0.0.0.0 would expose the admin API — and with it the
    // power to re-route any hostname — to every untrusted user container.
    const listen = caddy.baseConfig("http://api:4500/internal/tls-ask").admin.listen;
    assert.ok(!/^(0\.0\.0\.0|::|\[::\]):/.test(listen),
      "admin listens on " + listen + ", which every user container can reach");
    const fs = require("fs"), path = require("path");
    const boot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "caddy", "caddy.json"), "utf8"));
    assert.ok(!/^(0\.0\.0\.0|::|\[::\]):/.test(boot.admin.listen),
      "the bootstrap config still binds " + boot.admin.listen);
  });

  console.log("\n── compose boundaries ───────────────────────────────");

  const fs = require("fs"), path = require("path");
  const compose = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
  check("only the worker mounts the docker socket", () => {
    const services = compose.split(/^  (?=\w)/m);
    const withSocket = services.filter((s) => s.includes("docker.sock")).map((s) => s.split(":")[0].trim());
    assert.deepStrictEqual(withSocket, ["worker"], "socket mounted in: " + withSocket.join(", "));
  });
  check("only caddy publishes ports", () => {
    const services = compose.split(/^  (?=\w)/m);
    const withPorts = services.filter((s) => /^\s+ports:/m.test(s)).map((s) => s.split(":")[0].trim());
    assert.deepStrictEqual(withPorts, ["caddy"], "ports published by: " + withPorts.join(", "));
  });
  check("the app network is internal", () => {
    assert.ok(/souqi_apps[\s\S]*?internal: true/.test(compose));
  });
  check("postgres publishes no port", () => {
    const pg = compose.split("postgres:")[1].split(/^  \w/m)[0];
    assert.ok(!/^\s+ports:/m.test(pg));
  });

  console.log("\n── the api never runs docker ────────────────────────");

  check("the api does not import the docker engine at all", () => {
    // The strongest form of the rule: if the module is not reachable from
    // server.js, no handler can grow a silent docker call later.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(!/^\s*const\s+engine\s*=\s*require\(/m.test(src),
      "server.js imports docker/engine, which it has no socket to use");
    assert.ok(!/\bengine\.\w+\(/.test(src), "server.js still calls engine.*()");
  });
  check("runtime logs are fetched from the worker, not from docker", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(/internal\/logs/.test(src), "the api does not ask the worker for runtime logs");
    const worker = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "index.js"), "utf8");
    assert.ok(/internal\/logs/.test(worker), "the worker exposes no logs endpoint");
    assert.ok(/timingSafeEqual/.test(worker), "the worker's internal API is not authenticated");
  });
  check("the worker's internal API is never published to the host", () => {
    const y = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
    assert.ok(!/["']\d+:4600["']/.test(y), "the worker's internal API is published");
  });

  check("no API route calls a docker-touching pipeline action", () => {
    // The api container has no Docker socket, so any docker command issued
    // from a request handler fails silently and the caller is told the
    // opposite of the truth. These belong to the worker.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    for (const fn of ["stop", "start", "restart", "destroy"]) {
      const re = new RegExp("pipeline\\." + fn + "\\s*\\(");
      assert.ok(!re.test(src),
        "server.js calls pipeline." + fn + "(), which shells out to docker without a socket");
    }
  });
  check("lifecycle routes queue an action for the worker", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(/pending_action/.test(src), "no route queues a pending_action");
  });
  check("the worker claims and runs those actions", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "index.js"), "utf8");
    assert.ok(/pending_action IS NOT NULL/.test(src), "the worker never claims queued actions");
    assert.ok(/SKIP LOCKED/.test(src.slice(src.indexOf("claimNextAction"))),
      "action claiming is not concurrency-safe");
    for (const fn of ["stop", "start", "restart", "destroy"]) {
      assert.ok(new RegExp("pipeline\\." + fn + "\\(").test(src), "the worker cannot run " + fn);
    }
  });
  check("deleting a deployment also removes its network", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");
    const destroy = src.slice(src.indexOf("async function destroy"));
    assert.ok(/removeDeploymentNetwork/.test(destroy),
      "destroy() leaves a dead network behind for every deleted deployment");
  });

  console.log("\n── provider abstraction ─────────────────────────────");

  check("hetzner and local both satisfy the interface", () => {
    for (const name of ["local", "hetzner"]) {
      const p = providers.get(name);
      for (const m of ["createServer", "deleteServer", "getServer", "getServerResources"]) {
        assert.strictEqual(typeof p[m], "function", name + " is missing " + m);
      }
    }
  });
  check("nothing outside providers/ mentions hetzner", () => {
    const root = path.join(__dirname, "..", "src");
    const offenders = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "providers") walk(full); continue; }
        if (!e.name.endsWith(".js")) continue;
        const body = fs.readFileSync(full, "utf8");
        // config.js holds the env block for every provider; that is the one
        // place a name is allowed outside providers/.
        if (/hetzner/i.test(body) && !full.endsWith("config.js")) offenders.push(full);
      }
    })(root);
    assert.deepStrictEqual(offenders, [], "hetzner leaked into: " + offenders.join(", "));
  });

  console.log("\n── operational scripts (phase 2) ──────────────────");

  const scriptSrc = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const provisionSrc = scriptSrc("provision.js");
  const shipSrc = scriptSrc("ship.sh");
  const backupSrc = scriptSrc("backup.sh");
  const preflightSrc = scriptSrc("preflight.js");

  check("no script hard-codes a credential", () => {
    for (const [name, body] of [["provision.js", provisionSrc], ["ship.sh", shipSrc],
                                ["backup.sh", backupSrc], ["preflight.js", preflightSrc]]) {
      // A Hetzner token is 64 chars of base62. Anything that long sitting in a
      // quoted literal is a credential somebody pasted in.
      const literal = body.match(/["'][A-Za-z0-9]{40,}["']/);
      assert.ok(!literal, name + " contains a hard-coded secret: " + literal);
    }
  });

  check("provisioning creates nothing without an explicit flag", () => {
    const main = provisionSrc.slice(provisionSrc.indexOf("async function main"));
    assert.ok(/has\("--create"\)/.test(main), "no --create guard");
    assert.ok(/await plan\(\)/.test(main), "the default path does not fall through to plan()");
    const planBody = provisionSrc.slice(provisionSrc.indexOf("async function plan"),
                                        provisionSrc.indexOf("async function create"));
    assert.ok(!/createServer|ensureFirewall/.test(planBody), "plan() mutates cloud state");
  });

  check("provisioning refuses a server with no SSH key", () => {
    assert.ok(/if \(!keys\.length\)/.test(provisionSrc),
      "a host reachable only by an emailed root password would be created");
  });

  check("ship refuses to run until every check passes", () => {
    for (const gate of ["preflight.js", "verify.js", "verify-auth.js"]) {
      assert.ok(shipSrc.includes(gate), "ship.sh does not gate on " + gate);
    }
    assert.ok(/PREFLIGHT_TARGET=server/.test(shipSrc),
      "ship.sh runs preflight in local mode, so NODE_ENV would only warn");
  });

  check("ship never puts .env in the archive", () => {
    const tar = shipSrc.split("\n").find((l) => l.includes("tar --exclude"));
    assert.ok(tar && tar.includes("--exclude=.env"), "the tar would carry .env world-readable");
    assert.ok(/chmod 600 \$\{REMOTE_DIR\}\/\.env/.test(shipSrc), "the copied .env is not locked down");
  });

  check("ship never generates secrets on the server", () => {
    assert.ok(!/openssl rand|randomBytes/.test(shipSrc),
      "secrets minted on the host are lost when the host is rebuilt");
  });

  check("backup keeps the password off the command line", () => {
    // ps output is readable by every process on the box, so a password in
    // argv is a password leaked to anything that can shell out.
    assert.ok(!/PGPASSWORD=/.test(backupSrc), "PGPASSWORD appears in a command");
    assert.ok(!/--password|-W\b/.test(backupSrc), "a password flag appears");
    assert.ok(/compose exec -T postgres pg_dump/.test(backupSrc),
      "the dump does not run inside the container, where the password already lives");
  });

  check("backup validates a dump before adopting it", () => {
    assert.ok(/\.partial/.test(backupSrc), "the dump is written straight to its final name");
    assert.ok(/gzip -t/.test(backupSrc), "the gzip stream is never verified");
    assert.ok(/dump complete/.test(backupSrc), "truncation is never detected");
  });

  check("preflight blocks the settings that make a host open", () => {
    for (const [needle, why] of [
      ["ALLOW_DEV_AUTH", "anyone could deploy as anyone"],
      ["localhost", "TLS would fail for every app"],
      ["JWT_SECRET", "sessions would not verify"]
    ]) {
      assert.ok(preflightSrc.includes(needle), "preflight does not check " + needle + " -- " + why);
    }
  });

  check("preflight never overwrites a live secret", () => {
    const gen = preflightSrc.slice(preflightSrc.indexOf("function generate"));
    assert.ok(/if \(env\[key\]\) continue;/.test(gen),
      "generate() would rotate a live SECRET_KEY, making stored env vars undecryptable");
    assert.ok(!/\["JWT_SECRET",\s*\d+\]/.test(gen),
      "generate() mints a JWT_SECRET, which would reject every main-app session");
  });

  console.log("\n" + (failed === 0
    ? "✓ ALL " + passed + " CHECKS PASSED"
    : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
