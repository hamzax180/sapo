/* =================================================================
   csp-test.js — the two copies of the Content-Security-Policy agree
   -----------------------------------------------------------------
   The policy exists twice, and it has to.

   server/middleware/securityHeaders.js sets it on anything Express
   answers. But vercel.json declares `outputDirectory: "public"`, so the
   pages themselves — /agent, /projects, /deployments — are served as
   static files by Vercel's CDN and never reach Express at all. Only
   vercel.json's `headers` block applies to those, and it listed every
   security header EXCEPT this one: production served the builder with no
   CSP whatsoever while local development had a full one.

   Two copies of a security policy that can drift apart silently is worse
   than one that is merely permissive, so this pins them together. If you
   widen the policy for a new CDN, this fails until vercel.json says the
   same thing.
   ================================================================= */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failures++; console.log("  ✗ " + name + "\n      " + e.message); }
}

function middlewareCsp() {
  const securityHeaders = require("./middleware/securityHeaders");
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  securityHeaders({}, res, () => {});
  return res.headers["Content-Security-Policy"];
}

function vercelHeaders() {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const block = (v.headers || []).find((h) => h.source === "/(.*)");
  assert.ok(block, "vercel.json has no catch-all headers block");
  const out = {};
  for (const h of block.headers) out[h.key] = h.value;
  return out;
}

console.log("\n── CSP: one policy, two places that must agree ────────");

check("the middleware emits a policy at all", () => {
  assert.ok(middlewareCsp(), "securityHeaders did not set Content-Security-Policy");
});

check("vercel.json carries a Content-Security-Policy", () => {
  assert.ok(vercelHeaders()["Content-Security-Policy"],
    "vercel.json omits it — the statically served pages would ship with no CSP, " +
    "which is exactly the bug this file exists to hold");
});

check("the two policies are identical, directive for directive", () => {
  const a = middlewareCsp();
  const b = vercelHeaders()["Content-Security-Policy"];
  if (a === b) return;
  // Name what actually differs; a 600-character diff is unreadable.
  const split = (s) => new Set(String(s).split(";").map((x) => x.trim()).filter(Boolean));
  const A = split(a), B = split(b);
  const onlyMw = [...A].filter((x) => !B.has(x));
  const onlyVc = [...B].filter((x) => !A.has(x));
  assert.fail("they have drifted apart\n" +
    (onlyMw.length ? "      only in securityHeaders.js: " + onlyMw.join(" | ") + "\n" : "") +
    (onlyVc.length ? "      only in vercel.json:        " + onlyVc.join(" | ") + "\n" : "") +
    "      re-generate vercel.json's value from the middleware");
});

check("every other security header the middleware sets is also declared statically", () => {
  const securityHeaders = require("./middleware/securityHeaders");
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  securityHeaders({}, res, () => {});
  const vc = vercelHeaders();
  // X-DNS-Prefetch-Control is the one deliberate omission: it is a legacy
  // Chrome hint, not a security boundary, and Vercel does not prefetch.
  const skip = new Set(["X-DNS-Prefetch-Control", "Strict-Transport-Security"]);
  const missing = Object.keys(res.headers).filter((k) => !skip.has(k) && !vc[k]);
  assert.deepStrictEqual(missing, [],
    "served statically without: " + missing.join(", "));
});

if (failures) { console.log("\n✗ " + failures + " CSP CHECK(S) FAILED\n"); process.exit(1); }
console.log("\n✓ ALL CSP TESTS PASSED (4)\n");
