# Souqi Agent — Beating Replit With No AI API

> **Constraint:** no third-party AI API. No `GEMINI_API_KEY`, no OpenAI bill, no per-build cost, no quota wall, no vendor outage, no user data leaving the server.
>
> **Claim:** for *this* job — a business getting a real storefront — that constraint is an advantage, not a handicap. Replit's agent has to write code, so it needs a frontier model. Souqi doesn't write code: it fills a **typed 20-block document** that a validated renderer turns into a site. Filling a typed document from a sentence is a solved problem without a language model.
>
> Builds on: [AI-BUILDER-PLAN.md](AI-BUILDER-PLAN.md) (this replaces its §3.2–3.4 model pipeline; §3.1 contract, §3.6 validator and the draft/claim flow stand unchanged). Grounded in what already ships: `server/lib/template-composer.js`, `server/lib/site-validate.js`, `server/lib/block-schema.json`, `server/agent-test.js` (41 passing).

---

## 0. Where the two products actually compete

| | **Replit Agent** | **Souqi Agent (no API)** |
|---|---|---|
| Output | source code for an app | a validated `storefrontConfig` |
| Time to first paint | 40–120 s | **< 200 ms** (measured: composer + validator) |
| Cost per build | real model spend | **zero** |
| Can produce something broken | yes — code that won't compile or render | **structurally impossible** — output that fails the schema is dropped, not shipped |
| Content quality ceiling | high, generic | high **within 8 industries**, generic outside them |
| Real business data | none — fake seed data | live products, stock, orders from the console |
| Editing after generation | edit code | click the thing and change it |
| Languages | English-centric | EN / TR / AR with real RTL |
| Offline / air-gapped | no | yes |

**The honest read:** an LLM wins on *open-ended novelty* ("build me a 3D maze game"). We are not competing there and should not pretend to. We win decisively on **speed, reliability, cost, domain depth, and the fact that the output plugs into a real operations platform.** A restaurant owner in Istanbul does not need novelty; they need their menu online in ten seconds, in Turkish, wired to their stock.

**So the strategy is not "fake an LLM." It is: be excellent at a narrow, valuable job, and be instant.**

---

## 1. Principles

1. **Structure is deterministic. Always.** Which blocks, in which order, with which fields — decided by code, never by a probabilistic system. This is what makes "impossible to produce a broken site" true.
2. **Words are curated, not invented.** Every sentence that can ship was written by a human and lives in a corpus. A good human sentence beats a mediocre generated one, every time.
3. **Echo the user.** The single largest perceived-intelligence win, at zero cost: put the visitor's own words — business name, city, product nouns — into the headline. "Roasted in Istanbul" reads as understanding.
4. **Deterministic ≠ repetitive.** Variation comes from a seeded pick over a large combinatorial space, not from randomness. Same prompt → same site (testable); different prompts → visibly different sites.
5. **Ask instead of guessing.** When confidence is low, one chip-row question beats a confidently wrong site. Replit cannot cheaply do this; a 150 ms classifier can.
6. **Any model is an optional polish layer, never the structure.** If a local model is present it may *rewrite strings in an already-valid config*. If it's absent, slow, or wrong, we ship the curated copy and nobody notices.
7. **Everything still goes through `site-validate.js`.** One trust boundary, unchanged.

---

## 2. Architecture

```
prompt ─▶ ① UNDERSTAND ─▶ ② DECIDE ─▶ ③ COMPOSE ─▶ ④ STYLE ─▶ ⑤ VALIDATE ─▶ draft
          intent + slots   archetype   copy grammar  palette,    (unchanged)
          (classifier)     selection   + user words  type, art
                │                                        ▲
                └─ low confidence ─▶ ask one question ────┘
                                                    ⑥ POLISH (optional, local model, strings only)
```

Total budget: **< 250 ms** on the server, no network calls.

---

## 3. ① Understand — NLU without a model

Three passes over the sentence, all in `server/lib/nlu/`.

### 3.1 Normalise (`normalise.js`)
Lowercase, strip punctuation, fold diacritics (`ı/İ/ş/ğ/ö/ü/ç`, Arabic `أإآ→ا`), collapse whitespace, detect script → language (`en` | `tr` | `ar`). Turkish suffix stripping is enough with a **light stemmer** (drop `-lar/-ler/-cı/-ci/-lık/-lik/-sı/-si`); Arabic needs prefix stripping (`ال`, `و`, `ب`, `ل`).

