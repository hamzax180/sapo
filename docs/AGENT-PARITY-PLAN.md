# Souqi Agent — Replit-Parity Plan

> **The ask:** make it *function* like Replit — everything connected, everything real.
>
> **The honest diagnosis:** the pipeline works and the security model is solid, but the product is **amnesiac**. Every build starts from nothing, forgets itself on reload, has no address you can return to, and can only rebuild — never edit. Replit's magic isn't the model; it's that **a project is a durable thing you keep coming back to.** That is the gap, and this plan closes it.
>
> Companion docs: [NO-API-BUILDER-PLAN.md](NO-API-BUILDER-PLAN.md) (how generation works with no API), [AI-BUILDER-PLAN.md](AI-BUILDER-PLAN.md) (contract + validator), [EDITOR-PLAN.md](EDITOR-PLAN.md) (the editor it hands off to), [ARCHITECTURE-PLAN.md](ARCHITECTURE-PLAN.md) (tenancy + security).

---

## 0. Where we actually are

**Built and tested** (49 agent · 57 NLU · 11 claim · unit · isolation, all green):

| Piece | State |
|---|---|
| `nlu/` classify + slots | ✅ en 89.6% / tr 82.8% / ar 87.5%, 0.19 ms |
| `composer.js` archetypes + copy + palette + products | ✅ 8 structures, 21/24 headlines, 12 accents across 24 prompts |
| `design/palette.js` | ✅ 24/24 palettes pass WCAG AA, all 360° of hue |
| `site-validate.js` | ✅ the single trust boundary, hostile-input suite |
| `POST /api/agent/build` → draft | ✅ anonymous, rate-limited, 7-day TTL |
| `POST /api/agent/claim` → workspace | ✅ 401/403/404 proven against real Mongo |
| `/home` → `/agent` transcript | ✅ but see below |

**The seven things that make it feel unfinished:**

| # | Gap | What the user experiences |
|---|---|---|
| 1 | **No project.** A build is a sessionStorage string. | Reload `/agent` and it rebuilds from scratch. No URL to share or return to. |
| 2 | **No memory.** The transcript is DOM only. | Every message is turn one. The agent can't refer to what it just did. |
| 3 | **No preview.** A card with page-name chips. | You are told what was built. You never *see* it. |
| 4 | **Rebuild, not edit.** Follow-ups re-run the whole pipeline. | "Make the hero darker" throws away your other changes. |
| 5 | **No history.** No snapshots, no undo. | Nothing to go back to when a change is wrong. |
| 6 | **Fake staging.** `setTimeout` between stages. | It *looks* like work; it isn't. Slow builds will lie the other way. |
| 7 | **Claim is a cliff.** Signup is a 12-field form. | The moment of highest intent meets the highest friction. |

Everything below exists to kill those seven.

---

## 1. The one idea

> **A Project is the durable object. Everything else hangs off it.**

Today: `prompt → draft → (claim) → workspace`. A draft is a dead end that expires.

Target: `prompt → **Project** → revisions → (claim) → workspace`, where the Project has a URL, a transcript, a history, and an owner that starts as *nobody* and becomes *you*.

```
                    ┌──────────── Project (pr_…) ────────────┐
  /home  ─prompt─▶  │  slug · title · owner?(null→user)      │
                    │  ├── Turn[]      the conversation      │
                    │  ├── Revision[]  every config version  │
                    │  └── head        the current config    │
                    └───────────────┬────────────────────────┘
                                    │ claim (signup / login)
                                    ▼
                          Workspace (ws_…) ──▶ portal + live editor
```

**Anonymous ownership** is a signed, http-only cookie (`sq_anon`, 30 days). It is the thing that lets someone close the tab, come back tomorrow, and still find their site — without an account. Claiming re-points the project's owner from the anon id to a real user; nothing is copied, nothing is lost.

---

## 2. Data model

