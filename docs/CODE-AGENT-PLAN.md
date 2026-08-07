# Souqi Code — a Replit-style agent on DeepSeek

*Decision recorded 2026-08-05: full code generation, not config generation. This plan supersedes the block-generation option in [AI-PROVIDER-PLAN.md](AI-PROVIDER-PLAN.md) §1 for this product line; that document still governs prose/JSON routing for the existing site builder.*

The model is the easy part. **The sandbox, the feedback loop and the deploy path
are the product.** This plan is ordered accordingly.

---

## 0. The decision, and the hedge that makes it survivable

Souqi Code is a **second product line**, not a replacement. The config pipeline
keeps running:

| | Souqi **Sites** (today) | Souqi **Code** (this plan) |
|---|---|---|
| Output | validated `storefrontConfig` | real files in a repo |
| Editing | visual live editor (2,254 lines) | the agent, or an IDE |
| Serving | 45 ms, a Mongo row | build artifact / container |
| Cost per project | ~free | sandbox seconds + hosting |
| User | shop owner who wants a storefront | someone who wants an app |

**Do not delete the config path to build this.** Two reasons: it is your only
revenue-shaped thing that works today, and it is the fallback when the agent
can't finish — "I couldn't build that app, but here's a working site" is a far
better failure than a broken container. Route by intent at the composer: a
storefront prompt goes to the fast path; "build me a booking app with logins"
goes to Code.

---

## 1. v1 scope — one stack, static output, no database

The single most important decision in this document.

**v1 builds static front-end apps only:** Vite + React + TypeScript, Tailwind,
building to `dist/`. No server runtime, no database, no auth, no secrets.

Why this and not full-stack:

- Static output **deploys to a CDN**. A container per *live* app is the cost
  that kills this business model; a built `dist/` folder is pennies forever.
- Sandboxes then exist **only during a build**, not for the app's lifetime.
  Ten minutes of compute per project instead of 720 hours a month.
- It removes secrets management, DB provisioning, migrations, and the entire
  server-side attack surface from v1.
- It still covers most of what people actually ask for: landing pages,
  dashboards from mock data, calculators, portfolios, menus, booking *UIs*.

One stack, not "whatever the model picks." A fixed stack means a fixed scaffold,
fixed conventions, fixed error signatures — and **the model's success rate goes
up sharply** because it never chooses wrong. Replit supports many stacks; Replit
also has a much larger team and a frontier model.

Backend (API routes + Postgres) is **v2**, gated on v1's success rate being
measured, not assumed.

---

## 2. Architecture

```
       ┌─────────────────────────────────────────────────────┐
 user  │  agent.html (reuse) ── SSE ──▶ orchestrator         │
 ──────▶                                    │                │
       │                                    ▼                │
       │                          ┌──────────────────┐       │
       │                          │  agent loop      │       │
       │                          │  DeepSeek + tools│       │
       │                          └────────┬─────────┘       │
       │                                   │ tool calls      │
       │                                   ▼                 │
       │                        ┌────────────────────┐       │
       │                        │  SANDBOX (per proj)│       │
       │                        │  fs · shell · vite │       │
       │                        │  git · dev server  │       │
       │                        └────────┬───────────┘       │
       └─────────────────────────────────┼───────────────────┘
                                         ▼
                              preview proxy · CDN deploy
```

### The loop

```
scaffold ─▶ plan ─▶ [ write files ─▶ build ─▶ read errors ] ─▶ verify ─▶ commit
                           ▲                        │
                           └──── repair (max N) ────┘
```

Hard caps at every level: **max 25 tool calls, max 6 repair rounds, max 8
minutes wall clock, max $0.40 per build.** When a cap trips, the agent stops and
says what it got working — it does not spin. Uncapped agent loops are how you
get a $900 surprise from a runaway repair cycle.

### The tools

Deliberately small. Every tool is a place the model can fail, so there are seven.

| Tool | Signature | Notes |
|---|---|---|
| `list_files` | `(dir) → string[]` | cheap orientation |
| `read_file` | `(path, fromLine?, toLine?) → string` | **ranged** — never dump a whole file into context by default |
| `write_file` | `(path, content) → ok` | whole-file writes; diffs are where small models fail |
| `edit_file` | `(path, find, replace) → ok` | exact-match only, errors if ambiguous |
| `run` | `(cmd, timeoutMs) → {stdout, stderr, code}` | allowlisted commands only (§9) |
| `build` | `() → {ok, errors[]}` | structured, parsed — not raw text |
| `dom_snapshot` | `(route) → text` | see §4 — this replaces Replit's screenshot |

