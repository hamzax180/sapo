/* =================================================================
   preflight-test.js — lib/codeagent/preflight.js, no network, no browser
   -----------------------------------------------------------------
   Every case below is a build that really shipped, or a false positive
   that would have cost a repair round if it fired. The second kind
   matters as much as the first: preflight runs BEFORE the compile and
   can pre-empt it, so an error it invents is a round the model spends
   fixing code that was already correct.

   Run: npm run test:preflight
   ================================================================= */
"use strict";
const assert = require("assert");
const { preflight } = require("../lib/codeagent/preflight");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}
const codes = (list) => list.map((e) => e.code).sort();

console.log("\n── imports that do not resolve ────────");

/* build-parser-client.js: "the single most common way a generated app
   fails to build: the model imports a helper it then forgets to write." */
check("an import of a file that was never written is hard", () => {
  const r = preflight({
    "src/App.tsx": 'import { total } from "./lib/helpers";\nexport default function App(){ return <p>{total()}</p>; }'
  });
  assert.deepStrictEqual(codes(r.hard), ["UNRESOLVED_IMPORT"]);
  assert.match(r.hard[0].message, /\.\/lib\/helpers/);
  assert.strictEqual(r.hard[0].file, "src/App.tsx");
  assert.strictEqual(r.hard[0].line, 1);
});

check("an import that resolves to a written sibling passes", () => {
  const r = preflight({
    "src/App.tsx": 'import Header from "./components/Header";\nexport default function App(){ return <Header/>; }',
    "src/components/Header.tsx": "export default function Header(){ return <h1>hi</h1>; }"
  });
  assert.deepStrictEqual(r.hard, []);
});

/* The prompt MANDATES importing this file and PROTECTED_PATHS forbids
   writing it, so preflight folding in the scaffold is what stops every
   shop the model builds from failing on a correct import. */
check("the scaffold's own payments module resolves", () => {
  const r = preflight({
    "src/App.tsx": 'import { checkout } from "./lib/payments";\nexport default function App(){ return null; }'
  });
  assert.deepStrictEqual(r.hard, []);
});

check("../ climbs out of a subdirectory correctly", () => {
  const r = preflight({
    "src/components/Card.tsx": 'import { fmt } from "../lib/money";\nexport const Card = () => null;',
    "src/lib/money.ts": "export const fmt = (n: number) => String(n);"
  });
  assert.deepStrictEqual(r.hard, []);
});

console.log("\n── packages that are not installed ────────");

check("lucide-react is refused with the reason, not a resolve error", () => {
  const r = preflight({
    "src/App.tsx": 'import { Scissors } from "lucide-react";\nexport default function App(){ return <Scissors/>; }'
  });
  assert.deepStrictEqual(codes(r.hard), ["PACKAGE_NOT_INSTALLED"]);
  assert.match(r.hard[0].message, /not installed and cannot be/);
});

check("react and react-dom subpaths are allowed", () => {
  const r = preflight({
    "src/App.tsx": [
      'import { useState } from "react";',
      'import { createRoot } from "react-dom/client";',
      "export default function App(){ return null; }"
    ].join("\n")
  });
  assert.deepStrictEqual(r.hard, []);
});

console.log("\n── pages the nav promises ────────");

check("a nav link to a page nobody wrote is soft, not hard", () => {
  const r = preflight({
    "index.html": '<!doctype html><html><body><nav><a href="menu.html">Menu</a></nav></body></html>'
  });
  assert.deepStrictEqual(codes(r.soft), ["MISSING_PAGE"]);
  assert.deepStrictEqual(r.hard, [], "a dead link still compiles, so it must not pre-empt the build");
  assert.match(r.soft[0].message, /menu\.html/);
});

check("a link to a page that exists passes", () => {
  const r = preflight({
    "index.html": '<a href="/menu.html">Menu</a>',
    "menu.html": "<!doctype html><html><body>menu</body></html>"
  });
  assert.deepStrictEqual(r.soft, []);
});

check("external, mailto and anchor links are not pages", () => {
  const r = preflight({
    "index.html": [
      '<a href="https://instagram.com/x">IG</a>',
      '<a href="mailto:a@b.co">Mail</a>',
      '<a href="#top">Top</a>',
      '<a href="tel:+905551234567">Call</a>'
    ].join("\n")
  });
  assert.deepStrictEqual(r.soft, []);
});

console.log("\n── precision: errors it must NOT invent ────────");

/* An unanchored /from ["']/ matches prose. A false unresolved-import
   spends a repair round demanding a fix to correct code. */
check("the word from inside a comment or string is not an import", () => {
  const r = preflight({
    "src/App.tsx": [
      "// adapted from \"./old/Thing\" before the rewrite",
      'const note = `imported from "./nowhere" originally`;',
      "export default function App(){ return <p>{note}</p>; }"
    ].join("\n")
  });
  assert.deepStrictEqual(r.hard, [], "matched a string or a comment as an import");
});

/* Vite gives every module its own scope, so this is legal there. Only
   the srcdoc flattener ever had a problem with it, and it renames them
   itself now. Reporting it would spend a round on a non-defect. */
check("two modules declaring the same name is not reported", () => {
  const r = preflight({
    "src/App.tsx": 'import H from "./h";\nconst toneClasses = 1;\nexport default function App(){ return <H/>; }',
    "src/h.tsx": "const toneClasses = 2;\nexport default function H(){ return <i>{toneClasses}</i>; }"
  });
  assert.deepStrictEqual(r.hard, []);
  assert.deepStrictEqual(r.soft, []);
});

check("a scaffold file the model never touched is not blamed", () => {
  const r = preflight({});
  assert.deepStrictEqual(r.hard, []);
  assert.deepStrictEqual(r.soft, []);
});

check("the same missing file twice in one file is reported once", () => {
  const r = preflight({
    "src/App.tsx": [
      'import { a } from "./lib/gone";',
      'import { b } from "./lib/gone";',
      "export default function App(){ return <p>{a}{b}</p>; }"
    ].join("\n")
  });
  assert.strictEqual(r.hard.length, 1);
});

console.log("\n" + (failed === 0 ? "✓ ALL PREFLIGHT TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
process.exit(failed === 0 ? 0 : 1);
