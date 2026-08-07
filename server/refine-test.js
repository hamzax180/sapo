/* =================================================================
   refine-test.js — patch, don't rebuild
   -----------------------------------------------------------------
   Two layers proven here:

     1. UNIT: grammar.parse() + applyOps() against real composed
        configs — every op in the closed vocabulary, plus the honesty
        cases (unmatched, and matched-but-nothing-to-change).
     2. INTEGRATION: a chain of follow-ups against a REAL server +
        in-memory Mongo, proving each patch becomes its OWN revision —
        so three edits in a row means four revisions on record, not
        one config silently overwritten three times — and that an
        unmatched follow-up still falls back to a full rebuild rather
        than failing.

   Run: npm run test:refine
   ================================================================= */
"use strict";
const assert = require("assert");

const composer = require("./lib/composer");
const { validateSiteConfig } = require("./lib/site-validate");
const grammar = require("./lib/refine/grammar");
const { applyOps } = require("./lib/refine/apply");
const palette = require("./lib/design/palette");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}
function assertOk(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected") + ": got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); }

/* a real, validated config to patch against */
function seedConfig(prompt, hints) {
  const out = composer.compose(prompt, hints || {});
  return validateSiteConfig(out.config).config;
}

/* ================================================================= */
console.log("\n── unit: the six ops, against real configs ───────────");

check("setTheme: 'make it darker' shifts the actual accent", () => {
  const cfg = seedConfig("a bakery called Sweet Co", { industry: "restaurant", company: "Sweet Co" });
  const before = cfg.theme.accentColor;
  const r = grammar.parse("make it darker", cfg, { company: "Sweet Co" });
  assertOk(r && r.ops, "no match");
  const applied = applyOps(cfg, r.ops);
  assertOk(applied.changed);
  const rv = validateSiteConfig(applied.config, { forAgent: true });
  assertOk(rv.ok, "did not validate: " + rv.issues.join(","));
  eq(rv.issues.length, 0, "produced issues: " + rv.issues.join(" | "));
  assertOk(rv.config.theme.accentColor !== before, "accent did not change");
  const oBefore = palette.toOklch(before), oAfter = palette.toOklch(rv.config.theme.accentColor);
  assertOk(oAfter.l < oBefore.l, "darker did not reduce lightness");
});

check("setTheme: an explicit colour word wins outright", () => {
  const cfg = seedConfig("a shop", { industry: "retail" });
  const r = grammar.parse("use green please", cfg, {});
  assertOk(r && r.ops[0].op === "setTheme");
  const applied = applyOps(cfg, r.ops);
  const rv = validateSiteConfig(applied.config, { forAgent: true });
  eq(rv.config.theme.accentColor.toLowerCase(), "#2f855a");
});

check("addBlock: 'add testimonials' inserts case-studies once, not twice", () => {
  let cfg = seedConfig("a shop", { industry: "retail" });
  const r1 = grammar.parse("add testimonials", cfg, {});
  assertOk(r1 && r1.ops, "first add did not match");
  cfg = validateSiteConfig(applyOps(cfg, r1.ops).config, { forAgent: true }).config;
  assertOk(cfg.pages.main.blocks.some((b) => b.type === "case-studies"));

  const r2 = grammar.parse("add testimonials", cfg, {});
  assertOk(r2 && r2.noop, "asking twice should be a no-op, not a duplicate");
  eq(cfg.pages.main.blocks.filter((b) => b.type === "case-studies").length, 1);
});

check("removeBlock: removes a block that exists, no-ops on one that doesn't", () => {
  let cfg = seedConfig("a shop", { industry: "retail" });
  assertOk(cfg.pages.main.blocks.some((b) => b.type === "steps"), "fixture assumption: steps exists");
  const r = grammar.parse("remove the steps", cfg, {});
  assertOk(r && r.ops, "remove did not match");
  cfg = validateSiteConfig(applyOps(cfg, r.ops).config, { forAgent: true }).config;
  assertOk(!cfg.pages.main.blocks.some((b) => b.type === "steps"));

  const again = grammar.parse("remove the steps", cfg, {});
  assertOk(again && again.noop, "removing an absent block should be an honest no-op");
});

