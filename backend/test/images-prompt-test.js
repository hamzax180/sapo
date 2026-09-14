/* =================================================================
   buildImagesBlock + fixImageUrls.

   fixImageUrls rewrites what the model wrote, which is the same power
   twoUpOnMobile has and deserves the same suspicion: the failure mode of a
   too-eager rewrite is worse than the bug it fixes, because it invents code
   nobody asked for. Most of these tests are about what it must NOT touch.

   Run: node server/images-prompt-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const { buildImagesBlock, fixImageUrls, validateWriteFileArgs } = require("../lib/codeagent/model-loop");

const REAL = "https://cdn.souqi.site/u/" + "a1b2c3d4".repeat(4) + ".jpg";
const REAL2 = "https://cdn.souqi.site/u/" + "9f8e7d6c".repeat(4) + ".png";
const TOKEN = "a1b2c3d4".repeat(4);

let passed = 0;
function ok(name, fn) {
  try { fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

console.log("\nbuildImagesBlock");

ok("nothing attached produces nothing at all", () => {
  assert.strictEqual(buildImagesBlock([]), "");
  assert.strictEqual(buildImagesBlock(null), "");
  // An empty string concatenates away; a "no images" sentence would be noise
  // in every prompt the product ever sends.
});

ok("numbers them so 'the second one' means what the composer showed", () => {
  const out = buildImagesBlock([
    { url: REAL, name: "shop.jpg" }, { url: REAL2, name: "logo.png" }
  ]);
  assert.ok(out.indexOf("[1] " + REAL) < out.indexOf("[2] " + REAL2));
});

ok("carries the description, which is the entire point", () => {
  const out = buildImagesBlock([{ url: REAL, name: "a.jpg", description: "A warm-lit cafe interior." }]);
  assert.match(out, /Shows: A warm-lit cafe interior\./);
});

ok("describes the shape even with no description", () => {
  const wide = buildImagesBlock([{ url: REAL, name: "a.jpg", width: 1600, height: 900 }]);
  assert.match(wide, /landscape/);
  const tall = buildImagesBlock([{ url: REAL, name: "a.jpg", width: 900, height: 1600 }]);
  assert.match(tall, /portrait/);
  const sq = buildImagesBlock([{ url: REAL, name: "a.jpg", width: 800, height: 800 }]);
  assert.match(sq, /square/);
});

ok("tells the model these are real and not to invent others", () => {
  const out = buildImagesBlock([{ url: REAL, name: "a.jpg" }]);
  assert.match(out, /already/);
  assert.match(out, /do not invent/i);
});

console.log("\nfixImageUrls — what it must NOT touch");

ok("leaves everything alone when no images were attached", () => {
  const src = '<img src="https://images.unsplash.com/x.jpg" />';
  assert.strictEqual(fixImageUrls(src, []), src);
  assert.strictEqual(fixImageUrls(src, null), src);
  // With no allowed list there is no way to tell a real URL from an invented
  // one, and guessing would break the logo feature that already works.
});

ok("an allowed URL passes through byte for byte", () => {
  const src = '<img src="' + REAL + '" alt="Our shop" className="w-full object-cover" />';
  assert.strictEqual(fixImageUrls(src, [REAL]), src);
});

ok("does not touch a URL that is not an img src", () => {
  const src = 'const bg = "url(https://example.com/x.png)"; // https://other.com/y.jpg';
  assert.strictEqual(fixImageUrls(src, [REAL]), src);
  // A URL in a gradient or a comment is not something the browser will try
  // to load and fail at.
});

ok("does not touch relative or data sources", () => {
  const src = '<img src="/logo.svg" /><img src="data:image/png;base64,AAA" />';
  assert.strictEqual(fixImageUrls(src, [REAL]), src);
});

console.log("\nfixImageUrls — what it does");

ok("repairs a mistyped copy of a real URL back to the real one", () => {
  // The likeliest failure: the model retyping a long URL instead of copying.
  const typo = "https://cdn.souqi.site/u/" + TOKEN.slice(0, 28) + ".jpg";
  const out = fixImageUrls('<img src="' + typo + '" alt="shop" />', [REAL]);
  assert.ok(out.includes(REAL), "a near-miss should resolve to the person's actual photo");
  assert.ok(!out.includes(typo));
});

ok("replaces an invented stock URL with a gradient, not a broken image", () => {
  const out = fixImageUrls('<img src="https://images.unsplash.com/photo-123" alt="cafe" className="w-full h-64" />', [REAL]);
  assert.ok(!out.includes("unsplash"), "the invented URL must not survive");
  assert.match(out, /bg-gradient-to-br/);
  assert.match(out, /<div/, "an img with no src is a torn-page icon; a div is a design");
  assert.ok(!/src=/.test(out));
});

ok("the same phantom URL always gets the same colour", () => {
  const one = fixImageUrls('<img src="https://x.com/a.jpg" className="w-full" />', [REAL]);
  const two = fixImageUrls('<img src="https://x.com/a.jpg" className="w-full" />', [REAL]);
  assert.strictEqual(one, two, "flickering between builds would look like a bug");
});

ok("keeps the classes the model chose for the layout", () => {
  const out = fixImageUrls('<img src="https://fake.test/x.jpg" className="w-full h-64 rounded-xl" />', [REAL]);
  assert.match(out, /w-full/);
  assert.match(out, /h-64/);
  assert.match(out, /rounded-xl/);
  // The placeholder has to occupy the same box, or removing the image
  // collapses the layout around it.
});

console.log("\nthrough validateWriteFileArgs");

ok("applies on the real write path, alongside twoUpOnMobile", () => {
  const r = validateWriteFileArgs({
    path: "src/App.tsx",
    content: '<div className="grid grid-cols-1 md:grid-cols-3"><img src="https://nope.test/a.jpg" className="w-full" /></div>'
  }, { imageUrls: [REAL] });
  assert.match(r.content, /grid-cols-2/, "the existing rewrite still runs");
  assert.ok(!r.content.includes("nope.test"));
});

ok("no opts is the old behaviour exactly", () => {
  const src = '<img src="https://anything.test/a.jpg" />';
  assert.strictEqual(validateWriteFileArgs({ path: "src/A.tsx", content: src }).content, src);
  // Every existing caller passes no opts, so this must be a no-op for them.
});

console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
