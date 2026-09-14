/* =================================================================
   scaffold-files.js — the scaffold as a {path: contents} map
   -----------------------------------------------------------------
   A generated project is the fixed scaffold with the model's files laid
   on top. The model is told not to touch the scaffold's own files —
   model-loop.js: "Do not write index.html, package.json, vite.config.ts,
   tailwind.config.js, or tsconfig.json — those are fixed and already
   correct" — and PROTECTED_PATHS enforces it. So a revision's file map
   holds only src/**, which is the model's half and not a buildable tree.

   The files come from scaffold-data.json, not from reading the scaffold
   directory, and that is the whole point of this file.

   On Vercel the directory cannot be trusted either way. Excluded in
   .vercelignore, it is absent from the deployment and every deployed app
   ships an index.html pointing at a /src/main.tsx that is not there.
   Included, the function bundler TRANSPILES it: App.tsx becomes App.js
   plus a source map, vite.config.ts becomes vite.config.js — and
   index.html still asks for main.tsx, which is now gone. Both fail, for
   opposite reasons. A .json file is neither compiled nor dropped, and a
   static require() is traced into the bundle.

   Regenerate after changing anything under scaffold/:
     node scripts/build-scaffold-data.js
   ================================================================= */
"use strict";

// Static require, so the bundler traces it. Do not make this dynamic.
const DATA = require("./scaffold-data.json");

/** Every scaffold file, keyed by its path relative to the project root. */
function readScaffold() {
  return DATA;
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
  const merged = Object.assign({}, DATA);
  for (const [p, content] of Object.entries(files || {})) merged[p] = content;
  return merged;
}

module.exports = { withScaffold, readScaffold };
