# Agent — gap audit after Phase 6

*Audited 2026-08-05, against `claude/website-improvement-plan-alumek` with Phases 1–6 of [AGENT-PARITY-PLAN.md](AGENT-PARITY-PLAN.md) landed and green (49 agent · 57 NLU · 21 refine · 15 project · 11 claim · 10 SSE · 11 micro-claim · unit · isolation).*

The seven gaps that plan set out to kill are dead. This audit is about what the
plan didn't know it would create, plus what it filed under "polish" that turns
out not to be polish at all.

Everything below was verified by reading the code paths, not inferred from the
plan document.

---

## 0. The finding that matters most

> **Claiming a site is currently the worst thing a visitor can do to it.**

Phase 6 made claiming take ten seconds. It also — silently — made the claimed
project unreachable, un-editable, and permanently divorced from the site it
published. Every one of those is a direct consequence of claim *succeeding*.

The moment of highest intent still meets a cliff. We moved the cliff; we didn't
remove it.

---

## 1. P0 — broken right now

### 1.1 Your own project 404s one minute after you claim it

`agent.html` never sends an `Authorization` header — the only mention of
`sap_token` in the whole file is the `localStorage.setItem` that Phase 6 added
([agent.html:692](../public/agent.html)). So every agent-page fetch arrives with
an anonymous cookie and nothing else.

`GET /api/projects/:key` gates on `projects.owns()`
([index.js:1290](../server/index.js)), and `owns()` is asymmetric **by design**:

```js
if (project.ownerUserId) return !!owner.userId && project.ownerUserId === owner.userId;
return !!owner.anonId && project.ownerAnonId === owner.anonId;
```

Once claimed, `ownerUserId` is set, so the anon cookie stops being an answer.
`owner.userId` is `null` because no token was sent. **403.**

`boot()` treats any non-`ok` response as gone, and prints:

> That project isn't here — it may have expired, or the link is wrong.

That is what a user sees when they revisit the site they just paid attention to.
The `replay()` branch written for exactly this case
([agent.html:947](../public/agent.html), *"This site is already published…"*) is
unreachable — the fetch fails before replay is ever called.

**Fix:** attach the bearer token from `localStorage` on agent-page fetches.
`anon.ownerOf()` already prefers the user over the cookie, so nothing
server-side changes. One helper, every `fetch` in `agent.html`.

### 1.2 The conversation dies at claim

Same root cause, worse consequence. `POST /api/projects/:key/turns` runs the
same ownership check, so after claim **every follow-up 403s**. The composer is
still on screen, still enabled, still inviting.

We spent Phase 4 building six patch ops so that "make it darker" edits instead
of rebuilds, and Phase 5 building revision history — then switch both off at the
exact moment someone becomes a customer. Replit's agent doesn't stop being your
agent when you upgrade.

**Fix:** falls out of 1.1 for free. Worth its own test, because it is the
behaviour with the most product value.

### 1.3 ✅ The published site and the project diverge, permanently, in both directions

**Fixed** — went with **(b), reframed once "what does Replit actually do" was checked
concretely.** Replit isn't "project owns it" *or* "explicit publish" — it's both,
on two independent axes: one filesystem is the truth (no second copy exists to
diverge from), and Deploy is a separate, explicit, frozen snapshot. Reading
`live-editor.js` showed it already had half of that shape: a `draftConfig`
working tree with dirty-tracking, and a `publishConfig()` that writes
`storefrontConfig` as a frozen deploy target. The bug wasn't the shape — it was
that the **agent's revisions were a second, disconnected working tree with no
deploy step of its own.**

Built: `publishRevisionToWorkspace()` extracted as the one function that moves
a revision into `storefrontConfig` (`server/index.js`) — `finalizeClaim()` now
calls it for the automatic first publish at claim time, and a new
`POST /api/projects/:key/publish` calls it for every publish after. A
`publishedRevisionId` field on the project ([projects.js](../server/lib/projects.js))
is the durable record of what's actually live. The agent page now carries a
persistent Publish control next to the preview (not a chat message — state,
not narration): **"Published"** (disabled, green) when the head matches what's
live, **"Publish (N changes)"** (clickable) when it doesn't.

