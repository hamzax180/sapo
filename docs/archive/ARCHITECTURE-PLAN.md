# Souqi — Production Architecture & Secure Data-Flow Plan

> **Goal:** take Souqi from a working prototype to a top-tier, production-grade multi-tenant SaaS where **every piece of data flows through a single, server-authoritative, auditable path**, and **every entity, request, and portal carries a globally unique, traceable ID**.
>
> This is an A-to-Z plan: current-state truth → target architecture → the unique-ID system → security layers → phased rollout. It is grounded in the actual code (`server/index.js`, `server/db-adapters.js`, `public/js/store.js`, `public/js/ui.js`, `public/portal.html`).

---

## 0. Executive summary

Souqi today is a multi-tenant platform: a marketing/login site, an operations **console** (`index.html`), and per-workspace public **storefront portals** (`portal.html`), backed by an Express API that can route each workspace to its **own** MongoDB or Postgres database.

The architecture is sound in ambition but has **P0 security holes that must be closed before any real customer data touches it**. The single most important fact:

> **The generic CRUD API (`GET/POST/PUT/DELETE /:c`) has no authentication and no tenant check.** The tenant and even the *database connection string* are chosen by **client-supplied HTTP headers** (`x-workspace-id`, `x-workspace-db-uri`). Any actor can read or destroy any workspace's users, invoices, and payments, or point the server at an arbitrary database.

Everything below fixes that class of problem permanently by making the **server the sole authority** for identity, tenancy, and IDs — the browser proposes, the server disposes.

### Current-state findings (severity-ranked)

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| 1 | 🔴 P0 | Generic CRUD is fully unauthenticated; anyone can CRUD any collection | `server/index.js:557-621` |
| 2 | 🔴 P0 | Tenant + DB URI chosen by client headers; no proof caller belongs to workspace | `index.js:89-94`, `store.js:77-85` |
| 3 | 🔴 P0 | `POST /api/ws` is an unauthenticated upsert → workspace/domain/`dbUri`/config takeover by known `wsId` | `index.js:205-236` |
| 4 | 🔴 P0 | `JWT_SECRET` defaults to `"dev-insecure-secret"` → forgeable tokens | `index.js:35` |
| 5 | 🟠 P1 | Plaintext-password fallback on login; seed users ship plaintext passwords | `index.js:516-517`, `seed.js:18-22` |
| 6 | 🟠 P1 | IDs are `Date.now()` / `count+random` → collisions, enumerable, not globally unique | `index.js:411,419`, `store.js:64-69` |
| 7 | 🟠 P1 | Edit token passed in **query string** (`?et=`) → leaks via logs/history/referrer | `views.js:2724`, `index.js:322-334` |
| 8 | 🟠 P1 | No rate limiting on login / orders / inquiry / AI proxy → brute-force, spam, cost abuse | all public routes |
| 9 | 🟠 P1 | No request/correlation IDs, no idempotency → duplicate guest orders, no traceability | `index.js:400-438` |
| 10 | 🟡 P2 | No `helmet`/CSP/HSTS; `CORS` defaults to `*`; raw `e.message` returned to clients | `index.js:24-27`, all catch blocks |
| 11 | 🟡 P2 | Public projection is a **blacklist** (`PRIVATE_FIELDS`) — fails open when a new sensitive field is added | `db-adapters.js:17,302-317` |
| 12 | 🟡 P2 | `findAll` returns entire collections (no pagination); silent fallback to `localStorage` masks failures | `store.js:89-104`, `db-adapters.js:214` |
| 13 | 🟡 P2 | `dbUri` secrets stored in plaintext in the master `workspaces` collection | `index.js:213-230` |

### Implementation status (this branch)

Phases 0–5 are implemented and covered by tests (`cd server && npm test && npm run test:isolation`).

