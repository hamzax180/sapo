/* =================================================================
   dbproviders/builtin.js — a database per project, on the shared cluster
   -----------------------------------------------------------------
   One Postgres DATABASE and one ROLE per project, on the souqi-userdb
   cluster. What keeps one customer out of another's data is Postgres's
   own privilege system, not anything this file invents:

     - the role has no CONNECT on any database but its own, so reaching
       another tenant's data is refused at the connection, before a query
       is ever parsed;
     - it is not SUPERUSER, CREATEDB, CREATEROLE or BYPASSRLS, so it
       cannot grant itself the access it lacks;
     - the maintenance databases are closed to PUBLIC (db/userdb-init.sql),
       so it cannot stand somewhere else and work from there.

   HOW WE TALK TO IT. Not over a network. souqi-userdb is attached to app
   networks only and never to souqi_platform, so the worker has no route
   to it — that is deliberate, because a container on both would bridge
   every app to the platform database. Instead the worker uses the Docker
   socket it already owns: `docker exec -i souqi-userdb psql`, with the
   SQL on STDIN.

   Stdin, not `-c`, and not `psql "postgres://user:pass@..."`. A password
   in argv is visible in `ps` to every process in that namespace, which is
   the same reasoning scripts/backup.sh already states for pg_dump. The
   generated password would otherwise sit in the process table of a
   container customers' code can reach.

   IDENTIFIERS CANNOT BE PARAMETERIZED. `CREATE DATABASE $1` is not a
   thing in Postgres, so these names are built by string concatenation —
   the one place in this codebase where the "argv array, never a shell
   string" guarantee does not carry over. Two defences: names derive from
   the project id and nothing else (never user text), and they are passed
   through the same sanitiser engine.js uses for container names before
   they are quoted. scripts/verify.js asserts both.
   ================================================================= */
"use strict";

const crypto = require("crypto");
const { execFile } = require("child_process");
const { cfg } = require("../config");

// One name, from config, so the compose service, the network attach in
// engine.js and the psql calls below can never drift apart.
const CONTAINER = cfg.userDbContainer;
const SUPERUSER = process.env.USERDB_SUPERUSER || "souqiadmin";

/* Per-tenant ceilings. A single app must not be able to exhaust the
   cluster's connections or pin a backend open for ever — one tenant
   taking the database down takes every tenant down with it. */
const CONNECTION_LIMIT = Number(process.env.USERDB_CONNECTION_LIMIT || 20);
const STATEMENT_TIMEOUT = process.env.USERDB_STATEMENT_TIMEOUT || "30s";
const IDLE_TX_TIMEOUT = process.env.USERDB_IDLE_TX_TIMEOUT || "60s";

/**
 * project id -> a safe SQL identifier.
 *
 * Same character class engine.js allows in a container name, then a
 * length cap: Postgres truncates identifiers at 63 bytes, and a silent
 * truncation could collide two projects onto one database.
 */
function ident(prefix, projectId) {
  const safe = String(projectId || "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 48);
  if (!safe) throw new Error("refusing to build a database identifier from an empty project id");
  return prefix + safe.toLowerCase();
}

const dbNameFor = (projectId) => ident("db_", projectId);
const roleNameFor = (projectId) => ident("r_", projectId);

/** Double-quote an identifier the way quote_ident would. */
const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
/** Single-quote a literal (passwords). */
const lit = (v) => "'" + String(v).replace(/'/g, "''") + "'";

/**
 * Run SQL inside the userdb container, with the statements on stdin.
 *
 * ON_ERROR_STOP makes psql exit non-zero on the first failure instead of
 * ploughing through the rest of the script and reporting success.
 */
function psql(sql, opts) {
  const o = opts || {};
  const args = ["exec", "-i", CONTAINER, "psql",
    "-v", "ON_ERROR_STOP=1", "-U", SUPERUSER, "-d", o.database || "postgres"];
  if (o.tuplesOnly) args.push("-t", "-A");

  return new Promise((resolve) => {
    const child = execFile("docker", args, { timeout: o.timeoutMs || 30000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || "").trim(),
        // Never surface raw stderr to a caller that might log it: a failing
        // CREATE ROLE can echo the statement, and the statement contains
        // the password.
        error: err ? scrub(String(stderr || err.message)) : null
      });
    });
    child.stdin.end(sql);
  });
}

/** Strip anything that looks like a quoted password out of an error. */
function scrub(text) {
  return String(text).replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '***'").slice(0, 400);
}

const newPassword = () => crypto.randomBytes(24).toString("base64url");

function urlFor(role, password, dbName) {
  // The app dials the container by name over its own app network, the same
  // way Caddy reaches the app. No IP is ever baked into a credential.
  return "postgres://" + encodeURIComponent(role) + ":" + encodeURIComponent(password) +
    "@" + CONTAINER + ":5432/" + dbName;
}

