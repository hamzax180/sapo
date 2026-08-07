/* =================================================================
   composer.js — slots ➜ a real storefront config
   -----------------------------------------------------------------
   The four inputs that make two prompts produce two different sites:

     · ARCHETYPE   which blocks, in which order  (data/archetypes.json)
     · COPY        which sentence, filled with the visitor's own words
                                                (data/copy/<lang>.json)
     · PALETTE     an OKLCH ramp with AA contrast enforced
                                                (lib/design/palette.js)
     · PRODUCTS    plausible stock in the right currency
                                                (data/products/<lang>.json)

   Everything is seeded off the prompt, so the same sentence always
   rebuilds the same site while two different sentences diverge in
   structure, wording and colour at once.

   Output is a RAW config: it still goes through site-validate.js like
   any other producer. One trust boundary, no exceptions.
   ================================================================= */
"use strict";

const ARCH = require("../../data/archetypes.json");
const PRODUCTS = { en: require("../../data/products/en.json") };
const copy = require("./copy/engine");
const palette = require("./design/palette");

const INDUSTRIES = Object.keys(ARCH.byIndustry);

/* Blocks that only make sense where there is something to sell. */
const SELLS = ["retail", "fashion", "restaurant", "wholesale"];

/* ================================================================= */

/**
 * @param {string} prompt
 * @param {object} [hints] slots from server/lib/nlu
 * @returns {{config:object, meta:object}}
 */
function compose(prompt, hints) {
  const h = hints || {};
  const p = String(prompt || "").slice(0, 2000);

  const industry = INDUSTRIES.includes(h.industry) ? h.industry : "retail";
  const lang = PRODUCTS[h.lang] ? h.lang : "en";
  const tone = h.tone || "neutral";
  const features = Array.isArray(h.features) ? h.features : [];
  const seed = p.toLowerCase().replace(/\s+/g, " ").trim();

  const pal = palette.build({ seed: h.colour, industry: industry, tone: tone });
  // Track whether we were TOLD the name or invented one. The agent must not
  // claim "the business is called X" about a placeholder it made up itself.
  const namedByUser = !!h.company;
  const company = h.company || defaultName(industry, lang);
  const products = seedProducts(industry, lang, h.currency || "", seed);

  const ctx = {
    industry: industry, lang: lang, tone: tone, seed: seed,
    company: company, city: h.city || "", currency: h.currency || "",
    product: products.length ? products[0].name.split(" · ")[0] : ""
  };

  const archetypeKey = pickArchetype(industry, features, seed);
  const blockTypes = withInjections(ARCH.archetypes[archetypeKey].blocks, features);

  /* ---- home page ---- */
  const home = blockTypes.map((type, i) => buildBlock(type, ctx, pal, products, i)).filter(Boolean);

  const pages = { main: { title: "Home", slug: "main", isHome: true, blocks: home } };
  const navOrder = ["main"];

  /* ---- secondary pages ---- */
  const pageSpec = ARCH.pages[industry] || {};
  const sells = SELLS.includes(industry);

  if (sells && pageSpec.catalogue) {
    pages[pageSpec.catalogue] = {
      title: copy.line(ctx, "grid.title", "Products"),
      slug: pageSpec.catalogue, isHome: false,
      blocks: [buildBlock("product-grid", ctx, pal, products, 0), buildBlock("footer-rich", ctx, pal, products, 1)]
    };
    navOrder.push(pageSpec.catalogue);
  } else if (pageSpec.services) {
    pages[pageSpec.services] = {
      title: copy.line(ctx, "grid.title", "Services"),
      slug: pageSpec.services, isHome: false,
      blocks: [buildBlock("card-grid", ctx, pal, products, 0), buildBlock("footer-rich", ctx, pal, products, 1)]
    };
    navOrder.push(pageSpec.services);
  }

  if (pageSpec.contact) {
    pages.contact = {
      title: "Contact", slug: "contact", isHome: false,
      blocks: [buildBlock("rfq-form", ctx, pal, products, 0), buildBlock("footer-rich", ctx, pal, products, 1)]
    };
    navOrder.push("contact");
  }

  return {
    config: {
      themeVersion: 3,
      company: company,
      theme: { accentColor: pal.accent },
      pages: pages,
      navOrder: navOrder
    },
    meta: {
      industry: industry, company: company, namedByUser: namedByUser,
      accent: pal.accent, city: ctx.city,
      currency: ctx.currency, features: features, tone: tone, lang: lang,
      archetype: archetypeKey, archetypeLabel: ARCH.archetypes[archetypeKey].label,
      palettePassesAA: pal.passesAA, contrast: pal.contrast,
      productCount: products.length, source: "composer"
    }
  };
}

