/* =================================================================
   MERVEKS SAP — seed MongoDB from the front-end demo data
   Reuses ../js/seed.js (the single source of truth) so the live DB
   starts with the exact same realistic, fully-linked records as the
   demo. User passwords are hashed on the way in.

   Run:  node seed.js          (only seeds if the DB is empty)
         node seed.js --force  (wipes and re-seeds every collection)
   ================================================================= */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { connect, close } = require("./db");

// Load window.SEED_DATA() from the browser seed file without a browser.
function loadSeedData() {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "js", "seed.js"), "utf8");
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function("window", code)(sandbox.window);
  if (typeof sandbox.window.SEED_DATA !== "function") {
    throw new Error("Could not load SEED_DATA from ../public/js/seed.js");
  }
  return sandbox.window.SEED_DATA();
}

// "sap_users" -> "users"
const collName = (k) => k.replace(/^sap_/, "");

async function main() {
  const force = process.argv.includes("--force");
  const db = await connect();
  const data = loadSeedData();

  for (const seedKey of Object.keys(data)) {
    const name = collName(seedKey);
    const col = db.collection(name);
    const count = await col.countDocuments();

    if (count > 0 && !force) {
      console.log(`• ${name}: ${count} docs already present — skipped (use --force to reset)`);
      continue;
    }
    if (force) await col.deleteMany({});

    let records = data[seedKey].map((r) => Object.assign({}, r));

    // hash plaintext passwords for the users collection
    if (name === "users") {
      records = await Promise.all(records.map(async (u) => {
        if (u.password && !String(u.password).startsWith("$2")) {
          u.password = await bcrypt.hash(String(u.password), 10);
        }
        return u;
      }));
    }

    if (records.length) await col.insertMany(records);
    // a unique index on the business id keeps records addressable & dedup-safe
    await col.createIndex({ id: 1 }, { unique: true }).catch(() => {});
    console.log(`✓ ${name}: seeded ${records.length} docs`);
  }

  console.log("\nDone. Login credentials are the same as the demo (passwords now hashed in DB):");
  console.log("  owner@merveks.com / merveks2013   (Owner)");
  console.log("  operations@merveks.com / ops123   (Operations Manager)");
  await close();
}

main().catch((e) => { console.error("Seed failed:", e); process.exit(1); });
