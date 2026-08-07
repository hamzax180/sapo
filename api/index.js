/* =================================================================
   Vercel serverless entry point.

   Vercel turns each file under /api into a function. This one is a
   thin adapter: it require()s the SAME Express app the local server
   runs (server/index.js now exports it and only calls listen() when
   NOT on Vercel), so there is exactly one copy of the routing, auth
   and agent logic — not a serverless fork that drifts from the real
   one.

   Only /api/* is routed here (see vercel.json). Everything static —
   the marketing pages, code.html, assets — is served by Vercel's CDN
   directly out of public/, which is both faster and keeps this
   function's cold start small.
   ================================================================= */
module.exports = require("../server/index.js");
