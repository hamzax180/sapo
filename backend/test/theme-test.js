/* =================================================================
   The per-build design system.

   The claim being tested is a strong one — that a generated site is never
   inaccessible because accessibility here is computed rather than judged —
   so the central test runs every palette this module can produce and
   asserts the measured contrast, rather than spot-checking one.

   Run: node server/theme-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const theme = require("../lib/codeagent/theme");
const palette = require("../lib/design/palette");

let passed = 0;
function ok(name, fn) {
  try { fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

const TYPES = Object.keys(theme.TYPE_THEME).concat(["", "nonsense-type"]);

console.log("\ncontrast is computed, not hoped for");

ok("every build type produces a palette that passes AA", () => {
  for (const t of TYPES) {
    const th = theme.forBuild({ buildType: t });
    assert.ok(th.palette.passesAA, t + " produced a palette that fails AA: " +
      JSON.stringify(th.palette.contrast));
  }
});

ok("the pairings the prompt tells the model to use are the ones measured", () => {
  const th = theme.forBuild({ buildType: "ecommerce" });
  const p = th.palette;
  // Each of these is a pairing the prompt names as safe to use together.
  assert.ok(palette.contrast(p.ink, p.surface) >= 4.5, "text-ink on bg-surface");
  assert.ok(palette.contrast(p.ink2, p.surface) >= 4.5, "text-ink-2 on bg-surface");
  assert.ok(palette.contrast(p.onAccent, p.accent) >= 4.5, "text-on-accent on bg-accent");
  assert.ok(palette.contrast(p.ink, p.tint) >= 4.5, "text-ink on bg-tint");
  assert.ok(palette.contrast(p.onDark, p.dark) >= 4.5, "text-on-dark on bg-dark");
});

ok("an awkward seed is still forced to pass", () => {
  /* Mid-lightness oranges are the documented hard case: neither black nor
     white clears AA on them, so palette.js moves the FILL. If any seed can
     break the guarantee it is one of these. */
  for (const seed of ["#ff9900", "#ffff00", "#7a7a7a", "#000000", "#ffffff", "#c2410c"]) {
    const th = theme.forBuild({ buildType: "landing", seedHex: seed });
    assert.ok(th.palette.passesAA, seed + " produced a failing palette: " +
      JSON.stringify(th.palette.contrast));
  }
});

console.log("\nseeding");

ok("an uploaded logo's colour drives the palette", () => {
  const th = theme.forBuild({ buildType: "ecommerce", seedHex: "#c2410c" });
  assert.strictEqual(th.seededFromLogo, true);
  assert.notStrictEqual(th.palette.accent, theme.forBuild({ buildType: "ecommerce" }).palette.accent,
    "a logo seed must actually change the palette");
  assert.match(theme.promptBlock(th), /derived from the logo/);
});

ok("no logo falls back to the build type, and types differ from each other", () => {
  const seen = new Set();
  for (const t of ["ecommerce", "dashboard", "game", "landing"]) {
    const th = theme.forBuild({ buildType: t });
    assert.strictEqual(th.seededFromLogo, false);
    seen.add(th.palette.accent);
  }
  assert.strictEqual(seen.size, 4, "four build types should not share one accent colour");
});

ok("the same request always produces the same palette", () => {
  const a = theme.forBuild({ buildType: "blog" }), b = theme.forBuild({ buildType: "blog" });
  assert.deepStrictEqual(a.palette, b.palette, "a design that changes between identical builds is a bug");
});

console.log("\nthe generated tailwind config");

ok("parses, and carries every token the prompt names", async () => {
  const th = theme.forBuild({ buildType: "portfolio" });
  const file = path.join(require("os").tmpdir(), "souqi-tw-" + Date.now() + ".mjs");
  fs.writeFileSync(file, theme.tailwindConfig(th));
  return import("file://" + file.replace(/\\/g, "/")).then((m) => {
    const colors = m.default.theme.extend.colors;
    const block = theme.promptBlock(th);
    // Every token mentioned to the model must exist, or the class silently
    // does nothing and the text renders invisible.
    for (const token of ["accent", "accent-hover", "on-accent", "surface", "surface-2", "tint", "line", "ink", "ink-2", "dark", "on-dark"]) {
      assert.ok(colors[token], "token " + token + " missing from the config");
      if (block.indexOf(token) === -1 && token !== "accent-hover") {
        throw new Error("token " + token + " is configured but never mentioned to the model");
      }
    }
    fs.unlinkSync(file);
  });
});

ok("the font stack is not over-escaped", () => {
  const cfg = theme.tailwindConfig(theme.forBuild({ buildType: "landing" }));
  // Building this from a JSON string once produced \"Segoe UI\" in the output,
  // which is a broken CSS font value that still parses as JavaScript.
  assert.ok(!/\\\\"/.test(cfg), "escaped quotes leaked into the font stack");
  assert.match(cfg, /"Segoe UI"/);
});

ok("the model cannot overwrite the palette", () => {
  // tailwind.config.js is outside src/, and write_file/edit_file both refuse
  // anything that is not src/**.{ts,tsx,css}. That is what stops a build from
  // theming itself halfway through.
  const { validateWriteFileArgs } = require("../lib/codeagent/model-loop");
  assert.throws(() => validateWriteFileArgs({ path: "tailwind.config.js", content: "x" }), /only files under src\//);
});

console.log("\nthe font link");

ok("requests both faces, with weights, from the allowed hosts", () => {
  const tag = theme.fontLinkTag(theme.forBuild({ buildType: "landing" }));
  assert.match(tag, /fonts\.googleapis\.com/);
  assert.match(tag, /family=Fraunces:wght@/);
  assert.match(tag, /family=Inter:wght@/);
  assert.match(tag, /display=swap/, "without swap the page renders invisible text while the font loads");
});

ok("a single-family pairing does not ask for it twice", () => {
  const tag = theme.fontLinkTag(theme.forBuild({ buildType: "dashboard" }));   // Inter/Inter
  assert.strictEqual((tag.match(/family=Inter/g) || []).length, 1);
});

ok("the hosts it uses are the hosts the CSP allows", () => {
  const csp = fs.readFileSync(path.join(__dirname, "..", "..", "vercel.json"), "utf8");
  for (const host of ["fonts.googleapis.com", "fonts.gstatic.com"]) {
    assert.ok(csp.indexOf(host) !== -1, host + " is not in the CSP — the font would be blocked");
  }
});

console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
