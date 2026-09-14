/* =================================================================
   ownership-test.js — no project route resolves without deciding
   -----------------------------------------------------------------
   resolveProject() answers "which project is this key", not "may you
   have it". For a slug it happens to answer both, because findBySlug
   filters on the owner; for a `pr_` id it is a bare primary-key read.
   Every caller therefore owes it an ownership decision immediately
   after, and three of them did not: POST /api/security/scan/:key,
   GET /api/security/scan/:key/details and GET /api/projects/:key/thumb
   each returned another account's data to a request carrying no cookie
   and no token at all.

   This is a LINT, not a proof — it checks that each call site decides
   ownership, not that it decides correctly. The proof that the decision
   is right lives in cross-owner-test.js, which asks a real server for a
   real stranger's project. What this file buys is that the next route
   added to index.js cannot repeat the same omission unnoticed.
   ================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const lines = SRC.split(/\r?\n/);

/* How far after the resolve an ownership decision may sit. Every current
   call site decides on the line after the 404; the claim route needs a few
   more because it distinguishes "yours already" from "unclaimed, so
   claimable". Twelve is generous enough for both and still short enough
   that a decision buried under real work does not count. */
const WINDOW = 12;

/* The two shapes an ownership decision takes in this file. The first is the
   idiom; the second is the claim route, which computes the same conclusion
   from ownerUserId/ownerAnonId by hand because it must accept a project it
   does not yet own. Both end in the same refusal, so match on that. */
const DECIDES = /projects\.owns\(|not your project/;

let failures = 0;
let checked = 0;

lines.forEach((line, i) => {
  if (!/\bresolveProject\s*\(/.test(line)) return;
  if (/^\s*(\*|\/\/)/.test(line)) return;              // a mention in a comment
  if (/^async function resolveProject/.test(line)) return;  // the definition itself
  checked++;

  const window = lines.slice(i + 1, i + 1 + WINDOW).join("\n");
  if (DECIDES.test(window)) return;

  failures++;
  console.log("  ✗ index.js:" + (i + 1) + " resolves a project and never decides ownership");
  console.log("      " + line.trim());
});

if (!checked) {
  console.log("\n✗ ownership-test found no resolveProject() call sites — has index.js moved?\n");
  process.exit(1);
}

if (failures) {
  console.log("\n✗ " + failures + " of " + checked + " project lookups do not check ownership.");
  console.log("  Add, on the line after the 404:");
  console.log("      if (!projects.owns(project, owner)) return res.status(403).json({ error: \"not your project\" });\n");
  process.exit(1);
}

console.log("  ✓ all " + checked + " resolveProject() call sites decide ownership");
console.log("\n✓ OWNERSHIP LINT PASSED\n");