| Phase | Status | Evidence |
|-------|--------|----------|
| 0 — Security core | ✅ done | CRUD requires session; tenancy from signed token; `POST /api/ws` takeover-guarded; fail-closed `JWT_SECRET`; error envelope |
| 1 — Identity spine | ✅ done | `server/lib/ids.js` ULIDs; `X-Request-Id` on every response; server-minted ids + `requestId` on records |
| 2 — Session & RBAC | ✅ done | `wsId` in JWT; `server/lib/rbac.js` enforced; plaintext-password login removed |
| 3 — Validation & idempotency | ✅ done | `server/lib/validate.js` + schemas; `Idempotency-Key` dedupes orders/inquiries |
| 4 — Edge & secrets | ✅ done | security headers + CSP; rate limiters; per-route body limits; `dbUri` AES-256-GCM at rest |
| 5 — Data isolation | ✅ done | allowlist public projection; `findAll` scan cap + `findPage` cursor; **tenant-isolation test proves A can't read B** |
| 6 — Observability/compliance | ✅ done | structured request logs + `/metrics`; server-side append-only audit (guest + admin actions) with integrity hash; GDPR export + owner-only erasure |
| 7 — Live-editor & portal polish | ◑ partial | edit-token moved off query-string → URL fragment + `X-Edit-Token` header (with scrub); pluggable CAPTCHA hook (no-op until `CAPTCHA_SECRET` set). **Deferred (need keys/decisions):** real PSP integration, CSP nonce tightening, portal script cache-busting |

Bonus fix found while testing: `db-adapters.js` used `DB_NAME` as the per-tenant DB fallback, which would have collapsed all tenants into one database — corrected to always use `webo_<wsId>`.

### Definition of "done" (production bar)

- No data path exists that the server cannot **authenticate, authorize, tenant-scope, validate, rate-limit, and trace**.
- Every record, request, portal, and session has a **globally unique, prefixed, sortable ID**; every write is linked to the `requestId` and `actorId` that caused it.
- Client headers can never change **which tenant or database** is touched.
- Secrets live in a manager, encrypted at rest; PANs and passwords never touch our logs or DB in the clear.
- A single guest order can be replayed 100× and create **exactly one** order (idempotency).

---

## 1. Guiding principles

1. **Server-authoritative.** The browser is untrusted. Tenancy, identity, authorization, and ID minting happen server-side. The client may *propose* an idempotency key; it may never *choose* a tenant, a DB, or a primary ID.
2. **Zero-trust multi-tenancy.** Every query is scoped to a `workspaceId` **derived from the authenticated session**, not from a header.
3. **Everything is identified.** Entities, requests, sessions, portals, idempotent operations, and audit events all carry unique IDs, and they are **linked** so any record can be traced back to the exact request and actor.
4. **Defense in depth.** Edge → gateway → service → data-access, each layer independently enforces its own invariants (allowlist, validate, authz, scope).
5. **Fail closed.** Missing auth, unknown field, unresolved tenant, DB error → reject. Never silently fall back to another data source or return everything.
6. **Least privilege.** RBAC enforced on the server for every mutation; DB credentials scoped per tenant; secrets never broader than needed.
7. **Auditable & reversible.** Append-only audit log, backups, and migrations that can roll forward and back.

---

## 2. Target architecture

### 2.1 Layered components

```
                       ┌───────────────────────────────────────────────┐
   Browsers            │                  EDGE / CDN                    │
   ───────             │  TLS · HSTS · WAF · global rate-limit · cache  │
   • Marketing/login   └───────────────────────┬───────────────────────┘
   • Console (SPA)                              │  X-Request-Id injected here
   • Portal storefront                          ▼
                       ┌───────────────────────────────────────────────┐
                       │              API GATEWAY (Express)             │
                       │  requestId · CORS allowlist · helmet/CSP       │
                       │  authN (session) · rate-limit · body limits    │
                       └───────────────────────┬───────────────────────┘
                                               ▼
                       ┌───────────────────────────────────────────────┐
                       │           APPLICATION / DOMAIN LAYER           │
                       │  authZ (RBAC) · input validation (zod)         │
                       │  tenant resolver · idempotency · ID minting    │
                       │  services: orders, invoices, storefront, …     │
                       └───────────────────────┬───────────────────────┘
                                               ▼
                       ┌───────────────────────────────────────────────┐
                       │            DATA-ACCESS LAYER (repo)            │
                       │  field allowlist · pagination · audit hook     │
                       └───────┬───────────────────────────┬───────────┘
                               ▼                           ▼
                    ┌────────────────────┐      ┌──────────────────────┐
                    │   MASTER DB        │      │   PER-TENANT DB(s)    │
                    │  workspaces,       │      │  webo_<wsId> or a     │
                    │  domains, secrets  │      │  customer-owned DB    │
                    │  (dbUri encrypted) │      │  (Mongo / Postgres)   │
                    └────────────────────┘      └──────────────────────┘
```

