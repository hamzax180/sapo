/* =================================================================
   uploads-routes.js — sign, verify, and (in dev) serve
   -----------------------------------------------------------------
   Three routes, and the shape of them is dictated by one number: Vercel
   caps a serverless request body at about 4.5MB, which sits UNDER every
   express limit this app declares. Proxying a photo through the function
   would therefore fail at exactly the sizes people upload from a phone,
   and would burn function time doing it.

   So the bytes never touch us on the way in. /sign mints a presigned PUT
   and the browser uploads straight to the bucket; /complete then fetches
   back 256 bytes to check that what landed is what was promised.

   That split is also the security model. Between sign and complete the
   object is whatever the browser chose to send — a signed URL is a
   capability, not a guarantee — so a row stays "pending" and unusable
   until the bytes have been looked at. The client's declared MIME type is
   a hint; the magic bytes are the fact.

   Registered from index.js like any other route group, but kept in lib/
   rather than inlined there because index.js is already seven thousand
   lines and this is a self-contained feature with its own dependencies.
   ================================================================= */
"use strict";

const uploads = require("./uploads");
const s3 = require("./storage/s3");
const vision = require("./codeagent/vision");

/* Raised from the old 2MB because direct-to-bucket removed the reason for
   it — that cap existed to keep a base64 data URL inside a JSON request
   body. A modern phone photo is 3-6MB and should not be refused. */
const MAX_BYTES = Number(process.env.UPLOADS_MAX_BYTES) || 10 * 1024 * 1024;
const MAX_PER_MESSAGE = Number(process.env.UPLOADS_MAX_PER_MESSAGE) || 8;
const MONTHLY_PER_OWNER = Number(process.env.UPLOADS_MONTHLY_PER_OWNER) || 60;

/* SVG is deliberately absent, and it is the one exclusion worth explaining.
   As an <img src> it never executes — but the bucket is public-read so that
   published sites keep working without an expiring signature, which means
   anyone can NAVIGATE to the URL, and an SVG then runs as a document in the
   asset domain's origin. Allowing it would turn a bucket that hosts nothing
   else into an XSS surface. A PNG export is five seconds of work; a
   sanitiser that is actually correct is a day of it. */
const ALLOWED = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

/**
 * What the bytes actually are.
 *
 * The declared Content-Type is chosen by the uploader and signed into the
 * URL, which pins what the bucket will accept but says nothing about the
 * content. This is the check that a .png is a PNG.
 */
function sniff(buf) {
  if (!buf || buf.length < 12) return "";
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return "";
}

function monthStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * @param {object} app          express app
 * @param {object} deps
 * @param {function} deps.appOwnerOf   (req,res) -> {userId, anonId, email}
 * @param {function} deps.isAdminEmail (email) -> boolean
 * @param {function} [deps.limiter]    rate-limit middleware
 * @param {function} [deps.recordSpend] (owner, usd) -> void
 */
