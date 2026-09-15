/* =================================================================
   model-loop-test.js — lib/codeagent/model-loop.js's contract, no network
   -----------------------------------------------------------------
   The DeepSeek account this was built against currently returns 402
   Insufficient Balance — a real, honest signal from a real call (see
   codeagent-phase3-demo.js), not something this suite works around.
   Everything BELOW the API boundary is still fully provable with a
   stubbed transport: tool-call parsing, the "one retry on malformed
   JSON, then a clean failure" policy from docs/CODE-AGENT-PLAN.md §8,
   and the path-safety checks on what a model is allowed to write.

   This is exactly the split ai-client-test.js already draws for
   lib/ai/client.js — proving the deterministic half for free, so the
   live half (real tokens, real money) only has to prove what nothing
   else could.

   Run: npm run test:model-loop
   ================================================================= */
"use strict";
const assert = require("assert");
const client = require("../lib/ai/client");
const { proposeChanges, proposeWithRepair, proposeWithClientBuild, repairProposal, assessPrompt, buildPlan, parseToolCalls, validateWriteFileArgs, TOOLS_SCHEMA, clearCache, cacheKey, cacheStatsSnapshot,
  fitConversation, codeBudgetChars, systemPromptFor, EFFORT, effortFor, buildCodebaseContext, reviewBuild } = require("../lib/codeagent/model-loop");
const clientMod = require("../lib/ai/client");

let passed = 0, failed = 0;
async function check(name, fn) {
  // The response cache (added for real DeepSeek spend, see the "cache" tests
  // below) is a module-level singleton — several tests here reuse the exact
  // string "build a landing page" against DIFFERENT stubs to test different
  // failure modes. Without a clear per test, test #2 would silently receive
  // test #1's cached result instead of exercising its own stub.
  clearCache();
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

function toolCallMsg(calls) {
  return { role: "assistant", tool_calls: calls.map((c, i) => ({ id: "call_" + i, type: "function", function: { name: "write_file", arguments: JSON.stringify(c) } })) };
}
function fetchReturning(messages) {
  let i = 0;
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: messages[Math.min(i++, messages.length - 1)], finish_reason: "tool_calls" }], usage: { prompt_tokens: 200, completion_tokens: 150 } })
  });
}

/** A fake tools.js for proposeWithRepair tests — records every write_file
    call and returns a scripted, ordered sequence of build() outcomes so a
    test can say "fail once, then succeed" without a real sandbox. */
function fakeTools(buildResults) {
  let i = 0;
  const writes = [];
  return {
    writes,
    async write_file(path, content) { writes.push({ path, content }); return { ok: true }; },
    async build() {
      const r = buildResults[Math.min(i, buildResults.length - 1)];
      i++;
      return r.ok ? { ok: true, errors: [] } : { ok: false, errors: r.errors || [{ file: "src/App.tsx", line: 1, message: "fake build error " + i }] };
    }
  };
}

const ROUTES = { prose: { baseUrl: "https://x.invalid/prose", model: "gemini-3.8-flash", key: "k" }, json: { baseUrl: "https://x.invalid/json", model: "deepseek-chat", key: "k" } };

