/* =================================================================
   storage/objects.js — source archives in S3-compatible storage
   -----------------------------------------------------------------
   The spec is blunt about this: "do not permanently store application
   source code only on the VM". Until now that is exactly what happened
   — the upload landed in BUILD_ROOT and nowhere else, so losing the box
   lost every customer's source, and scripts/backup.sh only ever covered
   Postgres.

   Signed with SigV4 by hand rather than pulling in an SDK. The AWS SDK
   is ~20MB of dependency for four HTTP verbs against one bucket, and it
   is a supply-chain surface on the one service that holds customer
   source. Node's crypto does HMAC; that is the whole algorithm.

   Works against anything S3-compatible — R2, S3, MinIO, Spaces —
   because it only uses path-style addressing and the four verbs.

   NOT configured is a normal state, not an error: isConfigured() is
   false when S3_BUCKET is unset, and every caller falls back to the
   local build directory. That keeps a laptop working while making the
   production gap explicit (preflight warns about it).
   ================================================================= */
"use strict";

const crypto = require("crypto");
const zlib = require("zlib");
const { cfg } = require("../config");

const REGION = process.env.S3_REGION || "auto";
const SERVICE = "s3";

function isConfigured() {
  const s = cfg.s3;
  return !!(s.endpoint && s.bucket && s.accessKey && s.secretKey);
}

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const hmac = (key, v) => crypto.createHmac("sha256", key).update(v).digest();

/** Everything after the host, percent-encoded the way SigV4 wants. */
function encodeKey(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

/**
 * One signed request.
 *
 * The payload hash is always the real hash rather than UNSIGNED-PAYLOAD:
 * it costs one pass over a few hundred KB and means a corrupted body is
 * rejected by the store instead of silently accepted.
 */
async function signedFetch(method, key, body) {
  const s = cfg.s3;
  const base = s.endpoint.replace(/\/+$/, "");
  const url = new URL(base + "/" + s.bucket + "/" + encodeKey(key));

  const payload = body || Buffer.alloc(0);
  const payloadHash = sha256(payload);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   // 20260902T041500Z
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (body) headers["content-type"] = "application/octet-stream";

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => h + ":" + headers[h] + "\n").join("");

  const canonicalRequest = [
    method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash
  ].join("\n");

  const scope = [dateStamp, REGION, SERVICE, "aws4_request"].join("/");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  let k = hmac("AWS4" + s.secretKey, dateStamp);
  k = hmac(k, REGION); k = hmac(k, SERVICE); k = hmac(k, "aws4_request");
  const signature = crypto.createHmac("sha256", k).update(toSign).digest("hex");

  headers.authorization = "AWS4-HMAC-SHA256 Credential=" + s.accessKey + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

  return fetch(url.toString(), {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(60000)
  });
}

/* ---------- the shape we store ----------
   The source is already a {path: contents} map, so it is stored as one
   gzipped JSON object. No tar, no archive format to get wrong, and it
   round-trips byte-for-byte into the same map the build reads. */

const keyFor = (deploymentId) => "sources/" + String(deploymentId).replace(/[^a-zA-Z0-9_.-]/g, "") + ".json.gz";

async function putSource(deploymentId, files) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(files), "utf8"));
  const key = keyFor(deploymentId);
  try {
    const res = await signedFetch("PUT", key, body);
    if (!res.ok) {
      return { ok: false, error: "storage rejected the upload (" + res.status + ")" };
    }
    return { ok: true, key, bytes: body.length };
  } catch (e) {
    return { ok: false, error: "storage unreachable: " + e.message };
  }
}

async function getSource(key) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const res = await signedFetch("GET", key);
    if (!res.ok) return { ok: false, error: "storage returned " + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, files: JSON.parse(zlib.gunzipSync(buf).toString("utf8")) };
  } catch (e) {
    return { ok: false, error: "could not read the archive: " + e.message };
  }
}

async function deleteSource(key) {
  if (!isConfigured() || !key) return { ok: false, skipped: true };
  try {
    const res = await signedFetch("DELETE", key);
    // 404 is success for a delete: the object is gone either way.
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { isConfigured, keyFor, putSource, getSource, deleteSource, signedFetch };
