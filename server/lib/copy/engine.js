/* =================================================================
   copy/engine.js — pick a human-written line and fill it in
   -----------------------------------------------------------------
   Every sentence that can ship was written by a person and lives in
   data/copy/<lang>.json. This module chooses between them.

   Two rules make that feel written rather than assembled:

     · GUARDS — a variant declares the slots it needs. "Roasted in
       *{city}*" is only eligible when a city was actually found, so
       there is never a "Roasted in undefined".
     · SEEDED CHOICE — the pick is a hash of (prompt + role), so the
       same prompt always yields the same site (testable), while two
       different prompts diverge across every role at once.

   See docs/NO-API-BUILDER-PLAN.md §5.
   ================================================================= */
"use strict";

const CORPUS = { en: require("../../../data/copy/en.json") };

/* FNV-1a — small, fast, and stable across runs and platforms, which a
   built-in hash would not be. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * @param {object} ctx  { industry, lang, seed, company, city, currency, tone, product, products }
 * @param {string} role e.g. "hero.title"
 * @param {string} [fallback]
 * @returns {string}
 */
function line(ctx, role, fallback) {
  const variants = eligible(ctx, role);
  if (!variants.length) return fill(fallback || "", ctx);
  const idx = hash((ctx.seed || "") + "|" + role) % variants.length;
  return fill(variants[idx], ctx);
}

/** Several distinct lines for the same role (steps, stats, card grids). */
function lines(ctx, role, count) {
  const variants = eligible(ctx, role);
  if (!variants.length) return [];
  const out = [];
  const start = hash((ctx.seed || "") + "|" + role) % variants.length;
  for (let i = 0; i < Math.min(count, variants.length); i++) {
    out.push(fill(variants[(start + i) % variants.length], ctx));
  }
  return out;
}

function eligible(ctx, role) {
  const byLang = CORPUS[ctx.lang] || CORPUS.en;
  const pool = ((byLang[ctx.industry] || {})[role]) || (((byLang._shared) || {})[role]) || [];
  return pool.filter((v) => {
    if (typeof v === "string") return true;
    // every declared slot must actually have a value
    if (Array.isArray(v.needs) && v.needs.some((k) => !ctx[k])) return false;
    // and the tone must match, when a variant is written for particular tones
    if (Array.isArray(v.tone) && v.tone.length && !v.tone.includes(ctx.tone || "neutral")) return false;
    return true;
  }).map((v) => (typeof v === "string" ? v : v.t));
}

/** {slot} substitution. Unknown or empty slots collapse rather than print. */
function fill(text, ctx) {
  return String(text || "")
    .replace(/\{(\w+)\}/g, (m, key) => (ctx[key] === null || ctx[key] === undefined ? "" : String(ctx[key])))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** How many distinct variants exist — used by the variation test. */
function poolSize(ctx, role) { return eligible(ctx, role).length; }

module.exports = { line, lines, poolSize, hash, CORPUS };