```jsonc
// projects
{
  "id": "pr_8kQ2vX",
  "slug": "kahve-co",                 // from the business name; unique per owner
  "title": "Kahve Co",
  "ownerAnonId": "an_9dK…",           // set at creation
  "ownerUserId": null,                 // set at claim; anon id retained for audit
  "wsId": null,                        // set at claim
  "headRevision": "rv_04",
  "meta": { "industry": "restaurant", "city": "Istanbul", "tone": "warm", … },
  "createdAt": "…", "updatedAt": "…",
  "expiresAt": "…"                     // TTL only while unclaimed
}

// turns  (the conversation, in order)
{ "id": "tn_07", "projectId": "pr_8kQ2vX", "role": "user|agent",
  "kind": "text|thinking|result|question|error",
  "body": "make it darker",
  "ops": [ … ],                        // what this turn changed
  "revisionId": "rv_04",               // the config after this turn
  "ms": 812, "at": "…" }

// revisions  (immutable; a checkpoint you can restore)
{ "id": "rv_04", "projectId": "pr_8kQ2vX", "parentId": "rv_03",
  "config": { … },                     // full validated config
  "label": "Darker palette", "at": "…" }
```

Full configs per revision, not diffs. A site config is a few hundred KB at most; storing whole ones makes restore trivial and removes an entire class of bug. Cap at 50 revisions per project, then compact the oldest.

---

