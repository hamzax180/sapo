/* =================================================================
   leak-test.js — no response carries something it should not
   -----------------------------------------------------------------
   Reading every route to see what it returns is how three of them got
   away with returning another account's project. So this asks the
   server instead: sign in as a real user, GET everything that is safe
   to GET, and look at what actually comes back.

   Two questions, on every response:

     1. Does it contain a SECRET? A bcrypt hash, a provider API key, a
        JWT, a database URI, a Stripe key. The server holds all of
        these and has no reason to hand any of them to a browser.

     2. Does it contain someone ELSE? Every account in the database is
        known here, so an address that is not the signed-in user's is
        a cross-account leak by definition — the check that would have
        caught the security-scan routes.

   GET only, and only routes with no side effects. This runs against a
   real server and a real database: it must be able to run twice.
   ================================================================= */
"use strict";

const BASE = process.env.BASE || "http://localhost:4000";

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const pass = (m) => console.log("  ✓ " + m);

/* What a secret looks like on the wire. Deliberately shaped rather than
   name-based: a field called `token` is fine if it holds nothing, and a
   field called `data` is not if it holds a bcrypt hash. */
const SECRETS = [
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, "a bcrypt password hash"],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, "a JWT"],
  [/\bsk_(live|test)_[A-Za-z0-9]{16,}/, "a Stripe secret key"],
  [/\bsk-[A-Za-z0-9]{20,}/, "an OpenAI-style API key"],
  [/\bAIza[A-Za-z0-9_-]{30,}/, "a Google API key"],
  [/mongodb(\+srv)?:\/\/[^"\s]*:[^"@\s]+@/, "a MongoDB URI with credentials"],
  [/postgres(ql)?:\/\/[^"\s]*:[^"@\s]+@/, "a Postgres URI with credentials"],
  [/\bghp_[A-Za-z0-9]{20,}/, "a GitHub token"]
];

