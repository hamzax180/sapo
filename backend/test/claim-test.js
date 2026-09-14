/* =================================================================
   claim-test.js — "your app is saved and comes with you"
   -----------------------------------------------------------------
   That sentence is on the wall a visitor hits after their one free
   build, and it is the whole conversion pitch: build something, then
   sign up to keep it. It is also a promise about claimAnon — on
   signup, every project owned by this browser's anon id has to become
   the new account's.

   If that ever stops working, the product asks people to sign up for
   the one thing that then disappears, and nothing else in the suite
   would notice: the signup still returns 200, the session still works,
   and the project is simply no longer anybody's.

   Seeded rather than built, because a headless client cannot finish a
   build — the browser compiles in a WebContainer and posts the result
   back. What is under test is the ownership move, not the model.

   Runs against a live server on a @souqi.test account it deletes.
   ================================================================= */
"use strict";

const BASE = process.env.BASE || "http://localhost:4000";
const PASSWORD = "correct-horse-battery-8";

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const pass = (m) => console.log("  ✓ " + m);
const cookieFrom = (res, name) => {
  const sc = (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []);
  return sc.map((l) => (new RegExp("^" + name + "=[^;]*").exec(l) || [])[0]).find(Boolean) || null;
};

(async () => {
  let MongoClient, jwt;
  try { ({ MongoClient } = require("mongodb")); jwt = require("jsonwebtoken"); require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") }); }
  catch (e) { console.log("• claim-test SKIPPED (" + e.message + ")"); return; }
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
    console.log("• claim-test SKIPPED (needs MONGODB_URI and JWT_SECRET)"); return;
  }

  console.log("\n── the conversion moment ──────────────────────────────");

  /* A real anonymous visitor, with a real anon grant. */
  const first = await fetch(BASE + "/api/projects");
  const anonCookie = cookieFrom(first, "sq_anon");
  if (!anonCookie) { fail("no sq_anon cookie was issued to a first-time visitor"); return; }

  let anonId;
  try {
    const raw = decodeURIComponent(anonCookie.split("=").slice(1).join("="));
    anonId = jwt.verify(raw, process.env.JWT_SECRET).anonId;
  } catch (e) {
    console.log("• claim-test SKIPPED — this JWT_SECRET does not verify " + BASE + "'s anon grant");
    return;
  }
  pass("a first-time visitor is given an anon identity");

  const email = "claim-" + Date.now() + "@souqi.test";
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME);
  const pid = "pr_claim" + Math.random().toString(36).slice(2, 8);
  const made = [pid];
  let userId = null;

  try {
    await db.collection("projects").insertOne({
      id: pid, slug: "claim-probe-" + Date.now().toString(36), title: "Built before signing up",
      ownerAnonId: anonId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });

    /* Sign up carrying the same cookie, which is what a browser does,
       because it is the same browser. */
    const up = await fetch(BASE + "/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: anonCookie },
      body: JSON.stringify({ name: "Claim Probe", email: email, password: PASSWORD })
    });
    if (up.status !== 200 && up.status !== 201) {
      fail("signup returned " + up.status + ": " + (await up.text()).slice(0, 90));
      return;
    }
    const body = await up.json().catch(() => ({}));
    userId = (body.user || {}).id;
    const session = cookieFrom(up, "sq_session");
    pass("they sign up");

    const after = await db.collection("projects").findOne({ id: pid },
      { projection: { _id: 0, ownerUserId: 1, ownerAnonId: 1 } });
    if (after && after.ownerUserId === userId) {
      pass("the app they built before signing up is now theirs");
    } else {
      fail("the project did not move to the new account (owner is " + JSON.stringify(after) +
        ") — the wall promises it comes with them, and it did not");
    }

    if (!session) { fail("signup issued no session cookie"); return; }

    const open = await fetch(BASE + "/api/codeagent/" + pid, { headers: { Cookie: session } });
    if (open.status === 200) pass("they can open it with their new session");
    else fail("opening the carried-over project returned " + open.status);

    const list = await (await fetch(BASE + "/api/projects", { headers: { Cookie: session } })).json().catch(() => ({}));
    if ((list.projects || []).some((p) => p.id === pid)) pass("it appears in their project list");
    else fail("it is not in their project list, so they cannot find it again");

    /* ---- and the OTHER way round ----

       Someone who already has an account does the same thing: lands
       anonymously, builds, and then signs IN rather than up. claimAnon is
       called on that path too, and it has to be — otherwise the returning
       customer is the one who loses the app, which is worse than the new
       one losing it. A second browser, a second anon identity, a second
       project, the same account. */
    const second = await fetch(BASE + "/api/projects");
    const anon2 = cookieFrom(second, "sq_anon");
    if (!anon2) { fail("a second visitor got no anon identity"); return; }
    let anonId2;
    try {
      const raw2 = decodeURIComponent(anon2.split("=").slice(1).join("="));
      anonId2 = jwt.verify(raw2, process.env.JWT_SECRET).anonId;
    } catch (e) { fail("could not read the second anon grant"); return; }

    const pid2 = "pr_claim2" + Math.random().toString(36).slice(2, 8);
    await db.collection("projects").insertOne({
      id: pid2, slug: "claim-probe2-" + Date.now().toString(36), title: "Built before signing in",
      ownerAnonId: anonId2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    made.push(pid2);

    const inRes = await fetch(BASE + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: anon2 },
      body: JSON.stringify({ email: email, password: PASSWORD })
    });
    if (inRes.status !== 200) {
      fail("signing in returned " + inRes.status);
    } else {
      const moved2 = await db.collection("projects").findOne({ id: pid2 }, { projection: { _id: 0, ownerUserId: 1 } });
      if (moved2 && moved2.ownerUserId === userId) {
        pass("a returning customer's anonymous build comes with them too");
      } else {
        fail("the project built before signing IN did not move (owner is " + JSON.stringify(moved2) + ")");
      }
    }
  } finally {
    await db.collection("projects").deleteMany({ id: { $in: made } });
    const ws = await db.collection("workspaces").find({ ownerEmail: email }).toArray();
    for (const w of ws) { try { await client.db("webo_" + w.id).dropDatabase(); } catch (e) {} }
    await db.collection("workspaces").deleteMany({ ownerEmail: email });
    if (userId) await db.collection("codeagent_usage").deleteMany({ owner: "u:" + userId });
    await client.close();
  }

  if (failures) { console.log("\n✗ " + failures + " CLAIM CHECK(S) FAILED\n"); process.exit(1); }
  console.log("\n✓ ALL CLAIM TESTS PASSED\n");
})().catch((e) => { console.error("harness failed: " + (e && e.stack || e)); process.exit(1); });
