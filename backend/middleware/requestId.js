/* =================================================================
   Souqi — request correlation id
   -----------------------------------------------------------------
   Assigns every HTTP request a unique `req_...` id (honouring a valid
   inbound X-Request-Id from the edge/CDN if present), attaches it to
   `req.id`, and echoes it back as the X-Request-Id response header.

   Every log line and every audit row created while handling a request
   is stamped with this id, so a record can always be traced back to
   the exact call — and the reply — that produced it.
   ================================================================= */
"use strict";
const { newRequestId, isValidId } = require("../lib/ids");

module.exports = function requestId(req, res, next) {
  const inbound = req.headers["x-request-id"];
  req.id = (typeof inbound === "string" && isValidId(inbound, "req")) ? inbound : newRequestId();
  res.setHeader("X-Request-Id", req.id);
  next();
};
