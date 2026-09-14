/* =================================================================
   The upload routes, with storage and vision stubbed.

   The interesting half is the completion check, because that is the actual
   security boundary: between /sign and /complete the object is whatever the
   browser chose to PUT, so everything downstream depends on this step
   refusing what does not match. A signed URL is a capability, not a promise.

   Run: node server/uploads-routes-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const Module = require("module");
const path = require("path");

/* ---- stubs, injected before the routes module loads ---------------- */
const store = { objects: new Map(), deleted: [] };
let visionResult = { description: "A warm-lit cafe interior.", costUsd: 0.001 };
let visionUp = true;

const s3Stub = {
  isConfigured: () => true,
  newKey: (ext) => "u/" + "a".repeat(32) + "." + ext,
  publicUrl: (k) => "https://cdn.test/" + k,
  presignPut: (k, o) => "https://bucket.test/" + k + "?sig=1&ct=" + encodeURIComponent(o.contentType),
  deleteObject: async (k) => { store.deleted.push(k); store.objects.delete(k); return { ok: true }; },
  signedFetch: async (method, key, body, opts) => {
    const buf = store.objects.get(key);
    if (!buf) return { ok: false, status: 404, headers: new Map() };
    if (method === "HEAD") {
      return { ok: true, status: 200, headers: { get: (h) => h === "content-length" ? String(buf.length) : null } };
    }
    const sliced = opts && opts.range ? buf.subarray(0, 256) : buf;
    return {
      ok: true, status: opts && opts.range ? 206 : 200,
      headers: { get: (h) => h === "content-type" ? "image/png" : null },
      arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength)
    };
  }
};
const visionStub = {
  available: () => visionUp,
  describe: async () => visionResult
};

const realResolve = Module._resolveFilename;
const S3 = path.join(__dirname, "..", "lib", "storage", "s3.js");
const VIS = path.join(__dirname, "..", "lib", "codeagent", "vision.js");
require.cache[S3] = { id: S3, filename: S3, loaded: true, exports: s3Stub };
require.cache[VIS] = { id: VIS, filename: VIS, loaded: true, exports: visionStub };

const uploads = require("../lib/uploads");
uploads.init({ getMasterDb: () => null });
const routes = require("../lib/uploads-routes");

/* ---- a tiny express double ----------------------------------------- */
function makeApp() {
  const handlers = {};
  const app = {
    post: (p, ...rest) => { handlers["POST " + p] = rest[rest.length - 1]; },
    get: (p, ...rest) => { handlers["GET " + p] = rest[rest.length - 1]; }
  };
  app.call = async (key, req) => {
    let code = 200, payload = null;
    const res = {
      status(c) { code = c; return this; },
      json(o) { payload = o; return this; },
      set() { return this; }, send(b) { payload = b; return this; }, end() { return this; }
    };
    await handlers[key](req, res);
    return { code, body: payload };
  };
  return app;
}

const OWNER = { anonId: "anon-1", userId: null, email: "a@b.c" };
const app = makeApp();
routes.register(app, { appOwnerOf: () => OWNER, isAdminEmail: () => false });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>" + "x".repeat(40));

