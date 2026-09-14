/* =================================================================
   delete-test.js — "delete my account" has to mean it
   -----------------------------------------------------------------
   The route authenticated with a verified session and then listed what
   to delete with anon.ownerOf, which reads the user only from an
   Authorization header. No page in this app sends one. So the list was
   scoped to an anon cookie alone: a project built on another device was
   never matched, and for anyone with no sq_anon cookie at all — a fresh
   browser, or one whose 30-day anon grant had lapsed — the filter
   matched nothing and not one project was removed.

   It also deleted the user row and the workspace record while leaving
   the account's OWN DATABASE in place: clients, orders, invoices, audit,
   all of it, with nothing pointing at it any more. The other way out of
   this product, DELETE /api/ws/:id, has always purged that. Deletion
   that leaves the data is not deletion.

   Everything here runs against a live server with a real account, on a
   @souqi.test address, and cleans up whatever the route leaves behind.
   ================================================================= */
"use strict";

const BASE = process.env.BASE || "http://localhost:4000";
const PASSWORD = "correct-horse-battery-8";

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const pass = (m) => console.log("  ✓ " + m);

(async () => {
  let MongoClient;
  try { ({ MongoClient } = require("mongodb")); require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") }); }
  catch (e) { console.log("• delete-test SKIPPED (" + e.message + ")"); return; }
  if (!process.env.MONGODB_URI) { console.log("• delete-test SKIPPED (no MONGODB_URI)"); return; }

  const email = "del-" + Date.now() + "@souqi.test";
  const up = await fetch(BASE + "/auth/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Delete Probe", email: email, password: PASSWORD })
  });
  if (up.status !== 200 && up.status !== 201) {
    console.log("• delete-test SKIPPED (signup returned " + up.status + ")"); return;
  }
  const sc = (typeof up.headers.getSetCookie === "function" ? up.headers.getSetCookie() : []);
  const cookie = sc.map((l) => (/^sq_session=[^;]*/.exec(l) || [])[0]).find(Boolean);
  const user = (await up.json().catch(() => ({}))).user || {};
  if (!cookie || !user.id) { fail("signup issued no usable session"); return; }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME);

  const ws = await db.collection("workspaces").findOne({ ownerEmail: email });
  const tenantName = ws ? "webo_" + ws.id : null;

  console.log("\n── deleting an account ────────────────────────────────");
  console.log("   " + email + "  ws " + (ws && ws.id));

  /* Three projects. Only the middle one carries the anon id this request
     will send; the others are the same person on other devices, which is
     the case the old resolver could not see. */
  const ids = ["pr_delA" + Math.random().toString(36).slice(2, 7),
               "pr_delB" + Math.random().toString(36).slice(2, 7),
               "pr_delC" + Math.random().toString(36).slice(2, 7)];
  await db.collection("projects").insertMany(ids.map((id, i) => ({
    id: id, slug: "del-" + i, title: "Project " + i,
    ownerUserId: user.id, ownerAnonId: "an_device_" + i,
    createdAt: new Date().toISOString()
  })));

  /* Something in the tenant database, so "was it purged" has an answer. */
  if (tenantName) {
    await client.db(tenantName).collection("clients").insertOne({ id: "cli_probe", name: "A client record" });
  }

  const del = await fetch(BASE + "/api/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password: PASSWORD })
  });
  if (del.status !== 200) {
    fail("DELETE /api/account returned " + del.status + ": " + (await del.text()).slice(0, 90));
  } else {
    pass("the account accepted its own deletion");
  }

  const left = await db.collection("projects")
    .find({ id: { $in: ids } }, { projection: { _id: 0, id: 1, title: 1 } }).toArray();
  if (left.length) {
    fail(left.length + " of " + ids.length + " projects outlived the account: " +
      left.map((p) => p.title).join(", ") + " — a project built on another device was never matched");
  } else {
    pass("every project went with it, whichever device built it");
  }

  const wsLeft = await db.collection("workspaces").countDocuments({ ownerEmail: email });
  if (wsLeft) fail("the workspace record is still there"); else pass("the workspace record is gone");

  if (tenantName) {
    const names = (await client.db().admin().listDatabases()).databases.map((d) => d.name);
    const stillThere = names.includes(tenantName);
    let rows = 0;
    if (stillThere) rows = await client.db(tenantName).collection("clients").countDocuments().catch(() => 0);
    if (rows > 0) {
      fail("the account's own database survived with " + rows + " row(s) in it — the records are still on disk with nothing pointing at them");
    } else {
      pass("the account's own database was purged");
    }
  }

  /* The audit of a deletion has to outlive the deletion. */
  const audit = await db.collection("platform_audit")
    .findOne({ action: "account.delete", entityId: user.id }).catch(() => null);
  if (audit) pass("a platform audit row records the deletion, outside the database it erased");
  else fail("nothing recorded the deletion");

  /* Cleanup, in case the route left anything. */
  await db.collection("projects").deleteMany({ id: { $in: ids } });
  const stray = await db.collection("workspaces").find({ ownerEmail: email }).toArray();
  for (const w of stray) { try { await client.db("webo_" + w.id).dropDatabase(); } catch (e) {} }
  await db.collection("workspaces").deleteMany({ ownerEmail: email });
  if (tenantName) { try { await client.db(tenantName).dropDatabase(); } catch (e) {} }
  await client.close();

  if (failures) { console.log("\n✗ " + failures + " DELETE CHECK(S) FAILED\n"); process.exit(1); }
  console.log("\n✓ ALL DELETE TESTS PASSED\n");
})().catch((e) => { console.error("harness failed: " + (e && e.stack || e)); process.exit(1); });
