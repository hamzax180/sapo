/* =================================================================
   refine/apply.js — six ops, applied to a config
   -----------------------------------------------------------------
   The whole point of "edit, don't rebuild" (docs/AGENT-PARITY-PLAN.md
   §4): a follow-up patches the EXISTING config instead of regenerating
   it, so "make it darker" doesn't throw away the wording changes from
   three turns ago.

   This module only ever produces a RAW config — the same as any other
   producer — and the caller runs it through site-validate.js exactly
   like a fresh build. That means a malformed op (a typo'd block id, an
   out-of-range move) degrades to "nothing happened" rather than a
   corrupt page, because the validator's repair pass has the last word
   either way.
   ================================================================= */
"use strict";

const crypto = require("crypto");

const OPS = ["setProp", "addBlock", "removeBlock", "moveBlock", "setTheme", "addPage"];

function mintId(type) {
  return "b_" + String(type).replace(/[^a-z]/gi, "").slice(0, 6) + "_" + crypto.randomBytes(3).toString("hex");
}

function getPath(obj, path) {
  return String(path || "").split(".").filter(Boolean).reduce((o, k) => (o === null || o === undefined ? o : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = String(path || "").split(".").filter(Boolean);
  if (!keys.length) return;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] == null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * @param {object} config   a validated storefrontConfig (the head revision)
 * @param {object[]} ops    up to a handful of ops from refine/grammar.js
 * @returns {{config:object, changed:boolean, touched:string[]}}
 *   `changed` is false if every op was a no-op (e.g. removing a block that
 *   isn't there) — the caller uses that to avoid storing a no-op revision.
 */
function applyOps(config, ops) {
  const next = JSON.parse(JSON.stringify(config || {}));
  next.pages = next.pages || {};
  const touched = [];

  for (const op of ops || []) {
    if (!op || OPS.indexOf(op.op) < 0) continue;

    if (op.op === "setTheme") {
      next.theme = next.theme || {};
      const before = getPath(next.theme, op.path);
      setPath(next.theme, op.path, op.value);
      if (before !== op.value) touched.push("theme." + op.path);
      continue;
    }

    if (op.op === "addPage") {
      if (next.pages[op.slug]) continue;               // already exists — no-op, not an error
      next.pages[op.slug] = {
        title: op.title || op.slug, slug: op.slug, isHome: false,
        blocks: (op.blocks || []).map((b) => ({ id: mintId(b.type), type: b.type, props: b.props || {} }))
      };
      next.navOrder = (Array.isArray(next.navOrder) ? next.navOrder : Object.keys(next.pages)).concat([op.slug]);
      touched.push("page:" + op.slug);
      continue;
    }

    const page = next.pages[op.page];
    if (!page || !Array.isArray(page.blocks)) continue;

    if (op.op === "setProp") {
      const block = page.blocks.find((b) => b.id === op.block);
      if (!block) continue;
      block.props = block.props || {};
      const before = getPath(block.props, op.path);
      if (before === op.value) continue;
      setPath(block.props, op.path, op.value);
      touched.push("block:" + op.block + "." + op.path);
      continue;
    }

    if (op.op === "addBlock") {
      if (!op.block || !op.block.type) continue;
      const blk = { id: mintId(op.block.type), type: op.block.type, props: op.block.props || {} };
      const at = typeof op.at === "number" ? Math.max(0, Math.min(op.at, page.blocks.length)) : page.blocks.length;
      page.blocks.splice(at, 0, blk);
      touched.push("addBlock:" + op.block.type);
      continue;
    }

    if (op.op === "removeBlock") {
      const before = page.blocks.length;
      page.blocks = page.blocks.filter((b) => b.id !== op.block);
      if (page.blocks.length !== before) touched.push("removeBlock:" + op.block);
      continue;
    }

    if (op.op === "moveBlock") {
      const idx = page.blocks.findIndex((b) => b.id === op.block);
      if (idx < 0) continue;
      const to = Math.max(0, Math.min(typeof op.to === "number" ? op.to : idx, page.blocks.length - 1));
      if (to === idx) continue;
      const [blk] = page.blocks.splice(idx, 1);
      page.blocks.splice(to, 0, blk);
      touched.push("moveBlock:" + op.block);
      continue;
    }
  }

  return { config: next, changed: touched.length > 0, touched: touched };
}

module.exports = { applyOps, OPS };
