# Archive

These are kept because they record why things are the way they are, not
because they describe the system. Read them as history. Where one of them
disagrees with the code, the code is right.

Most of them were invalidated by a single commit. `0234221` — titled, with
some understatement, "Stop publishing the owner's email on the checkout
page" — deleted about twenty thousand lines: the whole storefront and
portal subsystem, the block engine, the on-page editor, and the browser
data layer under `public/js/`. Six of the documents below are built on files
that commit removed.

| Document | What it was | Why it is here |
|---|---|---|
| `ARCHITECTURE-PLAN.md` | A security and data-flow audit, sixteen sections | Grounded in `store.js`, `views.js` and `portal.html`. Its §7 and §8 audit the portal and the live editor, which no longer exist. The line numbers it cites point into deleted files. |
| `CODE-AGENT-PLAN.md` | The plan that produced Souqi Code | Largely built. Its §5 designs the sandbox around Daytona, retired in `4f3a213` for the in-browser WebContainer, and it still refers to `agent.html`. |
| `AI-PROVIDER-PLAN.md` | Routing prose to Gemini and JSON to DeepSeek | The split is gone. `d48f2f4` put every route on DeepSeek. The document even carries a dated reminder to update a Gemini price that is no longer paid. |
| `AI-BUILDER-PLAN.md` | Build-a-storefront-by-prompting | Its north star was a rendered storefront of typed blocks. The product generates React and HTML source instead. Self-marked superseded at line 10. |
| `NO-API-BUILDER-PLAN.md` | Beating the competition with no AI API at all | The opposite of what shipped. The NLU machinery it describes does survive, in `backend/lib/nlu/`. |
| `AGENT-PARITY-PLAN.md` | Fixing an agent with no memory, no project, no URL | All three were fixed. Projects, revisions and `/s/:slug` exist. |
| `AGENT-GAP-AUDIT.md` | A gap audit dated 2026-08-05 | Audits a branch and a claim flow that have both been rebuilt. |
| `EDITOR-PLAN.md` | Rebuilding the visual editor | Every one of the five files it cites was deleted. Nothing in it is actionable. |
| `MONGODB-SETUP.md` | Connecting to a real MongoDB | Its premise is a "demo mode" where the browser read and wrote `localStorage` through `public/js/store.js`. That file and that data layer are gone. The environment variables in its later sections may still hold. |

For how the system works now, see [`../HOW-IT-WORKS.md`](../HOW-IT-WORKS.md),
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) and
[`../DEPLOYING.md`](../DEPLOYING.md).
