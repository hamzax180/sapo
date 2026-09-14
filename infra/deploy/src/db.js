/* =================================================================
   db.js — Postgres pool + the small query helpers everything uses
   ================================================================= */
"use strict";

const { Pool } = require("pg");
const { cfg } = require("./config");

const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });

pool.on("error", (err) => {
  // An idle client erroring is not fatal — the pool replaces it. Logging it
  // matters because a silent storm here is what a dying database looks like.
  console.error("[db] idle client error:", err.message);
});

const query = (text, params) => pool.query(text, params);

async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/** Runs fn inside a transaction, rolling back on any throw. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (e2) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx };
