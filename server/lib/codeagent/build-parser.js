/* =================================================================
   codeagent/build-parser.js — structured errors, not raw text
   -----------------------------------------------------------------
   `npm run build` runs `tsc --noEmit && vite build` (scaffold/package.
   json), so a failure is either a TypeScript diagnostic or an esbuild/
   Rollup bundle error. Both have a recognisable `file:line:col` shape;
   anything that doesn't match becomes one catch-all entry rather than
   being dropped — an unparsed error is still a build failure and the
   caller (a repair loop, eventually) needs to know that happened even
   without a clean file/line to point at.
   ================================================================= */
"use strict";

// tsc:    src/App.tsx(12,5): error TS2322: Type 'string' is not assignable...
const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;

// esbuild/vite:  src/App.tsx:15:2: ERROR: Expected ";" but found "}"
//           or:      src/App.tsx:15:2:
const ESBUILD_RE = /^\s*(\S+\.[tj]sx?):(\d+):(\d+):\s*(?:ERROR:\s*)?(.*)$/;

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

    m = ESBUILD_RE.exec(line);
    if (m) {
      // esbuild often puts the actual message on the NEXT non-empty line
      // when this line is just "file:line:col:" with nothing after it.
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

module.exports = { parseBuildErrors };
