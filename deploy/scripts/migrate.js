/* =================================================================
   scripts/migrate.js — apply db/schema.sql
   -----------------------------------------------------------------
   The schema is written to be idempotent (IF NOT EXISTS everywhere,
   the enum guarded by an exception block), so this is safe to run on
   every deploy rather than only on a fresh database.
   ================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db");

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  try {
    await pool.query(sql);
    console.log("schema applied");
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log("tables:", rows.map((r) => r.table_name).join(", "));
  } catch (e) {
    console.error("migration failed:", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
