/* =================================================================
   scaffold-files.js — the scaffold as a {path: contents} map
   -----------------------------------------------------------------
   A generated project is the fixed scaffold with the model's files laid
   on top. The model is told not to touch the scaffold's own files —
   model-loop.js: "Do not write index.html, package.json, vite.config.ts,
   tailwind.config.js, or tsconfig.json — those are fixed and already
   correct" — and PROTECTED_PATHS enforces it. So a revision's file map
   holds only src/**, which is the model's half of the project and not a
   buildable tree on its own.

   Every consumer so far reassembled the two halves for itself. The
   WebContainer mounts the scaffold and writes the model's files over it;
   the runtimes copyDir() the scaffold into a workspace. The deploy plane
   was the one caller that got only the model's half, so it received a
   source tree with no package.json and no index.html and answered "could
   not work out how to build this project" — correctly, because there was
   nothing there to build.

   Read once and cached: the scaffold is fixed at deploy time and this is
   on the request path.
   ================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const SCAFFOLD_DIR = path.join(__dirname, "scaffold");

// Build artefacts and dependencies are produced ON the target, never
// shipped to it. node_modules in particular would be both wrong and
// enormous.
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".cache", ".vite"]);

let cache = null;

/** Every file under the scaffold, keyed by its path relative to the root. */
function readScaffold() {
  if (cache) return cache;

  const out = {};
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;                       // no scaffold on disk: caller still gets the model's files
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          out[rel] = fs.readFileSync(abs, "utf8");
        } catch (e) { /* unreadable file is not worth failing a deploy over */ }
      }
    }
  };
  walk(SCAFFOLD_DIR, "");
  cache = out;
  return out;
}

/**
 * The complete source tree for a project: scaffold underneath, the
 * model's files on top.
 *
 * The model's half wins on a collision, which matters for src/App.tsx —
 * the scaffold ships a placeholder one and the generated app replaces it.
 * That is the same precedence the WebContainer gets by mounting the
 * scaffold first and writing over it.
 */
function withScaffold(files) {
  const merged = Object.assign({}, readScaffold());
  for (const [p, content] of Object.entries(files || {})) merged[p] = content;
  return merged;
}

/** Testing seam: forget the cached read. */
function _reset() { cache = null; }

module.exports = { withScaffold, readScaffold, SCAFFOLD_DIR, _reset };