/**
 * Create the database and role if they are not already there.
 *
 * Idempotent: a redeploy calls this every time and must not fail because
 * the database already exists, and must not rotate a live password —
 * doing so would break the running container that still holds the old one.
 */
async function provision(projectId, existing) {
  const dbName = dbNameFor(projectId);
  const role = roleNameFor(projectId);

  if (existing && existing.secret) {
    // Already provisioned. Trust the stored credential rather than
    // re-issuing one.
    return { ok: true, existed: true, url: urlFor(role, existing.secret, dbName), dbName, role };
  }

  const password = newPassword();

  /* Role and database first, in one script so a half-created tenant is
     not left behind. The DO block makes CREATE ROLE idempotent — there is
     no CREATE ROLE IF NOT EXISTS — and re-sets the password in the case
     where a role survived without a stored credential, which is the only
     way we could not otherwise recover. */
  const create = [
    "DO $$ BEGIN",
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = " + lit(role) + ") THEN",
    "    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT " + CONNECTION_LIMIT + "', " +
      lit(role) + ", " + lit(password) + ");",
    "  ELSE",
    "    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT " + CONNECTION_LIMIT + "', " +
      lit(role) + ", " + lit(password) + ");",
    "  END IF;",
    "END $$;",
    // No SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS: a tenant must not be able
    // to grant itself what it does not have.
    "ALTER ROLE " + q(role) + " NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;",
    "ALTER ROLE " + q(role) + " SET statement_timeout = " + lit(STATEMENT_TIMEOUT) + ";",
    "ALTER ROLE " + q(role) + " SET idle_in_transaction_session_timeout = " + lit(IDLE_TX_TIMEOUT) + ";",
    ""
  ].join("\n");

  const roleRes = await psql(create);
  if (!roleRes.ok) return { ok: false, error: "could not create the database role — " + roleRes.error };

  // CREATE DATABASE cannot run inside a transaction block, so it is its
  // own call rather than part of the script above.
  const exists = await psql("SELECT 1 FROM pg_database WHERE datname = " + lit(dbName) + ";",
    { tuplesOnly: true });
  if (exists.ok && exists.stdout !== "1") {
    const made = await psql("CREATE DATABASE " + q(dbName) + " OWNER " + q(role) + ";");
    if (!made.ok) return { ok: false, error: "could not create the database — " + made.error };
  }

  /* The grants that actually isolate. REVOKE ... FROM PUBLIC is the
     important half: without it every role on the cluster can connect to
     this database, and per-role grants would be decoration. */
  const grants = [
    "REVOKE ALL ON DATABASE " + q(dbName) + " FROM PUBLIC;",
    "GRANT CONNECT, TEMPORARY ON DATABASE " + q(dbName) + " TO " + q(role) + ";"
  ].join("\n");
  const g1 = await psql(grants);
  if (!g1.ok) return { ok: false, error: "could not set database privileges — " + g1.error };

  const inside = [
    "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
    "GRANT ALL ON SCHEMA public TO " + q(role) + ";",
    "ALTER SCHEMA public OWNER TO " + q(role) + ";"
  ].join("\n");
  const g2 = await psql(inside, { database: dbName });
  if (!g2.ok) return { ok: false, error: "could not set schema privileges — " + g2.error };

  return { ok: true, existed: false, url: urlFor(role, password, dbName), dbName, role, secret: password };
}

/**
 * Drop the database and the role.
 *
 * WITH (FORCE) terminates live backends: an app container holding a
 * connection would otherwise block the drop indefinitely, and by the time
 * this runs the project is being deleted anyway.
 */
async function destroy(projectId) {
  const dbName = dbNameFor(projectId);
  const role = roleNameFor(projectId);

  const dropped = await psql("DROP DATABASE IF EXISTS " + q(dbName) + " WITH (FORCE);", { timeoutMs: 60000 });
  if (!dropped.ok) return { ok: false, error: "could not drop the database — " + dropped.error };

  // The role can only go after the database it owns.
  const role_ = await psql("DROP ROLE IF EXISTS " + q(role) + ";");
  if (!role_.ok) return { ok: false, error: "database dropped, but the role remains — " + role_.error };

  return { ok: true };
}

/** Size on disk, for the dashboard and the soft cap. */
async function inspect(projectId) {
  const dbName = dbNameFor(projectId);
  const r = await psql(
    "SELECT pg_database_size(" + lit(dbName) + ")::bigint;",
    { tuplesOnly: true }
  );
  if (!r.ok) return { ok: false, reachable: false, error: r.error };
  const n = Number(r.stdout);
  return { ok: true, reachable: true, sizeBytes: Number.isFinite(n) ? n : null };
}

/** Is the cluster up? Used by health and before provisioning. */
async function ready() {
  const r = await psql("SELECT 1;", { tuplesOnly: true, timeoutMs: 8000 });
  return r.ok && r.stdout === "1";
}

module.exports = {
  mode: "builtin",
  provision, destroy, inspect, ready,
  dbNameFor, roleNameFor, ident,
  CONTAINER
};
