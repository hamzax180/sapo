# Souqi Deploy

Build a user app, run it in its own hardened container, give it an HTTPS URL.

Hetzner + Docker + Caddy + Postgres. No Kubernetes — at ten clients it would
be more moving parts than the thing it orchestrates.

```
                        Internet
                            │
                      Caddy :80 :443          ← the only published ports
                            │
                    souqi_apps (internal)     ← no route off the box
                    ├── app-dep_a1b2  (0.5 CPU, 512MB, 100 PIDs)
                    ├── app-dep_c3d4
                    └── app-dep_e5f6
                            ▲
                            │ docker.sock
                         worker  ──── Postgres ──── api
                              souqi_platform
```

## Run it locally

```bash
cp .env.example .env
docker compose up -d
```

Auth uses the main app session — the same `sq_session` cookie, signed with the
same `JWT_SECRET`. For local work you can skip the login flow:

```bash
echo 'ALLOW_DEV_AUTH=1' >> .env     # refuses to boot alongside NODE_ENV=production
```

Then:

```bash
curl -s localhost:4500/projects -H 'x-user-id: u1' -H 'content-type: application/json' -d '{"name":"demo"}'
```

Take the `projectId`, create a deployment, push source, and deploy:

```bash
curl -s localhost:4500/deployments -H 'x-user-id: u1' -H 'content-type: application/json' -d '{"projectId":"prj_..."}'
curl -s localhost:4500/deployments/dep_.../source -H 'x-user-id: u1' -H 'content-type: application/json' -d '{"files":{"index.html":"<h1>hi</h1>"}}'
curl -s -X POST localhost:4500/deployments/dep_.../deploy -H 'x-user-id: u1'
curl -s localhost:4500/deployments/dep_.../status -H 'x-user-id: u1'
```

## Verify the security properties

```bash
node scripts/verify.js        # 50 checks — containers, builds, secrets, compose
node scripts/verify-auth.js   # 21 checks — sessions, revocation, boot guards
```

71 checks, no Docker daemon required. They assert what the code *would* run
rather than running it, so they hold in CI and before anything is deployed —
a guarantee you can only test with the full stack up is one that quietly
stops being true.

## What is enforced, and where

| Rule | Enforced in |
|---|---|
| No `--privileged`, no socket, no host network, no bind mounts | `src/docker/engine.js` → `buildRunArgs` has no parameter that could add them |
| Nothing published except 80/443 | `docker-compose.yml`; `buildRunArgs` never emits `-p` |
| CPU / memory / PID ceilings | `buildRunArgs`, per-deployment values from the DB |
| `cap-drop=ALL`, `no-new-privileges`, read-only root, non-root user | `buildRunArgs` + generated Dockerfiles |
| User build scripts never run on the host | `src/framework/dockerfiles.js` — every build is `docker build` |
| Command injection | `execFile` with an argv array, never a shell string |
| Secrets encrypted at rest, never logged, never returned | `src/secrets.js`, `src/api/server.js` |
| Refuse deploys when the host is full | `src/monitor/capacity.js` |
| Only a real signed-in session can deploy | `src/api/auth.js` — shared `sq_session` JWT |
| A revoked session stops working | introspection against the main app, 60s cache |

**The one line that matters:** `/var/run/docker.sock` is mounted into the
worker and nowhere else. The worker is a control plane and needs the control
API; it runs no untrusted code itself. User code only ever executes inside
the containers it creates.

## Supported frameworks

`static` · `node` · `nextjs` · `python`

Detected from `package.json` / `requirements.txt`, or declared explicitly —
a `deploy.json` in the source always wins:

```json
{ "framework": "nextjs", "buildCommand": "npm run build", "startCommand": "npm start", "port": 3000 }
```

Vite and CRA apps resolve to `static`, not `node`. They compile to files, so
they ship as an ~8MB nginx image instead of a 512MB Node process — the
difference between hosting ten apps on one box and hosting three.

## Endpoints

```
POST   /projects                     GET  /projects
POST   /deployments                  GET  /deployments/:id
POST   /deployments/:id/source       GET  /deployments/:id/status
POST   /deployments/:id/deploy       GET  /deployments/:id/logs?phase=build|runtime
POST   /deployments/:id/redeploy
POST   /deployments/:id/start        PUT    /projects/:id/env
POST   /deployments/:id/stop         GET    /projects/:id/env
POST   /deployments/:id/restart      DELETE /projects/:id/env/:key
DELETE /deployments/:id              GET  /capacity
```

## Going to Hetzner

One server. Four scripts, in order — none of them spends money until you pass
`--create`.

```bash
node scripts/preflight.js --generate   # fill empty secrets (never overwrites)
node scripts/preflight.js              # check .env before it leaves the laptop
node scripts/provision.js              # plan: type, price, firewall. Creates nothing.
node scripts/provision.js --create     # creates the server
bash scripts/ship.sh <ip>              # copy the stack, build, start, wait for health
```

