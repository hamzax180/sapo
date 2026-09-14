/* =================================================================
   diffstat-test.js — the numbers on the build card

   These are shown to someone deciding whether to read a file, so the
   property that matters is not "close enough": a small edit must not
   report as a rewrite, or the count is noise with a plus sign on it.

   Run: node server/diffstat-test.js
   ================================================================= */
"use strict";
const assert = require("assert");
const { diffStat, statsFor } = require("../lib/codeagent/diffstat");

let passed = 0;
function ok(name, fn) {
  try { fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

const L = (...xs) => xs.join("\n");

console.log("\ncounting what changed");

ok("a new file is all additions and says it is new", () => {
  assert.deepStrictEqual(diffStat(undefined, L("a", "b", "c")), { added: 3, removed: 0, isNew: true });
  assert.deepStrictEqual(diffStat(undefined, ""), { added: 0, removed: 0, isNew: true });
});

ok("an unchanged file counts nothing", () => {
  assert.deepStrictEqual(diffStat(L("a", "b"), L("a", "b")), { added: 0, removed: 0, isNew: false });
});

ok("a one-line edit is +1 -1, not a rewrite", () => {
  // The whole point of the LCS: the surrounding lines are common, so they
  // must not be counted. A naive length comparison reports 0/0 here, and a
  // naive "everything between head and tail" reports the file.
  const before = L("import x", "const a = 1;", "const b = 2;", "export default a;");
  const after  = L("import x", "const a = 1;", "const b = 9;", "export default a;");
  assert.deepStrictEqual(diffStat(before, after), { added: 1, removed: 1, isNew: false });
});

ok("a pure append adds and removes nothing", () => {
  assert.deepStrictEqual(diffStat(L("a", "b"), L("a", "b", "c", "d")), { added: 2, removed: 0, isNew: false });
});

ok("a pure deletion removes and adds nothing", () => {
  assert.deepStrictEqual(diffStat(L("a", "b", "c"), L("a", "c")), { added: 0, removed: 1, isNew: false });
});

ok("an insertion in the middle does not count the tail twice", () => {
  const before = L("a", "b", "c", "d", "e");
  const after  = L("a", "b", "X", "Y", "c", "d", "e");
  assert.deepStrictEqual(diffStat(before, after), { added: 2, removed: 0, isNew: false });
});

ok("a trailing newline is a terminator, not an extra line", () => {
  // Without the trim, every file reports one more line than an editor shows
  // and "no change" becomes "+1 -1" the moment one side has the newline.
  assert.deepStrictEqual(diffStat("a\nb\n", "a\nb\n"), { added: 0, removed: 0, isNew: false });
  assert.strictEqual(diffStat(undefined, "a\nb\n").added, 2);
});

ok("a full rewrite counts both sides", () => {
  assert.deepStrictEqual(diffStat(L("a", "b", "c"), L("x", "y")), { added: 2, removed: 3, isNew: false });
});

ok("moving a block is not free, but it is not the whole file either", () => {
  const before = L("h1", "h2", "A", "B", "t1", "t2");
  const after  = L("h1", "h2", "t1", "t2", "A", "B");
  const d = diffStat(before, after);
  assert.ok(d.added <= 2 && d.removed <= 2, "a two-line move reported " + JSON.stringify(d));
});

console.log("\nit stays cheap on a big file");

ok("a large file with a small edit is fast and still exact", () => {
  const base = [];
  for (let i = 0; i < 6000; i++) base.push("line " + i);
  const before = base.join("\n");
  const copy = base.slice(); copy[3000] = "CHANGED";
  const t0 = Date.now();
  const d = diffStat(before, copy.join("\n"));
  const ms = Date.now() - t0;
  /* 6000x6000 would be 36M cells, well past the cap — but head/tail
     trimming reduces this to a 1x1 middle, so the cap is never reached and
     the answer stays exact. That is the whole reason for trimming first. */
  assert.deepStrictEqual(d, { added: 1, removed: 1, isNew: false });
  assert.ok(ms < 500, "took " + ms + "ms");
});

ok("two big unrelated files fall back rather than hanging", () => {
  const a = [], b = [];
  for (let i = 0; i < 3000; i++) { a.push("a" + i); b.push("b" + i); }
  const t0 = Date.now();
  const d = diffStat(a.join("\n"), b.join("\n"));
  const ms = Date.now() - t0;
  // Over the cap: coarse, and coarse in the safe direction — it can only
  // over-state the change, never claim a rewrite was a small edit.
  assert.deepStrictEqual(d, { added: 3000, removed: 3000, isNew: false });
  assert.ok(ms < 500, "took " + ms + "ms");
});

console.log("\na whole build");

ok("statsFor pairs every call with the tree it started from", () => {
  const base = { "src/App.tsx": L("one", "two", "three") };
  const calls = [
    { path: "src/App.tsx", content: L("one", "TWO", "three") },
    { path: "src/New.tsx", content: L("a", "b") }
  ];
  assert.deepStrictEqual(statsFor(calls, base), [
    { path: "src/App.tsx", added: 1, removed: 1, isNew: false },
    { path: "src/New.tsx", added: 2, removed: 0, isNew: true }
  ]);
});

ok("a first build has no base tree and every file is new", () => {
  const s = statsFor([{ path: "index.html", content: L("<!doctype html>", "<html>") }], undefined);
  assert.strictEqual(s[0].isNew, true);
  assert.strictEqual(s[0].added, 2);
});

console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
