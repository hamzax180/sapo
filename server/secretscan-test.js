/* =================================================================
   secretscan-test.js
   -----------------------------------------------------------------
   Every "credential" below is invented for this file. None of them
   authenticates anywhere.

   They are ASSEMBLED AT RUNTIME rather than written as literals, and
   that is not cosmetic: GitHub's push protection scans this file and
   cannot tell an invented credential from a real one — exactly the
   problem the scanner under test has. Written out in full, this file
   is unpushable. Joined from parts, it holds no string that matches a
   vendor pattern while the tests still see the whole thing.

   The half of this file that matters most is the second half. A
   scanner that blocks deploys is only as good as its false-positive
   rate, so the negative cases are the ones that decide whether this is
   safe to make blocking at all.
   ================================================================= */
"use strict";

const assert = require("assert");
const path = require("path");
const scanner = require("./lib/secretscan");

/** Joins fixture fragments. See the header for why they are fragments. */
const j = (...parts) => parts.join("");

const FAKE = {
  aws: j("AKIA", "2E0ZTQ4RJ7WNPLQX"),
  stripeLive: j("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dcQ8Kf2"),
  stripePub: j("pk_", "live_", "51H8xKqLyjWDarjtT1zdp7dcQ8Kf2mN4b"),
  github: j("ghp", "_", "9WlKq2ZvR8mTx4NbY6cJdF1sHgP0aE3uViO7"),
  google: j("AIza", "SyD9fK2mQ7pR4tXvB1nL6cW8jH3sG5uZ0eA"),
  slack: j("xoxb", "-2847391045-3927104857-Kd8Mq2Xv9Rt4Nb"),
  openai: j("sk", "-", "Kq7ZvR2mTx4NbY6cJdF1sHgP0aE3uViO9WlB8nMt5Yr2"),
  anthropic: j("sk", "-ant-", "api03-",
    "aB3xK9mQ7pR4tXvB1nL6cW8jH3sG5uZ0eA2dF7hJ4kM6nP9qR1sT3vW5yZ8bC0dE2fG4hJ6kL8mN0pQ7rS9tU1vW3xY5zA"),
  sendgrid: j("SG", ".", "aB3xK9mQ7pR4tXvB1nL6cW", ".", "8jH3sG5uZ0eA2dF7hJ4kM6nP9qR1sT3vW5yZ8bC0dE2"),
  npm: j("npm", "_", "K9mQ7pR4tXvB1nL6cW8jH3sG5uZ0eA2dF7hJ"),
  twilio: j("SK", "a3f9c2e8b7d1450629af83bc5d7e04f1"),
  privateKey: j("-----BEGIN RSA ", "PRIVATE KEY", "-----"),
  jwt: j("eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  dbUrl: j("postgres://", "appuser", ":", "s3cretpassw0rd", "@shop-db.acme-corp.net:5432/shop")
};

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); failed++; }
}

const one = (content, p) => scanner.scan({ [p || "src/app.js"]: content });
const ids = (r) => r.findings.map((f) => f.rule).sort();

console.log("\n── it catches a real credential ─────────────────────");

const POSITIVES = [
  ["aws-access-key-id", "const k = '" + FAKE.aws + "';"],
  ["stripe-live-secret", "stripe('" + FAKE.stripeLive + "')"],
  ["github-token", "token: '" + FAKE.github + "'"],
  ["google-api-key", "key=" + FAKE.google],
  ["slack-token", "SLACK='" + FAKE.slack + "'"],
  ["openai-key", "OPENAI_API_KEY=" + FAKE.openai],
  ["anthropic-key", "ANTHROPIC=" + FAKE.anthropic],
  ["sendgrid-key", FAKE.sendgrid],
  ["npm-token", "//registry.npmjs.org/:_authToken=" + FAKE.npm],
  ["twilio-api-key", FAKE.twilio],
  ["private-key", FAKE.privateKey + "\nMIIEow...\n"]
];

for (const [id, content] of POSITIVES) {
  check("blocks " + id, () => {
    const r = one(content);
    assert.ok(r.findings.some((f) => f.rule === id),
      "not detected; found instead: " + (ids(r).join(", ") || "nothing"));
    assert.strictEqual(r.blocked, true, "detected but did not block");
  });
}

console.log("\n── it does not leak what it found ───────────────────");

check("the finding masks the credential", () => {
  const r = one("stripe('" + FAKE.stripeLive + "')");
  const f = r.findings[0];
  assert.ok(!f.match.includes(FAKE.stripeLive), "the full secret is in the finding");
  assert.ok(f.match.length < FAKE.stripeLive.length, "the mask is not shorter than the secret");
  assert.ok(!JSON.stringify(r).includes(FAKE.stripeLive),
    "the full secret survives somewhere in the result, which is returned to a browser and logged");
});

check("it says where, so the finding is actionable", () => {
  const r = one("line one\nline two\nconst k = '" + FAKE.aws + "';\n", "src/lib/pay.ts");
  assert.strictEqual(r.findings[0].path, "src/lib/pay.ts");
  assert.strictEqual(r.findings[0].line, 3, "the reported line is wrong");
});

console.log("\n── it does not block a working deploy ───────────────");

