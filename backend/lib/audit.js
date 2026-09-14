/* =================================================================
   Souqi — server-side audit trail (append-only, authoritative)
   -----------------------------------------------------------------
   Writes tamper-evident audit rows the CLIENT cannot forge, stamped
   with the correlation id, tenant, actor and a content hash. Used for
   the surfaces that have no client-side audit: guest portal actions
   (orders/inquiries) and owner-only admin actions (domain, storefront,
   export, erasure).

   Audit writes are best-effort: a failure here is logged but never
   breaks the primary operation.
   ================================================================= */
"use strict";
const crypto = require("crypto");
const { idForCollection } = require("./ids");

function hashOf(rec) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ a: rec.action, e: rec.entityId, t: rec.ts, w: rec.wsId, r: rec.requestId, actor: rec.actor }))
    .digest("hex")
    .slice(0, 32);
}

/** Append an audit row to a tenant's own DB (via the db adapter). */
async function writeAudit(dbAdapter, ws, entry) {
  try {
    const rec = {
      id: idForCollection("audit"),
      ts: new Date().toISOString(),
      requestId: entry.requestId || null,
      wsId: ws.workspaceId,
      actor: entry.actor || "system",
      action: entry.action,
      entity: entry.entity || null,
      entityId: entry.entityId || null,
      summary: entry.summary || "",
      source: "server"
    };
    if (entry.meta) rec.meta = entry.meta;
    rec.hash = hashOf(rec);
    await dbAdapter.insertOne(ws, "audit", rec);
    return rec;
  } catch (e) {
    console.error(`[${entry.requestId || "-"}] audit write failed:`, e.message);
    return null;
  }
}

/** Append a PLATFORM-level audit row to the master DB (survives tenant
 *  erasure — used to record the deletion itself). */
async function writeMasterAudit(masterDb, entry) {
  try {
    const rec = {
      id: idForCollection("audit"),
      ts: new Date().toISOString(),
      requestId: entry.requestId || null,
      wsId: entry.wsId || null,
      actor: entry.actor || "system",
      action: entry.action,
      entityId: entry.entityId || null,
      summary: entry.summary || "",
      source: "platform"
    };
    /* Same line writeAudit has had all along (see above), and its absence here
       was silently throwing away the only diagnostics this platform records.

       The code-agent build route computes rounds, repaired, fellBack, mode,
       provider and cost on every single build and passes them in as meta —
       and they died at this boundary. The effect was not "less detail in the
       logs": it was that no question about agent quality could be answered at
       all. What fraction of builds succeed, does a prompt change help, how
       often does a repair round save a build — every one of those needs a
       field that was computed and dropped right here.

       Before rec.hash, deliberately: the hash is the tamper-evidence for this
       row, so meta has to be inside what it covers rather than bolted on
       after. */
    if (entry.meta) rec.meta = entry.meta;
    rec.hash = hashOf(rec);
    await masterDb.collection("platform_audit").insertOne(rec);
    return rec;
  } catch (e) {
    console.error(`[${entry.requestId || "-"}] platform audit write failed:`, e.message);
    return null;
  }
}

module.exports = { writeAudit, writeMasterAudit };