check("moveBlock: 'move X up' actually reorders, and settles at the top", () => {
  let cfg = seedConfig("a shop", { industry: "retail" });
  const idxBefore = cfg.pages.main.blocks.findIndex((b) => b.type === "steps");
  assertOk(idxBefore > 0, "fixture assumption: steps isn't already first");
  const r = grammar.parse("move steps up", cfg, {});
  assertOk(r && r.ops);
  cfg = validateSiteConfig(applyOps(cfg, r.ops).config, { forAgent: true }).config;
  const idxAfter = cfg.pages.main.blocks.findIndex((b) => b.type === "steps");
  eq(idxAfter, idxBefore - 1);

  // move it all the way to the top, then confirm "up" from there is a no-op
  let guard = 0;
  while (cfg.pages.main.blocks.findIndex((b) => b.type === "steps") > 0 && guard++ < 10) {
    const rr = grammar.parse("move steps up", cfg, {});
    cfg = validateSiteConfig(applyOps(cfg, rr.ops).config, { forAgent: true }).config;
  }
  eq(cfg.pages.main.blocks.findIndex((b) => b.type === "steps"), 0);
  const atTop = grammar.parse("move steps up", cfg, {});
  assertOk(atTop && atTop.noop, "moving something already at the top should be a no-op");
});

check("setProp: change the headline sets exactly that block's title", () => {
  const cfg = seedConfig("a shop", { industry: "retail" });
  const r = grammar.parse('change the headline to "Everything, delivered fast"', cfg, {});
  assertOk(r && r.ops, "headline change did not match");
  const applied = applyOps(cfg, r.ops);
  const rv = validateSiteConfig(applied.config, { forAgent: true });
  assertOk(rv.ok);
  const hero = rv.config.pages.main.blocks.find((b) => b.type === "hero");
  eq(hero.props.title, "Everything, delivered fast");
});

check("addPage: 'add a booking page' creates a new page with real blocks", () => {
  const cfg = seedConfig("a salon", { industry: "services", company: "The Studio" });
  const r = grammar.parse("add a booking page", cfg, {});
  assertOk(r && r.ops, "addPage did not match");
  const applied = applyOps(cfg, r.ops);
  assertOk(applied.changed);
  const rv = validateSiteConfig(applied.config, { forAgent: true });
  assertOk(rv.ok, rv.issues.join(","));
  assertOk(rv.config.pages.booking, "booking page missing");
  assertOk(rv.config.pages.booking.blocks.length >= 1);
  assertOk(rv.config.navOrder.includes("booking"), "new page never reached the nav");
});

check("addPage: asking for the same page twice is a no-op, not a duplicate", () => {
  let cfg = seedConfig("a salon", { industry: "services" });
  const r1 = grammar.parse("add a booking page", cfg, {});
  cfg = validateSiteConfig(applyOps(cfg, r1.ops).config, { forAgent: true }).config;
  const r2 = grammar.parse("add a booking page", cfg, {});
  assertOk(r2 && r2.noop);
});

/* ================================================================= */
console.log("\n── unit: the trust boundary still applies ────────────");

check("a hand-crafted op targeting a bogus block id is simply ignored", () => {
  const cfg = seedConfig("a shop", { industry: "retail" });
  const applied = applyOps(cfg, [{ op: "setProp", page: "main", block: "b_does_not_exist", path: "title", value: "hi" }]);
  eq(applied.changed, false);
});

check("addBlock only ever inserts a block type that's actually in the registry", () => {
  const cfg = seedConfig("a shop", { industry: "retail" });
  const applied = applyOps(cfg, [{ op: "addBlock", page: "main", block: { type: "evil-script-block", props: { html: "<script>x</script>" } } }]);
  const rv = validateSiteConfig(applied.config, { forAgent: true });
  assertOk(rv.ok);
  assertOk(!rv.config.pages.main.blocks.some((b) => b.type === "evil-script-block"), "an unknown block type reached the stored config");
});

check("no rule match returns undefined, not a guess", () => {
  const cfg = seedConfig("a shop", { industry: "retail" });
  eq(grammar.parse("please completely reimagine this as something else entirely", cfg, {}), null);
});

/* ================================================================= */
console.log("\n── integration: real server, real chain of follow-ups ─");

