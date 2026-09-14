/* =================================================================
   slots.js — pull the concrete facts out of a prompt
   -----------------------------------------------------------------
   The classifier says *what kind* of business it is. This says what is
   specific about THIS one: its name, its city, what it sells, which
   features it needs, what tone to write in, what colour to use.

   Those specifics are what make generated copy feel written rather
   than assembled — "Roasted in Istanbul" reads as understanding, and
   costs nothing. See docs/NO-API-BUILDER-PLAN.md §3.3.

   Every rule here is tuned for PRECISION over recall: a wrong city is
   worse than no city, because a missing slot simply removes the copy
   variants that needed it.
   ================================================================= */
"use strict";

const { fold, analyse } = require("./normalise");

/* ---- cities ------------------------------------------------------- */
/* Folded forms — matched against the folded prompt. `label` is what gets
   printed back to the user (so "istanbul" renders as "Istanbul"). */
const CITIES = {
  // Türkiye
  istanbul: "Istanbul", ankara: "Ankara", izmir: "İzmir", bursa: "Bursa", antalya: "Antalya",
  adana: "Adana", konya: "Konya", gaziantep: "Gaziantep", mersin: "Mersin", kayseri: "Kayseri",
  eskisehir: "Eskişehir", trabzon: "Trabzon", samsun: "Samsun", denizli: "Denizli", malatya: "Malatya",
  diyarbakir: "Diyarbakır", sanliurfa: "Şanlıurfa", kocaeli: "Kocaeli", sakarya: "Sakarya",
  mugla: "Muğla", bodrum: "Bodrum", alanya: "Alanya", kadikoy: "Kadıköy", besiktas: "Beşiktaş",
  // MENA
  dubai: "Dubai", "abu dhabi": "Abu Dhabi", sharjah: "Sharjah", doha: "Doha", riyadh: "Riyadh",
  jeddah: "Jeddah", dammam: "Dammam", mecca: "Mecca", medina: "Medina", kuwait: "Kuwait City",
  manama: "Manama", muscat: "Muscat", amman: "Amman", beirut: "Beirut", damascus: "Damascus",
  aleppo: "Aleppo", baghdad: "Baghdad", erbil: "Erbil", basra: "Basra", cairo: "Cairo",
  alexandria: "Alexandria", casablanca: "Casablanca", rabat: "Rabat", tunis: "Tunis", algiers: "Algiers",
  tripoli: "Tripoli", khartoum: "Khartoum", sanaa: "Sanaa", aden: "Aden",
  // Europe / other common
  london: "London", manchester: "Manchester", berlin: "Berlin", munich: "Munich", hamburg: "Hamburg",
  cologne: "Cologne", frankfurt: "Frankfurt", paris: "Paris", lyon: "Lyon", marseille: "Marseille",
  amsterdam: "Amsterdam", rotterdam: "Rotterdam", brussels: "Brussels", vienna: "Vienna",
  zurich: "Zurich", milan: "Milan", rome: "Rome", madrid: "Madrid", barcelona: "Barcelona",
  lisbon: "Lisbon", warsaw: "Warsaw", prague: "Prague", stockholm: "Stockholm", oslo: "Oslo",
  copenhagen: "Copenhagen", dublin: "Dublin", athens: "Athens", sofia: "Sofia", bucharest: "Bucharest",
  // Arabic spellings
  "دبي": "Dubai", "الرياض": "Riyadh", "جده": "Jeddah", "الدوحه": "Doha", "الكويت": "Kuwait City",
  "بيروت": "Beirut", "عمان": "Amman", "بغداد": "Baghdad", "القاهره": "Cairo", "الاسكندريه": "Alexandria",
  "دمشق": "Damascus", "حلب": "Aleppo", "اسطنبول": "Istanbul", "انقره": "Ankara"
};

const CURRENCY_BY_CITY = {
  Istanbul: "₺", Ankara: "₺", "İzmir": "₺", Bursa: "₺", Antalya: "₺", Adana: "₺", Konya: "₺",
  Gaziantep: "₺", Mersin: "₺", Kayseri: "₺", "Eskişehir": "₺", Trabzon: "₺", Samsun: "₺",
  Denizli: "₺", Malatya: "₺", "Diyarbakır": "₺", "Şanlıurfa": "₺", Kocaeli: "₺", Sakarya: "₺",
  "Muğla": "₺", Bodrum: "₺", Alanya: "₺", "Kadıköy": "₺", "Beşiktaş": "₺",
  Dubai: "AED", "Abu Dhabi": "AED", Sharjah: "AED", Doha: "QAR", Riyadh: "﷼", Jeddah: "﷼",
  Dammam: "﷼", Mecca: "﷼", Medina: "﷼", "Kuwait City": "KWD", Manama: "BHD", Muscat: "OMR",
  Amman: "JOD", Beirut: "$", Cairo: "EGP", Alexandria: "EGP", Casablanca: "MAD", Rabat: "MAD",
  London: "£", Manchester: "£", Dublin: "€"
};

