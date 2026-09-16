import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/* EVERY .html AT THE ROOT IS A PAGE.
 *
 * Discovered rather than declared, because the model cannot edit this file
 * — it is scaffold, and validateWriteFileArgs refuses it. A list here would
 * mean a new page could never be added without a scaffold release, which is
 * the same trap src/lib/payments.ts fell into: an import the prompt promised
 * and the container could not satisfy.
 *
 * So a multi-page site is written the way a site is written. The model
 * writes about.html and about.html is a page — real separate documents,
 * real <a href> between them, no router and no client-side history to get
 * wrong at the three different path prefixes this build gets served under.
 *
 * With only the scaffold's index.html present this resolves to exactly the
 * default Vite input, so a React single-page app builds as it always did.
 */
const root = process.cwd();   // NOT __dirname: package.json is type:module,
                              // so this file is ESM and __dirname is undefined.
                              // Vite runs with cwd at the project root.
const htmlPages = Object.fromEntries(
  fs.readdirSync(root)
    .filter((f) => f.endsWith(".html"))
    .map((f) => [path.basename(f, ".html"), path.resolve(root, f)])
);

export default defineConfig({
  plugins: [react()],
  server: { host: true, strictPort: true },
  build: { rollupOptions: { input: htmlPages } },
  // Relative asset paths ("./assets/x.js" instead of "/assets/x.js") — this
  // build gets served through Souqi's own proxy at an arbitrary per-project
  // path prefix (/api/codeagent/preview/<slug>/...), not from the origin
  // root. Root-relative paths would resolve against whatever origin the
  // browser thinks it's on, ignoring the prefix entirely — found live as a
  // 404 on every asset the moment the proxy went in. Relative paths resolve
  // correctly against the CURRENT document URL regardless of what prefix
  // it's served under, with no per-request HTML rewriting needed.
  base: "./"
});
