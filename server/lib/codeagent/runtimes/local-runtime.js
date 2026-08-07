/* =================================================================
   codeagent/runtimes/local-runtime.js — Phase 2 ONLY, never Phase 3+
   -----------------------------------------------------------------
   Runs the scaffold in a plain OS temp directory with a plain child
   process. This is the SAME machine, SAME kernel, SAME filesystem as
   the API process that holds JWT_SECRET and MONGODB_URI — there is
   NO isolation here (docs/CODE-AGENT-PLAN.md §5, §9: "plain Docker on
   your box: shared kernel... No.").

   This exists to prove the seven-tool substrate against a hardcoded,
   non-adversarial script — the whole point of Phase 2 is to find out
   whether the plumbing works BEFORE anything untrusted (a model, a
   stranger's prompt) can reach it. Once Phase 1 lands a real sandbox
   provider, the code-generating agent (Phase 3+) must run ONLY there.
   `assertDevOnly()` is a deliberate tripwire against that mistake.
   ================================================================= */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
// cross-spawn resolves Windows .cmd/.bat shims (npm, npx) WITHOUT going
// through shell:true — Node's own spawn can't run those on Windows unless
// shell:true is set, and shell:true + an args array is a real injection
// risk (Node emits DEP0190 for exactly this) because args stop being
// individually escaped. This is the one dependency worth taking to keep
// run() genuinely shell-free even on Windows.
const spawn = require("cross-spawn");
const { registerRuntime } = require("../runtime");

const SCAFFOLD_DIR = path.join(__dirname, "..", "scaffold");
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".cache"]);

function assertDevOnly() {
  if (process.env.NODE_ENV === "production" && process.env.CODEAGENT_ALLOW_LOCAL_IN_PROD !== "1") {
    throw new Error(
      "local-runtime refuses to run with NODE_ENV=production — it has no sandboxing. " +
      "Use the e2b/daytona runtime for anything reachable by a real user."
    );
  }
}

/** Resolves a workspace-relative path and refuses to leave the workspace
    root — the one traversal check that matters even for a hardcoded
    script, because it is free and it is the check Phase 3 will lean on
    hardest once the caller is a model instead of a fixed sequence. */
function resolveInWorkspace(ws, relPath) {
  const clean = String(relPath || "").replace(/^[/\\]+/, "");
  const full = path.resolve(ws.root, clean);
  if (full !== ws.root && !full.startsWith(ws.root + path.sep)) {
    throw new Error("path escapes the workspace: " + relPath);
  }
  return full;
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

async function walk(dir, root, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    else out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

async function create() {
  assertDevOnly();
  const id = "ws_" + crypto.randomBytes(8).toString("hex");
  const root = path.join(os.tmpdir(), "souqi-codeagent", id);
  await copyDir(SCAFFOLD_DIR, root);
  return { id, kind: "local", root };
}

async function writeFile(ws, relPath, content) {
  const full = resolveInWorkspace(ws, relPath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf8");
}

async function readFile(ws, relPath, fromLine, toLine) {
  const full = resolveInWorkspace(ws, relPath);
  const text = await fsp.readFile(full, "utf8");
  if ((fromLine === null || fromLine === undefined) && (toLine === null || toLine === undefined)) return text;
  const lines = text.split("\n");
  const from = Math.max(1, fromLine || 1);
  const to = Math.min(lines.length, toLine || lines.length);
  return lines.slice(from - 1, to).join("\n");
}

async function listFiles(ws, dir) {
  const base = dir ? resolveInWorkspace(ws, dir) : ws.root;
  const out = [];
  await walk(base, ws.root, out);
  return out.sort();
}

/** child.kill() only signals the ONE process it points at. npm/vite/tsc
    routinely spawn their own native binaries underneath (esbuild is the one
    that bit us here) — on Windows those don't die with their parent unless
    the whole tree is killed explicitly, which is what left an orphaned
    esbuild.exe holding a file lock after the first version of this function
    shipped. `taskkill /t` kills the process tree; POSIX SIGKILL already
    covers the tree via the process group. This is exactly the kind of bug
    Phase 2 exists to surface before a repair loop hits timeouts routinely
    and leaks a process per retry. */
function killTree(child) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) { child.kill("SIGKILL"); }
  }
}

/** argv only — never a shell string. See runtime.js header. */
function run(ws, argv, timeoutMs) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, {
      cwd: ws.root, windowsHide: true,
      detached: process.platform !== "win32" // POSIX: own process group, so killTree can target -pid
    });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs || 120000);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + "\n" + e.message, timedOut: false });
    });
  });
}

async function snapshot(ws) {
  const files = await listFiles(ws);
  const hashed = await Promise.all(files.map(async (rel) => {
    const buf = await fsp.readFile(resolveInWorkspace(ws, rel));
    return { path: rel, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
  }));
  return { files: hashed, at: new Date().toISOString() };
}

/** A file recently released by a killed child process (esbuild's native
    binary, in particular) can stay locked on Windows for a beat after the
    process is gone. `fs.rm`'s own maxRetries handles most of that, but it
    only retries ENOENT/EBUSY races on the SAME call — this adds one outer
    retry so a slow-to-release handle doesn't leak the whole workspace. */
async function destroy(ws) {
  const attempt = () => fsp.rm(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    await attempt();
  } catch (e) {
    await new Promise((r) => setTimeout(r, 500));
    await attempt();
  }
}

registerRuntime("local", { create, writeFile, readFile, listFiles, run, snapshot, destroy });

module.exports = { create, writeFile, readFile, listFiles, run, snapshot, destroy, killTree };