### 2.2 The three frontends and their trust levels

| Surface | File | Auth | Data it may touch |
|---------|------|------|-------------------|
| Marketing + sign-in | `login.html` | none | public content, `POST /auth/*` |
| Operations console (SPA) | `index.html` | **session required** | that workspace's data, scoped by session |
| Public storefront portal | `portal.html` | none (guest) + short-lived owner **edit session** | public catalog, guest order/inquiry/track only |

### 2.3 The core rule change

Today: `store.js` sends `x-workspace-id` / `x-workspace-db-uri`; the server obeys.
Target: the **session** (cookie/JWT) encodes `sub` (user) + `wsId` + `role`. A `tenantResolver` middleware turns `wsId` → DB handle by looking it up in the master DB **server-side**. Client DB headers are **ignored and rejected**.

---

## 3. The unique-ID system (the backbone you asked for)

Every identifiable thing gets a **prefixed, collision-proof, sortable** ID. This is the spine that makes secure data-flow *traceable*.

### 3.1 Format

```
<prefix>_<ULID>
         └── 26-char Crockford base32, 128-bit, lexicographically time-sortable
```

- **ULID** (or **UUIDv7**) — 128 bits, monotonic within a millisecond, URL-safe, no coordination needed across servers/DBs. Sortable by creation time, which kills the need for a separate `createdAt` index in many cases.
- **Prefix** names the type, so an ID is self-describing in logs, URLs, and support tickets (`ord_01J9…` is obviously an order). Stripe-style.
- **Never** `Date.now()` (collides under concurrency), **never** `count + random` (enumerable, collides across devices), **never** a database auto-increment exposed to the client (leaks volume, enumerable).

### 3.2 Prefix registry

| Entity / concept | Prefix | Example | Minted by | Notes |
|------------------|--------|---------|-----------|-------|
| Workspace (tenant) | `ws_` | `ws_01J9F3…` | server @ signup | replaces `ws_mrzeozny3fg1` |
| User | `usr_` | `usr_01J9…` | server | |
| Client / customer | `cli_` | `cli_01J9…` | server | |
| Supplier | `sup_` | | server | |
| Product | `prd_` | | server | |
| Quote | `qte_` | | server | |
| Order | `ord_` | `ord_01J9…` | server | + human ref `SQ-ORD-2026-000123` |
| Shipment | `shp_` | | server | |
| Invoice | `inv_` | | server | + sequential legal number per tenant |
| Purchase order | `por_` | | server | |
| Bill | `bil_` | | server | |
| Payment | `pay_` | | server | |
| Audit event | `aud_` | | server | references `requestId` + `actorId` |
| **HTTP request** | `req_` | `req_01J9…` | gateway middleware | returned as `X-Request-Id` |
| **Idempotency op** | `idem_` | client-supplied | client → server verifies | dedupes POSTs |
| **Login/session** | `ses_` | | server | `jti` for revocation |
| **Editor session** | `edit_` | | server | short-lived, `jti`-revocable |
| Trace / correlation | `trace_` | | edge | spans multiple services |

> **Human-facing references** (invoice numbers, order refs) are **separate** from primary IDs: `SQ-INV-2026-000042`, generated by a **per-tenant atomic counter** (see 3.5). Primary IDs are opaque ULIDs; human refs are pretty, sequential, and legally required for invoices — never mix the two roles.

### 3.3 Three kinds of ID, three purposes

1. **Entity IDs** (`ord_`, `inv_`…) — identify *records*. Minted server-side on write. The client's proposed `id` is **discarded**.
2. **Request IDs** (`req_`) — identify *one HTTP call*. A middleware assigns one to every request (honoring an inbound `X-Request-Id` from the edge if present and well-formed), attaches it to `req`, echoes it in the response header, and stamps it on every log line and every audit row created during that request.
3. **Idempotency keys** (`idem_`) — identify *an intended operation*. The client generates one per user action (e.g. "place this order") and sends it as `Idempotency-Key`. The server stores `{key → first result}` per tenant; replays return the stored result instead of acting twice.

