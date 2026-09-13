/* =================================================================
   The contract between the prompt and the build container.

   This exists because of a bug that cost every payment-taking app a build:
   SYSTEM_PROMPT instructed the model to import './lib/payments',
   PROTECTED_PATHS forbade it from writing that file, and the WebContainer
   never mounted it. Three components each individually reasonable, and
   together a guaranteed unresolvable import — with a repair loop that could
   not fix it, because the only fix was a write the validator rejects.

   The general rule this enforces: IF THE PROMPT TELLS THE MODEL TO IMPORT
   SOMETHING, THE BUILD CONTAINER MUST HAVE IT. That is checkable, so it
   should never again be discovered by a customer.

   Run: node server/scaffold-contract-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { readScaffold } = require("./lib/codeagent/scaffold-files");
const { systemPromptFor } = require("./lib/codeagent/model-loop");

let passed = 0;
function ok(name, fn) {
  try { fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

const scaffold = readScaffold();
const indexSrc = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const wcSrc = fs.readFileSync(path.join(__dirname, "..", "public", "js", "codeagent", "wc-runtime.js"), "utf8");
const prompt = systemPromptFor("economy") + systemPromptFor("power");

/* What the server ships down the files frame on every build round. */
const runtimeList = (() => {
  const m = /const SCAFFOLD_RUNTIME_FILES = \[([^\]]*)\]/.exec(indexSrc);
  return m ? (m[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, "")) : [];
})();

console.log("\nprompt/container contract");

ok("every module the prompt says to import is reachable by the build", () => {
  // "from './lib/payments'" and friends, as they appear in the prompt.
  const imports = [...prompt.matchAll(/from\s+['"]\.\/([\w/.-]+)['"]/g)].map((m) => m[1]);
  assert.ok(imports.length, "expected the prompt to name at least one import");

  const mountedInBrowser = /'src':\s*\{[\s\S]*?directory:\s*\{([\s\S]*?)\n\s*\}/.exec(wcSrc);
  const browserSrcFiles = mountedInBrowser
    ? (mountedInBrowser[1].match(/'([\w.-]+)'/g) || []).map((s) => "src/" + s.replace(/'/g, ""))
    : [];

  for (const rel of imports) {
    const candidates = ["src/" + rel + ".ts", "src/" + rel + ".tsx", "src/" + rel + "/index.ts"];
    const reachable = candidates.some((c) =>
      runtimeList.includes(c) || browserSrcFiles.includes(c));
    assert.ok(reachable,
      "the prompt tells the model to import './" + rel + "' but the build container " +
      "never receives it — it is neither mounted by wc-runtime.js nor listed in " +
      "SCAFFOLD_RUNTIME_FILES. This is an unresolvable import on every build that " +
      "follows the instruction.");
  }
});

ok("anything the model is forbidden to write, the container is given", () => {
  const m = /const PROTECTED_PATHS = new Set\(\[([^\]]*)\]\)/.exec(
    fs.readFileSync(path.join(__dirname, "lib", "codeagent", "model-loop.js"), "utf8"));
  const protectedPaths = m ? (m[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, "")) : [];
  assert.ok(protectedPaths.length, "expected PROTECTED_PATHS to be parseable");

  // main.tsx and vite-env.d.ts are mounted by wc-runtime itself; anything else
  // protected has to arrive some other way or it simply is not there.
  const mountedByBrowser = ["src/main.tsx", "src/vite-env.d.ts"];
  for (const p of protectedPaths) {
    if (mountedByBrowser.includes(p)) continue;
    assert.ok(runtimeList.includes(p),
      p + " is protected from the model AND absent from the browser mount, so nothing " +
      "can ever create it. Add it to SCAFFOLD_RUNTIME_FILES.");
  }
});

ok("everything sent as a runtime scaffold file actually exists in the scaffold", () => {
  for (const p of runtimeList) {
    assert.ok(typeof scaffold[p] === "string" && scaffold[p].length,
      p + " is listed in SCAFFOLD_RUNTIME_FILES but is not in scaffold-data.json — " +
      "it would be sent as undefined and resolve to nothing.");
  }
});

ok("payments.ts carries the exports the prompt names", () => {
  const src = scaffold["src/lib/payments.ts"] || "";
  // Named in SYSTEM_PROMPT's import example; a rename here is a build failure
  // in every generated shop.
  for (const fn of ["listItems", "checkout", "formatPrice", "paymentsAvailable"]) {
    assert.ok(new RegExp("export\\s+(async\\s+)?function\\s+" + fn + "\\b").test(src),
      "the prompt imports { " + fn + " } but payments.ts does not export it");
  }
});

console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
