/* =================================================================
   MERVEKS SAP — seed MongoDB from the front-end demo data
   Reuses ./seed-data.js (the single source of truth) so the live DB
   starts with the exact same realistic, fully-linked records as the
   demo. User passwords are hashed on the way in.

   Run:  node seed.js          (only seeds if the DB is empty)
         node seed.js --force  (wipes and re-seeds every collection)
   ================================================================= */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { connect, close } = require("./db");
/* Was public/js/seed.js, read as SOURCE and run through `new Function` to
   recover a window global — an indirection that existed only because the old
   demo console loaded the same file in a browser. Nothing does now, so it is
   a plain module here, and the eval (and its eslint-disable) went with it. */
const loadSeedData = require("./seed-data");

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