### 3.4 End-to-end example: one storefront order

```
Shopper clicks "Pay"  →  POST /api/portal/ws_01J9.../orders
   Headers:  Idempotency-Key: idem_01J9AK…      (client-generated, one per checkout)
   Edge adds: X-Request-Id: req_01J9AK…
      │
      ▼  server
   1. tenantResolver: ws_01J9…  → master DB → tenant DB handle (server-side)
   2. idempotency: seen idem_01J9AK…? → if yes, return the stored {ref, orderId}
   3. validate body (zod), rate-limit by IP+ws
   4. mint  ord_01J9AK…  + human ref  SQ-ORD-2026-000123
   5. write order to tenant DB
   6. write audit  aud_01J9…  { requestId: req_01J9AK…, actor: "guest", wsId, action:"order.create", entity: ord_01J9… }
   7. store idempotency result keyed by (ws, idem_01J9AK…)
   8. respond 201 { orderId: ord_01J9…, ref: SQ-ORD-2026-000123 }  + header X-Request-Id
```

Now: the order, the audit trail, the server logs, and the shopper's confirmation **all share the same `req_` id**, and a network retry produces **zero** duplicate orders. That is the traceability + safety the brief asks for.

### 3.5 Implementation notes

- Add `server/lib/ids.js`: `newId(prefix)` (ULID), `newRequestId()`, `isValidId(prefix, s)`.
- Per-tenant sequential human refs use an atomic counter document/row:
  `db.counters.findOneAndUpdate({_id:'invoice:2026'}, {$inc:{seq:1}}, {upsert,returnDocument:'after'})` (Mongo) or `INSERT … ON CONFLICT … RETURNING` (Postgres) — never `COUNT(*)+1`.
- Unique index on `id` in every collection/table (already partially done: `db-adapters.js:152`). Add unique compound `(wsId, idempotencyKey)` on the idempotency store.
- Client `store.js:nextId` becomes a **temporary local-only** helper for DEMO mode; in LIVE mode the client sends **no** `id` and reads the server-minted one back.

---

## 4. Tenant isolation & data model

### 4.1 Stop trusting the client for tenancy (P0)

- **Remove** `x-workspace-id` / `x-workspace-db-type` / `x-workspace-db-uri` from the trust path (`store.js:77-85`, `index.js:89-94`). The server derives `wsId` from the **session**.
- `tenantResolver(req)` → looks up `workspaces` in the master DB by the session's `wsId` → returns a cached, server-owned `{dbType, dbUri}`. The client never sees or sets a DB URI.
- Authorization: for **every** CRUD call, assert the session's `wsId` matches the route/resource's `wsId` **and** the role permits the action.

### 4.2 Isolation model

Two supported tenancy modes, both server-enforced:

1. **Platform-hosted** (default): one managed cluster, **one database per workspace** (`webo_<wsId>`) — strong isolation, easy per-tenant backup/delete. This already exists (`db-adapters.js:54`); make it the default and remove the "shared DB, filter by field" ambiguity.
2. **Bring-your-own-DB** (enterprise): customer supplies a connection string **once**, via an authenticated owner-only settings flow; it is validated, **encrypted with KMS**, and stored in the master DB. It is never transmitted by the browser again.

### 4.3 Secrets at rest

- Encrypt `dbUri` (and any API keys) in the `workspaces` record with envelope encryption (KMS data key). Decrypt only in the tenant resolver, in memory.
- Rotate the master `JWT_SECRET` off the insecure default; require it via env or **refuse to boot** (`index.js:35`).

### 4.4 Data-access hardening

- **Allowlist output**, not blacklist: replace `PRIVATE_FIELDS` (`db-adapters.js:17`) with an explicit per-collection **public projection** (`portalPublicFields.products = ['id','name','price','image',…]`). New fields are private by default → fails closed.
- **Pagination** everywhere: `findAll` takes `{limit,cursor}` (cursor = last ULID) and returns `{items, nextCursor}`. No unbounded scans.
- **Parameterize / allowlist** all Postgres identifiers (collection names already allowlisted via `COLLECTIONS` — keep that invariant and never interpolate user input into SQL).

---

## 5. Authentication & authorization

### 5.1 AuthN

