/* =================================================================
   codeagent-phase3-demo.js — DeepSeek writes code, single-shot, measured
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md Phase 3: "'Build a landing page for a
   barber shop' produces something that compiles. Measure raw success
   rate — that number sets everything after."

   ONLY the daytona runtime, never local-runtime.js. This is the first
   script in the codebase where a model's own output becomes code that
   actually executes (npm run build), and local-runtime.js explicitly
   refuses that role — see its file header. Phase 1 exists so this
   phase has somewhere safe to run.

   No repair loop yet (that's Phase 4): one model call per prompt, its
   proposed write_file calls applied as-is, one build, pass or fail,
   sandbox destroyed either way. The number this prints is the actual
   deliverable — it decides whether DeepSeek stays on the coding route
   or gets demoted to cheaper sub-tasks (§11 of the plan).

   Costs real DeepSeek tokens and real sandbox minutes. Run deliberately.
   Run: npm run codeagent:phase3
   ================================================================= */
"use strict";
require("dotenv").config();
const client = require("./lib/ai/client");
const { createRuntime } = require("./lib/codeagent/runtime");
require("./lib/codeagent/runtimes/daytona-runtime"); // registers "daytona" — the ONLY runtime used below
const { makeTools } = require("./lib/codeagent/tools");
const { proposeChanges } = require("./lib/codeagent/model-loop");

const PROMPTS = [
  "Build a one-page landing site for a barber shop called Usta Berber. Include a hero with the shop name and a tagline, a services list with prices, and a contact section.",
  "Build a landing page for an Istanbul coffee roastery called Kahve Co that sells beans online. Show three products with prices in Turkish lira.",
  "Build a simple portfolio page for a freelance photographer. Include a hero, a grid of 6 placeholder project cards, and a contact email.",
  "Build a pricing page with three tiers: Starter, Pro, and Business, each with a price and a short feature list.",
  "Build a landing page for a local bakery with daily specials and opening hours."
];

const WATCHDOG_MS = 6 * 60 * 1000;

async function runOne(prompt, index, total) {
  console.log("\n[" + (index + 1) + "/" + total + "] \"" + prompt.slice(0, 60) + (prompt.length > 60 ? "…" : "") + "\"");
  let ws = null;
  const runtime = createRuntime("daytona");
  const watchdog = setTimeout(async () => {
    console.error("  ⚠ watchdog fired for this prompt — forcing sandbox cleanup");
    if (ws) { try { await runtime.destroy(ws); } catch (e) { /* best effort */ } }
  }, WATCHDOG_MS);
  watchdog.unref();

  try {
    const t0 = Date.now();
    const proposal = await proposeChanges(prompt);
    const modelMs = Date.now() - t0;

    if (!proposal.ok) {
      console.log("  ✗ model did not produce usable output: " + proposal.reason);
      return { prompt, ok: false, stage: "model", reason: proposal.reason };
    }
    console.log("  model proposed " + proposal.calls.length + " file(s) in " + (modelMs / 1000).toFixed(1) + "s"
      + (proposal.cached ? " [CACHE HIT — $0]" : "")
      + (proposal.retried ? " (needed one retry)" : "")
      + (!proposal.cached && proposal.costUsd ? ", ~$" + proposal.costUsd.toFixed(5) : ""));
    for (const c of proposal.calls) console.log("    " + c.path + " (" + c.content.length + " chars)");

    ws = await runtime.create();
    const tools = makeTools(runtime, ws);

    // The scaffold's dependencies still have to actually land in THIS
    // sandbox before a build can mean anything — Phase 1/2 both install
    // before building; this script skipped straight to write+build and
    // every "failure" that produced was really just "react was never
    // installed," not a signal about the model's output at all.
    const install = await tools.run("npm install", 180000);
    if (install.code !== 0) {
      console.log("  ✗ npm install failed (substrate problem, not measuring the model): " + install.stdout.slice(-500));
      return { prompt, ok: false, stage: "install", modelMs, costUsd: proposal.costUsd };
    }

    for (const c of proposal.calls) await tools.write_file(c.path, c.content);

    const t1 = Date.now();
    const build = await tools.build(180000);
    const buildMs = Date.now() - t1;

    if (build.ok) {
      console.log("  ✓ COMPILED in " + (buildMs / 1000).toFixed(1) + "s");
      return { prompt, ok: true, stage: "build", modelMs, buildMs, files: proposal.calls.length, costUsd: proposal.costUsd };
    } else {
      console.log("  ✗ build FAILED (" + build.errors.length + " error(s)):");
      for (const e of build.errors.slice(0, 3)) console.log("    " + JSON.stringify(e));
      return { prompt, ok: false, stage: "build", errors: build.errors, modelMs, buildMs, costUsd: proposal.costUsd };
    }
  } catch (e) {
    console.log("  ✗ EXCEPTION: " + (e.message || JSON.stringify(e)));
    return { prompt, ok: false, stage: "exception", reason: e.message || String(e) };
  } finally {
    clearTimeout(watchdog);
    if (ws) { try { await runtime.destroy(ws); } catch (e) { console.error("  ⚠ cleanup failed: " + e.message); } }
  }
}

(async () => {
  if (!process.env.DAYTONA_API_KEY) {
    console.log("• codeagent-phase3-demo SKIPPED — DAYTONA_API_KEY is not set");
    process.exit(0);
  }
  client.init(); // reads AI_ENABLED / AI_JSON_* from the already-loaded .env
  const state = client._debugState();
  if (!state.config.enabled || !state.config.routes.json.key) {
    console.log("• codeagent-phase3-demo SKIPPED — AI_ENABLED=1 and AI_JSON_KEY are required (see docs/AI-PROVIDER-PLAN.md §3)");
    process.exit(0);
  }

  console.log("\n--- CODEAGENT PHASE 3: DeepSeek writes code, single-shot, measured ---");
  console.log("(" + PROMPTS.length + " prompts, real sandbox + real model call each — this costs real money)");

  const results = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    results.push(await runOne(PROMPTS[i], i, PROMPTS.length));
  }

  const compiled = results.filter((r) => r.ok).length;
  const modelFailed = results.filter((r) => r.stage === "model").length;
  const buildFailed = results.filter((r) => r.stage === "build" && !r.ok).length;
  const exceptions = results.filter((r) => r.stage === "exception").length;
  const totalCost = results.reduce((s, r) => s + (r.costUsd || 0), 0);

  console.log("\n" + "=".repeat(60));
  console.log("RESULT: " + compiled + "/" + PROMPTS.length + " compiled on the first try (" + Math.round((compiled / PROMPTS.length) * 100) + "%)");
  console.log("  model-stage failures: " + modelFailed + "  |  build-stage failures: " + buildFailed + "  |  exceptions: " + exceptions);
  console.log("  total estimated model cost: ~$" + totalCost.toFixed(5));
  console.log("=".repeat(60));
  console.log("\ndocs/CODE-AGENT-PLAN.md §11: under ~40% single-shot means the answer isn't more");
  console.log("prompt engineering — it's a better model on the coding route, DeepSeek kept for");
  console.log("cheaper sub-tasks. This number is that decision, not a guess.");

  process.exit(0);
})();
