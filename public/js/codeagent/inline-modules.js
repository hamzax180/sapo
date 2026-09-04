/* =================================================================
   inline-modules.js — flatten a small ES module graph into one script
   -----------------------------------------------------------------
   The builder previews an app one of two ways. On a cross-origin
   isolated desktop it boots a WebContainer and runs the real Vite dev
   server, which handles any number of files. Everywhere else — every
   phone, and any browser without SharedArrayBuffer — it falls back to
   rendering into an iframe srcdoc with React and Babel from a CDN.

   That fallback used to inline src/App.tsx and nothing else, which is
   fine for a single-file app and useless for anything the model
   actually generates: a photography portfolio arrives as App.tsx plus
   six components. Its import statements survived into a plain inline
   <script>, and one surviving import is a hard parse error — "Cannot
   use import statement outside a module" — so nothing rendered at all.

   This walks the local import graph and concatenates every reachable
   module into one script, dependencies first. It is deliberately NOT a
   general bundler: it handles the shapes a React component file takes
   and reports what it could not do rather than guessing.

   Not supported, on purpose, and reported in `warnings`:
     - circular imports (the cycle is broken, order may be wrong)
     - two modules declaring the same top-level name
     - `export * from`, namespace imports, dynamic import()
   ================================================================= */
"use strict";

/** Extensions tried when an import has none, in resolution order. */
const EXTS = [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

/** Normalise "src/a/../b" to "src/b" so keys match `files`. */
function normalize(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Resolve a relative specifier against the importing file's directory.
 * Returns the matching key in `files`, or null when nothing matches —
 * a missing file is reported, never silently treated as empty.
 */
function resolve(spec, fromPath, files) {
  const dir = fromPath.indexOf("/") === -1 ? "" : fromPath.replace(/\/[^/]*$/, "");
  const base = normalize((dir ? dir + "/" : "") + spec);
  if (files[base] != null) return base;
  for (const ext of EXTS) {
    if (files[base + ext] != null) return base + ext;
  }
  return null;
}

/** Every top-level binding a module introduces, so collisions are visible. */
function declaredNames(code) {
  const names = new Set();
  const re = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return names;
}

/**
 * One module's source, rewritten to live in a shared top-level scope.
 *
 * `defaultName` comes back so the importer can bind its own local name
 * to it. React and lucide imports are not rewritten here — their names
 * are collected and emitted once in the prelude, because a per-module
 * `const { useState } = React` in every file is a redeclaration error
 * the moment there is more than one file.
 */
function transformModule(src, path, index, ctx) {
  let code = src;
  const localBindings = [];   // { local, from } — resolved after all modules are in

  // ---- type-only imports vanish; they have no runtime meaning ----
  code = code.replace(/import\s+type\s+[\s\S]*?from\s+['"][^'"]*['"];?/g, "");

  // ---- react ----
  code = code.replace(
    /import\s+(?:React\s*,?\s*)?(\{[\s\S]*?\})?\s*from\s+['"]react['"];?/g,
    (m, named) => {
      if (named) {
        named.replace(/[{}]/g, "").split(",").forEach((n) => {
          const t = n.trim().split(/\s+as\s+/)[0].trim();
          if (t) ctx.reactNames.add(t);
        });
      }
      return "";
    }
  );

  // ---- lucide-react ----
  code = code.replace(/import\s+\{([^}]*)\}\s+from\s+['"]lucide-react['"];?/g, (m, icons) => {
    icons.split(",").forEach((n) => {
      const t = n.trim().split(/\s+as\s+/)[0].trim();
      if (t) ctx.lucideNames.add(t);
    });
    return "";
  });

  // ---- local imports: recorded, then erased. The module they name is
  //      inlined above this one, so its bindings are already in scope. ----
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]*)['"];?/g, (m, clause, spec) => {
    const target = resolve(spec, path, ctx.files);
    if (!target) {
      ctx.warnings.push(path + ': cannot resolve "' + spec + '" — its bindings will be undefined');
      return "";
    }
    const c = clause.trim();
    if (/^\*\s+as\s+/.test(c)) {
      ctx.warnings.push(path + ": namespace import of " + spec + " is not supported");
      return "";
    }
    // default import, with or without a named list beside it
    const def = c.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*\{([\s\S]*)\})?$/);
    if (def) {
      localBindings.push({ local: def[1], target: target, kind: "default" });
      if (def[2]) aliasNamed(def[2], localBindings);
      return "";
    }
    const only = c.match(/^\{([\s\S]*)\}$/);
    if (only) { aliasNamed(only[1], localBindings); return ""; }
    return "";
  });

  // ---- side-effect imports of local files (e.g. "./index.css") ----
  code = code.replace(/import\s+['"][^'"]*['"];?/g, "");

  // ---- remaining bare-package imports cannot be satisfied ----
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+['"]([^.'"][^'"]*)['"];?/g, (m, clause, pkg) => {
    ctx.warnings.push(path + ": dropped import from \"" + pkg + "\" — not available in the CDN preview");
    return "";
  });

  // ---- exports ----
  let defaultName = null;

  // export default function Name / class Name  -> keep the declaration
  code = code.replace(
    /export\s+default\s+(async\s+)?(function|class)\s+([A-Za-z_$][\w$]*)/,
    (m, asy, kind, name) => { defaultName = name; return (asy || "") + kind + " " + name; }
  );

  if (!defaultName) {
    // export default <anything else> -> bind it to a synthetic name
    const synth = "__mod" + index + "_default";
    const before = code;
    code = code.replace(/export\s+default\s+/, "const " + synth + " = ");
    if (code !== before) defaultName = synth;
  }

  // `export default Name;` above became `const __modN_default = Name;`,
  // which is correct and needs nothing further.

  code = code.replace(/export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/g, "");
  code = code.replace(/export\s*\{[^}]*\}\s*;?/g, "");
  code = code.replace(/export\s+\*\s+from\s+['"][^'"]*['"];?/g, (m) => {
    ctx.warnings.push(path + ": `export * from` is not supported");
    return "";
  });

  return { code: code, defaultName: defaultName, localBindings: localBindings };
}