- **Sessions:** issue a short-lived **access token (15 min)** + **rotating refresh token (httpOnly, Secure, SameSite=Strict cookie)**. Access token carries `sub`, `wsId`, `role`, `jti`. Refresh rotation detects token theft (reuse → revoke family).
- **Passwords:** bcrypt (cost ≥ 12) or argon2id. **Remove the plaintext fallback** (`index.js:516-517`) and re-hash all seed users; never ship plaintext passwords in `seed.js`.
- **Login scoping:** authenticate against the **tenant resolved from the login identity**, not from a client header (`index.js:508`). Add per-account + per-IP rate limiting and lockout/backoff.
- Optional: TOTP MFA for Owner/Finance roles; SSO (OAuth) for enterprise.

### 5.2 AuthZ — enforce the RBAC you already have, on the server

You already define roles in `ui.js:12` (`Owner`, `HR Manager`, `Operations Manager`, `Finance Officer`, `Trade Specialist`) — but they're enforced **only in the browser**. Port `ROLE_PERMS` to a shared server module and gate every mutation.

| Layer | Check |
|-------|-------|
| Route | authenticated? valid session `jti` not revoked? |
| Tenant | `session.wsId === resource.wsId`? |
| Role | `can(role, collection, action)` — server copy of `ROLE_PERMS` |
| Ownership | for workspace-admin ops, `assertOwnsWorkspace` (already exists, `index.js:156` — extend it to all admin routes) |
| Field | can this role write these specific fields? (mass-assignment guard) |

### 5.3 Lock down the generic CRUD (the P0)

Wrap `/:c` routes (`index.js:563-621`) with: `requireSession → tenantResolver → requireRole(collection, action) → validate(collection) → repo`. Reject unknown collections (already done) **and** unauthorized ones. No route may read/write tenant data without passing all five checks in 5.2.

---

## 6. API-layer hardening (gateway)

Add, in order, as Express middleware:

1. `requestId` — mint `req_…`, attach, echo `X-Request-Id`.
2. `helmet` + strict **CSP** (portal and console get tailored policies; the storefront allows only self + configured asset origins).
3. **CORS allowlist** from env (`index.js:26-27` currently `*`) — reflect only known origins + custom domains.
4. Body limits per route (the 12 MB limit at `index.js:24` should apply **only** to the storefront-config route, not globally).
5. **Rate limiting / slow-down**: strict on `/auth/*`, `/api/portal/*/orders`, `/inquiry`, `/ai/chat`; generous on reads. Back with Redis for multi-instance.
6. **Idempotency** middleware for all unsafe POSTs that create money/records.
7. **Validation**: `zod` schema per endpoint; reject unknown keys; coerce types; enforce lengths. Kills mass-assignment and injection.
8. **Error envelope**: never leak `e.message` (`index.js` catch blocks). Return `{ error: { code, message, requestId } }`; log the detail server-side keyed by `requestId`.
9. **AI proxy** (`index.js:530`): require a session, rate-limit, and meter usage per workspace (cost control).

---

## 7. Portal / storefront (public) security

The portal is the most exposed surface — guests hit it with no auth.

- **Read path**: only `findAllPublic` with the **allowlist** projection (§4.4); only products `publishedToPortal === true` (make this strict, drop the "fallback to all" at `db-adapters.js:309-310` in production).
- **Write path** (orders, inquiries): validation + IP/workspace rate-limit + optional CAPTCHA/Turnstile on inquiry/order + **idempotency** (no duplicate orders).
- **Payments**: never accept or store PANs. Integrate a real PSP (Stripe/Adyen) with a client-side tokenized element; store only `{brand, last4, pspRef}`. The current code already avoids storing full cards (`index.js:414-417`) — formalize it: the order write records only the PSP payment intent id (`pay_…` ↔ `pi_…`).
- **Tenant scoping**: the portal resolves its `wsId` from the path (`portal.js:50`) or custom domain (`index.js:53-72`) — keep that, but all writes go through the same server-authoritative tenant resolver.

---

## 8. Live-editor security

- **Token transport**: move the edit token out of the **query string** (`views.js:2724`, `?et=`) into an `Authorization` header or a short-lived httpOnly cookie set via a one-time exchange. Query strings leak into logs, history, and `Referer`.
- **Lifetime & revocation**: keep it short (≤15 min, already `index.js:307`) and add a `jti` so an owner can revoke an editing session; verify `scope==='portal-edit'` and `wsId` match (already done, `index.js:326-329`).
- **CSP**: the editor page must not allow inline script injection through storefront config content (sanitize any HTML in blocks; the config can contain data-URI images — validate MIME + size).