`write_file` over patches is a considered choice: DeepSeek is markedly more
reliable emitting a whole file than a unified diff, and at these file sizes the
extra output tokens cost less than a failed patch round.

---

## 3. What you already own (this is the advantage)

Do not rebuild these. They map onto Code with almost no change:

| Existing | Reuse |
|---|---|
| `projects.js` — projects/turns/revisions | **Direct.** A revision becomes a git SHA instead of a config blob |
| `anon.js` — anonymous signed-cookie ownership | **Direct.** Build before signup still works |
| SSE staging (`sseOpen`/`sseFrame`, stage events) | **Direct.** Stages become plan/write/build/repair/done |
| `agent.html` split view + transcript + history | **Mostly.** Preview iframe points at the sandbox proxy instead of `/portal` |
| Micro-claim (Phase 6) | **Direct.** Same claim, different artifact |
| `/projects` list, rename, delete | **Direct** |
| NLU classify + slots | **Router.** Decide Sites vs Code, and seed the scaffold |

That is a genuine head start — the durable-object work from
[AGENT-PARITY-PLAN.md](AGENT-PARITY-PLAN.md) Phases 1–6 was stack-agnostic, and
it pays off here.

**Does not carry over:** `generic-renderer.js`, `blocks.js`, `live-editor.js`,
`site-validate.js`, the composer, archetypes, the palette engine. They keep
serving Souqi Sites; they have no role in Code.

---

## 4. The feedback loop — and the DeepSeek constraint

This is where agents succeed or fail, and where your model choice bites.

**Replit screenshots the running app and reacts to what it sees. DeepSeek V3 is
text-only, so you cannot.** Your loop must be entirely textual:

1. **TypeScript / build errors** — structured, parsed to `{file, line, message}`.
   Highest signal; fix these first, always.
2. **Runtime console errors** — headless Chrome in the sandbox loads each route,
   collects `console.error` + uncaught exceptions.
3. **`dom_snapshot`** — the accessibility tree or `innerText` of a rendered
   route. This is your screenshot substitute: it proves the page *rendered* and
   contains the expected content, without vision.
4. **Route assertions** — did every route in the plan return non-empty content?

A blank white page compiles clean. Without (3) and (4), the agent will
confidently report success on a broken app — the single most common failure mode
in this category of product.

If vision genuinely matters later, route *only* that step to a multimodal model
(Gemini Flash is cheap and multimodal) while DeepSeek keeps writing code. The
adapter from [AI-PROVIDER-PLAN.md](AI-PROVIDER-PLAN.md) §3 already makes that a
routing entry, not a rewrite.

---

## 5. The sandbox

**Start managed. Self-host only when volume justifies it.**

| Option | Isolation | Verdict |
|---|---|---|
| Plain Docker on your box | shared kernel | **No.** Untrusted code from strangers; a kernel escape is your whole platform |
| **E2B / Daytona / Modal** (managed) | Firecracker-class | **Start here.** API-driven, per-second billing, built for exactly this |
| Self-hosted Firecracker | strong | v2, when sandbox spend > ops cost |

Managed also solves a problem you have today: your dev machine is an i3 with
8 GB and no GPU. You cannot comfortably run an orchestrator plus containers plus
a browser locally. With a managed provider you develop against the same
infrastructure you ship on, from day one.

**Lifecycle discipline — this is the cost control:**

- Sandbox is created **on demand**, not on project open.
- Hibernate after **90 seconds idle**. Resume on next message.
- Hard-kill at **8 minutes** of continuous run.
- The filesystem is snapshotted to object storage on every checkpoint, so a
  killed sandbox loses nothing.

Idle sandboxes are the #1 way this product loses money. Treat them like open
database connections.

---

## 6. Checkpoints and rollback

`git init` in the sandbox at scaffold. **One commit per agent turn.** A revision
row in `projects.js` stores the SHA plus the file-tree snapshot pointer.

Rollback is `git checkout <sha>` and re-snapshot — and, exactly as in
[AGENT-PARITY-PLAN.md](AGENT-PARITY-PLAN.md) Phase 5, **restore appends a new
revision rather than rewinding history.** That behaviour is already built,
already tested, and already correct; keep it.

---

## 7. Preview and deploy

