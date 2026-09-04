/* =================================================================
   lib/secretscan.js — refuse to ship a credential
   -----------------------------------------------------------------
   A generated app is uploaded to the deploy plane, built, and served on
   a public hostname. Anything committed into it is published. A model
   that helpfully inlines the key a user pasted into chat, or a user who
   pastes a .env into a file, ships a live credential to the internet.

   This blocks the deploy before the upload happens.

   THE DESIGN CONSTRAINT IS FALSE POSITIVES, NOT COVERAGE.
   A missed secret is bad. A false positive is worse, because it stops
   someone deploying working software and there is no way for them to
   override it — so this deliberately does not do entropy scanning,
   which flags minified bundles, hashes, base64 images and UUIDs.
   Every blocking rule matches a provider-issued shape: a fixed prefix
   plus a fixed length, the form these tokens actually have. If a rule
   cannot be written that precisely, it reports instead of blocking.
   ================================================================= */
"use strict";

/* Blocking rules. Each `re` is anchored to a vendor prefix and a length,
   so it matches the real thing and almost nothing else. `what` is shown
   to the user, so it names the provider rather than the regex. */
const HIGH = [
  { id: "aws-access-key-id", what: "an AWS access key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "stripe-live-secret", what: "a live Stripe secret key", re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}/g },
  { id: "github-token", what: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: "google-api-key", what: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", what: "a Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  // sk-ant- is Anthropic and fits this shape too. Without the lookahead the
  // user is told they leaked an OpenAI key when they did not, and the rule
  // that would have named it correctly never gets a chance to run.
  { id: "openai-key", what: "an OpenAI API key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}/g },
  // Real keys carry ~95 characters after sk-ant-api03-. 60 is well clear of
  // anything that is not one, while leaving room for the format to change
  // without this silently stopping to match.
  { id: "anthropic-key", what: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{60,}/g },
  { id: "sendgrid-key", what: "a SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: "npm-token", what: "an npm access token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "twilio-api-key", what: "a Twilio API key", re: /\bSK[0-9a-f]{32}\b/g },
  { id: "private-key", what: "a private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g }
];

/* Reported, never blocking. These shapes are real often enough to be worth
   saying out loud and wrong often enough that refusing on them would stop
   legitimate deploys — a connection string in a README, a fixture, or an
   example file is not a leak. */
const MEDIUM = [
  {
    id: "db-connection-string",
    what: "a database connection string with a password in it",
    re: /\b(?:postgres|postgresql|mysql|mongodb)(?:\+srv)?:\/\/[^\s:/@]+:[^\s@/]{6,}@[^\s/]+/g
  },
  { id: "jwt", what: "a JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g }
];

/* A value that is obviously a stand-in. Checked against the MATCH, not the
   line, so a real key on a line mentioning "example" is still caught. */
const PLACEHOLDER = /(?:x{6,}|X{6,}|0{8,}|1234567890|your[_-]?(?:api)?[_-]?key|placeholder|example|redacted|dummy|changeme|<[^>]+>|\.\.\.)/i;

/* Files that are ours, generated, or vendored. The scaffold ships on every
   deploy and cannot be edited by the model in the ways that matter, and a
   lockfile's integrity hashes are noise no rule here should have to dodge. */
const SKIP_PATH = /(?:^|\/)(?:node_modules|\.git|dist|build|coverage)\/|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/* Binary-ish and generated content. Scanning a base64 image for tokens finds
   nothing and costs the whole file. */
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|eot|otf|mp[34]|webm|pdf|zip|gz|wasm|map|min\.js|min\.css)$/i;

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FINDINGS = 50;

/** Enough of the secret to recognise it, never enough to use it. */
function mask(s) {
  const str = String(s);
  if (str.length <= 12) return str.slice(0, 4) + "…";
  return str.slice(0, 8) + "…" + str.slice(-4);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Scan a file tree.
 *
 * @param {Object<string,string>} files  path -> contents
 * @returns {{blocked: boolean, findings: Array, scanned: number, skipped: number}}
 *   findings are {path, line, rule, what, severity, match} where `match` is
 *   masked — this result is returned to a browser and written to logs, so it
 *   must never carry the credential it is reporting.
 */
function scan(files) {
  const findings = [];
  let scanned = 0;
  let skipped = 0;

  for (const [path, raw] of Object.entries(files || {})) {
    if (SKIP_PATH.test(path) || SKIP_EXT.test(path)) { skipped++; continue; }
    if (typeof raw !== "string") { skipped++; continue; }
    if (raw.length > MAX_FILE_BYTES) { skipped++; continue; }
    scanned++;

    for (const [severity, rules] of [["high", HIGH], ["medium", MEDIUM]]) {
      for (const rule of rules) {
        // Fresh lastIndex per file: these regexes are /g and module-level.
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(raw)) !== null) {
          if (m[0].length === 0) { rule.re.lastIndex++; continue; }
          if (PLACEHOLDER.test(m[0])) continue;
          findings.push({
            path: path,
            line: lineOf(raw, m.index),
            rule: rule.id,
            what: rule.what,
            severity: severity,
            match: mask(m[0])
          });
          if (findings.length >= MAX_FINDINGS) break;
        }
        if (findings.length >= MAX_FINDINGS) break;
      }
      if (findings.length >= MAX_FINDINGS) break;
    }
    if (findings.length >= MAX_FINDINGS) break;
  }

  return {
    blocked: findings.some((f) => f.severity === "high"),
    findings: findings,
    scanned: scanned,
    skipped: skipped
  };
}

/** One sentence for the error body, so the UI has something to show even if
    it only renders the message. */
function summarize(result) {
  const high = result.findings.filter((f) => f.severity === "high");
  if (!high.length) return "no credentials found";
  const first = high[0];
  const rest = high.length - 1;
  return "found " + first.what + " in " + first.path + " (line " + first.line + ")" +
    (rest > 0 ? " and " + rest + " other " + (rest === 1 ? "credential" : "credentials") : "");
}

module.exports = { scan, summarize, HIGH, MEDIUM, PLACEHOLDER };
