/* =================================================================
   Souqi — pluggable CAPTCHA verification
   -----------------------------------------------------------------
   Guards the unauthenticated public forms (guest orders, inquiries)
   against bots. It is a NO-OP until CAPTCHA_SECRET is configured, so
   dev/demo stays open and the endpoints become protected the moment a
   provider is wired up — no code change required.

   Provider chosen via CAPTCHA_PROVIDER: "turnstile" (Cloudflare,
   default) or "recaptcha" (Google). The client sends the solved token
   as body.captchaToken or the X-Captcha-Token header.
   ================================================================= */
"use strict";
const { httpError } = require("../lib/errors");

const VERIFY_URL = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  recaptcha: "https://www.google.com/recaptcha/api/siteverify"
};

function verifyCaptcha() {
  return async function (req, res, next) {
    const secret = (process.env.CAPTCHA_SECRET || "").trim();
    if (!secret) return next(); // disabled — pass through

    const token = (req.body && (req.body.captchaToken || req.body.captcha)) || req.headers["x-captcha-token"];
    if (!token) return next(httpError(400, "captcha_required", "captcha verification required"));

    try {
      const provider = (process.env.CAPTCHA_PROVIDER || "turnstile").toLowerCase();
      const url = VERIFY_URL[provider] || VERIFY_URL.turnstile;
      const params = new URLSearchParams({ secret, response: String(token), remoteip: req.ip || "" });
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
      const j = await r.json().catch(() => ({}));
      if (!j.success) return next(httpError(403, "captcha_failed", "captcha verification failed"));
      return next();
    } catch (e) {
      return next(httpError(502, "captcha_error", "captcha provider unreachable"));
    }
  };
}

module.exports = { verifyCaptcha };