/* ---- structure ---------------------------------------------------- */

function pickArchetype(industry, features, seed) {
  const allowed = ARCH.byIndustry[industry] || ARCH.byIndustry.retail;

  // What the visitor actually asked for wins over the seeded pick.
  for (const f of features) {
    const preferred = ARCH.prefer[f];
    if (preferred && allowed.includes(preferred)) return preferred;
  }
  return allowed[copy.hash(seed + "|archetype") % allowed.length];
}

function withInjections(blocks, features) {
  const out = blocks.slice();
  for (const f of features) {
    const rule = ARCH.inject[f];
    if (!rule || out.includes(rule.type)) continue;
    const at = out.indexOf(rule.after);
    if (at < 0) continue;
    out.splice(at + 1, 0, rule.type);
  }
  return out;
}

/* ---- blocks -------------------------------------------------------- */

let seq = 0;
function id(type) {
  seq = (seq + 1) % 1e6;
  return "b_" + type.replace(/[^a-z]/g, "").slice(0, 6) + "_" + seq;
}

function buildBlock(type, ctx, pal, products, index) {
  const props = PROPS[type] ? PROPS[type](ctx, pal, products, index) : null;
  return props ? { id: id(type), type: type, props: props } : null;
}

const PROPS = {
  topbar: (c) => ({
    message: copy.line(c, "topbar", "Now open"), ctaLabel: "", ctaAction: "none", ctaTarget: ""
  }),

  hero: (c, pal) => ({
    eyebrow: copy.line(c, "hero.eyebrow", ""), eyebrowStyle: "badge",
    title: copy.line(c, "hero.title", "Welcome"),
    subtitle: copy.line(c, "hero.sub", ""),
    align: c.tone === "premium" ? "left" : "center",
    accentColor: pal.accent,
    buttons: [{ label: copy.line(c, "hero.cta", "See more"), action: "page", target: catalogueSlug(c) }]
  }),

  stats: (c, pal) => ({ accentColor: pal.accent, items: statsFor(c) }),

  steps: (c) => ({
    title: copy.line(c, "steps.title", "How it works"),
    items: copy.lines(c, "steps.item", 3).map((t, i) => ({ icon: String(i + 1), title: t, desc: "", buttonLabel: "" }))
  }),

  richtext: (c) => ({
    heading: copy.line(c, "story.heading", "About us"),
    body: copy.line(c, "story.body", "")
  }),

  "quote-banner": (c, pal) => ({
    quote: copy.line(c, "quote", ""),
    bgColor: pal.accent, textColor: pal.onAccent,
    ctaLabel: copy.line(c, "hero.cta", "See more"), ctaAction: "page", ctaTarget: catalogueSlug(c)
  }),

  "product-grid": (c) => ({
    title: copy.line(c, "grid.title", "Products"),
    subtitle: copy.line(c, "grid.sub", ""),
    showCatBar: true, limit: 12, ctaLabel: "", ctaAction: "none", ctaTarget: ""
  }),

  "card-grid": (c, pal, products) => ({
    title: copy.line(c, "grid.title", "What we do"),
    subtitle: copy.line(c, "grid.sub", ""),
    columns: 3,
    items: products.slice(0, 3).map((p) => ({
      icon: "", title: p.name, tag: p.priceLabel, desc: p.desc, color: pal.accent
    }))
  }),

  "case-studies": (c, pal, products) => ({
    title: copy.line(c, "grid.title", "Recent work"),
    items: products.slice(0, 3).map((p) => ({ title: p.name, result: p.priceLabel, desc: p.desc }))
  }),

  "editorial-grid": (c) => ({
    title: copy.line(c, "grid.title", "Gallery"),
    subtitle: copy.line(c, "grid.sub", ""),
    items: []
  }),

  "link-grid": (c) => ({ title: "Where to find us", items: [] }),

  tracker: (c) => ({ title: "Track your shipment", subtitle: "Enter the reference we sent you." }),

  "rfq-form": (c) => ({
    title: quoteLed(c.industry) ? "Request a quote" : "Get in touch",
    subtitle: "Tell us what you need and we'll come back the same working day.",
    perks: [{ value: "Same-day reply" }, { value: "No obligation" }, { value: "Priced in writing" }],
    submitLabel: quoteLed(c.industry) ? "Request quote" : "Send message"
  }),

  "footer-rich": (c, pal) => ({
    tagline: c.company,
    desc: copy.line(c, "footer.desc", ""),
    accentColor: pal.accent, bgColor: pal.dark,
    newsletter: true, newsletterTitle: "Stay in the loop", newsletterSub: "Occasional updates. No spam.",
    contactEmail: "hello@example.com", contactPhone: "", contactAddress: c.city || "",
    legal: "© " + new Date().getFullYear() + " " + c.company,
    socials: [], columns: []
  })
};

