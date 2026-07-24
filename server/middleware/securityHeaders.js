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

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https:",
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
  if (!process.env.CSP_DISABLED) res.setHeader("Content-Security-Policy", CSP);
  if (isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  next();
};