(async () => {
  console.log("\n── a build with no entry file is not a build ───────");

  /* src/main.tsx mounts src/App.tsx. A tree without it type-checks perfectly
     and renders nothing, which is how "build an e-commerce storefront" came
     back as three utility files, a green tick and a black screen. */

  await check("no App.tsx on a fresh build -> not accepted, the model is asked for it", async () => {
    const utils = toolCallMsg([
      { path: "src/types.ts", content: "export type Product = { id: string };" },
      { path: "src/data.ts", content: "export const products = [];" }
    ]);
    const withApp = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return null}" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([utils, withApp]) });

    const rounds = [];
    const res = await proposeWithClientBuild({
      userPrompt: "build an e-commerce storefront",
      hasExistingEntry: false,
      onFiles: async () => ({ ok: true, errors: [] }),   // it always type-checks
      onRound: (r) => rounds.push(r)
    });

    assert.strictEqual(rounds[0].ok, false, "round 0 was accepted despite having no entry file");
    assert.strictEqual(rounds[0].errors[0].code, "NO_ENTRY");
    assert.strictEqual(res.ok, true, "the second round supplied App.tsx and should succeed");
    assert.ok(res.calls.some((c) => c.path === "src/App.tsx"), "the result has no entry file");
    assert.ok(res.calls.some((c) => c.path === "src/types.ts"),
      "the earlier files were dropped instead of accumulated");
  });

  /* The turn is killed at a fixed ceiling by the platform, and until this
     guard existed the loop had no idea. It would start a fourth repair round
     with forty seconds left, get the process taken out from under it, and the
     client — which had just watched eleven files get written — threw "No
     result came back" over a tree that was sitting in memory the whole time.

     Six minutes of Max effort for nothing, twice in a row, is what this is. */
  await check("out of time mid-repair -> hands back the files it has, not nothing", async () => {
    const first = toolCallMsg([
      { path: "src/App.tsx", content: "export default function App(){return <div/>}" },
      { path: "src/Header.tsx", content: "export default function H(){return <h1/>}" }
    ]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([first]) });

    let builds = 0;
    const res = await proposeWithClientBuild({
      userPrompt: "build a five star restaurant site",
      hasExistingEntry: true,
      maxRounds: 4,
      // Always fails, so without a deadline this would run every round.
      onFiles: async () => { builds++; return { ok: false, errors: [{ file: "src/App.tsx", line: 2, message: "Cannot find name 'x'." }] }; },
      // Already spent by the time round 1 would start.
      deadlineAt: Date.now() + 500
    });

    assert.strictEqual(res.ok, true, "a turn that ran out of time returned no files at all");
    assert.strictEqual(res.ranOutOfTime, true, "the result does not say it was cut short");
    assert.ok(res.calls.some((c) => c.path === "src/App.tsx"), "App.tsx was thrown away");
    assert.ok(res.calls.some((c) => c.path === "src/Header.tsx"), "Header.tsx was thrown away");
    assert.strictEqual(res.verified, false, "a tree that never compiled was reported as verified");
    assert.ok(/Cannot find name/.test(res.note || ""), "the note does not carry the last build error");
    assert.strictEqual(builds, 1, "it started another round it had no time to finish");
  });

  await check("round 0 always runs, however little time is left", async () => {
    const first = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return null}" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([first]) });
    const res = await proposeWithClientBuild({
      userPrompt: "build a landing page for a bakery",
      hasExistingEntry: true,
      onFiles: async () => ({ ok: true, errors: [] }),
      deadlineAt: Date.now() - 60000   // already past
    });
    assert.strictEqual(res.ok, true, "an expired deadline skipped the only round that produces anything");
    assert.ok(!res.ranOutOfTime, "a build that finished was reported as cut short");
    assert.ok(res.calls.some((c) => c.path === "src/App.tsx"));
  });

  await check("no deadline -> unchanged, every repair round still runs", async () => {
    const bad = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return <div/>}" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([bad]) });
    let builds = 0;
    await proposeWithClientBuild({
      userPrompt: "build a portfolio with a projects grid",
      hasExistingEntry: true,
      maxRounds: 2,
      onFiles: async () => { builds++; return { ok: false, errors: [{ file: "src/App.tsx", line: 1, message: "boom" }] }; }
    });
    assert.ok(builds >= 3, "the repair budget shrank when no deadline was given (built " + builds + " times)");
  });

  /* The case the first version of this guard missed. It gated on "is there
     conversation history", which is false only on the very first message — so
     a project whose first build produced no App.tsx had history from message
     two onward, and the check switched itself off exactly when it was needed. */
  await check("no App.tsx on a FOLLOW-UP to a project that has none -> still caught", async () => {
    const utils = toolCallMsg([{ path: "src/lib/format.ts", content: "export const f = (n:number)=>String(n);" }]);
    const withApp = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return null}" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([utils, withApp]) });

    const rounds = [];
    await proposeWithClientBuild({
      userPrompt: "add electronics",
      hasExistingEntry: false,
      history: [{ role: "user", body: "build e commerce" }, { role: "assistant", body: "done" }],
      onFiles: async () => ({ ok: true, errors: [] }),
      onRound: (r) => rounds.push(r)
    });
    assert.strictEqual(rounds[0].ok, false,
      "history made the guard skip — the exact case it exists for");
    assert.strictEqual(rounds[0].errors[0].code, "NO_ENTRY");
  });

  await check("a missing entry file costs no compile — it is known before building", async () => {
    /* The compile that used to run here could only ever pass: the scaffold
       ships a placeholder src/App.tsx, so leaf files resolve against it, type
       -check, and render "Souqi Code". It was ~13s of WebContainer install
       spent proving a placeholder is valid TypeScript, on a question `written`
       already answers. */
    const utils = toolCallMsg([
      { path: "src/types.ts", content: "export type E = { id: string };" },
      { path: "src/lib/split.ts", content: "export const split = () => 1;" }
    ]);
    const withApp = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return null}" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([utils, withApp]) });

    let builds = 0;
    const res = await proposeWithClientBuild({
      userPrompt: "an expense splitter for roommates",
      hasExistingEntry: false,
      onFiles: async () => { builds++; return { ok: true, errors: [] }; }
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(builds, 1, "compiled " + builds + " times; the round with no App.tsx should not build at all");
    assert.ok(res.calls.some((c) => c.path === "src/types.ts"),
      "the files written before App.tsx were dropped — skipping the build must not skip collecting them");
  });

  await check("a follow-up that edits one component is left alone", async () => {
    const edit = toolCallMsg([{ path: "src/components/Header.tsx", content: "export const Header = () => null;" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([edit]) });

    let modelCalls = 0;
    const respond = fetchReturning([edit]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { modelCalls++; return respond(); } });

    const res = await proposeWithClientBuild({
      userPrompt: "make the header sticky",
      hasExistingEntry: true,                 // the project already has one
      onFiles: async () => ({ ok: true, errors: [] })
    });
    assert.strictEqual(res.ok, true, "an ordinary edit was rejected for not rewriting App.tsx");
    assert.strictEqual(modelCalls, 1, "the guard forced a pointless repair round");
    assert.deepStrictEqual(res.calls.map((c) => c.path), ["src/components/Header.tsx"]);
  });

  await check("a fresh build that does write App.tsx passes straight through", async () => {
    const good = toolCallMsg([
      { path: "src/App.tsx", content: "export default function App(){return null}" },
      { path: "src/data.ts", content: "export const x = 1;" }
    ]);
    let modelCalls = 0;
    const respond = fetchReturning([good]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { modelCalls++; return respond(); } });

    const res = await proposeWithClientBuild({
      userPrompt: "build a calculator",
      hasExistingEntry: false,
      onFiles: async () => ({ ok: true, errors: [] })
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(modelCalls, 1, "a correct build was sent back for repair");
  });

  console.log("\n── validateWriteFileArgs: path safety ──────────────");

  await check("a normal src/ path is accepted", () => {
    const r = validateWriteFileArgs({ path: "src/App.tsx", content: "x" });
    assert.strictEqual(r.path, "src/App.tsx");
  });
  await check("path traversal is rejected", () => {
    assert.throws(() => validateWriteFileArgs({ path: "src/../../etc/passwd", content: "x" }), /not a safe relative path/);
  });
  await check("an absolute path is rejected", () => {
    assert.throws(() => validateWriteFileArgs({ path: "/etc/passwd", content: "x" }), /not a safe relative path/);
  });
  await check("a path outside src/ is rejected — the model may not touch the fixed scaffold files", () => {
    assert.throws(() => validateWriteFileArgs({ path: "package.json", content: "{}" }), /only files under src\//);
  });
  await check("non-string content is rejected", () => {
    assert.throws(() => validateWriteFileArgs({ path: "src/App.tsx", content: 12345 }), /must be a string/);
  });
  await check("an empty path is rejected", () => {
    assert.throws(() => validateWriteFileArgs({ path: "", content: "x" }), /non-empty string/);
  });

  console.log("\n── parseToolCalls ───────────────────────────────────");

  await check("a single valid write_file call parses", () => {
    const r = parseToolCalls(toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return null}" }]));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.calls.length, 1);
    assert.strictEqual(r.calls[0].path, "src/App.tsx");
  });
  await check("multiple write_file calls in one message all parse, in order", () => {
    const r = parseToolCalls(toolCallMsg([
      { path: "src/App.tsx", content: "a" },
      { path: "src/components/Hero.tsx", content: "b" }
    ]));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.calls.length, 2);
    assert.strictEqual(r.calls[1].path, "src/components/Hero.tsx");
  });
  await check("no tool calls at all -> a clean, named failure, not a crash", () => {
    const r = parseToolCalls({ role: "assistant", content: "I'm not sure what to build." });
    assert.strictEqual(r.ok, false);
    assert.ok(/no tool calls/.test(r.reason));
  });
  await check("malformed JSON in the arguments -> a clean failure naming it", () => {
    const msg = { tool_calls: [{ function: { name: "write_file", arguments: "{not valid json" } }] };
    const r = parseToolCalls(msg);
    assert.strictEqual(r.ok, false);
    assert.ok(/malformed JSON/.test(r.reason));
  });
  await check("a tool call for anything other than write_file is rejected", () => {
    const msg = { tool_calls: [{ function: { name: "run_shell_command", arguments: "{}" } }] };
    const r = parseToolCalls(msg);
    assert.strictEqual(r.ok, false);
    assert.ok(/unexpected tool call/.test(r.reason));
  });
  await check("one bad call in a batch fails the WHOLE batch, not a partial apply", () => {
    const msg = toolCallMsg([{ path: "src/App.tsx", content: "a" }]);
    msg.tool_calls.push({ function: { name: "write_file", arguments: "{broken" } });
    const r = parseToolCalls(msg);
    assert.strictEqual(r.ok, false, "a batch with one malformed call should not report ok:true for the good half");
  });

  console.log("\n── proposeChanges: the one-retry policy, end to end ─");

  await check("a clean single-shot success needs no retry", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "ok" }])]) });
    const res = await proposeChanges("build a landing page");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.retried, false);
    assert.strictEqual(res.calls.length, 1);
  });

  await check("malformed JSON on attempt 1, valid on attempt 2 -> succeeds, marked retried", async () => {
    const bad = { tool_calls: [{ function: { name: "write_file", arguments: "{oops" } }] };
    const good = toolCallMsg([{ path: "src/App.tsx", content: "fixed" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([bad, good]) });
    const res = await proposeChanges("build a landing page");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.retried, true);
    assert.strictEqual(res.calls[0].content, "fixed");
  });

  await check("the retry message sequence is protocol-valid — a tool response per tool_call_id, before the follow-up user message", async () => {
    // Found live against the real DeepSeek API, not by inspection: an
    // assistant message carrying tool_calls MUST be followed immediately by
    // one `tool` role message per tool_call_id — skip straight to a `user`
    // message (what this looked like before the fix) and the provider
    // rejects the WHOLE request with 400, not just the malformed call.
    const bad = { role: "assistant", tool_calls: [{ id: "call_abc123", type: "function", function: { name: "write_file", arguments: "{broken" } }] };
    const good = toolCallMsg([{ path: "src/App.tsx", content: "fixed" }]);
    let secondCallMessages = null;
    let n = 0;
    const respond = fetchReturning([bad, good]);
    client.init({
      enabled: true, routes: ROUTES,
      fetchImpl: async (url, opts) => {
        n++;
        if (n === 2) secondCallMessages = JSON.parse(opts.body).messages;
        return respond();
      }
    });
    const res = await proposeChanges("build a landing page");
    assert.strictEqual(res.ok, true, "setup failed: " + JSON.stringify(res));
    assert.ok(secondCallMessages, "the retry never happened");

    const assistantIdx = secondCallMessages.findIndex((m) => m.role === "assistant" && m.tool_calls);
    assert.ok(assistantIdx >= 0, "the broken assistant message was dropped instead of being explained to the model");
    const toolMsg = secondCallMessages[assistantIdx + 1];
    assert.strictEqual(toolMsg && toolMsg.role, "tool", "no tool-role response immediately follows the assistant's tool_calls message");
    assert.strictEqual(toolMsg.tool_call_id, "call_abc123", "the tool response's tool_call_id does not match the original call's id");
    assert.strictEqual(secondCallMessages[assistantIdx + 2].role, "user", "the follow-up instruction should come after the required tool response, not before it");
  });

  await check("malformed JSON twice in a row -> a clean failure, no third attempt", async () => {
    const bad = { tool_calls: [{ function: { name: "write_file", arguments: "{still broken" } }] };
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([bad])()); } });
    const res = await proposeChanges("build a landing page");
    // A build never hard-fails: the user gets a runnable template rather than
    // an error. But the failure must stay legible, or a path-safety violation
    // and a timeout become the same event in the logs.
    assert.strictEqual(res.fallback, true, "expected the template fallback, not a real design");
    assert.ok(/twice in a row/.test(res.reason), "the fallback must carry WHY, got: " + res.reason);
    assert.strictEqual(calls, 2, "expected exactly 2 attempts (1 + 1 retry), got " + calls);
  });

  await check("a truncated completion (finish_reason:length) retries with a BIGGER token budget, not the same one that just failed", async () => {
    // Found live: a real request failed "malformed tool call twice in a
    // row" because the completion was cut off mid-JSON-string by
    // MAX_TOKENS both times — the retry was reusing the exact same
    // budget that had just proven insufficient, so a genuinely large
    // file failed identically forever. finish_reason "length" (not
    // "tool_calls") is what distinguishes an honest truncation from the
    // model actually writing bad syntax, and that's what should widen
    // the retry's budget instead of just repeating the first attempt.
    const truncated = { tool_calls: [{ function: { name: "write_file", arguments: '{"path":"src/App.tsx","content":"unterminated' } }] };
    const good = toolCallMsg([{ path: "src/App.tsx", content: "fits this time" }]);
    const finishReasons = ["length", "tool_calls"];
    const requestBodies = [];
    let i = 0;
    client.init({
      enabled: true, routes: ROUTES,
      fetchImpl: async (url, opts) => {
        requestBodies.push(JSON.parse(opts.body));
        const message = i === 0 ? truncated : good;
        const finish_reason = finishReasons[Math.min(i, finishReasons.length - 1)];
        i++;
        return { ok: true, json: async () => ({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 200, completion_tokens: 150 } }) };
      }
    });
    const res = await proposeChanges("build a big dashboard");
    assert.strictEqual(res.ok, true, "setup failed: " + JSON.stringify(res));
    assert.strictEqual(res.retried, true);
    assert.strictEqual(requestBodies.length, 2, "expected exactly 2 attempts");
    assert.ok(requestBodies[1].max_tokens > requestBodies[0].max_tokens,
      "the retry after a truncation should ask for MORE tokens than the attempt that got cut off — got " + requestBodies[0].max_tokens + " then " + requestBodies[1].max_tokens);
  });

  await check("truncated twice in a row -> a clean failure that says so, not a generic 'malformed' message", async () => {
    const truncated = { tool_calls: [{ function: { name: "write_file", arguments: '{"path":"src/App.tsx","content":"still unterminated' } }] };
    client.init({
      enabled: true, routes: ROUTES,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: truncated, finish_reason: "length" }], usage: { prompt_tokens: 200, completion_tokens: 150 } }) })
    });
    const res = await proposeChanges("build a big dashboard");
    assert.strictEqual(res.fallback, true, "expected the template fallback");
    assert.ok(/too large to finish writing/.test(res.reason), "expected a truncation-specific message, got: " + res.reason);
  });

  await check("a path-safety violation is treated the same as malformed JSON — one retry, then fail clean", async () => {
    const unsafe = toolCallMsg([{ path: "../outside.txt", content: "x" }]);
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([unsafe])()); } });
    const res = await proposeChanges("build a landing page");
    assert.strictEqual(res.fallback, true, "expected the template fallback");
    assert.strictEqual(calls, 2);
    // The one failure mode that must never be silent: the model tried to write
    // outside src/. It is allowed to end in a template, not in nothing said.
    assert.ok(res.reason && /safe relative path|only files under src\//.test(res.reason),
      "a path-safety violation must be named in the reason, got: " + res.reason);
  });

  console.log("\n── proposeChanges surfaces ai/client's own guarantees ──");

  await check("AI disabled -> proposeChanges fails clean, no crash, no fetch reached", async () => {
    let reached = false;
    client.init({ enabled: false, routes: ROUTES, fetchImpl: async () => { reached = true; } });
    const res = await proposeChanges("build a landing page");
    assert.strictEqual(res.fallback, true, "expected the template fallback");
    assert.strictEqual(res.disabled, true, "ai/client's `disabled` must survive the fallback");
    assert.strictEqual(reached, false, "AI disabled must not reach the network");
  });

  console.log("\n── the tool schema itself ───────────────────────────");

  /* This used to assert TOOLS_SCHEMA.length === 1, which was a proxy for
     the thing actually worth protecting: the model is never handed a tool
     that can EXECUTE anything. Adding the inert suggest_next broke the
     proxy without touching the invariant, so the invariant is written out
     directly here instead — an allow-list plus an explicit refusal of the
     dangerous names, which is a stronger guarantee than a count and does
     not have to be revisited every time a harmless tool is added. */
  await check("only inert tools are offered — nothing that can execute", () => {
    const names = TOOLS_SCHEMA.map((s) => s.function.name).sort();
    /* edit_file joins the list and the claim still holds: it changes text in
       a file the model was already allowed to overwrite, through the same
       path validation and the same PROTECTED_PATHS. It executes nothing.

       read_file joins it too, and is inert in a stronger sense: it never
       touches the filesystem. It looks the path up in the in-memory file map
       the caller passed for this one request, so there is nothing on the host
       for a traversal to reach even if validateReadPath were bypassed.

       This assertion is deliberately an exact set rather than a subset check,
       so adding a tool to the model's surface cannot happen quietly — which
       is why it caught both of these. */
    /* search_code joins them, and is inert on the same terms as read_file:
       it iterates the same in-memory map through the same validateReadPath,
       so it can never name a file a read could not have opened anyway. It
       spawns nothing and touches no disk. */
    assert.deepStrictEqual(names, ["edit_file", "read_file", "search_code", "suggest_next", "write_file"]);
    for (const forbidden of ["run", "exec", "shell", "bash", "npm_install", "install", "fetch", "http"]) {
      assert.ok(!names.includes(forbidden), "a tool named " + forbidden + " is offered to the model");
    }
  });

  await check("suggest_next rides along with the writes and comes back as suggestions", async () => {
    const msg = {
      role: "assistant",
      tool_calls: [
        { id: "c0", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "x" }) } },
        { id: "c1", type: "function", function: { name: "suggest_next", arguments: JSON.stringify({ suggestions: ["Add a dark mode toggle", "Filter by category"] }) } }
      ]
    };
    client.init({ enabled: true, routes: ROUTES, fetchImpl: await fetchReturning([msg]) });
    const out = await proposeChanges("a budget tracker " + Math.random());
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.calls.length, 1, "suggest_next was counted as a file write");
    assert.deepStrictEqual(out.suggestions, ["Add a dark mode toggle", "Filter by category"]);
  });

  await check("a malformed suggest_next is dropped, never fails the build it came with", async () => {
    const msg = {
      role: "assistant",
      tool_calls: [
        { id: "c0", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "y" }) } },
        { id: "c1", type: "function", function: { name: "suggest_next", arguments: "{not json" } }
      ]
    };
    client.init({ enabled: true, routes: ROUTES, fetchImpl: await fetchReturning([msg]) });
    const out = await proposeChanges("a todo app " + Math.random());
    assert.strictEqual(out.ok, true, "malformed suggestions failed the whole turn");
    assert.deepStrictEqual(out.suggestions, []);
  });

  await check("suggestions are capped at 3 and trimmed — a chip is not a paragraph", async () => {
    const long = "x".repeat(200);
    const msg = {
      role: "assistant",
      tool_calls: [
        { id: "c0", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "z" }) } },
        { id: "c1", type: "function", function: { name: "suggest_next", arguments: JSON.stringify({ suggestions: ["  a  b  ", long, "three", "four", "five"] }) } }
      ]
    };
    client.init({ enabled: true, routes: ROUTES, fetchImpl: await fetchReturning([msg]) });
    const out = await proposeChanges("a shop " + Math.random());
    assert.strictEqual(out.suggestions.length, 3);
    assert.strictEqual(out.suggestions[0], "a b", "inner whitespace was not collapsed");
    assert.ok(out.suggestions[1].length <= 80, "a suggestion came back longer than a chip can hold");
  });

  await check("suggest_next cannot write, run or reach anything — it only carries strings", () => {
    const s = TOOLS_SCHEMA.find((x) => x.function.name === "suggest_next");
    const props = s.function.parameters.properties;
    assert.deepStrictEqual(Object.keys(props), ["suggestions"]);
    assert.strictEqual(props.suggestions.type, "array");
    assert.strictEqual(props.suggestions.items.type, "string");
  });

  console.log("\n── response cache (docs/AI-PROVIDER-PLAN.md §4.1) ──");

  await check("the exact same prompt twice -> ONE network call, second is free", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "same design" }])])()); } });
    const first = await proposeChanges("a barber shop landing page");
    const second = await proposeChanges("a barber shop landing page");
    assert.strictEqual(calls, 1, "the second call reached the network — the cache did nothing");
    assert.strictEqual(first.cached, false, "the FIRST call should not itself claim to be cached");
    assert.strictEqual(second.cached, true, "the second call did not report cached:true");
    assert.strictEqual(second.costUsd, 0, "a cache hit must cost $0, not the real call's cost");
    assert.deepStrictEqual(second.calls, first.calls, "a cache hit returned different files than the original design");
  });

  await check("whitespace/case differences still hit the cache — same request, differently typed", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "x" }])])()); } });
    await proposeChanges("A Barber Shop Landing Page");
    await proposeChanges("  a barber shop landing page  ");
    assert.strictEqual(calls, 1, "trivial whitespace/case differences should not bypass the cache");
  });

  await check("a DIFFERENT prompt is a cache miss — no fuzzy matching, no serving the wrong design", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "x" }])])()); } });
    await proposeChanges("a barber shop landing page");
    await proposeChanges("a bakery landing page");
    assert.strictEqual(calls, 2, "two genuinely different prompts must not collide in the cache");
  });

  await check("a FAILED call is never cached — a timeout isn't a design worth remembering", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; } });
    const first = await proposeChanges("a barber shop landing page");
    assert.strictEqual(first.fallback, true, "a 500 should end in the template fallback");
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "x" }])])()); } });
    const second = await proposeChanges("a barber shop landing page");
    assert.strictEqual(second.ok, true, "a prior failure should not poison later attempts at the same prompt");
    assert.ok(!second.fallback, "the second call should produce a real design, not the template again");
    assert.strictEqual(second.calls[0].content, "x");
    assert.strictEqual(calls, 2, "the failed first call should not have been treated as a cache entry to skip past");
  });

  await check("a retried-but-eventually-successful design is cached too — the NEXT call for it is free", async () => {
    let calls = 0;
    const bad = { tool_calls: [{ function: { name: "write_file", arguments: "{broken" } }] };
    const good = toolCallMsg([{ path: "src/App.tsx", content: "fixed" }]);
    // ONE shared closure (persistent internal `i`) so the retry's two
    // sequential calls correctly see bad-then-good, not bad-then-bad —
    // recreating fetchReturning() fresh per call (as an earlier draft of
    // this test did) resets that counter every time and never reaches "good".
    const respond = fetchReturning([bad, good]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return respond(); } });
    const first = await proposeChanges("a barber shop landing page");
    assert.strictEqual(first.ok, true, "setup failed: " + JSON.stringify(first));
    assert.strictEqual(calls, 2, "expected the 1 + 1 retry from the first call");
    const second = await proposeChanges("a barber shop landing page");
    assert.strictEqual(second.cached, true);
    assert.strictEqual(calls, 2, "the second call for the same (now-cached) prompt reached the network");
  });

  console.log("\n── proposeWithRepair (Phase 4, docs/CODE-AGENT-PLAN.md §2) ──");

  await check("build succeeds on round 0 -> no repair round, repaired:false", async () => {
    let modelCalls = 0;
    const respond = fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "v1" }])]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { modelCalls++; return respond(); } });
    const tools = fakeTools([{ ok: true }]);
    const res = await proposeWithRepair({ userPrompt: "a barber shop landing page", tools });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.repaired, false);
    assert.strictEqual(res.rounds, 1);
    assert.strictEqual(modelCalls, 1, "a same-round success should not have called the model twice");
    assert.strictEqual(tools.writes.length, 1);
  });

  await check("build fails once, the repair round fixes it -> ok:true, repaired:true, rounds:2", async () => {
    const v1 = toolCallMsg([{ path: "src/App.tsx", content: "broken version" }]);
    const v2 = toolCallMsg([{ path: "src/App.tsx", content: "fixed version" }]);
    const respond = fetchReturning([v1, v2]);
    let modelCalls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { modelCalls++; return respond(); } });
    const tools = fakeTools([{ ok: false, errors: [{ file: "src/App.tsx", line: 4, message: "Type 'string' is not assignable to type 'number'." }] }, { ok: true }]);
    const rounds = [];
    const res = await proposeWithRepair({ userPrompt: "a barber shop landing page", tools, onRound: (r) => rounds.push(r) });
    assert.strictEqual(res.ok, true, "setup failed: " + JSON.stringify(res));
    assert.strictEqual(res.repaired, true);
    assert.strictEqual(res.rounds, 2);
    assert.strictEqual(modelCalls, 2, "expected exactly one model call per round, no extra retries");
    assert.strictEqual(tools.writes[1].content, "fixed version", "the repaired write did not use the round-2 output");
    assert.strictEqual(rounds.length, 2);
    assert.strictEqual(rounds[0].ok, false);
    assert.strictEqual(rounds[1].ok, true);
  });

  await check("the repair message is protocol-valid AND carries the real build errors, not a generic prompt", async () => {
    const v1 = toolCallMsg([{ path: "src/App.tsx", content: "v1" }]);
    const v2 = toolCallMsg([{ path: "src/App.tsx", content: "v2" }]);
    const respond = fetchReturning([v1, v2]);
    let secondCallMessages = null, n = 0;
    client.init({
      enabled: true, routes: ROUTES,
      fetchImpl: async (url, opts) => { n++; if (n === 2) secondCallMessages = JSON.parse(opts.body).messages; return respond(); }
    });
    const tools = fakeTools([{ ok: false, errors: [{ file: "src/App.tsx", line: 7, message: "Cannot find name 'foo'." }] }, { ok: true }]);
    await proposeWithRepair({ userPrompt: "x", tools });

    const assistantIdx = secondCallMessages.findIndex((m) => m.role === "assistant" && m.tool_calls);
    assert.ok(assistantIdx >= 0, "the round-1 assistant message is missing from the repair conversation");
    assert.strictEqual(secondCallMessages[assistantIdx + 1].role, "tool", "no tool-role response immediately follows the assistant's tool_calls — same protocol requirement as the JSON-retry path");
    const errorMsg = secondCallMessages[secondCallMessages.length - 1];
    assert.strictEqual(errorMsg.role, "user");
    assert.ok(errorMsg.content.indexOf("Cannot find name 'foo'") >= 0, "the repair prompt did not include the ACTUAL build error — the model can't fix what it can't see");
    assert.ok(errorMsg.content.indexOf("src/App.tsx:7") >= 0, "the repair prompt dropped the file/line the error came from");
  });

  await check("a build that never passes stops at the round cap, not forever", async () => {
    let modelCalls = 0;
    const respond = fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "always broken" }])]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { modelCalls++; return respond(); } });
    const tools = fakeTools([{ ok: false }]); // every round fails — fakeTools clamps to the last entry
    const res = await proposeWithRepair({ userPrompt: "x", tools, maxRounds: 2 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.rounds, 3, "maxRounds:2 means 1 initial try + 2 repairs = 3 total attempts");
    assert.strictEqual(modelCalls, 3, "the loop kept calling the model past the cap");
    assert.ok(/still failing/.test(res.reason));
  });

  await check("maxRounds:0 means exactly one attempt, no repair calls at all", async () => {
    let modelCalls = 0;
    const respond = fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "x" }])]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { modelCalls++; return respond(); } });
    const tools = fakeTools([{ ok: false }]);
    const res = await proposeWithRepair({ userPrompt: "x", tools, maxRounds: 0 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.rounds, 1);
    assert.strictEqual(modelCalls, 1);
  });

  await check("a model-call failure mid-loop surfaces cleanly instead of looping on nothing", async () => {
    const v1 = toolCallMsg([{ path: "src/App.tsx", content: "v1" }]);
    let n = 0;
    client.init({
      enabled: true, routes: ROUTES,
      fetchImpl: async () => { n++; if (n === 1) return (await fetchReturning([v1])()); return { ok: false, status: 500, json: async () => ({}) }; }
    });
    const tools = fakeTools([{ ok: false }]);
    const res = await proposeWithRepair({ userPrompt: "x", tools, maxRounds: 3 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.round, 1, "should have stopped at the round where the model call itself failed, not exhausted the whole cap");
    assert.strictEqual(n, 2, "the loop kept calling a provider that just failed");
  });

  await check("proposeWithRepair never pollutes proposeChanges' cache — different contracts, different lifetimes", async () => {
    let calls = 0;
    const respond = fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "from repair" }])]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return respond(); } });
    const tools = fakeTools([{ ok: true }]);
    await proposeWithRepair({ userPrompt: "same prompt", tools });
    assert.strictEqual(calls, 1);
    const viaCache = await proposeChanges("same prompt");
    assert.strictEqual(calls, 2, "proposeChanges got a free ride off proposeWithRepair's call — the two must not share cache state");
    assert.strictEqual(viaCache.ok, true);
  });

  console.log("\n── assessPrompt: ask, don't guess ──────────────────");

  function jsonReplyFetch(contentObj) {
    return async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: typeof contentObj === "string" ? contentObj : JSON.stringify(contentObj) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 30 }
      })
    });
  }

  await check("a clear prompt -> {clear:true}, no reply to show", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch({ clear: true }) });
    const res = await assessPrompt("a landing page for a bakery");
    assert.strictEqual(res.clear, true);
  });

  await check("a vague prompt -> {clear:false} with the model's own warm reply, not a canned question", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch({ clear: false, reply: "Hey! 👋 What would you like me to build?" }) });
    const res = await assessPrompt("make it really nice please");
    assert.strictEqual(res.clear, false);
    assert.strictEqual(res.reply, "Hey! 👋 What would you like me to build?");
  });

  await check("uses the prose (Gemini) route, not json — `reply` is spoken to the user in their own language", async () => {
    let hitUrl = "";
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (url) => { hitUrl = url; return (await jsonReplyFetch({ clear: true })()); } });
    await assessPrompt("make it really nice please");
    // The classification half of this call would be fine on the cheap code
    // model. The `reply` half is not: it is shown verbatim to someone who may
    // have written in Turkish or Arabic, which is what the prose route is for.
    assert.ok(hitUrl.indexOf("/prose") >= 0, "expected the prose-route baseUrl, got: " + hitUrl);
    assert.ok(hitUrl.indexOf("/json") < 0, "assessPrompt must not fall back to the code model's route");
  });

  /* buildPlan moved to the reasoning tier, deliberately reversing what this
     test used to assert. Deciding WHAT to build is the most reasoning-heavy
     call in the agent and the one whose mistakes cost most — everything
     downstream executes against the plan, so a bad plan is a well-built wrong
     app.

     The concern the old assertion protected is real and is not gone: the
     title and summary are shown to the person verbatim, so a weaker
     multilingual model writes a worse plan card for someone who asked in
     Turkish or Arabic. That is the accepted trade. assessPrompt stays on
     prose precisely because it carries the conversational half — the
     clarifying question the person actually answers. */
  await check("buildPlan uses the reasoning tier — planning is the expensive call to get wrong", async () => {
    let hitUrl = "", sentModel = "";
    const plan = { title: "Bakery Site", summary: "A landing page for a bakery.", features: ["Menu section", "Opening hours", "Contact form"] };
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (url, o) => {
      hitUrl = url; sentModel = JSON.parse(o.body).model; return (await jsonReplyFetch(plan)()); } });
    const res = await buildPlan("a landing page for a bakery", "website");
    assert.ok(hitUrl.indexOf("/json") >= 0, "expected the code-model route, got: " + hitUrl);
    assert.ok(sentModel, "a model must be named on the request");
    assert.strictEqual(res.title, "Bakery Site", "the model's plan should be used when the call succeeds");
  });

  await check("buildPlan falls back to a deterministic plan when the prose route is down — an outage must not block a build", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({ error: "Insufficient Balance" }) }) });
    const res = await buildPlan("a landing page for a bakery", "website");
    assert.ok(res && typeof res.summary === "string" && res.summary.length > 0, "expected a usable fallback plan, got: " + JSON.stringify(res));
  });

  await check("clear:false with NO reply text -> fails open, not a broken prompt", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch({ clear: false }) });
    const res = await assessPrompt("make it really nice please");
    assert.strictEqual(res.clear, true, "a malformed refusal should fail OPEN (let the build proceed), not silently block one");
  });

  await check("clear:false with an empty/whitespace reply -> also fails open", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch({ clear: false, reply: "   " }) });
    const res = await assessPrompt("make it really nice please");
    assert.strictEqual(res.clear, true);
  });

  await check("malformed JSON from the assessment call itself -> fails open", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch("not json at all") });
    const res = await assessPrompt("make it really nice please");
    assert.strictEqual(res.clear, true);
  });

  await check("the assessment call failing outright (network, breaker, budget) -> fails open, never blocks a build", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    const res = await assessPrompt("make it really nice please");
    assert.strictEqual(res.clear, true);
  });

  await check("AI disabled -> fails open too, no crash, no fetch reached", async () => {
    let reached = false;
    client.init({ enabled: false, routes: ROUTES, fetchImpl: async () => { reached = true; } });
    const res = await assessPrompt("make it really nice please");
    assert.strictEqual(res.clear, true);
    assert.strictEqual(reached, false);
  });

  await check("quickAssess answers greetings and noise itself — no model call, works with the provider down", async () => {
    let reached = false;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { reached = true; } });
    for (const noise of ["hello", "hi", "HHH", "haha", "test", "ok", "zzz"]) {
      const res = await assessPrompt(noise);
      assert.strictEqual(res.clear, false, JSON.stringify(noise) + " should not reach a build");
      assert.ok(res.reply && res.reply.length > 0, "should offer a reply to show");
    }
    assert.strictEqual(reached, false, "the gate must not touch the network");
  });

  await check("quickAssess never rejects a real request, however short", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch({ clear: true }) });
    for (const real of ["a todo app", "bakery site", "crm", "gym", "2d game", "portfolio"]) {
      const res = await assessPrompt(real);
      assert.strictEqual(res.clear, true, JSON.stringify(real) + " is a build request");
    }
  });

  console.log("\n── the prose-route cache (this is the Gemini bill) ──");

  // Counts only calls that reach the network. buildPlan/assessPrompt each make
  // exactly one, so `calls` is a direct measure of what Gemini was billed for.
  function countingFetch(contentObj) {
    const box = { calls: 0 };
    box.impl = async () => { box.calls++; return (await jsonReplyFetch(contentObj)()); };
    return box;
  }
  // jsonReplyFetch is declared in the assessPrompt section above and hoists
  // to the top of this IIFE, so it is in scope here.
  const PLAN = { title: "Bakery Site", summary: "A landing page for a bakery.", features: ["Menu", "Hours", "Contact"] };

  await check("the same plan request twice -> ONE Gemini call, the second is free", async () => {
    const f = countingFetch(PLAN);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: f.impl });
    const first = await buildPlan("a landing page for a bakery", "website");
    const second = await buildPlan("a landing page for a bakery", "website");
    assert.strictEqual(f.calls, 1, "expected the second plan to be served from cache, got " + f.calls + " calls");
    assert.strictEqual(second.cached, true);
    assert.strictEqual(second.costUsd, 0, "a cache hit must be billed at zero");
    assert.deepStrictEqual(second.features, first.features);
  });

  await check("a different build type is a different plan — types must not share an entry", async () => {
    const f = countingFetch(PLAN);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: f.impl });
    await buildPlan("a landing page for a bakery", "website");
    await buildPlan("a landing page for a bakery", "game");
    assert.strictEqual(f.calls, 2, "website and game must not serve each other's plan");
  });

  await check("a plan the model could not produce is NOT cached — an outage must not be pinned for 24h", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; } });
    const down = await buildPlan("a landing page for a bakery", "website");
    assert.strictEqual(down.generated, false, "expected the deterministic fallback plan");
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await jsonReplyFetch(PLAN)()); } });
    const recovered = await buildPlan("a landing page for a bakery", "website");
    assert.strictEqual(recovered.generated, true, "the fallback should not have been remembered as the answer");
    assert.strictEqual(calls, 2);
  });

  await check("the same assessment twice -> ONE Gemini call", async () => {
    const f = countingFetch({ clear: false, reply: "Hey! What should I build?" });
    client.init({ enabled: true, routes: ROUTES, fetchImpl: f.impl });
    const first = await assessPrompt("make it really nice please");
    const second = await assessPrompt("make it really nice please");
    assert.strictEqual(f.calls, 1, "expected the second assessment to be free, got " + f.calls + " calls");
    assert.strictEqual(second.reply, first.reply);
    assert.strictEqual(second.costUsd, 0);
  });

  await check("a failed assessment is NOT cached — it fails open, and open is not an answer", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; } });
    const down = await assessPrompt("make it really nice please");
    assert.strictEqual(down.clear, true, "a failed assessment fails open");
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await jsonReplyFetch({ clear: false, reply: "What should I build?" })()); } });
    const recovered = await assessPrompt("make it really nice please");
    assert.strictEqual(recovered.clear, false, "the fail-open shrug should not have been cached as the verdict");
    assert.strictEqual(calls, 2);
  });

  await check("plan, assessment and design never collide on the same prompt", () => {
    const p = "a landing page for a bakery";
    const keys = new Set([
      cacheKey(p, { kind: "plan" }),
      cacheKey(p, { kind: "assess" }),
      cacheKey(p, {})           // design — the default kind
    ]);
    assert.strictEqual(keys.size, 3, "three different questions about one prompt need three entries");
  });

  await check("editing a system prompt invalidates its entries without a manual version bump", () => {
    const p = "a landing page for a bakery";
    const before = cacheKey(p, { kind: "plan", promptHash: "aaaaaaaaaaaa" });
    const after = cacheKey(p, { kind: "plan", promptHash: "bbbbbbbbbbbb" });
    assert.notStrictEqual(before, after, "a changed prompt fingerprint must change the key");
  });

  await check("stats report what the cache actually saved", async () => {
    const f = countingFetch(PLAN);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: f.impl });
    await buildPlan("a landing page for a bakery", "website");
    await buildPlan("a landing page for a bakery", "website");
    await buildPlan("a landing page for a bakery", "website");
    const s = cacheStatsSnapshot();
    assert.strictEqual(s.hits, 2, "two of the three calls should have been hits");
    assert.strictEqual(s.misses, 1);
    assert.ok(s.savedUsd > 0, "a hit on a call that cost money should register a saving");
    assert.ok(s.hitRate > 0.6 && s.hitRate <= 1);
  });

  await check("the cache is bounded — it cannot grow without limit", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch(PLAN) });
    // One more distinct prompt than the cache can hold.
    for (let i = 0; i < 520; i++) await buildPlan("bakery site variant " + i, "website");
    const s = cacheStatsSnapshot();
    assert.ok(s.entries <= s.maxEntries, "entries (" + s.entries + ") must not exceed the cap (" + s.maxEntries + ")");
    assert.ok(s.evictions > 0, "expected the oldest entries to have been evicted");
  });

  await check("eviction is LRU, not FIFO — a prompt that keeps being asked for survives", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch(PLAN) });
    const hot = "the one everybody asks for";
    await buildPlan(hot, "website");
    for (let i = 0; i < 400; i++) {
      await buildPlan("filler " + i, "website");
      if (i % 50 === 0) await buildPlan(hot, "website"); // keep touching it
    }
    for (let i = 400; i < 520; i++) await buildPlan("filler " + i, "website");
    const before = cacheStatsSnapshot().hits;
    await buildPlan(hot, "website");
    assert.strictEqual(cacheStatsSnapshot().hits, before + 1, "a repeatedly-used entry should have survived eviction");
  });

  /* ---- options survive the trip into the loop --------------------------
     These exist because imageUrls did not. It was passed by index.js, never
     named in proposeWithClientBuild's destructure, and therefore undefined by
     the time validateWriteFileArgs looked for it — so the invented-image-URL
     guard never ran on the path that serves every desktop user.

     The unit tests passed throughout, because they called
     validateWriteFileArgs directly with an opts bag. That tests the function
     and not the wiring, and the wiring was the bug. These go through the real
     entry point instead. */
  /* ---- edit_file --------------------------------------------------------
     A surgical edit is only worth having if it is safe, so most of these are
     about refusing rather than applying. An edit that lands in the wrong place
     is worse than a rewrite, because a rewrite is at least visible. */
  console.log("\n── edit_file ───────────────────────────────────────");

  function editMsg(calls) {
    return { role: "assistant", tool_calls: calls.map((c, i) => ({
      id: "e_" + i, type: "function", function: { name: "edit_file", arguments: JSON.stringify(c) } })) };
  }
  /* hasExistingEntry, because every case below hands it a project that
     HAS a src/App.tsx and the route computes this from exactly that.
     Without it the entry guard fires on any round whose writes do not
     include App.tsx — which for an edit test is most of them — and the
     turn under test becomes a NO_ENTRY repair instead. */
  const runEdit = (calls, files) => proposeWithClientBuild({
    userPrompt: "change it", maxRounds: 0, baseFiles: files, hasExistingEntry: true,
    onFiles: async () => ({ ok: true, errors: [] })
  });

  await check("a unique anchor is replaced and the rest of the file survives", async () => {
    const before = 'export default function App(){\n  const t = "Old Title";\n  return <h1>{t}</h1>;\n}\n';
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([
      editMsg([{ path: "src/App.tsx", find: '"Old Title"', replace: '"New Title"' }]) ]) });
    const res = await runEdit(null, { "src/App.tsx": before });
    assert.ok(res.ok);
    const out = res.calls.find((c) => c.path === "src/App.tsx").content;
    assert.match(out, /New Title/);
    assert.match(out, /export default function App/, "the untouched half must still be there");
    assert.ok(!/Old Title/.test(out));
  });

  /* The refusals are asserted against parseToolCalls rather than the whole
     loop, because that is where the decision is made. Driven through
     proposeWithClientBuild they would be indistinguishable from any other
     failed round: every edit missing means nothing was written, the round
     fails, and at maxRounds:0 the loop correctly ships the fallback template —
     so res.ok comes back TRUE and tells you nothing about whether the edit was
     refused or wrongly applied. */
  const parseEdits = (calls, files) => parseToolCalls(
    { tool_calls: calls.map((c, i) => ({ id: "e_" + i, type: "function",
      function: { name: "edit_file", arguments: JSON.stringify(c) } })) },
    null, { files: files });

  await check("an ambiguous anchor is refused, not guessed at", () => {
    const r = parseEdits([{ path: "src/App.tsx", find: '"x"', replace: '"y"' }],
      { "src/App.tsx": 'const a = "x";\nconst b = "x";\n' });
    assert.ok(!r.ok, "two matches must not be applied to the first one");
    assert.match(r.reason, /appears 2 times/);
    assert.match(r.reason, /more of the surrounding lines/, "must say how to fix it");
  });

  await check("an anchor that is not there is refused with a usable message", () => {
    const r = parseEdits([{ path: "src/App.tsx", find: "text the model imagined", replace: "z" }],
      { "src/App.tsx": "real content" });
    assert.ok(!r.ok);
    assert.match(r.reason, /Copy the anchor exactly/);
    assert.ok(r.recoverable, "a missed anchor is retryable, not a dead turn");
  });

  await check("editing a file that does not exist points at write_file", () => {
    const r = parseEdits([{ path: "src/Nope.tsx", find: "a", replace: "b" }], { "src/App.tsx": "x" });
    assert.ok(!r.ok);
    assert.match(r.reason, /use write_file to create it/);
  });

  await check("the scaffold cannot be edited any more than it can be written", () => {
    const r = parseEdits([{ path: "src/lib/payments.ts", find: "a", replace: "b" }],
      { "src/lib/payments.ts": "abc" });
    assert.ok(!r.ok, "PROTECTED_PATHS must hold for edits too");
    assert.match(r.reason, /fixed scaffold/);
  });

  await check("an edit cannot escape src/ or reach a non-source file", () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", "package.json", "src/x.json"]) {
      const r = parseEdits([{ path: bad, find: "a", replace: "b" }], { [bad]: "a" });
      assert.ok(!r.ok, bad + " should have been refused");
    }
  });

  await check("two edits to one file compose instead of clobbering", async () => {
    const before = "const a = 1;\nconst b = 2;\n";
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([
      editMsg([
        { path: "src/App.tsx", find: "const a = 1;", replace: "const a = 10;" },
        { path: "src/App.tsx", find: "const b = 2;", replace: "const b = 20;" }
      ]) ]) });
    const res = await runEdit(null, { "src/App.tsx": before });
    assert.ok(res.ok);
    const out = res.calls.find((c) => c.path === "src/App.tsx").content;
    assert.match(out, /const a = 10;/);
    assert.match(out, /const b = 20;/, "the second edit must see the first one's result");
  });

  await check("an edit still gets the same rewrites a write does", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([
      editMsg([{ path: "src/App.tsx", find: "GRID", replace: 'className="grid grid-cols-1 md:grid-cols-3"' }]) ]) });
    const res = await runEdit(null, { "src/App.tsx": "<div GRID></div>" });
    assert.ok(res.ok);
    assert.match(res.calls[0].content, /grid-cols-2/, "twoUpOnMobile must apply to edited content too");
  });

  await check("a failed edit alongside a good write does not lose the write", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([{
      role: "assistant", tool_calls: [
        { id: "a", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "src/App.tsx", find: "nope", replace: "x" }) } },
        { id: "b", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/New.tsx", content: "export const N = 1;" }) } }
      ] }]) });
    const res = await runEdit(null, { "src/App.tsx": "real" });
    assert.ok(res.ok, "one bad anchor must not discard the work that did land");
    assert.ok(res.calls.some((c) => c.path === "src/New.tsx"));
  });

  /* ---- read_file ---------------------------------------------------------
     The risky part is not the lookup, it is the loop: a tool that returns a
     reply rather than a file changes the shape of a turn, and a turn that
     never stops reading never writes anything. */
  console.log("\n── read_file ───────────────────────────────────────");

  function readThenWrite(readPaths, writeAfter) {
    const first = { role: "assistant", tool_calls: readPaths.map((p, i) => ({
      id: "r_" + i, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: p }) } })) };
    const second = toolCallMsg([writeAfter || { path: "src/App.tsx", content: "export default function App(){return <p>ok</p>}" }]);
    return fetchReturning([first, second]);
  }
  const runRead = (files) => proposeWithClientBuild({
    userPrompt: "change the header", maxRounds: 0, baseFiles: files,
    onFiles: async () => ({ ok: true, errors: [] })
  });

  await check("a read is answered and the model writes on the next round", async () => {
    let bodies = [];
    const inner = readThenWrite(["src/components/Header.tsx"]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(); } });
    const res = await runRead({ "src/components/Header.tsx": "export const Header = () => <h1>Velvet</h1>;" });
    assert.ok(res.ok, "the turn should complete");
    assert.strictEqual(bodies.length, 2, "expected one round to read and one to write");
    const toolMsg = bodies[1].messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "the second call must carry the file back as a tool result");
    assert.match(toolMsg.content, /Velvet/, "the model should receive the real file contents");
  });

  await check("an unknown path comes back as an error listing what exists", async () => {
    let bodies = [];
    const inner = readThenWrite(["src/Ghost.tsx"]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(); } });
    await runRead({ "src/App.tsx": "x" });
    const toolMsg = bodies[1].messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /not in this project/);
    assert.match(toolMsg.content, /src\/App\.tsx/, "naming the real files is what makes the error recoverable");
  });

  await check("a read cannot escape src/ or walk up the tree", async () => {
    for (const bad of ["../../server/.env", "/etc/passwd", "package.json"]) {
      let bodies = [];
      const inner = readThenWrite([bad]);
      client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(); } });
      /* A DIFFERENT prompt each iteration. Round 0 is cached by prompt, so
         reusing one made every pass after the first a cache hit with zero
         model calls — the assertion then read an undefined second body and
         failed for a reason that had nothing to do with traversal. */
      await proposeWithClientBuild({
        userPrompt: "change the header " + bad, maxRounds: 0,
        baseFiles: { "src/App.tsx": "x", [bad]: "SECRET" },
        onFiles: async () => ({ ok: true, errors: [] })
      });
      const toolMsg = bodies[1].messages.find((m) => m.role === "tool");
      assert.match(toolMsg.content, /^Error:/, bad + " should have been refused");
      assert.ok(!/SECRET/.test(toolMsg.content), bad + " leaked content");
    }
  });

  await check("asking for the same file twice does not spend a second round", async () => {
    /* A model that cannot find what it wants will ask again. Without the
       served-set it burns every round re-asking and writes nothing, and the
       person gets a starter template for a question no one answered. */
    let calls = 0;
    const loop = { role: "assistant", tool_calls: [{ id: "r", type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx" }) } }] };
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ choices: [{ message: loop, finish_reason: "tool_calls" }], usage: {} }) };
    } });
    await runRead({ "src/App.tsx": "x" });
    assert.ok(calls <= 4, "a repeating reader must not loop forever; made " + calls + " calls");
  });

  await check("an ordinary build still costs exactly one model call", async () => {
    /* The tool loop now wraps every mode. If that turned a plain build into
       two round trips it would be a latency regression on the common path. */
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ choices: [{ message: toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return <p>hi</p>}" }]), finish_reason: "tool_calls" }], usage: {} }) };
    } });
    const res = await proposeWithClientBuild({ userPrompt: "a site", maxRounds: 0, onFiles: async () => ({ ok: true, errors: [] }) });
    assert.ok(res.ok);
    assert.strictEqual(calls, 1, "a build with no tool calls must not gain a round trip");
  });

  /* ---- staying inside the model's context window ------------------------
     The repair loop used to only grow. What follows pins the two properties
     that stop it: the conversation reaches a steady size however many rounds
     run, and what gets dropped is never something the protocol or the model
     needs. */
  /* ---- pages -------------------------------------------------------------
     A site is .html files at the project root, one per page, discovered by
     vite.config.ts rather than declared anywhere. These pin the boundary
     that makes that safe, and the two places the entry guard had to learn
     that an app is not the only thing this builds. */
  await check("the language rule names no language it does not mean literally", () => {
    /* English requests were coming back as Turkish sites. The rule said
       "match the person", but it named Turkish four times in the paragraph
       that governs UI copy, as its only worked example — and that paragraph
       sits tens of thousands of characters before the request, behind the
       whole codebase. The nearest language word to the model when it started
       writing copy was the example.

       So: no named example. English may still appear, because it is the
       stated fallback for an ambiguous request rather than an illustration
       of "write in their language". */
    for (const mode of ["economy", "power", "plan"]) {
      const prompt = systemPromptFor(mode);
      for (const named of ["Turkish", "Arabic", "Spanish", "French", "German", "Chinese"]) {
        assert.ok(prompt.indexOf(named) === -1,
          mode + " prompt names " + named + " — an example here is what the model reaches for " +
          "when it is not sure, and it is wrong every time the person did not write in it");
      }
      assert.match(prompt, /LANGUAGE:/, mode + " prompt lost its language rule entirely");
    }
  });

  /* ---- running out of room ----------------------------------------------
     A completion cut at the token ceiling ends mid-string in the LAST tool
     call. Everything before it is a whole file that parsed and validated.
     These pin that the prefix survives, that a build which stopped early is
     never remembered as a design, and that a retry adds to the first
     attempt's work rather than replacing it. */
  /* ---- effort -----------------------------------------------------------
     The control in front of the user is only worth having if each step
     changes something real. For most of this project's life it did not:
     AI_JSON_POWER_MODEL was unset, so "Power" ran the identical model to
     "Auto" and bought a longer prompt suffix and one extra round. */
  /* ---- pressable answers -------------------------------------------------
     These options are model output rendered straight into the UI, so the
     shape is validated here rather than trusted. */
  console.log("\n── pressable answers ───────────────────");

  function askReturning(obj) {
    return async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: "stop" }], usage: {} }) });
  }

  await check("options are clamped, and a second recommendation is dropped", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: askReturning({
      action: "ask", reply: "One household or several?",
      options: [
        { label: "  One household  ", hint: "x".repeat(200), recommended: true },
        { label: "Several groups", recommended: true },
        { label: "y".repeat(80) },
        { label: "" },
        { label: "Fourth" },
        { label: "Fifth — over the cap" }
      ]
    }) });
    const r = await assessPrompt("a splitter");
    assert.strictEqual(r.clear, false);
    assert.strictEqual(r.options.length, 4, "more than four answers is two questions");
    assert.strictEqual(r.options[0].label, "One household", "label was not trimmed");
    assert.ok(r.options[0].hint.length <= 90, "hint was not clamped");
    assert.ok(r.options[2].label.length <= 40, "a long label was not clamped");
    const recs = r.options.filter((o) => o.recommended).length;
    assert.strictEqual(recs, 1, "two recommendations is the model hedging; got " + recs);
    assert.ok(!r.options.some((o) => !o.label), "an option with no label must not reach the UI");
  });

  await check("a single option is no choice at all, so none are sent", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: askReturning({
      action: "ask", reply: "What is it called?", options: [{ label: "Only one" }] }) });
    const r = await assessPrompt("a shop");
    assert.strictEqual(r.options, undefined, "one button is a button, not a question");
  });

  await check("an open question still just asks", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: askReturning({
      action: "ask", reply: "What is the business called?" }) });
    const r = await assessPrompt("a shop");
    assert.strictEqual(r.clear, false);
    assert.strictEqual(r.reply, "What is the business called?");
    assert.strictEqual(r.options, undefined);
  });

  await check("chat replies never carry options", async () => {
    /* A greeting with buttons under it is inventing a choice nobody was
       offered. */
    client.init({ enabled: true, routes: ROUTES, fetchImpl: askReturning({
      action: "chat", reply: "Hey! What should I build?",
      options: [{ label: "A shop" }, { label: "A blog" }] }) });
    const r = await assessPrompt("hello");
    assert.strictEqual(r.action, "chat");
    assert.strictEqual(r.options, undefined);
  });

  console.log("\n── effort ────────────────────────────");

  await check("the scale is ordered, and every step changes something", () => {
    assert.deepStrictEqual(EFFORT.map((e) => e.id), ["fast", "balanced", "smart", "max"],
      "the order IS the slider — index 0 is the left end");
    for (let i = 1; i < EFFORT.length; i++) {
      const prev = EFFORT[i - 1], cur = EFFORT[i];
      assert.ok(cur.maxTokens > prev.maxTokens, cur.id + " does not raise the token budget");
      assert.ok(cur.rounds > prev.rounds, cur.id + " does not raise the repair budget");
    }
    // A step that only changes a number nobody sees is not a step.
    assert.ok(EFFORT.some((e) => e.tier === "eco") && EFFORT.some((e) => e.tier === "power"),
      "the scale never reaches the stronger model, so it is one model with four labels");
  });

  await check("an unknown level builds anyway rather than refusing", () => {
    // A stale client or a queued request must not be able to fail a build by
    // naming a level this server has never heard of.
    assert.strictEqual(effortFor("nonsense").id, "balanced");
    assert.strictEqual(effortFor(null).id, "balanced");
    assert.strictEqual(effortFor("").id, "balanced");
    assert.strictEqual(effortFor(undefined).id, "balanced");
  });

  await check("the retired \"power\" mode lands on the level it meant", () => {
    /* Power was the top half of this scale before it was a scale. A page that
       has not reloaded still sends mode:"power" and no effort, and demoting
       that to the default would quietly give someone the weaker model. */
    assert.strictEqual(effortFor(null, "power").id, "smart");
    assert.strictEqual(effortFor(undefined, "POWER").id, "smart");
    // An explicit level always wins over the legacy field.
    assert.strictEqual(effortFor("fast", "power").id, "fast");
  });

  await check("effort picks the model, and mode no longer does", async () => {
    /* The bug this replaces: mode carried both "show me a plan" and "think
       harder", so choosing Plan silently chose the weaker model too. */
    const seen = [];
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => {
      seen.push(JSON.parse(o.body));
      return { ok: true, json: async () => ({ choices: [{ message: toolCallMsg([{ path: "src/App.tsx", content: "x" }]), finish_reason: "tool_calls" }], usage: {} }) };
    } });

    for (const id of ["fast", "balanced", "smart", "max"]) {
      clearCache();
      await proposeWithClientBuild({
        userPrompt: "a site " + id, maxRounds: 0, effort: id,
        onFiles: async () => ({ ok: true, errors: [] })
      });
    }
    const budgets = seen.map((b) => b.max_tokens);
    assert.deepStrictEqual(budgets, EFFORT.map((e) => e.maxTokens),
      "each level must ask for its own budget; got " + JSON.stringify(budgets));
  });

  console.log("\n── running out of room ──────────────────");

  // An assistant message whose final write_file argument stops mid-string,
  // exactly as a provider cuts one at max_tokens.
  function cutBatch(wholeFiles, cutPath) {
    const calls = wholeFiles.map((f, i) => ({
      id: "w" + i, type: "function",
      function: { name: "write_file", arguments: JSON.stringify(f) }
    }));
    calls.push({
      id: "cut", type: "function",
      function: { name: "write_file", arguments: '{"path":"' + cutPath + '","content":"export default function App(){ return <di' }
    });
    return { role: "assistant", tool_calls: calls };
  }

  await check("a cut-off last file does not destroy the files before it", () => {
    const msg = cutBatch([
      { path: "src/types.ts", content: "export type A = 1;" },
      { path: "src/data.ts", content: "export const d = [];" }
    ], "src/App.tsx");

    // Without the truncation flag this is still all-or-nothing, which is the
    // right default: a malformed call in a COMPLETE response is a real fault.
    const blind = parseToolCalls(msg, null, {});
    assert.strictEqual(blind.ok, false, "a malformed call in a complete response must still fail the batch");

    const known = parseToolCalls(msg, null, { truncated: true });
    assert.strictEqual(known.ok, true, "the complete prefix was thrown away");
    assert.deepStrictEqual(known.calls.map((c) => c.path), ["src/types.ts", "src/data.ts"]);
    assert.strictEqual(known.droppedTail, "src/App.tsx",
      "the caller needs the cut file's name to say what is still missing");
  });

  await check("a truncated response with nothing salvageable still fails", () => {
    // Only the cut call. There is no prefix to keep, so this must not be
    // dressed up as a success with zero files.
    const msg = cutBatch([], "src/App.tsx");
    const r = parseToolCalls(msg, null, { truncated: true });
    assert.strictEqual(r.ok, false, "zero salvaged files is not a usable turn");
  });

  await check("a build that ran out of room is not cached as the design", async () => {
    /* The old code cached round 0 unconditionally, which is precisely the
       round that is incomplete whenever a build needs a second one. */
    const cut = cutBatch([{ path: "src/App.tsx", content: "export default function App(){return null}" }], "src/Extra.tsx");
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ choices: [{ message: cut, finish_reason: "length" }], usage: {} }) };
    } });

    const opts = { userPrompt: "a site that ran out of room", maxRounds: 0, hasExistingEntry: true,
      onFiles: async () => ({ ok: true, errors: [] }) };
    const first = await proposeWithClientBuild(opts);
    assert.strictEqual(first.ok, true, "the salvaged file should still build");
    const after = calls;
    await proposeWithClientBuild(opts);
    assert.ok(calls > after, "a truncated build was served from cache — it would replay a half-written app");
  });

  await check("a complete build IS cached, and caches the whole accumulated tree", async () => {
    /* Two rounds: the first fails to build, the second fixes it. What gets
       remembered must be both rounds' files, not round 0's broken draft. */
    const first = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return <p>v1</p>}" }]);
    const second = toolCallMsg([{ path: "src/components/Fixed.tsx", content: "export const Fixed = () => null;" }]);
    let calls = 0, builds = 0;
    const respond = fetchReturning([first, second]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return respond(); } });

    const opts = {
      userPrompt: "a two round build", maxRounds: 2, hasExistingEntry: true,
      onFiles: async () => { builds++; return builds === 1 ? { ok: false, errors: [{ message: "boom" }] } : { ok: true, errors: [] }; }
    };
    const res = await proposeWithClientBuild(opts);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.calls.length, 2, "the result should carry both rounds' files");

    const modelCallsBefore = calls;
    const again = await proposeWithClientBuild(Object.assign({}, opts, {
      onFiles: async () => ({ ok: true, errors: [] })
    }));
    assert.strictEqual(calls, modelCallsBefore, "the completed build was not cached");
    assert.strictEqual(again.calls.length, 2,
      "the cache kept round 0 only — the repair round's file was lost");
  });

  console.log("\n── pages, not just one app ──────────────");

  await check("a page at the root is writable; a nested one is not", () => {
    for (const good of ["index.html", "about.html", "contact-us.html", "menu.html"]) {
      assert.strictEqual(validateWriteFileArgs({ path: good, content: "<!doctype html>" }).path, good);
    }
    /* Nested is refused because vite.config.ts reads the project root, not a
       recursive glob — shop/item.html would be written and then silently
       never built, which is worse than being told no. */
    for (const bad of ["shop/item.html", "src/page.html", "../escape.html", "/abs.html"]) {
      assert.throws(() => validateWriteFileArgs({ path: bad, content: "x" }),
        /not a safe relative path|only files under src\/|must be a \.ts/, bad + " was accepted");
    }
  });

  await check("opening the root to .html did not open it to everything else", () => {
    // The scaffold is still the scaffold. Widening the path rule for pages
    // must not have made package.json or a config file writable.
    for (const bad of ["package.json", "vite.config.ts", "tsconfig.json", "tailwind.config.js", "notes.txt", "evil.js"]) {
      assert.throws(() => validateWriteFileArgs({ path: bad, content: "x" }), /write_file:/, bad + " became writable");
    }
    assert.throws(() => validateWriteFileArgs({ path: "src/main.tsx", content: "x" }), /fixed scaffold/);
  });

  await check("a site build is not asked for an App.tsx it has no use for", async () => {
    /* The entry guard judged src/App.tsx alone. A static site never has one,
       so every multi-page site would have burned a round being told to write
       a file that belongs to the other kind of project entirely. */
    const site = toolCallMsg([
      { path: "index.html", content: "<!doctype html><html><head><title>Home</title></head><body><a href=\"about.html\">About</a></body></html>" },
      { path: "about.html", content: "<!doctype html><html><head><title>About</title></head><body>Hi</body></html>" }
    ]);
    let modelCalls = 0;
    const respond = fetchReturning([site]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { modelCalls++; return respond(); } });

    const res = await proposeWithClientBuild({
      userPrompt: "a website for my barber shop with an about page",
      hasExistingEntry: false,
      onFiles: async () => ({ ok: true, errors: [] })
    });
    assert.strictEqual(res.ok, true, "a site with a home page was rejected for having no App.tsx");
    assert.strictEqual(modelCalls, 1, "the guard forced a repair round on a complete site");
    assert.ok(res.calls.some((c) => c.path === "about.html"), "the second page was dropped");
  });

  await check("a build with neither entry is still caught", async () => {
    // The guard still has to fire. Widening it to accept index.html must not
    // have turned it off for a run that wrote no entry point of either kind.
    const partial = toolCallMsg([{ path: "src/lib/util.ts", content: "export const x = 1;" }]);
    const withApp = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return null}" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([partial, withApp]) });
    const rounds = [];
    await proposeWithClientBuild({
      userPrompt: "a dashboard", hasExistingEntry: false,
      onFiles: async () => ({ ok: true, errors: [] }),
      onRound: (r) => rounds.push(r)
    });
    assert.strictEqual(rounds[0].ok, false, "a build with no entry of either kind was accepted");
    assert.strictEqual(rounds[0].errors[0].code, "NO_ENTRY");
  });

  console.log("\n── the context window ──────────────────────");

  /* A SMALL SYNTHETIC WINDOW, deliberately not the provider's.
     fitConversation takes the window as an argument, so its correctness is
     arithmetic and owes nothing to what DeepSeek happens to allow this month.
     Pinning these cases to the real window made them vacuous the moment it was
     corrected from 65,536 to its measured 400,000 — the head plus six repair
     rounds no longer overflowed, so the trimmer was never exercised and every
     assertion passed without testing anything. */
  const WINDOW = 65536;
  const fitOpts = (over) => Object.assign({ windowTokens: WINDOW, maxTokens: 16000, tools: TOOLS_SCHEMA, headLen: 2 }, over || {});

  /* An assistant message carrying tool_calls MUST be followed by one `tool`
     message per call. A trimmer that drops messages individually breaks that
     and the provider answers 400 — the same failure the trimmer exists to
     prevent, arrived at from the other side. */
  function assertProtocolValid(msgs, label) {
    for (let i = 0; i < msgs.length; i++) {
      const calls = msgs[i].tool_calls || [];
      if (!calls.length) continue;
      const replies = new Set();
      for (let j = i + 1; j < msgs.length && msgs[j].role === "tool"; j++) replies.add(msgs[j].tool_call_id);
      for (const c of calls) {
        assert.ok(replies.has(c.id), label + ": tool_call " + c.id + " lost its reply");
      }
    }
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== "tool") continue;
      const prev = msgs[i - 1];
      assert.ok(prev && (prev.role === "assistant" || prev.role === "tool"),
        label + ": a tool message at " + i + " does not follow an assistant message");
    }
  }

  function repairRound(n) {
    return [
      { role: "assistant", tool_calls: [{ id: "c" + n, type: "function", function: { name: "write_file", arguments: "y".repeat(48000) } }] },
      { role: "tool", tool_call_id: "c" + n, content: "ok" },
      { role: "user", content: "The build failed with these errors: round " + n }
    ];
  }

  await check("the conversation stops growing instead of walking out of the window", async () => {
    const head = [{ role: "system", content: "S".repeat(13000) }, { role: "user", content: "C".repeat(73000) }];
    let msgs = head.slice();
    let worst = 0;
    for (let round = 0; round < 6; round++) {
      const fit = fitConversation(msgs, fitOpts());
      const used = clientMod.estimateTokens(fit.messages, TOOLS_SCHEMA) + 16000;
      worst = Math.max(worst, used);
      assertProtocolValid(fit.messages, "round " + round);
      msgs = fit.messages.concat(repairRound(round));
    }
    assert.ok(worst <= WINDOW, "sent " + worst + " tokens into a " + WINDOW + " window");
  });

  await check("the system prompt and the request survive every trim", async () => {
    const head = [{ role: "system", content: "SYSTEM-PROMPT" }, { role: "user", content: "C".repeat(73000) }];
    let msgs = head.slice();
    for (let round = 0; round < 5; round++) msgs = msgs.concat(repairRound(round));
    const fit = fitConversation(msgs, fitOpts());
    assert.ok(fit.dropped > 0, "nothing was dropped — this case is meant to overflow");
    assert.strictEqual(fit.messages[0].content, "SYSTEM-PROMPT", "the rules were dropped");
    assert.ok(fit.messages.some((m) => m.role === "user" && /^C+$/.test(m.content)),
      "the request carrying the codebase was dropped");
  });

  await check("the newest attempt is kept — it is the one the errors refer to", async () => {
    const head = [{ role: "system", content: "S" }, { role: "user", content: "C".repeat(73000) }];
    let msgs = head.slice();
    for (let round = 0; round < 5; round++) msgs = msgs.concat(repairRound(round));
    const fit = fitConversation(msgs, fitOpts());
    const last = fit.messages[fit.messages.length - 1];
    assert.match(last.content, /round 4/, "the current build errors were trimmed away");
    assert.ok(fit.messages.some((m) => (m.tool_calls || []).some((c) => c.id === "c4")),
      "the attempt those errors describe was dropped, so there is nothing to fix");
  });

  await check("a conversation that already fits is returned untouched", async () => {
    const msgs = [{ role: "system", content: "S" }, { role: "user", content: "small" }].concat(repairRound(0));
    const fit = fitConversation(msgs, fitOpts());
    assert.strictEqual(fit.dropped, 0);
    assert.strictEqual(fit.messages.length, msgs.length, "a fitting conversation must not be rewritten");
  });

  await check("history is shed only after every earlier attempt is gone", async () => {
    /* Order matters: a superseded repair round is worth less than the
       conversation, so history is the second thing to go, not the first. */
    const msgs = [
      { role: "system", content: "S" },
      { role: "user", content: "H".repeat(3000) },      // history turn
      { role: "assistant", content: "h".repeat(3000) }, // history turn
      { role: "user", content: "C".repeat(73000) }      // the request
    ].concat(repairRound(0), repairRound(1));
    const fit = fitConversation(msgs, Object.assign(fitOpts(), { headLen: 4 }));
    assert.ok(fit.messages.some((m) => /^C+$/.test(m.content || "")), "the request was shed before history");
    assertProtocolValid(fit.messages, "history shed");
  });

  await check("the code budget leaves room for a reply and the attempt it fixes", async () => {
    /* Configured here rather than inherited from whichever test ran last:
       the budget is computed from the configured model's window, so a stale
       route would have this assert against the wrong number and pass for a
       reason that has nothing to do with the budget. */
    client.init({ enabled: true, routes: ROUTES });
    /* The REAL window, read from the client rather than assumed, because this
       case is about the live budget and not about the trimmer's arithmetic.
       Reply budgets are stated rather than imported: they are not exported,
       and writing them down is what makes a change to them show up here. */
    const realWindow = clientMod.windowFor("json", null);
    assert.ok(realWindow >= 100000,
      "the configured window is " + realWindow + " — if the provider table changed, these numbers need rechecking");
    for (const mode of ["economy", "power"]) {
      const budget = codeBudgetChars({ mode });
      const reply = mode === "power" ? 64000 : 32000;
      const need = clientMod.estimateTokens([
        { role: "system", content: systemPromptFor(mode) },
        { role: "user", content: "x".repeat(budget) }
      ], TOOLS_SCHEMA) + reply * 2;
      assert.ok(need <= realWindow, mode + ": a full-budget request plus one repair round needs " + need +
        " tokens, over the " + realWindow + " window");
      /* The budget must also fit the message that carries it. proposeWithClientBuild
         slices at MAX_USER_PROMPT_CHARS and says nothing, so a budget above that
         cap cuts a file in half with no marker — the one thing
         buildCodebaseContext is built to never do. */
      const promptCap = Number(process.env.CODEAGENT_MAX_PROMPT_CHARS || 400000);
      assert.ok(budget < promptCap, mode + ": code budget " + budget +
        " exceeds the " + promptCap + "-char prompt cap, so it would be silently truncated");
    }
  });

  console.log("\n── caller options reach the write validator ────────");

  await check("proposeWithClientBuild carries imageUrls down to the file writer", async () => {
    const real = "https://cdn.souqi.site/u/" + "ab".repeat(16) + ".jpg";
    client.init({
      enabled: true, routes: ROUTES,
      fetchImpl: fetchReturning([toolCallMsg([{
        path: "src/App.tsx",
        content: 'export default function App(){return <img src="https://images.unsplash.com/fake.jpg" className="w-full" />}'
      }])])
    });
    const res = await proposeWithClientBuild({
      userPrompt: "a cafe site",
      maxRounds: 0,
      imageUrls: [real],
      onFiles: async () => ({ ok: true, errors: [] })
    });
    assert.ok(res.ok, "expected the build to succeed");
    const app = res.calls.find((c) => c.path === "src/App.tsx");
    assert.ok(!/unsplash/.test(app.content),
      "an invented image URL survived — imageUrls is not reaching validateWriteFileArgs");
    assert.match(app.content, /bg-gradient-to-br/,
      "the invented URL should have become a gradient placeholder");
  });

  await check("no imageUrls is still a clean pass-through", async () => {
    client.init({
      enabled: true, routes: ROUTES,
      fetchImpl: fetchReturning([toolCallMsg([{
        path: "src/App.tsx", content: '<img src="https://example.com/x.jpg" />'
      }])])
    });
    const res = await proposeWithClientBuild({
      userPrompt: "a site", maxRounds: 0,
      onFiles: async () => ({ ok: true, errors: [] })
    });
    // Nothing was attached, so there is no way to tell a real URL from an
    // invented one and the guard must not guess.
    assert.match(res.calls[0].content, /example\.com/);
  });

  /* ---- discipline -----------------------------------------------------
     Two things the loop never used to know: that a round had achieved
     nothing, and that the tree it was about to overwrite belonged to
     somebody. Both were paid for in real projects. */
  console.log("\n── the loop notices it is going in circles ─────────");

  const brokenApp = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){ return <Foo/>; }" }]);
  const sameErr = [{ file: "src/App.tsx", line: 3, col: 1, code: "TS2304", message: "Cannot find name 'Foo'" }];

  await check("the same write and the same errors twice stops the run early", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([brokenApp]) });
    let builds = 0;
    const res = await proposeWithClientBuild({
      userPrompt: "fix it", maxRounds: 3, baseFiles: { "src/App.tsx": "old" }, hasExistingEntry: true,
      onFiles: async () => { builds++; return { ok: false, errors: sameErr }; }
    });
    assert.strictEqual(res.ok, false);
    assert.ok(res.stalled, "the loop never noticed it was repeating itself");
    // maxRounds 3 is four rounds. Detecting at the second repeat spends three.
    assert.ok(builds < 4, "spent every round on a loop that had stopped converging: " + builds);
  });

  await check("the model is told it is repeating, not just handed the errors again", async () => {
    const bodies = [];
    const inner = fetchReturning([brokenApp]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(); } });
    await proposeWithClientBuild({
      userPrompt: "fix it", maxRounds: 3, baseFiles: { "src/App.tsx": "old" }, hasExistingEntry: true,
      onFiles: async () => ({ ok: false, errors: sameErr })
    });
    const said = bodies.some((b) => (b.messages || []).some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.indexOf("STOP.") !== -1));
    assert.ok(said, "the repeat was detected but never mentioned to the model");
  });

  await check("a build that keeps failing never templates over an existing app", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([brokenApp]) });
    let n = 0;
    const res = await proposeWithClientBuild({
      userPrompt: "add a footer", maxRounds: 1, hasExistingEntry: true,
      baseFiles: { "src/App.tsx": "the person's real app", "src/components/Header.tsx": "export const Header = () => null;" },
      // A different error each round, so this tests the cap and not the stall.
      onFiles: async () => ({ ok: false, errors: [{ file: "src/App.tsx", line: ++n, col: 1, message: "error " + n }] })
    });
    assert.strictEqual(res.ok, false);
    assert.ok(res.keptExisting, "the turn did not report that the project was left alone");
    assert.ok(!res.fellBack, "a starter template was shipped over a working project");
  });

  await check("a first build with nothing to lose still gets the starter template", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([brokenApp]) });
    let k = 0;
    const res = await proposeWithClientBuild({
      userPrompt: "a landing page", maxRounds: 0, baseFiles: {}, hasExistingEntry: true,
      // Round 0 fails; the fallback App.tsx that follows compiles.
      onFiles: async () => (++k >= 2 ? { ok: true, errors: [] } : { ok: false, errors: sameErr })
    });
    assert.ok(res.ok, "a first build that fails should still render something");
    assert.ok(res.fellBack, "the template is the right answer when the alternative is a blank screen");
  });

  console.log("\n── search_code ───────────────────────────────────");

  const shop = {
    "src/App.tsx": 'import { useCart } from "./hooks/useCart";\nexport default function App(){ return <p>Book a table</p>; }',
    "src/hooks/useCart.ts": "export function useCart(){ return { total: 0 }; }\n// the TOTAL is minor units",
    "index.html": '<!doctype html><html><body><a href="menu.html">Menu</a></body></html>',
    "menu.html": "<!doctype html><html><body>menu</body></html>"
  };
  function searchThenWrite(calls) {
    const first = { role: "assistant", tool_calls: calls.map((a, i) => ({
      id: "s_" + i, type: "function", function: { name: "search_code", arguments: JSON.stringify(a) } })) };
    const second = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){ return <p>ok</p>; }" }]);
    return fetchReturning([first, second]);
  }
  async function searchOnce(args, files) {
    const bodies = [];
    const inner = searchThenWrite([args]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(); } });
    await proposeWithClientBuild({
      userPrompt: "change it", maxRounds: 0, baseFiles: files || shop, hasExistingEntry: true,
      onFiles: async () => ({ ok: true, errors: [] })
    });
    const tool = (bodies[1] || { messages: [] }).messages.find((m) => m.role === "tool");
    return tool ? tool.content : null;
  }

  await check("a match comes back as file, line and the line itself", async () => {
    const out = await searchOnce({ query: "useCart" });
    assert.match(out, /src\/App\.tsx:1:/);
    assert.match(out, /src\/hooks\/useCart\.ts:1:/);
  });

  await check("matching is case-insensitive by default", async () => {
    const out = await searchOnce({ query: "total" });
    assert.match(out, /useCart\.ts:1/, "lowercase 'total' should match 'total: 0'");
    assert.match(out, /useCart\.ts:2/, "and the uppercase TOTAL in the comment");
  });

  await check("a page at the project root is searchable", async () => {
    const out = await searchOnce({ query: "menu.html" });
    assert.match(out, /^index\.html:1:/m);
  });

  await check("regex is opt-in and a bad one is an answer, not a crash", async () => {
    const good = await searchOnce({ query: "Book a (table|room)", regex: true });
    assert.match(good, /src\/App\.tsx:2:/);
    // Both halves run the same userPrompt, and the response cache would
    // otherwise serve the first result to the second without a model call.
    clearCache();
    const bad = await searchOnce({ query: "Book a (table", regex: true });
    assert.match(bad, /Error: .*not a valid regular expression/);
  });

  /* Bare "no matches" reads as a broken tool, and the model searches again
     with a synonym instead of concluding the thing is absent. */
  await check("no matches says the search worked", async () => {
    const out = await searchOnce({ query: "stripeWebhookHandler" });
    assert.match(out, /No matches/);
    assert.match(out, /does not yet/);
  });

  await check("search cannot name a file a read could not open", async () => {
    const out = await searchOnce({ query: "SECRET" }, {
      "src/App.tsx": "export default function App(){ return null; }",
      ".env": "JWT_SECRET=hunter2"
    });
    assert.ok(!/\.env/.test(out), "search reached a path outside what a read is allowed: " + out);
  });

  /* The manifest tells the model to call read_file on a page it was not
     shown, and read_file refused every .html at the project root — so a
     site's own pages were unreadable by the thing that wrote them. */
  await check("read_file can open a page at the project root", async () => {
    const bodies = [];
    const first = { role: "assistant", tool_calls: [{ id: "r0", type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "menu.html" }) } }] };
    const inner = fetchReturning([first, toolCallMsg([{ path: "index.html", content: "<!doctype html><html></html>" }])]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(); } });
    await proposeWithClientBuild({
      userPrompt: "add a page", maxRounds: 0, baseFiles: shop, hasExistingEntry: true,
      onFiles: async () => ({ ok: true, errors: [] })
    });
    const tool = bodies[1].messages.find((m) => m.role === "tool");
    assert.match(tool.content, /menu/, "the page came back as an error: " + tool.content);
    assert.ok(!/only files under src/.test(tool.content), "root .html is still refused");
  });

  console.log("\n── the reviewer, and its bias toward silence ──────");

  /* One stub, two answers: the reviewer's system prompt is unmistakable, so
     the same transport can serve the builder and the review of what it built. */
  function fetchBuildThenReview(reviewContent) {
    const build = fetchReturning([toolCallMsg([
      { path: "src/App.tsx", content: "export default function App(){ return <p>hi</p>; }" }
    ])]);
    return async (u, o) => {
      const body = JSON.parse(o.body);
      const isReview = (body.messages || []).some(
        (m) => m.role === "system" && String(m.content).indexOf("ALREADY COMPILED") !== -1);
      if (!isReview) return build();
      return { ok: true, json: async () => ({
        choices: [{ message: { role: "assistant", content: reviewContent }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
    };
  }
  const runReviewed = (mode) => proposeWithClientBuild({
    userPrompt: "a booking page with a form", maxRounds: 2, baseFiles: {},
    hasExistingEntry: true, mode: mode,
    onFiles: async () => ({ ok: true, errors: [] })
  });

  await check("eco never spends a call reviewing", async () => {
    let reviews = 0;
    const inner = fetchBuildThenReview('{"ok":true}');
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => {
      if (String(o.body).indexOf("ALREADY COMPILED") !== -1) reviews++;
      return inner(u, o);
    } });
    const res = await runReviewed("economy");
    assert.ok(res.ok);
    assert.strictEqual(reviews, 0, "Eco paid for a review it was never meant to run");
  });

  await check("power reviews once and a clean verdict ends the turn", async () => {
    let reviews = 0;
    const inner = fetchBuildThenReview('{"ok":true}');
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => {
      if (String(o.body).indexOf("ALREADY COMPILED") !== -1) reviews++;
      return inner(u, o);
    } });
    const res = await runReviewed("power");
    assert.ok(res.ok, "a clean review must not fail the build");
    assert.strictEqual(reviews, 1, "expected exactly one review, got " + reviews);
  });

  await check("a finding sends it back, and says the build passed", async () => {
    const bodies = [];
    const inner = fetchBuildThenReview('{"ok":false,"missing":["No booking form in src/App.tsx"]}');
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(u, o); } });
    await runReviewed("power");
    const told = bodies.some((b) => (b.messages || []).some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.indexOf("The app compiled, but it is missing") !== -1));
    assert.ok(told, "the repair round was told the build FAILED, which it did not");
  });

  /* The whole design bias: this runs on an app that already works, so every
     way of not knowing has to mean "leave it alone". */
  await check("an unparseable verdict leaves the working build alone", async () => {
    const inner = fetchBuildThenReview("I think it looks great honestly");
    client.init({ enabled: true, routes: ROUTES, fetchImpl: inner });
    const res = await runReviewed("power");
    assert.ok(res.ok, "a reviewer that answered gibberish failed a build that compiled");
  });

  await check("an empty missing list is not a finding", async () => {
    const r = await (async () => {
      client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchBuildThenReview('{"ok":false,"missing":[]}') });
      return reviewBuild("a page", [{ path: "src/App.tsx", content: "x" }], {});
    })();
    assert.ok(r.ok, "ok:false with nothing named is not something a model can act on");
  });

  console.log("\n── the model can see the whole structure ──────────");

  /* There is no list_files tool, so a file that did not fit the budget was
     a file the model did not know existed — and "inspect before you change
     it" is not advice you can take about a file you cannot name. */
  await check("every file is named even when they all fit", () => {
    const r = buildCodebaseContext({
      "src/App.tsx": "export default function App(){ return null; }",
      "src/lib/money.ts": "export const f = 1;"
    }, { prompt: "tweak it", budget: 100000 });
    assert.match(r.text, /src\/App\.tsx/);
    assert.match(r.text, /src\/lib\/money\.ts/);
    assert.match(r.text, /list is complete/);
    assert.deepStrictEqual(r.omitted, [], "nothing should have been cut at this budget");
  });

  await check("a file too big to show is named with what to do about it", () => {
    const r = buildCodebaseContext({
      "src/App.tsx": "export default function App(){ return null; }",
      "src/components/Hero.tsx": "x".repeat(4000)
    }, { prompt: "change the app", budget: 600 });
    assert.ok(r.omitted.indexOf("src/components/Hero.tsx") !== -1, "expected the big file to be cut");
    assert.match(r.text, /src\/components\/Hero\.tsx\s+NOT shown — call read_file/);
  });

  await check("the manifest cannot push the context over its budget", () => {
    const files = {};
    for (let i = 0; i < 60; i++) files["src/components/C" + i + ".tsx"] = "export const C" + i + " = () => null;";
    const budget = 3000;
    const r = buildCodebaseContext(files, { prompt: "x", budget: budget });
    assert.ok(r.text.length <= budget, "context is " + r.text.length + " chars against a " + budget + " budget");
  });

  console.log("\n── the model is shown what it did, not just what it wrote ──");

  /* The repair round gets the full text of every file, which says what the
     files NOW SAY and not what was done to them. "Rewriting a 200-line
     component to change one line is how a working feature disappears" was a
     rule with no evidence attached, on a turn where the evidence is a
     subtraction away. */
  const bigFile = "export default function App(){\n" +
    Array.from({ length: 80 }, (_, i) => "  const v" + i + " = " + i + ";").join("\n") +
    "\n  return <p>hi</p>;\n}";

  async function repairBodies(written, base) {
    const bodies = [];
    const inner = fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: written }])]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return inner(); } });
    await proposeWithClientBuild({
      userPrompt: "fix the heading", maxRounds: 1, baseFiles: base, hasExistingEntry: true,
      onFiles: async () => ({ ok: false, errors: [{ file: "src/App.tsx", line: 2, col: 1, message: "TS1005" }] })
    });
    const msgs = bodies[bodies.length - 1].messages || [];
    const last = msgs.filter((m) => m.role === "user").pop();
    return last ? last.content : "";
  }

  await check("a repair round is told what it has changed, with the numbers", async () => {
    const out = await repairBodies("export default function App(){ return <p>hi</p>; }", { "src/App.tsx": bigFile });
    assert.match(out, /What you have changed so far this turn/);
    assert.match(out, /src\/App\.tsx\s+\+\d+ -\d+/);
  });

  await check("replacing most of a big working file is called out", async () => {
    const out = await repairBodies("export default function App(){ return <p>hi</p>; }", { "src/App.tsx": bigFile });
    assert.match(out, /You REPLACED most of src\/App\.tsx/);
    assert.match(out, /use edit_file/);
  });

  /* Ten lines of a twelve-line helper is a rewrite in ratio and nothing in
     substance — flagging it would train the model to ignore the warning. */
  await check("a small file rewritten whole is not flagged as a rewrite", async () => {
    clearCache();
    const out = await repairBodies("export const f = 2;", { "src/App.tsx": "export const f = 1;" });
    assert.match(out, /What you have changed so far this turn/);
    assert.ok(!/You REPLACED most of/.test(out), "cried wolf over a one-line file: " + out);
  });

  await check("a brand new file is marked new rather than as a deletion", async () => {
    clearCache();
    const out = await repairBodies("export default function App(){ return null; }", {});
    assert.match(out, /src\/App\.tsx\s+\+\d+ -0\s+\(new file\)/);
    assert.ok(!/You REPLACED most of/.test(out));
  });

  console.log("\n── the turn reports what it had to repair ─────────");

  /* The loop knew every failure it fixed and told nobody: on success the
     return said repaired:true and dropped WHAT was repaired, so a project
     making the same structural mistake every turn was indistinguishable
     from one that got it right first time. memory.js needs the difference. */
  await check("a repaired structural failure comes back on the result", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([
      toolCallMsg([{ path: "src/App.tsx", content: 'import { t } from "./lib/gone";\nexport default function App(){ return <p>{t}</p>; }' }]),
      toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){ return <p>ok</p>; }" }])
    ]) });
    const res = await proposeWithClientBuild({
      userPrompt: "a tracker", maxRounds: 2, baseFiles: {}, hasExistingEntry: true,
      onFiles: async () => ({ ok: true, errors: [] })
    });
    assert.ok(res.ok, "the second round should have compiled");
    assert.ok(Array.isArray(res.failures), "no failures array came back");
    assert.ok(res.failures.some((f) => f.code === "UNRESOLVED_IMPORT"),
      "the unresolved import was repaired and then forgotten: " + JSON.stringify(res.failures));
  });

  await check("a turn that went right first time reports nothing", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([
      toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){ return <p>ok</p>; }" }])
    ]) });
    const res = await proposeWithClientBuild({
      userPrompt: "a clean one", maxRounds: 2, baseFiles: {}, hasExistingEntry: true,
      onFiles: async () => ({ ok: true, errors: [] })
    });
    assert.ok(res.ok);
    assert.deepStrictEqual(res.failures, [], "invented a failure on a clean build");
  });

  console.log("\n── preflight reaches the loop ─────────────────────");

  await check("an import of a file nobody wrote never reaches the compiler", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([
      toolCallMsg([{ path: "src/App.tsx", content: 'import { total } from "./lib/helpers";\nexport default function App(){ return <p>{total()}</p>; }' }])
    ]) });
    let builds = 0;
    const res = await proposeWithClientBuild({
      userPrompt: "a tracker", maxRounds: 0, baseFiles: {}, hasExistingEntry: true,
      onFiles: async () => { builds++; return { ok: true, errors: [] }; }
    });
    // Round 0 is caught before onFiles; only the fallback build spends one.
    assert.strictEqual(builds, 1, "paid for a compile guaranteed to fail");
    assert.ok(res.fellBack, "expected the unresolved import to fail the round");
  });

  await check("a dead nav link waits for the compile and does not cost the site", async () => {
    const page = '<!doctype html><html><body><nav><a href="menu.html">Menu</a></nav></body></html>';
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([
      toolCallMsg([{ path: "index.html", content: page }])
    ]) });
    let builds = 0;
    const res = await proposeWithClientBuild({
      userPrompt: "a cafe site", maxRounds: 0, baseFiles: {}, hasExistingEntry: true,
      onFiles: async () => { builds++; return { ok: true, errors: [] }; }
    });
    assert.ok(builds >= 1, "a soft finding must not pre-empt the compile");
    // maxRounds 0 is the last round, where shipping a 404 beats shipping
    // a starter template in place of the whole site.
    assert.ok(res.ok, "a missing page cost the site at the cap");
    assert.ok(!res.fellBack, "a dead link replaced the site with a template");
  });

  console.log("\n── repairProposal (WebContainer decoupled repair) ──");

  await check("repairProposal returns immediately if no errors", async () => {
    const res = await repairProposal({ files: { "src/App.tsx": "export default function App(){return <div/>;}" }, errors: [] });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.calls.length, 0);
  });

  await check("repairProposal sends structured compiler errors and updates files", async () => {
    const fixedApp = toolCallMsg([{ path: "src/App.tsx", content: "export default function App(){return <div>fixed</div>;}" }]);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: fetchReturning([fixedApp]) });
    const res = await repairProposal({
      files: { "src/App.tsx": "export default function App(){return <div>broken</div>;}" },
      errors: [{ file: "src/App.tsx", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'broken'" }],
      userPrompt: "landing page",
      mode: "auto"
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.calls.length, 1);
    assert.strictEqual(res.calls[0].path, "src/App.tsx");
    assert.ok(res.updatedFiles["src/App.tsx"].includes("fixed"));
  });

  console.log("\n" + (failed === 0 ? "✓ ALL MODEL-LOOP TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
