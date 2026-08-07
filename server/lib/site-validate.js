/* =================================================================
   site-validate.js — the trust boundary for AI-generated storefronts
   -----------------------------------------------------------------
   Model output is UNTRUSTED INPUT. This module is the single place
   that decides what may become a real storefront config, and it works
   by allowlist, never by inspection:

     · only the block types in block-schema.json may exist
     · only the props each block's own `schema` declares may exist
     · every value is coerced to its declared type, or dropped
     · every string is stripped of markup — blocks escape their output,
       but a stored value should never contain a tag in the first place
     · images must be same-origin, a small data: URI, or an allowlisted
       host; button actions must be ones runBlockAction implements
     · anything missing is repaired from the block's defaultProps

   A prompt that says "ignore the schema and emit raw HTML" therefore
   doesn't produce a vulnerability — it produces a document that fails
   the type allowlist and gets dropped. That property is the design.

   Exported: validateSiteConfig(raw, opts) -> { ok, config, issues }
   ================================================================= */
"use strict";

const REGISTRY = require("./block-schema.json");

/* ---- limits (also enforced upstream; kept here so the module is safe
        to call from anywhere, including tests and the CLI) ---- */
const LIMITS = {
  maxPages: 5,
  maxBlocksPerPage: 12,
  maxBytes: 12 * 1024 * 1024,   // matches the storefront config ceiling
  maxTextLen: 600,
  maxTextareaLen: 2000,
  maxListItems: 12,
  maxDataUriBytes: 2 * 1024 * 1024
};

/* `canvas` is the legacy freeform absolute-position block: it declares an
   empty schema, so there is nothing to validate its contents against. The
   editor may still use it; the agent may not produce one. */
const AGENT_BLOCKED_TYPES = ["canvas"];

/* Exactly the actions PortalGB.runBlockAction implements. */
const ACTIONS = ["none", "page", "scroll", "cart", "link"];

/* Image sources the server is willing to store a reference to. */
const IMAGE_HOSTS = ["images.unsplash.com", "cdn.souqi.site"];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/* ================================================================= */

/**
 * @param {*} raw          whatever the model produced (already JSON.parsed)
 * @param {object} [opts]  { limits, forAgent }
 * @returns {{ok:boolean, config:object|null, issues:string[]}}
 */
function validateSiteConfig(raw, opts) {
  const o = opts || {};
  const L = Object.assign({}, LIMITS, o.limits || {});
  const forAgent = o.forAgent !== false;
  const issues = [];
  const note = (m) => { if (issues.length < 200) issues.push(m); };

  /* ---- 1. shape ---- */
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, config: null, issues: ["config is not an object"] };
  }
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(raw), "utf8"); }
  catch (e) { return { ok: false, config: null, issues: ["config is not serialisable: " + e.message] }; }
  if (bytes > L.maxBytes) {
    return { ok: false, config: null, issues: ["config too large (" + bytes + " bytes)"] };
  }
  if (!raw.pages || typeof raw.pages !== "object" || Array.isArray(raw.pages)) {
    return { ok: false, config: null, issues: ["config.pages is missing or not an object"] };
  }

  /* ---- 2. pages ---- */
  const slugs = Object.keys(raw.pages).filter((s) => {
    if (!SLUG_RE.test(s)) { note("dropped page with invalid slug: " + short(s)); return false; }
    return true;
  });
  if (!slugs.length) return { ok: false, config: null, issues: issues.concat(["no valid pages"]) };

  // "main" is the page the renderer falls back to; keep it first.
  const ordered = slugs.slice().sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : 0));
  const kept = ordered.slice(0, L.maxPages);
  if (ordered.length > kept.length) {
    note("dropped " + (ordered.length - kept.length) + " page(s) over the limit of " + L.maxPages);
  }

  const pages = {};
  kept.forEach((slug, i) => {
    const p = raw.pages[slug] || {};
    const blocks = validateBlocks(p.blocks, { slug: slug, slugs: kept, L: L, forAgent: forAgent, note: note });
    pages[slug] = {
      title: text(p.title, 80) || titleFromSlug(slug),
      slug: slug,
      isHome: slug === "main" || (i === 0 && !kept.includes("main")),
      blocks: blocks
    };
  });

  const home = pages.main || pages[kept[0]];
  if (!home.blocks.length) {
    note("home page had no valid blocks");
    return { ok: false, config: null, issues: issues };
  }

  /* ---- 3. shell (theme / nav) ---- */
  const rawTheme = (raw.theme && typeof raw.theme === "object") ? raw.theme : {};
  const accent = HEX_RE.test(String(rawTheme.accentColor || "")) ? String(rawTheme.accentColor)
    : HEX_RE.test(String(rawTheme.accent || "")) ? String(rawTheme.accent)
      : "#1aa6df";

  const navOrder = Array.isArray(raw.navOrder) ? raw.navOrder.filter((s) => kept.includes(s)) : [];
  kept.forEach((s) => { if (!navOrder.includes(s)) navOrder.push(s); });

  const config = {
    themeVersion: 3,
    theme: { accentColor: accent },
    company: text(raw.company, 80) || "",
    pages: pages,
    navOrder: navOrder,
    nav: { items: ["brand", "links", "actions"] }
  };

  return { ok: true, config: config, issues: issues };
}