### 3.2 Classify industry (`classify.js`)
Today's approach is first-keyword-wins. Upgrade to a **multinomial Naive Bayes** classifier trained offline on a labelled corpus that ships in-repo:

- `data/train/industry.{en,tr,ar}.tsv` — **~250 labelled prompts per language**, hand-written plus harvested from real signups.
- `scripts/train-classifier.js` computes log-priors and per-token log-likelihoods, writes `server/lib/nlu/industry-model.json` (a few hundred KB of numbers — **not a neural net, no runtime dependency**).
- Inference is a sum of logs over ~10 tokens: microseconds.
- Emits `{ industry, confidence, runnerUp }`.

Why this over keywords: it handles *"I sell parts to garages"* (no keyword) and weighs evidence instead of racing. Same technique that ran spam filters for twenty years — boring, fast, and inspectable.

### 3.3 Extract slots (`slots.js`)
Rule-based, high precision, each independently testable:

| Slot | How |
|---|---|
| `company` | `called/named/adlı/اسمها X`, possessive `X's`, Title-Case run near the head noun. Stop at clause boundaries (already fixed in `template-composer.js`) |
| `city` | gazetteer of ~2,000 TR/MENA/EU cities → used in copy *and* in the footer |
| `products` | noun phrases after `sell/selling/satıyorum/نبيع`, plus known product nouns per industry |
| `features` | closed vocabulary → block decisions: booking, delivery, online ordering, tracking, menu, catalogue, quotes/RFQ, gallery, reviews, multi-branch |
| `tone` | adjective lexicon → `warm` / `premium` / `technical` / `playful` (selects a copy register) |
| `colour` | 24 colour words × 3 languages → seed hex |
| `currency` | from city/country, or `₺ $ € ﷼` in the text |

**Test discipline:** every slot gets a fixture table in `agent-test.js` with ≥20 positive and ≥10 negative cases. Precision matters far more than recall — a wrong city is worse than no city.

### 3.4 Clarify when unsure
If `confidence < 0.55` or the runner-up is within 15%, the build endpoint returns `needsAnswer` instead of a config, and the home page shows one chip row:

> **Which is closest?** ` Restaurant `  ` Retail shop `  ` Wholesale `

One tap, and the build runs. This is a **feature Replit's flow cannot afford** — asking costs them a whole agent turn; it costs us 150 ms.

---

## 4. ② Decide — layout archetypes

Not one template per industry. **Three archetypes per industry × 8 industries = 24 skeletons**, each a validated block sequence in `data/archetypes/*.json`:

- **Catalogue-led** — topbar · hero · product-grid · stats · steps · quote-banner · footer
- **Story-led** — hero · richtext · editorial-grid · stats · card-grid · footer
- **Conversion-led** — hero · card-grid · steps · rfq-form · case-studies · footer

Selection = `(industry, features, tone)` → archetype, with the *features* slot able to inject blocks (`booking` → `steps` + `rfq-form`; `tracking` → `tracker`; `menu` → a menu page).

Page set is derived the same way: catalogue industries get a products page, quote-led ones get a contact/RFQ page. (Already working in `template-composer.js`; this generalises it.)

**Result:** two coffee shops with different sentences get different structures — not the same page with different words.

---

## 5. ③ Compose — a copy grammar

The heart of "no API" and the part that decides whether this feels premium or cheap.

### 5.1 The corpus
`data/copy/{lang}/{industry}.json`, one entry per **section role**:

```jsonc
{
  "hero.title": [
    "Roasted in *{city}*",                      // needs city
    "*{product}*, made fresh every morning",    // needs product
    "Good coffee, *properly* made",             // always safe
    "*{company}* — since the first cup"
  ],
  "hero.sub": [ "…", "…", "…" ],
  "steps.title": [ … ], "story.body": [ … ], "quote": [ … ]
}
```

Rules that make this work:

- **Guarded variants.** Each line declares the slots it needs; lines whose slots are empty are never chosen. So `{city}` only appears when a city was actually found — no `"Roasted in undefined"`.
- **Volume.** Target **12+ variants per role per industry per language**. 8 industries × ~10 roles × 12 × 3 languages ≈ **2,900 lines**. That is a week of writing, once, and it is the moat: it never regresses, never costs anything, and can be improved by a copywriter rather than a prompt engineer.
- **Register tags.** Each line tagged `warm|premium|technical|playful`; the `tone` slot filters before picking.
- **Seeded pick.** `index = hash(prompt + role) % candidates.length`. Deterministic per prompt (testable), different across prompts. With 12 variants across 10 roles the space is 12¹⁰ — collisions are not a practical concern.

### 5.2 Why this reads better than a cheap LLM
A small local model produces *plausible* sentences with a characteristic flatness ("Welcome to our store! We offer quality products at great prices."). A curated line written by a person for a specific industry ("We cook in small batches with ingredients we buy ourselves") is simply better writing. **We should compete on craft, not on inference.**

### 5.3 Product seeding
`data/products/{industry}.json` — 12 realistic items each with name, plausible price band, and a short description, localised and currency-aware. A generated coffee shop shows *Türk kahvesi · 250g · ₺165*, not *Product 1 · $99*. On claim, these are inserted as **editable demo products** the owner can rename — and if they connect their real inventory, they're replaced by live data. **Replit cannot do this at all.**

---

## 6. ④ Style — design without a model

### 6.1 Palette engine (`server/lib/design/palette.js`)
Input: a colour word, an uploaded logo, or the industry default. Output: a full ramp.

- Convert seed → **OKLCH**, generate surface / surface-2 / ink / ink-2 / line / accent / accent-hover by moving lightness and chroma along fixed, hand-tuned deltas.
- **Enforce WCAG AA**: compute contrast for every text-on-surface pair and nudge lightness until ≥4.5:1 (≥3:1 for large text). A generated site is *never* inaccessible — a guarantee no LLM can make.
- Logo → palette: extract the dominant non-neutral colour client-side (canvas, k-means over a downsampled bitmap, ~20 ms). No upload of the image needed for the colour itself.

### 6.2 Type & rhythm
A small table of **6 tested font pairings** (all already self-hosted or Google-served, as today) tagged by tone, plus one spacing scale. Chosen by `tone`, not invented.

### 6.3 Imagery
- **Curated packs**: `public/assets/stock/{industry}/` — 8–12 licensed images per industry, self-hosted. Selected by archetype slot + seeded pick. Already allowlisted by the validator's `/assets/` rule.
- **Procedural fallback**: deterministic SVG gradient/pattern generated from the palette, so a site with no photographs still looks composed rather than empty.
- No external image API, no hotlinking, no licensing risk.

---

## 7. ⑥ Polish — optional local inference, still no API

Only if we want it, and never load-bearing.

| Option | Where it runs | Cost | Use |
|---|---|---|---|
| **transformers.js / WebLLM** | the visitor's browser, WebGPU | zero | rewrite 3–6 strings after the site is already on screen |
| **llama.cpp** | the Souqi server | our hardware only | same, server-side, for browsers without WebGPU |
| **none** | — | — | curated copy ships as-is |

Rules if this is built:
- It receives an **already-valid config** and may only return **replacement strings for named fields**. It never chooses blocks, never emits JSON structure, never sees a schema it could break.
- Output goes back through `site-validate.js` like everything else.
- Hard timeout (~3 s); on timeout or garbage, keep the curated string. The user sees a site either way.
- Runs **after first paint** — the site is on screen in 200 ms and quietly improves, rather than making anyone wait.

This is the only place a model belongs in a no-API design, and it is strictly optional.

---

## 8. Refinement — a command grammar, not a chat model

The follow-up loop ("make it darker", "add a menu page", "remove the testimonials") does **not** need a model. Roughly 50 phrasings cover the vast majority of requests, and they map to the six patch ops from [AI-BUILDER-PLAN.md](AI-BUILDER-PLAN.md) §3.5:

```
(make|set) it? (darker|lighter|warmer|cooler|bolder)   → setTheme
add (a)? {block|page} (called X)?                       → addBlock / addPage
remove|delete|hide the {block}                          → removeBlock
move the {block} (up|down|to the top|to the bottom)     → moveBlock
change the {field} to "X"                               → setProp
use {colour}                                            → setTheme accent
```

Parsed with the same NLU stack. Unmatched input gets an honest, useful reply — *"I can change colours, add or remove sections, reorder them, and edit text. Try 'add a contact page'."* — plus suggestion chips. **Predictable beats clever** for an owner editing their own shop.