**Verified live, not just unit-tested:** claimed a project (auto-published),
confirmed the bar read "Published"; sent a follow-up ("make it darker"),
confirmed the bar switched to "Publish" *and* — checked directly against
`/api/portal/<wsId>/config` — the live site's accent color had **not** changed
(`#18a5de`, unchanged); clicked Publish, confirmed the live accent **did**
change (`#1b81ad`) and the bar returned to "Published"; reloaded the page,
confirmed both the bar state and the "2 changes" counter (after two more
unpublished follow-ups) persisted correctly from a fresh server round-trip,
not client memory. Backend: 6 new assertions in `project-test.js`, including
the one that matters most — a follow-up on a claimed project creates a new
revision but **provably does not** touch `workspaces.storefrontConfig` until
`/publish` is called, and `projects.owns()`'s asymmetric-ownership property
(established in Phase 6) holds here too: the anon cookie alone gets 403 on
`/publish` post-claim, same as it does on every other post-claim endpoint.

Also fixed in passing: `renderCard()`'s rebuild-fallback path (an unmatched
follow-up that falls back to a full rebuild — `refine/grammar.js`'s documented
behavior) hardcoded `claimed: false`, which would have re-shown the claim form
on an already-claimed, already-live project the first time a follow-up missed
the patch grammar. Now reads the page's own tracked claim state instead of
guessing.

**Original finding, for the record:** `finalizeClaim()` copied the head
revision into `workspaces.storefrontConfig` **once**, and never again:

| Surface | Writes to | Never touches |
|---|---|---|
| Agent follow-ups | `revisions` (new head) | `workspaces.storefrontConfig` |
| Visual editor Publish | `workspaces.storefrontConfig` via `/api/storefront/config` | `revisions` |

Two stores, one site, no sync in either direction, and no `Publish` control on
the agent side at all. Whichever surface you touched last is the one whose work
is invisible — and nothing tells you. A user who claims, opens the editor,
tweaks a headline, then goes back and asks the agent for one more change has
just lost the headline, or the change, depending on which page they reload.

**Still open, deliberately not done here:** the editor's `draftConfig` still
starts ephemeral rather than loading from the project's head revision, and
editor Publish still doesn't append a project revision — so an editor edit
doesn't show up in the agent's history panel, and the agent's next follow-up
can still clobber it rather than patching on top. That's the "one filesystem"
half of the Replit shape; today's fix is the "explicit deploy" half. Worth
doing, not urgent the way silent data loss was — the two surfaces no longer
lose work, they just don't yet share a working tree.

---

## 2. P1 — you cannot find your own work

### 2.1 There is no project list

`GET /api/projects` was built in Phase 1, returns the owner's projects sorted by
`updatedAt`, is tested in `project-test.js` — and has **zero UI consumers**. The
only `"/api/projects"` reference in `public/` is the `POST` that creates one.

The only route back to a build is having saved its URL. The plan's headline
success metric is *"Return rate — projects opened again ≥ 1 h later: > 35%"*
([§10](AGENT-PARITY-PLAN.md)). We built the durable object, the anonymous
30-day cookie, and the slug URLs that make returning possible, then shipped no
door.

**Fix:** a `/projects` page — cards with title, relative time, "claimed" badge,
opening `/agent/<slug>`. The endpoint is done; this is a template.

### 2.2 No rename, no delete, no share link

Titles come from whatever the composer extracted (`meta.company`), and are
permanent. `DELETE /api/projects/:key` exists and is unreachable from any UI.
"Share" is the browser address bar plus an explanation of what a slug is.

---

## 3. P2 — the last mile of work already paid for

### 3.1 Turkish and Arabic prompts produce English sites

The pipeline classifies Turkish at **82.8%** and Arabic at **87.5%**, extracts
slots per-language, and threads `lang` all the way into the copy engine. Which
then does this ([copy/engine.js:20](../server/lib/copy/engine.js)):

