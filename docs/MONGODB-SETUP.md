# Connecting Souqi Cloud to a real MongoDB

> Companion to [ARCHITECTURE-PLAN.md](ARCHITECTURE-PLAN.md) (the security design — tenant
> isolation, `dbUri` encryption at rest, RBAC — all of that is already **built and tested**
> in `server/`). This doc is the practical "how do I actually flip it on" guide.
>
> Right now new workspaces default to **Demo Mode** (`dbType: "local"`, data kept in the
> browser's `localStorage`). That's an honest fallback, not a placeholder to hide — it's what
> lets the whole app run with zero setup. This guide replaces it with a real, secured MongoDB.

---

## 1. What "Demo Mode" actually means today

- `POST /api/db/seed` / `POST /api/ws` accept `dbType` + `dbUri` per workspace ([server/index.js](../server/index.js), [server/db-adapters.js](../server/db-adapters.js)).
- If `dbType` is `"local"` (the signup default), the **client** never calls the DB — it reads/writes `localStorage` directly (`public/js/store.js`). Nothing touches a server database.
- If `dbType` is `"mongodb"`, the **server** is the only thing that ever holds the connection string (already encrypted at rest — see ARCHITECTURE-PLAN §4.3) and every query is tenant-scoped through the session (§4.1, already implemented and covered by `server/isolation-test.js`).

So the moment a real `dbUri` exists, the *security* is already there. What's missing is the *cluster itself*.

## 2. Get a MongoDB cluster (5 minutes, free tier works)

1. Create a free account at **mongodb.com/cloud/atlas** (or use an existing org).
2. **Create a cluster** — M0 (free) is fine to start; upgrade later without changing app code.
3. **Network access**: add the IP address(es) your server runs from (or `0.0.0.0/0` only for early testing — tighten this before real customer data, see §5).
4. **Database user**: create one with a strong generated password, scoped to **readWrite on this cluster only** — not an Atlas admin account.
5. **Get the connection string**: Atlas → Connect → Drivers → copy the `mongodb+srv://...` URI.

## 3. Two ways to use it

### Option A — one master cluster for the whole platform (recommended to start)
Every workspace gets its **own database** inside the same cluster (`webo_<wsId>` — this isolation already exists, see `db-adapters.js:getDbClient`). Simple, cheap, still fully isolated per tenant.

Set on the server (not in any client file):
```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
DB_NAME=souqi_master
```
`MONGODB_URI` is the **master** connection — it holds the `workspaces` registry, `visits`, `platform_audit`, `idempotency`. Individual tenant data still lands in its own per-workspace database on the *same* cluster unless a workspace brings its own (Option B).

### Option B — bring-your-own-database per customer (enterprise tier)
A customer supplies their own Atlas connection string via the owner-only domain/settings flow (`POST /api/ws/:id/domain` already accepts this). It's encrypted before storage (`lib/crypto.js`, AES-256-GCM) and decrypted only in-memory when the server needs it (`middleware/auth.js:resolveWsContext`). No app changes needed — this path already exists.

## 4. Required environment variables (production)

```
JWT_SECRET=<32+ random bytes>              # already required — server refuses to boot without it
DB_ENCRYPTION_KEY=<32-byte key, hex or base64>  # encrypts every stored dbUri (Option B) — see lib/crypto.js
MONGODB_URI=<your Atlas connection string>  # the master cluster (Option A)
DB_NAME=souqi_master
CORS_ORIGIN=https://app.souqi.site,https://souqi.site
NODE_ENV=production
```
Generate `DB_ENCRYPTION_KEY` once and store it somewhere durable (a secrets manager) — losing it makes every stored `dbUri` unrecoverable.

## 5. Before real customer data touches it

- [ ] Atlas network access is **not** `0.0.0.0/0` — allowlist your actual server IP(s), or use Atlas's VPC/PrivateLink.
- [ ] The database user has **no** admin/cluster-management privileges.
- [ ] Atlas **automated backups** are turned on (free tier doesn't include this — worth the smallest paid tier for that alone).
- [ ] `DB_ENCRYPTION_KEY` and `JWT_SECRET` are real secrets (not the repo defaults) and live in your host's secret manager, not a `.env` committed to git.
- [ ] Run the isolation test against the real cluster once, to prove tenant separation holds outside the in-memory test DB:
  ```bash
  cd server
  MONGODB_URI="<your atlas uri>" DB_NAME=souqi_master_test node isolation-test.js
  ```
  (points at a throwaway `_test` database name so it never touches real data.)

## 6. What changes in the product once this is live

- The signup "Database hosting" dropdown option should read **"Souqi Cloud Managed"** (drop "Demo Mode") once `MONGODB_URI` is set server-side — happy to flip that copy the moment you confirm the cluster is connected.
- New workspaces get a real, isolated database automatically — no code change needed on the client.
- Nothing about the UI, editor, or admin panel needs to change; they already talk to the same API regardless of what's behind it.

---

### TL;DR
The security architecture is already built and tested. All that's missing is an actual MongoDB cluster. Get one from Atlas (§2), set `MONGODB_URI` + `DB_NAME` on the server (§3 Option A), generate a `DB_ENCRYPTION_KEY` (§4), lock down network access before real data (§5) — send me the connection string (or set it yourself) and I'll verify it end-to-end and flip the signup copy from "Demo Mode" to "Souqi Cloud Managed".
