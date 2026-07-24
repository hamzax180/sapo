/* =================================================================
   Souqi — in-process metrics (dependency-free)
   -----------------------------------------------------------------
   Lightweight counters for request volume, status classes, error rate
   and latency. Exposed via GET /metrics (gated by METRICS_TOKEN). For
   fleet-wide metrics, scrape this per instance or swap for a Prometheus
   client / OpenTelemetry exporter (see ARCHITECTURE-PLAN §11).
   ================================================================= */
"use strict";

const startedAt = Date.now();
const counters = { requests: 0, errors: 0, totalMs: 0, byStatus: {} };

function record(status, ms) {
  counters.requests++;
  const cls = Math.floor(status / 100) + "xx";
  counters.byStatus[cls] = (counters.byStatus[cls] || 0) + 1;
  if (status >= 500) counters.errors++;
  counters.totalMs += Number(ms) || 0;
}

function snapshot() {
  return {
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    requests: counters.requests,
    errors: counters.errors,
    errorRate: counters.requests ? Math.round((counters.errors / counters.requests) * 1000) / 1000 : 0,
    byStatus: counters.byStatus,
    avgMs: counters.requests ? Math.round((counters.totalMs / counters.requests) * 10) / 10 : 0,
    rssMB: Math.round(process.memoryUsage().rss / 1048576)
  };
}

module.exports = { record, snapshot };
