#!/usr/bin/env node
/* =================================================================
   build-scaffold-data.js — freeze the scaffold into a JSON blob
   -----------------------------------------------------------------
   The deploy path needs the scaffold's files at request time, and on
   Vercel it cannot simply read them off disk.

   Two things happen to that directory in a Vercel build, and they pull
   in opposite directions. Exclude it in .vercelignore and the files are
   not in the deployment at all, so a deployed app ships an index.html
   pointing at a /src/main.tsx that does not exist. Include it and the
   function bundler TRANSPILES what it finds: App.tsx becomes App.js
   plus a source map, main.tsx becomes main.js, vite.config.ts becomes
   vite.config.js — and index.html still points at main.tsx, which is
   now gone. Both ways the build dies, for opposite reasons.

   A .json file is neither: the bundler has no reason to compile it, and
   a static require() is traced into the bundle. So the scaffold ships
   as data rather than as source, the same shape wc-runtime.js already
   uses for the WebContainer.

   Run after changing anything under scaffold/:
     node scripts/build-scaffold-data.js
   ================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "server", "lib", "codeagent");
const SCAFFOLD_DIR = path.join(ROOT, "scaffold");
const OUT = path.join(ROOT, "scaffold-data.json");

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".cache", ".vite"]);

// Anything the Vercel bundler would rewrite, or that is build output
// rather than source. A .js.map beside a .tsx is the fingerprint of the
// exact problem this file exists to avoid, so refuse to bake one in.
const IGNORE_EXT = new Set([".map"]);

function walk(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(abs, rel, out);
    } else if (entry.isFile()) {
      if (IGNORE_EXT.has(path.extname(entry.name))) continue;
      out[rel] = fs.readFileSync(abs, "utf8");
    }
  }
}

const files = {};
walk(SCAFFOLD_DIR, "", files);

// A scaffold without these is not buildable, and shipping one produces a
// failure deep inside a Docker build on another machine. Fail here instead.
const REQUIRED = ["index.html", "package.json", "src/main.tsx", "vite.config.ts", "tsconfig.json"];
const missing = REQUIRED.filter((f) => files[f] === undefined);
if (missing.length) {
  console.error("refusing to write: the scaffold is missing " + missing.join(", "));
  process.exit(1);
}

const compiled = Object.keys(files).filter((f) => /\.(js|jsx)$/.test(f) && files[f.replace(/\.jsx?$/, ".tsx")] !== undefined);
if (compiled.length) {
  console.error("refusing to write: found compiled output beside sources — " + compiled.join(", "));
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(files, null, 2) + "\n");

const names = Object.keys(files).sort();
console.log("wrote " + path.relative(process.cwd(), OUT) + " — " + names.length + " files");
for (const n of names) console.log("  " + n);
