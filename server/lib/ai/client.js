/* =================================================================
   ai/client.js — one adapter, two providers, routed by task
   -----------------------------------------------------------------
   docs/AI-PROVIDER-PLAN.md §3. Prose/multilingual work routes to
   Gemini; schema-constrained JSON (the code agent's tool calls, the
   refine grammar's fallback) routes to DeepSeek. Both speak the
   OpenAI chat-completions shape, so this is one HTTP client and a
   routing table — nothing else in the codebase is allowed to know a
   provider's name or URL.

   OFF BY DEFAULT: `init()` with no AI_ENABLED=1 in the environment
   makes every call return {ok:false, disabled:true} instantly, no
   network touched. That is the acceptance criterion for this module —
   every existing deterministic path must be provably unaffected by
   its presence (§0, "off by default").

   Every failure degrades to a return value the caller can act on.
   Nothing here throws for an ordinary operational failure (timeout,
   5xx, breaker open, budget spent) — those are correctness Mode, not
   exceptions, because a model being unavailable is not a bug.
   ================================================================= */
"use strict";

const DEFAULT_TIMEOUT_MS = 6000;
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

// Approximate $/1M tokens. VERIFY AGAINST CURRENT RATE CARDS before relying
// on this for real budgeting — both providers move these. Used only to
// produce an estimated costUsd on each call for the budget guard and for
// observability (docs/AI-PROVIDER-PLAN.md §7); never billed against directly.
const PRICING = {
  prose: { inputPerM: 0.10, outputPerM: 0.40 },                       // Gemini Flash
  json: { inputPerM: 0.27, inputCachedPerM: 0.07, outputPerM: 1.10 }  // DeepSeek chat
};

let CONFIG = null;
const breakers = {}; // route -> { failCount, openUntil }
let spend = {};       // "YYYY-MM" -> route -> usd  (in-memory; see recordSpend hook)

function monthKey(d) {
  const dt = d || new Date();
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0");
}

function routeFromEnv(env, prefix) {
  return {
    baseUrl: env[prefix + "_BASE_URL"] || "",
    model: env[prefix + "_MODEL"] || "",
    key: env[prefix + "_KEY"] || ""
  };
}

/**
 * @param {object} [overrides]
 * @param {boolean} [overrides.enabled]
 * @param {number} [overrides.budgetUsd]
 * @param {Function} [overrides.fetchImpl]   injection point for tests — never hits the network when supplied
 * @param {Function} [overrides.recordSpend] (route, usd) => void — plug in the audit collection later; defaults to in-memory
 * @param {object} [overrides.routes]        { prose: {baseUrl,model,key}, json: {...} } — overrides env for tests
 */
function init(overrides) {
  const o = overrides || {};
  const env = process.env;
  CONFIG = {
    enabled: (o.enabled !== null && o.enabled !== undefined) ? o.enabled : env.AI_ENABLED === "1",
    budgetUsd: Number((o.budgetUsd !== null && o.budgetUsd !== undefined) ? o.budgetUsd : (env.AI_MONTHLY_BUDGET_USD || 0)),
    fetchImpl: o.fetchImpl || globalThis.fetch,
    recordSpendHook: o.recordSpend || null,
    routes: {
      prose: (o.routes && o.routes.prose) || routeFromEnv(env, "AI_PROSE"),
      json: (o.routes && o.routes.json) || routeFromEnv(env, "AI_JSON")
    }
  };
  for (const r of Object.keys(CONFIG.routes)) breakers[r] = { failCount: 0, openUntil: 0 };
  spend = {};
  return CONFIG;
}

function ensureInit() {
  if (!CONFIG) init(); // reads real env on first use — same as any other lazily-configured module here
}

function recordFailure(route) {
  const b = breakers[route];
  b.failCount += 1;
  if (b.failCount >= BREAKER_FAILURE_THRESHOLD) b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
}
function recordSuccess(route) {
  breakers[route] = { failCount: 0, openUntil: 0 };
}
function breakerOpen(route) {
  const b = breakers[route];
  return !!(b && b.openUntil && Date.now() < b.openUntil);
}