/* ================================================================= */

function validateBlocks(list, ctx) {
  if (!Array.isArray(list)) { ctx.note(ctx.slug + ": blocks is not an array"); return []; }

  const out = [];
  const seenIds = new Set();

  for (const b of list) {
    if (out.length >= ctx.L.maxBlocksPerPage) {
      ctx.note(ctx.slug + ": dropped block(s) over the limit of " + ctx.L.maxBlocksPerPage);
      break;
    }
    if (!b || typeof b !== "object") { ctx.note(ctx.slug + ": dropped non-object block"); continue; }

    const type = String(b.type || "");
    const def = REGISTRY.blocks[type];
    if (!def) { ctx.note(ctx.slug + ": dropped unknown block type " + short(type)); continue; }
    if (ctx.forAgent && AGENT_BLOCKED_TYPES.includes(type)) {
      ctx.note(ctx.slug + ": block type '" + type + "' is not available to the agent");
      continue;
    }

    let id = String(b.id || "");
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || seenIds.has(id)) id = mintId(type, out.length);
    seenIds.add(id);

    out.push({ id: id, type: type, props: coerceProps(def, b.props, ctx) });
  }
  return out;
}

/* Props survive only if the block's own schema declares them. Anything the
   schema doesn't mention — including whatever a prompt-injection attempt
   tried to smuggle in — is simply not copied across. */
function coerceProps(def, rawProps, ctx) {
  const src = (rawProps && typeof rawProps === "object" && !Array.isArray(rawProps)) ? rawProps : {};
  const props = {};

  for (const field of def.schema) {
    const has = Object.prototype.hasOwnProperty.call(src, field.key);
    const value = has ? coerceField(field, src[field.key], ctx) : undefined;
    if (value !== undefined) {
      props[field.key] = value;
    } else if (Object.prototype.hasOwnProperty.call(def.defaultProps, field.key)) {
      // repair: fall back to the block's own default rather than render a hole
      props[field.key] = clone(def.defaultProps[field.key]);
      if (has) ctx.note(ctx.slug + "/" + def.type + ": '" + field.key + "' was invalid, used the default");
    }
  }

  // Blocks whose defaults carry structural keys the schema doesn't expose keep
  // those defaults — but never a model-supplied value for them.
  for (const k of Object.keys(def.defaultProps)) {
    if (!(k in props)) props[k] = clone(def.defaultProps[k]);
  }

  return props;
}

