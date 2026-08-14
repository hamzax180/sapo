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

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' " + WEBCONTAINER_CDN + " " + PREVIEW_FALLBACK_CDN,
  "worker-src 'self' blob:",
  "child-src 'self' blob: " + WEBCONTAINER_HOST,
  "frame-src 'self' blob: " + WEBCONTAINER_HOST,
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
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(self)");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  if (!process.env.CSP_DISABLED) res.setHeader("Content-Security-Policy", CSP);
  if (isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  next();
};
