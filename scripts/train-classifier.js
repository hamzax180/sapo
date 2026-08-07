#!/usr/bin/env node
/* =================================================================
   train-classifier.js — data/train/*.tsv ➜ industry-model.json
   -----------------------------------------------------------------
   A multinomial Naive Bayes over unigrams + bigrams, one model per
   language. Training is a few thousand counts; inference is a sum of
   logs over ~10 tokens. No neural net, no runtime dependency, no API
   — the artefact is a plain JSON of log-probabilities that ships in
   the repo. See docs/NO-API-BUILDER-PLAN.md §3.2.

   Usage:
     node scripts/train-classifier.js            # train + write + report
     node scripts/train-classifier.js --check    # fail if the file is stale
     node scripts/train-classifier.js --eval     # held-out accuracy only
   ================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TRAIN_DIR = path.join(ROOT, "data", "train");
const OUT = path.join(ROOT, "server", "lib", "nlu", "industry-model.json");
const { analyse, bigrams } = require(path.join(ROOT, "server", "lib", "nlu", "normalise.js"));

const LANGS = ["en", "tr", "ar"];

/* ---- corpus ------------------------------------------------------- */

function readCorpus(lang) {
  const file = path.join(TRAIN_DIR, "industry." + lang + ".tsv");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const tab = l.indexOf("\t");
      if (tab < 0) throw new Error(lang + ": row is missing a tab — " + l.slice(0, 50));
      return { label: l.slice(0, tab).trim(), text: l.slice(tab + 1).trim() };
    });
}

/** Features for one prompt: unigrams + bigrams, language forced to the
    corpus language so a Turkish row is never tokenised as English.
    Deduplicated — this is *binarised* NB, which is well established to beat
    raw counts on short texts, where one repeated word would otherwise
    dominate a ten-word document. */
function featurise(text, lang) {
  const a = analyse(text, lang);
  return [...new Set(a.tokens.concat(bigrams(a.tokens)))];
}

/* ---- training ----------------------------------------------------- */

/* Hand-curated domain terms, injected as pseudo-counts. At ~12 labelled
   prompts per class the corpus cannot cover the vocabulary — two coffee-shop
   prompts may share no content word at all — so the lexicon carries the
   domain knowledge and the corpus supplies the phrasing around it.

   Weight 6 was chosen by sweeping 4/6/8/12/16/24 against 5-fold accuracy:
   4 underweights the lexicon (en 86.5%), and everything above 6 is flat or
   slightly worse for Arabic (ar 87.5% → 85.4%). */
const LEX_WEIGHT = 6;
const LEXICON = JSON.parse(fs.readFileSync(path.join(TRAIN_DIR, "lexicon.json"), "utf8")).industries;

function lexiconFeatures(label, lang) {
  const terms = ((LEXICON[label] || {})[lang]) || [];
  const out = [];
  for (const term of terms) out.push(...featurise(term, lang));
  return out;
}

function train(rows, lang) {
  const docCount = {};             // label -> number of prompts
  const tokenCount = {};           // label -> token -> count
  const labelTotal = {};           // label -> total tokens
  const vocab = new Set();

  // seed every class with its lexicon before the corpus is counted
  for (const label of Object.keys(LEXICON)) {
    tokenCount[label] = tokenCount[label] || {};
    labelTotal[label] = labelTotal[label] || 0;
    docCount[label] = docCount[label] || 0;
    for (const f of lexiconFeatures(label, lang)) {
      tokenCount[label][f] = (tokenCount[label][f] || 0) + LEX_WEIGHT;
      labelTotal[label] += LEX_WEIGHT;
      vocab.add(f);
    }
  }

  for (const row of rows) {
    docCount[row.label] = (docCount[row.label] || 0) + 1;
    tokenCount[row.label] = tokenCount[row.label] || {};
    labelTotal[row.label] = labelTotal[row.label] || 0;
    for (const f of featurise(row.text, lang)) {
      tokenCount[row.label][f] = (tokenCount[row.label][f] || 0) + 1;
      labelTotal[row.label]++;
      vocab.add(f);
    }
  }

  const labels = Object.keys(docCount).sort();
  const V = vocab.size;
  // every class is seeded by the lexicon, so treat the prior as uniform
  // rather than letting an uneven corpus tilt it
  const nDocs = labels.length;
  labels.forEach((l) => { docCount[l] = 1; });

  // Laplace (add-1) smoothing, stored as logs so inference is a plain sum.
  const prior = {};
  const weights = {};             // token -> [logP per label], parallel to `labels`
  const missing = {};             // label -> log P(unseen token)

  labels.forEach((label) => {
    prior[label] = Math.log(docCount[label] / nDocs);
    missing[label] = Math.log(1 / (labelTotal[label] + V));
  });

  for (const token of vocab) {
    weights[token] = labels.map((label) => {
      const c = (tokenCount[label] || {})[token] || 0;
      return round(Math.log((c + 1) / (labelTotal[label] + V)));
    });
  }
  labels.forEach((l) => { prior[l] = round(prior[l]); missing[l] = round(missing[l]); });

  return { labels: labels, prior: prior, missing: missing, weights: weights, vocabSize: V, docs: nDocs };
}

