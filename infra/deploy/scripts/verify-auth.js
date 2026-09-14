/* =================================================================
   scripts/verify-auth.js — the session boundary
   -----------------------------------------------------------------
   Kept separate from verify.js because these tests mutate process
   env and the cached config to simulate production, and a test that
   rewrites global state should not share a process with one that
   asserts against it.

   The check that matters most is the last one: that x-user-id alone
   no longer authenticates. The placeholder was removed rather than
   demoted to a fallback, because a route that accepts either is a
   route that accepts the weaker one.
   ================================================================= */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const SECRET = "test-secret-for-verification";
process.env.JWT_SECRET = SECRET;

const { cfg } = require("../src/config");
cfg.jwtSecret = SECRET;              // config caches at import
cfg.allowDevAuth = false;
cfg.authIntrospectUrl = "";          // local verification only, by default

const auth = require("../src/api/auth");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); failed++; }
}

const sign = (payload, opts) => jwt.sign(payload, SECRET, opts || { expiresIn: "1h" });

/** Runs the middleware and reports what it did. */
function callMiddleware(mw, req) {
  return new Promise((resolve) => {
    const out = { status: null, body: null, passedThrough: false };
    const res = {
      status(c) { out.status = c; return this; },
      json(b) { out.body = b; resolve(out); return this; },
      end() { resolve(out); return this; }
    };
    req.header = req.header || ((k) => req.headers[String(k).toLowerCase()]);
    req.headers = req.headers || {};
    req.method = req.method || "GET";
    Promise.resolve(mw(req, res, () => { out.passedThrough = true; resolve(out); }))
      .catch(() => resolve(out));
  });
}