function recordSpend(route, usd) {
  const k = monthKey();
  spend[k] = spend[k] || {};
  spend[k][route] = (spend[k][route] || 0) + usd;
  if (CONFIG.recordSpendHook) { try { CONFIG.recordSpendHook(route, usd); } catch (e) { /* observability must never break the call */ } }
}
function monthSpend(route) {
  const k = monthKey();
  return (spend[k] && spend[k][route]) || 0;
}
function budgetExceeded(route) {
  if (!CONFIG.budgetUsd || CONFIG.budgetUsd <= 0) return false;
  // Budget is a whole-adapter guard (docs/AI-PROVIDER-PLAN.md §6 "monthly
  // budget hit"), not per-route — one runaway route shouldn't get a full
  // budget's worth of headroom just because another route stayed quiet.
  const total = Object.keys(CONFIG.routes).reduce((sum, r) => sum + monthSpend(r), 0);
  return total >= CONFIG.budgetUsd;
}

function estimateCost(route, usage) {
  const p = PRICING[route];
  if (!p || !usage) return 0;
  const outTok = usage.completion_tokens || 0;
  let inCost;
  const hasCacheBreakdown = (usage.prompt_cache_hit_tokens !== null && usage.prompt_cache_hit_tokens !== undefined) ||
    (usage.prompt_cache_miss_tokens !== null && usage.prompt_cache_miss_tokens !== undefined);
  if (p.inputCachedPerM && hasCacheBreakdown) {
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens || 0;
    inCost = (hit / 1e6) * p.inputCachedPerM + (miss / 1e6) * p.inputPerM;
  } else {
    inCost = ((usage.prompt_tokens || 0) / 1e6) * p.inputPerM;
  }
  const outCost = (outTok / 1e6) * p.outputPerM;
  return inCost + outCost;
}

/**
 * @param {object} req
 * @param {"prose"|"json"} req.route
 * @param {Array<{role:string, content:string}>} req.messages
 * @param {Array<object>} [req.tools]            OpenAI tool-calling schema
 * @param {{type:string}} [req.responseFormat]    e.g. {type:"json_object"}
 * @param {number} [req.maxTokens]
 * @param {number} [req.temperature]
 * @param {number} [req.timeoutMs]
 * @returns {Promise<object>} always resolves — never throws for an operational failure
 */
async function chat(req) {
  ensureInit();
  const route = req.route;
  if (!CONFIG.routes[route]) throw new Error("ai/client: unknown route \"" + route + "\" (expected \"prose\" or \"json\")");

  if (!CONFIG.enabled) return { ok: false, disabled: true, reason: "AI_ENABLED is not set" };

  const r = CONFIG.routes[route];
  if (!r.key || !r.baseUrl || !r.model) {
    return { ok: false, disabled: true, reason: "route \"" + route + "\" has no key/baseUrl/model configured" };
  }
  if (breakerOpen(route)) {
    return { ok: false, breakerOpen: true, reason: "circuit breaker open for \"" + route + "\" until " + new Date(breakers[route].openUntil).toISOString() };
  }
  if (budgetExceeded(route)) {
    return { ok: false, budgetExceeded: true, reason: "monthly AI budget of $" + CONFIG.budgetUsd + " reached" };
  }

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await CONFIG.fetchImpl(r.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + r.key },
      body: JSON.stringify({
        model: r.model,
        messages: req.messages,
        tools: req.tools || undefined,
        response_format: req.responseFormat || undefined,
        max_tokens: req.maxTokens || 900,
        temperature: (req.temperature !== null && req.temperature !== undefined) ? req.temperature : 0.5
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      recordFailure(route);
      let detail = "";
      try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch (e) { /* not JSON */ }
      return { ok: false, error: true, status: res.status, reason: "provider returned " + res.status + (detail ? ": " + detail : ""), latencyMs: Date.now() - t0 };
    }

    const json = await res.json();
    recordSuccess(route);
    const usage = json.usage || {};
    const costUsd = estimateCost(route, usage);
    recordSpend(route, costUsd);

    const choice = json.choices && json.choices[0];
    return {
      ok: true,
      message: choice ? choice.message : null,
      finishReason: choice ? choice.finish_reason : null,
      usage: usage,
      costUsd: costUsd,
      latencyMs: Date.now() - t0
    };
  } catch (e) {
    clearTimeout(timer);
    recordFailure(route);
    const timedOut = e.name === "AbortError";
    return { ok: false, error: true, timedOut: timedOut, reason: timedOut ? "timed out after " + (req.timeoutMs || DEFAULT_TIMEOUT_MS) + "ms" : e.message, latencyMs: Date.now() - t0 };
  }
}

/** For tests and dashboards — not used in the request path. */
function _debugState() {
  return { config: CONFIG, breakers: JSON.parse(JSON.stringify(breakers)), spend: JSON.parse(JSON.stringify(spend)) };
}

module.exports = { init, chat, monthSpend, budgetExceeded, _debugState };
