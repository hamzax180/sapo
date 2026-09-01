/* =================================================================
   secrets.js — project environment variables, encrypted at rest
   -----------------------------------------------------------------
   AES-256-GCM, same envelope shape the main app uses for tenant
   credentials. Two rules hold everywhere these values travel:

     - they are never selected into an API response;
     - they are never written to a log line, including error paths.

   A decrypted value exists only in the argv array handed to
   docker run, and only for the moment that call takes.
   ================================================================= */
"use strict";

const crypto = require("crypto");
const { cfg } = require("./config");

const MARKER = "enc:v1:";

function key() {
  if (!/^[0-9a-fA-F]{64}$/.test(cfg.secretKey)) {
    throw new Error("SECRET_KEY must be 64 hex characters — refusing to handle secrets without it");
  }
  return Buffer.from(cfg.secretKey, "hex");
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return MARKER + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function decrypt(value) {
  const s = String(value || "");
  if (!s.startsWith(MARKER)) throw new Error("not an encrypted value");
  const raw = Buffer.from(s.slice(MARKER.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/* Reserved names. A user setting PATH or LD_PRELOAD is either confused or
   probing; either way the platform sets these itself and a user value would
   change how the runtime resolves binaries inside the container. */
const RESERVED = new Set([
  "PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS",
  "PORT", "HOSTNAME", "PYTHONPATH"
]);

function validateKey(k) {
  const s = String(k || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s)) {
    return "must be letters, digits and underscores, starting with a letter";
  }
  if (RESERVED.has(s.toUpperCase())) return s + " is set by the platform and cannot be overridden";
  return null;
}

function validateValue(v) {
  const s = String(v == null ? "" : v);
  if (s.length > 4096) return "value is too long (max 4096 characters)";
  // A NUL would truncate the value where the container reads it, so what runs
  // would differ from what was saved.
  if (s.includes("\u0000")) return "value cannot contain a null byte";
  return null;
}

/** Masks a value for display. Never returns enough to reconstruct it. */
function mask(v) {
  const s = String(v || "");
  if (s.length <= 4) return "••••";
  return "••••" + s.slice(-4);
}

module.exports = { encrypt, decrypt, validateKey, validateValue, mask, RESERVED };