function register(app, deps) {
  const ownerOf = deps.appOwnerOf;
  const isAdmin = deps.isAdminEmail || (() => false);
  const limiter = deps.limiter || ((req, res, next) => next());

  /* ---- 1. mint a presigned PUT ------------------------------------ */
  app.post("/api/uploads/sign", limiter, async (req, res) => {
    /* Must run before anything writes a header — it sets the sq_anon
       cookie, which is the identity every later step checks against. */
    const owner = ownerOf(req, res);

    if (!s3.isConfigured()) {
      return res.status(503).json({ error: "Image uploads aren't set up on this server yet." });
    }

    const body = req.body || {};
    const type = String(body.type || "").toLowerCase();
    const ext = ALLOWED[type];
    if (!ext) {
      return res.status(415).json({
        error: "That file type isn't supported. Use a PNG, JPG, WebP or GIF."
      });
    }

    const bytes = Number(body.bytes) || 0;
    if (bytes > MAX_BYTES) {
      return res.status(413).json({
        error: "That image is " + Math.round(bytes / 1048576) + "MB — the limit is " +
          Math.round(MAX_BYTES / 1048576) + "MB."
      });
    }

    // Quota is a month of uploads per owner. Admins are exempt, same as builds.
    if (!isAdmin(owner.email)) {
      const used = await uploads.countSince(owner, monthStartIso());
      if (used >= MONTHLY_PER_OWNER) {
        return res.status(429).json({
          error: "You've uploaded " + used + " images this month, which is the limit."
        });
      }
    }

    const key = s3.newKey(ext);
    const row = await uploads.create({
      owner: owner,
      key: key,
      url: s3.publicUrl(key),
      name: String(body.name || "image." + ext),
      mime: type,
      ext: ext,
      bytes: bytes,
      width: Number(body.width) || 0,
      height: Number(body.height) || 0,
      seedHex: String(body.seedHex || "")
    });

    res.json({
      id: row.id,
      putUrl: s3.presignPut(key, { contentType: type, expiresSec: 300 }),
      // The browser must send exactly this: content-type is signed, so a
      // mismatch is rejected by the bucket rather than by us.
      headers: { "Content-Type": type },
      expiresIn: 300
    });
  });

  /* ---- 2. verify what landed -------------------------------------- */
  app.post("/api/uploads/:id/complete", limiter, async (req, res) => {
    const owner = ownerOf(req, res);
    const row = await uploads.get(String(req.params.id || ""));
    if (!row || !uploads.owns(row, owner)) return res.status(404).json({ error: "not found" });
    if (row.status === "ready") {
      // Idempotent: a retried completion returns the same answer rather than
      // paying for a second description of the same image.
      return res.json({ id: row.id, url: row.url, description: row.description });
    }

    /* 256 bytes, not the whole object. Enough for every signature we check,
       and it keeps a 10MB photo from crossing the function to answer a
       question about its first twelve bytes. */
    let head, sniffed = "", realBytes = 0;
    try {
      head = await s3.signedFetch("GET", row.key, null, { range: "bytes=0-255" });
      if (!head.ok && head.status !== 206) throw new Error("range GET " + head.status);
      const buf = Buffer.from(await head.arrayBuffer());
      sniffed = sniff(buf);

      const meta = await s3.signedFetch("HEAD", row.key);
      realBytes = Number(meta.headers.get("content-length")) || 0;
    } catch (e) {
      await uploads.markFailed(row.id, "could not read back: " + e.message);
      return res.status(502).json({ error: "The upload didn't finish. Try again." });
    }

    /* The two ways a signed URL gets abused: send something that is not an
       image at all, or send an image of a different type than was signed
       for. Both end the same way — the object is removed, because leaving
       unverified content in a public bucket is the actual risk. */
    if (!sniffed || sniffed !== row.mime) {
      await s3.deleteObject(row.key);
      await uploads.markFailed(row.id, "content is " + (sniffed || "unrecognised") + ", not " + row.mime);
      return res.status(415).json({ error: "That file isn't the image type it claimed to be." });
    }
    if (realBytes > MAX_BYTES) {
      await s3.deleteObject(row.key);
      await uploads.markFailed(row.id, "oversize: " + realBytes);
      return res.status(413).json({ error: "That image is over the size limit." });
    }

    await uploads.markReady(row.id, {
      bytes: realBytes, mime: sniffed, width: row.width, height: row.height
    });

    /* Describe it now, once, while the person is still looking at a
       spinner — not at build time, where it would be paid again on every
       edit and would add latency to the thing they are waiting for. */
    let description = "";
    if (vision.available()) {
      try {
        const whole = await s3.signedFetch("GET", row.key);
        if (whole.ok) {
          const seen = await vision.describe(Buffer.from(await whole.arrayBuffer()), sniffed);
          if (seen) {
            description = seen.description;
            await uploads.setDescription(row.id, seen.description, seen.costUsd);
            if (deps.recordSpend) { try { deps.recordSpend(owner, seen.costUsd); } catch (e) {} }
          }
        }
      } catch (e) { /* soft: an undescribed image is still a usable image */ }
    }
    // Records that we asked, so a failure is not retried on every turn.
    if (!description) await uploads.setDescription(row.id, "", 0);

    res.json({ id: row.id, url: row.url, description: description });
  });

  /* ---- 3. serve, when there is no CDN in front of the bucket ------- */
  if (!process.env.S3_PUBLIC_BASE_URL) {
    /* Registered ONLY as a fallback, and it is the local-development path.
       In production every view here is a function invocation, which is why
       publicUrl() prefers a real domain — and why that domain must be ours
       and not the provider's, since these URLs are baked permanently into
       published customer source. */
    app.get("/api/img/*", async (req, res) => {
      const key = String(req.params[0] || "");
      if (!/^u\/[0-9a-f]{32}\.[a-z0-9]{1,5}$/.test(key)) return res.status(404).end();
      try {
        const got = await s3.signedFetch("GET", key);
        if (!got.ok) return res.status(404).end();
        res.set("Content-Type", got.headers.get("content-type") || "application/octet-stream");
        // Immutable: the key contains 128 bits of randomness and an object
        // is never rewritten under the same one.
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        res.set("X-Content-Type-Options", "nosniff");
        res.send(Buffer.from(await got.arrayBuffer()));
      } catch (e) { res.status(502).end(); }
    });
  }
}

module.exports = { register, sniff, ALLOWED, MAX_BYTES, MAX_PER_MESSAGE, MONTHLY_PER_OWNER };