async function main() {
  let MongoClient, jwt;
  try {
    ({ MongoClient } = require("mongodb"));
    jwt = require("jsonwebtoken");
    require("dotenv").config();
  } catch (e) {
    console.log("• leak-test SKIPPED (" + e.message + ")");
    return;
  }
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
    console.log("• leak-test SKIPPED (needs MONGODB_URI and JWT_SECRET)");
    return;
  }

  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const master = c.db(process.env.DB_NAME);

  /* Sign in as whoever owns the most projects — the account with the most
     surface for a route to get wrong. */
  const wss = await master.collection("workspaces").find({}).toArray();
  let me = null, myWs = null;
  for (const w of wss) {
    const u = await c.db("webo_" + w.id).collection("users").findOne({ email: w.ownerEmail });
    if (!u) continue;
    const n = await master.collection("projects").countDocuments({ ownerUserId: u.id });
    if (!me || n > me.__n) { me = Object.assign({ __n: n }, u); myWs = w.id; }
  }
  if (!me) { console.log("• leak-test SKIPPED (no account to sign in as)"); await c.close(); return; }

  const everyEmail = wss.map((w) => String(w.ownerEmail || "").toLowerCase()).filter(Boolean);
  const otherEmails = everyEmail.filter((e) => e !== String(me.email).toLowerCase());

  const token = jwt.sign({
    id: me.id, name: me.name, email: me.email, role: me.role,
    dept: me.dept, wsId: me.wsId || myWs, sessionEpoch: me.sessionEpoch
  }, process.env.JWT_SECRET, { expiresIn: "10m" });
  const cookie = "sq_session=" + token;

  const mine = await master.collection("projects")
    .find({ ownerUserId: me.id }, { projection: { id: 1, slug: 1 } }).limit(1).toArray();
  const key = mine.length ? mine[0].id : null;

  /* The row as it exists at rest, so the sweep can tell "this endpoint
     does not return a hash" from "there was no hash to return". A test
     that passes because the fixture is empty is the same as no test.
     Reuses the detector above rather than restating the pattern: two
     copies of a regex is two chances to write one that matches nothing,
     which is what happened on the first attempt at this line. */
  const rowHasHash = SECRETS[0][0].test(String(me.password || ""));
  await c.close();

  console.log("\n── leak sweep: signed in as " + me.email + " (" + me.__n + " projects) ─────");
  console.log("   watching for " + otherEmails.length + " other account address(es)\n");

  console.log("   the signed-in user's row " + (rowHasHash ? "DOES" : "does not") +
    " carry a bcrypt hash at rest" + (rowHasHash ? " — so there is something to leak" : " (weak fixture)"));

  const paths = [
    "/api/account", "/api/account/ai-keys", "/api/account/usage", "/api/account/plan",
    "/api/projects", "/api/security/overview", "/api/codeagent/limits",
    "/api/billing/plans", "/api/deploy/quota", "/health",
    /* The generic CRUD over the tenant's own collections. users sits on the
       allowlist and its rows hold the bcrypt hash, which is how three
       endpoints came to serve every password hash in a workspace to anyone
       holding a session — a Staff account included. */
    "/users", "/users/" + me.id, "/clients", "/products", "/audit",
    /* And the data-subject export, the single most likely document here to
       be forwarded to somebody else. */
    "/api/ws/" + (me.wsId || myWs) + "/export"
  ];
  if (key) paths.push(
    "/api/projects/" + key, "/api/codeagent/" + key, "/api/projects/" + key + "/details",
    "/api/projects/" + key + "/thumb", "/api/security/scan/" + key + "/details",
    "/api/deploy/" + key + "/config", "/api/deploy/" + key + "/env",
    "/api/deploy/" + key + "/status", "/api/deploy/" + key + "/database"
  );

  const before = failures;
  let looked = 0;
  for (const p of paths) {
    let res, body;
    try {
      res = await fetch(BASE + p, { headers: { Cookie: cookie } });
      body = await res.text();
    } catch (e) { fail(p + " — request failed: " + e.message); continue; }

    if (res.status === 404 && /Cannot GET/.test(body)) continue;   // route not in this build
    looked++;

    for (const [re, what] of SECRETS) {
      if (re.test(body)) fail(p + " (" + res.status + ") returned " + what);
    }
    const lower = body.toLowerCase();
    for (const other of otherEmails) {
      if (lower.includes(other)) fail(p + " (" + res.status + ") returned another account's address: " + other);
    }
  }
  if (failures === before) pass(looked + " responses carried no secret and no other account's address");
  else console.log("  (" + looked + " responses swept)");

  /* And the same sweep with NO session at all: anything that answers 200
     to a stranger had better be answering with nothing personal. */
  const beforeAnon = failures;
  let anonLooked = 0;
  for (const p of paths) {
    let res, body;
    try { res = await fetch(BASE + p); body = await res.text(); } catch (e) { continue; }
    if (res.status === 404 && /Cannot GET/.test(body)) continue;
    anonLooked++;
    for (const [re, what] of SECRETS) {
      if (re.test(body)) fail("ANONYMOUS " + p + " (" + res.status + ") returned " + what);
    }
    const lower = body.toLowerCase();
    for (const addr of everyEmail) {
      if (lower.includes(addr)) fail("ANONYMOUS " + p + " (" + res.status + ") returned an account address: " + addr);
    }
  }
  if (failures === beforeAnon) pass(anonLooked + " of those answered a stranger without leaking an address or a secret");
  else console.log("  (" + anonLooked + " of those swept as a stranger)");
}

main()
  .then(() => {
    if (failures) { console.log("\n✗ " + failures + " LEAK CHECK(S) FAILED\n"); process.exit(1); }
    console.log("\n✓ NO LEAKS FOUND\n");
  })
  .catch((e) => { console.error("harness failed: " + (e && e.stack || e)); process.exit(1); });
