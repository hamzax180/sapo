/* =================================================================
   domain-test.js — a custom domain is that project, and only that
   -----------------------------------------------------------------
   Two things were wrong with custom domains at once, and they pulled
   in opposite directions.

   TOO MUCH. A matching host was answered for EVERY path, including
   /api and /auth. And the platform's own name was not on the list of
   hosts that belong to the platform — PLATFORM_HOSTS had
   app.souqi.site but not souqi.site — so a published project could
   claim the real domain and be served in its place: the API, the
   sign-in page, all of it. Measured on a running server with a
   throwaway host, before the fix: /api/projects, /api/account/me and
   /auth/login all came back as the project's index.html.

   TOO LITTLE. The check was registered several hundred lines below
   app.get("/") and express.static, so on a domain someone had just
   connected, the root path served Souqi's own marketing page. The one
   URL that matters most showed a stranger's homepage.

   Both are the same test: ask what each host answers, and check it is
   the right one.

   The probe uses a .invalid host, deliberately. This database is
   shared with production and a row claiming a real name would take the
   live site over for as long as it existed.
   ================================================================= */
"use strict";

const BASE = process.env.BASE || "http://localhost:4000";
const PROBE_HOST = "domain-test-probe.invalid";
const MARK = "THE CUSTOMER APP";

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ " + m); };
const pass = (m) => console.log("  ✓ " + m);

/* fetch() silently drops a Host header — it is forbidden by the spec — so
   the request goes out over a raw socket instead. Finding that out the
   slow way is why this comment exists. */
function get(path, host) {
  const http = require("http");
  const url = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port || 80, path: path, method: "GET",
      headers: host ? { Host: host } : {}
    }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: body }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  let MongoClient;
  try { ({ MongoClient } = require("mongodb")); require("dotenv").config(); }
  catch (e) { console.log("• domain-test SKIPPED (" + e.message + ")"); return; }
  if (!process.env.MONGODB_URI) { console.log("• domain-test SKIPPED (no MONGODB_URI)"); return; }

  const id = "pr_domtest" + Math.random().toString(36).slice(2, 8);
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const projects = client.db(process.env.DB_NAME).collection("projects");

  try {
    await projects.insertOne({
      id: id, slug: "domain-test-probe", title: "Domain probe",
      ownerAnonId: "an_domain_test", createdAt: new Date().toISOString(),
      published: {
        publicSlug: "domain-test-probe", customDomain: PROBE_HOST,
        files: { "index.html": Buffer.from("<!DOCTYPE html><html><body><h1>" + MARK + "</h1></body></html>", "utf8").toString("base64") }
      }
    });

    console.log("\n── custom domains ─────────────────────────────────────");

    /* ---- the customer's domain is the customer's app ---- */
    const theirs = [];
    for (const p of ["/", "/index.html", "/about", "/login", "/projects"]) {
      const r = await get(p, PROBE_HOST);
      if (r.body.indexOf(MARK) < 0) theirs.push(p + " (" + r.status + ")");
    }
    if (theirs.length) fail("a connected domain did not serve the project at: " + theirs.join(", "));
    else pass("every page path on a connected domain serves that project, root included");

    /* ---- but it is not the platform ---- */
    const shadowed = [];
    for (const p of ["/api/projects", "/api/account/me", "/auth/login"]) {
      const r = await get(p, PROBE_HOST);
      if (r.body.indexOf(MARK) >= 0) shadowed.push(p);
    }
    if (shadowed.length) {
      fail("a custom domain shadowed the platform's own routes: " + shadowed.join(", ") +
        " — a domain pointed here could stand in for the API and the sign-in page");
    } else pass("/api and /auth on a connected domain are still the platform's");

    /* ---- and payments, which is why /api is excluded at all ---- */
    const pay = await get("/api/apps/" + id + "/payment-items", PROBE_HOST);
    if (pay.status === 200 && pay.body.indexOf(MARK) < 0) {
      pass("a shop on its own domain can still reach the payment API");
    } else fail("payments from a custom domain answered " + pay.status + ": " + pay.body.slice(0, 60));

    /* ---- the platform's own host is untouched ---- */
    const leaked = [];
    for (const p of ["/", "/login", "/api/projects"]) {
      const r = await get(p, null);
      if (r.body.indexOf(MARK) >= 0) leaked.push(p);
    }
    if (leaked.length) fail("the probe project leaked onto the platform's own host at: " + leaked.join(", "));
    else pass("the platform's own host serves the platform");

    /* ---- and its own names cannot be claimed ---- */
    const src = require("fs").readFileSync(require("path").join(__dirname, "index.js"), "utf8");
    if (src.indexOf("isPlatformZone") < 0) {
      fail("there is no platform-zone check, so a project can claim the platform's own domain");
    } else {
      const m = /const PLATFORM_HOSTS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
      const set = m ? m[1] : "";
      if (set.indexOf("APP_HOST") < 0) {
        fail("PLATFORM_HOSTS does not include the app's own domain — souqi.site would fall through to a custom-domain lookup");
      } else pass("the app's own domain is a platform host, and a zone check guards the claim");
    }
  } finally {
    const r = await projects.deleteOne({ id: id });
    if (!r.deletedCount) console.log("  ! the probe row was NOT removed — delete " + id + " by hand");
    const stray = await projects.countDocuments({ "published.customDomain": { $regex: "invalid$" } });
    if (stray) console.log("  ! " + stray + " project(s) still claim a .invalid domain");
    await client.close();
  }

  if (failures) { console.log("\n✗ " + failures + " DOMAIN CHECK(S) FAILED\n"); process.exit(1); }
  console.log("\n✓ ALL DOMAIN TESTS PASSED\n");
})().catch((e) => { console.error("harness failed: " + (e && e.stack || e)); process.exit(1); });
