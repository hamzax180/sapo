# Where things are

```
souqi/
├── api/index.js         The Vercel function. One line: it requires backend/index.js.
├── backend/             The application. Express, the code agent, the AI routing.
│   ├── index.js           Every route, ~6,900 lines. Also the listen/export gate.
│   ├── db.js              The master MongoDB connection.
│   ├── db-adapters.js     Per-workspace storage, Mongo or Postgres.
│   ├── middleware/        auth, rbac-adjacent guards, rate limit, captcha, headers, request id/log.
│   ├── lib/               The domain. projects, stripe, composer, uploads, github, vercel…
│   │   ├── ai/              One adapter, three routes, all pointed at DeepSeek.
│   │   ├── codeagent/       The agent: model loop, tools, runtimes, scaffold.
│   │   ├── nlu/             Intent without an API call. Generated model included.
│   │   ├── copy/ design/ refine/ storage/
│   ├── data/              Archetypes, copy corpus, product sets, classifier training sets.
│   ├── scripts/           Build and train steps. Not run at request time.
│   ├── test/              Every suite. `npm run ci` from backend/.
│   └── demos/             Phase walkthroughs and a dev verify harness.
├── frontend/            What gets served. No build step — the files ship as they are.
│   ├── *.html             Sixteen pages. URL is the filename without .html.
│   ├── js/                Shared UI, voice input, the WebContainer runtime.
│   ├── assets/
│   └── styles/
│       ├── tokens.css       Motion and elevation. Ten pages link it.
│       ├── base.css         The entrance animation. Twelve pages link it.
│       ├── components/      site-footer, upgrade-modal.
│       └── pages/           One per HTML page.
├── infra/deploy/        The container plane. Its own app, its own machine.
│   ├── src/               api, worker, docker engine, caddy proxy, providers, monitors.
│   ├── db/                Schema for the platform cluster and the customer cluster.
│   ├── scripts/           ship, provision, prepare-host, migrate, backup, verify, preflight.
│   └── docker-compose.yml The whole stack, heavily commented.
├── docs/                This, plus HOW-IT-WORKS, ARCHITECTURE, DEPLOYING, and archive/.
└── .github/workflows/   CI. Runs in backend/. Does not touch infra/.
```

## Two rules that are not obvious from the tree

**`api/` cannot move.** Vercel discovers serverless functions at `<root>/api/`
and nowhere else, and `vercel.json` names `api/index.js` by path. It is a shim
so that the same Express app runs as a function in production and as a server
locally.

**`frontend/` is named in exactly one place.** `vercel.json` has
`outputDirectory`, and `backend/index.js` has a single `PUBLIC_DIR` constant
that every page route and the static mount read. It used to be spelled out at
twenty-two send sites, which is why it is a constant now.

## Things that are generated, not written

Do not hand-edit these. Each has a script beside it.

| File | Made by |
|---|---|
| `backend/lib/nlu/industry-model.json` | `node scripts/train-classifier.js` (`npm run train:nlu`) |
| `backend/lib/codeagent/scaffold-data.json` | `node scripts/build-scaffold-data.js` — manual, with no CI check, so it can drift from `scaffold/` |

`backend/lib/block-schema.json` used to be generated too. Its generator read
`public/js/portals/`, which was deleted with the block editor, so the file is
now maintained by hand. `lib/site-validate.js` still validates against it.
