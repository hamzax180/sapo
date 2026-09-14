const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;

// esbuild/vite:  src/App.tsx:15:2: ERROR: Expected ";" but found "}"
//           or:      src/App.tsx:15:2:
const ESBUILD_RE = /^\s*(\S+\.[tj]sx?):(\d+):(\d+):\s*(?:ERROR:\s*)?(.*)$/;

/* Rollup, which is what `vite build` actually fails through, and which does
   NOT use file:line:col — so neither pattern above matches it:

     Could not resolve "../lib/payments" from "src/hooks/useCart.ts"

   That is the single most common way a generated app fails to build: the
   model imports a helper it then forgets to write. It produced no diagnostic
   at all, so the repair round was handed "no recognised diagnostic format
   was found" and had nothing to act on. */
const ROLLUP_RESOLVE_RE = /Could not resolve\s+["']([^"']+)["']\s+from\s+["']([^"']+)["']/;

function parseBuildErrors(output) {
  const lines = String(output || "").split("\n");
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let m = TSC_RE.exec(line);
    if (m) {
      errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
      continue;
    }

    m = ROLLUP_RESOLVE_RE.exec(line);
    if (m) {
      // m[2] is the importer — the file that actually has to change.
      errors.push({
        file: m[2], line: 0, col: 0, code: "UNRESOLVED_IMPORT",
        message: 'Could not resolve "' + m[1] + '". That file does not exist - either write it or drop the import.'
      });
      continue;
    }

    m = ESBUILD_RE.exec(line);
    if (m) {
      let message = m[4];
      if (!message) {
        const next = (lines[i + 1] || "").trim();
        if (next && !ESBUILD_RE.test(next)) message = next;
      }
      errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: "", message: message || "(see raw output)" });
    }
  }

  if (!errors.length) {
    errors.push({ file: "", line: 0, col: 0, code: "", message: "build failed but no recognised diagnostic format was found — see raw output" });
  }
  return errors;
}

export { parseBuildErrors };
