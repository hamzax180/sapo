/* =================================================================
   normalise.js — turn a typed sentence into comparable tokens
   -----------------------------------------------------------------
   Everything downstream (the industry classifier, the slot rules, the
   refinement grammar) works on tokens, not raw text. This module is
   the only place that knows about scripts, diacritics and suffixes.

   No dependencies, no model, no network. See docs/NO-API-BUILDER-PLAN.md §3.1.
   ================================================================= */
"use strict";

/* ---- script / language detection -------------------------------- */

const ARABIC = /[؀-ۿ]/;
const TURKISH_CHARS = /[ışğİĞŞ]/;           // ö/ü/ç are shared with German etc.
const TURKISH_WORDS = /\b(bir|için|ile|ve|benim|kendi|satan|satıyorum|istiyorum|sitesi|dükkan|mağaza|firma|şirket)\b/i;

/**
 * Best-effort language of a prompt. Deliberately biased towards `en`:
 * a wrong `tr` guess picks the wrong copy corpus, a wrong `en` guess is
 * merely bland.
 */
function detectLang(text) {
  const s = String(text || "");
  if (ARABIC.test(s)) return "ar";
  if (TURKISH_CHARS.test(s) || TURKISH_WORDS.test(s)) return "tr";
  return "en";
}

/* ---- folding ----------------------------------------------------- */

const FOLD = {
  "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
  "ö": "o", "Ö": "o", "ü": "u", "Ü": "u", "ç": "c", "Ç": "c",
  "â": "a", "î": "i", "û": "u",
  "á": "a", "à": "a", "ä": "a", "é": "e", "è": "e", "ê": "e", "ë": "e",
  "í": "i", "ï": "i", "ó": "o", "ô": "o", "ú": "u", "ñ": "n",
  // Arabic orthographic variants that mean the same letter
  "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"
};
const ARABIC_MARKS = /[ً-ٰٟـ]/g;   // harakat + tatweel

/** Lowercase and strip the accent/orthography differences that are noise. */
function fold(text) {
  let out = "";
  for (const ch of String(text || "")) out += FOLD[ch] || ch;
  return out.toLowerCase().replace(ARABIC_MARKS, "");
}

/* ---- stopwords --------------------------------------------------- */

const STOP = {
  en: new Set(["a", "an", "the", "my", "our", "your", "for", "with", "and", "or", "of", "in", "on", "to", "is", "are",
    "i", "we", "it", "that", "this", "want", "need", "would", "like", "make", "build", "create", "please", "can",
    "site", "website", "web", "page", "online", "new", "some", "have", "has", "get", "sell", "selling"]),
  tr: new Set(["bir", "bu", "su", "ve", "ile", "icin", "gibi", "de", "da", "ki", "mi", "ne", "benim", "bizim", "sizin",
    "olan", "yapmak", "istiyorum", "lazim", "site", "sitesi", "web", "sayfa", "sayfasi", "online", "yeni"]),
  ar: new Set(["و", "في", "من", "على", "الى", "عن", "مع", "او", "ان", "هذا", "هذه", "الذي", "التي", "اريد", "احتاج",
    "موقع", "صفحه", "الكتروني", "جديد", "لي", "لنا"])
};

/* ---- light stemming ---------------------------------------------- */

// Longest-first so "-lerimiz" is tried before "-ler".
const TR_SUFFIXES = ["lerimiz", "larimiz", "lerimi", "larimi", "cilik", "cilik", "ciligi", "lerin", "larin",
  "lerde", "larda", "leri", "lari", "ler", "lar", "cisi", "cilar", "ciler", "sini", "sina", "nin", "nun",
  "cin", "ci", "cu", "ce", "ca", "si", "su", "yi", "yu", "de", "da", "te", "ta", "in", "un", "im", "um", "i", "u"];

function stemTr(tok) {
  for (const suf of TR_SUFFIXES) {
    if (tok.length >= suf.length + 3 && tok.endsWith(suf)) return tok.slice(0, -suf.length);
  }
  return tok;
}

const AR_PREFIXES = ["وال", "بال", "كال", "فال", "لل", "ال", "و", "ب", "ك", "ف", "ل"];
const AR_SUFFIXES = ["يه", "ات", "ون", "ين", "ها", "هم", "نا", "ي", "ه"];

function stemAr(tok) {
  let t = tok;
  for (const p of AR_PREFIXES) {
    if (t.length >= p.length + 3 && t.startsWith(p)) { t = t.slice(p.length); break; }
  }
  for (const s of AR_SUFFIXES) {
    if (t.length >= s.length + 3 && t.endsWith(s)) { t = t.slice(0, -s.length); break; }
  }
  return t;
}

function stemEn(tok) {
  if (tok.length > 4 && tok.endsWith("ies")) return tok.slice(0, -3) + "y";
  if (tok.length > 4 && (tok.endsWith("ses") || tok.endsWith("xes") || tok.endsWith("ches") || tok.endsWith("shes"))) return tok.slice(0, -2);
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1);
  if (tok.length > 5 && tok.endsWith("ing")) return tok.slice(0, -3);
  return tok;
}

const STEM = { en: stemEn, tr: stemTr, ar: stemAr };

/* ---- tokenise ----------------------------------------------------- */

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * @returns {{lang:string, tokens:string[], folded:string, raw:string}}
 */
function analyse(text, forcedLang) {
  const raw = String(text || "");
  const lang = forcedLang || detectLang(raw);
  const folded = fold(raw);
  const stop = STOP[lang] || STOP.en;
  const stem = STEM[lang] || stemEn;

  const tokens = [];
  const matches = folded.match(WORD) || [];
  for (const m of matches) {
    if (m.length < 2) continue;
    if (stop.has(m)) continue;
    const s = stem(m);
    if (s.length >= 2) tokens.push(s);
  }
  return { lang: lang, tokens: tokens, folded: folded, raw: raw };
}

/** Token bigrams — "coffee shop" carries more signal than either word. */
function bigrams(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(tokens[i] + "_" + tokens[i + 1]);
  return out;
}

module.exports = { analyse, detectLang, fold, bigrams, STOP };
