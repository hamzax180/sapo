/* =================================================================
   Souqi Database Adapter
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

// Fields that should never be exposed via the public portal API (legacy
// blacklist — kept as a fallback for collections without an allowlist).
const PRIVATE_FIELDS = ["password", "cost", "costPrice", "margin", "dbUri", "dbType", "email", "phone", "address", "taxId"];

// ALLOWLIST of fields the public portal may see, per collection. Anything
// not listed here is dropped, so a newly-added sensitive field is private by
// default (fail closed) instead of leaking until someone remembers to add it
// to a blacklist. Only the collections the portal actually exposes are here.
const PORTAL_PUBLIC_FIELDS = {
  products: [
    "id", "ref", "sku", "name", "title", "description", "desc", "longDescription",
    "price", "salePrice", "unitPrice", "oldPrice", "currency",
    "category", "type", "unit", "stock", "inStock",
    "image", "images", "img", "photo", "thumbnail", "gallery",
    "rating", "tags", "brand", "options", "variants", "badge", "sale", "discount",
    "publishedToPortal"
  ],
  shipments: [
    "id", "ref", "status", "origin", "destination", "from", "to",
    "eta", "carrier", "service", "mode", "trackingNumber",
    "history", "updates", "timeline", "date", "createdAt", "updatedAt"
  ],
  orders: [
    "id", "ref", "status", "type", "source", "date", "createdAt",
    "total", "currency", "items"
  ]
};

// Max rows a single findAll may return — a guard rail against unbounded
// scans. Use findPage() for cursor pagination when a collection can exceed it.
const MAX_SCAN = 10000;

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
    // Parse DB name from the workspace's OWN connection string, or fall back
    // to a per-tenant database name. Never use the platform DB_NAME here —
    // that env names the master registry DB, and reusing it would collapse
    // every tenant into one shared database (breaking isolation).
    let dbName = dbUri.split("/").pop().split("?")[0];
    if (!dbName || dbName.includes(":") || dbName === "localhost" || dbName.startsWith("mongodb")) {
      dbName = workspaceId === "default" && process.env.DB_NAME ? process.env.DB_NAME : `webo_${workspaceId}`;
    }
    const db = client.db(dbName);
    const connObj = { type: "mongodb", db, client };
    connectionCache[cacheKey] = connObj;
    return connObj;
  } else if (dbType === "postgres" || dbType === "neon") {
    console.log(`[DB] Connecting to PostgreSQL/Neon for workspace: ${workspaceId}`);
    const pool = new Pool({
      connectionString: dbUri,
      // One pool per workspace is cached above, and every deployed app gets
      // its own database — so this ceiling is PER TENANT and the instance
      // total is (tenants x max). pg's default of 10 puts ten tenants at 100
      // connections, which is exactly Postgres's own default max_connections:
      // the eleventh tenant, or a spike across the existing ten, starts
      // getting "too many connections". That failure is not contained to the
      // tenant causing it — the platform registry DB shares the instance, so
      // one app's traffic would take the dashboard down with it. 5 keeps ten
      // tenants at half the limit, and each backend costs the box 5-10 MB of
      // RAM besides. Put PgBouncer in transaction mode in front before this
      // needs raising; multiplexing is the fix past a dozen tenants, not a
      // bigger number here.
      max: 5,
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
    // eslint-disable-next-line no-new-func
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
 * Looks up a workspace record by its customDomain field.
 * Scans the "workspaces" collection on the MASTER MongoDB connection.
 * Used by the custom-domain middleware in index.js.
 */
async function findWorkspaceByDomain(masterDb, domain) {
  if (!masterDb || !domain) return null;
  const normalized = String(domain).toLowerCase().trim();
  const ws = await masterDb.collection("workspaces").findOne({ customDomain: normalized });
  if (!ws) return null;
  const { _id, ...rest } = ws;
  return rest;
}

/**
 * Unified CRUD Methods
 */
