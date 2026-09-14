/* =================================================================
   Souqi — secret encryption at rest (AES-256-GCM)
   -----------------------------------------------------------------
   Encrypts sensitive values (per-tenant DB connection strings) before
   they are stored in the master registry, so a dump of the workspaces
   collection never yields usable credentials.

   Envelope: "enc:v1:" + base64( iv[12] | tag[16] | ciphertext )

   Backward-compatible:
     • If DB_ENCRYPTION_KEY is unset (dev), values pass through in the
       clear (with a marker-aware decrypt that is a no-op on plaintext).
     • decryptSecret() returns non-enc: strings unchanged, so legacy
       plaintext rows keep working during migration.
   ================================================================= */
"use strict";
const crypto = require("crypto");
const MARKER = "enc:v1:";

function getKey() {
  const raw = (process.env.DB_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("DB_ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  return buf;
}

function encryptSecret(plain) {
  if (plain == null || plain === "") return plain;
  if (typeof plain === "string" && plain.startsWith(MARKER)) return plain; // already encrypted
  const key = getKey();
  if (!key) return plain; // no key configured — dev/passthrough
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptSecret(value) {
  if (typeof value !== "string" || !value.startsWith(MARKER)) return value; // plaintext/legacy
  const key = getKey();
  if (!key) throw new Error("DB_ENCRYPTION_KEY is required to decrypt a stored secret");
  const raw = Buffer.from(value.slice(MARKER.length), "base64");
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
