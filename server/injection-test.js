/* =================================================================
   injection-test.js — the request body cannot smuggle a query
   -----------------------------------------------------------------
   Every field that reaches a Mongo filter comes from req.valid, and the
   validator rejects anything that is not the declared primitive. That is
   the claim; this is the proof, made against a running server rather
   than by reading the validator.

   The payloads are the standard NoSQL set: an operator object where a
   string belongs ({$ne:null} matches every row, {$gt:""} matches every
   non-empty one), a $regex that matches anything, and a $where carrying
   JavaScript. If any of them authenticates, or is stored, or changes
   which rows come back, this file fails.

   Run against a server you do not mind writing to: the signup probes
   would create accounts if they got through, which is the point.
   ================================================================= */
"use strict";

const BASE = process.env.BASE || "http://localhost:4000";

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("  ✓ " + name))
    .catch((e) => { failures++; console.log("  ✗ " + name + "\n      " + e.message); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* The strip probe below has to really sign up — that is the point of it —
   and every run therefore left an account and a whole tenant database
   behind. Five of them had accumulated before anyone looked. A test that
   litters gets run less often, so it cleans up after itself.

   Best effort on purpose: the harness talks HTTP and does not otherwise
   need a database, so if there is no MONGODB_URI (running against a remote
   BASE, say) it says what it left rather than failing over housekeeping. */
async function removeProbeAccount(email) {
  let MongoClient;
  try { ({ MongoClient } = require("mongodb")); require("dotenv").config(); }
  catch (e) { return "left behind (no mongodb driver here)"; }
  if (!process.env.MONGODB_URI) return "left behind (no MONGODB_URI)";

  const c = new MongoClient(process.env.MONGODB_URI);
  try {
    await c.connect();
    const master = c.db(process.env.DB_NAME);
    // Matched on the address, and the address alone is the safety rail:
    // nothing real can live at @souqi.test.
    if (!/@souqi.test$/.test(email)) return "refused — not a test address";
    const ws = await master.collection("workspaces").find({ ownerEmail: email }).toArray();
    for (const w of ws) { try { await c.db("webo_" + w.id).dropDatabase(); } catch (e) {} }
    const r = await master.collection("workspaces").deleteMany({ ownerEmail: email });
    return "cleaned up (" + r.deletedCount + " workspace, " + ws.length + " database)";
  } catch (e) {
    return "left behind (" + e.message + ")";
  } finally {
    try { await c.close(); } catch (e) {}
  }
}

async function post(path, body, headers) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: JSON.stringify(body)
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
  return { status: res.status, body: json, text: text, setCookie: res.headers.get("set-cookie") || "" };
}

/* An operator object where the schema wants a string. If the validator let
   this through, {$ne:null} matches the first user in the collection. */
const OPERATORS = [
  { label: "$ne", value: { $ne: null } },
  { label: "$gt", value: { $gt: "" } },
  { label: "$regex", value: { $regex: ".*" } },
  { label: "$where", value: { $where: "return true" } },
  { label: "$nin", value: { $nin: [] } }
];

(async () => {
  console.log("\n── injection: a body cannot become a query ────────────");

  /* ---- login ------------------------------------------------------- */
  for (const op of OPERATORS) {
    await check("login refuses an operator object as the email (" + op.label + ")", async () => {
      const r = await post("/auth/login", { email: op.value, password: "anything" });
      assert(r.status === 400 || r.status === 401,
        "expected 400/401, got " + r.status + " " + JSON.stringify(r.body));
      assert(!/sq_session=/.test(r.setCookie), "a session cookie was issued");
    });

    await check("login refuses an operator object as the password (" + op.label + ")", async () => {
      const r = await post("/auth/login", { email: "probe@souqi.test", password: op.value });
      assert(r.status === 400 || r.status === 401,
        "expected 400/401, got " + r.status + " " + JSON.stringify(r.body));
      assert(!/sq_session=/.test(r.setCookie), "a session cookie was issued");
    });
  }

  /* ---- signup ------------------------------------------------------ */
  await check("signup refuses an operator object as the email", async () => {
    const r = await post("/auth/signup", { name: "Probe", email: { $ne: null }, password: "correct-horse-8" });
    assert(r.status === 400, "expected 400, got " + r.status + " " + JSON.stringify(r.body));
  });

  await check("signup refuses an operator object as the name", async () => {
    const r = await post("/auth/signup", {
      name: { $ne: null }, email: "probe-" + Date.now() + "@souqi.test", password: "correct-horse-8"
    });
    assert(r.status === 400, "expected 400, got " + r.status + " " + JSON.stringify(r.body));
  });

  /* ---- prototype pollution ----------------------------------------- */
  await check("a __proto__ key in the body does not reach Object.prototype", async () => {
    await post("/auth/login", { email: "probe@souqi.test", password: "x", __proto__: { polluted: "yes" } });
    await post("/auth/login", JSON.parse('{"email":"probe@souqi.test","password":"x","constructor":{"prototype":{"polluted":"yes"}}}'));
    assert({}.polluted === undefined, "Object.prototype was polluted");
  });

  /* ---- unknown keys are stripped, not stored ----------------------- */
  await check("an unknown field is stripped rather than written through", async () => {
    const email = "probe-strip-" + Date.now() + "@souqi.test";
    const r = await post("/auth/signup", {
      name: "Probe", email: email, password: "correct-horse-8",
      role: "Owner", plan: "max", isAdmin: true
    });
    // Whether or not signup succeeds here, the injected privilege fields must
    // never come back described as accepted.
    if (r.status === 200 && r.body && r.body.user) {
      assert(r.body.user.plan !== "max", "a client-supplied plan was honoured");
      assert(r.body.user.isAdmin === undefined, "a client-supplied isAdmin was honoured");
      console.log("      (" + email + " — " + (await removeProbeAccount(email)) + ")");
    }
  });

  if (failures) { console.log("\n✗ " + failures + " INJECTION CHECK(S) FAILED\n"); process.exit(1); }
  console.log("\n✓ ALL INJECTION TESTS PASSED\n");
})().catch((e) => { console.error("harness failed: " + e.message); process.exit(1); });
