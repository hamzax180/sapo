/* =================================================================
   ai-client-test.js — lib/ai/client.js's contract, with NO real network
   -----------------------------------------------------------------
   Every guarantee in docs/AI-PROVIDER-PLAN.md is testable without a
   live key: off by default, per-route missing-config disables that
   route only, the per-route circuit breaker trips at 5 failures and
   cools down, the whole-adapter budget guard stops spend, and a
   successful call is costed and recorded. `fetchImpl` is injected so
   nothing here ever leaves the machine.

   Run: npm run test:ai-client
   ================================================================= */
"use strict";
const assert = require("assert");
const client = require("./lib/ai/client");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

function okFetch(body, usage) {
  return async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: body || "hi" }, finish_reason: "stop" }],
      usage: usage || { prompt_tokens: 100, completion_tokens: 50 }
    })
  });
}
function failFetch(status) {
  return async () => ({ ok: false, status: status || 500, json: async () => ({ error: { message: "boom" } }) });
}
function hangingFetch(ms) {
  return async (url, opts) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ ok: true, json: async () => ({ choices: [], usage: {} }) }), ms);
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  });
}

const FULL_ROUTES = {
  prose: { baseUrl: "https://example.invalid/prose", model: "test-prose", key: "k1" },
  json: { baseUrl: "https://example.invalid/json", model: "test-json", key: "k2" }
};

(async () => {
  console.log("\n── off by default ──────────────────────────────────");

  await check("AI_ENABLED not set -> disabled, no fetch called", async () => {
    let called = false;
    client.init({ enabled: false, fetchImpl: async () => { called = true; }, routes: FULL_ROUTES });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.disabled, true);
    assert.strictEqual(called, false, "fetch was called despite AI_ENABLED being off");
  });

  await check("enabled, but a route has no key -> that route disabled, not a crash", async () => {
    client.init({ enabled: true, fetchImpl: okFetch(), routes: { prose: FULL_ROUTES.prose, json: { baseUrl: "", model: "", key: "" } } });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.disabled, true);
  });

  await check("unknown route throws — this is a caller bug, not an operational failure", async () => {
    client.init({ enabled: true, fetchImpl: okFetch(), routes: FULL_ROUTES });
    await assert.rejects(() => client.chat({ route: "vision", messages: [] }), /unknown route/);
  });

  console.log("\n── the happy path is costed and recorded ───────────");

  await check("a successful call returns message + usage + an estimated cost", async () => {
    client.init({ enabled: true, fetchImpl: okFetch("hello there"), routes: FULL_ROUTES });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.message.content, "hello there");
    assert.strictEqual(res.usage.prompt_tokens, 100);
    assert.ok(res.costUsd > 0, "expected a nonzero estimated cost");
    assert.ok(client.monthSpend("json") > 0, "spend was not recorded against the route");
  });

  await check("DeepSeek cache-hit tokens are costed at the cached rate, not the miss rate", async () => {
    client.init({ enabled: true, fetchImpl: okFetch("x", { prompt_cache_hit_tokens: 10000, prompt_cache_miss_tokens: 0, completion_tokens: 0 }), routes: FULL_ROUTES });
    const cheap = await client.chat({ route: "json", messages: [] });
    client.init({ enabled: true, fetchImpl: okFetch("x", { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10000, completion_tokens: 0 }), routes: FULL_ROUTES });
    const expensive = await client.chat({ route: "json", messages: [] });
    assert.ok(cheap.costUsd < expensive.costUsd, "a full cache hit should cost less than a full cache miss for the same token count");
  });

  console.log("\n── the circuit breaker, per route ──────────────────");

  await check("5 consecutive failures open the breaker; the 6th call never reaches fetch", async () => {
    let calls = 0;
    client.init({ enabled: true, fetchImpl: async () => { calls++; return failFetch()(); }, routes: FULL_ROUTES });
    for (let i = 0; i < 5; i++) await client.chat({ route: "json", messages: [] });
    assert.strictEqual(calls, 5);
    const res = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.breakerOpen, true, "breaker should be open after 5 straight failures");
    assert.strictEqual(calls, 5, "the 6th call reached fetch — the breaker did not actually stop it");
  });

  await check("a failing DeepSeek route does not affect Gemini — breakers are per route", async () => {
    let proseCalls = 0, jsonCalls = 0;
    client.init({
      enabled: true,
      fetchImpl: async (url) => { if (url.indexOf("/json") >= 0) { jsonCalls++; return failFetch()(); } proseCalls++; return okFetch()(); },
      routes: FULL_ROUTES
    });
    for (let i = 0; i < 6; i++) await client.chat({ route: "json", messages: [] });
    const proseRes = await client.chat({ route: "prose", messages: [] });
    assert.strictEqual(proseRes.ok, true, "prose route was blocked by the json route's breaker");
    assert.ok(jsonCalls >= 5 && proseCalls === 1);
  });

  console.log("\n── the monthly budget guard ────────────────────────");

  await check("spend at/above the budget disables every route, not just the one that spent it", async () => {
    client.init({ enabled: true, budgetUsd: 0.000001, fetchImpl: okFetch("x", { prompt_tokens: 100000, completion_tokens: 100000 }), routes: FULL_ROUTES });
    const first = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(first.ok, true, "the call that PUSHES spend over budget should still complete");
    const second = await client.chat({ route: "prose", messages: [] });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.budgetExceeded, true);
  });

  await check("budgetUsd: 0 means unlimited (the safety default is opt-in, not silently on)", async () => {
    client.init({ enabled: true, budgetUsd: 0, fetchImpl: okFetch("x", { prompt_tokens: 999999999, completion_tokens: 999999999 }), routes: FULL_ROUTES });
    await client.chat({ route: "json", messages: [] });
    const res = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(res.ok, true, "budgetUsd:0 incorrectly blocked a call");
  });

  console.log("\n── timeouts degrade, they do not hang or throw ─────");

  await check("a slow provider aborts at the timeout and reports timedOut, not an exception", async () => {
    client.init({ enabled: true, fetchImpl: hangingFetch(5000), routes: FULL_ROUTES });
    const res = await client.chat({ route: "json", messages: [], timeoutMs: 50 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.timedOut, true);
  });

  console.log("\n── observability hook ──────────────────────────────");

  await check("recordSpend hook fires with (route, usd) on every successful call", async () => {
    const seen = [];
    client.init({ enabled: true, fetchImpl: okFetch(), recordSpend: (route, usd) => seen.push({ route, usd }), routes: FULL_ROUTES });
    await client.chat({ route: "prose", messages: [] });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].route, "prose");
  });

  console.log("\n" + (failed === 0 ? "✓ ALL AI CLIENT TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
