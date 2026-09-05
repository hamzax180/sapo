/* =================================================================
   retitle-projects.js — give existing projects the names they'd get today
   -----------------------------------------------------------------
   Projects created before titleFromPrompt() were titled `prompt.slice(0, 60)`
   — the raw first message, cut mid-word. This re-derives every one of them
   from the prompt that is still stored beside it, so the fix reaches the
   projects that already exist and not only the next one.

   Nothing is lost: `prompt` is untouched and is the only input, so a bad
   result can be re-derived or reverted from the same field.

   Dry run by default. Pass --write to actually update.

     node scripts/retitle-projects.js            # preview
     node scripts/retitle-projects.js --write    # apply
   ================================================================= */
"use strict";

// Explicit path, the same one server/index.js uses: run from anywhere
// and it still finds the connection string.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "server", ".env") });

const { connect, getMasterDb } = require("../server/db");
const { titleFromPrompt } = require("../server/lib/projects");

const WRITE = process.argv.includes("--write");

(async () => {
  await connect();
  const db = getMasterDb();
  if (!db) throw new Error("no database — is MONGODB_URI set?");

  const rows = await db.collection("projects")
    .find({}, { projection: { _id: 1, id: 1, slug: 1, title: 1, prompt: 1 } })
    .toArray();

  const changes = [];
  for (const r of rows) {
    if (!r.prompt) continue;                        // nothing to derive from
    const next = titleFromPrompt(r.prompt);
    if (next && next !== r.title) changes.push({ _id: r._id, from: r.title, to: next });
  }

  const w = Math.min(52, changes.reduce((m, c) => Math.max(m, (c.from || "").length), 0));
  for (const c of changes) {
    console.log("  " + String(c.from || "").slice(0, w).padEnd(w) + "  ->  " + c.to);
  }
  console.log("\n  %d of %d projects would change.", changes.length, rows.length);

  if (!WRITE) {
    console.log("  Dry run. Re-run with --write to apply.");
  } else {
    for (const c of changes) {
      await db.collection("projects").updateOne({ _id: c._id }, { $set: { title: c.to } });
    }
    console.log("  Written.");
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