/* ---- features ----------------------------------------------------- */
/* Closed vocabulary — each one changes which blocks get composed. */
const FEATURES = {
  booking:   { en: ["booking", "book a", "appointment", "reservation", "reserve", "slot", "schedule a"], tr: ["randevu", "rezervasyon"], ar: ["حجز", "موعد", "مواعيد"] },
  delivery:  { en: ["delivery", "deliver", "we deliver", "shipping to", "courier"], tr: ["teslimat", "paket servis", "kurye"], ar: ["توصيل", "دليفري"] },
  ordering:  { en: ["online order", "order online", "ordering", "click and collect", "takeaway", "pickup"], tr: ["online sipariş", "sipariş", "gel al"], ar: ["طلب اونلاين", "الطلب", "استلام"] },
  tracking:  { en: ["tracking", "track", "where their parcel", "consignment", "trace"], tr: ["takip", "kargo takip"], ar: ["تتبع", "متابعة الشحنة"] },
  menu:      { en: ["menu", "dishes", "what we serve"], tr: ["menü", "yemek listesi"], ar: ["منيو", "قائمة الطعام"] },
  catalogue: { en: ["catalogue", "catalog", "product range", "our products", "browse"], tr: ["katalog", "ürün yelpazesi", "ürünler"], ar: ["كتالوج", "المنتجات", "تشكيلة"] },
  quotes:    { en: ["quote", "rfq", "request a price", "estimate", "tender"], tr: ["teklif", "fiyat teklifi", "keşif"], ar: ["عرض سعر", "تسعيرة", "معاينة"] },
  gallery:   { en: ["portfolio", "gallery", "photos", "before and after", "our work", "projects"], tr: ["portföy", "galeri", "fotoğraf", "projelerimiz"], ar: ["معرض", "صور", "مشاريع", "أعمالنا"] },
  reviews:   { en: ["reviews", "testimonials", "what customers say", "ratings"], tr: ["yorumlar", "referans", "müşteri yorumları"], ar: ["آراء", "تقييمات", "شهادات"] },
  branches:  { en: ["branches", "locations", "stores in", "multi branch", "our shops"], tr: ["şube", "şubelerimiz", "mağazalarımız"], ar: ["فروع", "فروعنا", "مواقعنا"] },
  accounts:  { en: ["trade account", "open an account", "account terms", "price list", "b2b", "wholesale pricing"], tr: ["cari hesap", "bayilik", "fiyat listesi"], ar: ["حساب", "قائمة أسعار", "جملة"] }
};

/* ---- tone --------------------------------------------------------- */
const TONE = {
  premium:   { en: ["premium", "luxury", "high end", "exclusive", "bespoke", "elegant", "refined", "boutique"], tr: ["lüks", "premium", "özel", "şık"], ar: ["فاخر", "راقي", "حصري", "أنيق"] },
  technical: { en: ["industrial", "spec", "tolerance", "certified", "iso", "engineering", "precision", "compliance"], tr: ["endüstriyel", "teknik", "sertifika", "hassas"], ar: ["صناعي", "تقني", "مواصفات", "شهادة"] },
  playful:   { en: ["fun", "playful", "colourful", "colorful", "friendly", "quirky", "cheerful", "kids"], tr: ["eğlenceli", "renkli", "samimi", "çocuk"], ar: ["مرح", "ملون", "ودود", "أطفال"] },
  warm:      { en: ["family", "handmade", "homemade", "local", "small batch", "traditional", "cosy", "cozy", "artisan"], tr: ["aile", "el yapımı", "ev yapımı", "geleneksel", "yerel"], ar: ["عائلي", "يدوي", "بيتي", "تقليدي", "محلي"] }
};

/* ---- colour ------------------------------------------------------- */
const COLOURS = {
  red: "#c0392b", orange: "#d35400", amber: "#c58a1a", yellow: "#c9a227", gold: "#b08d3a",
  green: "#2f855a", emerald: "#1f7a5c", mint: "#2aa889", teal: "#178f8f", turquoise: "#12a5a5",
  blue: "#1f6fb2", navy: "#12365c", sky: "#2a93d4", indigo: "#4a4fa8",
  purple: "#6b4b9e", violet: "#7a4fb0", pink: "#c2478a", magenta: "#b53a86",
  brown: "#8a5a2b", beige: "#a08a6a", cream: "#a8926b",
  black: "#1c1c1c", grey: "#5a6470", gray: "#5a6470", silver: "#7b8794", cyan: "#1aa6df"
};
const COLOUR_WORDS = {
  tr: { kirmizi: "red", turuncu: "orange", sari: "yellow", altin: "gold", yesil: "green", mavi: "blue",
    lacivert: "navy", turkuaz: "turquoise", mor: "purple", pembe: "pink", kahverengi: "brown",
    bej: "beige", krem: "cream", siyah: "black", gri: "grey", beyaz: "white" },
  ar: { "احمر": "red", "برتقالي": "orange", "اصفر": "yellow", "ذهبي": "gold", "اخضر": "green",
    "ازرق": "blue", "كحلي": "navy", "فيروزي": "turquoise", "بنفسجي": "purple", "وردي": "pink",
    "بني": "brown", "بيج": "beige", "اسود": "black", "رمادي": "grey" }
};

