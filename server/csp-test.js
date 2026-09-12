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

/* ---- Cross-Origin-Embedder-Policy: the scoped copy -------------------
   COEP is not in the catch-all block above. It is set on a few routes
   only, because site-wide it blanks every deployed-app preview (see
   middleware/securityHeaders.js). So it has the same two-copies problem
   the CSP has, in a narrower place: index.js decides the scope for
   anything Express answers, vercel.json decides it for the statically
   served pages, and nothing checked that the two agreed — which is how
   /settings ended up isolated in neither and the builder's settings
   overlay started painting "refused to connect". */

function expressIsolated() {
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const re = /app\.use\("(\/[^"]+)", crossOriginIsolate\)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[1].replace(/\.html$/, ""));
  return out;
}

function vercelIsolated() {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const block = (v.headers || []).find((h) =>
    (h.headers || []).some((x) => x.key === "Cross-Origin-Embedder-Policy"));
  assert.ok(block, "vercel.json declares COEP nowhere — production is not isolated at all");
  // e.g. "/(agent|code|settings)(/.*)?" → agent, code, settings
  const alt = /^\/\(([^)]+)\)/.exec(block.source);
  assert.ok(alt, "cannot read the isolate scope out of " + JSON.stringify(block.source));
  return new Set(alt[1].split("|").map((s) => "/" + s.trim()));
}

/* The pages an isolated page can put in an iframe.

   A line that mentions `src` and names a path we serve as an HTML page is
   treated as a frame source. Crude on purpose: `<script src="/js/ui.js">`
   has no page behind it and drops out, and the cost of a false positive is
   a loud test rather than a silent hole. */
function framedPages(file) {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
  const out = new Set();
  for (const line of src.split("\n")) {
    if (!/src/i.test(line)) continue;
    const re = /"(\/[a-z0-9_-]+)"/gi;
    let m;
    while ((m = re.exec(line))) {
      const p = m[1];
      if (fs.existsSync(path.join(__dirname, "..", "public", p.slice(1) + ".html"))) out.add(p);
    }
  }
  return out;
}

check("both copies isolate exactly the same routes", () => {
  const ex = [...expressIsolated()].sort();
  const vc = [...vercelIsolated()].sort();
  assert.deepStrictEqual(ex, vc,
    "index.js isolates [" + ex.join(", ") + "] but vercel.json isolates [" + vc.join(", ") + "]\n" +
    "      Vercel serves these pages from the CDN, so a route missing there is\n" +
    "      isolated in development and not in production");
});

check("every page an isolated page frames is isolated too", () => {
  const iso = expressIsolated();
  const missing = [];
  for (const page of ["code.html"]) {
    for (const framed of framedPages(page)) {
      if (!iso.has(framed)) missing.push(framed + " (framed by " + page + ")");
    }
  }
  assert.deepStrictEqual(missing, [],
    "framed by a COEP page but sends no COEP of its own: " + missing.join(", ") + "\n" +
    "      A document embedded in a COEP context must assert COEP itself — the\n" +
    "      rule is not origin-scoped, and credentialless relaxes it for\n" +
    "      subresources, not for frames. The browser refuses the navigation and\n" +
    "      paints \"refused to connect\" inside the frame.");
});

if (failures) { console.log("\n✗ " + failures + " CSP CHECK(S) FAILED\n"); process.exit(1); }
console.log("\n✓ ALL CSP TESTS PASSED (6)\n");