---

## 9. Edge & transport

- **TLS everywhere**, HSTS preload, HTTP→HTTPS redirect.
- **Custom domains** (SaaS): automate certificate issuance (ACME) per verified customer domain; the domain→workspace map already lives in the master DB (`db-adapters.js:200`). Verify domain ownership (DNS TXT) before activation.
- **WAF / bot protection** at the edge; global IP rate limits; block known-bad ranges.
- Separate the **static site** (CDN) from the **API** (app servers) so a storefront DDoS can't starve the console.

---

## 10. Secrets & configuration

- All secrets (`JWT_SECRET`, `GEMINI_API_KEY`, master `MONGODB_URI`, per-tenant `dbUri`) in a **secret manager** (Vault / cloud KMS), never in `config.js` (`GEMINI_API_KEY: ""` at `public/js/config.js` must stay empty — the key lives only server-side, already proxied at `index.js:530`).
- **Refuse to boot** with default/placeholder secrets in production.
- 12-factor config: env per environment; no secrets in the repo or client bundle.

---

## 11. Observability, audit & integrity

- **Structured JSON logs** with `requestId`, `wsId`, `actorId`, `route`, `latency`, `status`. One correlation id from edge to DB.
- **Audit trail** (`audit` collection already exists and `store.js` records mutations): make it **append-only**, server-written, and stamped with `{requestId, actorId, wsId, action, entityId, before/after hash}`. Never write audit from the client.
- **Metrics + tracing** (OpenTelemetry): p95 latency, error rate, per-tenant request volume, AI spend.
- **Alerting**: auth-failure spikes, 5xx spikes, tenant-resolution failures, idempotency-store errors.

---

## 12. Data lifecycle & compliance

- **Backups**: per-tenant, automated, restore-tested. BYO-DB tenants own their backups; document responsibility split.
- **Encryption**: at rest (DB + secrets) and in transit (TLS).
- **PII & GDPR/KVKK**: data map of where PII lives (users, clients, orders); export & delete-by-workspace flows; retention policy.
- **Right to erasure**: because IDs are opaque and tenancy is per-DB, deleting a workspace = drop its DB + master record + backups per policy.

---

## 13. Engineering process

- **Validation-first**: no endpoint merges without a zod schema and an authz test.
- **Tests**: unit (id/idempotency/authz), integration (per-route auth matrix), and a **tenant-isolation test** that proves workspace A cannot read/write workspace B via any header/param manipulation. Extend the existing `server/smoke-test.js` / `unit-test.js`.
- **CI/CD gates**: lint, `npm audit`/SCA, secret scanning, the isolation test, and a staging deploy before prod.
- **Threat model** (STRIDE) reviewed each quarter; the findings table in §0 becomes the initial backlog.

---

## 14. Phased rollout roadmap (A → Z)

Non-breaking, prioritized so the platform is safe fast, then hardened.

| Phase | Theme | Key work | Primary files | Outcome |
|-------|-------|----------|---------------|---------|
| **0 — Stop the bleeding** (P0, days) | Close the open doors | Require real `JWT_SECRET` or refuse boot; **auth + tenant guard on all `/:c` CRUD**; auth on `POST /api/ws`; ignore client DB-URI headers | `index.js:35,205,557-621` | No unauthenticated data access; tenant can't be spoofed by header |
| **1 — Identity spine** | Unique IDs everywhere | `server/lib/ids.js` (ULID); `requestId` middleware + `X-Request-Id`; migrate writes to prefixed IDs + per-tenant human refs | `index.js`, `store.js:64-69` | Every record/request uniquely identified & linked |
| **2 — Session & RBAC** | Real auth | Access+refresh tokens (httpOnly cookie), remove plaintext-password path, server-side `ROLE_PERMS`, ownership checks on all admin routes | `index.js:502-527`, port `ui.js:12` | Least-privilege enforced server-side |
| **3 — Input & idempotency** | Safe writes | zod validation per route; `Idempotency-Key` on orders/payments/inquiries; error envelope (no `e.message`) | portal + CRUD routes | No dup orders; no injection/mass-assignment; no info leak |
| **4 — Edge & secrets** | Perimeter | helmet/CSP, CORS allowlist, per-route body limits, rate limits (Redis), secrets → KMS, encrypt `dbUri`, TLS/HSTS | `index.js:24-27`, infra | Hardened perimeter, secrets safe |
| **5 — Data & isolation** | Tenant integrity | Allowlist projections, pagination/cursors, per-tenant DB default, atomic counters, unique indexes, tenant-isolation test | `db-adapters.js` | Provable isolation, no unbounded scans |
| **6 — Observe & comply** | Run it for real | Structured logs + tracing, append-only server-side audit, backups + restore tests, GDPR export/delete, alerting | infra + `audit` | Operable, auditable, compliant |
| **7 — Live-editor & portal polish** | Exposed surfaces | Edit token off query-string, CAPTCHA on public forms, PSP integration (no PANs), storefront content sanitization | `views.js:2724`, `portal.js` | Public surfaces safe and abuse-resistant |

