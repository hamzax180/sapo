/* =================================================================
   stripe-test.js — lib/stripe.js's contract, no network
   -----------------------------------------------------------------
   Everything here is provable with a stubbed transport. The two
   things worth the most attention:

     • verifyWebhook. We do not use the `stripe` package, so its
       signature check is ours to get right. A wrong one is not a
       broken feature, it is an endpoint that accepts forged payment
       events from anybody.
     • Direct charges. createCheckoutSession must send
       `Stripe-Account`, or the charge lands on Souqi's platform
       account and Souqi silently becomes the merchant of record for
       someone else's shop.

   Run: node stripe-test.js
   ================================================================= */
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const stripe = require("./lib/stripe");

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(
      () => { passed++; console.log("  ✓ " + name); },
      (e) => { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
    );
    passed++; console.log("  ✓ " + name);
  } catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
  return Promise.resolve();
}

/** Records what was sent so a test can assert on headers and body. */
function recordingFetch(responseJson, ok) {
  const box = { calls: [] };
  box.impl = async (url, opts) => {
    box.calls.push({ url: url, headers: opts.headers, body: opts.body });
    return { ok: ok !== false, status: ok === false ? 402 : 200, json: async () => responseJson };
  };
  return box;
}

const CONFIGURED = { clientId: "ca_test", secretKey: "sk_test_123", webhookSecret: "whsec_test" };