/* ---- company name -------------------------------------------------- */
const NAME_STOP = new Set(["a", "an", "the", "my", "our", "your", "for", "with", "and", "of", "in", "on",
  "site", "website", "web", "page", "shop", "store", "business", "company", "bir", "icin", "ile", "site",
  "sitesi", "dukkan", "magaza", "sirket", "firma", "موقع", "شركة", "محل", "متجر"]);

const NAME_PATTERNS = [
  // "... called X", "... named X"  — stop at the next clause
  /(?:called|named)\s+([A-Za-zÀ-ÿĞğİıŞşÖöÜüÇç0-9'&.\- ]{2,40}?)(?=\s+(?:with|that|which|for|and|selling|offering|in|near)\b|[,.;]|$)/i,
  // Turkish: "X adında", "X isimli"
  /([A-Za-zÀ-ÿĞğİıŞşÖöÜüÇç0-9'&.\-]{2,30}(?:\s+[A-Za-zÀ-ÿĞğİıŞşÖöÜüÇç0-9'&.\-]{2,30})?)\s+(?:adında|adlı|isimli)/i,
  // Arabic: "اسمها X" / "باسم X"
  /(?:اسمها|اسمه|باسم)\s+([^\s,.;]{2,30}(?:\s+[^\s,.;]{2,30})?)/,
  // Title-Case run of 1–3 words that is not a sentence start
  /(?:^|\s)((?:[A-ZÀ-Ý][A-Za-zÀ-ÿ0-9'&.\-]{1,20})(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ0-9'&.\-]{1,20}){0,2})(?=\s|[,.;]|$)/
];

/* ================================================================= */

/**
 * @param {string} text
 * @param {string} [lang]  from classify(); avoids detecting twice
 * @returns {{company:string, city:string, currency:string, features:string[],
 *            tone:string, colour:string|null, colourWord:string|null, lang:string}}
 */
function extract(text, lang) {
  const raw = String(text || "");
  const a = analyse(raw, lang);
  const L = a.lang;
  const folded = a.folded;

  const city = findCity(folded);

  return {
    company: findCompany(raw, city),
    city: city,
    currency: (city && CURRENCY_BY_CITY[city]) || defaultCurrency(L),
    features: findFeatures(folded, L),
    tone: findTone(folded, L),
    colour: findColour(folded, L).hex,
    colourWord: findColour(folded, L).word,
    lang: L
  };
}

function findCity(folded) {
  // longest key first so "abu dhabi" beats a stray "dhabi"
  const keys = Object.keys(CITIES).sort((x, y) => y.length - x.length);
  for (const key of keys) {
    const re = new RegExp("(^|[^\\p{L}])" + escapeRe(key) + "([^\\p{L}]|$)", "u");
    if (re.test(folded)) return CITIES[key];
  }
  return "";
}

function findCompany(raw, city) {
  for (const re of NAME_PATTERNS) {
    const m = re.exec(raw);
    if (!m) continue;
    const cleaned = cleanName(m[1], city);
    if (cleaned) return cleaned;
  }
  return "";
}

function cleanName(s, city) {
  if (!s) return "";
  const words = String(s).trim().split(/\s+/)
    .filter((w) => !NAME_STOP.has(fold(w)))
    .slice(0, 4);
  const out = words.join(" ").replace(/[^A-Za-zÀ-ÿĞğİıŞşÖöÜüÇç0-9'&.\- ؀-ۿ]/g, "").trim();
  if (out.length < 2) return "";
  // a bare city name is a location, not a business name
  if (city && fold(out) === fold(city)) return "";
  return out.slice(0, 60);
}

function findFeatures(folded, lang) {
  const found = [];
  for (const [name, byLang] of Object.entries(FEATURES)) {
    const terms = (byLang[lang] || []).concat(lang === "en" ? [] : byLang.en || []);
    if (terms.some((t) => folded.includes(fold(t)))) found.push(name);
  }
  return found;
}

function findTone(folded, lang) {
  // first match wins by declaration order: premium > technical > playful > warm
  for (const [name, byLang] of Object.entries(TONE)) {
    const terms = (byLang[lang] || []).concat(lang === "en" ? [] : byLang.en || []);
    if (terms.some((t) => folded.includes(fold(t)))) return name;
  }
  return "neutral";
}

function findColour(folded, lang) {
  const localised = COLOUR_WORDS[lang] || {};
  for (const [word, english] of Object.entries(localised)) {
    if (wordIn(folded, word)) return { hex: COLOURS[english] || null, word: english };
  }
  for (const word of Object.keys(COLOURS)) {
    if (wordIn(folded, word)) return { hex: COLOURS[word], word: word };
  }
  return { hex: null, word: null };
}

function wordIn(folded, word) {
  return new RegExp("(^|[^\\p{L}])" + escapeRe(fold(word)) + "([^\\p{L}]|$)", "u").test(folded);
}

function defaultCurrency(lang) {
  return lang === "tr" ? "₺" : lang === "ar" ? "﷼" : "$";
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

module.exports = { extract, CITIES, FEATURES, TONE, COLOURS };
