/* =================================================================
   codeagent-phase4-demo.js — the repair loop, live, measured
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md Phase 4: "Success rate measured before and
   after. This is the phase that makes it feel like Replit."

   "Before" is already on record: Phase 3 measured 100% single-shot on
   5 straightforward prompts (codeagent-phase3-demo.js). Repeating those
   here would prove nothing — there'd be no failures for repair to fix.
   These 4 prompts are deliberately harder: multi-file, shared state
   across components, more TypeScript surface area to get wrong. The
   real question isn't "does DeepSeek write code" (answered), it's
   "when it's wrong, does seeing its own error fix it."

   ONLY the daytona runtime — same reasoning as Phase 3's demo: this is
   model output about to execute, and local-runtime.js explicitly
   refuses that role.

   maxRounds is capped at 2 here (3 total attempts) rather than the
   plan's full 6 — enough to show whether repair works at all, without
   burning the budget guard on a first measurement. Raise it once this
   number says it's worth it.

   Costs real DeepSeek tokens and real sandbox minutes. Run deliberately.
   Run: npm run codeagent:phase4
   ================================================================= */
"use strict";
require("dotenv").config();
const client = require("./lib/ai/client");
const { createRuntime } = require("./lib/codeagent/runtime");
require("./lib/codeagent/runtimes/daytona-runtime"); // registers "daytona" — the ONLY runtime used below
const { makeTools } = require("./lib/codeagent/tools");
const { proposeWithRepair, clearCache } = require("./lib/codeagent/model-loop");

const MAX_ROUNDS = 2; // 1 initial attempt + up to 2 repairs = 3 tries per prompt

const PROMPTS = [
  "Build a multi-step form wizard with 3 steps (contact info, preferences, review) using React Context to share state across all steps, plus a progress bar showing the current step out of 3. Split it into App.tsx and a separate Wizard context/component file.",
  "Build a landing page with a countdown timer counting down to a fixed future date (compute days/hours/minutes/seconds remaining with useEffect and setInterval), and an FAQ accordion below it where clicking a question expands its answer and only one answer can be open at a time.",
  "Build a dashboard mockup: a sidebar with 4 nav links, a stats grid of 4 cards with a label and a number each, and a data table below with 5 rows of fake employee data (name, role, status) — define a shared TypeScript interface for a table row and use it in both the data array and the component props.",
  "Build a shopping cart mini-app: a product list of 4 items each with an 'Add to cart' button, and a cart summary panel that shows added items with a running total price, computed from shared state lifted to App.tsx and passed down as props to both the product list and cart summary components."
];

const WATCHDOG_MS = 8 * 60 * 1000;

async function runOne(prompt, index, total) {
  console.log("\n[" + (index + 1) + "/" + total + "] \"" + prompt.slice(0, 70) + "…\"");
  let ws = null;
  const runtime = createRuntime("daytona");
  const watchdog = setTimeout(async () => {
    console.error("  ⚠ watchdog fired — forcing sandbox cleanup");
    if (ws) { try { await runtime.destroy(ws); } catch (e) { /* best effort */ } }
  }, WATCHDOG_MS);
  watchdog.unref();

  try {
    ws = await runtime.create();
    const tools = makeTools(runtime, ws);

    const install = await tools.run("npm install", 180000);
    if (install.code !== 0) {
      console.log("  ✗ npm install failed (substrate problem, not measuring the model)");
      return { prompt, ok: false, stage: "install" };
    }

    const t0 = Date.now();
    const res = await proposeWithRepair({
      userPrompt: prompt, tools, maxRounds: MAX_ROUNDS,
      onRound: (r) => {
        if (r.ok) { console.log("  round " + r.round + ": ✓ compiled"); return; }
        console.log("  round " + r.round + ": ✗ " + r.errors.length + " error(s) — " + JSON.stringify(r.errors[0]));
      }
    });
    const ms = Date.now() - t0;

    if (res.ok) {
      console.log("  " + (res.repaired ? "✓ REPAIRED and compiled" : "✓ compiled first try") +
        " in " + res.rounds + " round(s), " + (ms / 1000).toFixed(1) + "s, ~$" + (res.costUsd || 0).toFixed(5) +
        (res.jsonRetries ? " (" + res.jsonRetries + " JSON retry)" : ""));
      return { prompt, ok: true, repaired: res.repaired, rounds: res.rounds, costUsd: res.costUsd };
    } else {
      console.log("  ✗ never compiled after " + res.rounds + " round(s): " + res.reason);
      return { prompt, ok: false, stage: "repair-exhausted", rounds: res.rounds, costUsd: res.costUsd, reason: res.reason };
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
    console.log("• codeagent-phase4-demo SKIPPED — DAYTONA_API_KEY is not set");
    process.exit(0);
  }
  client.init();
  const state = client._debugState();
  if (!state.config.enabled || !state.config.routes.json.key) {
    console.log("• codeagent-phase4-demo SKIPPED — AI_ENABLED=1 and AI_JSON_KEY are required");
    process.exit(0);
  }
  clearCache(); // these prompts are new; a stale cache entry would hide a real regression

  console.log("\n--- CODEAGENT PHASE 4: the repair loop, live, measured ---");
  console.log("(" + PROMPTS.length + " harder prompts, up to " + (MAX_ROUNDS + 1) + " attempts each — real sandbox + real model calls)");

  const results = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    results.push(await runOne(PROMPTS[i], i, PROMPTS.length));
  }

  const firstTry = results.filter((r) => r.ok && !r.repaired).length;
  const repaired = results.filter((r) => r.ok && r.repaired).length;
  const neverCompiled = results.filter((r) => !r.ok).length;
  const totalCompiled = firstTry + repaired;
  const totalCost = results.reduce((s, r) => s + (r.costUsd || 0), 0);

  console.log("\n" + "=".repeat(64));
  console.log("RESULT: " + totalCompiled + "/" + PROMPTS.length + " compiled EVENTUALLY (" + Math.round((totalCompiled / PROMPTS.length) * 100) + "%)");
  console.log("  first try: " + firstTry + "  |  fixed by repair: " + repaired + "  |  never compiled: " + neverCompiled);
  console.log("  repair's actual lift: +" + repaired + " prompt(s) that a single-shot-only agent would have simply failed on");
  console.log("  total estimated cost: ~$" + totalCost.toFixed(5));
  console.log("=".repeat(64));

  process.exit(0);
})();