**Preview: ✅ built and live-verified**, ahead of schedule — a real user's
browser hitting Daytona's raw `*.daytonaproxy01.eu` domain directly in an
iframe got silently blocked ("This content is blocked. Contact the site
owner to fix the issue.") by local security software treating an unfamiliar
domain as suspicious. Same-origin content the visitor is already using isn't
unfamiliar to anything, so `GET /api/codeagent/preview/:key(/*)` in
`index.js` is a same-origin reverse proxy: fetches the sandbox's signed
Daytona URL **server-side**, streams the response back under Souqi's own
origin, owner-gated exactly like every other project read. Two side benefits
that weren't the point but are real: the signed URL never reaches the
browser at all now (nothing to leak from inspecting the iframe src), and
because the iframe is finally same-origin, its DOM became directly
inspectable from the parent page for the first time — verification that was
previously impossible (cross-origin) is now a one-liner.

**Found a second real bug getting there:** a `<base href="...">` tag was the
first attempt at fixing the resulting path prefix — it does nothing for
root-relative URLs (`/assets/x.js`), which is exactly what Vite's default
build emits, so every asset 404'd against the bare origin instead of the
proxy path. The actual fix belongs in Vite, not in HTML rewriting:
`scaffold/vite.config.ts` now sets `base: "./"`, which emits **relative**
asset paths — these resolve correctly against whatever URL the document was
served from, regardless of what prefix a proxy puts it under, with no
per-request rewriting needed. This is a scaffold change, so it's inherited
by every future project automatically.

**Verified live, end to end:** built a real app, confirmed both the JS and
CSS bundle requests resolved through the proxy path and returned 200 (not
the old bare-origin 404), then read the iframe's actual rendered DOM content
directly — the real page, with real copy, not just "a request succeeded."

Preview dies with the sandbox — that's fine, it's a preview.

**Deploy (this is what makes it a product):** `npm run build` → upload `dist/`
to object storage → serve via CDN at `<slug>.souqi.app`, custom domain
supported by the machinery you already have (`/api/ws/:id/domain`).

The published site is then **static, permanent, and costs ~nothing** — no
sandbox involved. This is the payoff for the §1 scope decision, and it is what
makes Code economically similar to Sites once a project is finished.

---

## 8. DeepSeek specifics

- **Model:** `deepseek-chat` (V3). Not `deepseek-reasoner` — R1 bills you for
  chain-of-thought on every tool call in a 25-call loop.
- **Tool calling** works in the OpenAI shape, but is **less reliable than
  frontier models**. Budget for it: validate every tool-call argument against a
  strict schema, and on malformed output retry *once* with the parse error fed
  back. Two strikes → deterministic fallback (usually "ask the user").
  Assume this is your #1 source of bugs for the first month.
- **Prefix caching** (~10% of miss rate, automatic) — lay the prompt out:

  ```
  STABLE   system + stack conventions + tool schemas + scaffold map   ~3,000 tok
  VARIABLE file tree · plan state · last error · user message         ~800 tok
  ```

  Never put the project name, a timestamp or a turn counter above the stable
  block; one variable token at the top voids the entire prefix on every call in
  the loop — which, at 25 calls per build, is the difference between $0.08 and
  $0.30.

- **Context discipline.** A 25-call loop compounds context fast. Ranged
  `read_file`, summarise completed steps into one line each, and never re-read a
  file the model just wrote.

---

## 9. Security — the part that ends companies

You will be executing code that an anonymous stranger prompted a model into
writing. Treat every sandbox as hostile.

| Control | Requirement |
|---|---|
| **Network egress** | **Deny by default.** Allowlist the npm registry only. This blocks crypto-mining, spam relays, and SSRF into your own infrastructure |
| **Your infrastructure** | Sandboxes must not reach your Mongo, master DB, internal IPs, or cloud metadata endpoints (`169.254.169.254`) |
| **Secrets** | None in v1 — §1 removed the need. No API keys, no DB creds, ever mounted |
| **Resources** | CPU, memory, disk and process caps per sandbox; a fork bomb must kill one sandbox, not a host |
| **Commands** | `run` is allowlisted: `npm i/ci/run`, `npx tsc`, `git`. Not `curl`, not `bash -c`, not arbitrary binaries |
| **Build output** | Scan `dist/` before publishing — you are hosting it on **your** domain, so injected scripts become your reputation and your CSP problem |
| **Abuse** | Per-IP and per-anon-cookie build quotas. Sandbox minutes are money; free anonymous builds are an open wallet |

Point 1 deserves emphasis: egress-deny is the single highest-value control here,
and it is far easier to configure on day one than to retrofit after an incident.

---

## 10. Cost model

Order-of-magnitude; **verify current rates** — sandbox and token pricing both
move.

**Per build (25 tool calls, moderate app):**

| | |
|---|---|
| Input, cached prefix | ~75K tok × ~$0.07/M ≈ $0.005 |
| Input, variable | ~20K tok × ~$0.27/M ≈ $0.005 |
| Output (file writes dominate) | ~25K tok × ~$1.10/M ≈ $0.028 |
| Sandbox, ~6 min | ≈ $0.02–0.06 |
| **Total** | **≈ $0.06–0.10 per successful build** |

Repairs and failures push the average up; the §2 caps are what keep the tail
bounded. Budget **~$0.15 average, $0.40 hard ceiling** per build.

**At 2,000 builds/month: ~$300.** The same loop on a frontier model runs
**$2,000–4,000** — that gap is the real argument for DeepSeek here, and it's a
much better argument than it was for copywriting.

**Hosting a finished app: ~$0** (static on CDN). This is why §1 matters.

---

## 11. Phases

Each phase ends with something demonstrable. Do not start the next until the
previous one runs.

| # | Work | Done when |
|---|---|---|
| **1** | ✅ **Sandbox provider integration: create, write files, run, kill, snapshot. No model.** | Provider: **Daytona** (`@daytona/sdk`; `@daytonaio/sdk` is deprecated — use the `@daytona` scope). `lib/codeagent/runtimes/daytona-runtime.js` implements the exact same five-verb `runtime.js` contract as `local-runtime.js`, verified against `codeagent-phase1-demo.js` — same `tools.js`, same scaffold, real isolation this time: **✓ real sandbox created (~2s) → ✓ egress-deny confirmed live (`curl` to a non-allowlisted host genuinely fails) → ✓ `npm install` succeeds through the domain allowlist → ✓ the real todo app builds → ✓ checkpoint snapshot → ✓ sandbox destroyed**, run twice for reliability, zero orphaned sandboxes confirmed via `daytona.list()` after. **Found three real bugs live, none guessable from docs alone:** (1) `networkBlockAll` and `domainAllowList` are **mutually exclusive** — the API rejects both together; `domainAllowList` alone is already deny-by-default-except, which is what §9 actually needs. (2) A sandbox's working directory is its user's **home directory**, which already has real content (`.bashrc`, `.face`, and after one `npm install`, `~/.npm/_cacache` — hundreds of cache files) — uploading the scaffold there with no boundary meant a recursive file listing enumerated all of it: 684 files in 64s once cache existed, versus **10 files in 0.1s** once the fix landed. Fixed with a dedicated `PROJECT_DIR` ("app") that every fs/run call is scoped to, replacing an ever-growing directory denylist with an actual boundary. (3) A per-directory walk that skips ignored names **before** recursing (matching how `local-runtime.js` already did it) is not optional — a single deep `listFiles(depth:12)` call is what triggered bug (2) in the first place. Also added a 6-minute script-level watchdog with forced cleanup, since a stuck step here is real, billed sandbox time — confirmed necessary: bugs (2)/(3) burned two orphaned sandboxes before the watchdog existed, both found and deleted manually via `daytona.list()`. |
| **2** | ✅ **The seven tools + strict arg validation, driven by a hardcoded script** | `server/codeagent-phase2-demo.js` — a real todo app, real `npm install`, real `npm run build`, against `lib/codeagent/{tools,runtime,build-parser,dom-snapshot}.js` and a **local** (unsandboxed, explicitly dev-only) runtime. **Proven both directions**, not just the happy path: a syntactically broken file is correctly reported `ok:false` with a parsed `{file, line, message}`, then the same tool call on the real app returns `ok:true` with zero errors. `dom_snapshot` degrades cleanly (`{ok:false, degraded:true, reason}`) rather than crashing when headless Chrome can't launch in this shell — confirmed as an environment-specific ICU/sandbox quirk, not a tool bug; Phase 5 re-exercises it against the real target runtime. **Found and fixed two real bugs the "prove it before spending a token" premise exists to catch:** (1) `shell:true` + an argv array on Windows is a real injection risk or Node's own DEP0190 wouldn't fire — replaced with `cross-spawn`, which resolves `.cmd`/`.bat` shims without a shell; (2) killing a timed-out child does **not** kill the process tree on Windows — an orphaned `esbuild.exe` outlived its parent and held a file lock, which would leak one process per repair-loop timeout at real volume. Fixed with a `taskkill /t /f` (Windows) / process-group `SIGKILL` (POSIX) tree-kill, used by both the timeout path and workspace teardown. |
| **3** | ✅ **DeepSeek in the loop, single shot, no repair** | **Measured: 5/5 (100%) compiled on the first try**, ~$0.002/generation, against 5 varied real prompts (barber shop, coffee roastery, photographer portfolio, pricing page, bakery) — `codeagent-phase3-demo.js`, real DeepSeek + real Daytona sandboxes, zero orphaned sandboxes after. `lib/codeagent/model-loop.js`: one tool (`write_file` only — §1's "the model doesn't choose the stack" applies to tool access too), the stable/variable prompt split from §8, a response cache (`docs/AI-PROVIDER-PLAN.md` §4.1 — exact-match, in-memory, `promptVersion`-keyed so an edited prompt invalidates cleanly), and the "one retry on malformed tool-call JSON, then a clean failure" policy. 24 stubbed tests, zero network, covering path-safety (a model may only write under `src/`), batch-fails-atomically, and the cache's hit/miss/no-fuzzy-matching/never-caches-a-failure properties. **Two real bugs found against the live API that no stub would have caught:** (1) the retry violated the tool-calling protocol — an assistant message carrying `tool_calls` must be followed immediately by one `tool`-role response per `tool_call_id` before any other message; skipping straight to a follow-up `user` message (the original implementation) is a 400 from the provider, not a retry. Fixed, and now covered by a stubbed test that inspects the actual retry request body. (2) `maxTokens: 3000` truncated a real multi-section landing page mid-JSON-string at ~3000 tokens, which surfaces as "malformed JSON" — indistinguishable from a genuine model mistake without the context that the cutoff is exactly where the token budget ran out. Raised to 8000 (headroom, not the expected size). A **third, non-bug finding**: the first full run showed 0/5, entirely because the demo script's own harness never ran `npm install` before building — every failure was the identical `Cannot find module 'react'`, a substrate problem, not a signal about model quality. Fixed by adding the install step Phase 1/2 both already had; re-run went 5/5. **Decision per §11: DeepSeek stays on the coding route** — 100% is well clear of the ~40% threshold that would have demoted it. |
| **4** | ✅ **The feedback loop (§4): build errors → repair, capped** | `proposeWithRepair()` in `model-loop.js`: propose → write → build → on failure, feed the ACTUAL structured errors (`build-parser.js`'s `{file,line,message}`, not raw compiler noise) back through a protocol-correct conversation continuation, capped (`maxRounds`, default 6 per §2, demo runs at 2). 7 new stubbed tests (31 total in the file) prove the mechanism itself: round-0 success needs no repair call, a scripted fail-then-pass round IS repaired and reports it, the repair message carries the real error text (not a generic prompt) through the same tool-call-then-tool-response protocol shape the Phase 3 fix established, the loop stops exactly at the cap rather than running forever, `maxRounds:0` makes exactly one attempt, a model-call failure mid-loop surfaces cleanly, and `proposeWithRepair` never leaks into `proposeChanges`' cache (different contracts — a repaired round is a fixed *version* of a design, not *the* design). **Measured live: `codeagent-phase4-demo.js`, 4 deliberately harder multi-file prompts (a form wizard with Context, a countdown+accordion page, a dashboard with a shared TS interface, a cart app with lifted state) — 4/4 compiled, but 0 needed repair.** Combined with Phase 3's 5/5, that's **9/9 real prompts compiling on the first attempt** against this scaffold and system prompt — genuinely good news (average cost per success stays at the single-shot price), but it means repair's live *value* is still unobserved, only its *correctness*. 9 samples doesn't clear that bar; production traffic (arbitrary, less carefully-worded prompts, at volume) is where a real failure — and a real repair — is expected to show up. The mechanism is ready for it either way. |
| **5** | ✅ **`dom_snapshot` + route assertions** | **Architecture change found live, not planned:** the original design (§4) had the orchestrator run Puppeteer against a sandbox's public preview URL. Chromium would not launch on this dev machine — a real, reproducible local ICU/D-Bus issue, tried via two different process-launch paths (Bash tool and PowerShell tool directly) and surviving a clean reinstall, so not a tooling artifact. Rather than block on that, checked the sandbox itself: Daytona's base image ships **Chromium pre-installed**. Moved the check inside the isolated Linux container instead — `daytona-runtime.js` now runs `chromium --headless=new --dump-dom` via the sandbox's own `run()`, which is arguably the more production-correct design anyway (the orchestrator needs no browser stack of its own, and no public network path to a sandbox's preview port). Also found live: a trailing `&` on `executeCommand` does **not** background a process — the call just blocks until its own timeout and takes the child down with it. Daytona's session API (`createSession` + `executeSessionCommand({runAsync:true})`) is the real mechanism; added as `startPreview()`. `tools.js`'s `dom_snapshot` now prefers `runtime.domSnapshot` when the runtime has one, falling back to the orchestrator-side Puppeteer path otherwise (still exercised correctly by Phase 2's local-runtime demo). **Verified live, both directions, in one run:** a real two-line component's `dom_snapshot` came back with the actual rendered text (not just "build passed"); a component that compiles clean but does `return null` came back `empty:true` — the exact false-positive this phase exists to prevent. Plus 6 new unit tests for the pure HTML→text extraction (script/style stripping, entity decoding, whitespace collapse), no sandbox needed for those. |
| **6** | ✅ **SSE stages, preview proxy, reuse `agent.html`'s look** | **Scope decision, made with the user mid-build:** `/agent` now serves Souqi Code, not the old deterministic site builder — a deliberate swap, not a merge. `agent.html` (site builder: prompt → storefront config, `/api/projects`) is untouched on disk and still fully working, just no longer routed to; `public/code.html` is a new file matching its exact visual system (nav, split layout, transcript rows, composer — copied CSS, not a shared stylesheet) wired to an entirely new backend. `POST /api/codeagent/build` (SSE) in `index.js`: create sandbox → install → `proposeWithRepair` with `onRound` mapped to real stage events → start preview → mint a signed preview URL → stream a `result` frame the page turns into a file-list card and a live iframe. No persistence yet (deliberately — that's Phase 7): an in-memory `codeBuilds` map keyed by `buildId` lets a follow-up reuse the same sandbox; the real cost ceiling is the sandbox's own `autoStopInterval` (bumped 10→20 min once follow-ups needed the sandbox to survive between messages), not the map. **Verified live in the browser, twice, including the follow-up path:** built a 3-file bakery landing page in 33s (~$0.0018), confirmed the signed preview URL actually serves the real built app (fetched server-side, independent of the iframe); sent a follow-up ("make the hero heading say X"), confirmed it touched only the one relevant file and finished in 6s reusing the same sandbox, and confirmed the NEW text is really in the served JS bundle (not just a green checkmark) while the untouched bakery name correctly persisted elsewhere. **Found and fixed two more real bugs in the process, neither guessable without running it:** (1) the dev launcher's `process.chdir()` silently starved `dotenv.config()` of `server/.env`, so `DAYTONA_API_KEY` read as unset even though the file was correct — the first live run's "build failed" traced back to this, not to any agent code. (2) `startPreview()`'s `createSession()` throws `conflict: session already exists` on a follow-up's second call — fixed by checking the port first (the common case: the old preview server is still healthy and serving the rebuild's new output already, since `vite preview` reads `dist/` per request rather than caching it at startup) and only falling through to session creation, with the conflict now an expected, swallowed outcome, when the port genuinely isn't answering. |
| **7** | ✅ **Git checkpoints + durable persistence** | **Reuses `projects.js` directly** — one Mongo `projects` collection serves both product lines now, differentiated only by `meta.kind`, which means code projects inherit the site builder's owner-scoped security model (`projects.owns()`) for free. Three lifetimes, deliberately not conflated: `codeBuilds` (in-memory, this server process) tracks a *live* sandbox for fast follow-ups; `projects`/`revisions` (Mongo) durably store **full file content** per turn, which is what actually survives a reload or restart; a git commit per turn inside the sandbox (the plan's literal ask) is session-scoped undo that dies with the sandbox like everything else in it — the Mongo write is the real durability mechanism, git is a shorter-lived layer on top. New `GET /api/codeagent/:key` replays a project's transcript and mints a **fresh** signed preview URL if the sandbox is still alive (the stored one has a 30-min expiry and was never meant to be durable). **Verified live, both the easy and the hard case:** built a project, closed and reopened its URL — transcript, files and a working live preview all came back, confirmed via a fresh server-side fetch of the re-minted URL. Then the harder case, done carefully — identified the specific sandbox belonging to a test project via a direct Mongo query (never touching the sandbox backing the user's own concurrent session) and killed it directly through the Daytona API to simulate a real `autoStopInterval` firing while the server keeps running. First pass: **the follow-up silently failed** — `codeBuilds` had a stale entry and nothing re-checked it, so the request died with "sandbox ... has been deleted" instead of resuming. Fixed with a cheap liveness probe (`echo ok`) before trusting the registry; on failure the entry is dropped and treated exactly like a resume. Re-verified: "Restored your previous files" → all 6 files re-materialized onto a fresh sandbox → the follow-up applied on top → confirmed the new text landed in the served bundle alongside the untouched resumed content. **Found and fixed a server-crashing bug in the process** — `sseOpen()` commits response headers immediately, and `anon.ownerOf()` (called after it) tries to set the `sq_anon` cookie, which throws `ERR_HTTP_HEADERS_SENT` outside this handler's own try/catch; as an unhandled rejection in an async Express handler, that took the **entire Node process** down, not just the one request, on literally the first anonymous visitor with no existing cookie. Fixed by matching the ordering the working `/api/projects` endpoint already used (owner resolved *before* opening the stream) — this is the kind of bug a stray reordering reintroduces if not guarded, worth remembering when touching either endpoint again. |
| **8** | ✅ **Deploy — scoped down, not to spec** | §7's literal ask was object storage + a real CDN; there was no such account provisioned, so standing one up wasn't a code decision to make alone — asked, and the answer was to reuse this server as the "CDN" rather than block Phase 8 on new infrastructure. `readDist()` (`daytona-runtime.js`) reads the built `dist/` **base64**, unlike the model-facing tools, which are utf8-text only because the model itself never writes binary content — a Vite build still can if something it references isn't text. `POST /api/codeagent/:key/publish` builds fresh (reusing the exact live-check/resume dance `POST /build` already has), stores the result directly on the project doc (same pattern `revisions` already uses), and a NEW `publicSlug` — global, not per-owner like the editing slug — makes `GET /s/:slug(/*)` a public, unauthenticated route with **zero runtime/sandbox involvement**. **Verified live, the way that actually matters for this phase:** built a real app, published it, then killed the backing Daytona sandbox directly (ownership confirmed via its `souqi-codeagent` label first) and re-fetched the published URL — still 200, HTML + JS + CSS all correct, proving the artifact is genuinely independent of the sandbox rather than "worked once while it happened to still be up." Also verified through the real UI end to end (typed prompt → built → clicked Publish → got a working link in the transcript) and an unmapped deep path falling back to `index.html` for client-side routing. Custom domains and a real edge CDN are still the honest v2 if volume ever justifies the ops cost — nothing here forecloses that, the public-slug route is a thin enough layer to sit behind one later without a rewrite. |
| **9** | ✅ **Per-owner spend cap + cost audit — scoped to the real gap found** | §9's "abuse" row is about *dollars*, not requests, and `codeAgentLimiter`'s per-IP rate limit (10/15min) already existed but only throttles *frequency* — at ~$0.002–0.40/build that's still $2–4 from one visitor in fifteen minutes, most of a modest shared budget. Investigating this phase surfaced something already built and easy to miss: `lib/ai/client.js`'s `AI_MONTHLY_BUDGET_USD` is a **whole-platform** guard already shared by both product lines, and `proposeWithRepair`/`assessPrompt` already fail closed through it correctly (confirmed by reading, not assumed) — but it's one shared pool, so nothing stopped a single owner from spending all of it alone before anyone else got a turn. That's the actual gap Phase 9 needed to close, not a second copy of the platform guard. New `lib/codeagent/usage.js` tracks cost **per owner** (same anon-cookie/user identity `projects.js` already uses), checked once per request — after the free chit-chat path, before either paid model call (`assessPrompt` on a fresh build, `proposeWithRepair` on both) — via `CODEAGENT_OWNER_MONTHLY_BUDGET_USD` (default $1, independent of the platform-wide ceiling, 0 disables it). Spend is recorded **regardless of outcome**: a failed repair loop still spent real tokens getting there, which is exactly why `proposeWithRepair` already threads `costUsd` through its failure return, not just success. Each recorded build also writes a `platform_audit` row (`writeMasterAudit`, action `codeagent.build`) with actor, cost and outcome — the literal "per-build cost visible in the audit collection" ask. **Verified live:** ran a real build, confirmed both the `codeagent_usage` row and the matching audit row landed with the correct owner and cost; then set that owner's recorded spend above the cap directly and confirmed the next build request was rejected **before any sandbox was created** (checked against Daytona's own live list — zero created for the blocked attempt, so the cap actually saves the cost it claims to, not just the UI turn). Deliberately **not** built this pass, flagged as still open: scanning `dist/` for injected `<script>` content before publish, and confirming/setting explicit CPU/memory/disk caps on sandbox creation (both still listed in §9's table; neither is a "quota" in the sense this phase's title asks for). |

