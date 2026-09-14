/* =================================================================
   codeagent/runtime.js — the seam Phase 1 plugs a real sandbox into
   -----------------------------------------------------------------
   Every runtime (local, E2B, Daytona, ...) implements the same five
   verbs. The seven tools in tools.js are written against THIS
   interface, never against a specific backend — so swapping the
   local dev runtime for a Firecracker microVM later is a one-file
   change, not a rewrite (docs/CODE-AGENT-PLAN.md §2, §5).

     create()                        -> workspace handle
     writeFile(ws, path, content)    -> void
     readFile(ws, path, from?, to?)  -> string
     listFiles(ws, dir?)             -> string[]      (relative paths)
     run(ws, argv, timeoutMs)        -> {code, stdout, stderr, timedOut}
     snapshot(ws)                    -> {files: [{path, sha256}], at}
     destroy(ws)                     -> void

   `run` takes an ARGV ARRAY, never a shell string — the allowlist in
   tools.js decides what commands exist at all, and passing argv means
   there is no shell to inject into even for an allowed command.

   Two OPTIONAL extended capabilities (Phase 5, docs/CODE-AGENT-PLAN.md §4),
   present when a runtime can actually back them — daytona-runtime.js has
   both, local-runtime.js has neither:

     startPreview(ws, timeoutMs)     -> {ok, url} | {ok:false, reason}
     domSnapshot(ws, url, timeoutMs) -> {ok, degraded, text, empty}

   tools.js's dom_snapshot tool checks for `runtime.domSnapshot` and uses
   it when present, falling back to the orchestrator-side Puppeteer path
   otherwise — the runtime, not the tool, decides how "does this route
   actually render" gets answered.
   ================================================================= */
"use strict";

/**
 * @typedef {object} Workspace
 * @property {string} id
 * @property {string} kind   "local" | "e2b" | "daytona" | ...
 */

const REGISTRY = {};

/** A runtime module registers itself here; kept separate from require()
    order so adding e2b-runtime.js later needs no change to this file. */
function registerRuntime(kind, impl) {
  REGISTRY[kind] = impl;
}

function createRuntime(kind) {
  const impl = REGISTRY[kind];
  if (!impl) {
    const known = Object.keys(REGISTRY);
    throw new Error(
      "no runtime registered for \"" + kind + "\"" +
      (known.length ? " (known: " + known.join(", ") + ")" : " (none registered yet)")
    );
  }
  return impl;
}

module.exports = { registerRuntime, createRuntime };
