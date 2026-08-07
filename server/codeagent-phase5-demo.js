/* =================================================================
   codeagent-phase5-demo.js — dom_snapshot, live, both directions
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md Phase 5: "A blank-page build is correctly
   reported as a failure, not a success."

   Proves it against a REAL sandbox, not by inspection: a working app's
   dom_snapshot must show real rendered text, AND a component that
   compiles clean but renders nothing (`return null`) must be caught as
   empty. Only the second case is Phase 5's actual point — a build that
   merely "doesn't crash tsc" is not the same claim as "a visitor sees
   something," and this is the check that tells the two apart.

   Why this runs entirely inside the Daytona sandbox rather than using
   Puppeteer from this host: Chromium fails to launch on THIS specific
   Windows machine (a real, reproducible local ICU/dbus issue, tried via
   both the Bash and PowerShell tool paths, survives a clean reinstall —
   not a sandboxing artifact). The sandbox's base image ships Chromium
   pre-installed, so daytona-runtime.js's domSnapshot() runs `chromium
   --dump-dom` INSIDE the isolated Linux container instead — which is
   also the more production-realistic design regardless of this host's
   quirks: the orchestrator never needs its own browser stack, or
   network access to a sandbox's public preview URL, at all.

   ONLY the daytona runtime — this executes model-shaped output (in
   spirit; the pages here are hardcoded for a controlled test, but the
   pipeline being proven is the one Phase 3+ actually uses).

   Costs real sandbox minutes (no model calls — the pages are fixed).
   Run: npm run codeagent:phase5
   ================================================================= */
"use strict";
require("dotenv").config();
const assert = require("assert");
const { createRuntime } = require("./lib/codeagent/runtime");
require("./lib/codeagent/runtimes/daytona-runtime");
const { makeTools } = require("./lib/codeagent/tools");

const pass = (m) => console.log("  ✓ " + m);
const step = (n, total, m) => console.log("\n[" + n + "/" + total + "] " + m);

const REAL_APP = `export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <h1>Souqi Code — Phase 5</h1>
      <p>This text must survive the round trip through a real browser.</p>
    </div>
  );
}
`;

// Compiles clean under tsc AND vite build — TypeScript has no objection to
// a component that renders null. This is exactly the failure mode a build
// step can never catch: syntactically and structurally fine, visibly empty.
const BLANK_APP = `export default function App() {
  return null;
}
`;

async function buildAndSnapshot(ws, tools, runtime, appCode, label) {
  await tools.write_file("src/App.tsx", appCode);
  const build = await tools.build(120000);
  assert.strictEqual(build.ok, true, label + ": build unexpectedly failed: " + JSON.stringify(build.errors && build.errors[0]));
  pass(label + ": npm run build succeeded (tsc + vite, both clean)");

  const preview = await runtime.startPreview(ws, 20000);
  assert.strictEqual(preview.ok, true, label + ": preview server never came up: " + preview.reason);
  pass(label + ": preview server answering at " + preview.url);

  const snap = await tools.dom_snapshot(preview.url, 15000);
  assert.strictEqual(snap.degraded, false, label + ": dom_snapshot degraded instead of running for real: " + snap.reason);
  return snap;
}

(async () => {
  let ws1 = null, ws2 = null;
  let ok = false;

  if (!process.env.DAYTONA_API_KEY) {
    console.log("• codeagent-phase5-demo SKIPPED — DAYTONA_API_KEY is not set");
    process.exit(0);
  }

  const watchdog = setTimeout(async () => {
    console.error("\n✗ PHASE 5 DEMO WATCHDOG — forcing cleanup");
    const runtime = createRuntime("daytona");
    if (ws1) { try { await runtime.destroy(ws1); } catch (e) {} }
    if (ws2) { try { await runtime.destroy(ws2); } catch (e) {} }
    process.exit(1);
  }, 6 * 60 * 1000);
  watchdog.unref();

  try {
    console.log("\n--- CODEAGENT PHASE 5: dom_snapshot, live, both directions ---");
    const runtime = createRuntime("daytona");

    step(1, 4, "a REAL app — dom_snapshot must show real rendered text, not just 'the build passed'");
    ws1 = await runtime.create();
    const tools1 = makeTools(runtime, ws1);
    const install1 = await tools1.run("npm install", 180000);
    assert.strictEqual(install1.code, 0, "npm install failed");

    const realSnap = await buildAndSnapshot(ws1, tools1, runtime, REAL_APP, "real app");
    assert.strictEqual(realSnap.empty, false, "a page with real content was reported EMPTY — dom_snapshot is broken in the direction that matters most");
    assert.ok(realSnap.text.indexOf("Souqi Code") >= 0, "rendered text is missing the actual heading — got: " + JSON.stringify(realSnap.text.slice(0, 100)));
    assert.ok(realSnap.text.indexOf("round trip") >= 0, "rendered text is missing the body copy");
    pass("dom_snapshot confirms REAL content rendered: " + JSON.stringify(realSnap.text.slice(0, 70)) + "…");
    await runtime.destroy(ws1); ws1 = null;
    pass("sandbox 1 destroyed");

    step(2, 4, "a BLANK app — compiles clean, renders NOTHING. This is Phase 5's actual point.");
    ws2 = await runtime.create();
    const tools2 = makeTools(runtime, ws2);
    const install2 = await tools2.run("npm install", 180000);
    assert.strictEqual(install2.code, 0, "npm install failed");

    const blankSnap = await buildAndSnapshot(ws2, tools2, runtime, BLANK_APP, "blank app");

    step(3, 4, "the assertion that matters: does dom_snapshot correctly call this a failure?");
    assert.strictEqual(blankSnap.empty, true,
      "a component that returns null was reported NON-empty — this is exactly the false-positive Phase 5 exists to prevent: " +
      "a build that compiles clean but shows a visitor nothing would have been reported as a SUCCESS");
    pass("blank page correctly reported empty:true — build succeeded, but a visitor would see nothing, and this is caught");

    step(4, 4, "cleanup");
    await runtime.destroy(ws2); ws2 = null;
    pass("sandbox 2 destroyed");

    console.log("\n✓ PHASE 5 PROVEN — dom_snapshot runs for real inside the sandbox (no host browser dependency), confirms real content when it exists, and correctly flags a compiles-clean-but-empty page as a failure, not a success.");
    ok = true;
  } catch (e) {
    console.error("\n✗ PHASE 5 DEMO FAILED:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
  } finally {
    clearTimeout(watchdog);
    const runtime = createRuntime("daytona");
    if (ws1) { try { await runtime.destroy(ws1); } catch (e) { console.error("  ⚠ cleanup failed for sandbox 1: " + e.message); } }
    if (ws2) { try { await runtime.destroy(ws2); } catch (e) { console.error("  ⚠ cleanup failed for sandbox 2: " + e.message); } }
    process.exit(ok ? 0 : 1);
  }
})();
