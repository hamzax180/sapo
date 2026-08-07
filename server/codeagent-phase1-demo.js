/* =================================================================
   codeagent-phase1-demo.js — prove the REAL sandbox, live
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md Phase 1: "A script scaffolds Vite+React in
   a sandbox, builds it, returns dist/, and the sandbox dies.
   Egress-deny verified by asserting an outbound curl FAILS."

   Runs the SAME seven tools (lib/codeagent/tools.js) as Phase 2's
   local proof — only the runtime underneath changes, which is the
   entire point of runtime.js's interface (docs/CODE-AGENT-PLAN.md
   §2, §5). If this and codeagent-phase2-demo.js both pass, the
   substrate is proven identical from the tool caller's point of view
   whether the backend is a laptop temp dir or a real microVM.

   Costs real sandbox minutes on a real account. Run deliberately.
   Run: npm run codeagent:phase1
   ================================================================= */
"use strict";
require("dotenv").config();
const assert = require("assert");
const { createRuntime } = require("./lib/codeagent/runtime");
require("./lib/codeagent/runtimes/daytona-runtime"); // registers "daytona"
const { makeTools } = require("./lib/codeagent/tools");

const pass = (m) => console.log("  ✓ " + m);
const step = (n, total, m) => console.log("\n[" + n + "/" + total + "] " + m);

const TODO_APP = `import { useState } from "react";

export default function App() {
  const [items, setItems] = useState<string[]>(["Buy roasted beans"]);
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-xl shadow p-6">
        <h1 className="text-xl font-semibold mb-4">Souqi Code — Todo</h1>
        <ul className="space-y-2">
          {items.map((it, i) => <li key={i} className="border rounded px-3 py-2">{it}</li>)}
        </ul>
      </div>
    </div>
  );
}
`;

(async () => {
  let ws = null;
  let ok = false;

  if (!process.env.DAYTONA_API_KEY) {
    console.log("• codeagent-phase1-demo SKIPPED — DAYTONA_API_KEY is not set");
    process.exit(0);
  }

  // A stuck step here is real, billed sandbox time — the first run of this
  // script proved that concretely (listFiles recursing into node_modules
  // ran for minutes before erroring). autoStopInterval:10 on the sandbox
  // itself is a second, independent backstop, but "stop" is not "delete" —
  // this one guarantees the script itself doesn't just sit there.
  const WATCHDOG_MS = 6 * 60 * 1000;
  const watchdog = setTimeout(async () => {
    console.error("\n✗ PHASE 1 DEMO WATCHDOG — exceeded " + (WATCHDOG_MS / 1000) + "s, forcing cleanup");
    if (ws) { try { await createRuntime("daytona").destroy(ws); console.error("  (sandbox destroyed by watchdog)"); } catch (e) { console.error("  ⚠ watchdog cleanup failed — check the Daytona dashboard for " + ws.id); } }
    process.exit(1);
  }, WATCHDOG_MS);
  watchdog.unref();

  try {
    console.log("\n--- CODEAGENT PHASE 1: prove the REAL sandbox, live ---");
    const TOTAL = 6;

    step(1, TOTAL, "create() — a real Daytona sandbox, network-blocked by default, npm registry allowlisted");
    const runtime = createRuntime("daytona");
    const t0 = Date.now();
    ws = await runtime.create();
    const tools = makeTools(runtime, ws);
    pass("sandbox " + ws.id + " created in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

    step(2, TOTAL, "egress-deny — a request to a NON-allowlisted host must fail");
    const curlOut = await runtime.run(ws, ["curl", "-sS", "--max-time", "6", "https://example.com"], 8000);
    assert.notStrictEqual(curlOut.code, 0, "a request to example.com SUCCEEDED — network egress is NOT actually blocked, this is a real security gap, not a test artifact");
    pass("curl to example.com failed as required (exit " + curlOut.code + ") — egress-deny is real, not just configured");

    step(3, TOTAL, "the allowlisted host IS reachable — npm install must still work");
    const files = await tools.list_files();
    assert.ok(files.includes("package.json"), "scaffold did not upload to the sandbox");
    const install = await tools.run("npm install", 240000);
    assert.strictEqual(install.code, 0, "npm install failed even against the allowlisted registry:\n" + install.stdout.slice(-1500));
    pass("npm install succeeded through the domain allowlist (" + files.length + " scaffold files uploaded, install exited 0)");

    step(4, TOTAL, "write_file() + build() — the real todo app, through the same tool contract as Phase 2");
    await tools.write_file("src/App.tsx", TODO_APP);
    const build = await tools.build(180000);
    if (!build.ok) console.error(build.raw);
    assert.strictEqual(build.ok, true, "build failed in the real sandbox");
    pass("npm run build succeeded — same tools.js, same scaffold, real isolation this time");

    step(5, TOTAL, "snapshot() — a checkpoint against the real sandbox filesystem");
    const manifest = await runtime.snapshot(ws);
    assert.ok(manifest.files.length > 0, "snapshot returned no files");
    pass("snapshot captured " + manifest.files.length + " files from the live sandbox");

    step(6, TOTAL, "destroy() — the sandbox must actually die, not just disconnect");
    await runtime.destroy(ws);
    pass("daytona.delete() completed");

    console.log("\n✓ PHASE 1 PROVEN — real Firecracker-class isolation, network-blocked by default, same 7-tool contract as Phase 2. This is the runtime a model is allowed to touch.");
    ok = true;
  } catch (e) {
    // The Daytona SDK's own error type doesn't always carry a string
    // .message (an earlier run printed the unhelpful "[object Object]"
    // here) — fall back through a few shapes before giving up on it.
    const msg = typeof e.message === "string" && e.message
      ? e.message
      : (e.response && e.response.data && JSON.stringify(e.response.data)) || JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 500);
    console.error("\n✗ PHASE 1 DEMO FAILED:", msg);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 6).join("\n"));
  } finally {
    clearTimeout(watchdog);
    if (ws && ok === false) {
      try {
        const runtime = createRuntime("daytona");
        await runtime.destroy(ws);
        console.log("  (cleaned up the sandbox after failure)");
      } catch (e) { console.error("  ⚠ could not clean up sandbox " + ws.id + " — check the Daytona dashboard: " + e.message); }
    }
    process.exit(ok ? 0 : 1);
  }
})();