## 3. The endpoint map

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/projects` | anon cookie | Create a project from a prompt. Returns `{ projectId, slug }` immediately, before the build. |
| `GET` | `/api/projects` | anon cookie / user | List *my* projects — the thing that makes returning possible. |
| `GET` | `/api/projects/:id` | owner | Project + turns + head config. This is what `/agent/:slug` loads. |
| `POST` | `/api/projects/:id/turns` | owner | Send a message. **SSE stream** of real stage events (§5). |
| `POST` | `/api/projects/:id/restore` | owner | Roll back to a revision. Appends a turn; never destroys history. |
| `PATCH` | `/api/projects/:id` | owner | Rename / retitle. |
| `DELETE` | `/api/projects/:id` | owner | Remove it, properly. |
| `POST` | `/api/projects/:id/claim` | user JWT | anon → user, mint workspace, publish, return edit token. *(generalises today's `/api/agent/claim`)* |
| `GET` | `/api/projects/:id/preview` | owner | Standalone HTML render of head, for the preview iframe. |

Everything keeps the existing guarantees: `site-validate.js` on every write, per-IP limiter on create, ownership checked on every read *and* write.

---

## 4. Edit, don't rebuild

The single biggest quality jump. A follow-up must **patch the head revision**, not re-run generation.

### 4.1 The op vocabulary (closed, six ops)

```jsonc
{ "op": "setProp",     "page": "main", "block": "b_h1", "path": "title", "value": "…" }
{ "op": "addBlock",    "page": "main", "at": 2, "block": { "type": "steps", "props": {…} } }
{ "op": "removeBlock", "page": "main", "block": "b_x9" }
{ "op": "moveBlock",   "page": "main", "block": "b_t3", "to": 1 }
{ "op": "setTheme",    "path": "accentColor", "value": "#123456" }
{ "op": "addPage",     "slug": "menu", "title": "Menu", "blocks": [ … ] }
```

Applied to head → new revision → validated → stored. One turn = one revision = **one undo step**.

### 4.2 Understanding the request — no model needed

`lib/refine/grammar.js`, built on the NLU stack already shipped:

| The user says | Op |
|---|---|
| darker / lighter / warmer / bolder / more muted | `setTheme accentColor` via `palette.shift()` |
| use green / make it navy | `setTheme` from the colour lexicon |
| add a menu page / contact page | `addPage` (archetype-seeded) |
| add testimonials / a gallery / stats | `addBlock` (feature→block map, already in `archetypes.json`) |
| remove the banner / drop the stats | `removeBlock` |
| move testimonials up / hero to the top | `moveBlock` |
| change the headline to "X" / call it "X" | `setProp` (+ rename the project) |
| longer / shorter / friendlier copy | re-pick from the copy corpus with a new tone |

**Coverage target: 80% of real follow-ups.** The other 20% get an honest reply naming what the agent *can* do, plus suggestion chips — never a silent failure, never a hallucinated "done!".

### 4.3 Rebuild is still available
"Start over" / "completely different" → full pipeline, as a new revision. The old one is still in history.

---

## 5. Real streaming

Replace `setTimeout` theatre with Server-Sent Events on `POST /turns`:

```
event: stage   data: {"id":"understand","label":"Reading your prompt"}
event: stage   data: {"id":"understand","state":"done","detail":"restaurant · Istanbul · warm"}
event: stage   data: {"id":"structure","label":"Choosing your sections"}
event: stage   data: {"id":"structure","state":"done","detail":"catalogue-led · 7 sections"}
event: patch   data: {"ops":[…],"revisionId":"rv_05"}
event: message data: {"body":"Done — 11 sections across 3 pages."}
event: done    data: {"ms":180}
```

Two things fall out of this for free:

- **Honesty.** A stage is `done` when it *is* done. If a build takes 4 s the UI shows 4 s; if it takes 180 ms it shows 180 ms. Today's fixed 1.7 s wait is a lie in both directions.
- **Progressive preview.** The `patch` event lets the preview iframe update mid-build, so the site assembles in front of you — the thing that actually feels like magic.

Fallback: if `EventSource` is unavailable, the same endpoint answers a normal JSON POST.

---

## 6. The screen

Replit's layout is **conversation left, thing-you-made right**. That is the single most important visual change.

```
┌─ Kahve Co ▾ ─────────────────────── Share · Publish ─┐
│                          │                            │
│  transcript              │   ⟦ live preview ⟧          │
│  (what exists today)     │   iframe → generic-renderer │
│                          │   [ 🖥 ▏📱 ▏🕐 history ]     │
│                          │                            │
│  ┌────────────────────┐  │                            │
│  │ Message Agent…     │  │                            │
│  └────────────────────┘  │                            │
└──────────────────────────┴────────────────────────────┘
```

- **Preview is the real renderer.** `generic-renderer.js` in an iframe, same code the published storefront runs — so preview == published by construction, not by discipline.
- **Device toggle** at true widths (1280 / 834 / 390), reusing [EDITOR-PLAN.md](EDITOR-PLAN.md) §3.
- **History drawer** lists revisions with their labels; click to restore.
- **Below 900px** it becomes tabs (Chat ▏Preview), because a split pane on a phone is two bad panes.
- **`Open in editor`** hands the head config to the live editor — the agent for structure, the editor for pixels.

---

## 7. Claim without the cliff

Today: `Claim this site →` lands on a 12-field signup. That is the worst possible moment for friction.

**Micro-claim:** email + password only. Everything else (industry, country, database, employees) is already known or has a sane default — the agent extracted the industry, the city implies the country, and the database is `local` until told otherwise. Two fields, one button.

The full signup form stays for people who arrive at `/signup` directly.

**Order of operations matters:** create the account → create the workspace → claim → *then* redirect. A failure at any step leaves the project intact and says so, rather than losing the work someone just watched being made.

---

## 8. Phases

Ordered so each one ships something usable, and so the riskiest thing (persistence) is proven first.

| # | Phase | Work | You can then… |
|---|---|---|---|
| **1** | ✅ **Projects & memory** | `projects`/`turns`/`revisions` collections, `sq_anon` signed cookie, `POST/GET /api/projects`, `/agent/:slug` loads from the server | …close the tab and come back to your site. Kills gaps 1 + 2. **Proven: 15 assertions in `project-test.js` against a real Mongo, incl. cross-owner isolation and claim ownership transfer.** |
| **2** | ✅ **Real streaming** | SSE on `POST /api/projects` and `/turns` (negotiated by `Accept`, plain JSON unaffected), real `stage` events from the actual pipeline (`understand`/`structure`/`write`), `setTimeout` staging deleted from the client | …see true progress — a stage settles when the work it names has ACTUALLY finished. Kills gap 6. **Proven: 10 assertions in `sse-test.js`, incl. that "write done"'s block count matches the real config and a vague prompt streams only `understand` before asking, never fakes the rest.** |
| **3** | ✅ **Live preview** | Split layout (conversation left, preview right; tabs below 900px), `GET /api/projects/:key/preview` (owner-gated, same shape as `/api/portal/:wsId/config`), `portal.html`/`portal.js` render it via a `?project=` branch — the SAME `generic-renderer.js` the published storefront runs, device toggle (1280/834/390) | …*watch* your site being built. Kills gap 3. **Verified live: the iframe genuinely renders "Kahve Co, since the first cup", updates to a new revision after a follow-up (`rv=` in the URL changes, content changes), and survives a reload.** Progressive `patch`-level updates (vs. a full re-render per revision) fold into Phase 4, once patch ops exist to progress toward. |
| **4** | ✅ **Edit, don't rebuild** | `refine/grammar.js` (the 6 ops, ~50 phrasings, config-aware so it only acts on sections that actually exist), `refine/apply.js` (pure, re-validated through the same trust boundary), `palette.shift()`, `POST /turns` tries a patch first and only falls back to a full rebuild on no match | …say "make it darker" and have it mean it — one turn, one new revision, everything else untouched. Kills gap 4. **Proven: 21 tests (`refine-test.js`), incl. a real 3-patch chain against a live server producing 4 distinct revisions with nothing overwritten, a repeated no-op creating zero phantom revisions, and an unmatched request still falling back to a full rebuild rather than failing.** Found and fixed a real latent bug along the way: the validator's repair pass silently stamped empty-string color defaults into stored configs, which then read as "newly invalid" on every subsequent re-validation — exactly the kind of noise a patch-heavy workflow would have hit constantly. |
| **5** | ✅ **History** | The preview bar's 🕐 button opens a dropdown of every revision (newest first, relative timestamps, current one marked), each with a Restore button; restore re-fetches and replays the whole transcript rather than DOM-patching. Backend was already there since Phase 1 (`listRevisions`, `POST /restore`, 50-revision compaction) — this phase is the UI that finally exposes it | …undo. Kills gap 5. **Verified live: 2 patches → 3 revisions listed correctly; restoring to "First build" reverted the accent AND removed the testimonials block added by a later patch, while creating a 4th revision (restore appends, never rewinds) — confirmed by re-opening the panel and seeing all 4 entries with the new one marked current.** Fixed a real polish bug caught in that same pass: the restore label leaked a raw internal id ("Restored rv_wvkNLnLa2pU") to the end user; now shows "Restored: First build". |
| **6** | **Micro-claim** | Two-field signup, project→workspace, edit token hand-off | …own it in ten seconds. Kills gap 7. |
| **7** | **Polish & proof** | Project list page, rename, delete, share link, `Publish` button, TR/AR copy corpora, logo→palette | …use it as an actual product. |

**Critical path: 1 → 2 → 3 → 4.** Phase 1 is the keystone — nothing else is worth much without it. Phases 5–7 are additive.

---

## 9. How it all connects (the whole loop)

```
  /home                /agent/:slug                     /portal/:wsId
  ─────                ────────────                     ─────────────
  prompt ──▶ POST /api/projects ──▶ project (anon cookie)
                    │
                    ├─ SSE /turns ─▶ nlu ─▶ composer ─▶ validate ─▶ revision
                    │                                        │
                    │                              preview iframe ◀┘
                    │                            (generic-renderer)
                    │
             follow-up ─▶ grammar ─▶ ops ─▶ apply to head ─▶ validate ─▶ revision
                    │
                    └─ claim ─▶ user + workspace ─▶ storefrontConfig ─▶ edit token
                                                            │
                                          live editor ◀─────┴─────▶ public storefront
