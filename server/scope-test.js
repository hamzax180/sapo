/* =================================================================
   scope-test.js — a narrow grant never widens
   -----------------------------------------------------------------
   This server signs three kinds of token with ONE secret:

     · a session      { id, email, role, wsId, sessionEpoch }
     · an anon grant  { anonId, scope:"anon" }              30 days
     · an edit grant  { wsId, email, scope:"portal-edit" }  15 minutes

   Sharing a secret is fine. Treating them as interchangeable was not,
   and two separate gates did:

   requireSession verified the signature and nothing else, so an edit
   grant became req.session. It carries the workspace owner's EMAIL, and
   requireAdmin compares an email to ADMIN_EMAILS — so wherever an admin
   also owns a workspace, a fifteen-minute grant for moving a heading
   around opened the platform admin API: every account, plan and figure
   on it.

   assertOwnsWorkspace tested ownership the same way — by email — and so
   the same grant satisfied GET /api/ws/:id/export (all thirteen
   collections), POST /api/ws/:id/domain, and DELETE /api/ws/:id.

   Both were confirmed against a running server before they were fixed.
   This file is what stops them coming back: it mints the real grants
   and asks for the things they must never open.
   ================================================================= */
"use strict";

const BASE = process.env.BASE || "http://localhost:4000";
let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const pass = (m) => console.log("  ✓ " + m);

(async () => {
  let jwt, MongoClient;
  try { jwt = require("jsonwebtoken"); ({ MongoClient } = require("mongodb")); require("dotenv").config(); }
  catch (e) { console.log("• scope-test SKIPPED (" + e.message + ")"); return; }
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
    console.log("• scope-test SKIPPED (needs MONGODB_URI and JWT_SECRET)"); return;
  }

  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const master = c.db(process.env.DB_NAME);

  /* The sharpest case is a workspace owner who is ALSO a platform admin,
     because that is where the edit grant's email did the damage. Fall back
     to any owner if this deployment has no overlap. */
  const admins = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const all = await master.collection("workspaces").find({}).toArray();
  const ws = all.find((w) => admins.includes(String(w.ownerEmail || "").toLowerCase())) || all[0];
  if (!ws) { console.log("• scope-test SKIPPED (no workspace to mint against)"); await c.close(); return; }
  const owner = await c.db("webo_" + ws.id).collection("users").findOne({ email: ws.ownerEmail });
  await c.close();
  if (!owner) { console.log("• scope-test SKIPPED (owner row missing)"); return; }

  const isAdmin = admins.includes(String(ws.ownerEmail || "").toLowerCase());
  console.log("\n── scope ──────────────────────────────────────────────");
  console.log("   minting against " + ws.ownerEmail + (isAdmin ? " (a platform admin — the sharp case)" : " (not an admin on this deployment)"));

  const S = process.env.JWT_SECRET;
  const edit    = jwt.sign({ wsId: ws.id, email: ws.ownerEmail, scope: "portal-edit" }, S, { expiresIn: "15m" });
  const anon    = jwt.sign({ anonId: "an_scope_probe", scope: "anon" }, S, { expiresIn: "30d" });
  const session = jwt.sign({
    id: owner.id, name: owner.name, email: owner.email, role: owner.role,
    dept: owner.dept, wsId: owner.wsId || ws.id, sessionEpoch: owner.sessionEpoch
  }, S, { expiresIn: "5m" });

  const get = (path, tok, asCookie) => fetch(BASE + path, {
    headers: asCookie ? { Cookie: "sq_session=" + tok } : { Authorization: "Bearer " + tok }
  });

  /* Everything a session may have and a grant may not. */
  const GUARDED = [
    "/api/admin/overview",
    "/api/admin/accounts",
    "/api/admin/apps",
    "/clients",
    "/users",
    "/api/ws/" + ws.id + "/export"
  ];

  for (const [label, tok] of [["a portal-edit grant", edit], ["an anon grant", anon]]) {
    const opened = [];
    for (const p of GUARDED) {
      const r = await get(p, tok);
      if (r.status < 300) opened.push(p + " (" + r.status + ")");
    }
    if (opened.length) fail(label + " opened: " + opened.join(", "));
    else pass(label + " is refused by all " + GUARDED.length + " guarded routes");
  }

  /* And the other direction, which matters just as much: the fix must not
     have locked out the people it is protecting. Both transports. */
  const brokenHeader = [], brokenCookie = [];
  for (const p of GUARDED) {
    if ((await get(p, session)).status >= 300) brokenHeader.push(p);
    if ((await get(p, session, true)).status >= 300) brokenCookie.push(p);
  }
  if (brokenHeader.length) fail("a real session was refused (Bearer): " + brokenHeader.join(", "));
  else pass("a real session still opens all " + GUARDED.length + ", as a Bearer header");
  if (brokenCookie.length) fail("a real session was refused (cookie): " + brokenCookie.join(", "));
  else pass("a real session still opens all " + GUARDED.length + ", as the sq_session cookie");

  /* A token signed with the wrong secret must fail regardless of claims. */
  const forged = jwt.sign({ id: owner.id, email: owner.email, role: "Owner", wsId: ws.id }, "not-the-secret");
  const f = await get("/api/admin/overview", forged);
  if (f.status === 401) pass("a token signed with another secret is refused");
  else fail("a forged token got " + f.status + " instead of 401");

  if (failures) { console.log("\n✗ " + failures + " SCOPE CHECK(S) FAILED\n"); process.exit(1); }
  console.log("\n✓ ALL SCOPE TESTS PASSED\n");
})().catch((e) => { console.error("harness failed: " + (e && e.stack || e)); process.exit(1); });