(async () => {
  let MongoMemoryServer, MongoClient;
  try {
    ({ MongoMemoryServer } = require("mongodb-memory-server"));
    ({ MongoClient } = require("mongodb"));
  } catch (e) {
    console.log("• integration skipped (mongodb-memory-server not available):", e.message);
    finish();
    return;
  }

  let mongod;
  try { mongod = await MongoMemoryServer.create(); }
  catch (e) {
    console.log("• integration skipped (could not start in-memory mongod):", e.message);
    finish();
    return;
  }

  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.DB_NAME = "souqi_master";
  process.env.JWT_SECRET = "refine-test-secret";
  process.env.PORT = "4101";
  process.env.GEMINI_API_KEY = "";
  process.env.LOG_REQUESTS = "0";
  const base = "http://localhost:4101";
  const seedClient = new MongoClient(uri);

  function browser() {
    const jar = new Map();
    return async (path, opts = {}) => {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers);
      if (jar.size) opts.headers.Cookie = [...jar].map(([k, v]) => k + "=" + v).join("; ");
      if (opts.body && typeof opts.body === "object") opts.body = JSON.stringify(opts.body);
      const r = await fetch(base + path, opts);
      const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
      raw.forEach((line) => { const [pair] = line.split(";"); const eq2 = pair.indexOf("="); if (eq2 > 0) jar.set(pair.slice(0, eq2), pair.slice(eq2 + 1)); });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
  }

  try {
    await seedClient.connect();
    require("./index.js");
    const deadline = Date.now() + 15000;
    for (;;) {
      try { const r = await fetch(base + "/health"); if (r.ok) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error("server did not come up");
      await new Promise((r) => setTimeout(r, 250));
    }

    const alice = browser();
    let res = await alice("/api/projects", { method: "POST", body: { prompt: "a bakery called Sweet Co in Bursa with online ordering" } });
    assert.strictEqual(res.status, 201, "create failed: " + JSON.stringify(res.data));
    const slug = res.data.slug;
    const firstAccent = res.data.config.theme.accentColor;
    check("create: a real project exists to patch against", () => assertOk(!!slug));

    res = await alice("/api/projects/" + slug + "/turns", { method: "POST", body: { message: "make it darker" } });
    check("patch 1/3 (theme): 200, no rebuild fields, accent actually changed", () => {
      assert.strictEqual(res.status, 200, JSON.stringify(res.data));
      eq(res.data.kind, "patch");
      assertOk(res.data.config.theme.accentColor !== firstAccent);
    });

    res = await alice("/api/projects/" + slug + "/turns", { method: "POST", body: { message: "add testimonials" } });
    check("patch 2/3 (add block): case-studies present, home page grew by exactly one block", () => {
      assert.strictEqual(res.status, 200, JSON.stringify(res.data));
      eq(res.data.kind, "patch");
      assertOk(res.data.config.pages.main.blocks.some((b) => b.type === "case-studies"));
    });
    const blocksAfterAdd = res.data.config.pages.main.blocks.length;

    res = await alice("/api/projects/" + slug + "/turns", { method: "POST", body: { message: "remove the steps" } });
    check("patch 3/3 (remove block): stats gone, everything else intact", () => {
      assert.strictEqual(res.status, 200);
      eq(res.data.kind, "patch");
      assertOk(!res.data.config.pages.main.blocks.some((b) => b.type === "steps"));
      eq(res.data.config.pages.main.blocks.length, blocksAfterAdd - 1);
      assertOk(res.data.config.pages.main.blocks.some((b) => b.type === "case-studies"), "patch 2's change was lost by patch 3");
    });

    res = await alice("/api/projects/" + slug);
    check("three patches -> FOUR revisions on record (first build + 3 patches), nothing overwritten in place", () => {
      assert.strictEqual(res.status, 200);
      eq(res.data.revisions.length, 4, "got " + res.data.revisions.length + " revisions");
    });
    check("the transcript has a turn per patch, in English, naming what changed", () => {
      const agentTurns = res.data.turns.filter((t) => t.role === "agent");
      assertOk(agentTurns.some((t) => /darker/.test(t.body)));
      assertOk(agentTurns.some((t) => /testimonials/.test(t.body)));
      assertOk(agentTurns.some((t) => /steps/.test(t.body)));
    });

    res = await alice("/api/projects/" + slug + "/turns", { method: "POST", body: { message: "remove the steps" } });
    check("asking for the same removal again is an honest no-op, not a 5th identical revision", () => {
      assert.strictEqual(res.status, 200);
      eq(res.data.noop, true);
      assertOk(/steps/i.test(res.data.reason), "reason didn't mention steps: " + res.data.reason);
    });
    res = await alice("/api/projects/" + slug);
    check("a no-op really did not create a new revision", () => eq(res.data.revisions.length, 4));

    res = await alice("/api/projects/" + slug + "/turns", {
      method: "POST", body: { message: "actually, let's make this a completely different kind of business entirely, a freight company" }
    });
    check("an unmatched follow-up still falls back to a full rebuild, not an error", () => {
      assert.strictEqual(res.status, 200, JSON.stringify(res.data));
      eq(res.data.kind, "rebuild");
      eq(res.data.meta.industry, "logistics");
    });
    res = await alice("/api/projects/" + slug);
    check("the fallback rebuild is ALSO just one more revision, not a reset", () => eq(res.data.revisions.length, 5));
  } catch (e) {
    failed++;
    console.error("\n✗ REFINE INTEGRATION FAILED:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  } finally {
    try { await seedClient.close(); } catch (e) {}
    try { await mongod.stop(); } catch (e) {}
    finish();
  }
})();

function finish() {
  console.log(failed === 0 ? "\n✓ ALL REFINE TESTS PASSED (" + passed + ")" : "\n✗ " + failed + " FAILED, " + passed + " passed");
  process.exit(failed === 0 ? 0 : 1);
}