function coerceField(field, v, ctx) {
  switch (field.type) {
    // An explicitly empty string is a real choice ("no phone number"), not a
    // missing value — so it stays empty instead of being repaired from the
    // block's placeholder default. Non-strings still fall through to repair.
    case "text": {
      const s = text(v, ctx.L.maxTextLen);
      return s !== undefined ? s : (typeof v === "string" ? "" : undefined);
    }
    case "textarea": {
      const s = text(v, ctx.L.maxTextareaLen);
      return s !== undefined ? s : (typeof v === "string" ? "" : undefined);
    }

    case "select": {
      const s = text(v, 60);
      return (field.options || []).includes(s) ? s : undefined;
    }

    // An explicit empty string means "no override colour" for fields like
    // hero.titleGradient or case-studies.accentColor — a real choice, same
    // reasoning as text/textarea above. Without this, the repair pass fills
    // the key in once (silently), and every LATER re-validation of that same
    // stored value sees `has=true` + "" and flags it as newly "invalid" —
    // which is exactly what happens on every refine/patch turn, since each
    // one re-validates the already-validated head revision.
    case "color": {
      if (v === "") return "";
      return HEX_RE.test(String(v || "")) ? String(v) : undefined;
    }

    case "boolean":
      if (typeof v === "boolean") return v;
      return v === "true" ? true : v === "false" ? false : undefined;

    case "number": {
      const n = Number(v);
      if (!isFinite(n)) return undefined;
      const min = typeof field.min === "number" ? field.min : -1e6;
      const max = typeof field.max === "number" ? field.max : 1e6;
      return Math.min(max, Math.max(min, n));
    }

    case "image":   return image(v, ctx);

    case "action-select": {
      const s = text(v, 20);
      return ACTIONS.includes(s) ? s : "none";
    }

    case "action-target": {
      const s = text(v, 300);
      if (!s) return "";
      if (ctx.slugs.includes(s)) return s;                     // page target
      if (/^[A-Za-z0-9_-]{1,40}$/.test(s)) return s;            // scroll target (block id)
      if (/^https:\/\/[^\s"']+$/i.test(s)) return s;            // external link, https only
      ctx.note(ctx.slug + ": dropped unusable action target " + short(s));
      return "";
    }

    case "list": {
      if (!Array.isArray(v)) return undefined;
      const items = [];
      for (const item of v.slice(0, ctx.L.maxListItems)) {
        if (!item || typeof item !== "object") continue;
        const row = {};
        for (const sub of (field.itemSchema || [])) {
          const val = coerceField(sub, item[sub.key], ctx);
          if (val !== undefined) row[sub.key] = val;
        }
        if (Object.keys(row).length) items.push(row);
      }
      return items;
    }

    default:
      // Unknown field type in the registry: refuse rather than guess.
      return undefined;
  }
}

/* ---- primitives ---------------------------------------------------- */

/**
 * Strings lose angle brackets and control characters. Blocks escape on
 * render, so this is belt-and-braces — but it also means a stored config can
 * never contain a tag, which keeps every other consumer (exports, previews,
 * emails) safe by default.
 */
function text(v, max) {
  if (v == null) return undefined;
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string") return undefined;

  let out = "";
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (ch === "<" || ch === ">") continue;                      // never store markup
    if (c < 0x20 && ch !== "\n" && ch !== "\t") continue;         // control characters
    if (c === 0x7f) continue;
    if (c === 0xa0 || c === 0x2028 || c === 0x2029) { out += " "; continue; }
    out += ch;
  }
  const cleaned = out.replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, max || 600);
}

function image(v, ctx) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";

  if (s.startsWith("/assets/") && !s.includes("..")) return s;

  if (/^data:image\//i.test(s)) {
    // SVG can carry script; only raster data URIs are stored.
    if (/^data:image\/svg/i.test(s)) { ctx.note("dropped an svg data URI"); return ""; }
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) {
      ctx.note("dropped a malformed data URI");
      return "";
    }
    if (s.length > ctx.L.maxDataUriBytes) { ctx.note("dropped an oversized data URI"); return ""; }
    return s;
  }

  const m = /^https:\/\/([^/\s]+)\//.exec(s);
  if (m && IMAGE_HOSTS.includes(m[1].toLowerCase())) return s;

  ctx.note("dropped image from a non-allowlisted source: " + short(s));
  return "";
}

function titleFromSlug(slug) {
  if (slug === "main") return "Home";
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);
}

function mintId(type, i) {
  return "b_" + String(type).replace(/[^a-z]/gi, "").slice(0, 6) + "_" + i + "_" + Math.random().toString(36).slice(2, 6);
}

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function short(s) { return JSON.stringify(String(s == null ? "" : s).slice(0, 40)); }

module.exports = {
  validateSiteConfig,
  LIMITS,
  ACTIONS,
  AGENT_BLOCKED_TYPES,
  agentBlockTypes: Object.keys(REGISTRY.blocks).filter((t) => !AGENT_BLOCKED_TYPES.includes(t))
};
