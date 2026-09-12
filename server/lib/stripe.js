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
    // Souqi-as-merchant (the subscriptions half, far below). Separate from
    // the Connect pair above because they are configured independently: a
    // deployment can sell its own plans without offering Connect, or the
    // reverse, and neither should switch the other on.
    publishableKey: o.publishableKey !== undefined ? o.publishableKey : (env.STRIPE_PUBLISHABLE_KEY || ""),
    plans: o.plans !== undefined ? o.plans : parsePlans(env.STRIPE_BILLING_PLANS),
    // Stripe Tax has to be enabled in the dashboard first, and asking for it
    // when it is not available fails the entire subscription — so it is
    // opt-in rather than assumed.
    automaticTax: o.automaticTax !== undefined ? !!o.automaticTax : env.STRIPE_AUTOMATIC_TAX === "1",
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

  // GET for the reads — a Price, a customer, a promotion-code lookup. Same
  // auth and timeout, but the parameters go in the query string: Stripe
  // ignores a body on a GET, so sending one would silently read the wrong
  // thing rather than fail.
  const method = (o.method || "POST").toUpperCase();
  const encoded = body ? formEncode(body) : "";

  const headers = {
    "Authorization": "Bearer " + c.secretKey,
    // Pinning the version means Stripe changing a default cannot silently
    // change what this code receives.
    "Stripe-Version": "2024-06-20"
  };
  if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
  // Direct charges: the request acts AS the connected account, so the charge,
  // the balance and the payout are all theirs. Without this header the charge
  // would land on Souqi's platform account — i.e. Souqi would be the merchant,
  // which is exactly the arrangement this module exists to avoid.
  if (o.account) headers["Stripe-Account"] = o.account;
  if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const url = (o.base || API_BASE) + path + (method === "GET" && encoded ? "?" + encoded : "");
    const res = await c.fetchImpl(url, {
      method: method,
      headers: headers,
      body: method === "GET" ? undefined : encoded,
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

/* ============================================================ subscriptions

   Everything above this line is Connect: the app OWNER is the merchant,
   the charge is created on their account and Souqi never touches the
   money. Everything below is the opposite arrangement, and that is why it
   is fenced off down here rather than mixed in — these calls send NO
   Stripe-Account header, so they run on Souqi's own account, because for
   a Souqi subscription Souqi really is the merchant.

   A caller names a plan, an interval and a currency. It never names an
   amount, and the browser never names a price id either: the id is looked
   up from STRIPE_BILLING_PLANS on the server and the amount comes back
   from Stripe. A request body that could carry either would let anyone
   subscribe to the top plan for a penny.

   OFF BY DEFAULT like the rest of this module, and with a second key: the
   card fields are Stripe's own iframes, which need a PUBLISHABLE key in
   the page as well as the secret one here. Missing either, or missing a
   plan catalogue, and isBillingConfigured() is false.
   ========================================================================= */

/**
 * The sold plans, keyed by the id the storefront uses ("core", "pro").
 *
 * Shape, as JSON in STRIPE_BILLING_PLANS:
 *   { "core": { "label": "Souqi Core",
 *               "entitlement": "pro",
 *               "prices": { "month": { "usd": "price_…" },
 *                           "year":  { "usd": "price_…" } } } }
 *
 * `entitlement` is the internal plan id the rest of the server gates on —
 * deliberately separate from the sold name, because marketing renames a
 * tier far more often than the code behind it changes.
 */
function parsePlans(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    // Not throwing: a typo in one env var should leave subscriptions off,
    // not stop the server from booting and take the whole site with it.
    console.warn("[stripe] STRIPE_BILLING_PLANS is not valid JSON, so subscriptions stay off:", e.message);
    return {};
  }
}

/** Connect needs two halves; billing needs three. */
function isBillingConfigured() {
  const c = ensureInit();
  return !!(c.secretKey && c.publishableKey && Object.keys(c.plans).length > 0);
}

/** Safe to hand to a browser — that is what a publishable key is for. */
function publishableKey() { return ensureInit().publishableKey; }

/**
 * The catalogue as the checkout page may see it: no price ids, ever. Those
 * are a server detail, and a page that knew them could ask to be charged
 * for a different one.
 */
function planCatalogue() {
  const c = ensureInit();
  const out = {};
  for (const id of Object.keys(c.plans)) {
    const p = c.plans[id] || {};
    const intervals = {};
    for (const interval of Object.keys(p.prices || {})) {
      intervals[interval] = Object.keys(p.prices[interval] || {});
    }
    out[id] = {
      id: id,
      label: p.label || id,
      entitlement: p.entitlement || null,
      // { month: ["usd","try"], year: ["usd"] } — which currencies this plan
      // can actually be billed in, so the page can hide a toggle it has no
      // price for instead of failing at submit.
      intervals: intervals
    };
  }
  return out;
}

/** The one place a plan/interval/currency turns into something chargeable. */
function priceIdFor(plan, interval, currency) {
  const c = ensureInit();
  const p = c.plans[String(plan || "")];
  if (!p || !p.prices) return null;
  const byInterval = p.prices[String(interval || "")];
  if (!byInterval) return null;
  return byInterval[String(currency || "").toLowerCase()] || null;
}

/** What the rest of the server gates on once this plan is paid for. */
function entitlementFor(plan) {
  const c = ensureInit();
  const p = c.plans[String(plan || "")];
  return (p && p.entitlement) || null;
}

/**
 * Stripe omits a money field rather than sending 0, and 0 is a real amount
 * in all of these — so a plain || would turn a genuine zero into the
 * fallback, and a plain read would turn a missing field into undefined.
 */
function amountOr(value, fallback) {
  return (value === null || value === undefined) ? fallback : value;
}

/** Read one Price, so the page can show what Stripe will actually charge. */
async function getPrice(priceId) {
  if (!priceId) return { ok: false, reason: "no price id" };
  const res = await request("/v1/prices/" + encodeURIComponent(priceId), null, { method: "GET" });
  if (!res.ok) return res;
  const p = res.data || {};
  return {
    ok: true,
    id: p.id,
    amountMinor: p.unit_amount,
    currency: p.currency,
    interval: (p.recurring && p.recurring.interval) || null,
    intervalCount: (p.recurring && p.recurring.interval_count) || 1,
    livemode: !!p.livemode
  };
}

/**
 * The Stripe customer for one Souqi account.
 *
 * A stored id can go stale — the customer was deleted in the dashboard, or
 * the keys were swapped between test and live mode and the id belongs to
 * the other one. Rather than fail the purchase, a stale id falls through
 * to a fresh customer; the caller stores whatever comes back.
 */
async function findOrCreateCustomer(p) {
  const opts = p || {};
  if (opts.existingId) {
    const got = await request("/v1/customers/" + encodeURIComponent(opts.existingId), null, { method: "GET" });
    if (got.ok && got.data && got.data.id && !got.data.deleted) {
      return { ok: true, id: got.data.id, reused: true };
    }
  }
  const made = await request("/v1/customers", {
    email: opts.email || undefined,
    name: opts.name || undefined,
    metadata: opts.metadata || {}
  }, { idempotencyKey: opts.idempotencyKey });
  if (!made.ok) return made;
  return { ok: true, id: made.data.id, reused: false };
}

/**
 * Resolve a promotion code the shopper typed into the id Stripe wants.
 *
 * A code that does not exist comes back as `notFound` rather than a hard
 * failure: "that code isn't valid" is a normal thing for a checkout to
 * say, not an error worth failing the page over.
 */
async function lookupPromotionCode(code) {
  const trimmed = String(code || "").trim();
  if (!trimmed) return { ok: false, notFound: true, reason: "no code given" };
  const res = await request("/v1/promotion_codes", { code: trimmed, active: true, limit: 1 }, { method: "GET" });
  if (!res.ok) return res;
  const hit = res.data && Array.isArray(res.data.data) ? res.data.data[0] : null;
  if (!hit) return { ok: false, notFound: true, reason: "that promotion code isn't valid" };
  const coupon = hit.coupon || {};
  return {
    ok: true, id: hit.id, code: hit.code,
    percentOff: amountOr(coupon.percent_off, null),
    amountOffMinor: amountOr(coupon.amount_off, null),
    currency: coupon.currency || null
  };
}

/**
 * Start a subscription whose first payment is confirmed in the browser.
 *
 * `default_incomplete` is the whole trick: the card is collected on our
 * own page, so at this moment the customer has no payment method at all.
 * Without it Stripe tries to charge one that does not exist, the
 * subscription is born `incomplete` against a failed invoice, and it
 * expires ~23 hours later having never asked anyone for a card. With it,
 * Stripe hands back a PaymentIntent whose client secret the page confirms
 * — and that confirmation is also what satisfies 3-D Secure, which is not
 * optional for a card issued in the EU or Turkey.
 *
 * save_default_payment_method is what makes the SECOND month work: the
 * card that clears the first invoice becomes the subscription's default,
 * so renewals never need a browser.
 */
async function createSubscription(p) {
  const c = ensureInit();
  const opts = p || {};
  if (!opts.customerId) return { ok: false, reason: "no customer to subscribe" };
  if (!opts.priceId) return { ok: false, reason: "no price configured for that plan" };

  const body = {
    customer: opts.customerId,
    items: [{ price: opts.priceId }],
    payment_behavior: "default_incomplete",
    payment_settings: {
      save_default_payment_method: "on_subscription",
      payment_method_types: ["card"]
    },
    expand: ["latest_invoice.payment_intent"],
    metadata: opts.metadata || {}
  };
  if (opts.promotionCodeId) body.promotion_code = opts.promotionCodeId;
  if (c.automaticTax) body.automatic_tax = { enabled: true };

  const res = await request("/v1/subscriptions", body, { idempotencyKey: opts.idempotencyKey });
  if (!res.ok) return res;
  return { ok: true, subscription: summariseSubscription(res.data) };
}

/** Read one subscription back — what the success page checks against. */
async function getSubscription(id) {
  if (!id) return { ok: false, reason: "no subscription id" };
  const res = await request("/v1/subscriptions/" + encodeURIComponent(id), null, { method: "GET" });
  if (!res.ok) return res;
  return { ok: true, subscription: summariseSubscription(res.data) };
}

/**
 * One shape for a subscription, whether it arrived from a create, a read
 * or a webhook — so those three callers cannot disagree about where the
 * status lives. A webhook's copy carries no expanded invoice, which is why
 * everything below `metadata` is allowed to be null.
 */
function summariseSubscription(sub) {
  const s = sub || {};
  const invoice = s.latest_invoice && typeof s.latest_invoice === "object" ? s.latest_invoice : null;
  const intent = invoice && invoice.payment_intent && typeof invoice.payment_intent === "object"
    ? invoice.payment_intent : null;
  const item = s.items && Array.isArray(s.items.data) ? s.items.data[0] : null;
  return {
    id: s.id || null,
    status: s.status || null,
    customerId: typeof s.customer === "string" ? s.customer : (s.customer && s.customer.id) || null,
    priceId: item && item.price ? item.price.id : null,
    currentPeriodEnd: s.current_period_end || null,
    cancelAtPeriodEnd: !!s.cancel_at_period_end,
    metadata: s.metadata || {},
    clientSecret: intent ? intent.client_secret : null,
    intentStatus: intent ? intent.status : null,
    invoice: invoice ? {
      subtotalMinor: amountOr(invoice.subtotal, null),
      discountMinor: Array.isArray(invoice.total_discount_amounts) && invoice.total_discount_amounts.length
        ? invoice.total_discount_amounts.reduce((n, d) => n + (d.amount || 0), 0) : 0,
      taxMinor: amountOr(invoice.tax, 0),
      totalMinor: amountOr(invoice.total, null),
      currency: invoice.currency || null
    } : null
  };
}

/**
 * Which internal plan a subscription in this state is entitled to, or null
 * for "none, fall back to free".
 *
 * `past_due` keeps its plan on purpose: Stripe is still retrying the card,
 * and cutting someone off mid-retry over a bank's temporary decline is a
 * worse failure than a few days of unpaid access. Everything that is not
 * live — incomplete, incomplete_expired, unpaid, canceled, paused — is
 * free, including the `incomplete` a subscription sits in between being
 * created and its first payment clearing.
 */
function entitlementForStatus(status, plan) {
  const live = status === "active" || status === "trialing" || status === "past_due";
  return live ? entitlementFor(plan) : null;
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
  // Connect — the owner is the merchant.
  authorizeUrl, exchangeCode, deauthorize, createCheckoutSession,
  // Subscriptions — Souqi is the merchant.
  isBillingConfigured, publishableKey, planCatalogue, priceIdFor, entitlementFor,
  entitlementForStatus, getPrice, findOrCreateCustomer, lookupPromotionCode,
  createSubscription, getSubscription, summariseSubscription,
  verifyWebhook,
  formEncode, WEBHOOK_TOLERANCE_SEC
};