---

## 15. Appendix A — Endpoint authorization matrix (target)

| Endpoint | Auth | Tenant check | Extra |
|----------|------|--------------|-------|
| `GET /health` | none | — | — |
| `POST /auth/login` | none | derived from identity | rate-limit + lockout |
| `POST /auth/refresh` | refresh cookie | — | rotation + reuse detection |
| `GET/POST/PUT/DELETE /:c` | **session** | `session.wsId` | RBAC + validate + paginate |
| `POST /api/ws` | **session (owner)** | creates own ws | validate |
| `POST /api/ws/:id/domain` | owner | `assertOwnsWorkspace` | DNS verify |
| `POST /api/storefront/config` | owner | `assertOwnsWorkspace` | size limit |
| `POST /api/storefront/edit-token` | owner | `assertOwnsWorkspace` | short TTL + `jti` |
| `GET /api/portal/:wsId/config` | none | path `wsId` | allowlist projection |
| `GET /api/portal/:wsId/products` | none | path `wsId` | published-only + projection |
| `POST /api/portal/:wsId/orders` | none (guest) | path `wsId` | **idempotency** + rate-limit + validate |
| `POST /api/portal/:wsId/inquiry` | none (guest) | path `wsId` | CAPTCHA + rate-limit |
| `POST /ai/chat` | **session** | `session.wsId` | rate-limit + spend meter |

## 16. Appendix B — Required environment variables (prod)

```
JWT_SECRET=<32+ random bytes; boot fails if missing/default>
JWT_REFRESH_SECRET=<separate 32+ bytes>
MONGODB_URI=<master cluster>            # workspaces, domains, secrets, idempotency, counters
DB_ENCRYPTION_KEY=<KMS key id/data key> # encrypts per-tenant dbUri at rest
CORS_ORIGIN=https://app.souqi.site,https://souqi.site
PLATFORM_HOST=app.souqi.site
GEMINI_API_KEY=<server-only>            # never in public/js/config.js
REDIS_URL=<for rate-limit + idempotency store>
NODE_ENV=production
```

## 17. Appendix C — New/changed modules

```
server/
  lib/ids.js            # ULID mint, request-id, validators, prefix registry
  lib/idempotency.js    # Idempotency-Key store (Redis/Mongo), per-tenant
  lib/counters.js       # atomic per-tenant sequential human refs
  middleware/requestId.js
  middleware/session.js        # verify access token / refresh
  middleware/tenantResolver.js # wsId(session) -> DB handle (server-side only)
  middleware/authorize.js      # server ROLE_PERMS
  middleware/validate.js       # zod schemas per collection/route
  middleware/rateLimit.js
  schemas/*.js                 # per-entity zod schemas + public projections
public/js/
  store.js              # LIVE mode: send no id / no db headers; read server ids;
                        # attach Idempotency-Key on creates
```

---

### TL;DR

Make the **server the single source of truth** for **identity, tenancy, and IDs**; give **everything a prefixed ULID** and **link every write to the request and actor that caused it**; put **auth + tenant + RBAC + validation + rate-limit + idempotency** in front of every data path — starting with the **unauthenticated CRUD API**, which is the one change that matters most today.
