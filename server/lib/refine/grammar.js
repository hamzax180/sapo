/* =================================================================
   refine/grammar.js — turn a follow-up sentence into ops, no model
   -----------------------------------------------------------------
   ~50 phrasings cover most real follow-ups (docs/AGENT-PARITY-PLAN.md
   §4.2). Each rule is a plain regex against the NORMALISED message,
   built on the same folding/stemming the classifier uses, so "make it
   DARKER!!" and "make it darker" hit the same rule.

   Every rule reads the CURRENT config to resolve what it's talking
   about — "remove the banner" only becomes an op if a banner-shaped
   block actually exists — so a request about something that isn't
   there comes back as an honest no-op, not a guess.

   parse() returns one of:
     { ops, summary }              matched — apply and store a revision
     { noop: true, reason }        matched the INTENT, target wasn't found
     null                          no rule matched — caller falls back
                                    to a full rebuild (still honest: that
                                    genuinely is the only way to satisfy it)

   English only for now, matching the copy corpus (NO-API-BUILDER-PLAN
   §2 lists TR/AR corpora as still to do — this inherits that gap
   rather than half-supporting it).
   ================================================================= */
"use strict";

const { fold } = require("../nlu/normalise");
const { COLOURS } = require("../nlu/slots");
const palette = require("../design/palette");
const ARCH = require("../../../data/archetypes.json");

/* ---- reading the config: "the banner", "testimonials", "the hero" ---- */
const NAME_TO_TYPE = {
  banner: "quote-banner", "quote banner": "quote-banner", quote: "quote-banner",
  "announcement bar": "topbar", announcement: "topbar", topbar: "topbar",
  stats: "stats", statistics: "stats", numbers: "stats",
  testimonials: "case-studies", reviews: "case-studies", "case studies": "case-studies", "success stories": "case-studies",
  gallery: "editorial-grid", portfolio: "editorial-grid", photos: "editorial-grid",
  steps: "steps", "how it works": "steps", process: "steps",
  "product grid": "product-grid", products: "product-grid", catalogue: "product-grid", catalog: "product-grid", shop: "product-grid",
  "contact form": "rfq-form", "quote form": "rfq-form", "booking form": "rfq-form", form: "rfq-form",
  footer: "footer-rich",
  tracker: "tracker", tracking: "tracker",
  hero: "hero", header: "hero", banner_hero: "hero",
  "card grid": "card-grid", cards: "card-grid", services: "card-grid", capabilities: "card-grid",
  "rich text": "richtext", text: "richtext", story: "richtext", about: "richtext",
  "link grid": "link-grid", locations: "link-grid", branches: "link-grid",
  partners: "partner-grid", brands: "brand-wall", "trust wall": "brand-wall",
  slideshow: "slideshow", carousel: "slideshow", "image banner": "image-banner"
};
const NAME_PATTERN = Object.keys(NAME_TO_TYPE).sort((a, b) => b.length - a.length).map((s) => s.replace(/ /g, "\\s+")).join("|");

function findBlockByType(config, type) {
  const home = config.pages && (config.pages.main || config.pages[Object.keys(config.pages)[0]]);
  if (!home) return null;
  return (home.blocks || []).find((b) => b.type === type) || null;
}
function homeSlug(config) {
  if (config.pages && config.pages.main) return "main";
  return config.pages ? Object.keys(config.pages)[0] : "main";
}

/* ---- new-page templates for "add a menu page" style requests ----
   Deliberately small and generic — these are a quick starting point the
   owner edits afterward, not a full archetype composition. */
function pageBlocks(kind, ctx) {
  const accent = (ctx.config.theme && ctx.config.theme.accentColor) || "#1aa6df";
  const footer = { type: "footer-rich", props: {
    tagline: ctx.company, desc: "", accentColor: accent, bgColor: "#12202e",
    newsletter: false, contactEmail: "", contactPhone: "", contactAddress: "", legal: "© " + new Date().getFullYear() + " " + ctx.company,
    socials: [], columns: []
  } };
  const map = {
    contact: [{ type: "rfq-form", props: { title: "Get in touch", subtitle: "Tell us what you need and we'll come back the same working day.", perks: [{ value: "Same-day reply" }], submitLabel: "Send message" } }, footer],
    booking: [{ type: "rfq-form", props: { title: "Book an appointment", subtitle: "Tell us what you're after and a time that suits you.", perks: [{ value: "Confirmed same day" }], submitLabel: "Request a time" } }, footer],
    menu: [{ type: "product-grid", props: { title: "Menu", subtitle: "", showCatBar: true, limit: 0, ctaLabel: "", ctaAction: "none", ctaTarget: "" } }, footer],
    shop: [{ type: "product-grid", props: { title: "Shop", subtitle: "", showCatBar: true, limit: 0, ctaLabel: "", ctaAction: "none", ctaTarget: "" } }, footer],
    gallery: [{ type: "editorial-grid", props: { title: "Gallery", subtitle: "", items: [] } }, footer],
    faq: [{ type: "richtext", props: { heading: "Frequently asked questions", body: "Add your questions and answers here." } }, footer],
    about: [{ type: "richtext", props: { heading: "About " + ctx.company, body: "" } }, footer]
  };
  return map[kind] || [{ type: "richtext", props: { heading: ctx.title, body: "" } }, footer];
}