---

## 9. What we deliberately do *not* claim

Being straight about this protects the product:

- We will **not** build "any app from any prompt." Ask for a 3D maze game and the honest answer is *"Souqi builds business sites and storefronts — here's what I can make instead."*
- Outside the 8 industries, output degrades to a competent generic business site. That should be **said**, not hidden — and it's the signal for which industry pack to write next.
- Very long, unusual, or multi-business prompts are where a frontier LLM would genuinely do better. If that traffic turns out to matter, the provider adapter from [AI-BUILDER-PLAN.md](AI-BUILDER-PLAN.md) §3.4 is still there — this plan doesn't burn that bridge, it just refuses to *depend* on it.

---

## 10. Phases

| Phase | Work | Outcome |
|---|---|---|
| **1 — Understand** ✅ *built* | `nlu/normalise.js`, `data/train/industry.{en,tr,ar}.tsv` (208 labelled prompts) + `lexicon.json`, `train-classifier.js` → `industry-model.json`, `nlu/classify.js`, `nlu/slots.js`, `nlu-test.js` (**57 tests**), clarify chips wired through `/api/agent/build` | **5-fold accuracy: en 89.6% · tr 82.8% · ar 87.5%**, 0.19 ms per prompt. Vague prompts ask instead of guessing |
| **2 — Corpus** ✅ *built* | `data/archetypes.json` (5 archetypes, 3 per industry + feature injection), `data/copy/en.json` (guarded, tone-tagged variants), `lib/copy/engine.js` (seeded pick) | **8 distinct structures and 21/24 distinct headlines across 24 prompts.** TR/AR corpora still to write |
| **3 — Design** ◐ *core done* | ✅ `lib/design/palette.js` — OKLCH ramp, AA enforced by measurement, accent auto-fitted so its own label is legible. ⬜ logo colour extraction, font-pair table, curated image packs | **24/24 palettes pass AA**, and every hue 0–360° clears 4.5:1 on the accent |
| **4 — Products** ◐ *seeds done* | ✅ `data/products/en.json` — 8 items per industry, currency-aware. ⬜ demo→real inventory swap on claim | Storefronts show *Türk kahvesi · 250g · ₺165*, not *Product 1 · $99* |
| **5 — Refine** (3 d) | Command grammar → the 6 patch ops, suggestion chips, honest fallback reply | Iteration without a model |
| **6 — TR / AR** (4 d) | Corpus + classifier + gazetteer in all three languages, RTL copy checks | A market almost nobody serves properly |
| **7 — Prove it** (2 d) | Golden-prompt snapshots, blind A/B vs Replit output, quality metrics (§11) | Evidence for the claim in the title |

Phases 1–2 are the value; 3–4 are the polish that makes it feel premium; 6 is the genuine moat.

---

## 11. How we'll know it's actually better

Measurable, not vibes:

- **Time to first paint** — target **< 500 ms** p95 end-to-end. (Replit: tens of seconds. This is the headline.)
- **Edits before publish** — median count of editor changes between generation and publish. Falling = generation is getting closer to what people wanted. This is the truest quality signal we have.
- **Industry accuracy** — held-out classifier test set, target **> 90%**.
- **Variation** — 100 distinct prompts must yield ≥ 85 distinct block sequences and no repeated hero headline.
- **Accessibility** — 100% of generated palettes pass AA. Automated, non-negotiable.
- **Blind comparison** — 20 prompts, our output vs a Replit build, judged by people who don't know which is which, on "would you publish this?"
- **Determinism** — the same prompt yields a byte-identical config (minus block ids). Already enforced in `agent-test.js`.

---

### TL;DR

Don't imitate Replit's agent — it's the wrong tool for this job and it needs an API we don't want. Souqi fills a **typed document**, so understanding can be a **Naive Bayes classifier plus rule-based slots** (microseconds, in-repo), content can be a **curated multilingual copy grammar** that echoes the user's own words (better writing than a cheap model, zero cost), and design can be a **deterministic OKLCH palette engine with enforced AA contrast** (a guarantee no model can give). That produces a real, accessible, industry-specific storefront **in under half a second, for free, offline, in three languages, wired to actual inventory** — and it lands in a click-to-edit editor. A local model can polish strings afterwards if we ever want it, but nothing depends on it.
