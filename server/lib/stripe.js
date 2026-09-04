/* =================================================================
   lib/stripe.js — Stripe Connect, and the only module that talks to it
   -----------------------------------------------------------------
   Souqi is a PLATFORM here, not the merchant. An app owner connects
   their own Stripe account over OAuth; charges are created directly
   on that account and the money lands in their balance. Souqi never
   holds funds and never takes custody of a card.

   What that buys, concretely:

     • Souqi stores an ACCOUNT ID ("acct_1abc…"), not a secret key.
       A dump of the users collection yields an identifier that is
       useless without Souqi's own platform key — where storing
       `sk_live_…` per user would hand over every merchant at once.
     • Payouts, refunds, disputes and tax are the owner's, in their
       own dashboard, under their own Stripe agreement.
     • No platform fee is taken (STRIPE_PLATFORM_FEE_BPS defaults to
       0). The hook is here because adding one later must not mean
       re-doing the connection model.

   OFF BY DEFAULT, exactly like ai/client.js: with no
   STRIPE_CLIENT_ID / STRIPE_SECRET_KEY in the environment,
   isConfigured() is false and every route that needs it answers
   "not configured" instead of half-working.

   No `stripe` npm package on purpose. Everything here is three form
   -encoded POSTs and an HMAC; pulling a dependency to do that would
   also pull its transitive tree into the Vercel bundle for no gain.
   The trade is that webhook verification is ours to get right — see
   verifyWebhook, which is written against Stripe's documented
   scheme and covered by tests.
   ================================================================= */
"use strict";

const crypto = require("crypto");

const API_BASE = "https://api.stripe.com";
const CONNECT_BASE = "https://connect.stripe.com";
const DEFAULT_TIMEOUT_MS = 15000;

// Stripe's own tolerance recommendation for replay protection.
const WEBHOOK_TOLERANCE_SEC = 300;

let CONFIG = null;

/**
 * @param {object} [overrides] test injection — never touches the network when
 *   `fetchImpl` is supplied.
 */
function init(overrides) {
  const o = overrides || {};
  const env = process.env;
  CONFIG = {
    clientId: o.clientId !== undefined ? o.clientId : (env.STRIPE_CLIENT_ID || ""),
    secretKey: o.secretKey !== undefined ? o.secretKey : (env.STRIPE_SECRET_KEY || ""),
    webhookSecret: o.webhookSecret !== undefined ? o.webhookSecret : (env.STRIPE_WEBHOOK_SECRET || ""),
    // Basis points, so a 2.5% fee is 250. 0 = no platform fee.
    feeBps: Number(o.feeBps !== undefined ? o.feeBps : (env.STRIPE_PLATFORM_FEE_BPS || 0)) || 0,
    fetchImpl: o.fetchImpl || globalThis.fetch
  };
  return CONFIG;
}

function ensureInit() {
  if (!CONFIG) init();
  return CONFIG;
}

/** Connect needs both halves: the client id starts OAuth, the secret finishes it. */
function isConfigured() {
  const c = ensureInit();
  return !!(c.clientId && c.secretKey);
}

function livemode() {
  const c = ensureInit();
  return /^sk_live_/.test(c.secretKey || "");
}

/* ---------------------------------------------------------------- form encoding */

/**
 * Stripe's API is application/x-www-form-urlencoded with bracketed paths for
 * nested data — `line_items[0][price_data][currency]=usd`. Building that by
 * hand at each call site is how a typo becomes a silent, unpriced charge, so
 * every request goes through this.
 */
function formEncode(obj, prefix, out) {
  const params = out || [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const path = prefix ? prefix + "[" + key + "]" : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object") formEncode(item, path + "[" + i + "]", params);
        else params.push(encodeURIComponent(path + "[" + i + "]") + "=" + encodeURIComponent(String(item)));
      });
    } else if (typeof value === "object") {
      formEncode(value, path, params);
    } else {
      params.push(encodeURIComponent(path) + "=" + encodeURIComponent(String(value)));
    }
  }
  return params.join("&");
}

