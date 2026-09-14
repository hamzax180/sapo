/* =================================================================
   palette.js — a whole colour system from one seed, with AA enforced
   -----------------------------------------------------------------
   Given a seed colour (a word the visitor typed, a colour lifted from
   their logo, or the industry default) this produces every colour the
   generated site needs — and then *proves* the text on it is legible
   by measuring WCAG contrast and moving lightness until it passes.

   That guarantee is the thing a language model cannot give you: a
   generated site here is never inaccessible, because accessibility is
   a computation, not a judgement call.

   Works in OKLCH, where lightness is perceptually even, so nudging L
   changes how light something *looks* rather than how bright its
   channels happen to be. See docs/NO-API-BUILDER-PLAN.md §6.1.
   ================================================================= */
"use strict";

/* ================= sRGB ⇄ OKLab ⇄ OKLCH ================= */

function hexToRgb(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function rgbToHex(rgb) {
  return "#" + rgb.map((c) => {
    const v = Math.round(Math.min(1, Math.max(0, c)) * 255);
    return v.toString(16).padStart(2, "0");
  }).join("");
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklab(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ];
}

function oklabToRgb(lab) {
  const [L, A, B] = lab;
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3);
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ].map(toGamma);
}

function toOklch(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [L, a, b] = rgbToOklab(rgb);
  return { l: L, c: Math.sqrt(a * a + b * b), h: (Math.atan2(b, a) * 180) / Math.PI };
}

function fromOklch(o) {
  const rad = (o.h * Math.PI) / 180;
  const rgb = oklabToRgb([o.l, Math.cos(rad) * o.c, Math.sin(rad) * o.c]);
  // clamp chroma until it fits in sRGB, so we never emit an out-of-gamut hex
  if (rgb.some((v) => v < -0.002 || v > 1.002)) {
    let c = o.c;
    for (let i = 0; i < 24 && c > 0; i++) {
      c *= 0.9;
      const test = oklabToRgb([o.l, Math.cos(rad) * c, Math.sin(rad) * c]);
      if (test.every((v) => v >= -0.002 && v <= 1.002)) return rgbToHex(test);
    }
  }
  return rgbToHex(rgb);
}

/* ================= WCAG contrast ================= */

