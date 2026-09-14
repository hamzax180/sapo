# backend

The Souqi application: Express, the code agent, the AI routing, and the tests.
`api/index.js` at the repo root requires this folder and nothing else, which is
how the same app runs as a Vercel function in production and as a plain server
locally.

## Run it

```bash
npm install && npm start
```

`http://localhost:4000`, serving both the API and the pages out of `frontend/`.
`npm run dev` is the same thing.

Configuration is `backend/.env` — copy `.env.example`. Note that `index.js`
loads it with an explicit path relative to its own directory, not the working
directory, so it works no matter where you start it from. Tests do the same.
That was a real bug once; the comment at the top of `index.js` names it.

```bash
npm run seed          # demo workspace and data
```

## Test it

```bash
npm test              # unit-test.js
npm run ci            # the full chain
```

Every suite is in `test/`, thirty-two of them, each a standalone script with
its own assert harness — no runner, no framework. `npm run test:<name>` runs
one. Most need neither network nor an API key; the ones that need a database
skip themselves when `MONGODB_URI` is unset, which is why they pin dotenv to an
explicit path rather than trusting the working directory.

Two suites are worth knowing by name:

- **`test/csp-test.js`** — asserts that `vercel.json` and `index.js` isolate
  exactly the same set of routes. It is the first thing to break if the two
  ever disagree about what the site serves, so run it after touching either.
- **`test/leak-test.js`** — path traversal and cross-tenant leakage. It throws
  if its probe files are missing rather than skipping, because a security test
  that cannot find its target has not passed, it has not run, and the two must
  not look the same.

### Known, and not yours

`npm run lint` exits 1: zero errors, 55 warnings, against a
`--max-warnings 50` budget. It has been over budget for a while and `ci.yml`
marks the step `continue-on-error`, which is why nothing noticed.

## Layout

| | |
|---|---|
| `index.js` | 131 routes — 99 under `/api`, the rest auth, published sites, payments, pages |
| `db.js`, `db-adapters.js` | the master connection; per-workspace Mongo or Postgres |
| `middleware/` | auth, captcha, rate limit, request id, request log, security headers |
| `lib/` | the domain — projects, stripe, composer, uploads, github, vercel, deployplane |
| `lib/ai/` | one adapter, three routes, all pointed at DeepSeek |
| `lib/codeagent/` | the agent: model loop, tools, runtimes, the scaffold |
| `lib/nlu/` | intent classification with no API call |
| `data/` | archetypes, copy corpus, products, classifier training sets |
| `scripts/` | build and train steps, never run at request time |
| `test/`, `demos/` | excluded from the Vercel bundle by `.vercelignore` |

## Things that will bite you

**Only `/api/*`, `/auth/*` and `/s/*` reach this app in production.** Every
other path is a static file from `frontend/`, or a 404 at the edge. The generic
CRUD routes and the page fallback in `guard()` exist here but cannot run on
`souqi.site`. A 404 from production means "not routed here", not "refused".

**Dependencies are declared twice.** The root `package.json` exists so Vercel
resolves the function's dependencies from the repo root, and it duplicates this
file's list plus `archiver`. Anything added here and not mirrored there will
work locally and 500 in production.

**`lib/codeagent/scaffold-data.json` is generated and can drift.**
`node scripts/build-scaffold-data.js` regenerates it from `lib/codeagent/scaffold/`.
There is no CI check, so nothing will tell you. `test/scaffold-contract-test.js`
is what catches it.

**`lib/codeagent/scaffold-files.js` must keep its static require.**
`require("./scaffold-data.json")`, that literal specifier, or Vercel's bundler
stops tracing the file and every deployed app builds an empty `dist`. The long
comment in `.vercelignore` explains why the directory is excluded and the blob
is not.

## More

[Architecture](../docs/ARCHITECTURE.md) ·
[How it works](../docs/HOW-IT-WORKS.md) ·
[Deploying](../docs/DEPLOYING.md) ·
[Repo map](../docs/REPO-MAP.md)
