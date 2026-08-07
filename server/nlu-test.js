/* =================================================================
   nlu-test.js — the understanding layer's contract
   -----------------------------------------------------------------
   Slot rules are tuned for PRECISION: a wrong city is worse than no
   city, because a missing slot only removes the copy variants that
   needed it, while a wrong one is visibly wrong on the page. So the
   negative cases here matter at least as much as the positive ones.

   Run: npm run test:nlu
   ================================================================= */
"use strict";

const { analyse, detectLang, fold } = require("./lib/nlu/normalise");
const { classify, choices } = require("./lib/nlu/classify");
const { extract } = require("./lib/nlu/slots");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}
function eq(a, b, m) { if (a !== b) throw new Error((m || "expected") + ": got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); }
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }

/* ================================================================= */
console.log("\n── normalise ─────────────────────────────────────────");

check("detects Arabic script", () => eq(detectLang("أريد موقعاً لمطعمي"), "ar"));
check("detects Turkish from its own letters", () => eq(detectLang("kahve dükkanı için"), "tr"));
check("defaults to English rather than guessing", () => eq(detectLang("a shop that sells things"), "en"));
check("folds Turkish letters", () => eq(fold("İSTANBUL Şişli"), "istanbul sisli"));
check("folds Arabic orthography variants", () => eq(fold("أحمد"), "احمد"));
check("drops stopwords and stems", () => {
  const t = analyse("a website for my coffee shops").tokens;
  assert(!t.includes("a") && !t.includes("website"), "stopwords survived: " + t.join(","));
  assert(t.includes("shop"), "plural not stemmed: " + t.join(","));
});
check("Turkish suffix stripping", () => assert(analyse("kahveci dükkanı").tokens.includes("kahve")));
check("Arabic prefix stripping", () => assert(analyse("المطعم").tokens.some((t) => t.indexOf("مطعم") === 0)));

/* ================================================================= */
console.log("\n── classify ──────────────────────────────────────────");

const CASES = [
  ["a storefront for my Istanbul coffee roastery with online ordering", "restaurant"],
  ["family pizzeria, we deliver in the evenings", "restaurant"],
  ["boutique clothing store named Nord", "fashion"],
  ["we sell leather bags and belts we make ourselves", "fashion"],
  ["freight forwarder with shipment tracking", "logistics"],
  ["a courier company, customers want to check where their parcel is", "logistics"],
  ["CNC machining shop taking custom orders", "manufacturing"],
  ["construction firm project portfolio", "construction"],
  ["roofing company, free site survey", "construction"],
  ["barber shop with appointment booking", "services"],
  ["dental clinic that needs an appointment page", "services"],
  ["auto parts wholesaler", "wholesale"],
  ["hardware store with a big product range", "retail"],
  ["İstanbul'daki kahve dükkanım için online sipariş alan bir site", "restaurant"],
  ["nakliye firması için kargo takip sistemi olan site", "logistics"],
  ["berber dükkanı için randevu sistemi", "services"],
  ["أريد موقعاً لمطعمي مع قائمة الطعام والطلب اونلاين", "restaurant"],
  ["شركة شحن مع تتبع الشحنات", "logistics"],
  ["صالون حلاقة مع نظام حجز مواعيد", "services"]
];

CASES.forEach(([prompt, want]) => {
  check("classifies: " + prompt.slice(0, 44), () => {
    const r = classify(prompt);
    eq(r.industry, want, "industry");
    assert(r.certain, "should have been confident, got " + r.confidence);
  });
});

check("gets it right with no keyword at all", () => {
  // the case the old first-keyword-wins matcher could not do
  const r = classify("I sell parts to garages, they order by the box");
  eq(r.industry, "wholesale");
});

check("asks instead of guessing on a vague prompt", () => {
  const r = classify("something nice");
  assert(!r.certain, "should not be confident");
  assert(choices(r).length >= 2, "should offer options");
});

check("asks instead of guessing on an empty prompt", () => {
  assert(!classify("").certain);
});

check("confidence is a real distribution", () => {
  const r = classify("bakery with daily specials");
  const sum = r.ranked.reduce((n, x) => n + x.p, 0);
  assert(Math.abs(sum - 1) < 0.02, "probabilities sum to " + sum);
});

check("is deterministic", () => {
  const a = classify("pet supplies shop, food and toys");
  const b = classify("pet supplies shop, food and toys");
  eq(a.industry, b.industry); eq(a.confidence, b.confidence);
});

/* ================================================================= */
console.log("\n── slots: company ────────────────────────────────────");

check("'called X' stops at the next clause", () => {
  eq(extract("a storefront for my coffee roastery called Kahve Co with online ordering").company, "Kahve Co");
});
check("'named X'", () => eq(extract("boutique clothing store named Nord").company, "Nord"));
check("Turkish 'X adlı'", () => eq(extract("Kesim adlı berber dükkanı").company, "Kesim"));
check("a bare city is not a company name", () => {
  const s = extract("a coffee shop in Istanbul");
  assert(s.company !== "Istanbul", "city leaked into company: " + s.company);
});
check("no invented name when there isn't one", () => {
  eq(extract("we sell bulk rice and sugar").company, "");
});

console.log("\n── slots: city & currency ────────────────────────────");

check("finds a Turkish city and its currency", () => {
  const s = extract("a bakery in Ankara");
  eq(s.city, "Ankara"); eq(s.currency, "₺");
});
check("finds a two-word city", () => eq(extract("freight company in Abu Dhabi").city, "Abu Dhabi"));
check("finds a city written in Arabic", () => eq(extract("مطعم في دبي").city, "Dubai"));
check("does not match a city inside another word", () => {
  eq(extract("we make romantic gifts").city, "", "'rome' matched inside 'romantic'");
});
check("falls back to a sane currency with no city", () => {
  eq(extract("a shop").currency, "$");
  eq(extract("bir dükkan").currency, "₺");
});

console.log("\n── slots: features, tone, colour ─────────────────────");

check("detects booking", () => assert(extract("barber with appointment booking").features.includes("booking")));
check("detects tracking and quotes together", () => {
  const f = extract("freight forwarder with shipment tracking and quote requests").features;
  assert(f.includes("tracking") && f.includes("quotes"), "got " + f.join(","));
});
check("detects Turkish features", () => {
  const f = extract("online sipariş ve teslimat yapıyoruz").features;
  assert(f.includes("ordering") && f.includes("delivery"), "got " + f.join(","));
});
check("detects Arabic features", () => {
  const f = extract("مطعم مع قائمة الطعام وحجز طاولة").features;
  assert(f.includes("menu") && f.includes("booking"), "got " + f.join(","));
});
check("no features when none are mentioned", () => eq(extract("a small shop").features.length, 0));

check("premium tone", () => eq(extract("premium bespoke tailoring").tone, "premium"));
check("warm tone", () => eq(extract("family bakery, handmade cakes").tone, "warm"));
check("technical tone", () => eq(extract("industrial parts to ISO spec").tone, "technical"));
check("neutral when nothing signals a tone", () => eq(extract("a shop that sells things").tone, "neutral"));

check("colour word to hex", () => {
  const s = extract("boutique store, green brand");
  eq(s.colourWord, "green"); assert(/^#[0-9a-f]{6}$/i.test(s.colour));
});
check("Turkish colour word", () => eq(extract("kırmızı temalı kahve dükkanı").colourWord, "red"));
check("no colour when none is named", () => eq(extract("a coffee shop").colour, null));
check("does not match a colour inside another word", () => {
  eq(extract("we sell greenhouses").colourWord, null, "'green' matched inside 'greenhouses'");
});

/* ================================================================= */
console.log("\n── end to end ────────────────────────────────────────");

check("a rich prompt yields every slot", () => {
  const p = "premium boutique clothing store named Nord in London, green brand, with online ordering";
  const c = classify(p);
  const s = extract(p, c.lang);
  eq(c.industry, "fashion");
  eq(s.company, "Nord"); eq(s.city, "London"); eq(s.currency, "£");
  eq(s.tone, "premium"); eq(s.colourWord, "green");
  assert(s.features.includes("ordering"));
});

check("understanding a prompt takes under 5ms", () => {
  const p = "a storefront for my Istanbul coffee roastery called Kahve Co with online ordering";
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) { const c = classify(p); extract(p, c.lang); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
  assert(ms < 5, "took " + ms.toFixed(2) + "ms per prompt");
  console.log("      (" + ms.toFixed(2) + " ms per prompt)");
});

/* ================================================================= */
console.log("\n──────────────────────────────────────────────────────");
console.log(failed === 0 ? "✓ ALL NLU TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed");
process.exit(failed === 0 ? 0 : 1);