/* ================================================================= */

function parse(message, config, meta) {
  const m = String(message || "");
  const norm = fold(m).toLowerCase();
  const ctx = { config: config, company: (meta && meta.company) || config.company || "the business" };
  const page = homeSlug(config);

  /* ---- 1. theme shift: darker / lighter / bolder / muted / warmer / cooler ---- */
  const SHIFT_WORDS = {
    darker: "darker", dark: "darker",
    lighter: "lighter", light: "lighter", brighter: "lighter",
    bolder: "bolder", "more vibrant": "bolder", "more colourful": "bolder", "more colorful": "bolder", punchier: "bolder",
    muted: "muted", "more muted": "muted", softer: "muted", subtler: "muted", "less vibrant": "muted",
    warmer: "warmer", warm: "warmer",
    cooler: "cooler", cool: "cooler"
  };
  for (const word of Object.keys(SHIFT_WORDS).sort((a, b) => b.length - a.length)) {
    if (new RegExp("\\b" + word + "\\b").test(norm)) {
      const kind = SHIFT_WORDS[word];
      const current = (config.theme && config.theme.accentColor) || "#1aa6df";
      const next = palette.shift(current, kind);
      return { ops: [{ op: "setTheme", path: "accentColor", value: next }], summary: "made the colour " + kind };
    }
  }

  /* ---- 2. an explicit colour word: "make it green", "use navy" ---- */
  for (const word of Object.keys(COLOURS)) {
    if (new RegExp("\\b" + word + "\\b").test(norm)) {
      return { ops: [{ op: "setTheme", path: "accentColor", value: COLOURS[word] }], summary: "changed the colour to " + word };
    }
  }

  /* ---- 3. add a page: "add a menu page", "add a contact page" ---- */
  let mm = /\badd\s+(?:a|an)?\s*([a-z][a-z\s]{1,24}?)\s+page\b/.exec(norm);
  if (mm) {
    const raw = mm[1].trim();
    const slug = raw.replace(/\s+/g, "-").slice(0, 30);
    if (config.pages && config.pages[slug]) return { noop: true, reason: "There's already a " + raw + " page." };
    const kindKey = Object.keys({ contact: 1, booking: 1, menu: 1, shop: 1, gallery: 1, faq: 1, about: 1 }).find((k) => raw.indexOf(k) >= 0) || raw;
    const blocks = pageBlocks(kindKey, Object.assign({ title: titleCase(raw) }, ctx));
    return {
      ops: [{ op: "addPage", slug: slug, title: titleCase(raw), blocks: blocks }],
      summary: "added a " + titleCase(raw) + " page"
    };
  }

  /* ---- 4. add a section by feature/name: "add testimonials", "add a gallery" ----
     One regex per known name, rather than one giant alternation — each match
     is unambiguous about which block type it means. */
  for (const name of Object.keys(NAME_TO_TYPE)) {
    const re = new RegExp("\\badd\\s+(?:a|an|some)?\\s*" + name.replace(/ /g, "\\s+") + "\\b");
    if (re.test(norm)) {
      const type = NAME_TO_TYPE[name];
      if (findBlockByType(config, type)) return { noop: true, reason: "There's already a " + name + " section on the page." };
      const props = defaultPropsFor(type, ctx);
      if (!props) break;
      const home = config.pages[page];
      const footerIdx = (home.blocks || []).findIndex((b) => b.type === "footer-rich");
      const at = footerIdx >= 0 ? footerIdx : (home.blocks || []).length;
      return {
        ops: [{ op: "addBlock", page: page, at: at, block: { type: type, props: props } }],
        summary: "added " + name
      };
    }
  }
  // features from the same vocabulary the initial build understands
  for (const feature of Object.keys(ARCH.inject)) {
    const re = new RegExp("\\badd\\s+(?:a|an|some)?\\s*" + feature + "\\b");
    if (re.test(norm)) {
      const rule = ARCH.inject[feature];
      if (findBlockByType(config, rule.type)) return { noop: true, reason: "There's already a " + feature + " section." };
      const props = defaultPropsFor(rule.type, ctx);
      if (props) {
        const home = config.pages[page];
        const afterIdx = (home.blocks || []).findIndex((b) => b.type === rule.after);
        const at = afterIdx >= 0 ? afterIdx + 1 : home.blocks.length;
        return { ops: [{ op: "addBlock", page: page, at: at, block: { type: rule.type, props: props } }], summary: "added " + feature };
      }
    }
  }

  /* ---- 5. remove a section: "remove the banner", "drop the stats" ---- */
  mm = new RegExp("\\b(?:remove|delete|drop|get rid of)\\s+(?:the\\s+)?(" + NAME_PATTERN + ")\\b").exec(norm);
  if (mm) {
    const type = NAME_TO_TYPE[mm[1].replace(/\s+/g, " ")];
    const block = type && findBlockByType(config, type);
    if (!block) return { noop: true, reason: "There's no " + mm[1] + " section to remove." };
    return { ops: [{ op: "removeBlock", page: page, block: block.id }], summary: "removed " + mm[1] };
  }

  /* ---- 6. move a section: "move testimonials up", "move the hero to the top" ---- */
  mm = new RegExp("\\bmove\\s+(?:the\\s+)?(" + NAME_PATTERN + ")\\s+(up|down|to\\s+the\\s+top|to\\s+the\\s+bottom|to\\s+top|to\\s+bottom)\\b").exec(norm);
  if (mm) {
    const type = NAME_TO_TYPE[mm[1].replace(/\s+/g, " ")];
    const block = type && findBlockByType(config, type);
    if (!block) return { noop: true, reason: "There's no " + mm[1] + " section to move." };
    const home = config.pages[page];
    const idx = home.blocks.findIndex((b) => b.id === block.id);
    const dir = mm[2].replace(/\s+/g, " ");
    let to = idx;
    if (dir === "up") to = idx - 1;
    else if (dir === "down") to = idx + 1;
    else if (dir.indexOf("top") >= 0) to = 0;
    else if (dir.indexOf("bottom") >= 0) to = home.blocks.length - 1;
    to = Math.max(0, Math.min(to, home.blocks.length - 1));
    if (to === idx) return { noop: true, reason: "The " + mm[1] + " section is already there." };
    return { ops: [{ op: "moveBlock", page: page, block: block.id, to: to }], summary: "moved " + mm[1] + " " + dir };
  }

  /* ---- 7. change the headline: change the headline to "X" ----
     Matched case-insensitively against the ORIGINAL message (never the
     lowercased `norm`/`m.toLowerCase()` used above) — the new headline is a
     literal value the visitor typed, and lowercasing "Roasted Fresh Daily"
     into "roasted fresh daily" would silently mangle their actual words. */
  mm = /\b(?:change|set)\s+the\s+(?:headline|title|heading)\s+to\s+"([^"]{1,120})"/i.exec(m) ||
       /\b(?:change|set)\s+the\s+(?:headline|title|heading)\s+to\s+(.{1,120})$/i.exec(m);
  if (mm) {
    const hero = findBlockByType(config, "hero");
    if (!hero) return { noop: true, reason: "There's no headline block on this page." };
    return { ops: [{ op: "setProp", page: page, block: hero.id, path: "title", value: mm[1].trim() }], summary: "changed the headline" };
  }

  return null;   // nothing matched — the caller falls back to a full rebuild
}

