/* =================================================================
   Souqi — structured HTTP errors + safe response envelope
   -----------------------------------------------------------------
   Handlers throw (or next()) an HttpError; the central error handler
   turns it into { error: { code, message, requestId } }. 5xx details
   are logged server-side keyed by requestId but never sent to clients,
   so internal messages (stack traces, DB errors) don't leak.
   ================================================================= */
"use strict";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = "HttpError";
    this.status = status || 500;
    this.code = code || (this.status >= 500 ? "internal_error" : "error");
    this.expose = this.status < 500; // safe to show the message to the client?
  }
}

function httpError(status, code, message) {
  return new HttpError(status, code, message);
}

/** Write a consistent error envelope. */
function sendError(res, err, requestId) {
  const status = (err && err.status) || 500;
  const code = (err && err.code) || (status >= 500 ? "internal_error" : "error");
  const expose = err instanceof HttpError ? err.expose : status < 500;
  const message = expose && err && err.message ? err.message : "Something went wrong";
  if (status >= 500) {
    // Server-side only — keep the real cause for debugging, tied to the id.
    console.error(`[${requestId || "-"}] ${code}:`, (err && err.stack) || err);
  }
  if (res.headersSent) return;
  res.status(status).json({ error: { code, message, requestId: requestId || null } });
}

/** Express error-handling middleware (must be registered LAST). */
function errorHandler(err, req, res, _next) {
  sendError(res, err, req && req.id);
}

module.exports = { HttpError, httpError, sendError, errorHandler };