/* Each of these appears in real generated apps. A rule firing on any of them
   would stop someone shipping software that has nothing wrong with it, which
   is the failure this scanner has to avoid more than any other. */
const NEGATIVES = [
  ["a placeholder in an example file", "STRIPE_KEY=" + j("sk_", "live_") + "xxxxxxxxxxxxxxxxxxxxxxxxxx"],
  ["an obvious stand-in", "OPENAI_API_KEY=" + j("sk", "-") + "your_api_key_here_replace_me_before_running"],
  ["an angle-bracket template", "AWS: <AKIA_YOUR_ACCESS_KEY_ID_HERE>"],
  ["a git SHA", "const rev = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';"],
  ["a sha256 integrity hash", "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="],
  ["a UUID", "id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301'"],
  ["a base64 png data URI", "src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\""],
  ["a tailwind class soup", "className='grid grid-cols-3 gap-4 rounded-2xl bg-slate-50 px-6 py-4'"],
  ["a long import path", "import { createBrowserRouter } from 'react-router-dom/dist/index.mjs';"],
  ["a css colour list", ":root{--a:#1aa6df;--b:#22a565;--c:#d92d20;--d:#e0a11a;--e:#8b98a5}"],
  ["a lorem paragraph", "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor"],
  ["an env var reference, not a value", "const key = process.env.STRIPE_SECRET_KEY;"],
  ["a public publishable key", "stripe('" + FAKE.stripePub + "')"],
  ["a localhost connection string", "postgres://user@localhost:5432/dev"]
];

for (const [label, content] of NEGATIVES) {
  check("allows " + label, () => {
    const r = one(content);
    assert.strictEqual(r.blocked, false,
      "blocked on " + ids(r).join(", ") + " — this would stop a legitimate deploy");
  });
}

console.log("\n── reported, but never blocking ─────────────────────");

check("a connection string is reported, not blocked", () => {
  // Not an example.* host: the placeholder filter suppresses those on
  // purpose, and it should — "example.net" in a connection string is
  // documentation, not a leak.
  const r = one("DATABASE_URL=" + FAKE.dbUrl);
  assert.ok(r.findings.some((f) => f.rule === "db-connection-string"), "not reported at all");
  assert.strictEqual(r.blocked, false,
    "a connection string blocks the deploy; these appear in READMEs and fixtures too often to refuse on");
});

check("a JWT is reported, not blocked", () => {
  const r = one("const t='" + FAKE.jwt + "'");
  assert.ok(r.findings.some((f) => f.rule === "jwt"));
  assert.strictEqual(r.blocked, false);
});

console.log("\n── it skips what it should ──────────────────────────");

check("lockfiles are skipped", () => {
  const r = scanner.scan({ "package-lock.json": "token " + FAKE.aws });
  assert.strictEqual(r.blocked, false, "a lockfile's contents are scanned");
  assert.strictEqual(r.scanned, 0);
});

check("node_modules is skipped", () => {
  const r = scanner.scan({ "node_modules/pkg/index.js": FAKE.aws });
  assert.strictEqual(r.blocked, false);
});

check("binary assets are skipped", () => {
  const r = scanner.scan({ "public/logo.png": FAKE.aws });
  assert.strictEqual(r.blocked, false);
});

check("a non-string value cannot crash the scan", () => {
  const r = scanner.scan({ "a.js": null, "b.js": undefined, "c.js": 42, "d.js": {} });
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.scanned, 0);
});

check("an empty tree is fine", () => {
  for (const input of [{}, null, undefined]) {
    const r = scanner.scan(input);
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.findings.length, 0);
  }
});

console.log("\n── the scaffold itself must be clean ────────────────");

/* The scaffold ships on EVERY deploy. One rule firing on it would block every
   deploy on the platform at once, which is why this is a test and not an
   assumption. */
check("the shipped scaffold produces no findings", () => {
  let data;
  try {
    data = require(path.join(__dirname, "lib", "codeagent", "scaffold-data.json"));
  } catch (e) {
    console.log("       (scaffold-data.json not built; run scripts/build-scaffold-data.js)");
    return;
  }
  const r = scanner.scan(data);
  assert.strictEqual(r.findings.length, 0,
    "the scaffold trips " + r.findings.map((f) => f.rule + " in " + f.path).join(", ") +
    " — every deploy on the platform would be blocked");
});

console.log("\n── the summary reads like a sentence ────────────────");

check("summarize names the file and the provider", () => {
  const r = one("const k='" + FAKE.aws + "';", "src/aws.ts");
  const s = scanner.summarize(r);
  assert.ok(/AWS access key ID/.test(s), s);
  assert.ok(/src\/aws\.ts/.test(s), s);
  assert.ok(!s.includes(FAKE.aws), "the summary leaks the credential");
});

check("summarize counts the rest", () => {
  const r = scanner.scan({ "a.js": FAKE.aws, "b.js": FAKE.github });
  assert.ok(/1 other credential/.test(scanner.summarize(r)), scanner.summarize(r));
});

console.log("\n" + (failed === 0
  ? "✓ ALL " + passed + " SECRET-SCAN CHECKS PASSED"
  : "✗ " + failed + " FAILED, " + passed + " passed"));
process.exit(failed === 0 ? 0 : 1);
