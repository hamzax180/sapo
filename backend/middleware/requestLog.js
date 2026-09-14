/* =================================================================
   Souqi — structured request logging + metrics tap
   -----------------------------------------------------------------
   Emits one JSON log line per request on completion, carrying the
   correlation id, tenant, actor, route, status and latency — so logs
   are queryable and every line ties back to a req_ id. Also feeds the
   in-process metrics counters.

   Set LOG_REQUESTS=0 to silence the per-request lines (metrics still
   recorded); useful in test runs.
   ================================================================= */
"use strict";
const metrics = require("../lib/metrics");

module.exports = function requestLog(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    metrics.record(res.statusCode, ms);
    if (process.env.LOG_REQUESTS === "0") return;
    const line = {
      t: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms,
      wsId: (req.session && req.session.wsId) || (req.ws && req.ws.workspaceId) || undefined,
      actor: (req.session && (req.session.email || req.session.id)) || undefined,
      ip: req.ip
    };
    try { console.log(JSON.stringify(line)); } catch (e) { /* logging must never throw */ }
  });
  next();
};
