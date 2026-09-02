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
    // maxBuffer matters for the data browser: a page of rows comes back as
    // one JSON document, and the 1MB default would truncate it into invalid
    // JSON rather than fail loudly.
    const child = execFile("docker", args,
      { timeout: o.timeoutMs || 30000, maxBuffer: o.maxBuffer || 12 * 1024 * 1024 },
      (err, stdout, stderr) => {
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

/* ---------- the data browser ----------
   Read-only, and read-only in a way the transport enforces rather than
   the caller promising. No statement the browser sends is ever executed:
   the client names a table and a page, and everything else is built here.

   Results come back as ONE json document rather than psql's own text
   output. Parsing aligned columns means guessing where a value ends, and
   a value that contains the separator — a Markdown table in a text
   column, say — silently shifts every field after it. json_agg puts that
   problem on Postgres, which cannot get it wrong.

   THE IDENTIFIER RULE, again. A table name cannot be a bound parameter,
   so a browse request could otherwise concatenate user text into SQL. The
   name is therefore never trusted as given: it is looked up in the
   catalogue first, and the string that reaches the query is the one
   Postgres handed back, not the one the client sent. */

/** Row cap per page, and per-cell cap. Both exist so one `SELECT *` on a
    table of large blobs cannot pull the worker's memory over. */
const MAX_ROWS = 200;
const MAX_CELL = 2000;

/** Reads one JSON value out of the tenant's own database. */
async function readJson(projectId, sql, opts) {
  const r = await psql(sql, Object.assign({ database: dbNameFor(projectId), tuplesOnly: true }, opts || {}));
  if (!r.ok) return { ok: false, error: r.error };
  try {
    return { ok: true, value: JSON.parse(r.stdout || "[]") };
  } catch (e) {
    return { ok: false, error: "the database returned something that could not be read" };
  }
}

/**
 * Every table the app has made, with an approximate row count.
 *
 * reltuples is the planner's estimate, not a count. That is deliberate:
 * an exact count(*) is a full scan of every table on the page, which on a
 * table worth browsing is exactly when it hurts. The UI says "about".
 */
async function listTables(projectId) {
  return readJson(projectId, [
    "SELECT coalesce(json_agg(t ORDER BY t.name), '[]')::text FROM (",
    "  SELECT c.relname AS name,",
    /* NULL, not 0, when the planner has no estimate yet. reltuples is -1
       on a table that has never been analysed, which is the normal state
       of a table an app just created — and "about 0 rows" over a table
       with data in it is worse than saying nothing at all. */
    "         CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS approx_rows,",
    "         pg_total_relation_size(c.oid)::bigint AS bytes",
    "    FROM pg_class c",
    "    JOIN pg_namespace n ON n.oid = c.relnamespace",
    /* public only. A tenant cannot reach another database at all, but its
       own catalogue also holds Postgres's internal schemas, and listing
       those as if they were the customer's tables is just noise. */
    "   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')",
    ") t;"
  ].join("\n"));
}

/**
 * Resolve a client-supplied table name to the real one, or nothing.
 *
 * This is the security boundary for the whole browser. The returned
 * string comes from pg_class, so by the time it is concatenated into a
 * query it is a name Postgres itself produced.
 */
async function resolveTable(projectId, wanted) {
  const listed = await listTables(projectId);
  if (!listed.ok) return { ok: false, error: listed.error };
  const hit = listed.value.find((t) => t.name === String(wanted));
  if (!hit) return { ok: false, notFound: true, error: "no table by that name in this database" };
  // null stays null: "we do not know" is a different answer from "zero".
  const approx = hit.approx_rows == null ? null : Number(hit.approx_rows);
  return { ok: true, name: hit.name, approxRows: Number.isFinite(approx) ? approx : null };
}

/**
 * One page of a table.
 *
 * Columns are read separately from rows because a table with no rows
 * still has a shape, and a browser that shows nothing at all for an empty
 * table looks broken rather than empty.
 *
 * ORDER BY ctid is not a meaningful sort — it is physical position — but
 * it is stable within a page, and without any ORDER BY, LIMIT/OFFSET can
 * return the same row twice across two pages and never show another.
 */
async function readRows(projectId, table, opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(parseInt(o.limit, 10) || 50, 1), MAX_ROWS);
  const offset = Math.max(parseInt(o.offset, 10) || 0, 0);

  const found = await resolveTable(projectId, table);
  if (!found.ok) return found;
  const t = q(found.name);

  const cols = await readJson(projectId, [
    "SELECT coalesce(json_agg(a ORDER BY a.pos), '[]')::text FROM (",
    "  SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnum AS pos",
    "    FROM pg_attribute",
    "   WHERE attrelid = " + lit("public." + found.name) + "::regclass",
    "     AND attnum > 0 AND NOT attisdropped",
    ") a;"
  ].join("\n"));
  if (!cols.ok) return { ok: false, error: cols.error };

  /* Every column is cast to text and truncated HERE, in the database.
     Doing it after the fact would mean the oversized value had already
     been serialised, buffered and shipped — the cap has to bite before
     the row leaves Postgres to be worth anything. */
  const projection = cols.value.map((c) =>
    "left(" + q(c.name) + "::text, " + MAX_CELL + ") AS " + q(c.name)
  ).join(", ") || "1";

  const rows = await readJson(projectId, [
    "SELECT coalesce(json_agg(r), '[]')::text FROM (",
    "  SELECT " + projection + " FROM public." + t + " ORDER BY ctid LIMIT " + limit + " OFFSET " + offset,
    ") r;"
  ].join("\n"), { timeoutMs: 20000 });
  if (!rows.ok) return { ok: false, error: rows.error };

  return {
    ok: true,
    table: found.name,
    columns: cols.value.map((c) => ({ name: c.name, type: c.type })),
    rows: rows.value,
    limit, offset,
    approxRows: found.approxRows,
    // The page is full, so there is probably more. Cheaper and more
    // honest than a count(*) that would scan the table to say so.
    hasMore: rows.value.length === limit
  };
}

module.exports = {
  mode: "builtin",
  provision, destroy, inspect, ready,
  listTables, readRows, resolveTable,
  dbNameFor, roleNameFor, ident,
  CONTAINER
};