function catalogueSlug(c) {
  const spec = ARCH.pages[c.industry] || {};
  return spec.catalogue || spec.services || "contact";
}

function quoteLed(industry) {
  return ["logistics", "manufacturing", "construction"].includes(industry);
}

/* ---- data --------------------------------------------------------- */

function seedProducts(industry, lang, currency, seed) {
  const pool = (PRODUCTS[lang] || PRODUCTS.en)[industry] || [];
  if (!pool.length) return [];
  const start = copy.hash(seed + "|products") % pool.length;
  const take = 6;
  const out = [];
  for (let i = 0; i < Math.min(take, pool.length); i++) {
    const p = pool[(start + i) % pool.length];
    out.push({
      name: p.name,
      desc: p.desc,
      price: p.price,
      priceLabel: p.price ? (currency ? currency + " " + p.price.toLocaleString("en-US") : String(p.price)) : "Free"
    });
  }
  return out;
}

function statsFor(c) {
  const map = {
    restaurant:    [["6 days", "open every week"], ["30 min", "average delivery"], ["100%", "cooked to order"]],
    fashion:       [["4", "drops a year"], ["14 days", "free returns"], ["100%", "small-run made"]],
    logistics:     [["24/7", "shipment tracking"], ["3", "modes: road, sea, air"], ["1", "reference per job"]],
    manufacturing: [["±0.05mm", "tolerance held"], ["2 weeks", "typical lead time"], ["100%", "inspected before dispatch"]],
    construction:  [["12", "projects a year"], ["0", "surprise cost lines"], ["10 yr", "workmanship cover"]],
    wholesale:     [["500+", "lines in stock"], ["48h", "delivery window"], ["30 days", "account terms"]],
    services:      [["15 min", "booking slots"], ["6 days", "open every week"], ["1", "person looking after you"]],
    retail:        [["Same day", "dispatch"], ["500+", "products in stock"], ["14 days", "easy returns"]]
  };
  return (map[c.industry] || map.retail).map((r) => ({ value: r[0], label: r[1] }));
}

function defaultName(industry, lang) {
  const map = {
    restaurant: "The Kitchen", fashion: "The Collection", logistics: "Freight Co",
    manufacturing: "The Works", construction: "Build Co", wholesale: "Trade Supply",
    services: "The Studio", retail: "The Shop"
  };
  return map[industry] || "Your Business";
}

module.exports = { compose, INDUSTRIES, pickArchetype };