`provision.js` is idempotent and label-scoped: it reuses an existing
`souqi-deploy` firewall, refuses to create a second `souqi-deploy-1`, and only
ever touches resources tagged `platform=souqi`. Cloud-init turns off password
auth, enables ufw, and caps container log size before Docker starts.

The default is `cx32` — 4 vCPU / 8GB / 80GB, which is what the capacity numbers
below assume. `cx22` is about half the price and fits roughly four apps rather
than ten; `provision.js` says so in the plan if you pick it.

Between provision and ship, point DNS at the new IP:

```
*.yourdomain.com   A   <server ip>
```

`ship.sh` refuses to run until `preflight.js` and both verify suites pass, so a
localhost `APP_DOMAIN`, a reused secret, or `ALLOW_DEV_AUTH=1` never reaches a
public host. `.env` is built and checked locally and copied with mode 600 —
secrets are never generated on the server.

## Going somewhere else

`provision.js` is Hetzner-only — it talks to their API to create the server,
and hands it a cloud-init that hardens it. Everything after that is provider
agnostic: `ship.sh` only needs an IP and a host with Docker on it.

So on OVH, netcup, or a box you already have, buy the server in the web
console and run the cloud-init half yourself:

```bash
bash scripts/prepare-host.sh <ip>          # what cloud-init does, over ssh
bash scripts/ship.sh <ip>                  # unchanged from here on
```

`prepare-host.sh` creates nothing and costs nothing. It installs Docker and
the compose plugin from Docker's own apt repository — a stock Ubuntu image
has neither, where Hetzner's `docker-ce` image has both — then applies the
identical hardening: password auth off, root login key-only, ufw down to 22
/ 80 / 443, container log rotation, and the `10.200.0.0/16` address pool
that stops Docker running out of networks at ~31 deployments.

It is idempotent, and it reports without touching anything if you ask:

```bash
SSH_USER=ubuntu bash scripts/prepare-host.sh <ip>     # non-root login
bash scripts/prepare-host.sh <ip> --check             # report only
```

One thing to size for: the capacity numbers below assume 8GB and 80GB, which
is `cx32`. Match the RAM or `MAX_CONTAINERS` is optimistic; a smaller disk is
survivable but images and logs are what fill it, in that order.

Caddy issues a certificate per hostname on first request, gated by
`/internal/tls-ask` so only real deployments get one — without that gate,
anyone pointing DNS at the box could make it request certificates on their
behalf and burn the rate limit.

## Backups

```bash
bash scripts/backup.sh                 # dump, verify, prune past 14 days
bash scripts/backup.sh --install-cron  # nightly 03:15
bash scripts/backup.sh --restore <file>
```

Every dump is checked for a valid gzip stream and the `dump complete` marker
before it is given its final name, because a truncated file that looks like a
backup is worse than no backup at all.

This covers the database — who owns which app and how it runs. Restoring it and
re-deploying rebuilds every app. It does **not** cover user source, which is
still staged on the VM, and the dumps land on the same disk as the database, so
copy them off the box before treating this as disaster recovery.

## Sessions

The deploy plane verifies the **same `sq_session` JWT the main app issues** —
same secret, same claims — so being signed in to Souqi means being signed in
here. No second identity system, no second login.

A JWT cannot answer one question on its own: whether the session has since
been revoked. "Sign out other sessions" works by bumping a per-user
`sessionEpoch` in Mongo, which this service does not have. So it asks the main
app at `AUTH_INTROSPECT_URL` and caches the answer for 60 seconds.

**When that endpoint is unreachable, reads continue and mutations are refused.**
That split is deliberate. Failing the whole plane on a main-app blip is a
worse outage than the risk it prevents; quietly letting a revoked token start
containers is exactly what revocation exists to stop. Capability degrades,
identity does not.

Leaving `AUTH_INTROSPECT_URL` unset is supported and means signature-and-expiry
only — a revoked token then keeps working until it expires, up to 12 hours.

Two boot guards are **fatal**, not warnings:

- `JWT_SECRET` unset or still the dev default, under `NODE_ENV=production`
- `ALLOW_DEV_AUTH=1` under `NODE_ENV=production`

Both mean anyone can deploy as anyone, so the API refuses to start rather than
serve while broken.

## Capacity

Ten clients on one VM is the target, **not a guarantee**. Admission control
refuses a deploy when memory is over 80%, disk is over 80%, the container
count is at its limit, or committed memory would pass 1.5× physical.
Refusing with a reason beats accepting and letting the OOM killer pick a
victim — which, on a shared box, is usually somebody else.

`GET /capacity` reports the live numbers.

## Not built yet

- **Source archives are staged on the VM.** `deployments.source_key` and the
  `S3_*` config exist; the upload path does not. Until it does, a lost VM is
  lost source.
- **The scheduler.** `hosts` and `deployments.host_id` are already in the
  schema, and `ComputeProvider` is the interface it will use, but placement
  is hardcoded to `local`.
- **Off-site backup copies.** `scripts/backup.sh` dumps and verifies, but the
  files sit on the same disk as the database.
