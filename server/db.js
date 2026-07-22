/* =================================================================
   MERVEKS SAP backend — MongoDB connection
   A single shared client/db, lazily connected on first use.
   ================================================================= */
const { MongoClient } = require("mongodb");

let client = null;
let db = null;

async function connect() {
  if (db) return db;
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
  const name = process.env.DB_NAME || "merveks_sap";
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(name);
  // confirm the connection is actually live
  await db.command({ ping: 1 });
  console.log("✓ MongoDB connected →", name);
  return db;
}

function getDb() {
  if (!db) throw new Error("Database not connected — call connect() first.");
  return db;
}

/** Returns the master DB instance, or null if not yet connected. Safe for middleware use. */
function getMasterDb() {
  return db || null;
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

module.exports = { connect, getDb, getMasterDb, close };