/* ---- default props for a freshly-added block, per type ---- */
function defaultPropsFor(type, ctx) {
  const accent = (ctx.config.theme && ctx.config.theme.accentColor) || "#1aa6df";
  switch (type) {
    case "stats": return { accentColor: accent, items: [{ value: "100%", label: "committed to it" }, { value: "5★", label: "average rating" }, { value: "24h", label: "response time" }] };
    case "case-studies": return { title: "What people say", items: [{ title: "A happy customer", result: "", desc: "Great to work with, would recommend." }] };
    case "editorial-grid": return { title: "Gallery", subtitle: "", items: [] };
    case "steps": return { title: "How it works", items: [{ icon: "1", title: "Get in touch", desc: "", buttonLabel: "" }, { icon: "2", title: "We get to work", desc: "", buttonLabel: "" }, { icon: "3", title: "Done", desc: "", buttonLabel: "" }] };
    case "tracker": return { title: "Track your order", subtitle: "Enter the reference we sent you." };
    case "link-grid": return { title: "Where to find us", items: [] };
    case "quote-banner": return { quote: "Ask us anything.", bgColor: accent, textColor: "#ffffff", ctaLabel: "", ctaAction: "none", ctaTarget: "" };
    case "card-grid": return { title: "What we offer", subtitle: "", columns: 3, items: [] };
    case "rfq-form": return { title: "Get in touch", subtitle: "", perks: [], submitLabel: "Send message" };
    case "topbar": return { message: "Now open", ctaLabel: "", ctaAction: "none", ctaTarget: "" };
    default: return null;
  }
}

function titleCase(s) {
  return String(s || "").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { parse };