async function main() {
  console.log("\n-- token verification ---------------------------------");

  await check("a valid session authenticates", () => {
    const u = auth.verifyToken(sign({ id: "u1", email: "a@b.c", wsId: "ws1" }));
    assert.strictEqual(u.id, "u1");
    assert.strictEqual(u.email, "a@b.c");
    assert.strictEqual(u.wsId, "ws1");
  });

  await check("a token signed with a different secret is rejected", () => {
    assert.strictEqual(auth.verifyToken(jwt.sign({ id: "u1" }, "other-secret")), null);
  });

  await check("an expired token is rejected", () => {
    assert.strictEqual(auth.verifyToken(sign({ id: "u1" }, { expiresIn: "-1s" })), null);
  });

  await check("a token carrying no id is rejected", () => {
    assert.strictEqual(auth.verifyToken(sign({ email: "a@b.c" })), null);
  });

  await check("a tampered payload is rejected", () => {
    const parts = sign({ id: "u1" }).split(".");
    const forged = Buffer.from(JSON.stringify({ id: "admin" })).toString("base64url");
    assert.strictEqual(auth.verifyToken(parts[0] + "." + forged + "." + parts[2]), null);
  });

  console.log("\n-- token extraction -----------------------------------");

  await check("reads the sq_session cookie", () => {
    const t = sign({ id: "u1" });
    assert.strictEqual(auth.tokenFrom({ headers: { cookie: "sq_session=" + t } }), t);
  });
  await check("accepts Authorization: Bearer", () => {
    const t = sign({ id: "u1" });
    assert.strictEqual(auth.tokenFrom({ headers: { authorization: "Bearer " + t } }), t);
  });
  await check("finds the cookie among others", () => {
    const t = sign({ id: "u1" });
    assert.strictEqual(auth.tokenFrom({ headers: { cookie: "a=1; sq_session=" + t + "; b=2" } }), t);
  });
  await check("no credentials means no token", () => {
    assert.strictEqual(auth.tokenFrom({ headers: {} }), null);
  });

  console.log("\n-- the placeholder is gone ----------------------------");

  await check("x-user-id alone does NOT authenticate", async () => {
    cfg.allowDevAuth = false;
    const r = await callMiddleware(auth.requireUser, {
      headers: { "x-user-id": "someone-else" }, method: "POST"
    });
    assert.strictEqual(r.passedThrough, false, "an unauthenticated request reached the handler");
    assert.strictEqual(r.status, 401);
  });

  await check("a real session does authenticate", async () => {
    const r = await callMiddleware(auth.requireUser, {
      headers: { cookie: "sq_session=" + sign({ id: "u7", email: "x@y.z" }) }, method: "POST"
    });
    assert.strictEqual(r.passedThrough, true, "a valid session was rejected");
  });

  await check("server.js no longer reads x-user-id directly", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(!/req\.header\("x-user-id"\)/.test(src), "server.js still trusts the header");
    assert.ok(src.includes("auth.requireUser"), "server.js is not using the auth module");
  });

  console.log("\n-- revocation -----------------------------------------");

  await check("with no introspection configured, a valid token is valid", async () => {
    cfg.authIntrospectUrl = "";
    assert.strictEqual(await auth.checkRevocation(sign({ id: "u1" })), "valid");
  });

  await check("an unreachable introspection endpoint reports unknown, not valid", async () => {
    cfg.authIntrospectUrl = "http://127.0.0.1:9/none";   // discard port: always refused
    const state = await auth.checkRevocation(sign({ id: "u1" }));
    cfg.authIntrospectUrl = "";
    assert.strictEqual(state, "unknown", "an outage was reported as a valid session");
  });

  await check("reads survive an introspection outage, mutations do not", async () => {
    cfg.authIntrospectUrl = "http://127.0.0.1:9/none";
    const token = sign({ id: "u9", email: "a@b.c" });
    const cookie = "sq_session=" + token;

    const read = await callMiddleware(auth.requireUser, { headers: { cookie }, method: "GET" });
    const write = await callMiddleware(auth.requireUser, { headers: { cookie }, method: "POST" });
    cfg.authIntrospectUrl = "";

    assert.strictEqual(read.passedThrough, true, "a read was blocked by an outage");
    assert.strictEqual(write.passedThrough, false, "a mutation ran without a revocation check");
    assert.strictEqual(write.status, 503);
  });

  console.log("\n-- boot guards ----------------------------------------");

  await check("dev auth is fatal in production", () => {
    const prev = process.env.NODE_ENV;
    cfg.allowDevAuth = true; process.env.NODE_ENV = "production";
    const r = auth.assertAuthConfig();
    process.env.NODE_ENV = prev; cfg.allowDevAuth = false;
    assert.ok(r.fatal.some((m) => /ALLOW_DEV_AUTH/.test(m)), "no fatal error raised");
  });

  await check("a default JWT secret is fatal in production", () => {
    const prevSecret = cfg.jwtSecret, prevEnv = process.env.NODE_ENV;
    cfg.jwtSecret = "dev-insecure-secret"; process.env.NODE_ENV = "production";
    const r = auth.assertAuthConfig();
    cfg.jwtSecret = prevSecret; process.env.NODE_ENV = prevEnv;
    assert.ok(r.fatal.some((m) => /JWT_SECRET/.test(m)), "a forgeable secret was allowed");
  });

  await check("a missing introspection URL warns but does not block boot", () => {
    const prev = cfg.authIntrospectUrl;
    cfg.authIntrospectUrl = "";
    const r = auth.assertAuthConfig();
    cfg.authIntrospectUrl = prev;
    assert.strictEqual(r.fatal.length, 0);
    assert.ok(r.warn.some((m) => /AUTH_INTROSPECT_URL/.test(m)));
  });

  console.log("\n-- internal endpoints ---------------------------------");

  await check("the wrong shared secret is refused", async () => {
    cfg.internalToken = "abc123";
    const r = await callMiddleware(auth.requireInternal, { headers: { "x-internal-token": "wrong!!" } });
    assert.strictEqual(r.passedThrough, false);
    assert.strictEqual(r.status, 401);
  });

  await check("the right shared secret is accepted", async () => {
    cfg.internalToken = "abc123";
    const r = await callMiddleware(auth.requireInternal, { headers: { "x-internal-token": "abc123" } });
    assert.strictEqual(r.passedThrough, true);
  });

  await check("internal endpoints are disabled when no secret is set", async () => {
    cfg.internalToken = "";
    const r = await callMiddleware(auth.requireInternal, { headers: {} });
    assert.strictEqual(r.passedThrough, false);
    assert.strictEqual(r.status, 503);
  });

  console.log("\n-- control plane --------------------------------------");

  const TOK = "t".repeat(64);
  const armControl = () => { cfg.controlDomain = "deploy.example.com"; cfg.platformToken = TOK; };
  const onControl = (token) => ({
    hostname: "deploy.example.com",
    headers: token === undefined ? {} : { "x-platform-token": token }
  });

  await check("no token on the control hostname is refused", async () => {
    armControl();
    const r = await callMiddleware(auth.requirePlatformToken, onControl(undefined));
    assert.strictEqual(r.passedThrough, false);
    assert.strictEqual(r.status, 401);
  });

  await check("a wrong token on the control hostname is refused", async () => {
    armControl();
    const r = await callMiddleware(auth.requirePlatformToken, onControl("x".repeat(64)));
    assert.strictEqual(r.status, 401);
  });

  // A length mismatch takes a different branch than a content mismatch:
  // timingSafeEqual throws on unequal buffers rather than returning false.
  // Both have to end in a 401, not a 500.
  await check("a token of the wrong length is refused, not a crash", async () => {
    armControl();
    const r = await callMiddleware(auth.requirePlatformToken, onControl("short"));
    assert.strictEqual(r.status, 401);
  });

  await check("the right token on the control hostname passes", async () => {
    armControl();
    const r = await callMiddleware(auth.requirePlatformToken, onControl(TOK));
    assert.strictEqual(r.passedThrough, true);
  });

  await check("host matching is case-insensitive", async () => {
    armControl();
    const r = await callMiddleware(auth.requirePlatformToken,
      { hostname: "DEPLOY.EXAMPLE.COM", headers: { "x-platform-token": TOK } });
    assert.strictEqual(r.passedThrough, true);
  });

  // The worker and the TLS ask dial api:4500 carrying no platform token,
  // and must not need one, or the stack stops working internally.
  await check("an internal caller is not gated", async () => {
    armControl();
    const r = await callMiddleware(auth.requirePlatformToken, { hostname: "api", headers: {} });
    assert.strictEqual(r.passedThrough, true);
  });

  // Caddy would never route this here, but the gate must not be the thing
  // that assumes so: a suffix match instead of equality would let it pass.
  await check("a hostname that merely CONTAINS the control domain is not it", async () => {
    armControl();
    const r = await callMiddleware(auth.requirePlatformToken,
      { hostname: "deploy.example.com.evil.test", headers: {} });
    assert.strictEqual(r.passedThrough, true);
  });

  await check("a routed control domain with no token set fails closed", async () => {
    cfg.controlDomain = "deploy.example.com"; cfg.platformToken = "";
    const r = await callMiddleware(auth.requirePlatformToken, onControl("anything"));
    assert.strictEqual(r.passedThrough, false);
    assert.strictEqual(r.status, 503);
  });

  await check("with no control domain the gate is inert", async () => {
    cfg.controlDomain = ""; cfg.platformToken = "";
    const r = await callMiddleware(auth.requirePlatformToken, { hostname: "anything", headers: {} });
    assert.strictEqual(r.passedThrough, true);
  });

  await check("a control domain without a token is fatal in production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    cfg.controlDomain = "deploy.example.com"; cfg.platformToken = "";
    const r = auth.assertAuthConfig();
    process.env.NODE_ENV = prev;
    assert.ok(r.fatal.some((m) => /DEPLOY_PLATFORM_TOKEN/.test(m)), "boot was allowed");
  });

  // The gate keys off how a request ARRIVED, so it is mounted before the
  // routes rather than on each one: otherwise every new route is published
  // by default and protected only if someone remembers to say so.
  await check("the gate is mounted app-wide, before any route", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src/api/server.js"), "utf8");
    const gate = src.indexOf("app.use(auth.requirePlatformToken)");
    assert.ok(gate !== -1, "gate is not mounted app-wide");
    const firstRoute = src.search(/app\.(get|post|put|delete)\(/);
    assert.ok(firstRoute === -1 || gate < firstRoute, "gate is mounted after a route");
  });

  console.log("\n" + (failed === 0
    ? "OK  all " + passed + " session checks passed"
    : "FAILED  " + failed + " of " + (passed + failed)));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