/** `A, B as C` -> alias entries; a plain name needs no binding at all. */
function aliasNamed(inner, out) {
  inner.split(",").forEach((n) => {
    const parts = n.trim().split(/\s+as\s+/);
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      out.push({ local: parts[1].trim(), source: parts[0].trim(), kind: "alias" });
    }
  });
}

/**
 * Flatten the graph reachable from `entry`.
 *
 * @param {string} entry  key into `files`, e.g. "src/App.tsx"
 * @param {Object<string,string>} files  every file the build produced
 * @returns {{code:string, modules:string[], warnings:string[]}}
 */
export function inlineModules(entry, files) {
  const ctx = {
    files: files,
    reactNames: new Set(),
    lucideNames: new Set(),
    warnings: []
  };

  const state = new Map();     // path -> "visiting" | "done"
  const pieces = [];
  const order = [];
  const defaults = new Map();  // path -> the name holding its default export
  const pending = [];          // { local, target, kind } to bind after everything is in
  const seenNames = new Set();
  let index = 0;

  function visit(path) {
    const s = state.get(path);
    if (s === "done") return;
    if (s === "visiting") {
      ctx.warnings.push("circular import involving " + path + " — module order may be wrong");
      return;
    }
    state.set(path, "visiting");

    const src = files[path];
    if (src == null) {
      ctx.warnings.push("missing file: " + path);
      state.set(path, "done");
      return;
    }

    // Dependencies first, so a component is defined before it is used.
    const deps = [];
    const re = /import\s+[\s\S]*?from\s+['"](\.[^'"]*)['"];?/g;
    let m;
    while ((m = re.exec(src))) {
      const t = resolve(m[1], path, files);
      if (t) deps.push(t);
    }
    deps.forEach(visit);

    const out = transformModule(src, path, index++, ctx);
    defaults.set(path, out.defaultName);

    declaredNames(out.code).forEach((n) => {
      if (seenNames.has(n)) {
        ctx.warnings.push('"' + n + '" is declared in more than one module — the later one wins');
      }
      seenNames.add(n);
    });

    out.localBindings.forEach((b) => pending.push(b));
    pieces.push("/* ---- " + path + " ---- */\n" + out.code.trim());
    order.push(path);
    state.set(path, "done");
  }

  visit(entry);

  // Bind each default import to whatever name its module ended up using.
  // Skipped when the names already match — the module declared `function
  // Header` and the importer called it `Header`, so re-declaring it would
  // be a redeclaration error rather than a binding.
  const aliases = [];
  pending.forEach((b) => {
    if (b.kind === "default") {
      const dn = defaults.get(b.target);
      if (!dn) {
        ctx.warnings.push(b.target + " has no default export, but " + b.local + " imports one");
      } else if (dn !== b.local && !seenNames.has(b.local)) {
        aliases.push("const " + b.local + " = " + dn + ";");
        seenNames.add(b.local);
      }
    } else if (b.kind === "alias" && !seenNames.has(b.local)) {
      aliases.push("const " + b.local + " = " + b.source + ";");
      seenNames.add(b.local);
    }
  });

  const prelude = [];
  if (ctx.reactNames.size) {
    prelude.push("const { " + Array.from(ctx.reactNames).join(", ") + " } = React;");
  }
  if (ctx.lucideNames.size) {
    prelude.push(
      "const { " + Array.from(ctx.lucideNames).join(", ") +
      " } = window.LucideReact || window.lucide || {};"
    );
  }

  return {
    code: prelude.concat(pieces, aliases).join("\n\n"),
    modules: order,
    warnings: ctx.warnings
  };
}

export default inlineModules;
