/* =================================================================
   classify.js — which industry is this prompt about?
   -----------------------------------------------------------------
   Runtime side of scripts/train-classifier.js. Loads the generated
   log-probability tables and scores a prompt in microseconds: no
   model server, no network, no API.

   The important output is not the label — it is the CONFIDENCE. A
   confident guess builds the site immediately; an unconfident one asks
   the visitor a single question, which is far better than confidently
   building the wrong thing. See docs/NO-API-BUILDER-PLAN.md §3.4.
   ================================================================= */
"use strict";

const MODEL = require("./industry-model.json");
const { analyse, bigrams } = require("./normalise");

/* Below this, ask instead of guessing. */
const CONFIDENT = 0.55;
/* If the runner-up is this close, it is a coin flip — ask. */
const MARGIN = 0.15;
/* Fewer recognised words than this and we are guessing from noise. */
const MIN_EVIDENCE = 1;

/**
 * @param {string} text
 * @param {string} [forcedLang]
 * @returns {{industry:string, confidence:number, runnerUp:string|null,
 *            certain:boolean, lang:string, evidence:number, ranked:Array}}
 */
function classify(text, forcedLang) {
  const a = analyse(text, forcedLang);
  const model = MODEL.languages[a.lang] || MODEL.languages.en;
  const features = [...new Set(a.tokens.concat(bigrams(a.tokens)))];

  const labels = model.labels;
  const scores = labels.map((l) => model.prior[l]);
  let evidence = 0;

  for (const f of features) {
    const w = model.weights[f];
    if (!w) continue;                     // unseen words carry no evidence
    evidence++;
    for (let i = 0; i < labels.length; i++) scores[i] += w[i];
  }

  // log-scores -> a probability distribution (softmax, shifted for stability)
  const max = Math.max.apply(null, scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const sum = exp.reduce((x, y) => x + y, 0);
  const probs = exp.map((e) => e / sum);

  const ranked = labels
    .map((label, i) => ({ industry: label, p: probs[i] }))
    .sort((x, y) => y.p - x.p);

  const top = ranked[0];
  const second = ranked[1] || null;
  const certain = evidence >= MIN_EVIDENCE &&
    top.p >= CONFIDENT &&
    (!second || top.p - second.p >= MARGIN);

  return {
    industry: top.industry,
    confidence: Math.round(top.p * 1000) / 1000,
    runnerUp: second ? second.industry : null,
    certain: certain,
    lang: a.lang,
    evidence: evidence,
    ranked: ranked.map((r) => ({ industry: r.industry, p: Math.round(r.p * 1000) / 1000 }))
  };
}

/** The 2–3 options to offer when `certain` is false. */
function choices(result) {
  return result.ranked.slice(0, 3).filter((r) => r.p > 0.04).map((r) => r.industry);
}

module.exports = { classify, choices, CONFIDENT, MARGIN };
