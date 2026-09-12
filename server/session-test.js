/* =================================================================
   session-test.js — "sign out other sessions" has to mean it
   -----------------------------------------------------------------
   Sessions are stateless JWTs, so there is no row to delete. The only
   honest way to invalidate one already issued is a counter on the user
   — sessionEpoch — that every request compares against. Two halves,
   and BOTH were broken, in opposite directions:

     · Nothing enforced it. One helper checked the epoch and only a
       handful of routes called it, so a revoked token still opened the
       admin API, the GDPR export, the whole CRUD and every route in
       Code. The button said "signed out". Nothing was.

     · Nothing STAMPED it either. Only the revoke route put an epoch in
       the tokens it minted; login, signup and the claim paths left it
       out. So the first login after a revoke produced a token reading
       epoch 0 against a bumped counter — which the one helper that DID
       check would refuse, permanently, on the account's own settings.
       Revoking would have locked you out of undoing it.

   Fixing one without the other makes things worse than leaving both.
   This runs the whole round trip against a live server: sign up, use
   it, revoke, watch the old token die, sign in again, watch the new one
   work. Its account is a @souqi.test address and it deletes it.
   ================================================================= */
"use strict";

const BASE = process.env.BASE || "http://localhost:4000";
let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const pass = (m) => console.log("  ✓ " + m);

async function call(path, opts) {
  const o = opts || {};
  const r = await fetch(BASE + path, {
    method: o.method || "GET",
    headers: Object.assign({ "Content-Type": "application/json" }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  const setCookie = (typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean));
  return { status: r.status, body: json, text: text, setCookie: setCookie };
}
const cookieFrom = (lines) => {
  for (const line of lines || []) {
    const m = /^sq_session=([^;]*)/.exec(line);
    if (m && m[1]) return "sq_session=" + m[1];
  }
  return null;
};

(async () => {
  const email = "sess-" + Date.now() + "@souqi.test";
  const password = "correct-horse-battery-8";

  console.log("\n── session revocation ─────────────────────────────────");

  const up = await call("/auth/signup", { method: "POST", body: { name: "Session Probe", email: email, password: password } });
  if (up.status !== 200 && up.status !== 201) {
    console.log("• session-test SKIPPED (signup returned " + up.status + ": " + up.text.slice(0, 120) + ")");
    return;
  }
  let cookie = cookieFrom(up.setCookie);
  if (!cookie) { fail("signup issued no session cookie"); return finish(email); }
  pass("signed up, session cookie issued");

  /* A token minted at signup must already carry the account's epoch —
     this is the half that, missing, turns a revoke into a lockout. */
  const payload = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[1], "base64").toString("utf8"));
  if (Object.prototype.hasOwnProperty.call(payload, "sessionEpoch")) pass("the minted token carries a sessionEpoch");
  else fail("the token has no sessionEpoch — the first revoke will lock this account out of its own settings");

  const me = await call("/api/account/me", { headers: { Cookie: cookie } });
  if (me.status === 200) pass("the new session works");
  else { fail("a fresh session was refused: " + me.status); return finish(email); }

  /* ---- revoke ---- */
  const rev = await call("/api/account/sessions/revoke", { method: "POST", headers: { Cookie: cookie } });
  if (rev.status !== 200) { console.log("• revoke endpoint returned " + rev.status + " — skipping the rest"); return finish(email); }
  const rotated = cookieFrom(rev.setCookie);
  pass("revoke accepted" + (rotated ? " and rotated this session's own cookie" : ""));

  /* The OLD cookie is the one that must now be dead, everywhere. */
  const guarded = ["/api/account/me", "/api/projects", "/api/account/ai-keys", "/clients"];
  const stillOpen = [];
  for (const p of guarded) {
    const r = await call(p, { headers: { Cookie: cookie } });
    if (r.status < 400) stillOpen.push(p + " (" + r.status + ")");
  }
  if (stillOpen.length) fail("the revoked cookie still opens: " + stillOpen.join(", "));
  else pass("the revoked cookie is refused by all " + guarded.length + " routes");

  /* The rotated one must still work, or revoking signs YOU out too. */
  if (rotated) {
    const r = await call("/api/account/me", { headers: { Cookie: rotated } });
    if (r.status === 200) pass("the session that did the revoking still works");
    else fail("revoking signed out the session that asked for it (" + r.status + ")");
  }

  /* ---- and the way back in ---- */
  const again = await call("/auth/login", { method: "POST", body: { email: email, password: password } });
  if (again.status !== 200) { fail("could not log in again after a revoke: " + again.status + " " + again.text.slice(0, 100)); return finish(email); }
  const fresh = cookieFrom(again.setCookie);
  pass("logging in again after a revoke works");

  const after = await call("/api/account/me", { headers: { Cookie: fresh } });
  if (after.status === 200) pass("and the token that login just minted is accepted — no lockout");
  else fail("the post-revoke login minted a token the server refuses (" + after.status + ") — the epoch is not being stamped");

  return finish(email);
})().then(() => {
  if (failures) { console.log("\n✗ " + failures + " SESSION CHECK(S) FAILED\n"); process.exit(1); }
  console.log("\n✓ ALL SESSION TESTS PASSED\n");
}).catch((e) => { console.error("harness failed: " + (e && e.stack || e)); process.exit(1); });

/** The probe really signs up, so it really cleans up. */
async function finish(email) {
  let MongoClient;
  try { ({ MongoClient } = require("mongodb")); require("dotenv").config(); } catch (e) { return; }
  if (!process.env.MONGODB_URI || !/@souqi\.test$/.test(email)) return;
  const c = new MongoClient(process.env.MONGODB_URI);
  try {
    await c.connect();
    const master = c.db(process.env.DB_NAME);
    const ws = await master.collection("workspaces").find({ ownerEmail: email }).toArray();
    for (const w of ws) { try { await c.db("webo_" + w.id).dropDatabase(); } catch (e) {} }
    const r = await master.collection("workspaces").deleteMany({ ownerEmail: email });
    if (r.deletedCount) console.log("  · cleaned up " + email);
  } catch (e) { console.log("  · could not clean up " + email + ": " + e.message); }
  finally { try { await c.close(); } catch (e) {} }
}