/* ---------------------------------------------------------------- transport */

/**
 * One call to Stripe. Never throws for an operational failure — the caller
 * gets {ok:false, reason} and decides, same contract as ai/client.js.
 *
 * @param {string} path
 * @param {object} body
 * @param {object} [opts] {account, idempotencyKey, base}
 */
async function request(path, body, opts) {
  const c = ensureInit();
  const o = opts || {};
  if (!c.secretKey) return { ok: false, reason: "Stripe is not configured on this server" };

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Authorization": "Bearer " + c.secretKey,
    // Pinning the version means Stripe changing a default cannot silently
    // change what this code receives.
    "Stripe-Version": "2024-06-20"
  };
  // Direct charges: the request acts AS the connected account, so the charge,
  // the balance and the payout are all theirs. Without this header the charge
  // would land on Souqi's platform account — i.e. Souqi would be the merchant,
  // which is exactly the arrangement this module exists to avoid.
  if (o.account) headers["Stripe-Account"] = o.account;
  if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await c.fetchImpl((o.base || API_BASE) + path, {
      method: "POST",
      headers: headers,
      body: formEncode(body || {}),
      signal: controller.signal
    });
    clearTimeout(timer);
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = (json && json.error && (json.error.message || json.error.error_description)) || ("Stripe returned " + res.status);
      return { ok: false, status: res.status, reason: msg, code: json && json.error && json.error.code };
    }
    return { ok: true, data: json };
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e.name === "AbortError";
    return { ok: false, timedOut: timedOut, reason: timedOut ? "Stripe timed out" : e.message };
  }
}

/* ---------------------------------------------------------------- OAuth */

/**
 * Where to send an owner to authorize Souqi against their Stripe account.
 *
 * `state` is required and must be unguessable and bound to the session — it is
 * the only thing standing between this and a CSRF that connects an ATTACKER's
 * Stripe account to a victim's project, silently redirecting that project's
 * revenue. index.js signs it; this module just refuses to build a URL without.
 */
function authorizeUrl(state, redirectUri) {
  const c = ensureInit();
  if (!c.clientId) return null;
  if (!state) throw new Error("stripe.authorizeUrl: state is required (CSRF protection)");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    scope: "read_write",
    state: state
  });
  if (redirectUri) q.set("redirect_uri", redirectUri);
  return CONNECT_BASE + "/oauth/authorize?" + q.toString();
}

/** Exchange the ?code= from the callback for the connected account id. */
async function exchangeCode(code) {
  const res = await request("/oauth/token", {
    grant_type: "authorization_code",
    code: String(code || "")
  }, { base: CONNECT_BASE });
  if (!res.ok) return res;
  const accountId = res.data && res.data.stripe_user_id;
  if (!accountId) return { ok: false, reason: "Stripe did not return an account id" };
  return { ok: true, accountId: accountId, livemode: !!(res.data && res.data.livemode) };
}

/**
 * Revoke Souqi's access. Called on disconnect.
 *
 * A failure here is reported but must not block the local disconnect: if
 * Stripe says "already revoked" (or is simply down), refusing to forget the
 * account id locally would leave an owner permanently unable to disconnect.
 */
async function deauthorize(accountId) {
  const c = ensureInit();
  return request("/oauth/deauthorize", {
    client_id: c.clientId,
    stripe_user_id: String(accountId || "")
  }, { base: CONNECT_BASE });
}

/* ---------------------------------------------------------------- checkout */

/**
 * A Checkout Session on the owner's connected account.
 *
 * NOTE what this does NOT accept: a raw amount from a caller. Prices come from
 * the server-side item the caller resolved first. An endpoint that let a
 * browser name its own price would let anyone mint $0.01 sessions against a
 * stranger's Stripe account — which is not just underpricing, it is a card
 * -testing endpoint, and it gets the OWNER's account shut down, not Souqi's.
 *
 * @param {object} p
 * @param {string} p.account        connected account id (acct_…)
 * @param {Array}  p.items          [{name, amountMinor, currency, quantity}] — server-resolved
 * @param {string} p.successUrl
 * @param {string} p.cancelUrl
 * @param {string} [p.idempotencyKey]
 * @param {object} [p.metadata]
 */