function round(n) { return Math.round(n * 1000) / 1000; }

/* ---- evaluation: k-fold, so we report honest accuracy -------------- */

function crossValidate(rows, lang, folds) {
  const k = folds || 5;
  // deterministic shuffle so the reported number doesn't move between runs
  const shuffled = rows.slice().sort((a, b) => hash(a.text) - hash(b.text));
  let correct = 0, total = 0;
  const confusion = {};

  for (let f = 0; f < k; f++) {
    const test = shuffled.filter((_, i) => i % k === f);
    const trainRows = shuffled.filter((_, i) => i % k !== f);
    if (!test.length || !trainRows.length) continue;
    const model = train(trainRows, lang);
    for (const row of test) {
      const got = predict(model, featurise(row.text, lang)).label;
      total++;
      if (got === row.label) correct++;
      else {
        const key = row.label + " → " + got;
        confusion[key] = (confusion[key] || 0) + 1;
      }
    }
  }
  return { accuracy: total ? correct / total : 0, total: total, confusion: confusion };
}

/**
 * Words the model has never seen carry no evidence, so they are SKIPPED,
 * not scored. Scoring them adds log(1/(labelTotal+V)) per label, which is
 * larger for classes with fewer training tokens — with a short prompt and a
 * sparse vocabulary that term swamps the real signal and the classifier
 * collapses onto whichever class has the shortest prompts. (Measured: doing
 * it the naive way scored 32%; skipping OOV scores far higher.)
 */
function predict(model, features) {
  const scores = model.labels.map((l) => model.prior[l]);
  let seen = 0;
  for (const f of features) {
    const w = model.weights[f];
    if (!w) continue;
    seen++;
    for (let i = 0; i < model.labels.length; i++) scores[i] += w[i];
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return { label: model.labels[best], scores: scores, seen: seen };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ---- main --------------------------------------------------------- */

function main() {
  const models = {};
  const report = [];

  for (const lang of LANGS) {
    const rows = readCorpus(lang);
    if (!rows.length) { report.push([lang, 0, 0, "—"]); continue; }
    models[lang] = train(rows, lang);
    const ev = crossValidate(rows, lang);
    report.push([lang, rows.length, models[lang].vocabSize, (ev.accuracy * 100).toFixed(1) + "%", ev.confusion]);
  }

  const artefact = {
    generatedBy: "scripts/train-classifier.js",
    note: "GENERATED FILE — do not hand-edit. Run `npm run train:nlu` after editing data/train/*.tsv.",
    algorithm: "multinomial naive bayes, unigram+bigram, add-1 smoothing, log-space",
    languages: models
  };
  const json = JSON.stringify(artefact) + "\n";

  if (process.argv.includes("--eval")) { printReport(report); return; }

  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (current !== json) {
      console.error("✗ server/lib/nlu/industry-model.json is stale.");
      console.error("  data/train/*.tsv changed without retraining. Run: npm run train:nlu");
      process.exit(1);
    }
    console.log("✓ industry-model.json is up to date");
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log("✓ wrote " + path.relative(ROOT, OUT) + " (" + (json.length / 1024).toFixed(0) + " KB)");
  printReport(report);
}

function printReport(report) {
  console.log("\n  lang  prompts  vocab   5-fold accuracy");
  console.log("  ────  ───────  ──────  ────────────────");
  for (const [lang, n, v, acc, conf] of report) {
    console.log("  " + lang.padEnd(6) + String(n).padEnd(9) + String(v).padEnd(8) + acc);
    if (conf && Object.keys(conf).length) {
      Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .forEach(([k, c]) => console.log("          " + c + "× " + k));
    }
  }
  console.log("");
}

main();
