"use strict";

/* =====================================================================
   GitHub — pushing a generated app to a repository the USER owns.

   The same shape as lib/stripe.js, and for the same reason: the account
   at the other end is theirs, not Souqi's. Souqi holds an OAuth token
   just long enough to create a repo and write a commit to it, the repo
   belongs to their account from the moment it exists, and disconnecting
   here does not touch anything already pushed. Their code stays theirs
   whatever happens to this platform, which is most of the point.

   Two things this deliberately is NOT:

   • Not a git client. There is no .git anywhere on the server and no
     child process. Everything goes through the Git Data API — blobs,
     tree, commit, ref — which is enough to write a commit and avoids
     shipping a git binary into a serverless function that has no
     writable filesystem worth the name.

   • Not a sync. It pushes; it never pulls. A project's files live in
     Mongo as a chain of revisions and that chain is the source of
     truth. Reading commits back and merging them into that chain is a
     different feature with its own conflict rules, and pretending to do
     it would lose someone's work the first time they edited both sides.
   ===================================================================== */

const API = "https://api.github.com";
const UA = "souqi-code";

/* `repo` is broader than it looks: it covers private repositories, which
   is the whole reason to ask for it — public_repo cannot create the
   private repo most people want for an unfinished app. It is also the
   narrowest OAuth scope that can. The UI says this in words before
   anyone clicks, because a GitHub consent screen reading "full control
   of private repositories" deserves a warning that arrived first. */
const SCOPE = "repo";

/* Not every failure is a bug. An operator who has not registered a GitHub
   OAuth app gets configured:false and a card that says so, rather than a
   button that dead-ends after the redirect. */
function isConfigured() {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function authorizeUrl(state, redirectUri) {
  const q = new URLSearchParams({
    client_id: String(process.env.GITHUB_CLIENT_ID || ""),
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: state,
    allow_signup: "false"
  });
  return "https://github.com/login/oauth/authorize?" + q.toString();
}

/** code -> access token. Throws with GitHub's own words on refusal. */
async function exchangeCode(code, redirectUri) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code: code,
      redirect_uri: redirectUri
    })
  });
  const body = await res.json().catch(() => ({}));
  // GitHub answers 200 with an {error} body rather than a status code, so
  // the status alone is not the check.
  if (body && body.error) throw new Error(body.error_description || body.error);
  if (!res.ok || !body.access_token) throw new Error("GitHub did not return an access token");
  return { token: body.access_token, scope: body.scope || "" };
}

/** One authenticated call. Non-2xx becomes an Error carrying GitHub's message. */
async function gh(token, path, init) {
  const res = await fetch(API + path, Object.assign({}, init, {
    headers: Object.assign({
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA
    }, (init && init.headers) || {})
  }));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || ("GitHub returned " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    // A 422 on repo creation is almost always "name already exists" —
    // something the caller can act on, not an outage.
    err.errors = (body && body.errors) || null;
    throw err;
  }
  return body;
}

/** Who the token belongs to. Shown on the card, so a wrong account is obvious. */
async function viewer(token) {
  const u = await gh(token, "/user", { method: "GET" });
  return { login: u.login, name: u.name || u.login, avatarUrl: u.avatar_url || null, htmlUrl: u.html_url };
}

/** Disconnecting should make the token stop working, not merely forget it. */
async function revoke(token) {
  const id = process.env.GITHUB_CLIENT_ID, secret = process.env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) return false;
  const auth = Buffer.from(id + ":" + secret, "utf8").toString("base64");
  const res = await fetch(API + "/applications/" + id + "/grant", {
    method: "DELETE",
    headers: {
      Authorization: "Basic " + auth,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA
    },
    body: JSON.stringify({ access_token: token })
  });
  return res.status === 204;
}

/* A repository name GitHub will accept, derived from the project's own
   slug so the two stay recognisably the same thing. */
