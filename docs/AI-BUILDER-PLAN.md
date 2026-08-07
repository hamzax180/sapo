# Souqi — Replit-style Home + "Build by Prompting" AI Agent

> **Goal:** replace the marketing/login landing with a **prompt-first home page** (the Replit `What will you build?` model), and put a real **AI site-builder agent** behind that prompt box: type a sentence → watch a working Souqi storefront assemble itself → sign up to claim it → keep editing it in the live editor.
>
> Grounded in the current code: `public/login.html` (2,188 lines — today's root page), `public/js/portals/blocks.js` (20 block types), `generic-renderer.js`, `config-migrate.js` (storefrontConfig **v2**), `server/index.js` (`/ai/chat` Gemini proxy, `/api/ws`, `/api/storefront/config`, edit tokens).
>
> Companion docs: [ARCHITECTURE-PLAN.md](ARCHITECTURE-PLAN.md) (security/tenancy), [EDITOR-PLAN.md](EDITOR-PLAN.md) (the editor the agent hands off to).
>
> **⚠️ Superseded in part:** §3.2–3.4 assume a hosted model API. [NO-API-BUILDER-PLAN.md](NO-API-BUILDER-PLAN.md) replaces that pipeline with a deterministic one that needs no API at all. The contract (§3.1), the validator (§3.6), the draft/claim flow (§3.3, §4) and the phasing here all still stand.

---

## 0. Where we are today (current-state findings)

| # | Finding | Evidence |
|---|---------|----------|
| 1 | **The root page is a login page.** `/` serves `login.html` — a marketing hero *plus* a sign-in card. The first thing a visitor is asked to do is authenticate, not build. | `server/index.js:67`, `login.html:1413` `.chero` + `#cheroAuth` |
| 2 | **The "build" promise is a canned animation.** The hero already says *"Build your website. Edit it live."* and plays a scripted fake-build demo (`#cdemo`, `siteTitle`, `siteGrid`). Nothing the visitor types drives it. | `login.html:1437-1460` |
| 3 | **There is no generation endpoint.** The only AI surface is `POST /ai/chat` — a thin Gemini text proxy used by the Finance assistant. No structured output, no schema, no validation. | `server/index.js:885`, `public/js/ai.js` |
| 4 | **But the hard part is already built.** A block registry with 20 typed blocks, JSON schemas per block, a single `render()` source of truth, a page/blocks config format, a renderer, and a live editor. **An agent only has to emit valid JSON — not HTML, not code.** | `blocks.js`, `generic-renderer.js` |
| 5 | **Workspace creation is already a one-POST flow.** `POST /api/ws` then `POST /api/storefront/config` then mint an edit token. The agent can reuse it verbatim. | `server/index.js:424, 556, 586` |
| 6 | **No anonymous path.** Everything workspace-shaped requires an owner JWT, so "your first prompt is free" needs a new, deliberately narrow draft lane. | `assertOwnsWorkspace` on every `/api/ws*` |

**North star:** a visitor lands on `souqi.site`, types *"a storefront for my Istanbul coffee roastery with online ordering"*, and within ~15 seconds is looking at a real, rendered Souqi storefront — hero, product grid, story section, footer — that they can refine with a second sentence, then claim with an email.

---

## 1. Principles

1. **The prompt box is the product.** It is the first and largest thing on the page; everything else is proof.
2. **The agent emits data, never code.** Output is `storefrontConfig` v2 JSON validated against the block registry. No model-authored HTML/JS ever reaches a page. This is the whole security story.
3. **Show work while it happens.** Streamed, staged progress (plan → sections → copy → images) reusing the existing build-animation vocabulary — a 15s wait must feel like watching, not loading.
4. **Free first prompt, no account.** Anonymous draft with a TTL; sign-up *claims* it. Never lose what the visitor just made.
5. **Refine, don't regenerate.** Follow-up prompts emit small **patch ops** against the existing config, so iteration is fast, cheap, and non-destructive (and undoable).
6. **Degrade to deterministic.** With no `GEMINI_API_KEY` (local dev, key outage, quota), a template composer still produces a real site from the same prompt. `/build` is never broken.
7. **Hand off, don't replace.** The agent's output opens in the existing live editor — the agent is the *fast start*, the editor is the *fine control*.
8. **Trilingual + RTL from day one.** The page uses the existing `data-t` translation system (en / tr / ar) like every other Souqi page; Arabic flips to RTL but the composer stays LTR-safe.

---

## 2. Part A — the new home page

### 2.1 Routing decision

| Path | Today | Target |
|------|-------|--------|
| `/` | `login.html` (marketing + sign-in) | **`build.html`** — prompt-first home |
| `/build` | — | `build.html` (canonical) |
| `/login` | `login.html` | `login.html`, trimmed to auth + short marketing |
| `/agent/:draftId` | — | `agent.html` — build workspace (chat + live preview) |

New file, **not** a rewrite of `login.html`: that file is 2,188 lines of working marketing, animation, and auth. Root gets repointed (`server/index.js:67` + `vercel.json`), and login keeps its own URL. Zero-framework, single-file, inline `<style>` — same house pattern as every other page here.

### 2.2 Anatomy (mapped to the reference screenshots)

```
┌──────────────────────────────────────────────────────────────┐
│ ◆ Souqi   Platform▾ Solutions▾ Pricing Resources  [Agent ①]  │  sticky, light
│                                    Contact sales  Log in  [Create workspace] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                  What will you build?                        │  clamp(2.6rem,6vw,4.2rem)
│          Your first prompt is free. No card needed.          │
│                                                              │
│   ┌────────────────────────────────────────────────────┐     │
│   │ Describe your business…                            │     │  auto-grow textarea
│   │                                                    │     │  rotating placeholder
│   │ [＋]  [🗂 Storefront ×]                    ( → )    │     │  attach · mode chip · send
│   └────────────────────────────────────────────────────┘     │
│                                                              │
│     ‹  [🖥 Website] [🛍 Storefront] [📇 Catalog]              │  mode rail, scroll-snap
│        [📅 Booking] [📄 Landing]  ›                           │
│                                                              │
│              Try an example prompt  ⟳                        │
│   [Coffee roastery]  [Freight forwarder]  [Salon booking]    │  shuffles on ⟳
│                                                              │
│  ── BUILT FOR ──  Retail · Fashion · Logistics · … (marquee) │
└──────────────────────────────────────────────────────────────┘
  ┌ Is this page worth your time?  Yes  No  × ┐   dismissible, localStorage
```

### 2.2b Below the fold

Five sections, in this order. The visual language is a warm paper surface with **one** bold accent, stadium-radius cards, and an escalating tint ramp (white → stone → tint → solid).

1. **Meet the Souqi Agent** — a 12-column **bento** of four cards, each with an eyebrow, a display-size title and a self-drawn CSS mock (no images):

   | Card | Span | Surface | Radius | Mock |
   |---|---|---|---|---|
   | Design Freely (live editor) | 7 | tint | `300px 26px 26px 300px` | storefront UI: menu bar, store-finder + add-to-cart, two product rows |
   | Move faster (staged builds) | 5 | stone | `26px` | four build-stage rows with progress bars |
   | Ship Anything (one workspace) | 5 | dark | `26px` | three wireframe panels + a bar chart |
   | Build together (roles) | 7 | solid accent | `26px 300px 26px 300px` | overlapping team avatars |

2. **Powered by the Souqi platform** — a four-card row on the tint ramp: *Agent chat · Full-stack infrastructure · Integrations · Control*, each with a CSS/SVG illustration (dashed publish ring, service stack, node graph, shield) and a paragraph pinned to the card foot so all four baselines line up.
3. **Trusted by builders** — 3-column carousel: label card, quote card, and a 2×2 side grid of prev/next buttons + monogram avatars, with dots. **Placeholder copy only** — real quotes need written permission before launch, and monograms stand in for photos rather than shipping invented faces.
4. **What are you waiting for?** — one line, one oversized pill CTA.
5. **Footer** — oversized wordmark + Product / Company / Legal columns + legal strip.

RTL is handled with logical properties plus `[dir="rtl"]` overrides that mirror the two stadium radii, so Arabic doesn't leave the rounded edge on the wrong side.

### 2.3 Composer behaviour (the details that make it feel right)

- **Auto-grow textarea**, 1 → 6 rows, then scrolls. `Enter` submits, `Shift+Enter` newline; on touch, `Enter` = newline and the arrow button submits.
- **Rotating placeholder** cycles every 3.5s while empty and untouched (`Make a storefront for…`, `Build a booking site for…`), pauses on focus. Respects `prefers-reduced-motion`.
- **Send button** is a circular arrow: disabled/greyed at 0 chars → accent gradient at ≥1 char. Once a mode chip is picked, it becomes a labelled **`Start →`** pill (matches screenshot 2).
- **Mode chips** render *inside* the composer with an `×`; picking a mode from the rail moves the checkmark and inserts the chip. Mode is a *hint* to the agent (block palette bias + starting page set), never a hard branch.
- **`＋` attach** (Phase 4): logo upload → becomes `cfg.logo`, brand colour extracted client-side from the image (canvas average + contrast clamp).
- **Example chips** fill the composer with a full prompt and focus it; `⟳` shuffles from a pool of ~15 per language.
- **Nothing blocks on JS**: with JS off, the composer degrades to a plain `<form method="GET" action="/agent">`.

### 2.4 Responsive spec (the mobile screenshots are the acceptance test)

| Breakpoint | Nav | Composer | Mode rail |
|---|---|---|---|
| **≥1024** | full links + Agent badge + Log in / Create | 720px max, 2-line default | all 5 visible, `‹ ›` arrows |
| **600–1023** | links collapse to hamburger, Agent badge stays | full width − 32px | horizontal scroll-snap, no arrows |
| **<600** | brand · Agent badge · ☰ only | full width, 44px min tap targets, sticky above keyboard (`dvh` units) | 4 visible, swipe |

Uses `100dvh`/`svh` (not `vh`) so the iOS keyboard doesn't push the composer off-screen — the single most common failure of this layout on phones.

---

## 3. Part B — the agent

### 3.1 The contract (this is the crux)

The model never writes markup. It fills in a **typed document** whose vocabulary is exactly the block registry:

```jsonc
{
  "version": 2,
  "company": "Kahve Roasters",
  "industry": "retail",
  "theme": { "accent": "#8a5a2b", "ink": "#1c1410", "font": "Jost", "radius": 14 },
  "pages": {
    "main":   { "title": "Home", "slug": "main", "isHome": true, "blocks": [ /* … */ ] },
    "about":  { "title": "About", "slug": "about", "blocks": [ /* … */ ] }
  },
  "navOrder": ["main", "about", "contact"]
}
```

…where every block is:

```jsonc
{ "id": "b_h1", "type": "hero", "props": { "title": "Roasted in *Istanbul*", "subtitle": "…", "align": "center", "buttons": [ … ] } }
```

**Allowed `type` values are exactly the 20 registered blocks** — `topbar, hero, stats, brand-wall, card-grid, editorial-grid, product-grid, calculator, case-studies, partner-grid, rfq-form, quote-banner, footer-rich, richtext, tracker, steps, link-grid, image-banner, slideshow, canvas` — and allowed `props` keys are exactly what each block's `schema` declares. Anything else is dropped by the validator, not by trust.

### 3.2 Feeding the model the schema (no drift)

`blocks.js` is a browser IIFE holding both `schema` and `render`. Rather than duplicating it by hand:

- **`scripts/gen-block-schema.js`** loads `blocks.js` in a minimal `window` shim, walks `PortalBlocks`, and emits **`server/lib/block-schema.json`** (`{ type, label, category, schema, defaultProps }` only — no render functions).
- Runs in `npm run ci`; **fails the build if the committed JSON is stale.** One source of truth stays one source of truth.
- The prompt embeds a *compacted* form (type + one-line purpose + prop names/types), ~1.5–2k tokens, not the full JSON.

### 3.3 Endpoints (new)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/agent/build` | none + strict limiter | prompt → new draft config. Returns `{ draftId, config, notes }`. SSE variant streams stages. |
| `POST` | `/api/agent/refine` | draft token | prompt + current config → **patch ops** (`§3.5`) |
| `GET` | `/api/agent/draft/:id` | draft token | fetch a draft (for reload / share-preview) |
| `POST` | `/api/agent/claim` | owner JWT | draft → real workspace: `POST /api/ws` + `storefrontConfig` + mint edit token |
| `GET` | `/api/agent/quota` | none | remaining free builds for this IP/fingerprint |

Drafts live in a `agent_drafts` master-DB collection: `{ id, config, prompt, ip, createdAt, expiresAt }`, **TTL index 7 days**, size-capped at the existing 12 MB storefront limit. A draft is *not* a workspace: it has no DB, no products, no tenancy — so it can safely exist without an account.

### 3.4 The build pipeline

```
prompt ─▶ ① classify ─▶ ② outline ─▶ ③ fill ─▶ ④ validate ─▶ ⑤ enrich ─▶ draft
         industry+     page list &   block      whitelist +    images,
         mode+lang     block types   props      coerce +       palette,
                                                sanitize       products
```

1. **Classify** (cheap, `maxOutputTokens: 120`): `{ industry, mode, language, company, tone }`. Also the abuse gate — off-topic or abusive prompts stop here.
2. **Outline**: which pages, which block types in which order. Constrained to the registry; capped at **5 pages / 12 blocks per page**.
3. **Fill**: one call per page (parallel) producing props. `responseMimeType: "application/json"` + `responseSchema` (Gemini structured output) so we get JSON, not prose in a fence.
4. **Validate** — `server/lib/site-validate.js`, the trust boundary. See §3.6.
5. **Enrich** (deterministic, no model): pick images from a curated per-industry set (`public/assets/stock/`), derive an accessible palette from the accent (WCAG AA contrast clamp), seed 4–8 demo products for `product-grid`, generate block ids.

**Latency budget:** ①120ms + ②~1.5s + ③~3–6s parallel + ⑤~200ms ≈ **5–8s**, streamed so first paint of the hero happens at ~2s.

**Provider adapter** (`server/lib/ai-provider.js`): `GEMINI` (default, already keyed) | `ANTHROPIC` (`claude-sonnet-5` for fill, `claude-haiku-4-5-20251001` for classify) | `TEMPLATE` (no key). Selected by `AI_PROVIDER` env. Same interface: `generateJson(system, user, schema)`.

### 3.5 Refinement — patch ops, not regeneration

Follow-ups ("make it darker", "add a menu page", "move testimonials up") return an op list, applied client-side and mirrored to the draft:

```jsonc
[ { "op": "setProp",  "page": "main", "block": "b_h1", "path": "title", "value": "…" },
  { "op": "addBlock", "page": "main", "at": 2, "block": { "type": "steps", "props": { … } } },
  { "op": "moveBlock","page": "main", "block": "b_t3", "to": 1 },
  { "op": "removeBlock","page": "main", "block": "b_x9" },
  { "op": "setTheme", "path": "accent", "value": "#123456" },
  { "op": "addPage",  "slug": "menu", "title": "Menu", "blocks": [ … ] } ]
```

Six ops, closed vocabulary, each validated the same way as a full build. Cheap (~1s), diffable, and every applied op batch is **one undo entry** — the same rule EDITOR-PLAN §4 sets for editor gestures.

### 3.6 Validation & safety (`site-validate.js`)

Model output is untrusted input. Every draft passes, in order:

1. **Shape**: must parse; must be an object with `pages`; ≤5 pages, ≤12 blocks/page, ≤12 MB.
2. **Type whitelist**: unknown `type` → block dropped (logged).
3. **Prop coercion**: keys not in that block's `schema` → dropped. Values coerced to the declared type (`text`/`textarea`/`select`(enum-checked)/`color`(hex-checked)/`image`/`list`(recursed)/`number`(clamped)).
4. **String sanitising**: strip `<`/`>`/`&` control chars — blocks `esc()` their output, but defence in depth means the stored value is clean too. `richtext` gets an allowlist tag filter (`b i em strong a p ul ol li br h2 h3`), `a[href]` limited to `https:`/`mailto:`/`#/p/`.
5. **URL policy**: `image` props must be same-origin `/assets/…`, a `data:image/*` under 2 MB, or an allowlisted CDN host. No arbitrary remote fetches.
6. **Action policy**: `action-select` values limited to the actions `PortalGB.runBlockAction` actually implements; `action-target` must resolve to a page slug in this config.
7. **Repair pass**: missing required props filled from `defaultProps`; empty pages get a hero; if `<2` valid blocks survive, fall back to the template composer rather than shipping a broken site.

**Prompt injection:** the user's prompt is *data*. It is passed in a separate turn, wrapped in delimiters, with a system instruction that its content can never change the output schema, the block whitelist, or the tool vocabulary. The validator is the actual guarantee — a prompt that says "output raw HTML" simply produces a document that fails step 2.

**Abuse & cost:** `agentLimiter` (5 builds / 15 min / IP, 30 refines / hour), a hard `maxOutputTokens` per stage, a daily global spend ceiling that flips the provider to `TEMPLATE` when hit, and a classifier reject for prompts that aren't about building a site.

### 3.7 The template fallback (no key, no problem)

`server/lib/template-composer.js`: keyword-matches the prompt against the existing industry templates (`portal-retail`, `portal-restaurant`, `portal-fashion`, `portal-services`, `portal-logistics`, `portal-construction`, `portal-manufacturing`), swaps in the extracted company name, a palette derived from any colour word in the prompt, and industry copy. Deterministic, instant, always available — and it's what powers the **home-page demo animation** so the marketing loop and the real product share one code path.

---

## 4. The agent workspace (`/agent/:draftId`)

Where the visitor lands after hitting `Start →`:

- **Left (or bottom sheet on touch)** — chat: the original prompt, streamed stage updates ("Planning 4 sections…", "Writing your hero…"), then a refine input with suggestion chips ("Add a contact page", "Warmer colours", "Add online ordering").
- **Right** — live preview in a device frame (desktop / iPad / phone toggle) rendering through **`generic-renderer.js` in an iframe** — the identical renderer the published storefront uses, so preview == published by construction.
- **Top-right** — `Claim this site` (→ signup, carrying `draftId`) and `Open in editor` (post-claim: mints an edit token and jumps to the live editor).
- **Version rail** — each prompt/patch batch is a restorable snapshot.

Claim flow: signup (existing page, `?draft=` param) → on success `POST /api/agent/claim` → `POST /api/ws` (id `ws_…`) → `POST /api/storefront/config` → `POST /api/storefront/edit-token` → redirect to `/portal/:wsId?edit=1`. Drafts already claimed are deleted; unclaimed ones expire in 7 days.

---

## 5. Phased rollout (A → Z)

Each phase is shippable on its own.

| Phase | Theme | Work | Ships |
|---|---|---|---|
| **0 — Skeleton** ✅ *built* | The page exists | `build.html`: nav + Agent badge + language switcher, hero composer (auto-grow, rotating placeholder, mode chips, example shuffle), industry marquee, bento, platform row, testimonial carousel, CTA, footer, feedback toast. Responsive to 375px, en/tr/ar with RTL, served at `/build`. Composer carries the prompt into signup. | New home page renders; **root repoint and the template-composer stub are still open** |
| **1 — Contract** ✅ *built* | Machine-readable blocks | `gen-block-schema.js` → `block-schema.json` (20 blocks), `npm run check:schema` in CI; `site-validate.js`; `agent-test.js` — **41 tests, all passing**, incl. hostile fixtures | Trust boundary in place before any model output touches it |
| **2 — Real generation** ◐ *half* | The agent works | ✅ `template-composer.js`, `POST /api/agent/build`, `GET /api/agent/draft/:id`, `agent_drafts` + 7-day TTL (Mongo index, in-memory fallback), `agentLimiter` 8/15min/IP, composer wired with staged progress + result card. ⬜ Still to do: `ai-provider.js` + `agent-pipeline.js` (classify→outline→fill) so output is model-written rather than template-composed | Typing a sentence already produces a real, validated 3-page site; the model swaps in behind the same validator |
| **3 — Workspace + claim** (2–3 d) | Keep what you made | `agent.html`, iframe preview, streamed stages, `/claim` → workspace → edit token → live editor | End-to-end prompt → owned, editable storefront |
| **4 — Refine loop** (2–3 d) | Conversation | `/api/agent/refine`, 6 patch ops, versions/undo, suggestion chips | Iterate in seconds instead of rebuilding |
| **5 — Enrichment** (2 d) | Looks designed | Curated image sets, palette derivation w/ contrast clamp, seeded products, logo upload + colour extraction | Output stops looking generated |
| **6 — Polish & proof** (2–3 d) | Trust | Marquee, "Meet the Agent" section retimed off the real pipeline, feedback toast, analytics funnel (`prompt→build→claim`), SEO/OG, Lighthouse ≥95, full a11y pass | Home page converts |

**Critical path:** 0 → 1 → 2 → 3. Phases 4–6 are additive.

---

## 6. Files

```
public/
  build.html                     # NEW — prompt-first home (root)
  agent.html                     # NEW — chat + live preview workspace
  js/agent/
    composer.js                  # NEW — textarea, modes, placeholder rotation, examples
    build-stream.js              # NEW — SSE consumer + stage UI
    preview.js                   # NEW — iframe host, device frames, postMessage bridge
    patch.js                     # NEW — apply the 6 ops + version stack
  css/agent.css                  # NEW

server/
  index.js                       # +5 routes, +agentLimiter, root → build.html
  lib/
    ai-provider.js               # NEW — Gemini | Anthropic | Template adapter
    agent-pipeline.js            # NEW — classify → outline → fill → enrich
    site-validate.js             # NEW — the trust boundary
    template-composer.js         # NEW — deterministic fallback
    block-schema.json            # GENERATED — do not hand-edit
  agent-test.js                  # NEW — pipeline + validator suite (hostile fixtures)

scripts/gen-block-schema.js      # NEW — blocks.js → block-schema.json
vercel.json                      # root rewrite → /build
```

Touched, not rewritten: `login.html` (stays at `/login`), `signup.html` (accept `?draft=`), `blocks.js` (unchanged — it *is* the schema).

---

## 7. Testing & QA

- **Validator fixtures** (must-pass, in `agent-test.js`): unknown block type, unknown prop, `<script>` in a title, `javascript:` href, 40-block page, 30 MB payload, `""`/`null`/prose-not-JSON model output, prompt-injection strings inside props. Every one must produce a *safe, renderable* config or a clean fallback — never a 500.
- **Golden prompts:** 12 prompts across industries and all 3 languages, snapshotted; a run that drops below 4 blocks or fails validation is a regression.
- **Determinism:** template composer output is byte-stable for a given prompt.
- **Device matrix:** iPhone Safari (keyboard-open composer!), Android Chrome, iPad portrait/landscape, desktop Chrome/Safari/Firefox.
- **Perf:** home LCP < 1.5s, Lighthouse ≥95/100/100/100; first streamed block ≤2.5s p50, full build ≤10s p95.
- **a11y:** composer labelled, mode rail arrow-key navigable, live-region announces stages, focus goes to the preview when the build completes, AA contrast in every generated palette.
- **Isolation:** an anonymous draft can never read or write a real workspace (extends `isolation-test.js`).

---

## 8. Risks & calls

| Risk | Mitigation |
|---|---|
| Generated sites look samey | Enrichment phase (palette, imagery, block-order variation seeded per prompt) + 3 layout archetypes per industry |
| Model cost from anonymous traffic | Staged token caps, per-IP quota, global daily ceiling → auto-fallback to template |
| Gemini structured output drifts | `responseSchema` + validator + repair pass; provider adapter lets us swap models without touching the pipeline |
| 20 blocks can't express every request | Agent states its limits in chat ("I used a card grid for that") and offers the closest block; new block types are additive and the schema regenerates itself |
| Losing today's SEO on `/` | Keep the marketing sections below the fold on `build.html`; 301-free move (same origin), retain `<h1>` semantics, ship OG/JSON-LD |

---

### TL;DR

Build a new prompt-first root page (`build.html`) modelled on Replit's, and put a **schema-constrained agent** behind it: the model fills in a typed `storefrontConfig` v2 document made of the 20 blocks that already exist, a server-side validator drops anything outside that vocabulary, and the result renders through the *same* `generic-renderer.js` the published storefront uses. Anonymous drafts make the first prompt free; claiming one creates the workspace and hands off to the live editor. Phase 0 (page + template composer) ships a working experience before a single model call, and Phase 1 (schema + validator) makes every later phase safe.
