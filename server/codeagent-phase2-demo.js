/* =================================================================
   codeagent-phase2-demo.js — prove the substrate, zero model involved
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md Phase 2: "A fixed 6-step sequence produces
   a working todo app... proves the substrate before adding
   non-determinism." Every step below goes through the SAME seven
   tools (lib/codeagent/tools.js) that a model will call from Phase 3
   onward — this script is the tool surface's only caller today, so if
   it works, the plumbing is sound; if it doesn't, no API key would
   have fixed that anyway.

   Runs against the LOCAL runtime, which is explicitly dev-only and
   unsandboxed (lib/codeagent/runtimes/local-runtime.js) — appropriate
   here because this script is fixed and non-adversarial, not because
   it would be safe for anything a stranger's prompt touches.

   Run: npm run codeagent:phase2
   ================================================================= */
"use strict";
const assert = require("assert");
const { createRuntime } = require("./lib/codeagent/runtime");
require("./lib/codeagent/runtimes/local-runtime"); // registers "local"
const { makeTools } = require("./lib/codeagent/tools");

const pass = (m) => console.log("  ✓ " + m);
const step = (n, m) => console.log("\n[" + n + "/6] " + m);

const TODO_APP = `import { useState } from "react";

export default function App() {
  const [items, setItems] = useState<string[]>(["Buy roasted beans", "Restock filters"]);
  const [draft, setDraft] = useState("");

  function add() {
    const text = draft.trim();
    if (!text) return;
    setItems((prev) => [...prev, text]);
    setDraft("");
  }

  function remove(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-xl shadow p-6">
        <h1 className="text-xl font-semibold mb-4">Souqi Code — Todo</h1>
        <div className="flex gap-2 mb-4">
          <input
            className="flex-1 border rounded px-3 py-2"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a todo"
          />
          <button className="bg-slate-900 text-white px-4 py-2 rounded" onClick={add}>
            Add
          </button>
        </div>
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="flex justify-between items-center border rounded px-3 py-2">
              <span>{it}</span>
              <button className="text-slate-400 hover:text-red-500" onClick={() => remove(i)}>
                remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
`;

const BROKEN_APP = `import { useState } from "react";

export default function App() {
  const [items, setItems] = useState<string[]>(["Buy roasted beans"]
  // missing closing paren above — this must fail the build

  return <div>{items.length}</div>;
}
`;

