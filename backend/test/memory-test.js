/* =================================================================
   memory-test.js — lib/codeagent/memory.js, the keep/discard policy
   -----------------------------------------------------------------
   The whole value of this module is what it REFUSES to remember. A memory
   that keeps every build error is a growing block of noise injected into
   every future turn, costing context and teaching nothing — so most of
   these assert that something was dropped.

   Run: npm run test:memory
   ================================================================= */
"use strict";
const assert = require("assert");
const memory = require("../lib/codeagent/memory");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

const unresolved = { code: "UNRESOLVED_IMPORT", message: 'Cannot resolve "./lib/helpers" — that file does not exist.' };
const typo = { code: "TS2304", message: "Cannot find name 'Foo'" };

console.log("\n── what is worth keeping ────────────────");

check("a structural mistake is kept", () => {
  const m = memory.merge(null, [unresolved]);
  assert.strictEqual(m.lessons.length, 1);
  assert.strictEqual(m.lessons[0].code, "UNRESOLVED_IMPORT");
  assert.strictEqual(m.lessons[0].hits, 1);
});

/* A typo carries nothing into next week, and a list of them is noise that
   costs context on every future turn. */
check("an ordinary type error is not", () => {
  assert.strictEqual(memory.merge(null, [typo]), null);
  assert.ok(!memory.isStructural(typo));
});

check("a project that has never erred stores nothing", () => {
  assert.strictEqual(memory.merge(null, []), null);
  assert.strictEqual(memory.merge(null, [typo, typo]), null);
});

console.log("\n── counting, which is the point ─────────");

/* Keyed on code rather than message: the message names THIS instance, so
   keying on it stores one lesson per filename and never shows a count. */
check("the same kind of mistake twice counts, it does not duplicate", () => {
  const first = memory.merge(null, [unresolved]);
  const second = memory.merge(first, [
    { code: "UNRESOLVED_IMPORT", message: 'Cannot resolve "./components/Hero" — that file does not exist.' }
  ]);
  assert.strictEqual(second.lessons.length, 1, "stored one lesson per filename");
  assert.strictEqual(second.lessons[0].hits, 2);
  assert.match(second.lessons[0].message, /Hero/, "the most recent example should be the one shown");
});

check("the most repeated comes first and the tail is what gets dropped", () => {
  let m = null;
  for (let i = 0; i < 4; i++) m = memory.merge(m, [unresolved]);
  m = memory.merge(m, [{ code: "MISSING_PAGE", message: "menu.html was never written" }]);
  assert.strictEqual(m.lessons[0].code, "UNRESOLVED_IMPORT");
  assert.strictEqual(m.lessons[0].hits, 4);
});

check("the list cannot grow without bound", () => {
  let m = null;
  for (const code of Array.from(memory.STRUCTURAL)) m = memory.merge(m, [{ code, message: code + " happened" }]);
  m = memory.merge(m, [{ code: "UNRESOLVED_IMPORT", message: "again" }]);
  assert.ok(m.lessons.length <= memory.MAX_LESSONS, "grew to " + m.lessons.length);
});

check("merging never mutates what it was given", () => {
  const before = memory.merge(null, [unresolved]);
  const snapshot = JSON.stringify(before);
  memory.merge(before, [unresolved]);
  assert.strictEqual(JSON.stringify(before), snapshot, "the caller's object was edited in place");
});

console.log("\n── what a later turn reads ──────────────");

check("nothing to say produces no block at all", () => {
  assert.strictEqual(memory.promptBlock(null), "");
  assert.strictEqual(memory.promptBlock({ lessons: [] }), "");
});

check("a repeated lesson says how often", () => {
  let m = memory.merge(null, [unresolved]);
  m = memory.merge(m, [unresolved]);
  const block = memory.promptBlock(m);
  assert.match(block, /has happened 2 times/);
  assert.match(block, /lib\/helpers/);
});

check("a single occurrence is not padded with a count", () => {
  const block = memory.promptBlock(memory.merge(null, [unresolved]));
  assert.ok(!/has happened/.test(block), "a count of one is noise: " + block);
});

console.log("\n" + (failed === 0 ? "✓ ALL MEMORY TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
process.exit(failed === 0 ? 0 : 1);
