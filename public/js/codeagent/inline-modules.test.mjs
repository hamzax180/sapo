/* Run: node public/js/codeagent/inline-modules.test.mjs
   No framework on purpose — it mirrors deploy/scripts/verify*.js, which
   assert what the code WOULD do rather than needing a browser. */
import assert from "node:assert";
import { inlineModules } from "./inline-modules.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}

// The exact shape the model generates: an App importing six components.
const files = {
  "src/App.tsx": [
    'import React, { useState } from "react";',
    'import Header from "./components/Header";',
    'import Hero from "./components/Hero";',
    'import { formatDate } from "./lib/date";',
    'import "./index.css";',
    'export default function App() {',
    '  return <div><Header /><Hero /></div>;',
    '}'
  ].join("\n"),
  "src/components/Header.tsx": [
    'import { Camera } from "lucide-react";',
    'export default function Header() { return <h1><Camera /></h1>; }'
  ].join("\n"),
  "src/components/Hero.tsx": [
    'import React from "react";',
    'const Hero = () => <section>hero</section>;',
    'export default Hero;'
  ].join("\n"),
  "src/lib/date.ts": 'export function formatDate(d) { return String(d); }',
  "src/index.css": "body{}"
};

const r = inlineModules("src/App.tsx", files);

check("no import statement survives", () =>
  assert.ok(!/(^|\n)\s*import\s/.test(r.code), "an import survived:\n" + r.code));

check("no export statement survives", () =>
  assert.ok(!/(^|\n)\s*export\s/.test(r.code), "an export survived"));

check("every reachable module is included", () => {
  ["src/lib/date.ts", "src/components/Header.tsx", "src/components/Hero.tsx", "src/App.tsx"]
    .forEach((m) => assert.ok(r.modules.includes(m), "missing " + m));
});

check("dependencies come before the module that uses them", () => {
  assert.ok(r.modules.indexOf("src/components/Header.tsx") < r.modules.indexOf("src/App.tsx"));
  assert.ok(r.modules.indexOf("src/lib/date.ts") < r.modules.indexOf("src/App.tsx"));
});

check("react hooks are destructured exactly once", () => {
  const n = (r.code.match(/=\s*React;/g) || []).length;
  assert.strictEqual(n, 1, "expected 1 React destructure, got " + n);
  assert.ok(/useState/.test(r.code), "useState was not collected");
});

check("lucide icons are collected from a nested module", () =>
  assert.ok(/const \{ Camera \} = window\.LucideReact/.test(r.code), r.code.slice(0, 200)));

check("a matching default name is NOT re-declared", () => {
  // Header.tsx declares `function Header`; App imports it as `Header`.
  // Emitting `const Header = ...` too would be a SyntaxError.
  assert.strictEqual((r.code.match(/\bconst Header\b/g) || []).length, 0);
  assert.ok(/function Header\b/.test(r.code));
});

check("an arrow default export is bound and reachable", () => {
  assert.ok(/const Hero = \(\) =>/.test(r.code), "Hero declaration missing");
});

check("the output is valid JS once JSX is compiled away", () => {
  const plain = r.code.replace(/<[^>]*\/>/g, "null").replace(/<(\w+)>[\s\S]*?<\/\1>/g, "null");
  new Function(plain.replace(/\bReact\b/g, "({})").replace(/window\./g, "globalThis."));
});

check("a missing file is reported, not silently empty", () => {
  const r2 = inlineModules("src/App.tsx", { "src/App.tsx": 'import X from "./nope";\nexport default function App(){}' });
  assert.ok(r2.warnings.some((w) => /cannot resolve/.test(w)), JSON.stringify(r2.warnings));
});

check("a circular import is broken and reported", () => {
  const r3 = inlineModules("src/a.tsx", {
    "src/a.tsx": 'import B from "./b";\nexport default function A(){}',
    "src/b.tsx": 'import A from "./a";\nexport default function B(){}'
  });
  assert.ok(r3.warnings.some((w) => /circular/.test(w)), JSON.stringify(r3.warnings));
});

check("a duplicate top-level name is reported", () => {
  const r4 = inlineModules("src/App.tsx", {
    "src/App.tsx": 'import H from "./h";\nconst styles = 1;\nexport default function App(){}',
    "src/h.tsx": 'const styles = 2;\nexport default function H(){}'
  });
  assert.ok(r4.warnings.some((w) => /more than one module/.test(w)), JSON.stringify(r4.warnings));
});

console.log("\n  " + (fail ? "FAILED " + fail + " of " + (pass + fail) : "all " + pass + " checks passed"));
process.exit(fail ? 1 : 0);