**Phase 3's measured success rate is the go/no-go.** If DeepSeek lands under
~40% single-shot on your scaffold, the answer isn't more prompt engineering —
it's a better model for the coding route specifically, with DeepSeek kept for
the cheaper sub-tasks. Decide that with the number in front of you, not now.

Realistic effort: **Phases 1–4 are the bulk.** This is months of work, not
weeks. Phase 2 exists specifically so you find out whether the infrastructure is
sound before spending a single token.

**Conversational input, found necessary from real use, not planned upfront:**
a real user's first message was "hello" and it built something anyway — the
site builder's classifier has a "which is closest?" fallback for exactly
this; Souqi Code initially had nothing, so DeepSeek just invented a project
rather than ask. Fixed with `assessPrompt()` in `model-loop.js`: one cheap,
**fail-open** DeepSeek call (JSON mode) that returns `{clear:true}` for
anything with real intent or `{clear:false, reply}` for genuine vagueness —
only on a FRESH build, never a follow-up, so an established project isn't
re-interrogated on every small edit. **First version asked a bare, canned
question** ("Quick question before I build: What kind of business or app is
this for?") — technically correct, but a real user reasonably read it as the
feature being broken, not working, because it never acknowledged what they'd
actually said. Rewritten so the model returns its own natural, in-character
reply instead of a fixed list of questions — told explicitly to greet back
if greeted, keep it short and warm, and never sound like a support ticket.
Verified live across two different casual openers (not just the one example
in the system prompt): "hello" → "Hey! 👋 What would you like me to build for
you?"; "yo whats good" → "Not much, just waiting to build something for you!
What did you have in mind?" — genuinely different replies, not the same
template restated. A parallel gap on the follow-up side: a purely
conversational reply ("thanks!", "nice") would otherwise burn a full rebuild
cycle trying to interpret gratitude as a code change. That one is
deterministic on purpose (`isCodeAgentChitChat()`, whole-message regex match
only, so "thanks for the header but also make the button blue" — a real
request that happens to open with a pleasantry — correctly falls through)
rather than another model call, since the phrase space for an acknowledgment
is small and closed, unlike a first prompt's. **Both verified live:** "hello"
→ a real generated reply → answered →
built on the combined prompt; "thanks!" on an existing project → instant
friendly reply, zero stages, zero rebuild.

---

## 12. What v1 deliberately does not do

- **No backend, database, auth or secrets.** §1. That's v2, gated on v1 metrics.
- **No multi-stack.** One scaffold, one set of conventions, one error taxonomy.
- **No vision.** DeepSeek is text-only; §4 compensates deliberately rather than
  pretending otherwise.
- **No deleting Souqi Sites.** §0. The config pipeline is the fallback and the
  revenue.
- **No self-hosted sandboxing** until managed spend justifies the ops burden.

---

### TL;DR

Build it as a **second product line**, keep Sites running as both fallback and
revenue. Scope v1 to **static front-end apps on one fixed stack** — that single
decision removes secrets, databases, and per-app hosting, and turns sandboxes
into a build-time cost instead of a permanent one. Reuse the projects/turns/
revisions model, the anon cookie, SSE staging and `agent.html` — Phases 1–6 of
the parity plan were stack-agnostic and carry over intact. Start on a **managed
Firecracker-class sandbox with egress denied by default**, cap every loop at 25
calls / 8 minutes / $0.40, and build the **text-only feedback loop** (build
errors → console → DOM snapshot) that substitutes for the screenshots DeepSeek
can't see. Prove the substrate in Phase 2 with zero model calls, then let
Phase 3's measured success rate decide whether DeepSeek stays on the coding
route or gets demoted to the cheap sub-tasks.