(async () => {
  console.log("\n── configuration is opt-in ──────────────────────────");

  await check("no env -> isConfigured() is false, nothing half-works", () => {
    stripe.init({ clientId: "", secretKey: "", webhookSecret: "" });
    assert.strictEqual(stripe.isConfigured(), false);
  });

  await check("a client id alone is not enough — OAuth needs both halves", () => {
    stripe.init({ clientId: "ca_test", secretKey: "" });
    assert.strictEqual(stripe.isConfigured(), false);
  });

  await check("both present -> configured", () => {
    stripe.init(CONFIGURED);
    assert.strictEqual(stripe.isConfigured(), true);
  });

  await check("livemode is read from the key prefix, not guessed", () => {
    stripe.init({ clientId: "ca_x", secretKey: "sk_live_abc" });
    assert.strictEqual(stripe.livemode(), true);
    stripe.init({ clientId: "ca_x", secretKey: "sk_test_abc" });
    assert.strictEqual(stripe.livemode(), false);
  });

  console.log("\n── form encoding (Stripe's bracketed shape) ─────────");

  await check("nested objects and arrays encode the way Stripe expects", () => {
    const out = stripe.formEncode({
      mode: "payment",
      line_items: [{ quantity: 2, price_data: { currency: "usd", unit_amount: 500 } }]
    });
    assert.ok(out.includes("mode=payment"), out);
    assert.ok(out.includes(encodeURIComponent("line_items[0][quantity]") + "=2"), out);
    assert.ok(out.includes(encodeURIComponent("line_items[0][price_data][unit_amount]") + "=500"), out);
  });

  await check("null and undefined are omitted, not sent as the strings 'null'/'undefined'", () => {
    const out = stripe.formEncode({ a: 1, b: null, c: undefined });
    assert.ok(out.includes("a=1"));
    assert.ok(!out.includes("b="), out);
    assert.ok(!out.includes("c="), out);
  });

  await check("values are URL-escaped — a name with & cannot inject another field", () => {
    const out = stripe.formEncode({ name: "Tea & Coffee=2" });
    assert.ok(!/name=Tea & Coffee/.test(out), out);
    assert.ok(out.includes("name=" + encodeURIComponent("Tea & Coffee=2")), out);
  });

  console.log("\n── OAuth ────────────────────────────────────────────");

  await check("authorizeUrl refuses to build a URL without state — that state IS the CSRF guard", () => {
    stripe.init(CONFIGURED);
    assert.throws(() => stripe.authorizeUrl(""), /state is required/);
  });

  await check("authorizeUrl carries client_id, read_write scope and the state", () => {
    stripe.init(CONFIGURED);
    const url = stripe.authorizeUrl("st_abc", "https://souqi.test/cb");
    assert.ok(url.startsWith("https://connect.stripe.com/oauth/authorize?"), url);
    assert.ok(url.includes("client_id=ca_test"));
    assert.ok(url.includes("scope=read_write"));
    assert.ok(url.includes("state=st_abc"));
    assert.ok(url.includes(encodeURIComponent("https://souqi.test/cb")));
  });

  await check("exchangeCode returns the connected account id", async () => {
    const f = recordingFetch({ stripe_user_id: "acct_123", livemode: false });
    stripe.init(Object.assign({}, CONFIGURED, { fetchImpl: f.impl }));
    const out = await stripe.exchangeCode("ac_code");
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.accountId, "acct_123");
    assert.ok(f.calls[0].url.includes("/oauth/token"));
  });

  await check("a token response with no account id is a failure, not a silent connect", async () => {
    const f = recordingFetch({});
    stripe.init(Object.assign({}, CONFIGURED, { fetchImpl: f.impl }));
    const out = await stripe.exchangeCode("ac_code");
    assert.strictEqual(out.ok, false);
    assert.ok(/account id/.test(out.reason));
  });

  console.log("\n── checkout: the money must go to the OWNER ─────────");

  await check("the session is created ON the connected account (Stripe-Account header)", async () => {
    const f = recordingFetch({ id: "cs_1", url: "https://checkout.stripe.com/x", amount_total: 1000 });
    stripe.init(Object.assign({}, CONFIGURED, { fetchImpl: f.impl }));
    const out = await stripe.createCheckoutSession({
      account: "acct_owner", items: [{ name: "Tea", amountMinor: 500, currency: "usd", quantity: 2 }],
      successUrl: "https://s/ok", cancelUrl: "https://s/no"
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.url, "https://checkout.stripe.com/x");
    assert.strictEqual(f.calls[0].headers["Stripe-Account"], "acct_owner",
      "without this header the charge lands on Souqi's own account");
  });

  await check("no connected account -> refused before any network call", async () => {
    const f = recordingFetch({});
    stripe.init(Object.assign({}, CONFIGURED, { fetchImpl: f.impl }));
    const out = await stripe.createCheckoutSession({ items: [{ name: "x", amountMinor: 1 }] });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(f.calls.length, 0);
  });

  await check("an empty basket is refused — no zero-value sessions", async () => {
    stripe.init(CONFIGURED);
    const out = await stripe.createCheckoutSession({ account: "acct_1", items: [] });
    assert.strictEqual(out.ok, false);
  });

  await check("mixed currencies are refused with a clear reason, not sent to fail obscurely", async () => {
    stripe.init(CONFIGURED);
    const out = await stripe.createCheckoutSession({
      account: "acct_1",
      items: [{ name: "a", amountMinor: 100, currency: "usd" }, { name: "b", amountMinor: 100, currency: "eur" }]
    });
    assert.strictEqual(out.ok, false);
    assert.ok(/share a currency/.test(out.reason));
  });

  await check("with no fee configured, no application_fee_amount is sent at all", async () => {
    const f = recordingFetch({ id: "cs_1", url: "u" });
    stripe.init(Object.assign({}, CONFIGURED, { fetchImpl: f.impl, feeBps: 0 }));
    await stripe.createCheckoutSession({
      account: "acct_1", items: [{ name: "x", amountMinor: 1000, currency: "usd", quantity: 1 }],
      successUrl: "s", cancelUrl: "c"
    });
    assert.ok(!f.calls[0].body.includes("application_fee_amount"),
      "sending a zero fee is not the same as sending none");
  });

  await check("a configured fee is applied in basis points on the basket total", async () => {
    const f = recordingFetch({ id: "cs_1", url: "u" });
    stripe.init(Object.assign({}, CONFIGURED, { fetchImpl: f.impl, feeBps: 250 })); // 2.5%
    await stripe.createCheckoutSession({
      account: "acct_1", items: [{ name: "x", amountMinor: 1000, currency: "usd", quantity: 2 }],
      successUrl: "s", cancelUrl: "c"
    });
    // 2 × 1000 = 2000 minor units; 2.5% = 50
    assert.ok(f.calls[0].body.includes(encodeURIComponent("payment_intent_data[application_fee_amount]") + "=50"),
      f.calls[0].body);
  });

  await check("a Stripe error degrades to {ok:false, reason} — it never throws", async () => {
    const f = recordingFetch({ error: { message: "Your card was declined." } }, false);
    stripe.init(Object.assign({}, CONFIGURED, { fetchImpl: f.impl }));
    const out = await stripe.createCheckoutSession({
      account: "acct_1", items: [{ name: "x", amountMinor: 100, currency: "usd" }],
      successUrl: "s", cancelUrl: "c"
    });
    assert.strictEqual(out.ok, false);
    assert.ok(/declined/.test(out.reason));
  });

  console.log("\n── webhook verification (forged events must not pass) ──");

  function sign(body, secret, ts) {
    const t = ts || Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", secret).update(t + "." + body).digest("hex");
    return { header: "t=" + t + ",v1=" + sig, body: body };
  }

  await check("a correctly signed event verifies and is parsed", () => {
    stripe.init(CONFIGURED);
    const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } });
    const s = sign(body, "whsec_test");
    const out = stripe.verifyWebhook(Buffer.from(body), s.header);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.event.type, "checkout.session.completed");
  });

  await check("a WRONG secret is rejected — this is the forgery case", () => {
    stripe.init(CONFIGURED);
    const body = JSON.stringify({ type: "x" });
    const s = sign(body, "whsec_attacker");
    const out = stripe.verifyWebhook(Buffer.from(body), s.header);
    assert.strictEqual(out.ok, false);
    assert.ok(/signature mismatch/.test(out.reason));
  });

  await check("a tampered body is rejected even with a once-valid signature", () => {
    stripe.init(CONFIGURED);
    const body = JSON.stringify({ amount: 100 });
    const s = sign(body, "whsec_test");
    const tampered = JSON.stringify({ amount: 999999 });
    const out = stripe.verifyWebhook(Buffer.from(tampered), s.header);
    assert.strictEqual(out.ok, false);
  });

  await check("an old timestamp is rejected — a captured event cannot be replayed", () => {
    stripe.init(CONFIGURED);
    const body = JSON.stringify({ type: "x" });
    const old = Math.floor(Date.now() / 1000) - (stripe.WEBHOOK_TOLERANCE_SEC + 60);
    const s = sign(body, "whsec_test", old);
    const out = stripe.verifyWebhook(Buffer.from(body), s.header);
    assert.strictEqual(out.ok, false);
    assert.ok(/replay|tolerance/.test(out.reason), out.reason);
  });

  await check("a malformed signature header is rejected, not crashed on", () => {
    stripe.init(CONFIGURED);
    for (const h of ["", "garbage", "t=123", "v1=abc", "t=,v1="]) {
      const out = stripe.verifyWebhook(Buffer.from("{}"), h);
      assert.strictEqual(out.ok, false, "header " + JSON.stringify(h) + " should not verify");
    }
  });

  await check("no webhook secret configured -> rejected, never accepted-by-default", () => {
    stripe.init({ clientId: "ca", secretKey: "sk_test", webhookSecret: "" });
    const out = stripe.verifyWebhook(Buffer.from("{}"), "t=1,v1=abc");
    assert.strictEqual(out.ok, false);
    assert.ok(/not configured/.test(out.reason));
  });

  await check("multiple v1 signatures (Stripe's key-rotation form) — any one matching passes", () => {
    stripe.init(CONFIGURED);
    const body = JSON.stringify({ type: "x" });
    const t = Math.floor(Date.now() / 1000);
    const good = crypto.createHmac("sha256", "whsec_test").update(t + "." + body).digest("hex");
    const header = "t=" + t + ",v1=" + "0".repeat(64) + ",v1=" + good;
    const out = stripe.verifyWebhook(Buffer.from(body), header);
    assert.strictEqual(out.ok, true);
  });

  await check("a verified signature over a non-JSON body fails cleanly", () => {
    stripe.init(CONFIGURED);
    const body = "not json at all";
    const s = sign(body, "whsec_test");
    const out = stripe.verifyWebhook(Buffer.from(body), s.header);
    assert.strictEqual(out.ok, false);
    assert.ok(/not JSON/.test(out.reason));
  });

  console.log("\n" + (failed === 0 ? "✓ ALL STRIPE TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