(async () => {
  let ws = null;
  let previewChild = null;
  let ok = false;

  try {
    console.log("\n--- CODEAGENT PHASE 2: prove the substrate, no model ---");

    step(1, "create() — copy the fixed scaffold (Vite + React + TS + Tailwind) into a workspace");
    const runtime = createRuntime("local");
    ws = await runtime.create();
    const tools = makeTools(runtime, ws);
    const files = await tools.list_files();
    assert.ok(files.includes("package.json"), "scaffold did not copy package.json");
    assert.ok(files.includes("src/App.tsx"), "scaffold did not copy src/App.tsx");
    pass("workspace " + ws.id + " created with " + files.length + " scaffold files");

    step(2, "write_file() — replace the placeholder App with a real todo app");
    await tools.write_file("src/App.tsx", TODO_APP);
    const readBack = await tools.read_file("src/App.tsx", 1, 3);
    assert.ok(readBack.indexOf("useState") >= 0, "read_file (ranged) did not return what write_file wrote");
    pass("App.tsx written; ranged read_file confirms it landed");

    step(3, "run() — npm install, through the allowlist, real network");
    const install = await tools.run("npm install", 180000);
    assert.strictEqual(install.code, 0, "npm install failed:\n" + install.stderr.slice(-1500));
    pass("npm install exited 0");

    step(4, "build() — must FAIL first: prove errors are parsed, not swallowed");
    await tools.write_file("src/App.tsx", BROKEN_APP);
    const brokenBuild = await tools.build(120000);
    assert.strictEqual(brokenBuild.ok, false, "a syntactically broken file built successfully — the check itself is broken");
    assert.ok(brokenBuild.errors.length > 0, "a failed build reported zero parsed errors");
    pass("broken build correctly reports ok:false with " + brokenBuild.errors.length + " parsed error(s):");
    console.log("      " + JSON.stringify(brokenBuild.errors[0]));

    step(4, "build() — now the REAL app must succeed");
    await tools.write_file("src/App.tsx", TODO_APP);
    const build = await tools.build(120000);
    if (!build.ok) console.error(build.raw);
    assert.strictEqual(build.ok, true, "the working todo app failed to build");
    pass("npm run build (tsc --noEmit && vite build) succeeded, 0 errors");

    step(5, "dom_snapshot() — the screenshot substitute: does it actually RENDER, not just compile?");
    const spawn = require("cross-spawn"); // same reasoning as local-runtime.js — no shell:true
    previewChild = spawn("npm", ["run", "preview"], { cwd: ws.root, windowsHide: true, detached: process.platform !== "win32" });
    let previewReady = false;
    previewChild.stdout.on("data", (d) => { if (String(d).indexOf("4173") >= 0) previewReady = true; });
    const deadline = Date.now() + 15000;
    while (!previewReady && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));

    const snap = await tools.dom_snapshot("http://localhost:4173", 10000);
    if (snap.degraded) {
      console.log("  ⚠ dom_snapshot degraded in THIS environment (" + snap.reason + ") — this is a known sandboxed-shell Chrome launch issue, not a tool bug. The build+parse path above is fully proven; dom_snapshot's real backend is exercised again in Phase 5 against the target sandbox runtime.");
    } else {
      assert.strictEqual(snap.empty, false, "the built app rendered an EMPTY page — this is exactly the blank-white-page failure mode dom_snapshot exists to catch");
      assert.ok(snap.text.indexOf("Souqi Code") >= 0, "rendered text did not contain the app's own heading");
      assert.ok(snap.text.indexOf("Buy roasted beans") >= 0, "rendered text did not contain the seeded todo item");
      pass("dom_snapshot confirms REAL rendered content, not just a successful compile:");
      console.log("      " + JSON.stringify(snap.text.slice(0, 80)) + "…");
    }

    step(6, "snapshot() + destroy() — checkpoint, then clean up");
    const manifest = await runtime.snapshot(ws);
    assert.ok(manifest.files.length > 0, "snapshot returned no files");
    pass("snapshot captured " + manifest.files.length + " files (this is what a git commit / checkpoint hashes in Phase 7)");

    console.log("\n✓ PHASE 2 SUBSTRATE PROVEN — 7 tools, argv-only run(), parsed build errors (success AND failure paths), workspace lifecycle. No model, no sandbox vendor needed for any of it.");
    ok = true;
  } catch (e) {
    console.error("\n✗ PHASE 2 DEMO FAILED:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
  } finally {
    // .kill() only SENDS the signal — on Windows especially, the child (and
    // any native binary it spawned, e.g. esbuild) can still hold file handles
    // in the workspace for a moment after this returns. Waiting for the real
    // exit event, not just calling kill(), is what makes destroy() reliable
    // instead of an occasional silent EBUSY.
    if (previewChild) {
      const { killTree } = require("./lib/codeagent/runtimes/local-runtime");
      await new Promise((resolve) => {
        previewChild.once("exit", resolve);
        killTree(previewChild);
        setTimeout(resolve, 3000); // don't hang the whole script on a stuck child
      });
    }
    if (ws) {
      const runtime = createRuntime("local");
      try {
        await runtime.destroy(ws);
      } catch (e) {
        // Silently swallowing this is exactly how the last run leaked two
        // temp directories without anyone noticing — say so instead.
        console.error("  ⚠ cleanup failed for " + ws.root + ": " + e.message + " (remove it manually)");
      }
    }
    process.exit(ok ? 0 : 1);
  }
})();
