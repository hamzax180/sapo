/* =================================================================
   anon.js — an identity for someone who hasn't signed up yet
   -----------------------------------------------------------------
   This is what lets a visitor build a site, close the tab, and still
   find it tomorrow — without an account. A signed, http-only cookie
   holds a random id; that id owns their projects until they claim
   them, at which point ownership moves to the real user.

   Signed with the same JWT secret, so it cannot be forged or edited
   by the browser. It carries NO personal data — just a random handle
   — so it is not a tracking cookie in any meaningful sense, and it is
   scoped to this site with SameSite=Lax.

   See docs/AGENT-PARITY-PLAN.md §1.
   ================================================================= */
"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const COOKIE = "sq_anon";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

let JWT_SECRET = "dev-insecure-secret";
function init(deps) { JWT_SECRET = deps.JWT_SECRET; }

/* Express has res.cookie built in, but no reader without cookie-parser —
   and one regex is cheaper than a dependency. */
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]*)").exec(raw);
  return m ? decodeURIComponent(m[1]) : "";
}

/**
 * The anonymous id for this request, minting and setting one if needed.
 * Always returns an id, so callers never have to handle "no identity yet".
 */
function ensureAnonId(req, res) {
  const existing = readCookie(req, COOKIE);
  if (existing) {
    try {
      const decoded = jwt.verify(existing, JWT_SECRET);
      if (decoded && decoded.scope === "anon" && decoded.anonId) return decoded.anonId;
    } catch (e) { /* expired or tampered — mint a fresh one below */ }
  }

  const anonId = "an_" + crypto.randomBytes(12).toString("base64url");
  const token = jwt.sign({ anonId: anonId, scope: "anon" }, JWT_SECRET, { expiresIn: "30d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,                                   // JS can't read it, so XSS can't steal it
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_MS,
    path: "/"
  });
  return anonId;
}

/** Read-only: the anon id if there is a valid one, else "". */
function anonIdOf(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return "";
  try {
    const decoded = jwt.verify(raw, JWT_SECRET);
    return decoded && decoded.scope === "anon" ? decoded.anonId || "" : "";
  } catch (e) { return ""; }
}

/** The signed-in user, if this request carries a valid session token in
    the Authorization header. Deliberately header-only, NOT the sq_session
    cookie — project-test.js's claim/publish security model depends on
    "the anon cookie alone, even from a browser that's also logged in
    elsewhere, is not ownership proof" (a claimed project requires the
    REAL Authorization header, not just whatever cookies happen to be
    sitting in the jar). Code's own sign-in gate needs cookie-based
    detection too, but that's handled locally in index.js precisely so it
    doesn't change what this shared function means for Sites. */
function userOf(req) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.scope) return null;        // edit/anon tokens are not sessions
    return decoded && decoded.id ? decoded : null;
  } catch (e) { return null; }
}

/**
 * Who is asking. A signed-in user always wins over the cookie, so claiming
 * on one device doesn't leave the project stuck behind an anonymous id.
 */
function ownerOf(req, res) {
  const user = userOf(req);
  const anonId = res ? ensureAnonId(req, res) : anonIdOf(req);
  return { userId: user ? user.id : null, email: user ? user.email : null, anonId: anonId };
}

module.exports = { init, ensureAnonId, anonIdOf, userOf, ownerOf, COOKIE };
