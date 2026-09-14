<div align="center">

<img src="frontend/assets/logo.png" width="80" alt="Souqi" />

# Souqi

**Describe an app. Watch it get built, and put it online.**

[![Vercel](https://img.shields.io/badge/Platform-Vercel-black?logo=vercel)](https://vercel.com)
[![Node.js](https://img.shields.io/badge/Runtime-Node.js%2020-green?logo=node.js)](https://nodejs.org)
[![MongoDB](https://img.shields.io/badge/Data-MongoDB-47A248?logo=mongodb&logoColor=white)](https://mongodb.com)
[![Docker](https://img.shields.io/badge/Deploy%20plane-Docker%20%2B%20Caddy-2496ED?logo=docker&logoColor=white)](https://docker.com)

[**souqi.site**](https://souqi.site) &nbsp;·&nbsp; [How it works](docs/HOW-IT-WORKS.md) &nbsp;·&nbsp; [Architecture](docs/ARCHITECTURE.md) &nbsp;·&nbsp; [Deploying](docs/DEPLOYING.md) &nbsp;·&nbsp; [Repo map](docs/REPO-MAP.md)

</div>

---

You type what you want. An agent writes real React and TypeScript, builds it in
your browser, shows you the result, and repairs it when the build fails. When
you are happy with it, it goes online — either as a published page on
`souqi.site/s/<slug>`, or as a container on a machine with its own domain,
TLS and database.

Two products, one repository:

- **Souqi Code** — the agent. Prompt, plan, build, preview, publish.
- **The deploy plane** — Docker, Caddy and Postgres on a VPS, which is what
  turns a build into a running application with a URL of its own.

## Running it

```bash
cd backend && npm install && npm start
```

That serves the pages and the API on `http://localhost:4000`. You will need a
`backend/.env` — copy `backend/.env.example` and fill in at minimum a MongoDB
URI and an AI key. Without a key the pages render and the agent does not build.

```bash
cd backend && npm test
```

The plane is a separate stack with its own manifest:

```bash
cd infra/deploy && docker compose up
```

## The layout

| | |
|---|---|
| `backend/` | the application — Express, the agent, the AI routing, the tests |
| `frontend/` | what gets served — sixteen pages, no build step |
| `infra/deploy/` | the container plane, its own app on its own machine |
| `api/index.js` | the Vercel function; one line, requiring `backend/` |
| `docs/` | how it works, how it is shaped, how it ships |

[`docs/REPO-MAP.md`](docs/REPO-MAP.md) has the rest, including which files are
generated and must not be hand-edited.

## Deploying

**`git push` deploys nothing.** There are two targets and each has its own
command — see [`docs/DEPLOYING.md`](docs/DEPLOYING.md), which also covers how to
check that a deploy actually landed, because a page that loads is not evidence.

## A note on the docs

`docs/archive/` holds nine planning documents. They are history, kept for the
reasoning rather than the instructions — a single commit removed the storefront
and portal subsystem they were written against. Where a document and the code
disagree, the code is right.