```js
const CORPUS = { en: require("../../../data/copy/en.json") };
…
const byLang = CORPUS[ctx.lang] || CORPUS.en;
```

`data/copy/` contains exactly one file: `en.json`. So a Turkish prompt is
understood in Turkish and answered in English, on a platform whose signup
defaults `country = TR` and which ships full TR/AR UI translations.

The classifier investment is stranded one file short of paying off. This is
listed under "polish" in the phase table; it is closer to the product's whole
premise in this market.

### 3.2 Logo → palette is unbuilt

Signup accepts a logo. The agent never sees one, and `palette.js` — which
already handles arbitrary seed colours at AA across all 360° of hue — is never
asked to start from a brand.

---

## 4. P3 — dead weight and unmeasured claims

### 4.1 The entire draft path is now dead code

`POST /api/agent/build`, `POST /api/agent/claim`, `GET /api/agent/draft/:id`,
the `agent_drafts` collection, the `draftMemory` fallback `Map`, and the 7-day
TTL logic have **no remaining client callers** — Phase 6 moved `signup.html` to
the project endpoints and it was the last one. The only thing exercising ~150
lines of server code plus a Mongo collection is `claim-test.js`, testing a
feature no user can reach.

**Fix:** delete the routes and the collection; retire `claim-test.js` (its real
coverage — "knowing an id authorises nothing" — is already carried by
`project-test.js` and `microclaim-test.js`). Removing a trust boundary nobody
uses is a security win as much as a tidiness one.

### 4.2 None of the success metrics are instrumented

[§10](AGENT-PARITY-PLAN.md) sets seven targets. Six of them have no counter
anywhere in the codebase — including *"Follow-ups handled as a patch, not a
rebuild: > 80%"*, which is the single number that says whether Phase 4 worked.
`attemptPatch()` already knows the answer on every call; it just doesn't write
it down.

**Fix:** count patch-vs-rebuild, claim conversion, and return-visits into the
existing audit collection. Cheap, and it converts the plan's targets from
aspirations into something we can be wrong about.

---

## 5. Proposed order

Ordered by *user harm per hour of work*, not by section number above.

| # | Work | Kills | Verified by |
|---|---|---|---|
| **A** | Bearer token on all agent-page fetches | 1.1 + 1.2 — project reachable and editable after claim | Extend `microclaim-test.js`: claim, then GET + follow-up with the returned token → 200, new revision. Live: claim → reload `/agent/<slug>` → transcript replays |
| **B** | Publish/sync decision + build (recommend **(a)**) | 1.3 — the divergence | New test: claim → agent follow-up → portal serves the new version. Editor save → agent history shows it |
| **C** | `/projects` list page | 2.1 — the return path the whole plan depends on | Live: build two projects, close tab, land on `/projects`, open the older one |
| **D** | TR corpus (`data/copy/tr.json`), then AR | 3.1 — the market we default to | Extend `agent-test.js`: a Turkish prompt yields Turkish headlines; AA + distinctness assertions hold per-language |
| **E** | Delete the draft path, retire `claim-test.js` | 4.1 — dead surface area | Full suite green with the routes gone |
| **F** | Rename / delete / share; metrics counters | 2.2 + 4.2 | Suite + a metrics read-back assertion |
| **G** | Logo → palette | 3.2 | AA must hold for logo-derived seeds — `palette.js` already proves this shape |

**A and B are the two that matter.** A is small and stops the worst break; B is
the last real architectural debt in the agent. C through G are the difference
between a demo that impresses and a product someone comes back to on Tuesday.

---

### TL;DR

Phases 1–6 killed all seven original gaps. Claiming, the thing Phase 6 made
easy, now quietly breaks the three things that made the agent worth claiming:
the project becomes unreachable (**no auth header on agent fetches**), the
conversation stops (**same cause**), and the published site permanently
diverges from the project (**claim copies once, nothing syncs**). Fix the auth
header first — it is one helper and it restores two features. Then decide
whether the project or the workspace owns the truth, and make it so. Everything
else is reachable work on top of a pipeline that is already honest.
