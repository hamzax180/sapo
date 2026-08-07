#!/usr/bin/env node
/* =================================================================
   gen-block-schema.js — blocks.js  ➜  server/lib/block-schema.json
   -----------------------------------------------------------------
   The block registry (public/js/portals/blocks.js) is a browser IIFE
   that holds BOTH the editable `schema` of every block and its
   `render()`. The AI builder needs the schema half on the server: to
   describe the vocabulary to the model, and — far more importantly —
   to validate whatever the model sends back.

   Copying those schemas by hand would guarantee drift, so this script
   evaluates the real registry in a tiny `window` shim and writes out
   the serialisable half (type, label, category, defaultProps, schema).
   Render functions are deliberately dropped: the server never renders.

   Usage:
     node scripts/gen-block-schema.js          # write the file
     node scripts/gen-block-schema.js --check  # fail if it's stale (CI)
   ================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SOURCES = [
  path.join(ROOT, "public", "js", "portals", "blocks.js"),
  path.join(ROOT, "public", "js", "portals", "canvas-block.js")
];
const OUT = path.join(ROOT, "server", "lib", "block-schema.json");

/* ---- the smallest DOM-ish shim the registry needs to evaluate ---- */
function makeSandbox() {
  const noop = () => {};
  const el = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop, setAttribute: noop, getAttribute: () => null, addEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [], innerHTML: "", textContent: ""
  });
  const document = {
    createElement: el, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: el(), documentElement: el()
  };
  const window = { document, addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) };
  window.window = window;
  const sandbox = {
    window, document, console,
    navigator: { userAgent: "node" }, location: { hash: "", href: "" },
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    requestAnimationFrame: noop
  };
  return vm.createContext(sandbox);
}

function collect() {
  const ctx = makeSandbox();
  for (const src of SOURCES) {
    const code = fs.readFileSync(src, "utf8");
    vm.runInContext(code, ctx, { filename: path.relative(ROOT, src) });
  }
  const registry = ctx.window.PortalBlocks;
  if (!registry || typeof registry !== "object") {
    throw new Error("PortalBlocks was not populated — did blocks.js move?");
  }

  const blocks = {};
  Object.keys(registry).sort().forEach((type) => {
    const b = registry[type] || {};
    blocks[type] = {
      type,
      label: b.label || type,
      category: b.category || "Content",
      // `schema` drives the editor's property form; it is also the exact
      // allowlist the validator enforces on model output.
      schema: serialiseSchema(b.schema),
      defaultProps: JSON.parse(JSON.stringify(b.defaultProps || {}))
    };
  });

  return {
    generatedBy: "scripts/gen-block-schema.js",
    note: "GENERATED FILE — do not hand-edit. Run `npm run gen:schema` after changing blocks.js.",
    blockCount: Object.keys(blocks).length,
    blocks
  };
}

/* Keep only the declarative keys; drop anything function-valued. */
function serialiseSchema(schema) {
  if (!Array.isArray(schema)) return [];
  return schema.map((f) => {
    const out = { key: f.key, label: f.label || f.key, type: f.type || "text" };
    if (Array.isArray(f.options)) out.options = f.options.slice();
    if (Array.isArray(f.itemSchema)) out.itemSchema = serialiseSchema(f.itemSchema);
    if (typeof f.min === "number") out.min = f.min;
    if (typeof f.max === "number") out.max = f.max;
    return out;
  }).filter((f) => !!f.key);
}

/* ---------------------------------------------------------------- */
function main() {
  const data = collect();
  const json = JSON.stringify(data, null, 2) + "\n";
  const check = process.argv.includes("--check");

  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (current !== json) {
      console.error("✗ server/lib/block-schema.json is stale.");
      console.error("  blocks.js changed without regenerating. Run: npm run gen:schema");
      process.exit(1);
    }
    console.log("✓ block-schema.json is up to date (" + data.blockCount + " blocks)");
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log("✓ wrote " + path.relative(ROOT, OUT) + " (" + data.blockCount + " blocks)");
}

main();