async function createCheckoutSession(p) {
  const c = ensureInit();
  const items = Array.isArray(p.items) ? p.items : [];
  if (!p.account) return { ok: false, reason: "no connected Stripe account" };
  if (!items.length) return { ok: false, reason: "nothing to pay for" };

  const currency = String(items[0].currency || "usd").toLowerCase();
  // Stripe prices one session in one currency; mixing them fails deep inside
  // the API with a much less obvious message than this.
  if (items.some((i) => String(i.currency || "usd").toLowerCase() !== currency)) {
    return { ok: false, reason: "all items in one checkout must share a currency" };
  }

  const total = items.reduce((sum, i) => sum + (Number(i.amountMinor) || 0) * (Number(i.quantity) || 1), 0);

  const body = {
    mode: "payment",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    line_items: items.map((i) => ({
      quantity: Number(i.quantity) || 1,
      price_data: {
        currency: currency,
        unit_amount: Number(i.amountMinor) || 0,
        product_data: { name: String(i.name || "Item").slice(0, 250) }
      }
    })),
    metadata: p.metadata || {}
  };

  // Only attach a fee when one is actually configured — sending
  // application_fee_amount: 0 is not the same as sending nothing, and on some
  // account configurations Stripe rejects the zero outright.
  if (c.feeBps > 0) {
    const fee = Math.floor((total * c.feeBps) / 10000);
    if (fee > 0) body.payment_intent_data = { application_fee_amount: fee };
  }

  const res = await request("/v1/checkout/sessions", body, {
    account: p.account,
    idempotencyKey: p.idempotencyKey
  });
  if (!res.ok) return res;
  return { ok: true, id: res.data.id, url: res.data.url, amountTotal: res.data.amount_total, currency: currency };
}

/* ---------------------------------------------------------------- webhooks */

/**
 * Verify a webhook against Stripe's documented scheme.
 *
 * Header: `t=<unix>,v1=<hex hmac>[,v1=<another>]`
 * Signed payload: `${t}.${rawBody}` — the RAW bytes, not re-serialized JSON.
 * Re-encoding the body changes key order and whitespace and the signature
 * stops matching, which is the single most common way this is got wrong.
 *
 * Returns the parsed event only when the signature AND the timestamp check
 * both pass, so a caller cannot accidentally act on an unverified payload.
 */
function verifyWebhook(rawBody, signatureHeader, secretOverride) {
  const c = ensureInit();
  const secret = secretOverride || c.webhookSecret;
  if (!secret) return { ok: false, reason: "STRIPE_WEBHOOK_SECRET is not configured" };
  if (!rawBody || !signatureHeader) return { ok: false, reason: "missing body or signature" };

  const parts = String(signatureHeader).split(",").map((s) => s.trim());
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq), v = part.slice(eq + 1);
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || !signatures.length) return { ok: false, reason: "malformed Stripe-Signature header" };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SEC) {
    return { ok: false, reason: "webhook timestamp outside tolerance — possible replay" };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const signedPayload = Buffer.concat([Buffer.from(timestamp + ".", "utf8"), body]);
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  // Constant-time compare. A plain === leaks how much of the signature was
  // right through timing, which is enough to forge one given enough tries.
  const expectedBuf = Buffer.from(expected, "utf8");
  const matched = signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
  if (!matched) return { ok: false, reason: "signature mismatch" };

  try {
    return { ok: true, event: JSON.parse(body.toString("utf8")) };
  } catch (e) {
    return { ok: false, reason: "verified signature but body was not JSON" };
  }
}

module.exports = {
  init, isConfigured, livemode,
  authorizeUrl, exchangeCode, deauthorize,
  createCheckoutSession, verifyWebhook,
  formEncode, WEBHOOK_TOLERANCE_SEC
};