const dbAdapter = {
  // Read all records (capped at MAX_SCAN to avoid unbounded memory use)
  async findAll(workspace, collection) {
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      const docs = await conn.db.collection(collection).find({}).limit(MAX_SCAN).toArray();
      // Remove mongo _id field
      return docs.map(d => {
        const { _id, ...rest } = d;
        return rest;
      });
    } else {
      // Postgres: ensure table exists (dynamic creation if missed)
      await conn.pool.query(`CREATE TABLE IF NOT EXISTS ${collection} (id VARCHAR(100) PRIMARY KEY, data JSONB NOT NULL)`);
      const res = await conn.pool.query(`SELECT data FROM ${collection} LIMIT ${MAX_SCAN}`);
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

  // Read records for public portal use, projected to an allowlist of safe
  // fields (fail closed) rather than a blacklist (fail open).
  async findAllPublic(workspace, collection) {
    const docs = await this.findAll(workspace, collection);
    // For products: only return those explicitly published to the portal.
    // If none are published yet (e.g. demo data), return all (graceful fallback).
    let rows = docs;
    if (collection === "products") {
      const published = docs.filter((d) => d.publishedToPortal === true);
      rows = published.length > 0 ? published : docs;
    }

    const allow = PORTAL_PUBLIC_FIELDS[collection];
    if (allow) {
      const allowSet = new Set(allow);
      return rows.map((doc) => {
        const safe = {};
        for (const k of Object.keys(doc)) if (allowSet.has(k)) safe[k] = doc[k];
        // Never expose customer PII / payment carried on order line data.
        if (collection === "orders" && Array.isArray(safe.items)) {
          safe.items = safe.items.map((it) => ({ name: it.name, qty: it.qty, price: it.price }));
        }
        return safe;
      });
    }

    // Collections without an explicit allowlist fall back to the blacklist.
    return rows.map((doc) => {
      const safe = Object.assign({}, doc);
      PRIVATE_FIELDS.forEach((f) => delete safe[f]);
      return safe;
    });
  },

  // Cursor pagination (opt-in) — ULID ids sort chronologically, so the last
  // id on a page is the cursor for the next. Returns { items, nextCursor }.
  async findPage(workspace, collection, { limit = 100, cursor = null } = {}) {
    const lim = Math.min(Math.max(1, Number(limit) || 100), 1000);
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      const q = cursor ? { id: { $gt: String(cursor) } } : {};
      const docs = await conn.db.collection(collection).find(q).sort({ id: 1 }).limit(lim + 1).toArray();
      const page = docs.slice(0, lim).map((d) => { const { _id, ...rest } = d; return rest; });
      return { items: page, nextCursor: docs.length > lim ? page[page.length - 1].id : null };
    } else {
      await conn.pool.query(`CREATE TABLE IF NOT EXISTS ${collection} (id VARCHAR(100) PRIMARY KEY, data JSONB NOT NULL)`);
      const res = cursor
        ? await conn.pool.query(`SELECT data FROM ${collection} WHERE id > $1 ORDER BY id ASC LIMIT $2`, [String(cursor), lim + 1])
        : await conn.pool.query(`SELECT data FROM ${collection} ORDER BY id ASC LIMIT $1`, [lim + 1]);
      const rows = res.rows.map((r) => r.data);
      const page = rows.slice(0, lim);
      return { items: page, nextCursor: rows.length > lim ? page[page.length - 1].id : null };
    }
  },


  // Erase an entire workspace's data (GDPR / right-to-erasure). Drops the
  // tenant database (Mongo) or all known tables (Postgres), then evicts the
  // cached connection so a later re-provision reconnects fresh.
  async purgeWorkspace(workspace) {
    const conn = await getDbClient(workspace);
    if (conn.type === "mongodb") {
      await conn.db.dropDatabase();
    } else {
      for (const c of COLLECTIONS) {
        await conn.pool.query(`DROP TABLE IF EXISTS ${c}`);
      }
    }
    const cacheKey = `${workspace.workspaceId}_${workspace.dbType}`;
    try {
      if (conn.client) await conn.client.close();
      else if (conn.pool) await conn.pool.end();
    } catch (e) { /* ignore */ }
    delete connectionCache[cacheKey];
    return true;
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
  findWorkspaceByDomain,
  dbAdapter
};