function repoNameFrom(s) {
  const name = String(s || "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "").replace(/[-.]+$/, "")
    .slice(0, 90);
  return name || "souqi-app";
}

async function createRepo(token, opts) {
  const repo = await gh(token, "/user/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: repoNameFrom(opts.name),
      description: String(opts.description || "").slice(0, 350),
      private: opts.private !== false,
      auto_init: false,          // empty, so the first push IS the history
      has_issues: true, has_wiki: false, has_projects: false
    })
  });
  return {
    fullName: repo.full_name, htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch || "main", private: !!repo.private,
    owner: repo.owner && repo.owner.login
  };
}

/* What never belongs in the commit: build output and installed
   dependencies. Pushing them is slow, useless, and makes the repo look
   like a mess rather than like source. */
const SKIP_RE = /(^|\/)(node_modules|dist|build|\.git|\.next|\.vercel|\.cache|coverage)(\/|$)/;

/* A generated app is a few dozen small text files. These ceilings are not
   about GitHub's limits — they are about refusing to spend two minutes
   and 400 API calls on something that has clearly gone wrong. */
const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function prepare(files) {
  const out = [];
  let bytes = 0, skipped = 0;
  for (const path of Object.keys(files || {}).sort()) {
    if (SKIP_RE.test(path)) { skipped++; continue; }
    const content = files[path];
    if (typeof content !== "string") { skipped++; continue; }
    const size = Buffer.byteLength(content, "utf8");
    if (out.length >= MAX_FILES || bytes + size > MAX_TOTAL_BYTES) { skipped++; continue; }
    bytes += size;
    out.push({ path: path.replace(/^\/+/, ""), content: content });
  }
  return { entries: out, bytes: bytes, skipped: skipped };
}

/**
 * Write every file as one commit.
 *
 * Blobs, then a tree, then a commit, then move the branch — the order the
 * git object model requires. A repo with no commits yet has no ref to
 * read and no parent to point at, so both are conditional rather than
 * assumed; getting that wrong is the classic "Git Repository is empty"
 * 409 on the very first push, which is the only push most of these repos
 * will ever get.
 */
async function pushFiles(token, fullName, files, message) {
  const prepared = prepare(files);
  if (!prepared.entries.length) throw new Error("This project has no files to push yet.");

  const repo = await gh(token, "/repos/" + fullName, { method: "GET" });
  const branch = repo.default_branch || "main";

  let parentSha = null, baseTree = null;
  try {
    const ref = await gh(token, "/repos/" + fullName + "/git/ref/heads/" + branch, { method: "GET" });
    parentSha = ref.object && ref.object.sha;
    if (parentSha) {
      const commit = await gh(token, "/repos/" + fullName + "/git/commits/" + parentSha, { method: "GET" });
      baseTree = commit.tree && commit.tree.sha;
    }
  } catch (e) {
    // 404/409 here is the empty-repository case, which is not an error.
    if (e.status && e.status !== 404 && e.status !== 409) throw e;
  }

  const tree = [];
  for (const f of prepared.entries) {
    const blob = await gh(token, "/repos/" + fullName + "/git/blobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" })
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeBody = { tree: tree };
  if (baseTree) treeBody.base_tree = baseTree;
  const newTree = await gh(token, "/repos/" + fullName + "/git/trees", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(treeBody)
  });

  const commitBody = { message: String(message || "Update from Souqi").slice(0, 500), tree: newTree.sha };
  if (parentSha) commitBody.parents = [parentSha];
  const commit = await gh(token, "/repos/" + fullName + "/git/commits", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commitBody)
  });

  const refPath = "/repos/" + fullName + "/git/refs";
  if (parentSha) {
    await gh(token, refPath + "/heads/" + branch, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
  } else {
    await gh(token, refPath, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/" + branch, sha: commit.sha })
    });
  }

  return {
    commitSha: commit.sha, branch: branch,
    htmlUrl: repo.html_url + "/tree/" + branch,
    commitUrl: repo.html_url + "/commit/" + commit.sha,
    files: prepared.entries.length, skipped: prepared.skipped, bytes: prepared.bytes
  };
}

module.exports = {
  isConfigured, authorizeUrl, exchangeCode, viewer, revoke,
  createRepo, pushFiles, repoNameFrom, SCOPE,
  // exported for the tests
  _prepare: prepare, _SKIP_RE: SKIP_RE, MAX_FILES, MAX_TOTAL_BYTES
};
