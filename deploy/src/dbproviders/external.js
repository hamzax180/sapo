/* =================================================================
   dbproviders/external.js — the customer's own database
   -----------------------------------------------------------------
   A connection string the customer supplies, used verbatim. This
   provider creates nothing and owns nothing; provision() is a
   validation step, and destroy() deliberately does not touch the remote
   database. Deleting a project on this platform must never drop a
   database on someone else's Neon or RDS account.

   Every managed Postgres hands you a connection string, so one string
   covers Neon, Supabase, RDS, Cloud SQL and a box under a desk.

   VALIDATION HAPPENS ON THE PLATFORM SIDE, and that placement is the
   point. api and worker both sit on souqi_platform, which is not
   internal, so both have the egress to reach an external host — the app
   containers never do. So the api can validate a URL in the request that
   saves it, and does: one connection and a SELECT 1, refused with the
   reason there and then rather than accepted and discovered as a crash
   loop three minutes into a deploy.

   This is also the one provider the api may import. Everything in
   builtin.js shells out to `docker exec`, which the api has no socket
   for; this file needs a Postgres client and nothing else.
   ================================================================= */
"use strict";

const { Client } = require("pg");

const CONNECT_TIMEOUT_MS = 8000;

/**
 * Parse and sanity-check before we ever open a socket.
 *
 * Rejecting an obviously wrong string here gives a better message than a
 * connection timeout, and stops us dialling something that was never a
 * database in the first place.
 */
function parse(url) {
  let u;
  try { u = new URL(String(url || "").trim()); }
  catch (e) { return { ok: false, error: "that does not look like a connection URL" }; }

  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    return { ok: false, error: "only postgres:// URLs are supported, not " + u.protocol.replace(":", "") };
  }
  if (!u.hostname) return { ok: false, error: "the URL has no host" };
  if (!u.pathname || u.pathname === "/") return { ok: false, error: "the URL has no database name" };

  /* An external database on localhost is either a mistake or an attempt to
     reach something on the host from inside our network. Neither is what
     this feature is for, and the app container could not reach it anyway —
     its network is --internal. Refusing with a reason beats a deploy that
     silently cannot connect. */
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
    return { ok: false, error: "that points at localhost, which your app's container cannot reach — use a host that is reachable from the internet" };
  }
  return { ok: true, url: u };
}

/**
 * Store the customer's URL, after proving it works.
 *
 * `existing.secret` is the URL itself for this provider — there is no
 * separate password, because the string carries one.
 */
async function provision(projectId, existing) {
  const raw = (existing && existing.secret) || null;
  if (!raw) {
    return { ok: false, error: "no external database URL has been set for this project" };
  }

  const parsed = parse(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const check = await test(raw);
  if (!check.ok) return { ok: false, error: check.error };

  return { ok: true, existed: true, url: raw, dbName: parsed.url.pathname.slice(1), role: parsed.url.username || null };
}

/** One connection and one trivial query, at a given TLS setting. */
async function attempt(url, ssl) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: CONNECT_TIMEOUT_MS,
    ssl: ssl
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true };
  } catch (e) {
    // The message can echo the connection string; keep the password out.
    return { ok: false, error: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* already gone */ }
  }
}

/**
 * Can we actually reach this database?
 *
 * TLS is tried first and plaintext second, which is libpq's own default
 * (`sslmode=prefer`) and is the behaviour a connection string implies when
 * it says nothing about SSL. Both halves are needed and for opposite
 * reasons: every managed provider requires TLS, and a self-hosted Postgres
 * usually has none at all. Trying only TLS refused a working database with
 * "the server does not support SSL connections" — accurate, useless, and
 * fixable only by knowing to append sslmode=disable.
 *
 * The certificate is not verified. These are customer-supplied hosts whose
 * CAs we do not carry, and refusing them would reject most real databases;
 * what establishes that the customer's own provider is on the other end is
 * their credentials, not our trust store. sslmode=require in their URL is
 * honoured as written — no plaintext fallback — so someone who insists on
 * TLS gets a failure rather than a silent downgrade.
 */
async function test(url) {
  const parsed = parse(url);
  if (!parsed.ok) return parsed;

  const mode = (/[?&]sslmode=([a-z-]+)/i.exec(url) || [])[1];
  if (mode === "disable") {
    const plain = await attempt(url, false);
    return plain.ok ? plain : { ok: false, error: "could not connect — " + scrub(plain.error) };
  }

  const secure = await attempt(url, { rejectUnauthorized: false });
  if (secure.ok) return secure;

  // Only fall back when the server itself turned TLS down. A wrong password
  // or an unreachable host must not be retried as though it were a TLS
  // problem, and must not report the second failure instead of the first.
  const refusedTls = /does not support SSL|server does not support/i.test(secure.error || "");
  if (!refusedTls || mode === "require" || mode === "verify-ca" || mode === "verify-full") {
    return { ok: false, error: "could not connect — " + scrub(secure.error) };
  }

  const plain = await attempt(url, false);
  return plain.ok ? plain : { ok: false, error: "could not connect — " + scrub(plain.error) };
}

function scrub(text) {
  return String(text || "")
    .replace(/postgres(ql)?:\/\/[^\s]*/gi, "postgres://***")
    .slice(0, 300);
}

/** Intentionally a no-op: we did not create it, we do not delete it. */
async function destroy() {
  return { ok: true, skipped: true, reason: "external databases are not deleted by this platform" };
}

async function inspect(projectId, existing) {
  const raw = existing && existing.secret;
  if (!raw) return { ok: false, reachable: false, error: "no URL set" };
  const t = await test(raw);
  // Size is the provider's business, not ours.
  return { ok: t.ok, reachable: t.ok, sizeBytes: null, error: t.error || null };
}

const ready = async () => true;

module.exports = { mode: "external", provision, destroy, inspect, ready, test, parse };
