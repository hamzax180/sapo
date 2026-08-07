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
const client = require("./lib/ai/client");
const { proposeChanges, proposeWithRepair, assessPrompt, parseToolCalls, validateWriteFileArgs, TOOLS_SCHEMA, clearCache } = require("./lib/codeagent/model-loop");

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

const ROUTES = { prose: { baseUrl: "https://x.invalid", model: "m", key: "k" }, json: { baseUrl: "https://x.invalid/json", model: "deepseek-chat", key: "k" } };

(async () => {
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
    assert.strictEqual(res.ok, false);
    assert.ok(/twice in a row/.test(res.reason));
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
    assert.strictEqual(res.ok, false);
    assert.ok(/too large to finish writing/.test(res.reason), "expected a truncation-specific message, got: " + res.reason);
  });

  await check("a path-safety violation is treated the same as malformed JSON — one retry, then fail clean", async () => {
    const unsafe = toolCallMsg([{ path: "../outside.txt", content: "x" }]);
    let calls = 0;
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([unsafe])()); } });
    const res = await proposeChanges("build a landing page");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(calls, 2);
  });

  console.log("\n── proposeChanges surfaces ai/client's own guarantees ──");

  await check("AI disabled -> proposeChanges fails clean, no crash, no fetch reached", async () => {
    let reached = false;
    client.init({ enabled: false, routes: ROUTES, fetchImpl: async () => { reached = true; } });
    const res = await proposeChanges("build a landing page");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.disabled, true);
    assert.strictEqual(reached, false);
  });

  console.log("\n── the tool schema itself ───────────────────────────");

  await check("exactly one tool is offered: write_file — not run, not npm install", () => {
    assert.strictEqual(TOOLS_SCHEMA.length, 1);
    assert.strictEqual(TOOLS_SCHEMA[0].function.name, "write_file");
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
    assert.strictEqual(first.ok, false);
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => { calls++; return (await fetchReturning([toolCallMsg([{ path: "src/App.tsx", content: "x" }])])()); } });
    const second = await proposeChanges("a barber shop landing page");
    assert.strictEqual(second.ok, true, "a prior failure should not poison later attempts at the same prompt");
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
    const res = await assessPrompt("hello");
    assert.strictEqual(res.clear, false);
    assert.strictEqual(res.reply, "Hey! 👋 What would you like me to build?");
  });

  await check("uses the json (DeepSeek) route, not prose — this is a classification call, not copywriting", async () => {
    let hitUrl = "";
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async (url) => { hitUrl = url; return (await jsonReplyFetch({ clear: true })()); } });
    await assessPrompt("hello");
    assert.ok(hitUrl.indexOf("/json") >= 0, "expected the json-route baseUrl, got: " + hitUrl);
  });

  await check("clear:false with NO reply text -> fails open, not a broken prompt", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch({ clear: false }) });
    const res = await assessPrompt("hello");
    assert.strictEqual(res.clear, true, "a malformed refusal should fail OPEN (let the build proceed), not silently block one");
  });

  await check("clear:false with an empty/whitespace reply -> also fails open", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch({ clear: false, reply: "   " }) });
    const res = await assessPrompt("hello");
    assert.strictEqual(res.clear, true);
  });

  await check("malformed JSON from the assessment call itself -> fails open", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: jsonReplyFetch("not json at all") });
    const res = await assessPrompt("hello");
    assert.strictEqual(res.clear, true);
  });

  await check("the assessment call failing outright (network, breaker, budget) -> fails open, never blocks a build", async () => {
    client.init({ enabled: true, routes: ROUTES, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    const res = await assessPrompt("hello");
    assert.strictEqual(res.clear, true);
  });

  await check("AI disabled -> fails open too, no crash, no fetch reached", async () => {
    let reached = false;
    client.init({ enabled: false, routes: ROUTES, fetchImpl: async () => { reached = true; } });
    const res = await assessPrompt("hello");
    assert.strictEqual(res.clear, true);
    assert.strictEqual(reached, false);
  });

  console.log("\n" + (failed === 0 ? "✓ ALL MODEL-LOOP TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