function relLuminance(hex) {
  const rgb = hexToRgb(hex) || [0, 0, 0];
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1..21. */
function contrast(a, b) {
  const la = relLuminance(a), lb = relLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Move `fg` lighter or darker (in OKLCH L, so it stays the same hue) until it
 * clears `target` contrast against `bg`. Returns the original if it already
 * passes, and the best it managed if the hue simply cannot get there.
 */
function ensureContrast(fg, bg, target) {
  const want = target || 4.5;
  if (contrast(fg, bg) >= want) return fg;

  const o = toOklch(fg);
  if (!o) return fg;
  const bgLight = relLuminance(bg) > 0.18;
  const dir = bgLight ? -1 : 1;      // dark text on light backgrounds, and vice versa

  let best = fg, bestRatio = contrast(fg, bg);
  for (let step = 1; step <= 40; step++) {
    const l = Math.min(1, Math.max(0, o.l + dir * step * 0.025));
    const candidate = fromOklch({ l: l, c: o.c, h: o.h });
    const ratio = contrast(candidate, bg);
    if (ratio > bestRatio) { best = candidate; bestRatio = ratio; }
    if (ratio >= want) return candidate;
    if (l === 0 || l === 1) break;
  }
  return best;
}

/* ================= the palette ================= */

/* Industry defaults, used when the prompt names no colour. Chosen to look
   like the trade rather than like a template. */
const INDUSTRY_SEED = {
  restaurant: "#a8552b", fashion: "#1f2430", logistics: "#12708f", manufacturing: "#41506b",
  construction: "#b5761f", services: "#2f6f5e", wholesale: "#2c5d8a", retail: "#1aa6df"
};

/**
 * @param {object} opts { seed, industry, tone }
 * @returns {object} a full, AA-verified palette
 */
function build(opts) {
  const o = opts || {};
  const seed = hexToRgb(o.seed) ? o.seed : (INDUSTRY_SEED[o.industry] || "#1aa6df");
  const base = toOklch(seed);
  const tone = o.tone || "neutral";

  // Tone shifts how saturated and how light the surfaces read.
  const chromaScale = tone === "premium" ? 0.72 : tone === "playful" ? 1.18 : tone === "technical" ? 0.82 : 1;
  const c = Math.min(0.33, base.c * chromaScale);
  const h = base.h;

  // Accent: pinned into a band that stays usable as a button fill, then
  // adjusted until its own label is legible on it (see fitAccent).
  const rawAccent = fromOklch({ l: clamp(base.l, 0.48, 0.68), c: c, h: h });
  const fitted = fitAccent(rawAccent);
  const accent = fitted.accent;
  const accentHover = fromOklch({ l: clamp(toOklch(accent).l - 0.07, 0.3, 0.62), c: c, h: h });

  // Surfaces: near-white, carrying a trace of the hue so the page feels tinted
  // rather than grey.
  const surface = tone === "premium"
    ? fromOklch({ l: 0.985, c: Math.min(0.008, c * 0.05), h: h })
    : fromOklch({ l: 0.975, c: Math.min(0.014, c * 0.09), h: h });
  const surface2 = fromOklch({ l: 0.945, c: Math.min(0.02, c * 0.14), h: h });
  const line = fromOklch({ l: 0.895, c: Math.min(0.024, c * 0.16), h: h });
  const tint = fromOklch({ l: 0.9, c: Math.min(0.09, c * 0.55), h: h });

  // Ink: enforced against the surface it actually sits on.
  const ink = ensureContrast(fromOklch({ l: 0.28, c: Math.min(0.04, c * 0.25), h: h }), surface, 7);
  const ink2 = ensureContrast(fromOklch({ l: 0.52, c: Math.min(0.03, c * 0.2), h: h }), surface, 4.5);

  // Text that has to sit ON the accent (button labels, the quote banner).
  const onAccent = fitted.on;
  const onDark = "#f4f7fa";
  const dark = fromOklch({ l: 0.26, c: Math.min(0.05, c * 0.3), h: h });

  const palette = {
    seed: seed,
    accent: accent,
    accentHover: accentHover,
    onAccent: onAccent,
    surface: surface,
    surface2: surface2,
    tint: tint,
    line: line,
    ink: ink,
    ink2: ink2,
    dark: dark,
    onDark: ensureContrast(onDark, dark, 4.5)
  };

  palette.contrast = {
    inkOnSurface: round2(contrast(palette.ink, palette.surface)),
    ink2OnSurface: round2(contrast(palette.ink2, palette.surface)),
    onAccentOnAccent: round2(contrast(palette.onAccent, palette.accent)),
    inkOnTint: round2(contrast(palette.ink, palette.tint)),
    onDarkOnDark: round2(contrast(palette.onDark, palette.dark))
  };
  palette.passesAA = Object.values(palette.contrast).every((r) => r >= 4.5);

  return palette;
}

/**
 * A button label has to be legible on its own button. Picking the better of
 * black/white is not enough — mid-lightness hues (oranges around hue 15, the
 * classic case) top out around 4.4:1 either way. So we also move the FILL
 * until the pairing clears AA, trying both label colours and keeping whichever
 * needed the smaller shift, so the accent stays as close to what was asked for
 * as legibility allows.
 */
function fitAccent(accent) {
  const candidates = ["#ffffff", "#101418"];
  let best = null;

  for (const on of candidates) {
    if (contrast(on, accent) >= 4.5) {
      const shift = 0;
      if (!best || shift < best.shift) best = { accent: accent, on: on, shift: shift };
      continue;
    }
    const o = toOklch(accent);
    // white label -> darken the fill; dark label -> lighten it
    const dir = relLuminance(on) > 0.5 ? -1 : 1;
    for (let i = 1; i <= 40; i++) {
      const l = Math.min(1, Math.max(0, o.l + dir * i * 0.02));
      const candidate = fromOklch({ l: l, c: o.c, h: o.h });
      if (contrast(on, candidate) >= 4.5) {
        if (!best || i < best.shift) best = { accent: candidate, on: on, shift: i };
        break;
      }
      if (l === 0 || l === 1) break;
    }
  }

  return best || { accent: accent, on: pickOn(accent), shift: 99 };
}

/** Black or white on this fill — whichever is more legible. */
function pickOn(bg) {
  const white = contrast("#ffffff", bg);
  const black = contrast("#101418", bg);
  return white >= black ? "#ffffff" : "#101418";
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

/* ================= refine: "make it darker" ================= */

/** Shortest-path hue rotation toward `target`, capped at `maxStep` degrees. */
function hueTowards(h, target, maxStep) {
  const diff = ((target - h + 540) % 360) - 180;   // -180..180
  const step = Math.sign(diff) * Math.min(Math.abs(diff), maxStep);
  return (h + step + 360) % 360;
}

const SHIFT_KINDS = ["darker", "lighter", "bolder", "muted", "warmer", "cooler"];

/**
 * Move an existing accent colour along one perceptual axis. Used by the
 * refine grammar (docs/AGENT-PARITY-PLAN.md §4.2) so "make it darker" moves
 * THIS site's actual colour rather than picking a new one from scratch.
 * @param {string} hex
 * @param {"darker"|"lighter"|"bolder"|"muted"|"warmer"|"cooler"} kind
 */
function shift(hex, kind) {
  const o = toOklch(hex);
  if (!o) return hex;
  let { l, c, h } = o;
  switch (kind) {
    case "darker":  l = clamp(l - 0.11, 0.18, 0.9); break;
    case "lighter": l = clamp(l + 0.11, 0.18, 0.9); break;
    case "bolder":  c = Math.min(0.33, c * 1.35 + 0.02); break;
    case "muted":   c = Math.max(0.015, c * 0.55); break;
    case "warmer":  h = hueTowards(h, 40, 45); break;    // toward orange
    case "cooler":  h = hueTowards(h, 230, 45); break;   // toward blue
    default: return hex;
  }
  return fromOklch({ l, c, h });
}

module.exports = {
  build, contrast, ensureContrast, toOklch, fromOklch, hexToRgb, rgbToHex, INDUSTRY_SEED,
  shift, SHIFT_KINDS
};
