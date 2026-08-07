/* =================================================================
   daytona-runtime-test.js — the pure logic, no sandbox, no network
   -----------------------------------------------------------------
   Everything else in daytona-runtime.js needs a real sandbox (proven
   live in codeagent-phase1-demo.js and codeagent-phase5-demo.js) —
   but extractBodyText() is pure text processing and shouldn't need
   $0.01 of sandbox time just to prove a regex still works.

   Run: npm run test:daytona-runtime
   ================================================================= */
"use strict";
const assert = require("assert");
const { extractBodyText } = require("./lib/codeagent/runtimes/daytona-runtime");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

console.log("\n── extractBodyText ──────────────────────────────────");

check("extracts plain text from a simple body", () => {
  const html = "<html><head><title>x</title></head><body><h1>Hello</h1><p>World</p></body></html>";
  assert.strictEqual(extractBodyText(html), "Hello World");
});

check("a component that renders null -> empty string, not whitespace-that-looks-empty", () => {
  const html = "<html><body><div id=\"root\"></div>\n  \n</body></html>";
  assert.strictEqual(extractBodyText(html), "");
});

check("strips script and style contents, not just the tags", () => {
  const html = "<body><script>var x = 'this must not appear';</script><style>.a{color:red}</style><p>Real text</p></body>";
  const text = extractBodyText(html);
  assert.strictEqual(text, "Real text");
  assert.ok(text.indexOf("this must not appear") === -1);
});

check("decodes the common HTML entities Chromium's dump-dom actually emits", () => {
  const html = "<body><p>Tom &amp; Jerry &lt;3 &quot;friends&quot; &#39;forever&#39;</p></body>";
  assert.strictEqual(extractBodyText(html), "Tom & Jerry <3 \"friends\" 'forever'");
});

check("collapses whitespace from nested block elements into single spaces", () => {
  const html = "<body>\n  <div>\n    <h1>Title</h1>\n    <p>Para   with   gaps</p>\n  </div>\n</body>";
  assert.strictEqual(extractBodyText(html), "Title Para with gaps");
});

check("no <body> tag at all -> falls back to the whole string, still doesn't crash", () => {
  const html = "<div>fragment, no html wrapper</div>";
  assert.strictEqual(extractBodyText(html), "fragment, no html wrapper");
});

console.log("\n" + (failed === 0 ? "✓ ALL DAYTONA-RUNTIME TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
process.exit(failed === 0 ? 0 : 1);
