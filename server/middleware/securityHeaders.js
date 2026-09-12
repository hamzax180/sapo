/* =================================================================
   Souqi — security response headers (dependency-free helmet)
   -----------------------------------------------------------------
   Baseline hardening on every response. HSTS is emitted only in
   production (never on plain-HTTP dev).

   NOTE on CSP: the current console/portal pages rely on inline
   scripts/styles and Google Fonts, so the policy permits
   'unsafe-inline'/'unsafe-eval' for now. Tightening to nonce-based
   script-src is tracked as a Phase 7 follow-up (needs per-page
   nonces + a pass over the inline handlers). Even so, this policy
   blocks plugins/object embeds, framing by other origins and
   base-uri hijacking. Set CSP_DISABLED=1 to omit it if a page needs
   debugging.
   ================================================================= */
"use strict";
const isProd = process.env.NODE_ENV === "production";

// WebContainers (the builder page) need three things this policy did not
// previously allow, and each failure looked like an unexplained build
// error rather than a CSP problem:
//   - the @webcontainer/api module itself, loaded from jsdelivr;
//   - blob: workers — WebContainer runs its virtual Node in Web Workers
//     created from blob URLs, so worker-src blob: is mandatory;
//   - a frame source for the preview: the running client app is served
//     either same-origin via a service worker or from
//     *.webcontainer-api.io, and it renders inside an iframe.
// Named hosts, not wildcards: this widens the policy by three specific
// origins rather than relaxing it.
const WEBCONTAINER_CDN = "https://cdn.jsdelivr.net";
// The runtime frames stackblitz.com for its own licensing/credential
// handshake before it will boot, and serves the running client app from
// *.webcontainer-api.io. Both are required for a preview to appear.
const WEBCONTAINER_HOST = "https://*.webcontainer-api.io https://stackblitz.com";
// The device-mockup preview has a second render path, used whenever
// WebContainers aren't booted yet (every reopened project, briefly, while
// npm install runs) or aren't supported at all (no SharedArrayBuffer —
// most mobile browsers): a CDN-script srcdoc fallback built in code.html's
// showPreview()/renderAppPreview(), which loads Tailwind, React, Babel and
// lucide-react from these three hosts. Missing here, every one of those
// script tags was silently blocked — the preview mockup just stayed
// blank, with no error visible anywhere but the browser console.
const PREVIEW_FALLBACK_CDN = "https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://unpkg.com";

// Stripe Elements, on /checkout. The card fields are iframes served from
// js.stripe.com — that is what keeps the card number out of this origin
// and out of Souqi's PCI scope — and a 3-D Secure challenge is framed
// from hooks.stripe.com. Without the frame-src entries the fields render
// as blank boxes and a card that needs authentication just never clears,
// with the only clue in the browser console.
const STRIPE_SCRIPT = "https://js.stripe.com";
const STRIPE_FRAME = "https://js.stripe.com https://hooks.stripe.com";

// Deployed apps, for the preview thumbnails on /projects and /deployments.
// Every app the deploy plane publishes lives on a subdomain of APP_DOMAIN
// (football.souqi.site, app-ede76579dad1.souqi.site), and framing one was
// blocked by this policy — Chrome rendered the grey broken-content box, which
// looks exactly like the app failing to load rather than us refusing to show
// it. A wildcard over one domain we operate, not a blanket https:.
const APP_DOMAIN = (process.env.APP_DOMAIN || "souqi.site").toLowerCase();
const APP_PREVIEW_FRAME = "https://*." + APP_DOMAIN + " https://" + APP_DOMAIN;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' " + WEBCONTAINER_CDN + " " + PREVIEW_FALLBACK_CDN + " " + STRIPE_SCRIPT,
  "worker-src 'self' blob:",
  "child-src 'self' blob: " + WEBCONTAINER_HOST,
  "frame-src 'self' blob: " + WEBCONTAINER_HOST + " " + STRIPE_FRAME + " " + APP_PREVIEW_FRAME,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: blob: data:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");

module.exports = function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  /* API and auth answers are about WHO IS ASKING, and must never be stored
     by a cache that serves more than one person.

     They carried no Cache-Control at all, so the platform's default applied —
     in production that is "public, max-age=0, must-revalidate". `public` on a
     body containing an account's email address is the wrong default even with
     revalidation, and the only Vary was `Origin`, so nothing in the chain was
     told the answer depends on the session cookie.

     no-store is the correct instruction: do not write this down anywhere.
     res.vary() APPENDS, so the Origin that cors() sets is kept — overwriting
     Vary here would quietly widen CORS caching instead. */
  const p = req.path || "";
  if (p.indexOf("/api/") === 0 || p.indexOf("/auth/") === 0) {
    res.setHeader("Cache-Control", "no-store");
    res.vary("Cookie");
  }
  /* microphone=(self), not (): the composer's voice input is served from
     this origin, and with () the browser refuses getUserMedia and speech
     recognition outright — the mic button raised a permissions-policy
     violation in the console and looked simply dead. Not (*) either:
     generated apps render in iframes here, and none of them should
     inherit the microphone because our own composer uses it. */
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(self), camera=(self)");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  /* NO Cross-Origin-Embedder-Policy here, deliberately.

     COEP was set on every page, and a cross-origin IFRAME under COEP has to
     assert its own COEP or the browser blocks the navigation and paints a
     blank frame. credentialless relaxes that for subresources, not for
     frames. The deployed apps send no cross-origin headers at all, so every
     preview thumbnail on /projects and /deployments came out white — with or
     without a sandbox attribute, which is how it was traced here rather than
     to the iframe.

     Only the builder actually needs COEP: WebContainers require cross-origin
     isolation for SharedArrayBuffer. index.js sets it there, on /agent and
     /code alone (see crossOriginIsolate), and vercel.json mirrors that scope
     for the statically served copies. Everywhere else it bought nothing and
     cost the previews. */
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (!process.env.CSP_DISABLED) res.setHeader("Content-Security-Policy", CSP);
  if (isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  next();
};
