/* =================================================================
   WeboCloud Database Adapter
   -----------------------------------------------------------------
   Dynamically manages and caches connections for multiple client
   databases (MongoDB or PostgreSQL/Neon).
   Provides a unified CRUD interface for the Express backend.
   ================================================================= */
const { MongoClient } = require("mongodb");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const connectionCache = {}; // Caches workspace connection pools/clients

// Allowed collections
const COLLECTIONS = [
  "users",
  "clients",
  "suppliers",
  "products",
  "quotes",
  "orders",
  "shipments",
  "invoices",
  "purchaseorders",
  "bills",
  "payments",
  "notifications",
  "audit"
];

/**
 * Gets or creates the database connection client for a workspace config
 */
async function getDbClient(workspace) {
  const { workspaceId, dbType, dbUri } = workspace;
  const cacheKey = `${workspaceId}_${dbType}`;

  if (connectionCache[cacheKey]) {
    return connectionCache[cacheKey];
  }

  if (dbType === "mongodb") {
    console.log(`[DB] Connecting to MongoDB for workspace: ${workspaceId}`);
    const client = new MongoClient(dbUri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    // Parse DB name from URI or use default
    const dbName = dbUri.split("/").pop().split("?")[0] || `webo_${workspaceId}`;
    const db = client.db(dbName);
    const connObj = { type: "mongodb", db, client };
    connectionCache[cacheKey] = connObj;
    return connObj;
  } else if (dbType === "postgres" || dbType === "neon") {
    console.log(`[DB] Connecting to PostgreSQL/Neon for workspace: ${workspaceId}`);
    const pool = new Pool({
      connectionString: dbUri,
      connectionTimeoutMillis: 5000,
      ssl: dbUri.includes("sslmode=require") || dbUri.includes("neon.tech") ? { rejectUnauthorized: false } : false
    });
    // Test the connection pool
    await pool.query("SELECT 1");
    const connObj = { type: "postgres", pool };
    connectionCache[cacheKey] = connObj;
    return connObj;
  } else {
    throw new Error(`Unsupported database type: ${dbType}`);
  }
}

/**
 * Validates a connection string
 */
async function testConnection(dbType, dbUri) {
  if (dbType === "mongodb") {
    const client = new MongoClient(dbUri, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    await client.db().command({ ping: 1 });
    await client.close();
    return true;
  } else if (dbType === "postgres" || dbType === "neon") {
    const pool = new Pool({
      connectionString: dbUri,
      connectionTimeoutMillis: 3000,
      ssl: dbUri.includes("sslmode=require") || dbUri.includes("neon.tech") ? { rejectUnauthorized: false } : false
    });
    await pool.query("SELECT 1");
    await pool.end();
    return true;
  }
  throw new Error("Invalid database type specified.");
}

/**
 * Loads default seed data from the browser source of truth
 */
function loadSeedData() {
  const seedPath = path.join(__dirname, "..", "public", "js", "seed.js");
  if (!fs.existsSync(seedPath)) {
    console.warn("[DB] public/js/seed.js not found, skipping template seeding.");
    return null;
  }
  const code = fs.readFileSync(seedPath, "utf8");
  const sandbox = { window: {} };
  try {
    new Function("window", code)(sandbox.window);
    if (typeof sandbox.window.SEED_DATA === "function") {
      return sandbox.window.SEED_DATA();
    }
  } catch (err) {
    console.error("[DB] Failed to evaluate js/seed.js:", err);
  }
  return null;
}

/**
 * Seeds tables/collections inside a newly provisioned database
 */
async function seedWorkspaceDatabase(workspace) {
  const conn = await getDbClient(workspace);
  const seedData = loadSeedData();
  if (!seedData) return;

  const getCollName = (k) => k.replace(/^sap_/, "");

  if (conn.type === "mongodb") {
    for (const key of Object.keys(seedData)) {
      const name = getCollName(key);
      if (!COLLECTIONS.includes(name)) continue;

      const col = conn.db.collection(name);
      const count = await col.countDocuments();
      if (count === 0) {
        let records = seedData[key].map((r) => Object.assign({}, r));
        if (name === "users") {
          records = await Promise.all(records.map(async (u) => {
            if (u.password && !String(u.password).startsWith("$2")) {
              u.password = await bcrypt.hash(String(u.password), 10);
            }
            return u;
          }));
        }
        if (records.length > 0) {
          await col.insertMany(records);
        }
        await col.createIndex({ id: 1 }, { unique: true }).catch(() => {});
      }
    }
  } else if (conn.type === "postgres") {
    for (const key of Object.keys(seedData)) {
      const name = getCollName(key);
      if (!COLLECTIONS.includes(name)) continue;

      // 1. Create table with schema structure: id (PK) + data (JSONB)
      await conn.pool.query(`
        CREATE TABLE IF NOT EXISTS ${name} (
          id VARCHAR(100) PRIMARY KEY,
          data JSONB NOT NULL
        )
      `);

      // 2. Count existing records
      const countRes = await conn.pool.query(`SELECT COUNT(*) FROM ${name}`);
      const count = parseInt(countRes.rows[0].count, 10);

      if (count === 0) {
        let records = seedData[key].map((r) => Object.assign({}, r));
        if (name === "users") {
          records = await Promise.all(records.map(async (u) => {
            if (u.password && !String(u.password).startsWith("$2")) {
              u.password = await bcrypt.hash(String(u.password), 10);
            }
            return u;
          }));
        }

        // 3. Bulk insert using JSONB records
        for (const record of records) {
          await conn.pool.query(
            `INSERT INTO ${name} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
            [record.id, JSON.stringify(record)]
          );
        }
      }
    }
  }
}

/**
 * Unified CRUD Methods
 */
const dbAdapter = {
  // Read all records
  async findAll(workspace, collection) {
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      const docs = await conn.db.collection(collection).find({}).toArray();
      // Remove mongo _id field
      return docs.map(d => {
        const { _id, ...rest } = d;
        return rest;
      });
    } else {
      // Postgres: ensure table exists (dynamic creation if missed)
      await conn.pool.query(`CREATE TABLE IF NOT EXISTS ${collection} (id VARCHAR(100) PRIMARY KEY, data JSONB NOT NULL)`);
      const res = await conn.pool.query(`SELECT data FROM ${collection}`);
      return res.rows.map(r => r.data);
    }
  },

  // Read one record by ID
  async findOne(workspace, collection, id) {
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      const doc = await conn.db.collection(collection).findOne({ id });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return rest;
    } else {
      await conn.pool.query(`CREATE TABLE IF NOT EXISTS ${collection} (id VARCHAR(100) PRIMARY KEY, data JSONB NOT NULL)`);
      const res = await conn.pool.query(`SELECT data FROM ${collection} WHERE id = $1`, [id]);
      return res.rows.length ? res.rows[0].data : null;
    }
  },

  // Create one record
  async insertOne(workspace, collection, record) {
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      if (collection === "users" && record.password && !String(record.password).startsWith("$2")) {
        record.password = await bcrypt.hash(String(record.password), 10);
      }
      await conn.db.collection(collection).insertOne(Object.assign({}, record));
      const saved = await conn.db.collection(collection).findOne({ id: record.id });
      const { _id, ...rest } = saved;
      return rest;
    } else {
      await conn.pool.query(`CREATE TABLE IF NOT EXISTS ${collection} (id VARCHAR(100) PRIMARY KEY, data JSONB NOT NULL)`);
      if (collection === "users" && record.password && !String(record.password).startsWith("$2")) {
        record.password = await bcrypt.hash(String(record.password), 10);
      }
      await conn.pool.query(
        `INSERT INTO ${collection} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
        [record.id, JSON.stringify(record)]
      );
      return record;
    }
  },

  // Update one record by ID
  async updateOne(workspace, collection, id, patch) {
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      delete patch._id;
      if (collection === "users" && patch.password && !String(patch.password).startsWith("$2")) {
        patch.password = await bcrypt.hash(String(patch.password), 10);
      }
      await conn.db.collection(collection).updateOne({ id }, { $set: patch });
      const updated = await conn.db.collection(collection).findOne({ id });
      if (!updated) return null;
      const { _id, ...rest } = updated;
      return rest;
    } else {
      await conn.pool.query(`CREATE TABLE IF NOT EXISTS ${collection} (id VARCHAR(100) PRIMARY KEY, data JSONB NOT NULL)`);
      const currentRes = await conn.pool.query(`SELECT data FROM ${collection} WHERE id = $1`, [id]);
      if (!currentRes.rows.length) return null;
      
      const current = currentRes.rows[0].data;
      if (collection === "users" && patch.password && !String(patch.password).startsWith("$2")) {
        patch.password = await bcrypt.hash(String(patch.password), 10);
      }
      
      const merged = Object.assign({}, current, patch);
      await conn.pool.query(
        `UPDATE ${collection} SET data = $2 WHERE id = $1`,
        [id, JSON.stringify(merged)]
      );
      return merged;
    }
  },

  // Delete one record by ID
  async deleteOne(workspace, collection, id) {
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      const res = await conn.db.collection(collection).deleteOne({ id });
      return res.deletedCount > 0;
    } else {
      await conn.pool.query(`CREATE TABLE IF NOT EXISTS ${collection} (id VARCHAR(100) PRIMARY KEY, data JSONB NOT NULL)`);
      const res = await conn.pool.query(`DELETE FROM ${collection} WHERE id = $1`, [id]);
      return true;
    }
  }
};

module.exports = {
  testConnection,
  seedWorkspaceDatabase,
  dbAdapter
};
