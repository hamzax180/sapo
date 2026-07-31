/* =================================================================
   Souqi — LOCAL admin-panel verification server
   -----------------------------------------------------------------
   Boots the REAL API against an in-memory MongoDB seeded with realistic
   accounts (varied plans), per-tenant orders and visit rows, then
   listens on :4010 so the admin panel can be exercised with LIVE data.

   Not used in production — it's a dev harness. Admin login:
      email:  admin@souqi.test
      pass:   admin123
   ================================================================= */
"use strict";
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");

  // Reuse the already-downloaded binary (this harness may be launched from the
  // repo root, where the package's local cache isn't auto-discovered).
  let systemBinary = "";
  try {
    const cacheDir = path.join(__dirname, "node_modules", ".cache", "mongodb-memory-server");
    const exe = fs.readdirSync(cacheDir).find((f) => /^mongod.*\.exe$/i.test(f) || /^mongod-/.test(f));
    if (exe) systemBinary = path.join(cacheDir, exe);
  } catch (e) { /* fall back to auto-download */ }

  const mongod = await MongoMemoryServer.create(systemBinary ? { binary: { systemBinary } } : {});
  const uri = mongod.getUri();

  process.env.MONGODB_URI = uri;
  process.env.DB_NAME = "souqi_master";
  process.env.JWT_SECRET = "dev-admin-verify-secret";
  process.env.ADMIN_EMAILS = "admin@souqi.test";
  process.env.PORT = "4010";
  process.env.GEMINI_API_KEY = "";
  process.env.LOG_REQUESTS = "0";

  const c = new MongoClient(uri);
  await c.connect();
  const master = c.db("souqi_master");

  const PLANS = ["free", "pro", "business", "max", "team", "enterprise"];
  const INDUSTRIES = ["retail", "fashion", "restaurant", "logistics", "services", "wholesale", "construction", "manufacturing"];
  const COUNTRIES = ["TR", "AE", "SA", "DE", "GB", "US", "EG", "FR", "RU", "NL"];
  const NAMES = ["Mersin Textiles", "NovaWear", "Bosphorus Bites", "CargoLink", "Atlas Services", "Gulf Wholesale",
    "BuildRight", "MetalWorks", "Kahve House", "Zenith Retail", "Souq Al Noor", "Pixel Prints", "Anatolia Foods", "UrbanFit"];

  // Deterministic PRNG so numbers are stable across runs.
  let seed = 12345;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

  // Admin workspace + owner.
  await master.collection("workspaces").insertOne({
    id: "ws_admin", company: "Souqi HQ", ownerEmail: "admin@souqi.test", plan: "enterprise",
    industry: "services", country: "TR", dbType: "local", dbUri: "", createdAt: daysAgo(90)
  });
  await c.db("webo_ws_admin").collection("users").insertOne({
    id: "usr_admin", name: "Platform Admin", email: "admin@souqi.test",
    password: bcrypt.hashSync("admin123", 10), role: "Owner", active: true
  });

  // Tenant workspaces with plans, spread over the last 30 days, each with orders.
  const planSpread = ["free", "free", "free", "pro", "pro", "business", "max", "free", "team", "pro", "enterprise", "free", "business", "max"];
  for (let i = 0; i < NAMES.length; i++) {
    const id = "ws_store" + i;
    const plan = planSpread[i % planSpread.length];
    await master.collection("workspaces").insertOne({
      id, company: NAMES[i], ownerEmail: NAMES[i].toLowerCase().replace(/[^a-z]/g, "") + "@example.com",
      plan, industry: INDUSTRIES[i % INDUSTRIES.length], country: pick(COUNTRIES),
      dbType: "local", dbUri: "", createdAt: daysAgo(Math.floor(rnd() * 30)),
      customDomain: i < 4 ? NAMES[i].toLowerCase().replace(/[^a-z]/g, "") + ".com" : null
    });
    const orderCount = Math.floor(rnd() * 60) + 3;
    const orders = [];
    for (let o = 0; o < orderCount; o++) {
      orders.push({ id: "ord_" + id + "_" + o, total: Math.round((rnd() * 400 + 20) * 100) / 100, status: "Pending", createdAt: daysAgo(Math.floor(rnd() * 20)) });
    }
    await c.db("webo_" + id).collection("orders").insertMany(orders);
  }

  // Visit rows across the last 14 days (marketing + portal), varied unique ids.
  const visits = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const count = Math.floor(rnd() * 220) + 120;
    for (let v = 0; v < count; v++) {
      visits.push({
        id: "vis_" + d + "_" + v, ts: new Date().toISOString(), createdAt: new Date(),
        day, path: rnd() > 0.5 ? "/" : "/portal/ws_store" + Math.floor(rnd() * NAMES.length),
        type: rnd() > 0.45 ? "marketing" : "portal",
        wsId: null, vid: "vid_" + day + "_" + Math.floor(rnd() * 130)
      });
    }
  }
  await master.collection("visits").insertMany(visits);
  await c.close();

  console.log("✓ Seeded verification data (admin@souqi.test / admin123). Starting API on :4010 …");
  require("./index.js"); // connects to the same in-memory cluster and listens

  const shutdown = async () => { try { await mongod.stop(); } catch (e) {} process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})().catch((e) => { console.error("verify server failed:", e); process.exit(1); });