```

Every arrow already exists or is specified above. Three invariants hold across all of them:

1. **Nothing reaches a page without `site-validate.js`.** One trust boundary, no exceptions, including restore and patch.
2. **Every mutation is a revision.** Nothing is edited in place, so nothing is unrecoverable.
3. **Ownership is checked on every read and write** — anon or user, same check.

---

## 10. How we'll know it worked

| Metric | Today | Target |
|---|---|---|
| Return rate — projects opened again ≥1 h later | **0%** (impossible) | > 35% |
| Follow-ups handled as a patch, not a rebuild | 0% | > 80% |
| Time to first visible section | ~1.7 s (fake) | < 400 ms (real) |
| Edits in the visual editor before publish | unmeasured | falling, quarter on quarter |
| Claim conversion, build → owned workspace | unmeasured | > 25% |
| Palettes passing AA | 100% | 100% (never regress) |
| Prompts answered with "I can't do that" honestly | n/a | 100% of the unsupported 20% |

---

## 11. What this plan deliberately does not do

- **No model API.** Nothing here needs one. If one is ever added it slots in behind the same validator ([NO-API-BUILDER-PLAN.md](NO-API-BUILDER-PLAN.md) §7).
- **No general app building.** Souqi builds business sites. Asked for a 3D maze game, the right answer is to say so.
- **No rewrite of the live editor.** The agent hands off to it; [EDITOR-PLAN.md](EDITOR-PLAN.md) covers its own work.

---

### TL;DR

The generation pipeline is done and honest; the **product around it is amnesiac**. Introduce a **Project** as the durable object — with an anonymous signed-cookie owner, a persisted transcript, and immutable revisions — then give it **real SSE staging**, a **live preview of the actual renderer**, and **six patch ops** so follow-ups edit instead of rebuild. Finish with **history/restore** and a **two-field claim**. Phase 1 is the keystone: the moment a build survives a page reload and has a URL, everything else becomes worth building.