let passed = 0;
async function ok(name, fn) {
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

const sign = (body) => app.call("POST /api/uploads/sign", { body: body });
const complete = (id) => app.call("POST /api/uploads/:id/complete", { params: { id: id } });

(async () => {
  console.log("\nsigning");

  await ok("returns a presigned PUT that pins the content type", async () => {
    const r = await sign({ name: "a.png", type: "image/png", bytes: 1000 });
    assert.strictEqual(r.code, 200);
    assert.match(r.body.id, /^img_/);
    assert.ok(r.body.putUrl.includes("image%2Fpng"), "content-type must be signed in");
    assert.strictEqual(r.body.headers["Content-Type"], "image/png");
  });

  await ok("refuses SVG — a public bucket makes it an XSS surface", async () => {
    const r = await sign({ name: "logo.svg", type: "image/svg+xml", bytes: 500 });
    assert.strictEqual(r.code, 415);
    assert.match(r.body.error, /PNG, JPG, WebP or GIF/);
  });

  await ok("refuses a non-image outright", async () => {
    assert.strictEqual((await sign({ name: "x.pdf", type: "application/pdf", bytes: 10 })).code, 415);
  });

  await ok("refuses oversize before a byte is uploaded", async () => {
    const r = await sign({ name: "big.jpg", type: "image/jpeg", bytes: 40 * 1024 * 1024 });
    assert.strictEqual(r.code, 413);
    assert.match(r.body.error, /40MB/);
  });

  console.log("\ncompletion — the security boundary");

  await ok("accepts an image that is what it claimed", async () => {
    const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
    store.objects.set("u/" + "a".repeat(32) + ".png", PNG);
    const r = await complete(s.body.id);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.url, "https://cdn.test/u/" + "a".repeat(32) + ".png");
    assert.strictEqual((await uploads.get(s.body.id)).status, "ready");
  });

  await ok("HTML renamed .png is rejected AND deleted from the bucket", async () => {
    store.deleted.length = 0;
    const s = await sign({ name: "evil.png", type: "image/png", bytes: HTML.length });
    const key = "u/" + "a".repeat(32) + ".png";
    store.objects.set(key, HTML);
    const r = await complete(s.body.id);
    assert.strictEqual(r.code, 415);
    assert.ok(store.deleted.includes(key), "unverified content must not stay in a public bucket");
    assert.strictEqual((await uploads.get(s.body.id)).status, "failed");
  });

  await ok("a real image of the WRONG type is also rejected", async () => {
    store.deleted.length = 0;
    const s = await sign({ name: "a.png", type: "image/png", bytes: JPEG.length });
    store.objects.set("u/" + "a".repeat(32) + ".png", JPEG);   // signed png, sent jpeg
    const r = await complete(s.body.id);
    assert.strictEqual(r.code, 415);
    assert.strictEqual(store.deleted.length, 1);
  });

  await ok("an object that never arrived fails cleanly", async () => {
    const s = await sign({ name: "a.png", type: "image/png", bytes: 10 });
    store.objects.delete("u/" + "a".repeat(32) + ".png");
    const r = await complete(s.body.id);
    assert.strictEqual(r.code, 502);
    assert.strictEqual((await uploads.get(s.body.id)).status, "failed");
  });

  await ok("someone else's id is a 404, not a 403 that confirms it exists", async () => {
    const s = await sign({ name: "a.png", type: "image/png", bytes: 10 });
    const other = makeApp();
    routes.register(other, { appOwnerOf: () => ({ anonId: "anon-2" }), isAdminEmail: () => false });
    const r = await other.call("POST /api/uploads/:id/complete", { params: { id: s.body.id } });
    assert.strictEqual(r.code, 404);
  });

  console.log("\ndescription");

  await ok("caches what vision saw", async () => {
    visionUp = true;
    const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
    store.objects.set("u/" + "a".repeat(32) + ".png", PNG);
    const r = await complete(s.body.id);
    assert.match(r.body.description, /cafe interior/);
    assert.match((await uploads.get(s.body.id)).description, /cafe interior/);
  });

  await ok("no vision is not a failed upload", async () => {
    visionUp = false;
    const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
    store.objects.set("u/" + "a".repeat(32) + ".png", PNG);
    const r = await complete(s.body.id);
    assert.strictEqual(r.code, 200, "an undescribed image is still a usable image");
    assert.strictEqual(r.body.description, "");
    assert.ok((await uploads.get(s.body.id)).describedAt, "must record that we asked");
    visionUp = true;
  });

  await ok("completion is idempotent and does not pay twice", async () => {
    const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
    store.objects.set("u/" + "a".repeat(32) + ".png", PNG);
    await complete(s.body.id);
    let calls = 0;
    const prev = visionStub.describe;
    visionStub.describe = async () => { calls++; return visionResult; };
    const again = await complete(s.body.id);
    assert.strictEqual(again.code, 200);
    assert.strictEqual(calls, 0, "a retried completion must not re-describe");
    visionStub.describe = prev;
  });

  console.log("\nsniffer");

  await ok("recognises exactly the four allowed signatures", () => {
    assert.strictEqual(routes.sniff(PNG), "image/png");
    assert.strictEqual(routes.sniff(JPEG), "image/jpeg");
    assert.strictEqual(routes.sniff(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)])), "image/gif");
    assert.strictEqual(routes.sniff(Buffer.concat([
      Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20)])), "image/webp");
    assert.strictEqual(routes.sniff(HTML), "");
    assert.strictEqual(routes.sniff(Buffer.from("<svg/>")), "", "SVG has no magic bytes and must not pass");
    assert.strictEqual(routes.sniff(Buffer.alloc(4)), "", "too short to judge");
  });

  console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
  Module._resolveFilename = realResolve;
})();
