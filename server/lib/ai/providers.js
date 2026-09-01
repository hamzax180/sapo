/* =================================================================
   ai/providers.js — the catalogue of model providers a USER can pick
   -----------------------------------------------------------------
   Two different things are called "a provider" in this codebase and
   conflating them causes real bugs, so they are separated here:

     • ROUTES (ai/client.js `prose` / `json`) are SOUQI'S OWN keys,
       configured in server/.env. They are the default and the only
       thing an anonymous visitor ever uses. Souqi pays for them.

     • PROVIDERS (this file) are BRING-YOUR-OWN-KEY. A signed-in user
       pastes their own Anthropic/Gemini/OpenAI/DeepSeek key, it is
       encrypted at rest (lib/crypto.js) against their account, and
       their builds run on it. Souqi pays nothing and the user is not
       subject to Souqi's monthly budget guard.

   `id: "souqi"` is the sentinel for "no BYOK, use the server route" —
   it is deliberately in the same list so the picker has one uniform
   shape instead of a special case in every caller.

   `kind` is what actually decides the transport:
     "route"        -> ai/client.js's configured json route
     "openai"       -> OpenAI chat-completions shape (client.js)
     "anthropic"    -> Anthropic Messages API via the official SDK
                       (ai/anthropic.js). NOT the OpenAI-compat shim:
                       thinking, tool blocks and stop reasons are all
                       different enough that pretending otherwise
                       silently loses features.
   ================================================================= */
"use strict";

const PROVIDERS = [
  {
    id: "souqi",
    label: "Souqi Default",
    hint: "Runs on Souqi's own models. No key needed.",
    kind: "route",
    byok: false,
    defaultModel: null,
    keyPattern: null,
    keyPlaceholder: null
  },
  {
    id: "claude",
    label: "Claude",
    hint: "Anthropic API key (starts sk-ant-). Best quality for multi-file apps.",
    kind: "anthropic",
    byok: true,
    defaultModel: "claude-opus-5",
    // Deliberately loose: Anthropic has shipped more than one key prefix
    // (sk-ant-api03-, sk-ant-admin...), and a regex tight enough to pin the
    // current one would reject a valid future key with a confusing
    // "invalid key" that is really "our regex is stale". Shape only.
    keyPattern: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
    keyPlaceholder: "sk-ant-..."
  },
  {
    id: "gemini",
    label: "Gemini",
    hint: "Google AI Studio API key. Fast and cheap.",
    kind: "openai",
    byok: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    keyPattern: /^[A-Za-z0-9_\-]{30,}$/,
    keyPlaceholder: "AIza..."
  },
  {
    id: "openai",
    label: "OpenAI",
    hint: "OpenAI API key (starts sk-).",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    byok: true,
    defaultModel: "gpt-4o",
    keyPattern: /^sk-[A-Za-z0-9_\-]{20,}$/,
    keyPlaceholder: "sk-..."
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "DeepSeek API key. Cheapest for code generation.",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    byok: true,
    defaultModel: "deepseek-chat",
    keyPattern: /^sk-[A-Za-z0-9_\-]{20,}$/,
    keyPlaceholder: "sk-..."
  }
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

function get(id) {
  return BY_ID.get(String(id || "").toLowerCase()) || null;
}

function isValidId(id) {
  return BY_ID.has(String(id || "").toLowerCase());
}

/** The shape the picker renders. Never includes keys or regexes. */
function publicList() {
  return PROVIDERS.map((p) => ({
    id: p.id, label: p.label, hint: p.hint, byok: !!p.byok,
    defaultModel: p.defaultModel || null,
    keyPlaceholder: p.keyPlaceholder || null
  }));
}

/**
 * Shape-check a pasted key before it is ever stored or sent anywhere.
 *
 * This is a typo guard, not authentication — only the provider can say
 * whether a key is real. The point is to fail immediately on an obviously
 * wrong paste (a whole curl command, a model name, an empty string) rather
 * than storing it and surfacing the mistake later as an opaque 401 in the
 * middle of somebody's build.
 */
function validateKey(providerId, key) {
  const p = get(providerId);
  if (!p) return { ok: false, reason: "unknown provider" };
  if (!p.byok) return { ok: false, reason: p.label + " does not take an API key" };
  const k = String(key || "").trim();
  if (!k) return { ok: false, reason: "API key is required" };
  if (k.length > 400) return { ok: false, reason: "that does not look like an API key" };
  if (/\s/.test(k)) return { ok: false, reason: "an API key should not contain spaces" };
  if (p.keyPattern && !p.keyPattern.test(k)) {
    return { ok: false, reason: "that does not look like a " + p.label + " key" };
  }
  return { ok: true, key: k };
}

/** Last 4 characters only — enough for a user to recognise which key is stored. */
function maskKey(key) {
  const k = String(key || "");
  if (k.length < 8) return "••••";
  return "••••" + k.slice(-4);
}

module.exports = { PROVIDERS, get, isValidId, publicList, validateKey, maskKey };
