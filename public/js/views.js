/* =================================================================
   MERVEKS SAP — module views
   Each function renders one screen into the content element and wires
   its own events. Mutations go through Store (which records them to
   the audit history) and then call App.reload() to repaint.
   ================================================================= */
window.Views = (function () {
  const { icon, money, usd, toUSD, num, date, dateTime, rel, initials, flag, esc, avColor, toast, modal, closeModal, drawer, confirm } = UI;
  const T = (k) => UI.t(k);
  let _cachedProducts = [];

  /* ---- status colour maps ---- */
  const SH_ST = { "Booked": "blue", "In Transit": "amber", "Customs": "orange", "On Hold": "slate", "Delivered": "green", "Cancelled": "red" };
  const ORD_ST = { "Pending": "amber", "Confirmed": "blue", "Shipped": "purple", "Completed": "green", "Cancelled": "red" };
  const INV_ST = { "Draft": "slate", "Sent": "blue", "Partial": "amber", "Paid": "green", "Overdue": "red" };
  const QUO_ST = { "Draft": "slate", "Sent": "blue", "Accepted": "green", "Rejected": "red", "Expired": "amber" };
  const PO_ST = { "Draft": "slate", "Sent": "blue", "Received": "green", "Cancelled": "red" };
  const BILL_ST = { "Unpaid": "blue", "Partial": "amber", "Paid": "green", "Overdue": "red" };
  const PROD_ST = { "In stock": "green", "Low": "amber", "Out of stock": "red" };
  const CLI_ST = { "Active": "green", "On hold": "amber", "Inactive": "slate" };

  /* STATUS_TR: used only as fallback when UI.t() has no key registered.
     The tr() helper respects the active language — in EN mode it returns
     the English key unchanged; in TR mode it uses UI.t() which covers
     both STATUS_TR values AND the full TRANSLATIONS table in ui.js. */
  const STATUS_TR = {
    "All": "Tümü",
    "Booked": "Rezerve",
    "In Transit": "Yolda",
    "Customs": "Gümrükte",
    "On Hold": "Beklemede",
    "Delivered": "Teslim Edildi",
    "Cancelled": "İptal Edildi",
    "Pending": "Bekliyor",
    "Confirmed": "Onaylandı",
    "Shipped": "Sevk Edildi",
    "Completed": "Tamamlandı",
    "Draft": "Taslak",
    "Sent": "Gönderildi",
    "Paid": "Ödendi",
    "Overdue": "Gecikmiş",
    "In stock": "Stokta",
    "Low": "Kritik",
    "Out of stock": "Stok Dışı",
    "Active": "Aktif",
    "Inactive": "Pasif",
    "On hold": "Beklemede",
    "Railway": "Demiryolu",
    "Road": "Karayolu",
    "Sea": "Denizyolu",
    "Multimodal": "Çoklu Taşıma",
    "Owner": "Kurucu",
    "Operations Manager": "Operasyon Müdürü",
    "Finance Officer": "Finans Yetkilisi",
    "Trade Specialist": "Ticaret Uzmanı",
    "Employee": "Çalışan",
    // audit action / entity names
    "create": "Oluştur",
    "update": "Güncelle",
    "delete": "Sil",
    "login": "Giriş",
    "logout": "Çıkış",
    "shipment": "Sevkiyat",
    "order": "Sipariş",
    "product": "Ürün",
    "client": "Müşteri",
    "supplier": "Tedarikçi",
    "invoice": "Fatura",
    "quote": "Teklif",
    "user": "Kullanıcı",
    "session": "Oturum"
  };

  /* Language-aware status/label translator.
     - EN mode: return the English key as-is.
     - TR mode: try UI.t() first (covers the full TRANSLATIONS table),
       then fall back to STATUS_TR, then the raw key. */
  function tr(key) {
    if (!key) return "";
    if (UI.getLang && UI.getLang() === "en") return key;
    const fromUI = UI.t(key);
    if (fromUI !== key) return fromUI;           // UI.t() had a match
    return STATUS_TR[key] || key;                // STATUS_TR fallback
  }

  function badge(status, map) { return '<span class="st ' + (map[status] || "slate") + '">' + esc(tr(status)) + "</span>"; }
  function stars(n) { let s = ""; for (let i = 0; i < 5; i++) s += '<span style="color:' + (i < n ? "var(--gold)" : "var(--line)") + '">★</span>'; return '<span style="letter-spacing:1px">' + s + "</span>"; }
  function avatar(name, sub) {
    return '<div class="cell-id"><span class="mini-av" style="background:' + avColor(name) + '">' + initials(name) + "</span>" +
      '<div><div class="strong">' + esc(name) + "</div>" + (sub ? '<div class="ci-sub">' + esc(tr(sub)) + "</div>" : "") + "</div></div>";
  }
  function productStatus(stock, reorder) { return stock <= 0 ? "Out of stock" : stock <= reorder ? "Low" : "In stock"; }

  /* read form fields by [name]; data-type="number" coerces */
  function readForm(scope) {
    const o = {};
    scope.querySelectorAll("[name]").forEach((inp) => {
      let v = inp.value;
      if (inp.dataset.type === "number") v = v === "" ? 0 : Number(v);
      o[inp.name] = v;
    });
    return o;
  }
  function field(label, html, req) {
    return '<div class="field"><label>' + esc(label) + (req ? ' <span class="req">*</span>' : "") + "</label>" + html + "</div>";
  }
  function sel(name, value, options) {
    return '<select class="select" name="' + name + '">' +
      options.map((o) => '<option' + (o === value ? " selected" : "") + ">" + esc(tr(o)) + "</option>").join("") + "</select>";
  }
  function toolbar(searchId, segs, addLabel, addId, area) {
    const showAdd = addLabel && (!area || Auth.can(area, "edit"));
    return '<div class="toolbar">' +
      '<div class="search">' + icon("search") + '<input id="' + searchId + '" placeholder="' + T("Search…") + '" autocomplete="off"></div>' +
      (segs || "") +
      '<div class="grow"></div>' +
      (showAdd ? '<button class="btn btn-primary" id="' + addId + '">' + icon("plus") + esc(tr(addLabel)) + "</button>" : "") +
      "</div>";
  }
  // permission-gated row action buttons (edit / delete)
  function rowActs(area) {
    let h = "";
    if (Auth.can(area, "edit")) h += '<button class="icon-btn" data-edit>' + icon("edit") + "</button>";
    if (Auth.can(area, "delete")) h += '<button class="icon-btn danger" data-del>' + icon("trash") + "</button>";
    return h ? '<div class="row-actions" style="margin-top:2px">' + h + "</div>" : "";
  }
  function emptyRow(cols, msg) { return '<tr><td colspan="' + cols + '"><div class="empty">' + icon("box") + '<h4>' + UI.t("Nothing here yet") + '</h4><p>' + esc(msg || UI.t("No records match your filter.")) + '</p></div></td></tr>'; }

  // wire live text search over table rows
  function liveSearch(inputId) {
    const inp = document.getElementById(inputId); if (!inp) return;
    inp.addEventListener("input", () => {
      const q = inp.value.toLowerCase();
      inp.closest(".content").querySelectorAll("tbody tr[data-row]").forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  }
  // segmented status filter
  function segFilter(items, active) {
    return '<div class="seg" data-seg>' + items.map((i) =>
      '<button data-f="' + esc(i) + '"' + (i === active ? ' class="active"' : "") + ">" + esc(tr(i)) + "</button>").join("") + "</div>";
  }

  /* Industry-aware page header. If the active workspace renames this module
     (e.g. Clients → Customers), use that label + its subtitle; otherwise fall
     back to the module's default translated title/subtitle. */
  function indTitle(id, defTitle, defSub) {
    const ws = window.Workspace;
    const ov = ws && ws.label(id);
    const title = ov ? ov[0] : UI.t(defTitle);
    const sub = ov && ov[1] ? ov[1] : UI.t(defSub);
    return '<div class="section-title"><div><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div></div>';
  }

  /* =============================================================
     DASHBOARD HERO ART — a unique animated scene per industry.
     Each returns a self-contained 460×180 SVG tuned to the navy hero
     strip. Logistics keeps its rail corridor; the others get their own
     signature motion (order flow, distribution fan-out, retail POS).
     ============================================================= */
  function heroArt(key) {
    if (key === "ecommerce")     return heroEcommerce();
    if (key === "wholesale")     return heroWholesale();
    if (key === "retail")        return heroRetail();
    if (key === "manufacturing") return heroManufacturing();
    if (key === "restaurant")    return heroRestaurant();
    if (key === "construction")  return heroConstruction();
    if (key === "services")      return heroServices();
    return heroLogistics();
  }

  /* ---- shared premium toolkit (filters · atmosphere · motion helpers) ----
     Only one scene renders at a time, so all scenes can reuse these ids. */
  const HERO_DEFS =
    '<filter id="h-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    '<filter id="h-glow" x="-90%" y="-90%" width="280%" height="280%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    // neon bloom (double-pass) for comets, focal nodes and energy
    '<filter id="h-bloom" x="-160%" y="-160%" width="420%" height="420%"><feGaussianBlur stdDeviation="4.5" result="b1"/><feGaussianBlur stdDeviation="9" result="b2"/><feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    '<radialGradient id="h-vig" cx="50%" cy="44%" r="62%"><stop offset="52%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#02101f" stop-opacity=".5"/></radialGradient>' +
    '<linearGradient id="h-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#eaf6ff" stop-opacity="0"/><stop offset="50%" stop-color="#eaf6ff" stop-opacity=".4"/><stop offset="100%" stop-color="#eaf6ff" stop-opacity="0"/></linearGradient>';

  // full-scene atmosphere: vignette depth + slow drifting orbs + parallax dust
  const HERO_STARS = (function () {
    var p = "";
    var pts = [[40,30,1.0,0],[88,18,.7,1.1],[150,40,.6,2.0],[210,16,.9,.5],[268,52,.6,1.6],[300,12,1.0,.8],[348,34,.7,2.3],[392,20,.8,.3],[430,52,.9,1.4],[60,72,.6,1.0],[120,92,.5,2.1],[236,128,.6,.7],[330,98,.6,1.9],[418,104,.7,1.2],[24,120,.8,.4],[200,150,.5,2.4]];
    pts.forEach(function (q) { p += '<circle cx="'+q[0]+'" cy="'+q[1]+'" r="'+q[2]+'" fill="#d6ecff" class="h-tw" style="--d:'+(2.2+q[3]).toFixed(1)+'s;animation-delay:'+q[3]+'s"/>'; });
    return '<rect width="460" height="180" fill="url(#h-vig)"/>' +
      '<g filter="url(#h-glow)">' +
        '<circle cx="120" cy="64" r="58" fill="#3a7bd0" opacity=".08"><animate attributeName="cx" values="120;152;120" dur="15s" repeatCount="indefinite"/><animate attributeName="opacity" values=".05;.11;.05" dur="7.5s" repeatCount="indefinite"/></circle>' +
        '<circle cx="360" cy="120" r="68" fill="#2f6fb0" opacity=".07"><animate attributeName="cy" values="120;94;120" dur="17s" repeatCount="indefinite"/></circle>' +
      '</g>' + p;
  })();

  // glassy light sweep drawn ON TOP of each scene (appended before </svg>)
  const HERO_SHEEN =
    '<rect x="-110" y="-30" width="64" height="240" fill="url(#h-sheen)" transform="skewX(-19)" opacity="0">' +
      '<animate attributeName="x" values="-110;-110;560" keyTimes="0;.62;1" dur="7.5s" repeatCount="indefinite" calcMode="spline" keySplines="0 0 1 1;.45 0 .55 1"/>' +
      '<animate attributeName="opacity" values="0;0;.5;0" keyTimes="0;.62;.8;1" dur="7.5s" repeatCount="indefinite"/></rect>';

  const HERO_TW_KEYS =
    '.h-tw{animation:h-tw var(--d,3s) ease-in-out infinite}@keyframes h-tw{0%,100%{opacity:.08}50%{opacity:.62}}' +
    '.h-flow{stroke-dasharray:9 12;animation:h-flow var(--fd,2.2s) linear infinite}@keyframes h-flow{to{stroke-dashoffset:-42}}' +
    '.h-float{animation:h-float var(--ft,6s) ease-in-out infinite}@keyframes h-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}';

  // glowing light comet racing along a path, leaving a soft streak
  function heroComet(path, color, dur, begin) {
    return '<g filter="url(#h-bloom)"><g>' +
      '<ellipse cx="0" cy="0" rx="10" ry="1.7" fill="'+color+'" opacity=".5"/>' +
      '<circle r="3.4" fill="'+color+'" opacity=".55"/><circle r="1.9" fill="#fff"/>' +
      '<animateMotion dur="'+dur+'" begin="'+begin+'" repeatCount="indefinite" rotate="auto" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".5 0 .5 1" path="'+path+'"/>' +
      '</g></g>';
  }
  // expanding ring that fires when something "arrives"
  function heroBurst(x, y, color, dur, begin) {
    return '<circle cx="'+x+'" cy="'+y+'" r="3" fill="none" stroke="'+color+'" stroke-width="2.4">' +
      '<animate attributeName="r" values="3;22" dur="'+dur+'" begin="'+begin+'" repeatCount="indefinite" calcMode="spline" keySplines=".2 .6 .3 1"/>' +
      '<animate attributeName="opacity" values=".85;0" dur="'+dur+'" begin="'+begin+'" repeatCount="indefinite"/>' +
      '<animate attributeName="stroke-width" values="2.6;0" dur="'+dur+'" begin="'+begin+'" repeatCount="indefinite"/></circle>';
  }
  // a path rendered as a glowing energy channel with flowing dashes
  function heroFlow(path, color, w) {
    return '<path d="'+path+'" stroke="'+color+'" stroke-width="'+(w+10)+'" stroke-linecap="round" opacity=".16" filter="url(#h-glow)"/>' +
      '<path d="'+path+'" stroke="'+color+'" stroke-width="'+w+'" opacity=".4"/>' +
      '<path d="'+path+'" stroke="'+color+'" stroke-width="'+w+'" class="h-flow"/>';
  }

  /* ---- LOGISTICS · rail corridor Mersin → İstanbul → Baku ---- */
  function heroLogistics() {
    const routeD = "M 32 148 C 100 148, 130 44, 220 44 S 380 90, 428 28";
    const node = (x, y, fill, dark, mid, hot, dur, begin) =>
      '<g filter="url(#h-soft)">' +
        '<circle cx="' + x + '" cy="' + y + '" r="9" fill="' + fill + '"><animate attributeName="r" from="8" to="22" dur="' + dur + '" repeatCount="indefinite" begin="' + begin + '"/><animate attributeName="opacity" from=".4" to="0" dur="' + dur + '" repeatCount="indefinite" begin="' + begin + '"/></circle>' +
        '<circle cx="' + x + '" cy="' + y + '" r="8" fill="' + dark + '"/><circle cx="' + x + '" cy="' + y + '" r="5" fill="' + mid + '"/><circle cx="' + x + '" cy="' + y + '" r="2.3" fill="' + hot + '"/>' +
      '</g>';
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<linearGradient id="h-rg" gradientUnits="userSpaceOnUse" x1="32" y1="148" x2="428" y2="28"><stop offset="0%" stop-color="#5fe0a8"/><stop offset="48%" stop-color="#5fb0ff"/><stop offset="100%" stop-color="#e6b964"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '.h-rt{stroke-dasharray:9 7;animation:h-d 5s linear infinite}@keyframes h-d{to{stroke-dashoffset:-64}}</style>' +
      HERO_STARS +
      '<path d="M0 152 H460" stroke="rgba(255,255,255,.06)"/>' +
      '<path d="' + routeD + '" stroke="rgba(95,176,255,.22)" stroke-width="14" stroke-linecap="round" filter="url(#h-glow)"/>' +
      '<path d="' + routeD + '" stroke="url(#h-rg)" stroke-width="2.5" class="h-rt"/>' +
      heroComet(routeD, "#aef0ff", "4.2s", "0s") +
      node(32, 148, "#5fe0a8", "#1a3d28", "#5fe0a8", "#c0fff0", "2.5s", "0s") +
      node(220, 44, "#5fb0ff", "#0d2a45", "#5fb0ff", "#e0f2ff", "2.8s", ".9s") +
      node(428, 28, "#e6b964", "#3a2a0a", "#e6b964", "#fff4d0", "3s", "1.8s") +
      heroBurst(220, 44, "#9fd8ff", "4.2s", "1.9s") + heroBurst(428, 28, "#ffe1a0", "4.2s", "3.6s") +
      '<g font-family="Inter,sans-serif" font-size="12.5" font-weight="700">' +
        '<text x="32" y="170" text-anchor="middle" fill="rgba(140,220,180,.95)">Mersin</text>' +
        '<text x="220" y="31" text-anchor="middle" fill="rgba(150,200,240,.95)">' + UI.t("Istanbul") + '</text>' +
        '<text x="428" y="14" text-anchor="middle" fill="rgba(230,185,100,.95)">' + UI.t("Baku") + '</text>' +
      '</g>' +
      '<g filter="url(#h-glow)"><g><rect x="-12" y="-7" width="24" height="14" rx="3.2" fill="#fff" opacity=".96"/><line x1="-5" y1="-7" x2="-5" y2="7" stroke="rgba(26,166,223,.5)" stroke-width=".9"/><line x1="2.5" y1="-7" x2="2.5" y2="7" stroke="rgba(26,166,223,.5)" stroke-width=".9"/><animateMotion dur="4.2s" repeatCount="indefinite" rotate="auto" path="' + routeD + '"/></g></g>' +
      HERO_SHEEN +
      '</svg>';
  }

  /* ---- E-COMMERCE · click → cart → parcel → doorstep ---- */
  function heroEcommerce() {
    const arc = "M 86 116 C 170 116, 250 52, 392 60";
    const parcel = (begin) =>
      '<g opacity="0"><g transform="translate(-9,-8)">' +
        '<rect width="18" height="16" rx="2.6" fill="#fff" opacity=".97"/>' +
        '<rect width="18" height="6" rx="2.6" fill="#c9b8ff"/>' +
        '<line x1="9" y1="0" x2="9" y2="16" stroke="#7c5cff" stroke-width="1.1"/>' +
      '</g>' +
      '<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.08;.9;1" dur="3.4s" begin="' + begin + '" repeatCount="indefinite"/>' +
      '<animateMotion dur="3.4s" begin="' + begin + '" repeatCount="indefinite" rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".42 0 .58 1" path="' + arc + '"/></g>';
    const chip = (x, glyph, fill, begin) =>
      '<g transform="translate(' + x + ',96)" opacity="0">' + glyph(fill) +
        '<animateTransform attributeName="transform" type="translate" values="' + x + ',96;' + x + ',58" dur="2.6s" begin="' + begin + '" repeatCount="indefinite"/>' +
        '<animate attributeName="opacity" values="0;.9;0" dur="2.6s" begin="' + begin + '" repeatCount="indefinite"/>' +
      '</g>';
    const heart = (f) => '<path d="M0 -3 C -2 -6 -6 -4 -6 -1 C -6 2 -2 4 0 6 C 2 4 6 2 6 -1 C 6 -4 2 -6 0 -3 Z" fill="' + f + '"/>';
    const star  = (f) => '<path d="M0 -6 L1.8 -1.8 L6 -1.6 L2.6 1.4 L3.8 6 L0 3.2 L-3.8 6 L-2.6 1.4 L-6 -1.6 L-1.8 -1.8 Z" fill="' + f + '"/>';
    const plus  = (f) => '<circle r="7" fill="' + f + '"/><path d="M-3 0 H3 M0 -3 V3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>';
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<linearGradient id="h-ec" gradientUnits="userSpaceOnUse" x1="86" y1="116" x2="392" y2="60"><stop offset="0%" stop-color="#7c5cff"/><stop offset="60%" stop-color="#9b8bff"/><stop offset="100%" stop-color="#5fd0ff"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '.h-rt{stroke-dasharray:8 8;animation:h-d 4s linear infinite}@keyframes h-d{to{stroke-dashoffset:-64}}</style>' +
      HERO_STARS +
      '<path d="M0 152 H460" stroke="rgba(255,255,255,.06)"/>' +
      // dashed delivery arc + glow
      '<path d="' + arc + '" stroke="rgba(124,92,255,.22)" stroke-width="13" stroke-linecap="round" filter="url(#h-glow)"/>' +
      '<path d="' + arc + '" stroke="url(#h-ec)" stroke-width="2.4" class="h-rt"/>' +
      // LEFT: store browser window with a glowing cart
      '<g filter="url(#h-soft)">' +
        '<rect x="34" y="84" width="58" height="46" rx="8" fill="#12233f" stroke="#3b6098" stroke-width="1.2"/>' +
        '<rect x="34" y="84" width="58" height="13" rx="8" fill="#1c2f50"/>' +
        '<circle cx="42" cy="90.5" r="1.6" fill="#7c5cff"/><circle cx="48" cy="90.5" r="1.6" fill="#5fd0ff"/><circle cx="54" cy="90.5" r="1.6" fill="#7fe6c0"/>' +
        // cart glyph
        '<g transform="translate(54,114)" stroke="#bda9ff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M-10 -8 H-7 L-5 2 H6 L8 -5 H-6"/><circle cx="-4" cy="6" r="1.6" fill="#bda9ff"/><circle cx="5" cy="6" r="1.6" fill="#bda9ff"/></g>' +
      '</g>' +
      // source pulse
      '<circle cx="86" cy="116" r="6" fill="#7c5cff"><animate attributeName="r" from="6" to="17" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" from=".5" to="0" dur="2.4s" repeatCount="indefinite"/></circle>' +
      '<circle cx="86" cy="116" r="4" fill="#cdbcff"/>' +
      // RIGHT: doorstep / house pin that pulses on arrival
      '<g filter="url(#h-soft)" transform="translate(392,60)">' +
        '<circle r="9" fill="#5fd0ff"><animate attributeName="r" from="9" to="22" dur="3.4s" begin="1.5s" repeatCount="indefinite"/><animate attributeName="opacity" from=".45" to="0" dur="3.4s" begin="1.5s" repeatCount="indefinite"/></circle>' +
        '<circle r="14" fill="#0e2740" stroke="#5fd0ff" stroke-width="1.3"/>' +
        '<g stroke="#bfeaff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M-6 0 L0 -6 L6 0"/><path d="M-4 0 V6 H4 V0"/></g>' +
      '</g>' +
      '<text x="392" y="92" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" font-weight="700" fill="rgba(150,220,255,.9)">' + UI.t("Delivered") + '</text>' +
      // racing light + arrival burst at the doorstep
      heroComet(arc, "#cfeaff", "3.4s", ".4s") +
      heroBurst(392, 60, "#5fd0ff", "3.4s", "1.5s") +
      // travelling parcels (staggered = continuous order flow)
      parcel("0s") + parcel("1.15s") + parcel("2.3s") +
      // floating reaction chips
      chip(150, heart, "#ff7a9c", ".2s") + chip(214, star, "#ffd36b", "1.1s") + chip(268, plus, "#7c5cff", "1.9s") +
      HERO_SHEEN +
      '</svg>';
  }

  /* ---- WHOLESALE · central hub fanning pallets to 3 nodes ---- */
  function heroWholesale() {
    const lanes = [
      { d: "M 96 86 C 200 64, 300 44, 404 42", begin: "0s",   to: [404, 42] },
      { d: "M 96 94 C 210 94, 312 94, 414 95", begin: ".8s",  to: [414, 95] },
      { d: "M 96 102 C 200 124, 300 144, 402 150", begin: "1.6s", to: [402, 150] }
    ];
    const lanePath = (l) =>
      '<path d="' + l.d + '" stroke="rgba(15,157,107,.16)" stroke-width="11" stroke-linecap="round" filter="url(#h-glow)"/>' +
      '<path d="' + l.d + '" stroke="url(#h-wh)" stroke-width="2.1" class="h-rt"/>';
    const crate = (l) =>
      '<g opacity="0"><g transform="translate(-8,-7)"><rect width="16" height="14" rx="2.2" fill="#eafff6" opacity=".97"/><path d="M0 5 H16 M8 0 V14" stroke="#0f9d6b" stroke-width="1.1"/></g>' +
        '<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.88;1" dur="3.2s" begin="' + l.begin + '" repeatCount="indefinite"/>' +
        '<animateMotion dur="3.2s" begin="' + l.begin + '" repeatCount="indefinite" rotate="0" path="' + l.d + '"/></g>';
    const dest = (l, i) =>
      '<g filter="url(#h-soft)" transform="translate(' + l.to[0] + ',' + l.to[1] + ')">' +
        '<circle r="8" fill="#3fd6a0"><animate attributeName="r" from="8" to="19" dur="3.2s" begin="' + l.begin + '" repeatCount="indefinite"/><animate attributeName="opacity" from=".45" to="0" dur="3.2s" begin="' + l.begin + '" repeatCount="indefinite"/></circle>' +
        '<circle r="11" fill="#0b3a2a" stroke="#3fd6a0" stroke-width="1.2"/>' +
        '<g stroke="#bff5e2" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="-5" y="-4" width="10" height="8" rx="1.4"/><path d="M-5 -1 H5"/></g>' +
      '</g>';
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<linearGradient id="h-wh" gradientUnits="userSpaceOnUse" x1="96" y1="94" x2="414" y2="80"><stop offset="0%" stop-color="#5fe0a8"/><stop offset="100%" stop-color="#2fae7a"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '.h-rt{stroke-dasharray:7 7;animation:h-d 4.5s linear infinite}@keyframes h-d{to{stroke-dashoffset:-56}}</style>' +
      HERO_STARS +
      '<path d="M0 152 H460" stroke="rgba(255,255,255,.06)"/>' +
      lanes.map(lanePath).join("") +
      // central warehouse hub
      '<g filter="url(#h-soft)">' +
        '<rect x="40" y="78" width="58" height="40" rx="5" fill="#0e3327" stroke="#2fae7a" stroke-width="1.3"/>' +
        '<path d="M40 78 L69 62 L98 78 Z" fill="#13402f" stroke="#2fae7a" stroke-width="1.3"/>' +
        '<rect x="60" y="96" width="18" height="22" rx="1.5" fill="#0a261d" stroke="#3fd6a0" stroke-width="1"/>' +
        // stacked crates beside the hub
        '<g stroke="#7fe6c0" stroke-width="1" fill="#0f2c22"><rect x="44" y="104" width="11" height="11" rx="1.4"/><rect x="83" y="104" width="11" height="11" rx="1.4"/></g>' +
      '</g>' +
      '<circle cx="96" cy="94" r="6" fill="#2fae7a"><animate attributeName="r" from="6" to="16" dur="2.6s" repeatCount="indefinite"/><animate attributeName="opacity" from=".5" to="0" dur="2.6s" repeatCount="indefinite"/></circle>' +
      '<circle cx="96" cy="94" r="4" fill="#bff5e2"/>' +
      lanes.map(dest).join("") +
      // flowing energy + arrival burst on every lane
      lanes.map((l) => heroComet(l.d, "#9bffd9", "3.2s", l.begin)).join("") +
      lanes.map((l) => heroBurst(l.to[0], l.to[1], "#7fe6c0", "3.2s", l.begin)).join("") +
      lanes.map(crate).join("") +
      '<text x="69" y="134" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" font-weight="700" fill="rgba(120,230,190,.9)">' + UI.t("Central DC") + '</text>' +
      HERO_SHEEN +
      '</svg>';
  }

  /* ---- RETAIL · barcode scan + rising sales bars + coin pop ---- */
  function heroRetail() {
    const bars = [
      { x: 250, h: 38,  begin: "0s" },
      { x: 282, h: 58,  begin: ".25s" },
      { x: 314, h: 46,  begin: ".5s" },
      { x: 346, h: 74,  begin: ".75s" },
      { x: 378, h: 92,  begin: "1s" }
    ];
    const base = 150;
    const bar = (b) =>
      '<rect x="' + b.x + '" y="' + (base - b.h) + '" width="20" height="' + b.h + '" rx="3" fill="url(#h-rt2)" opacity=".95" transform="scale(1,0)" style="transform-box:fill-box;transform-origin:bottom">' +
        '<animateTransform attributeName="transform" type="scale" values="1 0;1 1" dur="1.1s" begin="' + b.begin + '" fill="freeze" calcMode="spline" keySplines=".2 .7 .3 1"/>' +
      '</rect>';
    // barcode strip
    let barcode = "";
    const bw = [2, 1, 3, 1.5, 2.5, 1, 2, 3, 1, 2.5, 1.5, 2, 1, 3, 2]; let bx = 44;
    bw.forEach((w) => { barcode += '<rect x="' + bx.toFixed(1) + '" y="74" width="' + w + '" height="44" fill="#ffd9d2"/>'; bx += w + 2.4; });
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<linearGradient id="h-rt2" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#e6534b"/><stop offset="100%" stop-color="#ff9d6b"/></linearGradient>' +
        '<linearGradient id="h-rt-beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff5a4e" stop-opacity="0"/><stop offset="50%" stop-color="#ff8a6b" stop-opacity=".9"/><stop offset="100%" stop-color="#ff5a4e" stop-opacity="0"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '</style>' +
      HERO_STARS +
      '<path d="M0 152 H460" stroke="rgba(255,255,255,.06)"/>' +
      // storefront awning across the top
      '<g opacity=".9">' +
        '<rect x="28" y="30" width="404" height="9" rx="3" fill="#16273f"/>' +
        '<path d="M28 39 h404 v6 l-13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 -13 9 -13 -9 v-6 Z" fill="#e6534b" opacity=".25"/>' +
      '</g>' +
      // LEFT: barcode panel + scanning beam
      '<g filter="url(#h-soft)">' +
        '<rect x="34" y="64" width="92" height="64" rx="9" fill="#111f33" stroke="#7c4a44" stroke-width="1.2"/>' +
        barcode +
        // sweeping scan beam
        '<rect x="36" y="66" width="88" height="6" rx="3" fill="url(#h-rt-beam)"><animate attributeName="y" values="68;120;68" dur="2.6s" repeatCount="indefinite" calcMode="spline" keySplines=".4 0 .6 1;.4 0 .6 1"/></rect>' +
        '<line x1="40" y1="124" x2="120" y2="124" stroke="#ff8a6b" stroke-width="1" opacity=".5"/>' +
      '</g>' +
      // scan-complete ping at the barcode + bloomed live dot
      heroBurst(80, 124, "#ff8a6b", "2.6s", "1.1s") +
      '<g filter="url(#h-bloom)"><circle cx="44" cy="58" r="3" fill="#ff7a5c"><animate attributeName="opacity" values="1;.25;1" dur="1.4s" repeatCount="indefinite"/></circle></g>' +
      '<text x="80" y="58" text-anchor="middle" font-family="Inter,sans-serif" font-size="10" font-weight="800" letter-spacing=".05em" fill="rgba(255,150,120,.9)">' + UI.t("LIVE SALES") + '</text>' +
      // RIGHT: rising sales bars on a baseline
      '<line x1="240" y1="150" x2="410" y2="150" stroke="rgba(255,255,255,.12)" stroke-width="1.4"/>' +
      bars.map(bar).join("") +
      // coin pop above the tallest bar (bloomed, with a sparkle burst)
      heroBurst(388, 32, "#ffe6a0", "2.2s", "1.5s") +
      '<g filter="url(#h-bloom)"><g transform="translate(388,40)" opacity="0">' +
        '<circle r="9" fill="#ffd36b" stroke="#e6a93c" stroke-width="1.3"/><text y="3.5" text-anchor="middle" font-family="Inter,sans-serif" font-size="10" font-weight="800" fill="#8a5a12">$</text>' +
        '<animateTransform attributeName="transform" type="translate" values="388,52;388,30" dur="2.2s" begin="1.1s" repeatCount="indefinite" calcMode="spline" keySplines=".2 .7 .3 1"/>' +
        '<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.2;.7;1" dur="2.2s" begin="1.1s" repeatCount="indefinite"/>' +
      '</g></g>' +
      HERO_SHEEN +
      '</svg>';
  }

  /* ---- MANUFACTURING · raw material → press → finished goods on a line ---- */
  function heroManufacturing() {
    const beltY = 116;
    // a part travelling the production line, transforming raw → finished
    const part = (begin, fromFill, toFill) =>
      '<g opacity="0"><rect x="-8" y="-7" width="16" height="14" rx="2" fill="' + fromFill + '">' +
        '<animate attributeName="fill" values="' + fromFill + ';' + fromFill + ';' + toFill + ';' + toFill + '" keyTimes="0;.45;.55;1" dur="4s" begin="' + begin + '" repeatCount="indefinite"/></rect>' +
        '<animateMotion dur="4s" begin="' + begin + '" repeatCount="indefinite" path="M 96 ' + beltY + ' H 410"/>' +
        '<animate attributeName="opacity" values="0;1;1;1;0" keyTimes="0;.05;.5;.95;1" dur="4s" begin="' + begin + '" repeatCount="indefinite"/></g>';
    // gear
    const gear = (cx, cy, r, dur, dir) => {
      let teeth = ""; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; teeth += '<rect x="' + (cx - 1.6) + '" y="' + (cy - r - 3) + '" width="3.2" height="4" rx="1" fill="#f0a93c" transform="rotate(' + (i * 45) + ' ' + cx + ' ' + cy + ')"/>'; }
      return '<g><g>' + teeth + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#f0a93c" stroke-width="2.4"/><circle cx="' + cx + '" cy="' + cy + '" r="2" fill="#f0a93c"/>' +
        '<animateTransform attributeName="transform" type="rotate" from="' + (dir > 0 ? 0 : 360) + ' ' + cx + ' ' + cy + '" to="' + (dir > 0 ? 360 : 0) + ' ' + cx + ' ' + cy + '" dur="' + dur + '" repeatCount="indefinite"/></g></g>';
    };
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<linearGradient id="h-mf" gradientUnits="userSpaceOnUse" x1="96" y1="116" x2="410" y2="116"><stop offset="0%" stop-color="#fbbf6b"/><stop offset="100%" stop-color="#d97706"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '.h-belt{stroke-dasharray:6 6;animation:h-d 1.4s linear infinite}@keyframes h-d{to{stroke-dashoffset:-48}}</style>' +
      HERO_STARS +
      // conveyor belt
      '<rect x="86" y="126" width="328" height="9" rx="4" fill="#15233a" stroke="#3a5a86" stroke-width="1"/>' +
      '<line x1="92" y1="130.5" x2="408" y2="130.5" stroke="url(#h-mf)" stroke-width="2" class="h-belt"/>' +
      '<g filter="url(#h-soft)">' +
        // raw material silo (left)
        '<rect x="36" y="92" width="40" height="34" rx="4" fill="#3a2a10" stroke="#d97706" stroke-width="1.3"/>' +
        '<path d="M36 92 L56 80 L76 92 Z" fill="#4a360f" stroke="#d97706" stroke-width="1.3"/>' +
        '<rect x="50" y="108" width="12" height="18" fill="#1a1206" stroke="#f0a93c" stroke-width="1"/>' +
        // press / machine (center)
        '<rect x="226" y="74" width="56" height="52" rx="5" fill="#102a45" stroke="#f0a93c" stroke-width="1.3"/>' +
        '<rect x="240" y="60" width="28" height="16" rx="2" fill="#15233a" stroke="#f0a93c" stroke-width="1"/>' +
        // press head punching down
        '<rect x="248" y="86" width="12" height="14" rx="1.5" fill="#f0a93c"><animate attributeName="y" values="86;100;86" dur="1s" repeatCount="indefinite" calcMode="spline" keySplines=".3 0 .2 1;.8 0 .7 1"/></rect>' +
        // finished goods stack (right)
        '<g stroke="#7fe6c0" stroke-width="1.1" fill="#0f2c22"><rect x="418" y="112" width="13" height="13" rx="1.5"/><rect x="421" y="99" width="13" height="13" rx="1.5"/></g>' +
      '</g>' +
      gear(252, 52, 8, "3s", 1) + gear(270, 46, 6, "2.4s", -1) +
      // source pulse + machine glow
      '<circle cx="96" cy="116" r="5" fill="#d97706"><animate attributeName="r" from="5" to="14" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" from=".5" to="0" dur="2.4s" repeatCount="indefinite"/></circle>' +
      part("0s", "#8a6a3a", "#7fe6c0") + part("1.3s", "#8a6a3a", "#7fe6c0") + part("2.6s", "#8a6a3a", "#7fe6c0") +
      // spark burst each time the press strikes + arrival burst at finished stack
      heroBurst(254, 102, "#ffe0a0", "1s", "0s") +
      heroBurst(424, 110, "#9fffd9", "4s", "3.6s") +
      '<text x="56" y="146" text-anchor="middle" font-family="Inter,sans-serif" font-size="10.5" font-weight="700" fill="rgba(245,180,90,.9)">' + UI.t("Raw") + '</text>' +
      '<text x="254" y="146" text-anchor="middle" font-family="Inter,sans-serif" font-size="10.5" font-weight="700" fill="rgba(245,180,90,.9)">' + UI.t("Press") + '</text>' +
      '<text x="424" y="146" text-anchor="middle" font-family="Inter,sans-serif" font-size="10.5" font-weight="700" fill="rgba(127,230,192,.9)">' + UI.t("Finished") + '</text>' +
      HERO_SHEEN +
      '</svg>';
  }

  /* ---- RESTAURANT · plate service with rising steam & order tickets ---- */
  function heroRestaurant() {
    const steam = (x, begin) =>
      '<path d="M' + x + ' 70 q -5 -8 0 -16 q 5 -8 0 -16" stroke="#ffd9d9" stroke-width="2.2" fill="none" stroke-linecap="round" opacity="0">' +
        '<animate attributeName="opacity" values="0;.7;0" dur="2.8s" begin="' + begin + '" repeatCount="indefinite"/>' +
        '<animateTransform attributeName="transform" type="translate" values="0 6;0 -10" dur="2.8s" begin="' + begin + '" repeatCount="indefinite"/></path>';
    const ticket = (begin) =>
      '<g opacity="0"><g transform="translate(-11,-14)"><rect width="22" height="28" rx="2.5" fill="#fff" opacity=".96"/><path d="M4 7 H18 M4 12 H18 M4 17 H14" stroke="#e11d48" stroke-width="1.4" stroke-linecap="round"/></g>' +
        '<animateMotion dur="3.6s" begin="' + begin + '" repeatCount="indefinite" path="M 372 60 C 320 40, 250 40, 150 64"/>' +
        '<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.85;1" dur="3.6s" begin="' + begin + '" repeatCount="indefinite"/></g>';
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<radialGradient id="h-plate" cx="50%" cy="40%" r="65%"><stop offset="0%" stop-color="#fff"/><stop offset="70%" stop-color="#e9eef5"/><stop offset="100%" stop-color="#c4cedb"/></radialGradient>' +
        '<linearGradient id="h-rs" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#e11d48"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '.h-dash{stroke-dasharray:7 7;animation:h-d 4s linear infinite}@keyframes h-d{to{stroke-dashoffset:-56}}</style>' +
      HERO_STARS +
      // order flow line from kitchen pass (right) to tables (left)
      '<path d="M 372 60 C 320 40, 250 40, 150 64" stroke="rgba(225,29,72,.18)" stroke-width="11" stroke-linecap="round" filter="url(#h-glow)"/>' +
      '<path d="M 372 60 C 320 40, 250 40, 150 64" stroke="url(#h-rs)" stroke-width="2.2" class="h-dash"/>' +
      // hero plate (center-left) under a cloche being lifted
      steam("214", "0s") + steam("226", ".7s") + steam("238", "1.4s") +
      '<g filter="url(#h-soft)">' +
        '<ellipse cx="226" cy="118" rx="58" ry="13" fill="url(#h-plate)"/>' +
        '<ellipse cx="226" cy="116" rx="40" ry="8.5" fill="#dde4ee"/>' +
        // food mound
        '<ellipse cx="226" cy="113" rx="22" ry="7" fill="#c97b4a"/><ellipse cx="219" cy="110" rx="6" ry="3.5" fill="#e6534b"/><ellipse cx="233" cy="111" rx="5" ry="3" fill="#7fb04a"/>' +
        // cloche lifting up
        '<g><path d="M188 104 a38 30 0 0 1 76 0 Z" fill="#1b2f4d" stroke="#9fb9d6" stroke-width="1.4" opacity=".9"/><circle cx="226" cy="74" r="3" fill="#cfe0ef"/>' +
          '<animateTransform attributeName="transform" type="translate" values="0 0;0 -22;0 0" keyTimes="0;.5;1" dur="4s" repeatCount="indefinite" calcMode="spline" keySplines=".3 0 .2 1;.8 0 .7 1"/>' +
          '<animate attributeName="opacity" values="1;.85;1" dur="4s" repeatCount="indefinite"/></g>' +
      '</g>' +
      // kitchen pass node (right)
      '<g filter="url(#h-soft)" transform="translate(372,60)">' +
        '<circle r="7" fill="#fb7185"><animate attributeName="r" from="7" to="18" dur="2.6s" repeatCount="indefinite"/><animate attributeName="opacity" from=".5" to="0" dur="2.6s" repeatCount="indefinite"/></circle>' +
        '<circle r="12" fill="#3a0d1b" stroke="#fb7185" stroke-width="1.3"/>' +
        '<g stroke="#ffd0d8" stroke-width="1.5" fill="none" stroke-linecap="round"><path d="M-5 -3v6M-5 -3a2 2 0 0 1 4 0M-1 -3v6M2 -3v3a2 2 0 0 0 3 0v-3"/></g>' +
      '</g>' +
      ticket("0s") + ticket("1.8s") +
      // order racing to the table + served burst
      heroComet("M 372 60 C 320 40, 250 40, 150 64", "#ffd0d8", "3.6s", ".3s") +
      heroBurst(150, 64, "#fb7185", "3.6s", "1.6s") +
      '<text x="372" y="92" text-anchor="middle" font-family="Inter,sans-serif" font-size="10.5" font-weight="700" fill="rgba(255,150,170,.9)">' + UI.t("Kitchen") + '</text>' +
      HERO_SHEEN +
      '</svg>';
  }

  /* ---- CONSTRUCTION · crane lifting beams onto a rising structure ---- */
  function heroConstruction() {
    const beam = (begin) =>
      '<g opacity="0"><g transform="translate(-16,-3)"><rect width="32" height="6" rx="1.5" fill="#f0a93c"/><path d="M0 0 h32 M0 6 h32 M4 0 l4 6 M12 0 l4 6 M20 0 l4 6 M28 0 l4 6" stroke="#b45309" stroke-width=".7"/></g>' +
        '<animateMotion dur="4s" begin="' + begin + '" repeatCount="indefinite" keyPoints="0;.5;.5;1" keyTimes="0;.4;.6;1" calcMode="linear" path="M 150 44 L 150 120 L 360 120 L 360 96"/>' +
        '<animate attributeName="opacity" values="0;1;1;1;0" keyTimes="0;.05;.55;.95;1" dur="4s" begin="' + begin + '" repeatCount="indefinite"/></g>';
    // cable from trolley down to hook
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<linearGradient id="h-cn" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#b45309"/><stop offset="100%" stop-color="#fbbf6b"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '.h-rise rect{transform-box:fill-box;transform-origin:bottom}</style>' +
      HERO_STARS +
      '<path d="M0 152 H460" stroke="rgba(255,255,255,.06)"/>' +
      // tower crane
      '<g filter="url(#h-soft)" stroke="#f0a93c" stroke-width="2" fill="none" stroke-linecap="round">' +
        '<path d="M150 150 V40"/><path d="M138 150 L150 138 L162 150" stroke-width="1.4"/>' +
        '<path d="M150 44 H372" stroke-width="2.4"/><path d="M150 44 L110 44" stroke-width="2.4"/>' +            // jib + counter-jib
        '<path d="M150 30 L150 44 M150 30 L120 44 M150 30 L210 44 M150 30 L290 44 M150 30 L360 44" stroke-width="1"/>' + // mast cap stays
        '<rect x="104" y="40" width="14" height="9" rx="1.5" fill="#3a2a10" stroke-width="1.2"/>' +              // counterweight
      '</g>' +
      // trolley + cable + hook (cable length pulses with the lift)
      '<g stroke="#cfe0ef" stroke-width="1.2"><line x1="360" y1="46" x2="360" y2="92"><animate attributeName="y2" values="92;92;120;120;92" keyTimes="0;.4;.55;.85;1" dur="4s" repeatCount="indefinite"/></line></g>' +
      // structure being built (rising floors)
      '<g class="h-rise" filter="url(#h-soft)">' +
        '<rect x="330" y="120" width="60" height="30" rx="2" fill="#16324f" stroke="#5b7da3" stroke-width="1"/>' +
        '<rect x="330" y="104" width="60" height="16" rx="2" fill="#1b3a5c" stroke="#6f95bd" stroke-width="1"><animateTransform attributeName="transform" type="scale" values="1 0;1 1" dur="1s" begin="1.6s" fill="freeze" calcMode="spline" keySplines=".2 .7 .3 1"/></rect>' +
        '<g stroke="#3a5a86" stroke-width=".8"><path d="M345 120 V150 M360 120 V150 M375 120 V150 M330 135 H390"/></g>' +
      '</g>' +
      // crane beacon (bloomed) + dust burst as each floor settles
      '<g filter="url(#h-bloom)"><circle cx="150" cy="44" r="4.5" fill="#ffd089"><animate attributeName="opacity" values="1;.35;1" dur="1.6s" repeatCount="indefinite"/></circle></g>' +
      beam("0s") + beam("2s") +
      heroBurst(360, 104, "#e6c79a", "4s", "1.55s") + heroBurst(360, 104, "#e6c79a", "4s", "3.55s") +
      '<text x="360" y="166" text-anchor="middle" font-family="Inter,sans-serif" font-size="10.5" font-weight="700" fill="rgba(245,180,90,.9)">' + UI.t("On site") + '</text>' +
      HERO_SHEEN +
      '</svg>';
  }

  /* ---- SERVICES · proposal → project orbit → billed (clean, professional) ---- */
  function heroServices() {
    // orbiting milestone dots around a central project hub
    const orbit = (rx, ry, dur, dot, begin) =>
      '<g><ellipse cx="232" cy="92" rx="' + rx + '" ry="' + ry + '" fill="none" stroke="rgba(45,212,191,.18)" stroke-width="1"/>' +
        '<circle r="3.4" fill="' + dot + '"><animateMotion dur="' + dur + '" begin="' + begin + '" repeatCount="indefinite" path="M ' + (232 + rx) + ' 92 A ' + rx + ' ' + ry + ' 0 1 1 ' + (232 - rx) + ' 92 A ' + rx + ' ' + ry + ' 0 1 1 ' + (232 + rx) + ' 92"/></circle></g>';
    // a small rising billable-hours bar trio
    const bar = (x, h, begin) =>
      '<rect x="' + x + '" y="' + (140 - h) + '" width="13" height="' + h + '" rx="2.5" fill="url(#h-sv)" style="transform-box:fill-box;transform-origin:bottom" transform="scale(1,0)">' +
        '<animateTransform attributeName="transform" type="scale" values="1 0;1 1" dur="1s" begin="' + begin + '" fill="freeze" calcMode="spline" keySplines=".2 .7 .3 1"/></rect>';
    return '<svg width="460" height="180" viewBox="0 0 460 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + HERO_DEFS +
        '<linearGradient id="h-sv" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#0f766e"/><stop offset="100%" stop-color="#5eead4"/></linearGradient>' +
      '</defs>' +
      '<style>' + HERO_TW_KEYS + '</style>' +
      HERO_STARS +
      '<path d="M0 152 H460" stroke="rgba(255,255,255,.06)"/>' +
      // LEFT: proposal document
      '<g filter="url(#h-soft)">' +
        '<rect x="40" y="58" width="56" height="70" rx="5" fill="#0d2a2a" stroke="#2dd4bf" stroke-width="1.3"/>' +
        '<path d="M50 72 H86 M50 82 H86 M50 92 H78 M50 102 H86 M50 112 H72" stroke="#5eead4" stroke-width="1.5" stroke-linecap="round" opacity=".8"/>' +
        '<circle cx="86" cy="120" r="9" fill="#0f766e" stroke="#5eead4" stroke-width="1.2"/><path d="M82 120 l3 3 5 -6" stroke="#defff7" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</g>' +
      // CENTER: project hub with orbiting milestones
      orbit(56, 30, "6s", "#5eead4", "0s") + orbit(38, 20, "4.2s", "#7fe6c0", "1s") +
      '<g filter="url(#h-bloom)">' +
        '<circle cx="232" cy="92" r="17" fill="#0c3b38" stroke="#2dd4bf" stroke-width="1.6"/>' +
        '<g stroke="#5eead4" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="227" cy="88" r="3.4"/><path d="M232 99 a6 6 0 0 0-10 0"/><path d="M236 90 a4 4 0 0 1 0 6M239 87 a8 8 0 0 1 0 12"/></g>' +
        '<circle cx="232" cy="92" r="22" fill="none" stroke="#2dd4bf" stroke-width="1" opacity=".5"><animate attributeName="r" from="18" to="30" dur="2.8s" repeatCount="indefinite"/><animate attributeName="opacity" from=".5" to="0" dur="2.8s" repeatCount="indefinite"/></circle>' +
      '</g>' +
      // RIGHT: billable-hours bars + invoice tick
      '<line x1="350" y1="140" x2="420" y2="140" stroke="rgba(255,255,255,.12)"/>' +
      bar(356, 30, ".2s") + bar(374, 50, ".5s") + bar(392, 38, ".8s") + bar(410, 64, "1.1s") +
      '<text x="386" y="62" text-anchor="middle" font-family="Inter,sans-serif" font-size="10.5" font-weight="800" fill="rgba(94,234,212,.9)">' + UI.t("Billed") + '</text>' +
      '<text x="68" y="146" text-anchor="middle" font-family="Inter,sans-serif" font-size="10.5" font-weight="700" fill="rgba(94,234,212,.9)">' + UI.t("Proposal") + '</text>' +
      HERO_SHEEN +
      '</svg>';
  }

  /* =============================================================
     DASHBOARD
     ============================================================= */
  async function dashboard(el) {
    const [shipments, orders, products, invoices, clients, audit] = await Promise.all(
      ["shipments", "orders", "products", "invoices", "clients", "audit"].map((c) => Store.list(c)));

    const showFinance = Auth.can("finance", "view");
    const isOwner = Auth.isOwner();

    // industry fit: gate + relabel modules for the active workspace
    const ws = window.Workspace;
    const hasWs = ws && ws.exists();
    const indHas = (id) => !ws || ws.hasModule(id);
    const shipTitle = (ws && ws.label("shipments")) ? ws.label("shipments")[0] : null; // e.g. "Deliveries"

    const activeShip = shipments.filter((s) => !["Delivered", "Cancelled"].includes(s.status));
    const openOrders = orders.filter((o) => ["Pending", "Confirmed", "Shipped"].includes(o.status));
    const invValue = products.reduce((a, p) => a + p.stock * p.price, 0);
    const unpaid = invoices.filter((i) => ["Sent", "Overdue", "Draft"].includes(i.status));
    const outstanding = unpaid.reduce((a, i) => a + i.amount, 0);
    const overdue = invoices.filter((i) => i.status === "Overdue");
    const lowStock = products.filter((p) => p.stock <= p.reorder);
    const clientMap = Object.fromEntries(clients.map((c) => [c.id, c]));

    // shipments by mode (for the donut)
    const modes = {}; shipments.forEach((s) => { modes[s.mode] = (modes[s.mode] || 0) + 1; });
    const MODE_COLOR = { Railway: "#1aa6df", Road: "#7a4fb0", Sea: "#1f9d6b", Multimodal: "#c89a3c" };
    const segs = Object.keys(modes).map((m) => ({ label: tr(m), value: modes[m], color: MODE_COLOR[m] || "#5b6b7f" }));

    // greeting + context
    const u = Auth.current() || {};
    const first = (u.name || "").split(" ")[0];
    const hr = new Date().getHours();
    const greet = hr < 12 ? UI.t("Good morning") : hr < 18 ? UI.t("Good afternoon") : UI.t("Good evening");
    const dateStr = new Date().toLocaleDateString(UI.getLang() === "tr" ? "tr-TR" : "en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

    // small synthetic trend lines for the sparklines / area chart (visual)
    const trend = {
      ship: [3, 5, 4, 6, 5, 7, 6, activeShip.length],
      orders: [6, 5, 7, 6, 8, 7, 9, openOrders.length],
      inv: [320, 332, 318, 345, 360, 351, 372, Math.round(invValue / 1000)],
      rec: [70, 66, 79, 74, 86, 80, 91, Math.round(outstanding / 1000)]
    };
    const rev = [58, 64, 61, 73, 70, 82, 89, 98];
    const revLbl = ["-7h", "-6h", "-5h", "-4h", "-3h", "-2h", "-1h", UI.t("now")];
    const revDelta = Math.round(((rev[7] - rev[0]) / rev[0]) * 100);

    // industry-specific animated hero scene (logistics rail map, e-commerce
    // order flow, wholesale distribution fan-out, retail POS, …)
    const heroKey = hasWs ? ws.industryKey() : "logistics";
    const heroSvg = heroArt(heroKey);

    const kpi = (ic, color, val, fmt, l, delta, spark) =>
      '<div class="kpi">' +
        '<div class="top-row"><div class="ic ' + color + '">' + icon(ic) + "</div>" + (delta || "") + "</div>" +
        '<div class="n" data-count="' + val + '" data-fmt="' + fmt + '">0</div>' +
        '<div class="l">' + l + "</div>" + spark +
      "</div>";

    const showShipments = Auth.can("shipments", "view") && indHas("shipments");
    const showOrders = Auth.can("orders", "view") && indHas("orders");
    const showInventory = Auth.can("inventory", "view") && indHas("inventory");

    const activeCards = [];
    if (showShipments) {
      const shipKpiLabel = shipTitle ? UI.t("Active") + " " + shipTitle.toLowerCase() : UI.t("Active shipments");
      // delta: count of the industry's primary mode (logistics keeps the "on rail" idiom)
      const primaryMode = ws ? ws.shipModes()[0] : "Railway";
      const primaryCount = shipments.filter((s) => s.mode === primaryMode).length;
      const primaryLabel = primaryMode === "Railway" ? UI.t("on rail") : tr(primaryMode).toLowerCase();
      activeCards.push(kpi("truck", "blue", activeShip.length, "num", shipKpiLabel, '<div class="delta up">' + icon("arrowUp") + primaryCount + " " + primaryLabel + "</div>", Charts.sparkline(trend.ship, { color: "#1aa6df" })));
    }
    if (showOrders) {
      activeCards.push(kpi("cart", "purple", openOrders.length, "num", UI.t("Open orders"), '<div class="delta up">' + icon("arrowUp") + orders.length + " " + UI.t("total") + "</div>", Charts.sparkline(trend.orders, { color: "#7a4fb0" })));
    }
    if (showInventory) {
      activeCards.push(kpi("package", "green", invValue, "money", UI.t("Inventory value (est.)"), '<div class="delta ' + (lowStock.length ? "down" : "up") + '">' + icon(lowStock.length ? "arrowDown" : "check") + lowStock.length + " " + UI.t("low") + "</div>", Charts.sparkline(trend.inv, { color: "#1f9d6b" })));
    }
    if (showFinance) {
      activeCards.push(kpi("dollar", "gold", outstanding, "money", UI.t("Outstanding receivables"), '<div class="delta ' + (overdue.length ? "down" : "up") + '">' + icon("alert") + overdue.length + " " + UI.t("overdue") + "</div>", Charts.sparkline(trend.rec, { color: "#c89a3c" })));
    }
    const kpiCards = activeCards.join("");
    const kpiColumns = activeCards.length || 1;

    const widgets = [];

    // Revenue trend (Finance)
    if (showFinance) {
      widgets.push(
        '<div class="card"><div class="card-h"><h3>' + UI.t("Revenue trend") + '</h3><span class="sub">' + UI.t("Last 8 weeks · k USD") + '</span>' +
          '<div class="grow" style="flex:1"></div><span class="delta up" style="font-size:.82rem">' + icon("arrowUp") + revDelta + "%</span></div>" +
          '<div class="card-b" style="padding-bottom:8px">' + Charts.area(revLbl, rev) + "</div></div>"
      );
    }

    // Shipments in transit list (Shipments)
    if (showShipments) {
      widgets.push(
        '<div class="card"><div class="card-h"><span class="live-dot"></span><h3>' + (shipTitle ? shipTitle + " " + UI.t("in transit") : UI.t("Shipments in transit")) + '</h3>' +
          '<div class="grow" style="flex:1"></div><a href="#/shipments" class="btn btn-ghost btn-sm">' + UI.t("View all") + '</a></div>' +
          '<div class="tbl-wrap" style="border:none;box-shadow:none;border-radius:0"><table class="tbl"><thead><tr>' +
          '<th>' + UI.t("Reference") + '</th><th>' + UI.t("Client") + '</th><th>' + UI.t("Route") + '</th><th>' + UI.t("Status") + '</th><th>' + UI.t("ETA") + '</th></tr></thead><tbody>' +
          (activeShip.length ? activeShip.slice(0, 6).map((s) =>
            '<tr data-go="#/shipments"><td class="mono strong">' + esc(s.ref) + "</td>" +
            "<td>" + esc((clientMap[s.client] || {}).name || "—") + "</td>" +
            '<td><span class="muted">' + esc(s.origin) + " → " + esc(s.destination) + "</span></td>" +
            "<td>" + badge(s.status, SH_ST) + "</td>" +
            "<td>" + date(s.eta) + "</td></tr>").join("") : emptyRow(5, UI.t("No active shipments."))) +
          "</tbody></table></div></div>"
      );
      
      // Service mix donut
      widgets.push(
        '<div class="card"><div class="card-h"><h3>' + UI.t("Service mix") + '</h3><span class="sub">' + UI.t("By transport mode") + '</span></div>' +
          '<div class="card-b"><div class="donut-wrap">' + Charts.donut(segs, { centerLabel: UI.t("shipments") }) +
          '<div class="chart-legend">' +
          segs.map((s) => '<div class="lg"><span class="sw" style="background:' + s.color + '"></span><span class="k">' + esc(s.label) + '</span><span class="v">' + s.value + "</span></div>").join("") +
          "</div></div></div></div>"
      );
    }

    // Low-stock alerts (Inventory)
    if (showInventory) {
      widgets.push(
        '<div class="card"><div class="card-h"><h3>' + UI.t("Low-stock alerts") + '</h3>' +
          '<div class="grow" style="flex:1"></div><span class="tag">' + lowStock.length + " " + UI.t(lowStock.length > 1 ? "items" : "item") + "</span></div>" +
          '<div class="card-b" style="padding-top:6px">' +
          (lowStock.length ? lowStock.slice(0, 4).map((p) =>
            '<div class="flex between" style="padding:10px 0;border-bottom:1px solid var(--line-2)">' +
            '<div><div class="strong">' + esc(p.name) + '</div><div class="ci-sub muted">' + esc(p.sku) + " · " + esc(p.warehouse) + "</div></div>" +
            "<div style=\"text-align:right\">" + badge(productStatus(p.stock, p.reorder), PROD_ST) +
            '<div class="ci-sub muted" style="margin-top:3px">' + p.stock + " / " + p.reorder + " min</div></div></div>").join("")
            : '<p class="muted" style="margin:6px 0">' + UI.t("All products above reorder level. ✓") + '</p>') +
          "</div></div>"
      );
    }

    // Recent activity timeline (Owner only)
    if (isOwner) {
      widgets.push(
        '<div class="card"><div class="card-h"><h3>' + UI.t("Recent activity") + '</h3>' +
          '<div class="grow" style="flex:1"></div><a href="#/history" class="btn btn-ghost btn-sm">' + UI.t("History") + '</a></div>' +
          '<div class="card-b"><div class="timeline">' +
          audit.slice(0, 5).map((a) =>
            '<div class="tl-item"><div class="tl-dot ' + (a.action === "create" ? "green" : a.action === "delete" ? "red" : a.action === "login" || a.action === "logout" ? "purple" : "amber") + '"></div>' +
            '<div class="tl-h">' + esc(a.summary) + "</div>" +
            '<div class="tl-m"><span>' + esc(a.actor) + "</span><span>" + rel(a.ts) + "</span></div></div>").join("") +
          "</div></div></div>"
      );
    }

    let leftColHTML = "";
    let rightColHTML = "";
    widgets.forEach((w, idx) => {
      if (idx % 2 === 0) leftColHTML += w;
      else rightColHTML += w;
    });

    const hsParts = [];
    if (showShipments) hsParts.push(activeShip.length + " " + UI.t(activeShip.length === 1 ? "active shipment" : "active shipments"));
    if (showOrders) hsParts.push(openOrders.length + " " + UI.t(openOrders.length === 1 ? "open order" : "open orders"));
    if (showFinance) hsParts.push(money(outstanding, "USD") + " " + UI.t("receivable"));
    const hsSubText = hsParts.join(" · ");

    el.innerHTML =
      '<div class="hero-strip">' +
        '<div class="hs-text">' +
          '<div class="hs-kicker">' + dateStr + "</div>" +
          "<h2>" + greet + (first ? ", " + esc(first) : "") + "</h2>" +
          '<div class="hs-sub">' + hsSubText + "</div>" +
          '<div class="hs-motto">' + icon("check") + " " + (hasWs ? esc(ws.preset().blurb || ws.tagline()) : UI.t("We move trade with one motto — <b>trust</b>.")) + "</div>" +
          "</div>" +
        '<div class="hs-graphic">' + heroSvg + "</div>" +
      "</div>" +

      '<div class="kpis" style="grid-template-columns: repeat(' + kpiColumns + ', 1fr)">' +
        kpiCards +
      '</div>' +

      (widgets.length > 0 
        ? '<div class="grid-2">' +
            '<div style="display:flex;flex-direction:column;gap:18px">' + leftColHTML + '</div>' +
            '<div style="display:flex;flex-direction:column;gap:18px">' + rightColHTML + '</div>' +
          '</div>'
        : '');

    // animate KPI numbers
    el.querySelectorAll(".kpi .n[data-count]").forEach((n) => {
      const target = Number(n.dataset.count);
      const f = n.dataset.fmt === "money" ? ((v) => money(v, "USD")) : ((v) => num(Math.round(v)));
      Charts.countUp(n, target, { format: f });
    });
    el.querySelectorAll("[data-go]").forEach((r) => r.addEventListener("click", () => { location.hash = r.dataset.go; }));
  }

  /* =============================================================
     SHIPMENTS
     ============================================================= */
  function openScannerModal() {
    let html5QrCode = null;
    
    const stopScanner = async () => {
      if (html5QrCode && html5QrCode.isScanning) {
        try {
          await html5QrCode.stop();
        } catch (err) {
          console.error("Failed to stop scanner", err);
        }
      }
    };
    
    // Intercept modal close to clean up camera resources
    const originalCloseModal = UI.closeModal;
    UI.closeModal = function() {
      stopScanner();
      UI.closeModal = originalCloseModal;
      originalCloseModal();
    };

    modal({
      title: UI.t("Scan QR Code"),
      body: 
        '<p class="muted" style="margin-bottom:12px; font-size:0.85rem;">' + UI.t("Position the cargo barcode / QR code inside the camera view.") + '</p>' +
        '<div id="qrScannerReader" style="width: 100%; max-width: 440px; aspect-ratio: 1; background: #000; overflow: hidden; border-radius: var(--r-md); margin: 0 auto; position: relative;">' +
          '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#fff; font-size:0.85rem;" id="scannerLoader">' + UI.t("Starting camera…") + '</div>' +
        '</div>',
      footer: '<button class="btn btn-ghost" id="btnCancelScan" style="width:100%;">' + UI.t("Cancel") + '</button>',
      onMount: (m) => {
        const cancelBtn = m.querySelector("#btnCancelScan");
        if (cancelBtn) cancelBtn.addEventListener("click", () => UI.closeModal());
        
        setTimeout(() => {
          html5QrCode = new Html5Qrcode("qrScannerReader");
          const config = { fps: 10, qrbox: { width: 220, height: 220 } };
          
          html5QrCode.start(
            { facingMode: "environment" },
            config,
            (decodedText, decodedResult) => {
              stopScanner();
              UI.closeModal();
              toast(UI.t("QR Code scanned successfully"));
              
              const hashIndex = decodedText.indexOf("#/");
              if (hashIndex !== -1) {
                const targetHash = decodedText.substring(hashIndex);
                location.hash = targetHash;
              } else if (decodedText.startsWith("SH-") || decodedText.startsWith("MRV-")) {
                location.hash = "#/shipments?id=" + decodedText;
              } else {
                toast(UI.t("Invalid shipment QR Code link"), "err");
              }
            },
            (errorMessage) => {
              // Ignore standard frame scan errors
            }
          ).then(() => {
            const loader = document.getElementById("scannerLoader");
            if (loader) loader.remove();
          }).catch((err) => {
            const loader = document.getElementById("scannerLoader");
            if (loader) {
              loader.innerHTML = '<div style="color:var(--red); padding:20px; text-align:center;">' + UI.t("Camera access denied or unavailable.") + '</div>';
            }
            console.error("Camera start error", err);
          });
        }, 150);
      }
    });
  }

  async function shipments(el) {
    const [list, clients, orderList, products] = await Promise.all([Store.list("shipments"), Store.list("clients"), Store.list("orders"), Store.list("products")]);
    _cachedProducts = products;
    const clientMap = Object.fromEntries(clients.map((c) => [c.id, c]));
    const orderMap = Object.fromEntries(orderList.map((o) => [o.id, o]));
    const statuses = ["All", "Booked", "In Transit", "Customs", "On Hold", "Delivered", "Cancelled"];
    let activeStatus = "All";
    const shipWs = window.Workspace;
    const showFreightCol = shipWs ? shipWs.freightDetails() : true;

    function rows() {
      const data = activeStatus === "All" ? list : list.filter((s) => s.status === activeStatus);
      if (!data.length) return emptyRow(8, UI.t("No shipments in this status."));
      return data.map((s) =>
        '<tr data-row data-id="' + s.id + '">' +
        '<td style="text-align: center;" onclick="event.stopPropagation()"><input type="checkbox" class="ship-select" data-id="' + s.id + '"></td>' +
        '<td class="mono strong">' + esc(s.ref) + "</td>" +
        "<td>" + esc((clientMap[s.client] || {}).name || "—") + "</td>" +
        '<td><span class="muted">' + esc(s.origin) + " → " + esc(s.destination) + "</span></td>" +
        '<td><span class="tag">' + esc(tr(s.mode)) + "</span></td>" +
        "<td>" + (showFreightCol
          ? (s.containers + " " + UI.t(s.containers > 1 ? "containers" : "container") + " · " + s.weightTons + "t")
          : ((s.containers || 1) + " " + UI.t((s.containers || 1) > 1 ? "parcels" : "parcel"))) + "</td>" +
        "<td>" + badge(s.status, SH_ST) + "</td>" +
        "<td>" + date(s.eta) + rowActs("shipments") + "</td>" +
        "</tr>").join("");
    }

    el.innerHTML =
      indTitle("shipments", "Logistics & Shipments", "Railway container, road and sea freight · up to 28 t per booking") +
      toolbar("shipSearch", segFilter(statuses, activeStatus), "New shipment", "shipAdd", "shipments") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th style="width: 40px; text-align: center;"><input type="checkbox" id="bulkSelectAll"></th>' +
      "<th>" + UI.t("Reference") + "</th><th>" + UI.t("Client") + "</th><th>" + UI.t("Route") + "</th><th>" + UI.t("Mode") + "</th><th>" + UI.t("Load") + "</th><th>" + UI.t("Status") + "</th><th>" + UI.t("ETA") + "</th>" +
      '</tr></thead><tbody id="shipBody">' + rows() + "</tbody></table></div>";

    liveSearch("shipSearch");
    
    // Insert Camera Scan button in Search Container
    const searchContainer = el.querySelector(".search");
    if (searchContainer) {
      searchContainer.insertAdjacentHTML("beforeend", 
        '<button id="btnScanQr" class="icon-btn" style="padding: 2px; margin: 0; background: none; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;" title="' + UI.t("Scan QR Code") + '">' + 
          UI.icon("camera") + 
        '</button>'
      );
      const btnScan = searchContainer.querySelector("#btnScanQr");
      if (btnScan) {
        btnScan.addEventListener("click", (e) => {
          e.stopPropagation();
          openScannerModal();
        });
      }
    }

    // Insert Bulk actions in Toolbar
    const tbEl = el.querySelector(".toolbar");
    if (tbEl) {
      const grow = tbEl.querySelector(".grow");
      if (grow) {
        grow.insertAdjacentHTML("afterend",
          '<div id="bulkActions" style="display:none; align-items:center; gap:8px; margin-right:12px;">' +
            '<button class="btn btn-ghost btn-sm" id="btnBulkPrint">' + UI.icon("printer") + ' ' + UI.t("Print") + '</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnBulkDownload">' + UI.icon("download") + ' ' + UI.t("Download") + '</button>' +
          '</div>'
        );
      }
    }

    const bulkActions = el.querySelector("#bulkActions");
    const bulkSelectAll = el.querySelector("#bulkSelectAll");
    
    function updateBulkActions() {
      const checked = el.querySelectorAll(".ship-select:checked");
      if (bulkActions) {
        bulkActions.style.display = checked.length > 0 ? "flex" : "none";
      }
      if (bulkSelectAll) {
        const totalRows = el.querySelectorAll(".ship-select").length;
        bulkSelectAll.checked = totalRows === checked.length && checked.length > 0;
      }
    }
    
    if (bulkSelectAll) {
      bulkSelectAll.addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        el.querySelectorAll(".ship-select").forEach((chk) => {
          chk.checked = isChecked;
        });
        updateBulkActions();
      });
    }
    
    el.addEventListener("change", (e) => {
      if (e.target.classList.contains("ship-select")) {
        updateBulkActions();
      }
    });

    // Bulk print labels
    const btnBulkPrint = el.querySelector("#btnBulkPrint");
    if (btnBulkPrint) {
      btnBulkPrint.addEventListener("click", async () => {
        const checked = Array.from(el.querySelectorAll(".ship-select:checked")).map((chk) => chk.dataset.id);
        const selectedShipments = list.filter((s) => checked.includes(s.id));
        if (!selectedShipments.length) return;
        
        toast("Preparing labels...");
        
        const tempContainer = document.createElement("div");
        tempContainer.style.display = "none";
        document.body.appendChild(tempContainer);
        
        const labelsData = [];
        for (const s of selectedShipments) {
          const qrDiv = document.createElement("div");
          tempContainer.appendChild(qrDiv);
          const qrUrl = window.location.origin + window.location.pathname + '#/track?id=' + s.id;
          
          new QRCode(qrDiv, {
            text: qrUrl,
            width: 140,
            height: 140,
            colorDark: "#101827",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
          });
          
          await new Promise((resolve) => setTimeout(resolve, 50));
          
          const canvas = qrDiv.querySelector("canvas");
          const img = qrDiv.querySelector("img");
          let dataUrl = "";
          if (canvas) dataUrl = canvas.toDataURL("image/png");
          else if (img) dataUrl = img.src;
          
          labelsData.push({ s, dataUrl });
          qrDiv.remove();
        }
        tempContainer.remove();
        
        const iframe = document.createElement("iframe");
        iframe.style.position = "fixed";
        iframe.style.right = "0";
        iframe.style.bottom = "0";
        iframe.style.width = "0";
        iframe.style.height = "0";
        iframe.style.border = "0";
        document.body.appendChild(iframe);
        
        const doc = iframe.contentWindow.document;
        doc.write('<html><head><title>Print Bulk Shipment Labels</title>');
        doc.write('<style>');
        doc.write('body { font-family: "Inter", "Helvetica Neue", sans-serif; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #111; }');
        doc.write('.label-card { border: 2px solid #111; padding: 20px; border-radius: 8px; width: 280px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); margin-bottom: 25px; }');
        doc.write('@media print { .label-card { page-break-after: always; } }');
        doc.write('.logo { font-size: 1.2rem; font-weight: bold; margin-bottom: 4px; color: #1aa6df; letter-spacing: 0.05em; }');
        doc.write('.ref { font-size: 1.4rem; font-weight: bold; margin: 12px 0; font-family: monospace; letter-spacing: -0.02em; }');
        doc.write('.detail { font-size: 0.85rem; margin-bottom: 6px; text-align: left; display: flex; justify-content: space-between; }');
        doc.write('.detail b { color: #555; }');
        doc.write('.qr { margin-top: 20px; display: flex; justify-content: center; }');
        doc.write('</style></head><body>');

        const labelBrand = (window.Workspace ? Workspace.company() : "WeboCloud");
        labelsData.forEach(({ s, dataUrl }) => {
          const sClient = clientMap[s.client] || {};
          doc.write('<div class="label-card">');
          doc.write('<div class="logo">' + esc(labelBrand) + '</div>');
          doc.write('<div style="font-size:0.75rem; text-transform:uppercase; color:#666; font-weight:600; letter-spacing:0.05em;">Cargo shipment label</div>');
          doc.write('<div class="ref">' + esc(s.ref) + '</div>');
          doc.write('<hr style="border:0; border-top:1px dashed #ccc; margin:12px 0;">');
          doc.write('<div class="detail"><b>Client:</b> <span>' + esc(sClient.name || "—") + '</span></div>');
          doc.write('<div class="detail"><b>Route:</b> <span>' + esc(s.origin) + ' &rarr; ' + esc(s.destination) + '</span></div>');
          doc.write('<div class="detail"><b>Mode:</b> <span>' + esc(tr(s.mode)) + '</span></div>');
          doc.write('<div class="detail"><b>Weight:</b> <span>' + esc(s.weightTons) + ' t</span></div>');
          doc.write('<div class="qr"><img src="' + dataUrl + '" width="140" height="140"></div>');
          doc.write('</div>');
        });
        
        doc.write('<script>window.onload = function() { window.print(); setTimeout(function() { window.frameElement.remove(); }, 150); };</script>');
        doc.write('</body></html>');
        doc.close();
      });
    }

    // Bulk download QR codes
    const btnBulkDownload = el.querySelector("#btnBulkDownload");
    if (btnBulkDownload) {
      btnBulkDownload.addEventListener("click", async () => {
        const checked = Array.from(el.querySelectorAll(".ship-select:checked")).map((chk) => chk.dataset.id);
        const selectedShipments = list.filter((s) => checked.includes(s.id));
        if (!selectedShipments.length) return;
        
        toast("Generating QR codes...");
        
        const tempContainer = document.createElement("div");
        tempContainer.style.display = "none";
        document.body.appendChild(tempContainer);
        
        for (let i = 0; i < selectedShipments.length; i++) {
          const s = selectedShipments[i];
          const qrDiv = document.createElement("div");
          tempContainer.appendChild(qrDiv);
          const qrUrl = window.location.origin + window.location.pathname + '#/track?id=' + s.id;
          
          new QRCode(qrDiv, {
            text: qrUrl,
            width: 250,
            height: 250,
            colorDark: "#101827",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
          });
          
          await new Promise((resolve) => setTimeout(resolve, 80));
          
          const canvas = qrDiv.querySelector("canvas");
          const img = qrDiv.querySelector("img");
          let dataUrl = "";
          if (canvas) dataUrl = canvas.toDataURL("image/png");
          else if (img) dataUrl = img.src;
          
          if (dataUrl) {
            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = "shipment-qr-" + s.ref + ".png";
            a.click();
          }
          qrDiv.remove();
        }
        tempContainer.remove();
        toast("QR codes downloaded");
      });
    }

    el.querySelector("[data-seg]").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      activeStatus = b.dataset.f; el.querySelectorAll("[data-seg] button").forEach((x) => x.classList.toggle("active", x === b));
      document.getElementById("shipBody").innerHTML = rows(); wireRows();
      updateBulkActions();
    });
    { const a = document.getElementById("shipAdd"); if (a) a.addEventListener("click", () => shipForm(null, clients)); }

    function wireRows() {
      el.querySelectorAll("tr[data-id]").forEach((tr) => {
        const s = list.find((x) => x.id === tr.dataset.id);
        tr.addEventListener("click", (e) => {
          if (e.target.closest("input[type='checkbox']")) return;
          if (e.target.closest("[data-edit]")) return shipForm(s, clients);
          if (e.target.closest("[data-del]")) return delShip(s);
          shipDrawer(s, clientMap, orderMap);
        });
      });
    }
    wireRows();

    // Auto-open shipment drawer if referenced in URL hash query
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const deepLinkId = params.get("id");
    if (deepLinkId) {
      const s = list.find((x) => x.id === deepLinkId || x.ref === deepLinkId);
      if (s) {
        setTimeout(() => shipDrawer(s, clientMap, orderMap), 150);
      }
    }
  }

  function shipDrawer(s, clientMap, orderMap) {
    const c = clientMap[s.client] || {};
    const canEdit = Auth.can("shipments", "edit");
    const track = (s.tracking || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const dotFor = (st) => SH_ST[st] || "slate";

    // cost breakdown + margin (when linked to an order)
    const co = s.costs || { freight: 0, customs: 0, insurance: 0 };
    const costTotal = (co.freight || 0) + (co.customs || 0) + (co.insurance || 0);
    const linkedOrder = orderMap && s.orderId ? orderMap[s.orderId] : null;
    const revenue = linkedOrder ? orderGross(linkedOrder) : 0;
    const margin = revenue - costTotal;
    const showMargin = Auth.can("finance", "view") || Auth.isOwner();
    const showOrders = Auth.can("orders", "view");
    const costBlock =
      '<div class="dfield" style="margin-top:14px"><div class="k">' + UI.t("Costs & margin") + (s.orderId && showOrders ? " · " + recChip("link", s.orderId, "#/orders") : "") + '</div>' +
      '<div class="cost-grid">' +
        '<div class="cb"><span>' + UI.t("Freight") + '</span><b>' + money(co.freight || 0, "USD") + "</b></div>" +
        '<div class="cb"><span>' + UI.t("Customs") + '</span><b>' + money(co.customs || 0, "USD") + "</b></div>" +
        '<div class="cb"><span>' + UI.t("Insurance") + '</span><b>' + money(co.insurance || 0, "USD") + "</b></div>" +
        '<div class="cb total"><span>' + UI.t("Total cost") + '</span><b>' + money(costTotal, "USD") + "</b></div>" +
        (linkedOrder && showMargin ? '<div class="cb"><span>' + UI.t("Order revenue") + '</span><b>' + money(revenue, linkedOrder.currency) + "</b></div>" +
          '<div class="cb ' + (margin >= 0 ? "good" : "bad") + '"><span>' + UI.t("Margin") + '</span><b>' + money(margin, "USD") + "</b></div>" : "") +
      "</div></div>";

    const timeline = track.length
      ? '<div class="timeline" style="margin-top:10px">' + track.map((t) =>
          '<div class="tl-item"><div class="tl-dot ' + dotFor(t.status) + '"></div>' +
          '<div class="tl-h"><b>' + esc(tr(t.status)) + "</b> — " + esc(t.location || "") + "</div>" +
          (t.note ? '<div style="font-size:.85rem;color:var(--ink-2);margin-top:2px">' + esc(t.note) + "</div>" : "") +
          '<div class="tl-m"><span>' + UI.icon("users") + " " + esc(t.by || "—") + "</span><span>" + UI.icon("clock") + " " + dateTime(t.ts) + "</span></div></div>").join("") + "</div>"
      : '<p class="muted" style="margin:8px 0">' + UI.t("No tracking events yet.") + '</p>';

    const updateForm = canEdit
      ? '<div class="dfield" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line)"><div class="k" style="margin-bottom:8px">' + UI.icon("route") + ' ' + UI.t("Post tracking update") + '</div>' +
        '<div class="form-row">' + field(UI.t("Status"), '<select class="select" id="uStatus">' + Object.keys(SH_ST).map((st) => '<option' + (st === s.status ? " selected" : "") + ">" + esc(st) + "</option>").join("") + "</select>") + field(UI.t("Location"), '<input class="input" id="uLoc" placeholder="' + UI.t("e.g. Tbilisi, GE") + '">') + "</div>" +
        field(UI.t("Note"), '<input class="input" id="uNote" placeholder="' + UI.t("What happened?") + '">') +
        '<button class="btn btn-primary" id="postUpdate" style="width:100%">' + UI.icon("send") + ' ' + UI.t("Post update") + '</button></div>'
      : '<p class="hint" style="margin-top:14px">' + UI.icon("shield") + ' ' + UI.t("Read-only — your role can't post tracking updates.") + '</p>';

    const qrUrl = window.location.origin + window.location.pathname + '#/track?id=' + s.id;
    const qrBlock =
      '<div class="dfield" style="margin-top:14px; padding: 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-md); display: flex; align-items: center; gap: 16px;">' +
        '<a href="' + qrUrl + '" target="_blank" style="display:flex; align-items:center; justify-content:center; background:#fff; padding:6px; border-radius:var(--r-sm); border:1px solid var(--line-2); cursor:pointer; text-decoration:none;" title="' + UI.t("Open public tracking page") + '">' +
          '<div id="shipQrCode" style="min-width:80px; min-height:80px; display:flex; align-items:center; justify-content:center;"></div>' +
        '</a>' +
        '<div style="flex:1; display:flex; flex-direction:column; gap:4px;">' +
          '<div class="k" style="margin-bottom:0">' + UI.t("Shipment QR Code") + '</div>' +
          '<div style="font-size:0.75rem; color:var(--muted); word-break:break-all; font-family:monospace;">' + esc(s.ref) + '</div>' +
          '<div style="display:flex; gap:8px; margin-top:6px;">' +
            '<button class="btn btn-ghost btn-sm" id="btnDownloadQr" style="padding:4px 8px; font-size:0.72rem; height:auto;">' + UI.icon("download") + ' ' + UI.t("Download") + '</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnPrintQr" style="padding:4px 8px; font-size:0.72rem; height:auto;">' + UI.icon("printer") + ' ' + UI.t("Print") + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    let itemsBlock = "";
    let items = s.items && s.items.length ? s.items : (linkedOrder ? linkedOrder.items : []);
    if (items && items.length) {
      const rows = items.map(it => {
        const p = _cachedProducts.find(x => x.id === it.product);
        return '<tr>' +
          '<td>' + esc(p ? p.name : it.product) + '</td>' +
          '<td style="text-align:right"><b>' + it.qty + '</b></td>' +
          '</tr>';
      }).join("");
      itemsBlock = 
        '<div class="dfield" style="margin-top:14px;">' +
          '<div class="k">' + UI.t("Shipped Items") + '</div>' +
          '<div class="tbl-wrap" style="margin-top:6px;">' +
            '<table class="tbl"><thead><tr>' +
              '<th>' + UI.t("Product") + '</th>' +
              '<th style="text-align:right">' + UI.t("Qty") + '</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>' +
          '</div>' +
        '</div>';
    }

    drawer({
      kicker: UI.t("Shipment") + " · " + tr(s.mode), title: s.ref,
      body:
        '<div class="dgrid">' +
        '<div class="dfield"><div class="k">' + UI.t("Client") + '</div><div class="v">' + esc(c.name || "—") + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Status") + '</div><div class="v">' + badge(s.status, SH_ST) + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Origin") + '</div><div class="v">' + UI.icon("pin") + " " + esc(s.origin) + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Destination") + '</div><div class="v">' + UI.icon("pin") + " " + esc(s.destination) + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Containers") + '</div><div class="v">' + s.containers + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Weight") + '</div><div class="v">' + s.weightTons + " " + UI.t("tonnes") + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Departed") + '</div><div class="v">' + date(s.departed) + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("ETA") + '</div><div class="v">' + date(s.eta) + "</div></div>" +
        "</div>" +
        '<div class="dfield" style="margin-top:8px"><div class="k">' + UI.t("Documents") + '</div><div class="v" style="display:flex;flex-wrap:wrap;gap:7px;margin-top:6px">' +
        (s.docs || []).map((d) => '<span class="tag">' + UI.icon("file") + esc(tr(d)) + "</span>").join("") + "</div></div>" +
        itemsBlock +
        qrBlock +
        costBlock +
        '<div class="dfield" style="margin-top:14px"><div class="k">' + UI.icon("history") + " " + UI.t("Tracking history") + '</div>' + timeline + '</div>' +
        updateForm,
      footer: '<button class="btn btn-ghost" onclick="UI.closeDrawer()">' + UI.t("Close") + '</button>' + (canEdit ? '<button class="btn btn-primary" data-edit>' + UI.t("Edit shipment") + '</button>' : "")
    });

    // Generate QR code inside the #shipQrCode container
    const qrContainer = document.getElementById("shipQrCode");
    if (qrContainer) {
      new QRCode(qrContainer, {
        text: qrUrl,
        width: 80,
        height: 80,
        colorDark: "#101827",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
      // Remove title attribute generated by qrcodejs to avoid generic tooltips
      setTimeout(() => {
        const qrImg = qrContainer.querySelector("img");
        if (qrImg) qrImg.removeAttribute("title");
      }, 50);
    }

    const btnDownload = document.getElementById("btnDownloadQr");
    if (btnDownload) {
      btnDownload.addEventListener("click", () => {
        const container = document.getElementById("shipQrCode");
        const canvas = container.querySelector("canvas");
        const img = container.querySelector("img");
        let dataUrl = "";
        if (canvas) {
          dataUrl = canvas.toDataURL("image/png");
        } else if (img) {
          dataUrl = img.src;
        }
        if (dataUrl) {
          const a = document.createElement("a");
          a.href = dataUrl;
          a.download = "shipment-qr-" + s.ref + ".png";
          a.click();
        } else {
          toast("QR code is not ready yet", "err");
        }
      });
    }

    const btnPrint = document.getElementById("btnPrintQr");
    if (btnPrint) {
      btnPrint.addEventListener("click", () => {
        const container = document.getElementById("shipQrCode");
        const canvas = container.querySelector("canvas");
        const img = container.querySelector("img");
        let dataUrl = "";
        if (canvas) {
          dataUrl = canvas.toDataURL("image/png");
        } else if (img) {
          dataUrl = img.src;
        }
        if (!dataUrl) return toast("QR code not ready", "err");

        const iframe = document.createElement("iframe");
        iframe.style.position = "fixed";
        iframe.style.right = "0";
        iframe.style.bottom = "0";
        iframe.style.width = "0";
        iframe.style.height = "0";
        iframe.style.border = "0";
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow.document;
        doc.write('<html><head><title>Print Shipment Label - ' + esc(s.ref) + '</title>');
        doc.write('<style>');
        doc.write('body { font-family: "Inter", "Helvetica Neue", sans-serif; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #111; }');
        doc.write('.label-card { border: 2px solid #111; padding: 20px; border-radius: 8px; width: 280px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }');
        doc.write('.logo { font-size: 1.2rem; font-weight: bold; margin-bottom: 4px; color: #1aa6df; letter-spacing: 0.05em; }');
        doc.write('.ref { font-size: 1.4rem; font-weight: bold; margin: 12px 0; font-family: monospace; letter-spacing: -0.02em; }');
        doc.write('.detail { font-size: 0.85rem; margin-bottom: 6px; text-align: left; display: flex; justify-content: space-between; }');
        doc.write('.detail b { color: #555; }');
        doc.write('.qr { margin-top: 20px; display: flex; justify-content: center; }');
        doc.write('</style></head><body>');
        doc.write('<div class="label-card">');
        doc.write('<div class="logo">' + esc(window.Workspace ? Workspace.company() : "WeboCloud") + '</div>');
        doc.write('<div style="font-size:0.75rem; text-transform:uppercase; color:#666; font-weight: 600; letter-spacing: 0.05em;">Cargo shipment label</div>');
        doc.write('<div class="ref">' + esc(s.ref) + '</div>');
        doc.write('<hr style="border:0; border-top:1px dashed #ccc; margin:12px 0;">');
        doc.write('<div class="detail"><b>Client:</b> <span>' + esc(c.name || "—") + '</span></div>');
        doc.write('<div class="detail"><b>Route:</b> <span>' + esc(s.origin) + ' &rarr; ' + esc(s.destination) + '</span></div>');
        doc.write('<div class="detail"><b>Mode:</b> <span>' + esc(tr(s.mode)) + '</span></div>');
        doc.write('<div class="detail"><b>Weight:</b> <span>' + esc(s.weightTons) + ' t</span></div>');
        doc.write('<div class="qr"><img src="' + dataUrl + '" width="140" height="140"></div>');
        doc.write('</div>');
        doc.write('<script>window.onload = function() { window.print(); setTimeout(function() { window.frameElement.remove(); }, 150); };</script>');
        doc.write('</body></html>');
        doc.close();
      });
    }

    const post = document.getElementById("postUpdate");
    if (post) post.addEventListener("click", async () => {
      const status = document.getElementById("uStatus").value;
      const location = document.getElementById("uLoc").value.trim();
      const note = document.getElementById("uNote").value.trim();
      if (!location) return toast(UI.t("Please enter a location for the update"), "err");
      const ev = { ts: new Date().toISOString(), status, location, note, by: (Auth.current() || {}).name || "—" };
      const tracking = (s.tracking || []).concat(ev);
      await Store.update("shipments", s.id, { status, tracking });
      Store.logAction("update", "shipment", s.id, "Takip: " + s.ref + " → " + status + " @ " + location);
      
      // deduct inventory stock on transit/delivery
      if (["In Transit", "Customs", "Delivered"].includes(status) && !s.stockDeducted) {
        const deductedQty = await deductInventoryForShipment(s);
        if (deductedQty > 0 && window.showSidebarAnimation) {
          showSidebarAnimation("inventory", "-" + deductedQty, "red");
        }
      }

      // delivered → hand the linked order to Finance to invoice
      if (status === "Delivered" && s.orderId) {
        const ord = await Store.get("orders", s.orderId);
        if (ord && !ord.invoiceId) await Workflow.handoffToStage("invoice", "orders", ord.id, { entity: "order", ref: ord.ref, title: UI.t("Ready to invoice"), body: UI.t("Shipment") + " " + s.ref + " " + UI.t("delivered") + " — " + UI.t("issue the invoice."), link: "#/finance" });
      }
      toast(UI.t("Update added · ") + tr(status));
      s.status = status; s.tracking = tracking;
      shipDrawer(s, clientMap, orderMap); // re-render drawer with new event
      App.reload();
    });
    const ed = document.querySelector("#ui-drawer [data-edit]");
    if (ed) ed.addEventListener("click", async () => { UI.closeDrawer(); shipForm(s, await Store.list("clients")); });
  }

  async function shipForm(s, clients) {
    const products = await Store.list("products");
    const isEdit = !!s; s = s || {};
    const ws = window.Workspace;
    const modes = ws ? ws.shipModes() : ["Railway", "Road", "Sea", "Multimodal"];
    const showFreight = ws ? ws.freightDetails() : true;
    const defOrigin = ws ? ws.origin() : "Mersin, TR";
    const clientOpts = clients.map((c) => '<option value="' + c.id + '"' + (c.id === s.client ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");

    function itemRow(selectedProdId, qty) {
      const prodOpts = products.map((p) => '<option value="' + p.id + '"' + (selectedProdId === p.id ? ' selected' : '') + '>' + esc(p.name) + "</option>").join("");
      return '<div class="form-row" data-item style="grid-template-columns:2.2fr .8fr auto;align-items:end;margin-bottom:10px">' +
        field(UI.t("Product"), '<select class="select" data-p>' + prodOpts + "</select>") +
        field(UI.t("Qty"), '<input class="input" type="number" min="1" data-q value="' + (qty || 1) + '">') +
        '<button class="icon-btn danger" data-rm style="margin-bottom:15px">' + icon("trash") + "</button></div>";
    }

    modal({
      title: isEdit ? UI.t("Edit shipment form title") : UI.t("New shipment form title"), wide: true,
      body:
        field(UI.t("Reference"), '<input class="input" name="ref" value="' + esc(s.ref || (ws ? ws.refPrefix() : "MRV-RW-24-")) + '">', true) +
        '<div class="form-row">' +
          field(UI.t("Client"), '<select class="select" name="client">' + clientOpts + "</select>", true) +
          field(UI.t("Mode"), sel("mode", s.mode || modes[0], modes)) +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Origin"), '<input class="input" name="origin" value="' + esc(s.origin || defOrigin) + '">') +
          field(UI.t("Destination"), '<input class="input" name="destination" value="' + esc(s.destination || "") + '">') +
        "</div>" +
        (showFreight ?
        '<div class="form-row">' +
          field(UI.t("Containers"), '<input class="input" type="number" min="0" data-type="number" name="containers" value="' + (s.containers || 1) + '">') +
          field(UI.t("Weight (t)"), '<input class="input" type="number" min="0" max="28" data-type="number" name="weightTons" value="' + (s.weightTons || 0) + '">') +
        "</div>" : '<input type="hidden" name="containers" data-type="number" value="' + (s.containers || 0) + '"><input type="hidden" name="weightTons" data-type="number" value="' + (s.weightTons || 0) + '">') +
        '<div class="form-row">' +
          field(UI.t("Departed"), '<input class="input" type="date" name="departed" value="' + esc(s.departed || "") + '">') +
          field(UI.t("ETA"), '<input class="input" type="date" name="eta" value="' + esc(s.eta || "") + '">') +
        "</div>" +
        field(UI.t("Status"), sel("status", s.status || "Booked", Object.keys(SH_ST))) +
        '<div class="divider" style="height:1px;background:var(--line);margin:16px 0 12px"></div>' +
        '<label style="font-size:.8rem;font-weight:600;color:var(--ink-2);display:block;margin-bottom:8px;">' + UI.t("Items to Ship") + '</label>' +
        '<div id="shipItems">' + ((s.items && s.items.length) ? s.items.map(it => itemRow(it.product, it.qty)).join("") : itemRow()) + '</div>' +
        '<button class="btn btn-ghost btn-sm" id="shipAddItem" type="button" style="margin-top:4px">' + icon("plus") + UI.t("Add item") + '</button>',
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button><button class="btn btn-primary" data-save>' + (isEdit ? UI.t("Save changes") : UI.t("Create shipment")) + "</button>",
      onMount: (m) => {
        const sync = () => {
          m.querySelectorAll("[data-item]").forEach((row) => {
            row.querySelector("[data-rm]").onclick = () => { if (m.querySelectorAll("[data-item]").length > 1) row.remove(); };
          });
        };
        sync();
        const addBtn = m.querySelector("#shipAddItem");
        if (addBtn) {
          addBtn.addEventListener("click", () => {
            const shipItems = m.querySelector("#shipItems");
            if (shipItems) {
              shipItems.insertAdjacentHTML("beforeend", itemRow());
              sync();
            }
          });
        }

        m.querySelector("[data-save]").addEventListener("click", async () => {
          const v = readForm(m);
          if (!v.ref || !v.destination) return toast(UI.t("Reference and destination are required"), "err");
          v.docs = s.docs || ["Booking Confirmation"];
          if (s.orderId) v.orderId = s.orderId;     // carry the order link through
          if (s.costs) v.costs = s.costs;
          
          v.items = [...m.querySelectorAll("[data-item]")].map((row) => ({
            product: row.querySelector("[data-p]").value,
            qty: Number(row.querySelector("[data-q]").value) || 1
          }));

          if (isEdit) {
            await Store.update("shipments", s.id, v);
            Store.logAction("update", "shipment", s.id, UI.t("Shipment updated: ") + v.ref);
            toast(UI.t("Shipment updated"));
            if (["In Transit", "Customs", "Delivered"].includes(v.status) && !s.stockDeducted) {
              const deductedQty = await deductInventoryForShipment(s);
              if (deductedQty > 0 && window.showSidebarAnimation) {
                showSidebarAnimation("inventory", "-" + deductedQty, "red");
              }
            }
          }
          else {
            const r = await Store.create("shipments", v);
            Store.logAction("create", "shipment", r.id, UI.t("New shipment (") + tr(v.mode).toLowerCase() + "): " + v.ref);
            if (v.orderId) { await Store.update("orders", v.orderId, { shipmentId: r.id, status: "Shipped" }); }  // link back to the order
            toast(UI.t("Shipment created"));
            if (["In Transit", "Customs", "Delivered"].includes(v.status)) {
              const deductedQty = await deductInventoryForShipment(r);
              if (deductedQty > 0 && window.showSidebarAnimation) {
                showSidebarAnimation("inventory", "-" + deductedQty, "red");
              }
            }
          }
          closeModal(); App.reload();
        });
      }
    });
  }
  function delShip(s) {
    confirm({ title: UI.t("Delete shipment?"), message: UI.t("This shipment will be permanently removed.") + " (" + s.ref + ")", danger: true, okLabel: UI.t("Delete") }, async () => {
      if (s.stockDeducted) {
        const qty = await restoreInventoryForShipment(s);
        if (qty > 0 && window.showSidebarAnimation) showSidebarAnimation("inventory", "+" + qty, "green");
      }
      await Store.remove("shipments", s.id); Store.logAction("delete", "shipment", s.id, "Deleted: " + s.ref); toast(UI.t("Shipment deleted")); App.reload();
    });
  }

  /* =============================================================
     INVENTORY / PRODUCTS
     ============================================================= */
  async function inventory(el) {
    const list = await Store.list("products");
    const cats = ["All", "Nano-Z Coating", "Food Supply"];
    let activeCat = "All";

    function rows() {
      const data = activeCat === "All" ? list : list.filter((p) => p.category === activeCat);
      if (!data.length) return emptyRow(7, UI.t("No products in this category."));
      return data.map((p) => {
        const st = productStatus(p.stock, p.reorder);
        const pct = Math.min(100, p.reorder ? (p.stock / (p.reorder * 2)) * 100 : 100);
        const portalPill = p.publishedToPortal
          ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:#f0fdf4;border:1px solid #86efac;border-radius:99px;font-size:.72rem;font-weight:700;color:#16a34a;white-space:nowrap">🏪 Live</span>'
          : '<span style="font-size:.78rem;color:var(--muted)">—</span>';
        const imgThumb = p.image
          ? '<img src="' + esc(p.image) + '" alt="" style="width:32px;height:32px;object-fit:cover;border-radius:6px;border:1px solid var(--line);margin-right:8px;flex-shrink:0" onerror="this.style.display=\'none\'">'
          : '';
        return '<tr data-row data-id="' + p.id + '">' +
          '<td style="display:flex;align-items:center">' + imgThumb + avatar(p.name, p.sku) + '</td>' +
          '<td><span class="tag">' + esc(tr(p.category)) + '</span></td>' +
          '<td>' + esc(p.warehouse) + '</td>' +
          '<td style="min-width:140px"><div class="flex between" style="margin-bottom:5px"><span class="strong">' + num(p.stock) + ' ' + esc(p.unit) + '</span><span class="ci-sub muted">min ' + p.reorder + '</span></div><div class="bar"><span style="width:' + pct + '%;background:' + (st === 'Out of stock' ? 'var(--red)' : st === 'Low' ? 'var(--amber)' : 'linear-gradient(90deg,var(--green),#17b277)') + '"></span></div></td>' +
          '<td class="strong">' + money(p.price, p.currency) + '</td>' +
          '<td>' + portalPill + '</td>' +
          '<td>' + badge(st, PROD_ST) + rowActs('inventory') + '</td>' +
          '</tr>';
      }).join("");
    }


    el.innerHTML =
      indTitle("inventory", "Inventory & Products", "Inventory description") +
      toolbar("prodSearch", segFilter(cats, activeCat), "New product", "prodAdd", "inventory") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      "<th>" + UI.t("Product") + "</th><th>" + UI.t("Category") + "</th><th>" + UI.t("Warehouse") + "</th><th>" + UI.t("Stock level") + "</th><th>" + UI.t("Unit price") + "</th><th>" + UI.t("Portal") + "</th><th>" + UI.t("Status") + "</th>" +
      '</tr></thead><tbody id="prodBody">' + rows() + "</tbody></table></div>";

    liveSearch("prodSearch");
    el.querySelector("[data-seg]").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      activeCat = b.dataset.f; el.querySelectorAll("[data-seg] button").forEach((x) => x.classList.toggle("active", x === b));
      document.getElementById("prodBody").innerHTML = rows(); wireRows();
    });
    { const a = document.getElementById("prodAdd"); if (a) a.addEventListener("click", () => prodForm(null)); }

    function wireRows() {
      el.querySelectorAll("tr[data-id]").forEach((tr) => {
        const p = list.find((x) => x.id === tr.dataset.id);
        tr.addEventListener("click", (e) => {
          if (e.target.closest("[data-del]")) return delProd(p);
          prodForm(p);
        });
      });
    }
    wireRows();
  }

  function prodForm(p) {
    const isEdit = !!p; p = p || {};
    const published = p.publishedToPortal === true;
    modal({
      title: isEdit ? UI.t("Edit product") : UI.t("New product"), wide: true,
      body:
        // ── Storefront publish toggle (top of form, highlighted)
        '<div style="background:linear-gradient(90deg,#f0fdf4,#eff6ff);border:1.5px solid #86efac;border-radius:10px;padding:14px 16px;margin-bottom:18px;display:flex;align-items:center;gap:14px">' +
          '<span style="font-size:1.3rem">🏪</span>' +
          '<div style="flex:1"><div style="font-weight:700;font-size:.88rem;color:#15803d;margin-bottom:2px">' + UI.t("Publish to Customer Portal") + '</div>' +
          '<div style="font-size:.78rem;color:#4b5563">' + UI.t("When enabled, this product is visible on your public storefront.") + '</div></div>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0">' +
            '<input type="checkbox" name="publishedToPortal" ' + (published ? "checked" : "") + ' style="width:18px;height:18px;accent-color:#16a34a;cursor:pointer">' +
            '<span style="font-size:.82rem;font-weight:600;color:#166534">' + (published ? UI.t("Published") : UI.t("Publish")) + '</span>' +
          '</label>' +
        '</div>' +
        // ── Core fields
        '<div class="form-row">' +
          field("SKU", '<input class="input" name="sku" value="' + esc(p.sku || "") + '">', true) +
          field(UI.t("Category"), sel("category", p.category || "Nano-Z Coating", ["Nano-Z Coating", "Food Supply", "Electronics", "Clothing", "Home & Garden", "Sports", "Beauty", "Books", "Tools", "Other"])) +
        "</div>" +
        field(UI.t("Product name"), '<input class="input" name="name" value="' + esc(p.name || "") + '">', true) +
        // ── Description (for portal)
        field(UI.t("Description (shown on storefront)"), '<textarea class="input" name="description" rows="3" placeholder="' + UI.t("Describe this product for customers…") + '" style="resize:vertical;min-height:72px">' + esc(p.description || "") + '</textarea>') +
        // ── Product image
        '<div class="form-row">' +
          field(UI.t("Image URL"), '<input class="input" name="image" placeholder="https://example.com/image.jpg" value="' + esc(p.image || "") + '">') +
          field(UI.t("Brand / Manufacturer"), '<input class="input" name="brand" placeholder="e.g. ACME Corp" value="' + esc(p.brand || "") + '">') +
        '</div>' +
        // ── Image preview
        (p.image ? '<div style="margin-bottom:16px"><img src="' + esc(p.image) + '" alt="" style="max-width:100%;max-height:120px;border-radius:8px;border:1px solid var(--line);object-fit:contain;background:#f9f9f9" onerror="this.style.display=\'none\'"></div>' : '') +
        // ── Stock fields
        '<div class="form-row">' +
          field(UI.t("Stock on hand"), '<input class="input" type="number" min="0" data-type="number" name="stock" value="' + (p.stock != null ? p.stock : 0) + '">') +
          field(UI.t("Reorder level"), '<input class="input" type="number" min="0" data-type="number" name="reorder" value="' + (p.reorder != null ? p.reorder : 0) + '">') +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Unit"), '<input class="input" name="unit" value="' + esc(p.unit || "unit") + '">') +
          field(UI.t("Warehouse"), sel("warehouse", p.warehouse || (window.Workspace ? Workspace.warehouses()[0] : "Mersin Main"), (window.Workspace ? Workspace.warehouses() : ["Mersin Main", "Mersin Cold Store", "Istanbul DC"]))) +
        '</div>' +
        '<div class="form-row">' +
          field(UI.t("Unit price"), '<input class="input" type="number" min="0" data-type="number" name="price" value="' + (p.price != null ? p.price : 0) + '">') +
          field(UI.t("Currency"), sel("currency", p.currency || "USD", ["USD", "EUR", "TRY"])) +
        '</div>',
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button><button class="btn btn-primary" data-save>' + (isEdit ? UI.t("Save changes") : UI.t("Add product")) + "</button>",
      onMount: (m) => {
        // Live image preview on URL change
        const imgInput = m.querySelector('[name="image"]');
        const pubCheckbox = m.querySelector('[name="publishedToPortal"]');
        const pubLabel = m.querySelector('[name="publishedToPortal"] + span');
        if (imgInput) {
          imgInput.addEventListener("change", () => {
            const url = imgInput.value.trim();
            let prev = m.querySelector(".img-preview");
            if (!prev && url) { prev = document.createElement("img"); prev.className="img-preview"; prev.style.cssText="max-width:100%;max-height:100px;border-radius:8px;border:1px solid var(--line);margin-bottom:12px;object-fit:contain;background:#f9f9f9;display:block"; imgInput.parentElement.appendChild(prev); }
            if (prev && url) { prev.src = url; prev.onerror=()=>prev.remove(); }
          });
        }
        if (pubCheckbox && pubLabel) {
          pubCheckbox.addEventListener("change", () => { pubLabel.textContent = pubCheckbox.checked ? UI.t("Published") : UI.t("Publish"); });
        }
        m.querySelector("[data-save]").addEventListener("click", async () => {
          const v = readForm(m);
          if (!v.sku || !v.name) return toast(UI.t("SKU and name are required"), "err");
          v.status = productStatus(v.stock, v.reorder);
          v.publishedToPortal = !!(m.querySelector('[name="publishedToPortal"]') && m.querySelector('[name="publishedToPortal"]').checked);
          if (isEdit) { await Store.update("products", p.id, v); Store.logAction("update", "product", p.id, UI.t("Product updated: ") + v.name + " (stock " + v.stock + ")"); toast(UI.t("Product updated")); }
          else { const r = await Store.create("products", v); Store.logAction("create", "product", r.id, UI.t("Product added: ") + v.name); toast(UI.t("Product added")); }
          closeModal(); App.reload();
        });
      }
    });
  }

  function delProd(p) {
    confirm({ title: UI.t("Delete product?"), message: p.name +  + " " + UI.t("will be removed from inventory."), danger: true, okLabel: UI.t("Delete") }, async () => {
      await Store.remove("products", p.id); Store.logAction("delete", "product", p.id, UI.t("Product deleted: ") + p.name); toast(UI.t("Product deleted")); App.reload();
    });
  }

  /* =============================================================
     CLIENTS
     ============================================================= */
  async function clients(el) {
    const [list, orders] = await Promise.all([Store.list("clients"), Store.list("orders")]);
    const orderCount = (id) => orders.filter((o) => o.client === id).length;

    el.innerHTML =
      indTitle("clients", "Clients", "Clients description") +
      toolbar("cliSearch", "", "New client", "cliAdd", "clients") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      "<th>" + UI.t("Client") + "</th><th>" + UI.t("Country") + "</th><th>" + UI.t("Sector") + "</th><th>" + UI.t("Primary contact") + "</th><th>" + UI.t("Orders") + "</th><th>" + UI.t("Rating") + "</th><th>" + UI.t("Status") + "</th>" +
      '</tr></thead><tbody>' +
      (list.length ? list.map((c) =>
        '<tr data-row data-id="' + c.id + '">' +
        "<td>" + avatar(c.name, UI.t("Since") + " " + new Date(c.since).getFullYear()) + "</td>" +
        '<td>' + flag(c.country) + " " + esc(c.country) + "</td>" +
        '<td><span class="tag">' + esc(c.sector) + "</span></td>" +
        "<td>" + esc(c.contact) + '<div class="ci-sub muted">' + esc(c.email) + "</div></td>" +
        '<td class="strong">' + orderCount(c.id) + "</td>" +
        "<td>" + stars(c.rating) + "</td>" +
        "<td>" + badge(c.status, CLI_ST) + rowActs("clients") + "</td>" +
        "</tr>").join("") : emptyRow(7, UI.t("No clients yet."))) +
      "</tbody></table></div>";

    liveSearch("cliSearch");
    { const a = document.getElementById("cliAdd"); if (a) a.addEventListener("click", () => cliForm(null)); }
    el.querySelectorAll("tr[data-id]").forEach((tr) => {
      const c = list.find((x) => x.id === tr.dataset.id);
      tr.addEventListener("click", (e) => { if (e.target.closest("[data-del]")) return delCli(c); cliForm(c); });
    });
  }
  function cliForm(c) {
    const isEdit = !!c; c = c || {};
    modal({
      title: isEdit ? UI.t("Edit client") : UI.t("New client"), wide: true,
      body:
        field(UI.t("Company name"), '<input class="input" name="name" value="' + esc(c.name || "") + '">', true) +
        '<div class="form-row">' +
          field(UI.t("Country"), sel("country", c.country || "TR", ["TR", "RU", "AZ", "IR", "GE", "DE", "US"])) +
          field(UI.t("Sector"), '<input class="input" name="sector" value="' + esc(c.sector || "") + '">') +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Contact person"), '<input class="input" name="contact" value="' + esc(c.contact || "") + '">') +
          field(UI.t("Status"), sel("status", c.status || "Active", ["Active", "On hold", "Inactive"])) +
        "</div>" +
        '<div class="form-row">' +
          field("E-posta", '<input class="input" type="email" name="email" value="' + esc(c.email || "") + '">') +
          field(UI.t("Phone"), '<input class="input" name="phone" value="' + esc(c.phone || "") + '">') +
        "</div>" +
        field(UI.t("Rating (1-5)"), '<input class="input" type="number" min="1" max="5" data-type="number" name="rating" value="' + (c.rating || 4) + '">'),
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button><button class="btn btn-primary" data-save>' + (isEdit ? UI.t("Save changes") : UI.t("Create client")) + "</button>",
      onMount: (m) => m.querySelector("[data-save]").addEventListener("click", async () => {
        const v = readForm(m);
        if (!v.name) return toast(UI.t("Company name is required"), "err");
        if (isEdit) { await Store.update("clients", c.id, v); Store.logAction("update", "client", c.id, UI.t("Client updated: ") + v.name); toast(UI.t("Client updated")); }
        else { v.since = new Date().toISOString().slice(0, 10); const r = await Store.create("clients", v); Store.logAction("create", "client", r.id, UI.t("Client added: ") + v.name); toast(UI.t("Client created")); }
        closeModal(); App.reload();
      })
    });
  }
  function delCli(c) {
    confirm({ title: UI.t("Delete client?"), message: c.name +  + " " + UI.t("will be removed."), danger: true, okLabel: UI.t("Delete") }, async () => {
      await Store.remove("clients", c.id); Store.logAction("delete", "client", c.id, UI.t("Client deleted: ") + c.name); toast(UI.t("Client deleted")); App.reload();
    });
  }

  /* =============================================================
     SUPPLIERS
     ============================================================= */
  async function suppliers(el) {
    const list = await Store.list("suppliers");
    el.innerHTML =
      indTitle("suppliers", "Suppliers", "Suppliers description") +
      toolbar("supSearch", "", "New supplier", "supAdd", "suppliers") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      "<th>" + UI.t("Supplier") + "</th><th>" + UI.t("Country") + "</th><th>" + UI.t("Category") + "</th><th>" + UI.t("Contact") + "</th><th>" + UI.t("Rating") + "</th>" +
      '</tr></thead><tbody>' +
      (list.length ? list.map((s) =>
        '<tr data-row data-id="' + s.id + '">' +
        "<td>" + avatar(s.name, s.id) + "</td>" +
        "<td>" + flag(s.country) + " " + esc(s.country) + "</td>" +
        '<td><span class="tag">' + esc(s.category) + "</span></td>" +
        "<td>" + esc(s.contact) + '<div class="ci-sub muted">' + esc(s.email) + "</div></td>" +
        "<td>" + stars(s.rating) + rowActs("suppliers") + "</td>" +
        "</tr>").join("") : emptyRow(5, UI.t("No suppliers yet."))) +
      "</tbody></table></div>";

    liveSearch("supSearch");
    { const a = document.getElementById("supAdd"); if (a) a.addEventListener("click", () => supForm(null)); }
    el.querySelectorAll("tr[data-id]").forEach((tr) => {
      const s = list.find((x) => x.id === tr.dataset.id);
      tr.addEventListener("click", (e) => { if (e.target.closest("[data-del]")) return delSup(s); supForm(s); });
    });
  }
  function supForm(s) {
    const isEdit = !!s; s = s || {};
    modal({
      title: isEdit ? UI.t("Edit supplier") : UI.t("New supplier"), wide: true,
      body:
        field(UI.t("Supplier name"), '<input class="input" name="name" value="' + esc(s.name || "") + '">', true) +
        '<div class="form-row">' +
          field(UI.t("Country"), sel("country", s.country || "TR", ["TR", "RU", "AZ", "IR", "GE", "DE", "US"])) +
          field("Kategori", '<input class="input" name="category" value="' + esc(s.category || "") + '">') +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Contact person"), '<input class="input" name="contact" value="' + esc(s.contact || "") + '">') +
          field(UI.t("Rating (1-5)"), '<input class="input" type="number" min="1" max="5" data-type="number" name="rating" value="' + (s.rating || 4) + '">') +
        "</div>" +
        '<div class="form-row">' +
          field("E-posta", '<input class="input" type="email" name="email" value="' + esc(s.email || "") + '">') +
          field(UI.t("Phone"), '<input class="input" name="phone" value="' + esc(s.phone || "") + '">') +
        "</div>",
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button><button class="btn btn-primary" data-save>' + (isEdit ? UI.t("Save changes") : UI.t("Create supplier")) + "</button>",
      onMount: (m) => m.querySelector("[data-save]").addEventListener("click", async () => {
        const v = readForm(m);
        if (!v.name) return toast(UI.t("Supplier name is required"), "err");
        if (isEdit) { await Store.update("suppliers", s.id, v); Store.logAction("update", "supplier", s.id, UI.t("Supplier updated: ") + v.name); toast(UI.t("Supplier updated")); }
        else { const r = await Store.create("suppliers", v); Store.logAction("create", "supplier", r.id, UI.t("Supplier added: ") + v.name); toast(UI.t("Supplier created")); }
        closeModal(); App.reload();
      })
    });
  }
  function delSup(s) {
    confirm({ title: UI.t("Delete supplier?"), message: s.name +  + " " + UI.t("will be removed."), danger: true, okLabel: UI.t("Delete") }, async () => {
      await Store.remove("suppliers", s.id); Store.logAction("delete", "supplier", s.id, UI.t("Supplier deleted: ") + s.name); toast(UI.t("Supplier deleted")); App.reload();
    });
  }

  /* =============================================================
     ORDERS
     ============================================================= */
  async function orders(el) {
    const [list, clients, products] = await Promise.all([Store.list("orders"), Store.list("clients"), Store.list("products")]);
    const clientMap = Object.fromEntries(clients.map((c) => [c.id, c]));
    const prodMap = Object.fromEntries(products.map((p) => [p.id, p]));
    const total = (o) => o.items.reduce((a, it) => a + it.qty * it.price, 0);
    const statuses = ["All", "Pending", "Confirmed", "Shipped", "Completed", "Cancelled"];
    let activeStatus = "All";

    function rows() {
      const data = activeStatus === "All" ? list : list.filter((o) => o.status === activeStatus);
      if (!data.length) return emptyRow(6, UI.t("No orders in this status."));
      return data.map((o) =>
        '<tr data-row data-id="' + o.id + '">' +
        '<td class="mono strong">' + esc(o.ref) + "</td>" +
        "<td>" + esc((clientMap[o.client] || {}).name || "—") + "</td>" +
        "<td>" + date(o.date) + "</td>" +
        '<td>' + o.items.length + " " + UI.t(o.items.length > 1 ? "Items" : "Item") + "</td>" +
        '<td class="strong">' + money(total(o), o.currency) + "</td>" +
        "<td>" + badge(o.status, ORD_ST) +
          (Auth.can("orders", "delete") ? '<div class="row-actions" style="margin-top:2px"><button class="icon-btn danger" data-del>' + icon("trash") + "</button></div>" : "") + "</td>" +
        "</tr>").join("");
    }

    el.innerHTML =
      indTitle("orders", "Orders", "Purchase orders across distribution & supply lines") +
      toolbar("ordSearch", segFilter(statuses, activeStatus), "New order", "ordAdd", "orders") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      "<th>" + UI.t("Order ref") + "</th><th>" + UI.t("Client") + "</th><th>" + UI.t("Date") + "</th><th>" + UI.t("Items") + "</th><th>" + UI.t("Total") + "</th><th>" + UI.t("Status") + "</th>" +
      '</tr></thead><tbody id="ordBody">' + rows() + "</tbody></table></div>";

    liveSearch("ordSearch");
    el.querySelector("[data-seg]").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      activeStatus = b.dataset.f; el.querySelectorAll("[data-seg] button").forEach((x) => x.classList.toggle("active", x === b));
      document.getElementById("ordBody").innerHTML = rows(); wireRows();
    });
    { const a = document.getElementById("ordAdd"); if (a) a.addEventListener("click", () => ordForm(clients, products)); }

    function wireRows() {
      el.querySelectorAll("tr[data-id]").forEach((tr) => {
        const o = list.find((x) => x.id === tr.dataset.id);
        tr.addEventListener("click", (e) => { if (e.target.closest("[data-del]")) return delOrd(o); ordDrawer(o, clientMap, prodMap, total); });
      });
    }
    wireRows();
  }

  function ordDrawer(o, clientMap, prodMap, total) {
    const c = clientMap[o.client] || {};
    const canEdit = Auth.can("orders", "edit");
    const sub = sumItems(o.items);
    const gross = orderGross(o);
    const linkChip = (id, hash, ic) => id ? recChip(ic, id, hash) : '<span class="muted">' + UI.t("not yet") + "</span>";

    const linksList = [];
    if (o.quoteId && Auth.can("quotes", "view")) {
      linksList.push('<span class="link-lbl">' + UI.t("Quote") + ":</span> " + linkChip(o.quoteId, "#/quotes", "quote"));
    }
    if (o.shipmentId && Auth.can("shipments", "view")) {
      linksList.push('<span class="link-lbl">' + UI.t("Shipment") + ":</span> " + linkChip(o.shipmentId, "#/shipments", "truck"));
    }
    if (o.invoiceId && Auth.can("finance", "view")) {
      linksList.push('<span class="link-lbl">' + UI.t("Invoice") + ":</span> " + linkChip(o.invoiceId, "#/finance", "receipt"));
    }
    const linkedRecordsHTML = linksList.length > 0
      ? '<div class="dfield"><div class="k">' + UI.t("Linked records") + '</div><div class="v flex" style="gap:8px;flex-wrap:wrap;margin-top:4px">' + linksList.join(" ") + '</div></div>'
      : '';

    drawer({
      kicker: UI.t("Order"), title: o.ref,
      body:
        '<div class="dgrid">' +
        '<div class="dfield"><div class="k">' + UI.t("Client") + '</div><div class="v">' + esc(c.name || "—") + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Date") + '</div><div class="v">' + date(o.date) + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Status") + '</div><div class="v">' + badge(o.status, ORD_ST) + "</div></div>" +
        '<div class="dfield"><div class="k">' + UI.t("Total") + '</div><div class="v strong">' + money(gross, o.currency) + "</div></div>" +
        "</div>" +
        linkedRecordsHTML +
        '<div class="dfield"><div class="k">' + UI.t("Line items") + '</div></div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + UI.t("Product") + '</th><th class="right">' + UI.t("Qty") + '</th><th class="right">' + UI.t("Price") + '</th><th class="right">' + UI.t("Sub") + '</th></tr></thead><tbody>' +
        o.items.map((it) => {
          const p = prodMap[it.product] || {};
          return "<tr><td>" + esc(p.name || it.product) + '</td><td class="right">' + it.qty + '</td><td class="right">' + money(it.price, o.currency) + '</td><td class="right strong">' + money(it.qty * it.price, o.currency) + "</td></tr>";
        }).join("") +
        (o.freight ? '<tr><td colspan="3">' + UI.t("Freight") + '</td><td class="right">' + money(o.freight, o.currency) + "</td></tr>" : "") +
        '<tr><td colspan="3" class="strong">' + UI.t("Total") + '</td><td class="right strong">' + money(gross, o.currency) + "</td></tr>" +
        "</tbody></table></div>" +
        '<div class="dfield" style="margin-top:16px"><div class="k">' + UI.t("Advance status") + '</div><div class="flex" style="gap:8px;margin-top:6px;flex-wrap:wrap">' +
        Object.keys(ORD_ST).map((st) => '<button class="btn btn-ghost btn-sm" data-st="' + esc(st) + '"' + (st === o.status ? ' style="border-color:var(--accent);color:var(--accent)"' : "") + ">" + esc(tr(st)) + "</button>").join("") +
        "</div></div>",
      footer: '<button class="btn btn-ghost" onclick="UI.closeDrawer()">' + UI.t("Close") + "</button>" +
        (canEdit && o.status !== "Cancelled" && !o.shipmentId && Auth.can("shipments", "edit") ? '<button class="btn btn-dark" id="ordShip">' + icon("truck") + UI.t("Create shipment") + "</button>" : "") +
        (canEdit && o.status !== "Cancelled" && !o.invoiceId && Auth.can("finance", "edit") ? '<button class="btn btn-primary" id="ordInv">' + icon("receipt") + UI.t("Generate invoice") + "</button>" : "")
    });
    document.querySelectorAll("#ui-drawer [data-st]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.st === "Cancelled" && o.shipmentId) {
        const sh = await Store.get("shipments", o.shipmentId);
        if (sh && sh.stockDeducted) {
          const qty = await restoreInventoryForShipment(sh);
          if (qty > 0 && window.showSidebarAnimation) showSidebarAnimation("inventory", "+" + qty, "green");
        }
      }
      await Store.update("orders", o.id, { status: b.dataset.st });
      Store.logAction("update", "order", o.id, "Order " + o.ref + " → " + b.dataset.st);
      toast(UI.t("Status") + " → " + tr(b.dataset.st)); UI.closeDrawer(); App.reload();
    }));
    const sh = document.getElementById("ordShip");
    if (sh) sh.addEventListener("click", async () => {
      const clients = await Store.list("clients");
      UI.closeDrawer();
      const sw = window.Workspace;
      shipForm({ ref: sw ? sw.refPrefix() : "MRV-RW-24-", client: o.client, mode: (sw ? sw.shipModes()[0] : "Railway"), origin: (sw ? sw.origin() : "Mersin, TR"), destination: "", containers: 1, weightTons: 0, status: "Booked", departed: "", eta: "", docs: ["Booking Confirmation"], orderId: o.id, costs: { freight: 0, customs: 0, insurance: 0 } }, clients);
    });
    const inv = document.getElementById("ordInv");
    if (inv) inv.addEventListener("click", () => orderToInvoice(o));
  }

  function ordForm(clients, products) {
    const clientOpts = clients.map((c) => '<option value="' + c.id + '">' + esc(c.name) + "</option>").join("");
    const prodOpts = products.map((p) => '<option value="' + p.id + '" data-price="' + p.price + '">' + esc(p.name) + "</option>").join("");
    function itemRow() {
      return '<div class="form-row" data-item style="grid-template-columns:1.6fr .6fr .8fr auto;align-items:end;margin-bottom:10px">' +
        field(UI.t("Product"), '<select class="select" data-p>' + prodOpts + "</select>") +
        field(UI.t("Qty"), '<input class="input" type="number" min="1" data-q value="1">') +
        field(UI.t("Price"), '<input class="input" type="number" min="0" data-pr value="' + (products[0] ? products[0].price : 0) + '">') +
        '<button class="icon-btn danger" data-rm style="margin-bottom:15px">' + icon("trash") + "</button></div>";
    }
    modal({
      title: UI.t("New order"), wide: true,
      body:
        '<div class="form-row">' +
          field(UI.t("Client"), '<select class="select" name="client">' + clientOpts + "</select>", true) +
          field(UI.t("Currency"), sel("currency", "USD", ["USD", "EUR", "TRY"])) +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Date"), '<input class="input" type="date" name="date" value="' + new Date().toISOString().slice(0, 10) + '">') +
          field(UI.t("Status"), sel("status", "Pending", ["Pending", "Confirmed", "Shipped", "Completed", "Cancelled"])) +
        "</div>" +
        '<div class="divider"></div><label style="font-size:.8rem;font-weight:600;color:var(--ink-2)">' + UI.t("Line items") + '</label>' +
        '<div id="ordItems">' + itemRow() + "</div>" +
        '<button class="btn btn-ghost btn-sm" id="ordAddItem">' + icon("plus") + UI.t("Add item") + '</button>',
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button><button class="btn btn-primary" data-save>' + UI.t("Create order") + '</button>',
      onMount: (m) => {
        const sync = () => {
          m.querySelectorAll("[data-item]").forEach((row) => {
            const s = row.querySelector("[data-p]");
            s.onchange = () => { row.querySelector("[data-pr]").value = s.selectedOptions[0].dataset.price; };
            row.querySelector("[data-rm]").onclick = () => { if (m.querySelectorAll("[data-item]").length > 1) row.remove(); };
          });
        };
        sync();
        m.querySelector("#ordAddItem").addEventListener("click", () => { m.querySelector("#ordItems").insertAdjacentHTML("beforeend", itemRow()); sync(); });
        m.querySelector("[data-save]").addEventListener("click", async () => {
          const base = readForm(m);
          const items = [...m.querySelectorAll("[data-item]")].map((row) => ({
            product: row.querySelector("[data-p]").value,
            qty: Number(row.querySelector("[data-q]").value) || 1,
            price: Number(row.querySelector("[data-pr]").value) || 0
          }));
          const ref = "PO-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 9000) + 1000);
          const r = await Store.create("orders", { ref, client: base.client, date: base.date, status: base.status, currency: base.currency, items });
          Store.logAction("create", "order", r.id, "Created order " + ref); toast(UI.t("Order created")); closeModal(); App.reload();
          if (window.showSidebarAnimation) {
            showSidebarAnimation("orders", "+1", "blue");
          }
        });
      }
    });
  }
  function delOrd(o) {
    confirm({ title: UI.t("Delete order?"), message: o.ref + " " + UI.t("will be removed."), danger: true, okLabel: UI.t("Delete") }, async () => {
      await Store.remove("orders", o.id); Store.logAction("delete", "order", o.id, "Deleted order " + o.ref); toast(UI.t("Order deleted")); App.reload();
    });
  }

  /* =============================================================
     FINANCE / INVOICES
     ============================================================= */
  async function finance(el) {
    const [list, clients] = await Promise.all([Store.list("invoices"), Store.list("clients")]);
    const clientMap = Object.fromEntries(clients.map((c) => [c.id, c]));
    const statuses = ["All", "Draft", "Sent", "Paid", "Overdue"];
    let activeStatus = "All";

    const getInvoiceTotal = (i) => i.totalAmount !== undefined ? i.totalAmount : i.amount;
    const paid = list.filter((i) => i.status === "Paid").reduce((a, i) => a + getInvoiceTotal(i), 0);
    const out = list.filter((i) => ["Sent", "Overdue", "Draft"].includes(i.status)).reduce((a, i) => a + getInvoiceTotal(i), 0);
    const overdue = list.filter((i) => i.status === "Overdue").reduce((a, i) => a + getInvoiceTotal(i), 0);

    function rows() {
      const data = activeStatus === "All" ? list : list.filter((i) => i.status === activeStatus);
      if (!data.length) return emptyRow(7, UI.t("No invoices in this status."));
      return data.map((i) =>
        '<tr data-row data-id="' + i.id + '">' +
        '<td class="mono strong">' + esc(i.no) + "</td>" +
        "<td>" + esc((clientMap[i.client] || {}).name || "—") + "</td>" +
        "<td>" + date(i.issued) + "</td>" +
        "<td>" + date(i.due) + "</td>" +
        '<td class="strong">' + money(getInvoiceTotal(i), i.currency) + "</td>" +
        "<td>" + badge(i.status, INV_ST) + "</td>" +
        '<td class="actions"><div class="row-actions">' +
          '<button class="icon-btn" data-pdf title="' + UI.t("Export PDF") + '">' + icon("file") + "</button>" +
          (Auth.can("finance", "edit") && i.status !== "Paid" && i.status !== "Draft" ? '<button class="icon-btn" data-paid title="' + UI.t("Record payment") + '">' + icon("wallet") + "</button>" : "") +
          (Auth.can("finance", "delete") ? '<button class="icon-btn danger" data-del>' + icon("trash") + "</button>" : "") +
          "</div></td>" +
        "</tr>").join("");
    }

    const kpi = (ic, color, n, l) => '<div class="kpi"><div class="ic ' + color + '">' + icon(ic) + '</div><div class="n">' + n + '</div><div class="l">' + l + "</div></div>";
    const finTools =
      '<div class="toolbar">' +
      '<div class="search">' + icon("search") + '<input id="finSearch" placeholder="' + UI.t("Search…") + '" autocomplete="off"></div>' +
      segFilter(statuses, activeStatus) + '<div class="grow"></div>' +
      (Auth.can("finance", "edit") ? '<button class="btn btn-primary" id="finAdd">' + icon("plus") + UI.t("New invoice") + '</button>' : "") +
      "</div>";

    el.innerHTML =
      '<div class="section-title"><div><h2>' + UI.t("Finance & Invoices") + '</h2><p>' + UI.t("Receivables across all service lines") + '</p></div></div>' +
      '<div class="kpis" style="grid-template-columns:repeat(3,1fr)">' +
        kpi("check", "green", money(paid, "USD"), UI.t("Collected (paid)")) +
        kpi("dollar", "gold", money(out, "USD"), UI.t("Outstanding")) +
        kpi("alert", "purple", money(overdue, "USD"), UI.t("Overdue")) +
      "</div>" +
      finTools +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      "<th>" + UI.t("Invoice") + "</th><th>" + UI.t("Client") + "</th><th>" + UI.t("Issued") + "</th><th>" + UI.t("Due") + "</th><th>" + UI.t("Amount") + "</th><th>" + UI.t("Status") + "</th><th></th>" +
      '</tr></thead><tbody id="finBody">' + rows() + "</tbody></table></div>";

    liveSearch("finSearch");
    el.querySelector("[data-seg]").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      activeStatus = b.dataset.f; el.querySelectorAll("[data-seg] button").forEach((x) => x.classList.toggle("active", x === b));
      document.getElementById("finBody").innerHTML = rows(); wireRows();
    });
    { const a = document.getElementById("finAdd"); if (a) a.addEventListener("click", () => invForm(clients)); }

    function wireRows() {
      el.querySelectorAll("tr[data-id]").forEach((tr) => {
        const i = list.find((x) => x.id === tr.dataset.id);
        tr.addEventListener("click", async (e) => {
          if (e.target.closest("[data-paid]")) return recordInvoicePayment(i);
          if (e.target.closest("[data-del]")) return delInv(i);
          if (e.target.closest("[data-pdf]")) return exportInvoicePDF(i, clients);
          invForm(clients, i);
        });
      });
    }
    wireRows();
  }

  async function exportInvoicePDF(i, clients) {
    const client = clients.find(c => c.id === i.client) || {};
    let items = [];
    let freight = 0;
    if (i.order) {
      const order = await Store.get("orders", i.order);
      if (order) {
        const products = await Store.list("products");
        const prodMap = Object.fromEntries(products.map(p => [p.id, p]));
        items = (order.items || []).map(it => {
          const p = prodMap[it.product] || {};
          return { name: p.name || it.product, qty: it.qty, price: it.price };
        });
        freight = order.freight || 0;
      }
    }
    if (items.length === 0) {
      items = [{ name: "Consolidated trade operations / services", qty: 1, price: i.amount }];
    }

    // brand the document to the signed-in workspace (falls back to platform default)
    const B = window.Workspace ? Workspace.brand() : { company: "WeboCloud", tagline: "", email: "" };

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write('<html><head><title>Invoice_' + i.no + '</title><style>');
    doc.write('body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; padding: 40px; color: #333; line-height: 1.5; }');
    doc.write('.header { display: flex; justify-content: space-between; margin-bottom: 40px; }');
    doc.write('.logo { font-size: 1.8rem; font-weight: bold; color: #1aa6df; }');
    doc.write('.title { font-size: 2rem; font-weight: bold; text-align: right; margin: 0; }');
    doc.write('.details { display: flex; justify-content: space-between; margin-bottom: 40px; }');
    doc.write('.details-col { flex: 1; }');
    doc.write('.details-col h4 { margin: 0 0 8px 0; color: #777; text-transform: uppercase; font-size: 0.8rem; letter-spacing: 0.05em; }');
    doc.write('.tbl { width: 100%; border-collapse: collapse; margin-bottom: 40px; }');
    doc.write('.tbl th, .tbl td { padding: 12px; border-bottom: 1px solid #eee; text-align: left; }');
    doc.write('.tbl th { background-color: #f9f9f9; font-weight: bold; color: #555; }');
    doc.write('.tbl td.right, .tbl th.right { text-align: right; }');
    doc.write('.total-box { text-align: right; font-size: 1.2rem; font-weight: bold; margin-top: 20px; }');
    doc.write('.footer { margin-top: 60px; border-top: 1px solid #eee; padding-top: 20px; text-align: center; color: #777; font-size: 0.85rem; }');
    doc.write('</style></head><body>');

    doc.write('<div class="header">');
    doc.write('  <div><div class="logo">' + esc(B.company) + '</div>' + (B.tagline ? '<div style="font-size:0.85rem; color:#666;">' + esc(B.tagline) + '</div>' : '') + '</div>');
    doc.write('  <div><h1 class="title">INVOICE</h1><div style="text-align:right; font-family:monospace; font-size:1.1rem; font-weight:bold; margin-top:5px;">' + i.no + '</div></div>');
    doc.write('</div>');

    doc.write('<div class="details">');
    doc.write('  <div class="details-col">');
    doc.write('    <h4>Billed From</h4>');
    doc.write('    <strong>' + esc(B.company) + (B.tagline ? ' ' + esc(B.tagline) : '') + '</strong><br>');
    if (B.email) doc.write('    ' + esc(B.email) + '<br>');
    doc.write('  </div>');
    doc.write('  <div class="details-col">');
    doc.write('    <h4>Billed To</h4>');
    doc.write('    <strong>' + esc(client.name || "—") + '</strong><br>');
    if (client.contact) doc.write('    Attn: ' + esc(client.contact) + '<br>');
    if (client.phone) doc.write('    Phone: ' + esc(client.phone) + '<br>');
    if (client.country) doc.write('    Country: ' + esc(client.country) + '<br>');
    doc.write('  </div>');
    doc.write('  <div class="details-col" style="text-align:right;">');
    doc.write('    <h4>Invoice Details</h4>');
    doc.write('    <b>Issued:</b> ' + date(i.issued) + '<br>');
    doc.write('    <b>Due Date:</b> ' + date(i.due) + '<br>');
    doc.write('    <b>Status:</b> ' + esc(tr(i.status)) + '<br>');
    doc.write('  </div>');
    doc.write('</div>');

    doc.write('<table class="tbl">');
    doc.write('  <thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Unit Price</th><th class="right">Total</th></tr></thead>');
    doc.write('  <tbody>');
    items.forEach(it => {
      doc.write('    <tr><td>' + esc(it.name) + '</td><td class="right">' + it.qty + '</td><td class="right">' + money(it.price, i.currency) + '</td><td class="right">' + money(it.qty * it.price, i.currency) + '</td></tr>');
    });
    if (freight > 0) {
      doc.write('    <tr><td colspan="3">Freight & Logistics Services</td><td class="right">' + money(freight, i.currency) + '</td></tr>');
    }
    doc.write('  </tbody>');
    doc.write('</table>');

    const vatRate = i.vatRate !== undefined ? i.vatRate : 0;
    const vatAmount = i.vatAmount !== undefined ? i.vatAmount : 0;
    const totalAmount = i.totalAmount !== undefined ? i.totalAmount : i.amount;

    doc.write('<div style="display: flex; flex-direction: column; align-items: flex-end; font-size: 1rem; margin-top: 20px;">');
    doc.write('  <div style="display: flex; justify-content: space-between; width: 300px; margin-bottom: 5px;">');
    doc.write('    <span>' + esc(tr("Subtotal (Matrah)")) + ':</span>');
    doc.write('    <span>' + money(i.amount, i.currency) + '</span>');
    doc.write('  </div>');
    doc.write('  <div style="display: flex; justify-content: space-between; width: 300px; margin-bottom: 5px;">');
    doc.write('    <span>' + esc(tr("VAT (KDV) Amount")) + ' (' + vatRate + '%):</span>');
    doc.write('    <span>' + money(vatAmount, i.currency) + '</span>');
    doc.write('  </div>');
    doc.write('  <div style="display: flex; justify-content: space-between; width: 300px; font-size: 1.25rem; font-weight: bold; border-top: 2px solid #333; padding-top: 5px;">');
    doc.write('    <span>' + esc(tr("Grand Total")) + ':</span>');
    doc.write('    <span>' + money(totalAmount, i.currency) + '</span>');
    doc.write('  </div>');
    doc.write('</div>');

    doc.write('<div class="footer">');
    doc.write('  Thank you for your business. Payment is due within ' + (client.terms || 30) + ' days.<br>');
    doc.write('  © ' + new Date().getFullYear() + ' ' + esc(B.company) + (B.tagline ? ' · ' + esc(B.tagline) : ''));
    doc.write('</div>');

    doc.write('<script>window.onload = function() { window.print(); setTimeout(function() { window.frameElement.remove(); }, 150); };</script>');
    doc.write('</body></html>');
    doc.close();
  }

  /* ---- AI Accountant: full-ledger analysis ---- */
  function aiAccountant(invoices, clientMap) {
    const live = AI.hasKey();
    const s = AI.summarize(invoices, clientMap);
    const tr = UI.getLang() === "tr";
    const micSvg = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg>';
    const volSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>';
    const suggestions = tr
      ? ["Kâr-zarar", "Nakit & işletme sermayesi", "Envanter değeri", "Bordro", "Riskler nedir?"]
      : ["P&L", "Cash & working capital", "Inventory value", "Payroll", "What are the risks?"];

    modal({
      title: UI.t("AI Accountant"), wide: true,
      body:
        '<div class="ai-chat-wrap">' +
          '<div class="ai-head">' +
            '<div class="ai-orb">' + icon("sparkles") + "</div>" +
            '<div class="ai-head-txt"><div class="ai-title">' + UI.t("AI Accountant") + "</div>" +
            '<div class="ai-sub">' + (live ? UI.t("Powered by Google Gemini") + " · " + AI.model() : UI.t("Offline analysis engine · add a Gemini key in Settings for live AI")) + "</div></div>" +
            '<span class="ai-badge' + (live ? " live" : "") + '" id="aiBadge">' + icon(live ? "sparkles" : "shield") + (live ? " Gemini" : " " + UI.t("Offline")) + "</span>" +
          "</div>" +
          '<div class="ai-stats">' +
            '<div class="ai-stat"><div class="v">' + money(s.totalBilled, "USD") + '</div><div class="k">' + UI.t("Billed") + "</div></div>" +
            '<div class="ai-stat green"><div class="v">' + money(s.collected, "USD") + '</div><div class="k">' + UI.t("Collected") + "</div></div>" +
            '<div class="ai-stat gold"><div class="v">' + money(s.outstanding, "USD") + '</div><div class="k">' + UI.t("Outstanding") + "</div></div>" +
            '<div class="ai-stat red"><div class="v">' + money(s.overdueTotal, "USD") + '</div><div class="k">' + UI.t("Overdue") + "</div></div>" +
          "</div>" +
          '<div class="ai-msgs" id="aiMsgs"></div>' +
          '<div class="ai-suggest" id="aiSuggest">' + suggestions.map((q) => '<button class="ai-chip" data-q="' + esc(q) + '">' + esc(q) + "</button>").join("") + "</div>" +
        "</div>",
      footer:
        '<div class="ai-inputbar">' +
          '<button class="ai-iconbtn" id="aiMic" title="' + UI.t("Speak") + '">' + micSvg + "</button>" +
          '<input id="aiInput" class="ai-input" placeholder="' + UI.t("Ask anything") + '" autocomplete="off">' +
          '<button class="ai-iconbtn" id="aiSpeak" title="' + UI.t("Read replies aloud") + '">' + volSvg + "</button>" +
          '<button class="ai-sendbtn" id="aiSend" title="' + UI.t("Send") + '">' + icon("send") + "</button>" +
        "</div>",
      wide: true
    });

    {
        const history = [];
        let busy = false, ttsOn = false, listening = false, rec = null;
        const $ = (id) => document.getElementById(id);
        const msgs = $("aiMsgs");

        function scroll() { msgs.scrollTop = msgs.scrollHeight; }
        function pushMsg(role, html) {
          const d = document.createElement("div");
          d.className = "ai-msg " + (role === "user" ? "ai-user" : "ai-bot");
          d.innerHTML = (role === "user" ? "" : '<div class="ai-mini-orb">' + icon("sparkles") + "</div>") + '<div class="ai-bubble">' + html + "</div>";
          msgs.appendChild(d); scroll(); return d;
        }
        function typing(on) {
          let t = $("aiTyping");
          if (on && !t) { t = document.createElement("div"); t.className = "ai-msg ai-bot"; t.id = "aiTyping"; t.innerHTML = '<div class="ai-mini-orb">' + icon("sparkles") + '</div><div class="ai-bubble"><span class="ai-typing"><i></i><i></i><i></i></span></div>'; msgs.appendChild(t); scroll(); }
          else if (!on && t) t.remove();
        }
        function setBadge(src) { const b = $("aiBadge"); if (!b) return; b.className = "ai-badge" + (src === "gemini" ? " live" : ""); b.innerHTML = icon(src === "gemini" ? "sparkles" : "shield") + " " + (src === "gemini" ? "Gemini" : UI.t("Offline")); }
        function speak(text) { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = tr ? "tr-TR" : "en-US"; u.rate = 1.03; speechSynthesis.speak(u); } catch (e) {} }

        async function send(q) {
          q = (q || "").trim(); if (!q || busy) return;
          busy = true;
          const sg = $("aiSuggest"); if (sg) sg.style.display = "none";
          pushMsg("user", esc(q)); $("aiInput").value = ""; typing(true);
          const res = await AI.chat({ invoices: invoices, clientMap: clientMap, history: history, question: q });
          typing(false);
          pushMsg("bot", AI.render(res.text));
          history.push({ role: "user", text: q }, { role: "assistant", text: res.text });
          setBadge(res.source);
          if (ttsOn) speak(AI.strip(res.text));
          Store.logAction("ai", "finance", "—", "AI chat (" + res.source + "): " + q.slice(0, 60));
          busy = false;
        }

        // opening greeting — branded to the signed-in company
        const coName = window.Workspace ? Workspace.company() : "WeboCloud";
        const greet = tr
          ? "Merhaba 👋 Ben " + coName + " **baş muhasebecisiyim** — şirketin tüm defterlerine erişimim var (satış, alış, nakit, envanter, bordro). Kâr-zarar, nakit durumu, riskler… ne öğrenmek istersiniz?"
          : "Hi 👋 I'm the " + coName + " **chief accountant** — I can read the whole company's books (sales, purchases, cash, inventory, payroll). Ask me about P&L, cash position, risks… what would you like to know?";
        pushMsg("bot", AI.render(greet));

        // wiring
        $("aiSend").addEventListener("click", () => send($("aiInput").value));
        $("aiInput").addEventListener("keydown", (e) => { if (e.key === "Enter") send($("aiInput").value); });
        $("aiSuggest").addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) send(b.dataset.q); });
        $("aiSpeak").addEventListener("click", () => { ttsOn = !ttsOn; $("aiSpeak").classList.toggle("on", ttsOn); if (!ttsOn) try { speechSynthesis.cancel(); } catch (e) {} toast(ttsOn ? UI.t("Voice replies on") : UI.t("Voice replies off")); });
        $("aiMic").addEventListener("click", () => {
          const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (!SR) return toast(UI.t("Voice input is not supported in this browser"), "err");
          if (listening) { if (rec) rec.stop(); return; }
          rec = new SR(); rec.lang = tr ? "tr-TR" : "en-US"; rec.interimResults = true; rec.continuous = false;
          rec.onresult = (e) => { let t = ""; for (const r of e.results) t += r[0].transcript; $("aiInput").value = t; };
          rec.onend = () => { listening = false; $("aiMic").classList.remove("listening"); const v = $("aiInput").value.trim(); if (v) send(v); };
          rec.onerror = () => { listening = false; $("aiMic").classList.remove("listening"); };
          rec.start(); listening = true; $("aiMic").classList.add("listening");
        });
        setTimeout(() => $("aiInput").focus(), 100);
    }
  }

  /* ---- AI: single-invoice assessment ---- */
  function aiInvoice(inv, client) {
    modal({
      title: "AI · " + inv.no, wide: false,
      body: '<div id="aiOut2" class="ai-out"><div class="ai-loading">' + icon("sparkles") + " " + UI.t("Assessing invoice…") + '</div></div>',
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Close") + '</button>'
    });
    AI.analyzeInvoice(inv, client).then((res) => {
      const out = document.getElementById("aiOut2"); if (!out) return;
      out.innerHTML = '<div class="ai-badge' + (res.source === "gemini" ? " live" : "") + '">' + icon(res.source === "gemini" ? "sparkles" : "shield") + " " + (res.source === "gemini" ? "Gemini" : "Offline") + '</div><div class="ai-md">' + AI.render(res.text) + "</div>";
    });
  }
  function invForm(clients, i) {
    const isEdit = !!i; i = i || {};
    const clientOpts = clients.map((c) => '<option value="' + c.id + '"' + (c.id === i.client ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");
    const todayStr = new Date().toISOString().slice(0, 10);
    const dueStr = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })();
    modal({
      title: isEdit ? UI.t("Edit invoice") : UI.t("New invoice"), wide: true,
      body:
        '<div class="form-row">' +
          field(UI.t("Invoice no."), '<input class="input" name="no" value="' + esc(i.no || ("INV-" + new Date().getFullYear() + "-" + (Math.floor(Math.random() * 900) + 1100))) + '">', true) +
          field(UI.t("Client"), '<select class="select" name="client">' + clientOpts + "</select>", true) +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Issued"), '<input class="input" type="date" name="issued" value="' + esc(i.issued || todayStr) + '">') +
          field(UI.t("Due"), '<input class="input" type="date" name="due" value="' + esc(i.due || dueStr) + '">') +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Amount"), '<input class="input" type="number" min="0" data-type="number" name="amount" value="' + (i.amount || 0) + '">', true) +
          (() => {
            const defRate = (() => {
              if (window.Workspace && Workspace.active) {
                const active = Workspace.active();
                if (active && active.country && window.COUNTRIES) {
                  const c = COUNTRIES.find((x) => x.code === active.country || x.name === active.country);
                  if (c) return c.vat;
                }
              }
              return 20;
            })();
            const currentVatRate = (i.vatRate !== undefined) ? i.vatRate : (isEdit ? 0 : defRate);
            const standardRates = [20, 10, 1, 0];
            if (!standardRates.includes(defRate)) {
              standardRates.unshift(defRate);
            }
            const options = standardRates.map(r => 
              '<option value="' + r + '"' + (currentVatRate === r ? ' selected' : '') + '>' + r + '%</option>'
            ).join("");
            return field(UI.t("VAT (KDV) Rate"), '<select class="select" data-type="number" name="vatRate">' + options + '</select>', true);
          })() +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("VAT (KDV) Amount"), '<input class="input" type="number" readonly data-type="number" name="vatAmount" value="' + (i.vatAmount !== undefined ? i.vatAmount : 0) + '">') +
          field(UI.t("Grand Total"), '<input class="input" type="number" readonly data-type="number" name="totalAmount" value="' + (i.totalAmount !== undefined ? i.totalAmount : (i.amount || 0)) + '">') +
        "</div>" +
        '<div class="form-row">' +
          field(UI.t("Currency"), sel("currency", i.currency || "USD", ["USD", "EUR", "TRY"])) +
          field(UI.t("Status"), sel("status", i.status || "Draft", ["Draft", "Sent", "Paid", "Overdue"])) +
        "</div>",
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button>' +
        (isEdit ? '<button class="btn btn-ghost" id="invPdf" style="margin-right:8px">' + icon("file") + ' PDF</button>' +
                  '<button class="btn btn-ghost" id="invExcel" style="margin-right:8px">' + icon("grid") + ' Excel</button>' : '') +
        '<button class="btn btn-primary" data-save>' + (isEdit ? UI.t("Save changes") : UI.t("Create invoice")) + "</button>",
      onMount: (m) => {
        const amountEl = m.querySelector('[name="amount"]');
        const vatRateEl = m.querySelector('[name="vatRate"]');
        const vatAmountEl = m.querySelector('[name="vatAmount"]');
        const totalAmountEl = m.querySelector('[name="totalAmount"]');
        const clientEl = m.querySelector('[name="client"]');

        function recalc() {
          const amt = parseFloat(amountEl.value) || 0;
          const rate = parseFloat(vatRateEl.value) || 0;
          const vat = Math.round(amt * rate) / 100;
          vatAmountEl.value = vat.toFixed(2);
          totalAmountEl.value = (amt + vat).toFixed(2);
        }

        amountEl.addEventListener("input", recalc);
        vatRateEl.addEventListener("change", recalc);

        clientEl.addEventListener("change", () => {
          const selectedId = clientEl.value;
          const cl = clients.find(c => c.id === selectedId);
          if (cl) {
            vatRateEl.value = cl.country === "TR" ? "20" : "0";
            recalc();
          }
        });

        // Initialize default VAT rate based on the client if it's a new invoice
        if (!isEdit) {
          const initialClient = clients.find(c => c.id === clientEl.value);
          if (initialClient) {
            vatRateEl.value = initialClient.country === "TR" ? "20" : "0";
          }
        }
        recalc();

        if (isEdit) {
          m.querySelector("#invPdf").addEventListener("click", () => exportInvoicePDF(i, clients));

          m.querySelector("#invExcel").addEventListener("click", async () => {
            const client = clients.find(c => c.id === i.client) || {};
            let items = [];
            let freight = 0;
            if (i.order) {
              const order = await Store.get("orders", i.order);
              if (order) {
                const products = await Store.list("products");
                const prodMap = Object.fromEntries(products.map(p => [p.id, p]));
                items = (order.items || []).map(it => {
                  const p = prodMap[it.product] || {};
                  return { name: p.name || it.product, qty: it.qty, price: it.price };
                });
                freight = order.freight || 0;
              }
            }
            if (items.length === 0) {
              items = [{ name: "Consolidated trade operations / services", qty: 1, price: i.amount }];
            }

            const vatRate = i.vatRate !== undefined ? i.vatRate : 0;
            const vatAmount = i.vatAmount !== undefined ? i.vatAmount : 0;
            const totalAmount = i.totalAmount !== undefined ? i.totalAmount : i.amount;

            let csv = "\uFEFF";
            csv += "INVOICE SUMMARY\n";
            csv += "Invoice No,Client,Issued Date,Due Date,Subtotal (Matrah),VAT (KDV) Rate %,VAT (KDV) Amount,Grand Total,Currency,Status\n";
            csv += '"' + i.no + '","' + (client.name || "").replace(/"/g, '""') + '","' + i.issued + '","' + i.due + '",' + i.amount + ',' + vatRate + ',' + vatAmount + ',' + totalAmount + ',"' + i.currency + '","' + i.status + '"\n\n';
            
            csv += "INVOICE LINE ITEMS\n";
            csv += "Description,Quantity,Unit Price,Subtotal\n";
            items.forEach(it => {
              const sub = it.qty * it.price;
              csv += '"' + it.name.replace(/"/g, '""') + '",' + it.qty + ',' + it.price + ',' + sub + '\n';
            });
            if (freight > 0) {
              csv += '"Freight & Logistics Services",1,' + freight + ',' + freight + '\n';
            }
            csv += '"Subtotal (Matrah)",,,' + i.amount + '\n';
            csv += '"VAT (KDV) Amount (' + vatRate + '%)",,,' + vatAmount + '\n';
            csv += '"Grand Total",,,' + totalAmount + '\n';

            const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", "Invoice_" + i.no + ".csv");
            link.style.visibility = "hidden";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          });
        }

        m.querySelector("[data-save]").addEventListener("click", async () => {
          const v = readForm(m);
          if (!v.no || !v.amount) return toast(UI.t("Invoice no. and amount are required"), "err");
          if (isEdit) { await Store.update("invoices", i.id, v); Store.logAction("update", "invoice", i.id, "Updated invoice " + v.no); toast(UI.t("Invoice updated")); }
          else { v.order = null; const r = await Store.create("invoices", v); Store.logAction("create", "invoice", r.id, "Issued invoice " + v.no + " for " + money(v.totalAmount !== undefined ? v.totalAmount : v.amount, v.currency)); toast(UI.t("Invoice created")); }
          closeModal(); App.reload();
        });
      }
    });
  }
  function delInv(i) {
    confirm({ title: UI.t("Delete invoice?"), message: i.no + " " + UI.t("will be removed."), danger: true, okLabel: UI.t("Delete") }, async () => {
      await Store.remove("invoices", i.id); Store.logAction("delete", "invoice", i.id, "Deleted invoice " + i.no); toast(UI.t("Invoice deleted")); App.reload();
    });
  }

  /* =============================================================
     HISTORY (audit trail)
     ============================================================= */
  async function history(el) {
    const list = await Store.list("audit");
    const actions = ["All", "create", "update", "delete", "login", "logout"];
    let activeAction = "All";

    const dotClass = (a) => a === "create" ? "green" : a === "delete" ? "red" : a === "login" || a === "logout" ? "purple" : a === "update" ? "amber" : "";

    function render() {
      const data = activeAction === "All" ? list : list.filter((a) => a.action === activeAction);
      const q = (document.getElementById("histSearch") || {}).value || "";
      const filtered = q ? data.filter((a) => (a.summary + a.actor + a.entity).toLowerCase().includes(q.toLowerCase())) : data;
      const body = document.getElementById("histBody");
      if (!filtered.length) { body.innerHTML = '<div class="empty">' + icon("history") + "<h4>" + UI.t("No activity") + "</h4><p>" + UI.t("No records match your filter.") + "</p></div>"; return; }
      // group by day
      let html = '<div class="timeline">'; let lastDay = "";
      filtered.forEach((a) => {
        const day = date(a.ts);
        if (day !== lastDay) { html += '<div class="sb-group" style="color:var(--muted);padding:14px 0 8px;letter-spacing:.08em">' + day + "</div>"; lastDay = day; }
        html += '<div class="tl-item"><div class="tl-dot ' + dotClass(a.action) + '"></div>' +
          '<div class="tl-h"><b>' + esc(a.summary) + "</b></div>" +
          '<div class="tl-m"><span class="tag" style="text-transform:capitalize">' + esc(tr(a.action)) + " · " + esc(tr(a.entity)) + "</span>" +
          "<span>" + UI.icon("users") + " " + esc(a.actor) + "</span><span>" + UI.icon("clock") + " " + dateTime(a.ts) + "</span></div></div>";
      });
      html += "</div>";
      body.innerHTML = html;
    }

    el.innerHTML =
      '<div class="section-title"><div><h2>' + UI.t("Activity History") + '</h2><p>' + UI.t("Audit trail of all console creations, edits and deletions") + " · " + list.length + " " + UI.t("items") + '</p></div></div>' +
      toolbar("histSearch", segFilter(actions, activeAction), null, null) +
      '<div class="card"><div class="card-b" id="histBody"></div></div>';

    document.getElementById("histSearch").addEventListener("input", render);
    el.querySelector("[data-seg]").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      activeAction = b.dataset.f; el.querySelectorAll("[data-seg] button").forEach((x) => x.classList.toggle("active", x === b));
      render();
    });
    render();
  }

  /* =============================================================
     SETTINGS
     ============================================================= */
  async function settings(el) {
    const apiBase = Store.getApiBase();
    const live = Store.isConnected();
    const lang = UI.getLang();
    const canConnect = Auth.can("connect");
    const canAI = Auth.can("finance", "ai");
    const owner = Auth.isOwner();
    const aiLive = AI.hasKey();

    let activeLangNameSetting = "Türkçe (TR)";
    if (lang === "en") activeLangNameSetting = "English (EN)";

    const langCard =
      '<div class="card" style="margin-bottom:18px"><div class="card-h"><h3>' + UI.t("Language") + '</h3></div>' +
      '<div class="card-b">' +
      field(UI.t("Select language"), 
        '<div class="lang-dropdown" id="settingsLangDropdown" style="width:100%; max-width:240px;">' +
          '<button class="lang-trigger" id="settingsLangTrigger" style="width:100%; justify-content:space-between;">' +
            '<span class="lang-current">' + activeLangNameSetting + '</span>' +
            '<svg class="lang-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
          '</button>' +
          '<ul class="lang-list" id="settingsLangList" style="width:100%; text-align:left;">' +
            '<li data-value="en" class="lang-item' + (lang === "en" ? " active" : "") + '">English (EN)</li>' +
            '<li data-value="tr" class="lang-item' + (lang === "tr" ? " active" : "") + '">Türkçe (TR)</li>' +
          '</ul>' +
        '</div>'
      ) +
      '</div></div>';

    const connCard = canConnect
      ? '<div class="card" style="margin-bottom:18px"><div class="card-h"><h3>' + UI.t("Backend connection") + '</h3>' +
        '<div class="grow" style="flex:1"></div><span class="conn-pill ' + (live ? "live" : "demo") + '"><span class="dot"></span>' + (live ? UI.t("Live data") + " · " + UI.t("Active") : UI.t("Demo mode")) + "</span></div>" +
        '<div class="card-b">' +
        '<p class="muted" style="margin-top:0">' + UI.t("Enter REST API root URL to switch to live database. Leave blank to run offline on local demo data.") + '</p>' +
        field(UI.t("Connection base URL"), '<input class="input" id="apiBase" placeholder="https://api.yourcompany.com" value="' + esc(apiBase) + '">') +
        '<p class="hint">Expected endpoints: <code>GET/POST /{collection}</code>, <code>PUT/DELETE /{collection}/{id}</code>, health probe <code>GET /health</code>.</p>' +
        '<div class="flex" style="gap:10px;margin-top:8px"><button class="btn btn-primary" id="saveApi">' + icon("check") + UI.t("Save settings") + '</button>' +
        '<button class="btn btn-ghost" id="clearApi">' + UI.t("Disconnect (demo mode)") + '</button></div>' +
        "</div></div>"
      : "";

    const aiCard = canAI
      ? '<div class="card" style="margin-bottom:18px"><div class="card-h"><div class="ai-orb sm">' + icon("sparkles") + "</div><h3>" + UI.t("AI Accounting (Gemini)") + "</h3>" +
        '<div class="grow" style="flex:1"></div><span class="conn-pill ' + (aiLive ? "live" : "demo") + '"><span class="dot"></span>' + (aiLive ? "Gemini " + UI.t("Active") : UI.t("Offline engine")) + "</span></div>" +
        '<div class="card-b">' +
        '<p class="muted" style="margin-top:0">' + UI.t("Add a Google Gemini API key to enable live invoice analysis and collection reports.") + '</p>' +
        field(UI.t("Gemini API key"), '<input class="input" id="geminiKey" type="password" placeholder="AIza…" value="' + esc(AI.getKey()) + '">') +
        '<p class="hint">' + icon("key") + ' Stored locally in this browser. Get a key at <code>aistudio.google.com/app/apikey</code>. Model: <code>' + esc(AI.model()) + "</code></p>" +
        '<div class="flex" style="gap:10px;margin-top:8px"><button class="btn btn-primary" id="saveKey">' + icon("check") + UI.t("Save API key") + '</button>' +
        '<button class="btn btn-ghost" id="clearKey">' + UI.t("Use offline engine") + '</button></div>' +
        "</div></div>"
      : "";

    const sWsActive = window.Workspace && window.Workspace.active && window.Workspace.active();
    const sWsId = sWsActive ? sWsActive.id : null;
    const portalUrl = sWsId ? (Store.portalUrl ? Store.portalUrl(sWsId) : location.origin + "/portal/" + sWsId) : null;
    const currentDomain = sWsActive ? (sWsActive.customDomain || "") : "";
    const storefrontOn = sWsActive ? (sWsActive.storefrontEnabled !== false) : false;

    const sc = (sWsActive && sWsActive.storefrontConfig) || {};
    const storefrontCard = sWsId
      ? '<div class="card" style="margin-bottom:18px">' +
          '<div class="card-h">' +
            '<h3>🏪 ' + UI.t("Website Storefront Editor & Settings") + '</h3>' +
            '<div class="grow" style="flex:1"></div>' +
            '<span class="conn-pill ' + (storefrontOn ? "live" : "demo") + '"><span class="dot"></span>' + (storefrontOn ? UI.t("Live") : UI.t("Disabled")) + '</span>' +
          '</div>' +
          '<div class="card-b">' +
            '<p class="muted" style="margin-top:0">' + UI.t("Customize your public storefront design, header announcement banner, hero section text, colors, and domain.") + '</p>' +
            
            // ── Store Status & Links
            '<div class="form-row">' +
              '<div class="field"><label class="label">' + UI.t("Status") + '</label>' +
                '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 0">' +
                  '<input type="checkbox" id="sfEnabled" ' + (storefrontOn ? "checked" : "") + ' style="accent-color:var(--accent);width:18px;height:18px">' +
                  '<span style="font-weight:600">' + UI.t("Enable Public Storefront") + '</span>' +
                '</label>' +
              '</div>' +
              '<div class="field"><label class="label">' + UI.t("Storefront Template") + '</label>' +
                '<select class="input" id="sfTemplate">' +
                  '<option value="retail" ' + ((sc.template || "retail") === "retail" ? "selected" : "") + '>🛒 Retail & Superstore Marketplace (NOON / Amazon)</option>' +
                  '<option value="fashion" ' + (sc.template === "fashion" ? "selected" : "") + '>👗 Fashion & Apparel Editorial (ZARA / H&M)</option>' +
                  '<option value="catalog" ' + (sc.template === "catalog" ? "selected" : "") + '>🛍️ Standard E-Commerce Catalog</option>' +
                  '<option value="menu" ' + (sc.template === "menu" ? "selected" : "") + '>🍽️ Restaurant & Food Menu</option>' +
                  '<option value="tracker" ' + (sc.template === "tracker" ? "selected" : "") + '>🚚 Logistics & Order Tracker</option>' +
                  '<option value="inquiry" ' + (sc.template === "inquiry" ? "selected" : "") + '>💼 Professional Quote Inquiry</option>' +
                '</select>' +
              '</div>' +

            '</div>' +

            '<div class="form-row">' +
              field(UI.t("Storefront Brand Name"), '<input class="input" id="sfBrandName" placeholder="e.g. Your Company Name" value="' + esc(sc.brandName || (sWsActive && sWsActive.company) || "") + '">') +
              field(UI.t("Custom Logo Image URL"), '<input class="input" id="sfLogoUrl" placeholder="https://domain.com/logo.png" value="' + esc(sc.logoUrl || "") + '">') +
            '</div>' +

            '<div class="dfield"><div class="k">' + UI.t("Portal Live URL") + '</div><div class="v">' +

              '<code style="font-size:.8rem;background:var(--bg);padding:4px 8px;border-radius:6px;border:1px solid var(--line);user-select:all" id="sfPortalUrl">' + esc(portalUrl || "—") + '</code>' +
              (portalUrl ? ' <button class="btn btn-ghost btn-sm" id="sfCopyUrl" style="margin-left:6px">' + icon("copy") + UI.t("Copy") + '</button>' : "") +
              (portalUrl ? ' <a class="btn btn-primary btn-sm" href="' + esc(portalUrl) + '" target="_blank" rel="noopener" style="margin-left:6px">👁️ ' + UI.t("Preview Website") + '</a>' : "") +
            '</div></div>' +

            '<div class="divider"></div>' +

            // ── 📢 Top Announcement Banner
            '<h4 style="font-size:.92rem;font-weight:700;margin-bottom:12px;color:var(--text)">📢 ' + UI.t("Header Announcement Bar") + '</h4>' +
            '<div class="form-row">' +
              field(UI.t("Announcement Text"), '<input class="input" id="sfAnnounce" placeholder="e.g. Free Express Shipping on Orders Over $50 | 24/7 Support" value="' + esc(sc.announcement || "") + '">') +
              '<div class="field"><label class="label">' + UI.t("Bar Visibility") + '</label>' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 0">' +
                  '<input type="checkbox" id="sfAnnounceOn" ' + (sc.announcementEnabled !== false ? "checked" : "") + ' style="accent-color:var(--accent);width:16px;height:16px">' +
                  '<span>' + UI.t("Show Top Announcement Bar") + '</span>' +
                '</label>' +
              '</div>' +
            '</div>' +

            '<div class="divider"></div>' +

            // ── 🌟 Hero Header Banner Customizer
            '<h4 style="font-size:.92rem;font-weight:700;margin-bottom:12px;color:var(--text)">🎨 ' + UI.t("Hero Header Customizer") + '</h4>' +
            '<div class="form-row">' +
              field(UI.t("Hero Eyebrow Tag"), '<input class="input" id="sfHeroEyebrow" placeholder="e.g. NEW ARRIVALS 2026" value="' + esc(sc.heroEyebrow || "") + '">') +
              field(UI.t("Hero Alignment"), '<select class="input" id="sfHeroAlign"><option value="left" ' + (sc.heroAlign !== "center" ? "selected" : "") + '>Left Aligned</option><option value="center" ' + (sc.heroAlign === "center" ? "selected" : "") + '>Centered Layout</option></select>') +
            '</div>' +
            field(UI.t("Hero Main Title (Use *word* for italic accent)"), '<input class="input" id="sfHeroTitle" placeholder="e.g. Discover Our *Products*" value="' + esc(sc.heroTitle || "") + '">') +
            field(UI.t("Hero Subtitle"), '<textarea class="input" id="sfHeroSub" rows="2" placeholder="e.g. Shop the latest collection with fast express delivery." style="resize:vertical;min-height:60px">' + esc(sc.heroSub || "") + '</textarea>') +
            '<div class="form-row">' +
              field(UI.t("Primary Button Label"), '<input class="input" id="sfCtaText" placeholder="e.g. Shop Now" value="' + esc(sc.ctaText || "") + '">') +
              field(UI.t("Hero Background Image URL"), '<input class="input" id="sfHeroBgImage" placeholder="https://images.unsplash.com/..." value="' + esc(sc.heroBgImage || "") + '">') +
            '</div>' +

            '<div class="divider"></div>' +

            // ── 🎨 Theme Colors
            '<h4 style="font-size:.92rem;font-weight:700;margin-bottom:12px;color:var(--text)">✨ ' + UI.t("Theme Accent Color") + '</h4>' +
            '<div class="form-row" style="align-items:center">' +
              field(UI.t("Accent Color Hex"), '<input class="input" id="sfAccent" type="color" value="' + esc(sc.accentColor || "#111111") + '" style="height:40px;padding:4px;cursor:pointer">') +
              '<div class="field"><label class="label">' + UI.t("Color Presets") + '</label>' +
                '<div style="display:flex;gap:8px;padding-top:4px">' +
                  '<button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById(\'sfAccent\').value=\'#111111\'" style="background:#111;color:#fff">Black</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById(\'sfAccent\').value=\'#1aa6df\'" style="background:#1aa6df;color:#fff">Ocean</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById(\'sfAccent\').value=\'#e11d48\'" style="background:#e11d48;color:#fff">Rose</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById(\'sfAccent\').value=\'#059669\'" style="background:#059669;color:#fff">Emerald</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById(\'sfAccent\').value=\'#7c3aed\'" style="background:#7c3aed;color:#fff">Purple</button>' +
                '</div>' +
              '</div>' +
            '</div>' +

            '<div class="divider"></div>' +

            // ── 🌐 Custom Domain
            '<h4 style="font-size:.88rem;font-weight:600;margin-bottom:10px;color:var(--label)">🌐 ' + UI.t("Custom Domain") + '</h4>' +
            '<p class="muted" style="margin-top:0;font-size:.82rem">' + UI.t("Point your own custom domain to this storefront. Add a CNAME record pointing your domain to") + ' <code style="font-size:.8rem">' + esc(location.hostname) + '</code>, then enter it below.</p>' +
            field(UI.t("Custom Domain"), '<input class="input" id="sfDomain" placeholder="store.yourcompany.com" value="' + esc(currentDomain) + '">') +

            '<div class="flex" style="gap:12px;margin-top:16px">' +
              '<button class="btn btn-primary" id="sfSave">' + icon("check") + UI.t("Save All Storefront Settings") + '</button>' +
              (portalUrl ? ' <a class="btn btn-outline" href="' + esc(portalUrl) + '" target="_blank" rel="noopener">👁️ ' + UI.t("Preview Storefront") + '</a>' : "") +
              (portalUrl ? ' <button class="btn btn-outline" id="sfEditVisually">🎨 ' + UI.t("Edit Visually") + '</button>' : "") +
            '</div>' +
          '</div>' +
        '</div>'
      : "";


    const teamCard =
      '<div class="card"><div class="card-h"><h3>' + UI.t("Team & access") + '</h3><div class="grow" style="flex:1"></div>' +
        (owner ? '<a href="#/users" class="btn btn-ghost btn-sm">' + icon("users") + UI.t("Manage team") + '</a>' : "") + "</div>" +
        '<div class="card-b"><div class="dfield"><div class="k">' + UI.t("Your role") + '</div><div class="v"><span class="role-pill ' + (owner ? "owner" : "emp") + '">' + esc(tr((Auth.current() || {}).role)) + "</span></div></div>" +
        '<p class="muted" style="margin:6px 0 0">' + (owner ? UI.t("As Owner you have full access and can manage employee accounts and permissions in the Team module.") : UI.t("Your access is scoped to your role. Contact the Owner to change permissions.")) + "</p></div></div>";

    const sWs = window.Workspace;
    const sHasWs = sWs && sWs.exists();
    const companyLine = sHasWs ? (sWs.company() + " — " + sWs.preset().name) : UI.t("MERVEKS — Logistics & Trade");
    const resetNote = sHasWs
      ? UI.t("Reset clears all records and restores your workspace to how it started (empty, or with sample data).")
      : UI.t("Reset restores the original demo dataset and clears any local changes (demo mode only).");
    const resetLabel = sHasWs ? UI.t("Reset workspace data") : UI.t("Reset demo data");
    const dataCard =
      '<div class="card"><div class="card-h"><h3>' + UI.t("Company & data") + '</h3></div><div class="card-b">' +
        '<div class="dfield"><div class="k">' + UI.t("Company") + '</div><div class="v strong">' + esc(companyLine) + '</div></div>' +
        (sHasWs
          ? '<div class="dfield"><div class="k">' + UI.t("Industry") + '</div><div class="v">' + esc(sWs.preset().name) + '</div></div>'
          : '<div class="dfield"><div class="k">' + UI.t("Marketing site") + '</div><div class="v"><a href="' + Store.siteUrl() + '" target="_blank" rel="noopener">' + Store.siteUrl() + " " + icon("external") + "</a></div></div>" +
            '<div class="dfield"><div class="k">' + UI.t("Established") + '</div><div class="v">' + UI.t("Established info") + '</div></div>') +
        (owner ? '<div class="divider"></div><p class="muted" style="margin-top:0">' + resetNote + '</p><button class="btn btn-danger" id="resetData">' + icon("trash") + resetLabel + '</button>' : "") +
        "</div></div>";

    el.innerHTML =
      '<div class="section-title"><div><h2>' + UI.t("Settings") + '</h2><p>' + UI.t("Connection, AI, team access & data controls") + '</p></div></div>' +
      langCard + connCard + aiCard + storefrontCard + '<div class="grid-2">' + teamCard + dataCard + "</div>";


    const byId = (id) => document.getElementById(id);
    
    // Wire custom settings language dropdown
    const sDropdown = document.getElementById("settingsLangDropdown");
    const sTrigger = document.getElementById("settingsLangTrigger");
    if (sTrigger && sDropdown) {
      sTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        sDropdown.classList.toggle("open");
      });
      document.addEventListener("click", () => {
        sDropdown.classList.remove("open");
      });
      sDropdown.querySelectorAll(".lang-item").forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          UI.setLang(item.dataset.value);
          location.reload();
        });
      });
    }
    if (byId("saveApi")) byId("saveApi").addEventListener("click", async () => {
      Store.setApiBase(byId("apiBase").value.trim());
      toast(UI.t("Reconnecting…")); await Store.init(); App.refreshChrome(); App.reload();
    });
    if (byId("clearApi")) byId("clearApi").addEventListener("click", async () => {
      Store.setApiBase(""); byId("apiBase").value = "";
      toast(UI.t("Switched to demo mode")); await Store.init(); App.refreshChrome(); App.reload();
    });
    if (byId("saveKey")) byId("saveKey").addEventListener("click", () => {
      AI.setKey(byId("geminiKey").value.trim()); Store.logAction("update", "settings", "ai", "Updated AI Accounting (Gemini) key");
      toast(AI.hasKey() ? UI.t("Gemini key saved") : UI.t("Key cleared")); App.reload();
    });
    if (byId("clearKey")) byId("clearKey").addEventListener("click", () => { AI.setKey(""); toast(UI.t("Using offline engine")); App.reload(); });
    if (byId("resetData")) byId("resetData").addEventListener("click", () => {
      const rWs = window.Workspace && window.Workspace.exists();
      const msg = rWs
        ? UI.t("All records will be cleared and your workspace restored to its starting state.")
        : UI.t("All local changes will be discarded and the original MERVEKS demo dataset restored.");
      confirm({ title: UI.t("Reset data?"), message: msg, danger: true, okLabel: UI.t("Reset") }, () => {
        if (rWs) { Store.resetWorkspace(); toast(UI.t("Workspace reset")); }
        else { Store.resetDemo(); toast(UI.t("Demo data restored")); }
        App.reload();
      });
    });

    // ---- Storefront settings wiring ----
    if (byId("sfCopyUrl")) byId("sfCopyUrl").addEventListener("click", () => {
      const url = (byId("sfPortalUrl") || {}).textContent || "";
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast(UI.t("Portal URL copied")));
      else { const ta = document.createElement("textarea"); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast(UI.t("Portal URL copied")); }
    });
    if (byId("sfSave")) byId("sfSave").addEventListener("click", async () => {
      const ws = window.Workspace && window.Workspace.active && window.Workspace.active();
      if (!ws) return toast(UI.t("No active workspace"), "error");
      const enabled = !!(byId("sfEnabled") && byId("sfEnabled").checked);
      const domain = (byId("sfDomain") && byId("sfDomain").value || "").trim().toLowerCase();
      
      const sfConfig = Object.assign({}, ws.storefrontConfig || {}, {
        brandName: (byId("sfBrandName") && byId("sfBrandName").value || "").trim(),
        logoUrl: (byId("sfLogoUrl") && byId("sfLogoUrl").value || "").trim(),
        announcement: (byId("sfAnnounce") && byId("sfAnnounce").value || "").trim(),
        announcementEnabled: !!(byId("sfAnnounceOn") && byId("sfAnnounceOn").checked),
        heroEyebrow: (byId("sfHeroEyebrow") && byId("sfHeroEyebrow").value || "").trim(),
        heroTitle: (byId("sfHeroTitle") && byId("sfHeroTitle").value || "").trim(),
        heroSub: (byId("sfHeroSub") && byId("sfHeroSub").value || "").trim(),
        ctaText: (byId("sfCtaText") && byId("sfCtaText").value || "").trim(),
        heroAlign: (byId("sfHeroAlign") && byId("sfHeroAlign").value) || "left",
        heroBgImage: (byId("sfHeroBgImage") && byId("sfHeroBgImage").value || "").trim(),
        accentColor: (byId("sfAccent") && byId("sfAccent").value) || "#111111",
        template: (byId("sfTemplate") && byId("sfTemplate").value) || "catalog"
      });


      // Save to localStorage workspace record
      if (window.Workspace && window.Workspace.update) {
        window.Workspace.update(ws.id, { storefrontEnabled: enabled, customDomain: domain || null, storefrontConfig: sfConfig });
      }
      // Also persist to server if connected
      if (Store.setDomain) await Store.setDomain(ws.id, domain, enabled, sfConfig);
      toast(UI.t("Storefront customizer settings saved!"));
      App.reload();
    });

    if (byId("sfEditVisually")) byId("sfEditVisually").addEventListener("click", async () => {
      const ws = window.Workspace && window.Workspace.active && window.Workspace.active();
      if (!ws) return toast(UI.t("No active workspace"), "error");
      const base = Store.portalUrl ? Store.portalUrl(ws.id) : (location.origin + "/portal/" + ws.id);
      // Live backend: mint a short-lived edit token so the portal page (which
      // may be on a different origin/custom domain and can't see this app's
      // localStorage) can prove the request is coming from the owner.
      // Demo-only workspaces (no backend) skip this — the editor allows
      // itself to open without a token when there's no live workspace record.
      const editToken = Store.getEditToken ? await Store.getEditToken(ws.id) : null;
      const url = base + "?edit=true" + (editToken ? "&et=" + encodeURIComponent(editToken) : "");
      window.open(url, "_blank", "noopener");
    });

  }

  /* =============================================================
     TEAM (users) — Owner only
     ============================================================= */
  async function users(el) {
    const [list, audit, invoices, orders] = await Promise.all([
      Store.list("users"), Store.list("audit"),
      Store.list("invoices"), Store.list("orders")
    ]);
    const ROLES = Object.keys(Auth.ROLE_PERMS);
    const me = Auth.current() || {};
    const isOwner = me.role === "Owner";

    // ---- Perf engine ----
    const perfResults = Perf.compute(list, audit, invoices, orders);
    const maxScore = Math.max(1, perfResults[0] ? perfResults[0].perfScore : 1);
    const medals = ["🥇", "🥈", "🥉"];

    // ---- Leaderboard rows ----
    const leaderboard = perfResults.map((st, i) => {
      const pct = Math.round((st.perfScore / maxScore) * 100);
      const barColor = i === 0 ? "var(--accent)" : i === 1 ? "var(--green)" : i === 2 ? "var(--gold)" : "var(--muted)";
      const medal = i < 3 ? medals[i] : (i + 1) + ".";
      const rr = st.raiseRange;
      const raiseBadge = isOwner
        ? '<span style="margin-left:auto;padding:1px 7px;border-radius:99px;font-size:.68rem;font-weight:700;color:#fff;background:' + rr.color + ';white-space:nowrap;">' +
          (rr.low > 0 ? "+" + rr.low + "–" + rr.high + "%" : "PIP") + "</span>"
        : "";
      const trendIcon = st.trend === "up" ? "↑" : st.trend === "down" ? "↓" : "→";
      const trendColor = st.trend === "up" ? "var(--green)" : st.trend === "down" ? "var(--red)" : "var(--muted)";
      return (
        '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
          '<div style="width:24px;text-align:center;font-size:1rem;flex-shrink:0;">' + medal + '</div>' +
          '<div style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:700;flex-shrink:0;background:' + avColor(st.u.name) + ';color:#fff;">' + initials(st.u.name) + '</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">' +
              '<span style="font-weight:600;font-size:.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(st.u.name) + '</span>' +
              '<span style="font-size:.78rem;color:' + trendColor + ';font-weight:700;">' + trendIcon + '</span>' +
              raiseBadge +
              '<span style="font-size:.76rem;color:var(--muted);white-space:nowrap;margin-left:4px;">' + st.perfScore + ' pts</span>' +
            '</div>' +
            '<div style="height:5px;border-radius:99px;background:var(--surface-2);overflow:hidden;margin-bottom:3px;">' +
              '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:99px;transition:width .6s ease;"></div>' +
            '</div>' +
            '<div style="display:flex;gap:10px;">' +
              '<span style="font-size:.72rem;color:var(--muted);">' + st.activeDays + ' ' + UI.t("active days") + '</span>' +
              '<span style="font-size:.72rem;color:var(--muted);">' + st.last30Actions + ' ' + UI.t("actions") + ' / 30d</span>' +
              (isOwner && st.u.salary ? '<span style="font-size:.72rem;color:var(--muted);">$' + st.u.salary.toLocaleString() + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join("");

    // ---- Today activity cards ----
    const todayStr = new Date().toISOString().slice(0, 10);
    const ACTION_COLORS = { create: "green", update: "amber", delete: "red", login: "purple", logout: "slate" };
    const activityCards = perfResults.map((st) => {
      const todayEntries = audit.filter(a => a.actor === st.u.name && a.ts && a.ts.slice(0, 10) === todayStr);
      const bk = {};
      todayEntries.forEach(a => { const k = a.action + "_" + a.entity; bk[k] = (bk[k] || 0) + 1; });
      const hasActivity = todayEntries.length > 0;
      const details = hasActivity
        ? Object.keys(bk).map(key => {
            const [action, entity] = key.split("_");
            return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
              '<span class="st ' + (ACTION_COLORS[action] || "slate") + '" style="padding:2px 7px;font-size:.68rem;">' + esc(tr(action)) + '</span>' +
              '<span style="font-size:.8rem;color:var(--ink-2);">' + bk[key] + '× ' + esc(tr(entity)) + '</span>' +
            '</div>';
          }).join("")
        : '<p class="muted" style="font-size:.8rem;margin:4px 0 0;">' + UI.t("No activity today") + '</p>';
      return (
        '<div class="card" style="padding:0;">' +
          '<div class="card-h" style="padding:11px 14px;gap:9px;">' +
            '<div style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:700;background:' + avColor(st.u.name) + ';color:#fff;flex-shrink:0;">' + initials(st.u.name) + '</div>' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-weight:600;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(st.u.name) + '</div>' +
              '<div style="font-size:.72rem;color:var(--muted);">' + esc(tr(st.u.role)) + (st.u.dept ? " · " + esc(st.u.dept) : "") + '</div>' +
            '</div>' +
            (todayEntries.length > 0
              ? '<span style="background:var(--accent);color:#fff;font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:99px;white-space:nowrap;">' + todayEntries.length + ' ' + UI.t("actions") + '</span>'
              : '<span style="background:var(--surface-2);color:var(--muted);font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:99px;white-space:nowrap;">—</span>') +
          '</div>' +
          '<div style="padding:6px 14px 12px;border-top:1px solid var(--line-2);">' + details + '</div>' +
        '</div>'
      );
    }).join("");

    el.innerHTML =
      '<div class="section-title"><div><h2>' + UI.t("Team & Accounts") + '</h2><p>' + UI.t("Owner and employee accounts · roles control what each person can access") + '</p></div></div>' +

      '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:20px;margin-bottom:24px;" class="perf-grid">' +
        '<div class="card" style="padding:0;">' +
          '<div class="card-h" style="padding:14px 18px;">' +
            '<h3>' + icon("chart") + ' ' + UI.t("Top Performers Leaderboard") + '</h3>' +
            (isOwner ? '<span class="sub" style="margin-left:auto;font-size:.72rem;">' + UI.t("Raise range shown") + '</span>' : '') +
          '</div>' +
          '<div style="padding:0 18px 10px;">' + leaderboard + '</div>' +
        '</div>' +
        '<div>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
            '<h3 style="font-size:.93rem;font-weight:700;">' + icon("history") + ' ' + UI.t("Team Contributions Today") + '</h3>' +
            '<span style="font-size:.73rem;color:var(--muted);">' + todayStr + '</span>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:11px;">' + activityCards + '</div>' +
        '</div>' +
      '</div>' +

      toolbar("usrSearch", "", "New employee", "usrAdd", "users") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      "<th>" + UI.t("Member") + "</th><th>" + UI.t("Role") + "</th><th>" + UI.t("Department") + "</th><th>" + UI.t("PERF") + "</th><th>" + UI.t("Joined") + "</th><th>" + UI.t("Status") + "</th>" +
      '</tr></thead><tbody>' +
      list.map((u) => {
        const pr = perfResults.find(r => r.u.id === u.id);
        const scoreHtml = pr
          ? '<span style="font-weight:700;color:' + pr.raiseRange.color + ';">' + pr.perfScore + '</span><span style="font-size:.72rem;color:var(--muted);margin-left:4px;">/ ' + pr.percentile + '%ile</span>'
          : "—";
        return '<tr data-row data-id="' + u.id + '">' +
          "<td>" + avatar(u.name, u.email) + "</td>" +
          '<td><span class="role-pill ' + (u.role === "Owner" ? "owner" : "emp") + '">' + esc(tr(u.role)) + "</span></td>" +
          "<td>" + esc(u.dept || "—") + "</td>" +
          "<td>" + scoreHtml + "</td>" +
          "<td>" + (u.joined ? date(u.joined) : "—") + "</td>" +
          "<td>" + (u.active ? '<span class="st green">' + UI.t("Active") + '</span>' : '<span class="st slate">' + UI.t("Disabled") + '</span>') +
            rowActs("users") + "</td>" +
        "</tr>";
      }).join("") +
      "</tbody></table></div>" +
      '<p class="hint" style="margin-top:14px">' + icon("shield") + " " + UI.t("Owner has full control. Operations manages logistics, inventory & orders. Finance manages invoices & AI accounting. Trade manages clients, suppliers, inventory & orders. Employees cannot delete records or manage the team.") + '</p>';

    liveSearch("usrSearch");
    { const a = document.getElementById("usrAdd"); if (a) a.addEventListener("click", () => usrForm(null, ROLES, null)); }
    el.querySelectorAll("tr[data-id]").forEach((tr) => {
      const u = list.find((x) => x.id === tr.dataset.id);
      const pr = perfResults.find(r => r.u.id === u.id);
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) {
          if (u.id === me.id) return toast(UI.t("You can't delete your own account"), "err");
          return delUsr(u);
        }
        usrForm(u, ROLES, pr);
      });
    });
  }

  function usrForm(u, ROLES, pr) {
    const isEdit = !!u; u = u || {};
    const isOwner = (Auth.current() || {}).role === "Owner";
    const rr = pr ? pr.raiseRange : null;

    // ---- Profile tab ----
    const profileTab =
      '<div class="form-row">' +
        field(UI.t("Full name"), '<input class="input" name="name" value="' + esc(u.name || "") + '">', true) +
        field(UI.t("Email"), '<input class="input" type="email" name="email" value="' + esc(u.email || "") + '">', true) +
      "</div>" +
      '<div class="form-row">' +
        field(UI.t("Role"), sel("role", u.role || "Operations Manager", ROLES)) +
        field(UI.t("Department form label"), '<input class="input" name="dept" value="' + esc(u.dept || "") + '">') +
      "</div>" +
      '<div class="form-row">' +
        field(UI.t("Password"), '<input class="input" name="password" value="' + esc(u.password || "") + '">', true) +
        field(UI.t("Status"), sel("active", u.active === false ? "Disabled" : "Active", ["Active", "Disabled"])) +
      "</div>" +
      '<p class="hint">' + UI.icon("shield") + " " + UI.t("The role determines which modules and actions this account can use.") + "</p>";

    // ---- Performance tab ----
    const perfTab = pr ? (() => {
      const bar = (label, val, color) =>
        '<div style="margin-bottom:12px;">' +
          '<div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:4px;">' +
            '<span style="color:var(--ink-2);">' + label + '</span>' +
            '<span style="font-weight:700;">' + Math.round(val) + ' / 100</span>' +
          '</div>' +
          '<div style="height:8px;border-radius:99px;background:var(--surface-2);overflow:hidden;">' +
            '<div style="height:100%;width:' + Math.round(val) + '%;background:' + color + ';border-radius:99px;transition:width .6s ease;"></div>' +
          '</div>' +
        '</div>';

      return (
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">' +
          '<div class="card" style="padding:14px;text-align:center;">' +
            '<div style="font-size:2rem;font-weight:800;color:' + rr.color + ';">' + pr.perfScore + '</div>' +
            '<div style="font-size:.75rem;color:var(--muted);">PERF score</div>' +
          '</div>' +
          '<div class="card" style="padding:14px;text-align:center;">' +
            '<div style="font-size:2rem;font-weight:800;color:var(--ink);">' + pr.percentile + '%ile</div>' +
            '<div style="font-size:.75rem;color:var(--muted);">' + UI.t("Team rank") + '</div>' +
          '</div>' +
        '</div>' +
        bar(UI.t("Quality (role-fit)"),    pr.qualityScore,     "#1aa6df") +
        bar(UI.t("Revenue impact"),        pr.revenueScore,     "#1f9d6b") +
        bar(UI.t("Consistency (30 days)"), pr.consistencyScore, "#7a4fb0") +
        bar(UI.t("Seniority"),             pr.seniorityScore,   "#d97706") +
        '<div style="background:var(--surface-2);border-radius:var(--r);padding:12px 16px;margin-top:4px;">' +
          '<div style="display:flex;justify-content:space-between;font-size:.82rem;">' +
            '<span>' + UI.t("Active days (30d)") + '</span><b>' + pr.activeDays + ' / 30</b>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-top:6px;">' +
            '<span>' + UI.t("Actions (30d)") + '</span><b>' + pr.last30Actions + '</b>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-top:6px;">' +
            '<span>' + UI.t("All-time actions") + '</span><b>' + pr.allActions + '</b>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-top:6px;">' +
            '<span>' + UI.t("Trend") + '</span><b style="color:' + (pr.trend==="up"?"var(--green)":pr.trend==="down"?"var(--red)":"var(--muted)") + ';">' + (pr.trend === "up" ? "↑ " + UI.t("Improving") : pr.trend === "down" ? "↓ " + UI.t("Declining") : "→ " + UI.t("Stable")) + '</b>' +
          '</div>' +
        '</div>'
      );
    })() : '<p class="muted">' + UI.t("No performance data yet.") + '</p>';

    // ---- Salary tab (Owner only) ----
    const salaryTab = isOwner ? (() => {
      const salary = u.salary || 0;
      const currency = u.currency || "USD";
      const logs = (u.raiseLogs || []).slice().reverse();
      const raiseRecoHtml = rr
        ? '<div style="background:' + rr.color + '18;border:1px solid ' + rr.color + '44;border-radius:var(--r);padding:12px 16px;margin-bottom:16px;">' +
            '<div style="font-size:.72rem;font-weight:700;color:' + rr.color + ';text-transform:uppercase;letter-spacing:.06em;">' + UI.t("AI Raise Recommendation") + '</div>' +
            '<div style="font-size:1.4rem;font-weight:800;color:' + rr.color + ';margin:4px 0;">' + (rr.low > 0 ? "+" + rr.low + "–" + rr.high + "%" : UI.t("Performance Improvement Plan")) + '</div>' +
            '<div style="font-size:.8rem;color:var(--ink-2);">' + UI.t(rr.label) + ' · ' + pr.percentile + '%ile · PERF ' + pr.perfScore + '</div>' +
          '</div>'
        : "";

      const logRows = logs.length
        ? logs.map(l =>
            '<tr><td>' + l.date + '</td><td style="color:var(--green);font-weight:700;">+' + l.pct + '%</td><td>' + esc(l.note || "—") + '</td></tr>'
          ).join("")
        : '<tr><td colspan="3" style="color:var(--muted);text-align:center;">' + UI.t("No raise history yet") + '</td></tr>';

      return (
        raiseRecoHtml +
        '<div class="form-row">' +
          field(UI.t("Current salary"), '<input class="input" name="salary" type="number" min="0" data-type="number" value="' + salary + '">') +
          field(UI.t("Currency"), sel("currency", currency, ["USD", "EUR", "TRY"])) +
        '</div>' +
        '<h4 style="font-size:.82rem;font-weight:700;margin:12px 0 8px;color:var(--ink-2);">' + UI.t("Log a raise") + '</h4>' +
        '<div class="form-row">' +
          field(UI.t("Raise %"), '<input class="input" name="raisePct" type="number" min="0" max="100" placeholder="e.g. 8">') +
          field(UI.t("Note"), '<input class="input" name="raiseNote" placeholder="' + UI.t("e.g. Annual review") + '">') +
        '</div>' +
        '<h4 style="font-size:.82rem;font-weight:700;margin:12px 0 8px;color:var(--ink-2);">' + UI.t("Raise history") + '</h4>' +
        '<div class="tbl-wrap" style="max-height:160px;overflow-y:auto;">' +
          '<table class="tbl"><thead><tr><th>' + UI.t("Date") + '</th><th>' + UI.t("Raise") + '</th><th>' + UI.t("Note") + '</th></tr></thead>' +
          '<tbody>' + logRows + '</tbody></table>' +
        '</div>'
      );
    })() : "";

    // ---- Tabs (only show perf/salary if editing an existing user) ----
    const showTabs = isEdit && isOwner;
    const tabs = showTabs
      ? '<div class="modal-tabs" id="usrTabs" style="display:flex;gap:0;border-bottom:2px solid var(--line);margin:-4px -4px 16px;">' +
          '<button class="mtab active" data-tab="profile" style="padding:8px 16px;border:none;background:none;font-weight:600;font-size:.85rem;cursor:pointer;border-bottom:2px solid var(--accent);margin-bottom:-2px;color:var(--accent);">' + UI.t("Profile") + '</button>' +
          '<button class="mtab" data-tab="perf" style="padding:8px 16px;border:none;background:none;font-weight:600;font-size:.85rem;cursor:pointer;color:var(--muted);">' + UI.t("Performance") + '</button>' +
          (isOwner ? '<button class="mtab" data-tab="salary" style="padding:8px 16px;border:none;background:none;font-weight:600;font-size:.85rem;cursor:pointer;color:var(--muted);">' + UI.t("Salary & Raise") + '</button>' : '') +
        '</div>'
      : "";

    const body = tabs +
      '<div data-tabpanel="profile">' + profileTab + '</div>' +
      (showTabs ? '<div data-tabpanel="perf" hidden>' + perfTab + '</div>' : '') +
      (showTabs && isOwner ? '<div data-tabpanel="salary" hidden>' + salaryTab + '</div>' : '');

    modal({
      title: isEdit ? UI.t("Edit employee") : UI.t("New employee"), wide: true,
      body,
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button><button class="btn btn-primary" data-save>' + (isEdit ? UI.t("Save changes") : UI.t("Create employee")) + "</button>",
      onMount: (m) => {
        // Tab switching
        m.querySelectorAll(".mtab").forEach(btn => {
          btn.addEventListener("click", () => {
            m.querySelectorAll(".mtab").forEach(b => { b.classList.remove("active"); b.style.borderBottom = "2px solid transparent"; b.style.color = "var(--muted)"; });
            btn.classList.add("active"); btn.style.borderBottom = "2px solid var(--accent)"; btn.style.color = "var(--accent)";
            m.querySelectorAll("[data-tabpanel]").forEach(p => p.hidden = true);
            const panel = m.querySelector('[data-tabpanel="' + btn.dataset.tab + '"]');
            if (panel) panel.hidden = false;
          });
        });

        m.querySelector("[data-save]").addEventListener("click", async () => {
          const v = readForm(m);
          if (!v.name || !v.email || !v.password) return toast(UI.t("Name, email and password are required"), "err");
          v.active = v.active === "Active";
          v.salary = v.salary ? Number(v.salary) : (u.salary || 0);
          v.currency = v.currency || (u.currency || "USD");

          // Process raise log entry if pct entered
          let raiseLogs = u.raiseLogs ? [...u.raiseLogs] : [];
          if (v.raisePct && Number(v.raisePct) > 0) {
            const logEntry = { date: new Date().toISOString().slice(0, 10), pct: Number(v.raisePct), note: v.raiseNote || "" };
            raiseLogs.push(logEntry);
            v.salary = Math.round(v.salary * (1 + Number(v.raisePct) / 100));
            toast(UI.t("Raise logged") + ": +" + v.raisePct + "%");
          }
          v.raiseLogs = raiseLogs;
          delete v.raisePct; delete v.raiseNote;

          if (isEdit) {
            await Store.update("users", u.id, v);
            Store.logAction("update", "user", u.id, "Updated account " + v.name + " (" + v.role + ")");
            toast(UI.t("Account updated"));
          } else {
            v.joined = new Date().toISOString().slice(0, 10);
            const r = await Store.create("users", v);
            Store.logAction("create", "user", r.id, "Created " + v.role + " account for " + v.name);
            toast(UI.t("Account created"));
          }
          closeModal(); App.reload();
        });
      }
    });
  }
  function delUsr(u) {
    confirm({ title: UI.t("Delete employee?"), message: u.name + " (" + (tr(u.role)) + ") " + UI.t("will lose access immediately."), danger: true, okLabel: UI.t("Delete") }, async () => {
      await Store.remove("users", u.id); Store.logAction("delete", "user", u.id, "Deleted account " + u.name); toast(UI.t("Account deleted")); App.reload();
    });
  }


  /* =============================================================
     SHARED — totals, record-link chips, item builder
     ============================================================= */
  function sumItems(items) { return (items || []).reduce((a, it) => a + it.qty * it.price, 0); }
  function orderGross(o) { return sumItems(o.items) + (o.freight || 0); }
  function recChip(ic, text, hash) {
    return '<span class="rec-chip" onclick="UI.closeDrawer();location.hash=\'' + hash + '\'">' + icon(ic) + esc(text) + "</span>";
  }
  function itemBuilder(products, existing) {
    const prodOpts = (selId) => products.map((p) => '<option value="' + p.id + '" data-price="' + p.price + '"' + (p.id === selId ? " selected" : "") + ">" + esc(p.name) + "</option>").join("");
    const row = (it) => '<div class="form-row" data-item style="grid-template-columns:1.7fr .6fr .8fr auto;align-items:end;margin-bottom:10px">' +
      field(T("Product"), '<select class="select" data-p>' + prodOpts(it && it.product) + "</select>") +
      field(T("Qty"), '<input class="input" type="number" min="1" data-q value="' + ((it && it.qty) || 1) + '">') +
      field(T("Price"), '<input class="input" type="number" min="0" data-pr value="' + ((it && it.price) != null ? it.price : (products[0] ? products[0].price : 0)) + '">') +
      '<button class="icon-btn danger" data-rm style="margin-bottom:15px">' + icon("trash") + "</button></div>";
    return { row, html: (existing && existing.length ? existing : [null]).map(row).join("") };
  }
  function wireItemRows(m, builder) {
    const sync = () => m.querySelectorAll("[data-item]").forEach((r) => {
      const s = r.querySelector("[data-p]");
      s.onchange = () => { r.querySelector("[data-pr]").value = s.selectedOptions[0].dataset.price; };
      r.querySelector("[data-rm]").onclick = () => { if (m.querySelectorAll("[data-item]").length > 1) r.remove(); };
    });
    sync();
    const add = m.querySelector("[data-additem]");
    if (add) add.addEventListener("click", () => { m.querySelector("[data-items]").insertAdjacentHTML("beforeend", builder.row(null)); sync(); });
  }
  function readItemRows(m) {
    return [...m.querySelectorAll("[data-item]")].map((r) => ({ product: r.querySelector("[data-p]").value, qty: Number(r.querySelector("[data-q]").value) || 1, price: Number(r.querySelector("[data-pr]").value) || 0 }));
  }

  /* =============================================================
     QUOTATIONS  (Quote → accept → Order)
     ============================================================= */
  async function quotes(el) {
    const [list, clients, products] = await Promise.all([Store.list("quotes"), Store.list("clients"), Store.list("products")]);
    const cmap = Object.fromEntries(clients.map((c) => [c.id, c]));
    const statuses = ["All", "Draft", "Sent", "Accepted", "Rejected", "Expired"];
    let active = "All";
    const total = (q) => sumItems(q.items) + (q.freight || 0);
    function rows() {
      const data = active === "All" ? list : list.filter((q) => q.status === active);
      if (!data.length) return emptyRow(6, T("No records match your filter."));
      return data.map((q) =>
        '<tr data-row data-id="' + q.id + '">' +
        '<td class="mono strong">' + esc(q.ref) + "</td>" +
        "<td>" + esc((cmap[q.client] || {}).name || "—") + "</td>" +
        "<td>" + date(q.date) + "</td>" +
        "<td>" + (q.orderId ? recChip("link", q.orderId, "#/orders") : '<span class="muted">' + T("Valid until") + " " + date(q.validUntil) + "</span>") + "</td>" +
        '<td class="strong">' + money(total(q), q.currency) + "</td>" +
        "<td>" + badge(q.status, QUO_ST) + rowActs("quotes") + "</td>" +
        "</tr>").join("");
    }
    el.innerHTML =
      '<div class="section-title"><div><h2>' + T("Quotations") + '</h2><p>' + T("Price offers — the start of the sales chain") + "</p></div></div>" +
      toolbar("quoSearch", segFilter(statuses, active), "New quote", "quoAdd", "quotes") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + T("Quote") + "</th><th>" + T("Client") + "</th><th>" + T("Date") + "</th><th>" + T("Order") + "</th><th>" + T("Total") + "</th><th>" + T("Status") + "</th></tr></thead><tbody id='quoBody'>" + rows() + "</tbody></table></div>";
    liveSearch("quoSearch");
    el.querySelector("[data-seg]").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; active = b.dataset.f; el.querySelectorAll("[data-seg] button").forEach((x) => x.classList.toggle("active", x === b)); document.getElementById("quoBody").innerHTML = rows(); wire(); });
    { const a = document.getElementById("quoAdd"); if (a) a.addEventListener("click", () => quoteForm(null, clients, products)); }
    function wire() {
      el.querySelectorAll("tr[data-id]").forEach((tr) => {
        const q = list.find((x) => x.id === tr.dataset.id);
        tr.addEventListener("click", (e) => { if (e.target.closest("[data-edit]")) return quoteForm(q, clients, products); if (e.target.closest("[data-del]")) return delQuote(q); quoteDrawer(q, cmap, products); });
      });
    }
    wire();
  }
  function quoteDrawer(q, cmap, products) {
    const pmap = Object.fromEntries(products.map((p) => [p.id, p]));
    const canConvert = Auth.can("quotes", "edit") && !q.orderId && q.status !== "Rejected" && q.status !== "Expired";
    const itemsTbl = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + T("Product") + '</th><th class="right">' + T("Qty") + '</th><th class="right">' + T("Price") + '</th><th class="right">' + T("Sub") + "</th></tr></thead><tbody>" +
      q.items.map((it) => { const p = pmap[it.product] || {}; return "<tr><td>" + esc(p.name || it.product) + '</td><td class="right">' + it.qty + '</td><td class="right">' + money(it.price, q.currency) + '</td><td class="right strong">' + money(it.qty * it.price, q.currency) + "</td></tr>"; }).join("") +
      (q.freight ? '<tr><td colspan="3">' + T("Freight") + '</td><td class="right">' + money(q.freight, q.currency) + "</td></tr>" : "") +
      '<tr><td colspan="3" class="strong">' + T("Total") + '</td><td class="right strong">' + money(sumItems(q.items) + (q.freight || 0), q.currency) + "</td></tr></tbody></table></div>";
    drawer({
      kicker: T("Quotation"), title: q.ref,
      body:
        '<div class="dgrid"><div class="dfield"><div class="k">' + T("Client") + '</div><div class="v">' + esc((cmap[q.client] || {}).name || "—") + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Status") + '</div><div class="v">' + badge(q.status, QUO_ST) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Date") + '</div><div class="v">' + date(q.date) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Valid until") + '</div><div class="v">' + date(q.validUntil) + "</div></div></div>" +
        (q.notes ? '<div class="dfield"><div class="k">' + T("Notes") + '</div><div class="v">' + esc(q.notes) + "</div></div>" : "") +
        '<div class="dfield"><div class="k">' + T("Line items") + "</div></div>" + itemsTbl +
        (q.orderId && Auth.can("orders", "view") ? '<div class="dfield" style="margin-top:14px"><div class="k">' + T("Converted to order") + "</div><div class='v'>" + recChip("link", q.orderId, "#/orders") + "</div></div>" : ""),
      footer: '<button class="btn btn-ghost" onclick="UI.closeDrawer()">' + T("Close") + "</button>" + (canConvert ? '<button class="btn btn-primary" id="quoConvert">' + icon("check") + T("Accept & create order") + "</button>" : "")
    });
    const cv = document.getElementById("quoConvert");
    if (cv) cv.addEventListener("click", () => convertQuoteToOrder(q));
  }
  async function convertQuoteToOrder(q) {
    const ref = "SO-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 9000) + 1000);
    const order = await Store.create("orders", { ref, client: q.client, date: new Date().toISOString().slice(0, 10), status: "Confirmed", currency: q.currency, freight: q.freight || 0, quoteId: q.id, shipmentId: null, invoiceId: null, items: q.items });
    await Store.update("quotes", q.id, { status: "Accepted", orderId: order.id });
    Store.logAction("update", "quote", q.id, "Quote " + q.ref + " accepted → order " + ref);
    // hand the new order to Operations to book the shipment
    const ops = await Workflow.handoffToStage("order", "orders", order.id, { entity: "order", ref, title: T("New order to book"), body: T("Order") + " " + ref + " — " + T("create the shipment."), link: "#/orders" });
    toast(T("Order created from quote") + (ops ? " · " + T("handed to") + " " + ops.name.split(" ")[0] : "")); UI.closeDrawer(); App.reload();
    if (window.showSidebarAnimation) {
      showSidebarAnimation("orders", "+1", "blue");
    }
  }
  function quoteForm(q, clients, products) {
    const isEdit = !!q; q = q || {};
    const clientOpts = clients.map((c) => '<option value="' + c.id + '"' + (c.id === q.client ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");
    const builder = itemBuilder(products, q.items);
    const today = new Date().toISOString().slice(0, 10);
    const valid = (() => { const x = new Date(); x.setDate(x.getDate() + 14); return x.toISOString().slice(0, 10); })();
    modal({
      title: isEdit ? T("Edit quote") : T("New quote"), wide: true,
      body:
        '<div class="form-row">' + field(T("Client"), '<select class="select" name="client">' + clientOpts + "</select>", true) + field(T("Currency"), sel("currency", q.currency || "USD", ["USD", "EUR", "TRY"])) + "</div>" +
        '<div class="form-row">' + field(T("Date"), '<input class="input" type="date" name="date" value="' + esc(q.date || today) + '">') + field(T("Valid until"), '<input class="input" type="date" name="validUntil" value="' + esc(q.validUntil || valid) + '">') + "</div>" +
        '<div class="form-row">' + field(T("Freight"), '<input class="input" type="number" min="0" data-type="number" name="freight" value="' + (q.freight || 0) + '">') + field(T("Status"), sel("status", q.status || "Draft", ["Draft", "Sent", "Accepted", "Rejected", "Expired"])) + "</div>" +
        field(T("Notes"), '<input class="input" name="notes" value="' + esc(q.notes || "") + '">') +
        '<div class="divider"></div><label style="font-size:.8rem;font-weight:600;color:var(--ink-2)">' + T("Line items") + '</label><div data-items>' + builder.html + "</div>" +
        '<button class="btn btn-ghost btn-sm" data-additem>' + icon("plus") + T("Add item") + "</button>",
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + T("Cancel") + '</button><button class="btn btn-primary" data-save>' + (isEdit ? T("Save changes") : T("Create quote")) + "</button>",
      onMount: (m) => {
        wireItemRows(m, builder);
        m.querySelector("[data-save]").addEventListener("click", async () => {
          const v = readForm(m); v.items = readItemRows(m);
          if (!v.items.length) return toast(T("Add at least one item"), "err");
          if (isEdit) { await Store.update("quotes", q.id, v); Store.logAction("update", "quote", q.id, "Updated quote " + (q.ref || "")); toast(T("Quote updated")); }
          else { v.ref = "QT-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 9000) + 1000); v.orderId = null; const r = await Store.create("quotes", v); Store.logAction("create", "quote", r.id, "Created quote " + v.ref); toast(T("Quote created")); }
          closeModal(); App.reload();
        });
      }
    });
  }
  function delQuote(q) { confirm({ title: T("Delete?"), message: q.ref, danger: true, okLabel: T("Delete") }, async () => { await Store.remove("quotes", q.id); Store.logAction("delete", "quote", q.id, "Deleted quote " + q.ref); toast(T("Deleted")); App.reload(); }); }

  /* =============================================================
     ORDER → shipment / invoice / payment helpers
     ============================================================= */
  async function orderToInvoice(o) {
    const amount = orderGross(o);
    const client = await Store.get("clients", o.client);
    const terms = (client && client.terms) || 30;
    const issued = new Date().toISOString().slice(0, 10);
    const due = (() => { const x = new Date(); x.setDate(x.getDate() + terms); return x.toISOString().slice(0, 10); })();
    const no = "INV-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 900) + 1200);
    const inv = await Store.create("invoices", { no, client: o.client, order: o.id, issued, due, amount, paid: 0, currency: o.currency, status: "Sent" });
    await Store.update("orders", o.id, { invoiceId: inv.id });
    Store.logAction("create", "invoice", inv.id, "Invoiced order " + o.ref + " → " + no + " (" + money(amount, o.currency) + ")");
    // hand the invoice to Finance to send & collect
    await Workflow.handoffToStage("invoice", "invoices", inv.id, { entity: "invoice", ref: no, title: T("Invoice to collect"), body: no + " — " + T("send it and follow up payment."), link: "#/finance" });
    toast(T("Invoice generated")); UI.closeDrawer(); App.reload();
  }
  function recordInvoicePayment(inv) {
    const totalAmt = inv.totalAmount !== undefined ? inv.totalAmount : inv.amount;
    const outstanding = totalAmt - (inv.paid || 0);
    modal({
      title: T("Record payment") + " · " + inv.no, wide: false,
      body:
        '<div class="dfield"><div class="k">' + T("Outstanding") + '</div><div class="v strong" style="font-size:1.2rem">' + money(outstanding, inv.currency) + "</div></div>" +
        '<div class="form-row">' + field(T("Amount"), '<input class="input" type="number" min="0" id="payAmt" value="' + outstanding + '">', true) + field(T("Date"), '<input class="input" type="date" id="payDate" value="' + new Date().toISOString().slice(0, 10) + '">') + "</div>" +
        field(T("Method"), '<select class="select" id="payMethod"><option>Bank transfer</option><option>Cash</option><option>Letter of credit</option><option>Card</option></select>'),
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + T("Cancel") + '</button><button class="btn btn-primary" id="paySave">' + icon("wallet") + T("Record payment") + "</button>",
      onMount: (m) => m.querySelector("#paySave").addEventListener("click", async () => {
        const amt = Number(m.querySelector("#payAmt").value) || 0;
        if (amt <= 0) return toast(T("Enter an amount"), "err");
        const client = await Store.get("clients", inv.client);
        const ref = "PAY-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 9000) + 1000);
        await Store.create("payments", { ref, kind: "in", party: (client || {}).name || inv.client, doc: inv.id, date: m.querySelector("#payDate").value, amount: amt, currency: inv.currency, method: m.querySelector("#payMethod").value });
        const paid = (inv.paid || 0) + amt;
        const status = paid >= totalAmt ? "Paid" : "Partial";
        await Store.update("invoices", inv.id, { paid, status });
        Store.logAction("create", "payment", inv.id, "Received " + money(amt, inv.currency) + " on " + inv.no);
        // fully paid → let the Owner know the cash landed
        if (status === "Paid") { const owner = await Workflow.defaultAssignee("Owner"); if (owner) await Workflow.notify({ to: owner.id, type: "info", title: T("Invoice paid"), body: inv.no + " " + T("fully paid") + " — " + money(totalAmt, inv.currency) + ".", entity: "invoice", entityId: inv.id, link: "#/finance" }); }
        toast(T("Payment recorded")); closeModal(); App.reload();
      })
    });
  }

  /* =============================================================
     PURCHASING  (Purchase Orders → receive → Bills → payment)
     ============================================================= */
  async function purchasing(el) {
    const [pos, bills, suppliers, products] = await Promise.all([Store.list("purchaseorders"), Store.list("bills"), Store.list("suppliers"), Store.list("products")]);
    const smap = Object.fromEntries(suppliers.map((s) => [s.id, s]));
    let tab = "pos";
    const poTotal = (po) => sumItems(po.items);
    function poRows() {
      if (!pos.length) return emptyRow(6, T("No records match your filter."));
      return pos.map((po) =>
        '<tr data-row data-id="' + po.id + '" data-kind="po">' +
        '<td class="mono strong">' + esc(po.ref) + "</td>" +
        "<td>" + esc((smap[po.supplier] || {}).name || "—") + "</td>" +
        "<td>" + date(po.date) + "</td>" +
        "<td>" + (po.billId ? recChip("wallet", po.billId, "#/purchasing") : '<span class="muted">' + esc(po.warehouse) + "</span>") + "</td>" +
        '<td class="strong">' + money(poTotal(po), po.currency) + "</td>" +
        "<td>" + badge(po.status, PO_ST) + rowActs("purchasing") + "</td>" +
        "</tr>").join("");
    }
    function billRows() {
      if (!bills.length) return emptyRow(6, T("No records match your filter."));
      return bills.map((b) =>
        '<tr data-row data-id="' + b.id + '" data-kind="bill">' +
        '<td class="mono strong">' + esc(b.no) + "</td>" +
        "<td>" + esc((smap[b.supplier] || {}).name || "—") + "</td>" +
        "<td>" + date(b.issued) + "</td>" +
        "<td>" + date(b.due) + "</td>" +
        '<td class="strong">' + money(b.amount, b.currency) + " <span class='muted' style='font-weight:400'>(" + money(b.paid || 0, b.currency) + " " + T("paid") + ")</span></td>" +
        "<td>" + badge(b.status, BILL_ST) + (Auth.can("purchasing", "edit") && b.status !== "Paid" ? '<div class="row-actions" style="margin-top:2px"><button class="icon-btn" data-bpay title="' + T("Record payment") + '">' + icon("wallet") + "</button></div>" : "") + "</td>" +
        "</tr>").join("");
    }
    function render() {
      const head = tab === "pos"
        ? "<th>" + T("PO ref") + "</th><th>" + T("Supplier") + "</th><th>" + T("Date") + "</th><th>" + T("Bill / warehouse") + "</th><th>" + T("Total") + "</th><th>" + T("Status") + "</th>"
        : "<th>" + T("Bill") + "</th><th>" + T("Supplier") + "</th><th>" + T("Issued") + "</th><th>" + T("Due") + "</th><th>" + T("Amount") + "</th><th>" + T("Status") + "</th>";
      document.getElementById("purHead").innerHTML = head;
      document.getElementById("purBody").innerHTML = tab === "pos" ? poRows() : billRows();
      wire();
    }
    el.innerHTML =
      '<div class="section-title"><div><h2>' + T("Purchasing") + '</h2><p>' + T("Procurement from suppliers → receive goods → payables") + "</p></div></div>" +
      '<div class="toolbar"><div class="seg" id="purTabs"><button data-t="pos" class="active">' + T("Purchase Orders") + '</button><button data-t="bills">' + T("Supplier Bills") + '</button></div><div class="grow"></div>' +
      (Auth.can("purchasing", "edit") ? '<button class="btn btn-primary" id="poAdd">' + icon("plus") + T("New purchase order") + "</button>" : "") + "</div>" +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr id="purHead"></tr></thead><tbody id="purBody"></tbody></table></div>';
    el.querySelector("#purTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-t]"); if (!b) return; tab = b.dataset.t; el.querySelectorAll("#purTabs button").forEach((x) => x.classList.toggle("active", x === b)); render(); });
    { const a = document.getElementById("poAdd"); if (a) a.addEventListener("click", () => poForm(null, suppliers, products)); }
    function wire() {
      el.querySelectorAll("tr[data-id]").forEach((tr) => {
        if (tr.dataset.kind === "po") {
          const po = pos.find((x) => x.id === tr.dataset.id);
          tr.addEventListener("click", (e) => { if (e.target.closest("[data-edit]")) return poForm(po, suppliers, products); if (e.target.closest("[data-del]")) return delPO(po); poDrawer(po, smap, products); });
        } else {
          const b = bills.find((x) => x.id === tr.dataset.id);
          tr.addEventListener("click", (e) => { if (e.target.closest("[data-bpay]")) return recordBillPayment(b); billDrawer(b, smap); });
        }
      });
    }
    render();
  }
  function poDrawer(po, smap, products) {
    const pmap = Object.fromEntries(products.map((p) => [p.id, p]));
    const canReceive = Auth.can("purchasing", "edit") && po.status === "Sent";
    const itemsTbl = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + T("Item") + '</th><th class="right">' + T("Qty") + '</th><th class="right">' + T("Cost") + '</th><th class="right">' + T("Sub") + "</th></tr></thead><tbody>" +
      po.items.map((it) => { const p = pmap[it.product] || {}; return "<tr><td>" + esc(it.name || p.name || it.product) + '</td><td class="right">' + it.qty + '</td><td class="right">' + money(it.price, po.currency) + '</td><td class="right strong">' + money(it.qty * it.price, po.currency) + "</td></tr>"; }).join("") +
      '<tr><td colspan="3" class="strong">' + T("Total") + '</td><td class="right strong">' + money(sumItems(po.items), po.currency) + "</td></tr></tbody></table></div>";
    drawer({
      kicker: T("Purchase order"), title: po.ref,
      body:
        '<div class="dgrid"><div class="dfield"><div class="k">' + T("Supplier") + '</div><div class="v">' + esc((smap[po.supplier] || {}).name || "—") + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Status") + '</div><div class="v">' + badge(po.status, PO_ST) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Date") + '</div><div class="v">' + date(po.date) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Warehouse") + '</div><div class="v">' + esc(po.warehouse) + "</div></div></div>" +
        '<div class="dfield"><div class="k">' + T("Line items") + "</div></div>" + itemsTbl +
        (po.billId ? '<div class="dfield" style="margin-top:14px"><div class="k">' + T("Supplier bill") + "</div><div class='v'>" + recChip("wallet", po.billId, "#/purchasing") + "</div></div>" : ""),
      footer: '<button class="btn btn-ghost" onclick="UI.closeDrawer()">' + T("Close") + "</button>" + (canReceive ? '<button class="btn btn-primary" id="poReceive">' + icon("receive") + T("Receive & create bill") + "</button>" : "")
    });
    const rc = document.getElementById("poReceive");
    if (rc) rc.addEventListener("click", () => receivePO(po, products));
  }
  async function deductInventoryForShipment(s) {
    if (s.stockDeducted) return 0;
    
    let items = [];
    if (s.items && s.items.length) {
      items = s.items;
    } else if (s.orderId) {
      const ord = await Store.get("orders", s.orderId);
      if (ord && ord.items) items = ord.items;
    }
    
    if (items.length === 0) return 0;
    
    const products = await Store.list("products");
    let totalQty = 0;
    for (const it of items) {
      if (it.product) {
        const p = products.find((x) => x.id === it.product) || await Store.get("products", it.product);
        if (p) {
          const ns = Math.max(0, (p.stock || 0) - it.qty);
          await Store.update("products", it.product, { stock: ns, status: productStatus(ns, p.reorder) });
          totalQty += it.qty;
        }
      }
    }
    await Store.update("shipments", s.id, { stockDeducted: true });
    s.stockDeducted = true;
    return totalQty;
  }

  async function restoreInventoryForShipment(s) {
    if (!s.stockDeducted) return 0;
    
    let items = [];
    if (s.items && s.items.length) {
      items = s.items;
    } else if (s.orderId) {
      const ord = await Store.get("orders", s.orderId);
      if (ord && ord.items) items = ord.items;
    }
    
    if (items.length === 0) return 0;
    
    const products = await Store.list("products");
    let totalQty = 0;
    for (const it of items) {
      if (it.product) {
        const p = products.find((x) => x.id === it.product) || await Store.get("products", it.product);
        if (p) {
          const ns = (p.stock || 0) + it.qty;
          await Store.update("products", it.product, { stock: ns, status: productStatus(ns, p.reorder) });
          totalQty += it.qty;
        }
      }
    }
    await Store.update("shipments", s.id, { stockDeducted: false });
    s.stockDeducted = false;
    return totalQty;
  }

  async function receivePO(po, products) {
    let totalQty = 0;
    for (const it of po.items) {
      if (it.product) {
        const p = products.find((x) => x.id === it.product) || await Store.get("products", it.product);
        if (p) {
          const ns = (p.stock || 0) + it.qty;
          await Store.update("products", it.product, { stock: ns, status: productStatus(ns, p.reorder) });
          totalQty += it.qty;
        }
      }
    }
    const amount = sumItems(po.items);
    const due = (() => { const x = new Date(); x.setDate(x.getDate() + 30); return x.toISOString().slice(0, 10); })();
    const no = "BILL-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 900) + 100);
    const bill = await Store.create("bills", { no, supplier: po.supplier, po: po.id, issued: new Date().toISOString().slice(0, 10), due, amount, paid: 0, currency: po.currency, status: "Unpaid" });
    await Store.update("purchaseorders", po.id, { status: "Received", billId: bill.id });
    Store.logAction("update", "purchaseorder", po.id, "Received PO " + po.ref + " → stock updated, bill " + no);
    // new supplier bill → hand to Finance to schedule payment
    await Workflow.handoffToStage("invoice", "bills", bill.id, { entity: "bill", ref: no, title: T("New supplier bill"), body: no + " — " + T("schedule payment."), link: "#/purchasing" });
    toast(T("Goods received & bill created")); UI.closeDrawer(); App.reload();
    if (totalQty > 0 && window.showSidebarAnimation) {
      showSidebarAnimation("inventory", "+" + totalQty, "green");
    }
  }
  function billDrawer(b, smap) {
    const out = b.amount - (b.paid || 0);
    drawer({
      kicker: T("Supplier bill"), title: b.no,
      body: '<div class="dgrid"><div class="dfield"><div class="k">' + T("Supplier") + '</div><div class="v">' + esc((smap[b.supplier] || {}).name || "—") + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Status") + '</div><div class="v">' + badge(b.status, BILL_ST) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Amount") + '</div><div class="v strong">' + money(b.amount, b.currency) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Paid") + '</div><div class="v">' + money(b.paid || 0, b.currency) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Outstanding") + '</div><div class="v strong">' + money(out, b.currency) + "</div></div>" +
        '<div class="dfield"><div class="k">' + T("Due") + '</div><div class="v">' + date(b.due) + "</div></div>" +
        (b.po ? '<div class="dfield"><div class="k">' + T("Purchase order") + "</div><div class='v'>" + recChip("bag", b.po, "#/purchasing") + "</div></div>" : "") + "</div>",
      footer: '<button class="btn btn-ghost" onclick="UI.closeDrawer()">' + T("Close") + "</button>" + (Auth.can("purchasing", "edit") && b.status !== "Paid" ? '<button class="btn btn-primary" id="billPay">' + icon("wallet") + T("Record payment") + "</button>" : "")
    });
    const bp = document.getElementById("billPay");
    if (bp) bp.addEventListener("click", () => recordBillPayment(b));
  }
  function recordBillPayment(b) {
    const out = b.amount - (b.paid || 0);
    modal({
      title: T("Record payment") + " · " + b.no, wide: false,
      body: '<div class="dfield"><div class="k">' + T("Outstanding") + '</div><div class="v strong" style="font-size:1.2rem">' + money(out, b.currency) + "</div></div>" +
        '<div class="form-row">' + field(T("Amount"), '<input class="input" type="number" min="0" id="bpAmt" value="' + out + '">', true) + field(T("Date"), '<input class="input" type="date" id="bpDate" value="' + new Date().toISOString().slice(0, 10) + '">') + "</div>",
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + T("Cancel") + '</button><button class="btn btn-primary" id="bpSave">' + icon("wallet") + T("Record payment") + "</button>",
      onMount: (m) => m.querySelector("#bpSave").addEventListener("click", async () => {
        const amt = Number(m.querySelector("#bpAmt").value) || 0;
        if (amt <= 0) return toast(T("Enter an amount"), "err");
        const sup = await Store.get("suppliers", b.supplier);
        const ref = "PAY-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 9000) + 1000);
        await Store.create("payments", { ref, kind: "out", party: (sup || {}).name || b.supplier, doc: b.id, date: m.querySelector("#bpDate").value, amount: amt, currency: b.currency, method: "Bank transfer" });
        const paid = (b.paid || 0) + amt;
        await Store.update("bills", b.id, { paid, status: paid >= b.amount ? "Paid" : "Partial" });
        Store.logAction("create", "payment", b.id, "Paid " + money(amt, b.currency) + " to supplier on " + b.no);
        toast(T("Payment recorded")); closeModal(); UI.closeDrawer(); App.reload();
      })
    });
  }
  function poForm(po, suppliers, products) {
    const isEdit = !!po; po = po || {};
    const supOpts = suppliers.map((s) => '<option value="' + s.id + '"' + (s.id === po.supplier ? " selected" : "") + ">" + esc(s.name) + "</option>").join("");
    const builder = itemBuilder(products, po.items);
    modal({
      title: isEdit ? T("Edit purchase order") : T("New purchase order"), wide: true,
      body:
        '<div class="form-row">' + field(T("Supplier"), '<select class="select" name="supplier">' + supOpts + "</select>", true) + field(T("Currency"), sel("currency", po.currency || "USD", ["USD", "EUR", "TRY"])) + "</div>" +
        '<div class="form-row">' + field(T("Date"), '<input class="input" type="date" name="date" value="' + esc(po.date || new Date().toISOString().slice(0, 10)) + '">') + field(T("Warehouse"), sel("warehouse", po.warehouse || (window.Workspace ? Workspace.warehouses()[0] : "Mersin Main"), (window.Workspace ? Workspace.warehouses() : ["Mersin Main", "Mersin Cold Store", "Istanbul DC"]))) + "</div>" +
        field(T("Status"), sel("status", po.status || "Draft", ["Draft", "Sent", "Received", "Cancelled"])) +
        '<div class="divider"></div><label style="font-size:.8rem;font-weight:600;color:var(--ink-2)">' + T("Line items") + '</label><div data-items>' + builder.html + "</div>" +
        '<button class="btn btn-ghost btn-sm" data-additem>' + icon("plus") + T("Add item") + "</button>",
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + T("Cancel") + '</button><button class="btn btn-primary" data-save>' + (isEdit ? T("Save changes") : T("Create purchase order")) + "</button>",
      onMount: (m) => {
        wireItemRows(m, builder);
        m.querySelector("[data-save]").addEventListener("click", async () => {
          const v = readForm(m); v.items = readItemRows(m).map((it) => { const p = products.find((x) => x.id === it.product); return { product: it.product, name: p ? p.name : "", qty: it.qty, price: it.price }; });
          if (!v.items.length) return toast(T("Add at least one item"), "err");
          if (isEdit) { await Store.update("purchaseorders", po.id, v); Store.logAction("update", "purchaseorder", po.id, "Updated PO " + (po.ref || "")); toast(T("Saved")); }
          else { v.ref = "PUR-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 9000) + 100); v.billId = null; const r = await Store.create("purchaseorders", v); Store.logAction("create", "purchaseorder", r.id, "Created PO " + v.ref); toast(T("Purchase order created")); }
          closeModal(); App.reload();
        });
      }
    });
  }
  function delPO(po) { confirm({ title: T("Delete?"), message: po.ref, danger: true, okLabel: T("Delete") }, async () => { await Store.remove("purchaseorders", po.id); Store.logAction("delete", "purchaseorder", po.id, "Deleted PO " + po.ref); toast(T("Deleted")); App.reload(); }); }

  /* =============================================================
     ACCOUNTING  (AR / AP / cash / P&L from real data)
     ============================================================= */
  async function accounting(el) {
    const [invoices, bills, payments, shipments, clients] = await Promise.all(["invoices", "bills", "payments", "shipments", "clients"].map((c) => Store.list(c)));
    const cmap = Object.fromEntries(clients.map((c) => [c.id, c]));
    const getInvTotal = (x) => x.totalAmount !== undefined ? x.totalAmount : x.amount;
    const arOpen = invoices.filter((i) => ["Sent", "Partial", "Overdue"].includes(i.status));
    const ar = arOpen.reduce((a, i) => a + toUSD(getInvTotal(i) - (i.paid || 0), i.currency), 0);
    const apOpen = bills.filter((b) => ["Unpaid", "Partial", "Overdue"].includes(b.status));
    const ap = apOpen.reduce((a, b) => a + toUSD(b.amount - (b.paid || 0), b.currency), 0);
    const cashIn = payments.filter((p) => p.kind === "in").reduce((a, p) => a + toUSD(p.amount, p.currency), 0);
    const cashOut = payments.filter((p) => p.kind === "out").reduce((a, p) => a + toUSD(p.amount, p.currency), 0);
    const cash = cashIn - cashOut;
    const revenue = invoices.filter((i) => i.status !== "Draft").reduce((a, i) => a + toUSD(i.amount, i.currency), 0);
    const purchaseCost = bills.reduce((a, b) => a + toUSD(b.amount, b.currency), 0);
    const logisticsCost = shipments.reduce((a, s) => a + (s.costs ? (s.costs.freight + s.costs.customs + s.costs.insurance) : 0), 0);
    const profit = revenue - purchaseCost - logisticsCost;

    const vatSales = invoices.reduce((a, i) => a + toUSD(i.vatAmount !== undefined ? i.vatAmount : (i.amount * (i.vatRate || 0) / 100), i.currency), 0);
    const vatPurchases = bills.reduce((a, b) => a + toUSD(b.amount * 0.20, b.currency), 0);
    const netVat = vatSales - vatPurchases;

    const kpi = (ic, color, n, l, sub) => '<div class="kpi"><div class="ic ' + color + '">' + icon(ic) + '</div><div class="n">' + n + '</div><div class="l">' + l + "</div>" + (sub ? '<div class="delta">' + sub + "</div>" : "") + "</div>";
    const pl = (label, val, cls) => '<div class="pl-row ' + (cls || "") + '"><span>' + label + "</span><span class='strong'>" + usd(val, "USD") + "</span></div>";

    // AR aging
    const today = new Date();
    const aging = { current: 0, d30: 0, d60: 0, d90: 0 };
    arOpen.forEach((i) => { const days = Math.round((today - new Date(i.due)) / 86400000); const amt = toUSD(getInvTotal(i) - (i.paid || 0), i.currency); if (days <= 0) aging.current += amt; else if (days <= 30) aging.d30 += amt; else if (days <= 60) aging.d60 += amt; else aging.d90 += amt; });

    el.innerHTML =
      '<div class="section-title"><div><h2>' + T("Accounting") + '</h2><p>' + T("Receivables, payables, cash & profit — indicative USD") + "</p></div>" +
        '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">' +
          (Auth.can("finance", "ai") ? '<button class="btn btn-ai" id="aiBtn">' + icon("sparkles") + T("AI Accountant") + '</button>' : "") +
          '<button class="btn btn-ghost" id="exportPdfBtn">' + icon("file") + T("Export PDF") + '</button>' +
          '<button class="btn btn-ghost" id="exportExcelBtn">' + icon("receive") + T("Export Excel") + '</button>' +
        '</div>' +
      "</div>" +
      '<div class="kpis">' +
        kpi("receipt", "blue", usd(ar, "USD"), T("Receivables (AR)"), arOpen.length + " " + T("open")) +
        kpi("wallet", "gold", usd(ap, "USD"), T("Payables (AP)"), apOpen.length + " " + T("open")) +
        kpi("dollar", "green", usd(cash, "USD"), T("Net cash flow"), "+" + usd(cashIn, "USD") + " / -" + usd(cashOut, "USD")) +
        kpi("trend", profit >= 0 ? "green" : "navy", usd(profit, "USD"), T("Gross profit (est.)"), "") +
      "</div>" +
      '<div class="grid-3">' +
        '<div class="card"><div class="card-h"><h3>' + T("Profit & loss (indicative)") + '</h3></div><div class="card-b">' +
          pl(T("Revenue (invoiced)"), revenue) +
          pl("− " + T("Purchases (supplier bills)"), -purchaseCost) +
          pl("− " + T("Logistics costs"), -logisticsCost) +
          '<div class="divider"></div>' + pl("= " + T("Gross profit"), profit, "total") +
        "</div></div>" +
        '<div class="card"><div class="card-h"><h3>' + T("Receivables aging") + '</h3></div><div class="card-b"><div class="barlist">' +
          [["Current", aging.current, "var(--green)"], ["1–30 " + T("days"), aging.d30, "var(--accent)"], ["31–60 " + T("days"), aging.d60, "var(--gold)"], ["60+ " + T("days"), aging.d90, "var(--red)"]].map(([k, v, c]) => {
            const max = Math.max(1, aging.current, aging.d30, aging.d60, aging.d90);
            return '<div><div class="br-top"><span class="k">' + k + '</span><span class="v">' + usd(v, "USD") + '</span></div><div class="bar"><span style="width:' + (v / max * 100) + "%;background:" + c + '"></span></div></div>';
          }).join("") +
        "</div></div>" +
        '<div class="card"><div class="card-h"><h3>' + T("VAT Summary") + '</h3></div><div class="card-b">' +
          pl(T("Calculated VAT (Sales)"), vatSales) +
          pl("− " + T("Deductible VAT (Purchases)"), -vatPurchases) +
          '<div class="divider"></div>' +
          (netVat >= 0
            ? pl("= " + T("Net VAT Payable"), netVat, "total")
            : pl("= " + T("Net VAT Receivable"), -netVat, "total")) +
        "</div></div>" +
      "</div>" +
      '<div class="card" style="margin-top:18px"><div class="card-h"><h3>' + T("Payments ledger") + '</h3><div class="grow" style="flex:1"></div><span class="tag">' + payments.length + " " + T("entries") + "</span></div>" +
        '<div class="tbl-wrap" style="border:none;box-shadow:none;border-radius:0"><table class="tbl"><thead><tr><th>' + T("Reference") + "</th><th>" + T("Party") + "</th><th>" + T("Date") + "</th><th>" + T("Direction") + "</th><th>" + T("Method") + '</th><th class="right">' + T("Amount") + "</th></tr></thead><tbody>" +
        payments.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).map((p) =>
          "<tr><td class='mono strong'>" + esc(p.ref) + "</td><td>" + esc(p.party) + "</td><td>" + date(p.date) + "</td><td>" + (p.kind === "in" ? '<span class="st green">' + T("Cash in") + "</span>" : '<span class="st amber">' + T("Cash out") + "</span>") + "</td><td>" + esc(p.method) + "</td><td class='right strong'>" + (p.kind === "in" ? "+" : "−") + money(p.amount, p.currency) + "</td></tr>").join("") +
        "</tbody></table></div></div>";

    function generatePDF() {
      const B = window.Workspace ? Workspace.brand() : { company: "WeboCloud", tagline: "" };
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      document.body.appendChild(iframe);

      const doc = iframe.contentWindow.document;
      doc.open();
      
      const titleStr = T("Company Financial Statement");
      const dateStr = dateTime(new Date());
      
      doc.write('<html><head><title>' + titleStr + '</title><style>');
      doc.write('body { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #1e293b; padding: 40px; line-height: 1.5; font-size: 14px; }');
      doc.write('.header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1e73be; padding-bottom: 15px; margin-bottom: 30px; }');
      doc.write('.logo-area { display: flex; align-items: center; gap: 10px; }');
      doc.write('.logo-text { font-family: "Jost", "Inter", sans-serif; font-size: 1.6rem; font-weight: 800; color: #102a45; letter-spacing: 0.05em; }');
      doc.write('.logo-sub { font-size: 0.75rem; color: #8aa0b6; text-transform: uppercase; letter-spacing: 0.15em; font-weight: 600; margin-top: -2px; }');
      doc.write('.title-area { text-align: right; }');
      doc.write('.title { font-size: 1.5rem; font-weight: 700; margin: 0; color: #1e73be; }');
      doc.write('.meta { font-size: 0.8rem; color: #64748b; margin-top: 5px; }');
      doc.write('.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 35px; }');
      doc.write('.kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; background: #f8fafc; text-align: left; }');
      doc.write('.kpi .lbl { font-size: 0.7rem; color: #64748b; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }');
      doc.write('.kpi .val { font-size: 1.25rem; font-weight: 700; margin-top: 6px; color: #0f172a; }');
      doc.write('.kpi .sub { font-size: 0.75rem; color: #94a3b8; margin-top: 4px; }');
      doc.write('.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 25px; margin-bottom: 35px; }');
      doc.write('.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 35px; }');
      doc.write('.card { border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }');
      doc.write('.card-h { background: #f1f5f9; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; }');
      doc.write('.card-h h3 { font-size: 0.95rem; font-weight: 700; margin: 0; color: #1e293b; }');
      doc.write('.card-b { padding: 16px; }');
      doc.write('.pl-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #e2e8f0; font-size: 0.9rem; }');
      doc.write('.pl-row:last-child { border-bottom: none; }');
      doc.write('.pl-row.strong { font-weight: 700; border-bottom: 1px solid #cbd5e1; }');
      doc.write('.pl-row.total { font-weight: 800; font-size: 1rem; color: #1e73be; border-top: 2px solid #cbd5e1; padding-top: 10px; margin-top: 5px; }');
      doc.write('.aging-item { margin-bottom: 12px; }');
      doc.write('.aging-item:last-child { margin-bottom: 0; }');
      doc.write('.aging-label { display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 4px; }');
      doc.write('.aging-bar { height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; }');
      doc.write('.aging-progress { height: 100%; border-radius: 4px; }');
      doc.write('.section-h { font-size: 1.1rem; font-weight: 700; color: #102a45; border-bottom: 2px solid #cbd5e1; padding-bottom: 6px; margin-top: 40px; margin-bottom: 15px; }');
      doc.write('.tbl { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 0.85rem; }');
      doc.write('.tbl th, .tbl td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; }');
      doc.write('.tbl th { background: #f8fafc; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }');
      doc.write('.tbl td.right, .tbl th.right { text-align: right; }');
      doc.write('.tbl td.mono { font-family: monospace; font-weight: 600; }');
      doc.write('.st { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }');
      doc.write('.st.green { background: #dcfce7; color: #15803d; }');
      doc.write('.st.amber { background: #fef3c7; color: #b45309; }');
      doc.write('.footer { text-align: center; margin-top: 60px; font-size: 0.8rem; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; }');
      doc.write('</style></head><body>');

      // Header
      doc.write('<div class="header">');
      doc.write('  <div class="logo-area">');
      doc.write('    <div>');
      doc.write('      <div class="logo-text">' + esc(B.company) + '</div>');
      doc.write('      <div class="logo-sub">' + esc(B.tagline || T("SAP Console")) + '</div>');
      doc.write('    </div>');
      doc.write('  </div>');
      doc.write('  <div class="title-area">');
      doc.write('    <h1 class="title">' + titleStr + '</h1>');
      doc.write('    <div class="meta">' + T("Generated Date") + ': ' + dateStr + '</div>');
      doc.write('  </div>');
      doc.write('</div>');

      // KPIs
      doc.write('<div class="kpis">');
      doc.write('  <div class="kpi"><div class="lbl">' + T("Receivables (AR)") + '</div><div class="val">' + usd(ar, "USD") + '</div><div class="sub">' + arOpen.length + ' ' + T("open") + '</div></div>');
      doc.write('  <div class="kpi"><div class="lbl">' + T("Payables (AP)") + '</div><div class="val">' + usd(ap, "USD") + '</div><div class="sub">' + apOpen.length + ' ' + T("open") + '</div></div>');
      doc.write('  <div class="kpi"><div class="lbl">' + T("Net cash flow") + '</div><div class="val">' + usd(cash, "USD") + '</div><div class="sub">+' + usd(cashIn, "USD") + ' / -' + usd(cashOut, "USD") + '</div></div>');
      doc.write('  <div class="kpi"><div class="lbl">' + T("Gross profit (est.)") + '</div><div class="val">' + usd(profit, "USD") + '</div><div class="sub"></div></div>');
      doc.write('</div>');

      // Grid-3 (P&L, AR Aging, VAT Summary)
      doc.write('<div class="grid-3">');
      
      // P&L Card
      doc.write('  <div class="card">');
      doc.write('    <div class="card-h"><h3>' + T("Profit & loss (indicative)") + '</h3></div>');
      doc.write('    <div class="card-b">');
      doc.write('      <div class="pl-row"><span>' + T("Revenue (invoiced)") + '</span><strong>' + usd(revenue, "USD") + '</strong></div>');
      doc.write('      <div class="pl-row"><span>− ' + T("Purchases (supplier bills)") + '</span><span style="color:#d0112b">' + usd(-purchaseCost, "USD") + '</span></div>');
      doc.write('      <div class="pl-row"><span>− ' + T("Logistics costs") + '</span><span style="color:#d0112b">' + usd(-logisticsCost, "USD") + '</span></div>');
      doc.write('      <div class="pl-row total"><span>= ' + T("Gross profit") + '</span><strong>' + usd(profit, "USD") + '</strong></div>');
      doc.write('    </div>');
      doc.write('  </div>');

      // AR Aging Card
      const maxAge = Math.max(1, aging.current, aging.d30, aging.d60, aging.d90);
      doc.write('  <div class="card">');
      doc.write('    <div class="card-h"><h3>' + T("Receivables aging") + '</h3></div>');
      doc.write('    <div class="card-b">');
      
      const ages = [
        ["Current", aging.current, "#10b981"],
        ["1–30 " + T("days"), aging.d30, "#1aa6df"],
        ["31–60 " + T("days"), aging.d60, "#f59e0b"],
        ["60+ " + T("days"), aging.d90, "#ef4444"]
      ];
      
      ages.forEach(([k, v, color]) => {
        const pct = (v / maxAge) * 100;
        doc.write('      <div class="aging-item">');
        doc.write('        <div class="aging-label"><span>' + k + '</span><strong>' + usd(v, "USD") + '</strong></div>');
        doc.write('        <div class="aging-bar"><div class="aging-progress" style="width:' + pct + '%; background:' + color + '"></div></div>');
        doc.write('      </div>');
      });
      doc.write('    </div>');
      doc.write('  </div>');

      // VAT Summary Card
      doc.write('  <div class="card">');
      doc.write('    <div class="card-h"><h3>' + T("VAT Summary") + '</h3></div>');
      doc.write('    <div class="card-b">');
      doc.write('      <div class="pl-row"><span>' + T("Calculated VAT (Sales)") + '</span><strong>' + usd(vatSales, "USD") + '</strong></div>');
      doc.write('      <div class="pl-row"><span>− ' + T("Deductible VAT (Purchases)") + '</span><span style="color:#d0112b">' + usd(-vatPurchases, "USD") + '</span></div>');
      if (netVat >= 0) {
        doc.write('      <div class="pl-row total"><span>= ' + T("Net VAT Payable") + '</span><strong>' + usd(netVat, "USD") + '</strong></div>');
      } else {
        doc.write('      <div class="pl-row total"><span>= ' + T("Net VAT Receivable") + '</span><strong>' + usd(-netVat, "USD") + '</strong></div>');
      }
      doc.write('    </div>');
      doc.write('  </div>');
      
      doc.write('</div>');

      // Payments Ledger Title
      doc.write('<h2 class="section-h">' + T("Payments ledger") + '</h2>');

      // Payments Table
      doc.write('<table class="tbl">');
      doc.write('  <thead>');
      doc.write('    <tr><th>' + T("Reference") + '</th><th>' + T("Party") + '</th><th>' + T("Date") + '</th><th>' + T("Direction") + '</th><th>' + T("Method") + '</th><th class="right">' + T("Amount") + '</th></tr>');
      doc.write('  </thead>');
      doc.write('  <tbody>');
      
      const sortedPayments = payments.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
      sortedPayments.forEach((p) => {
        const dirHtml = p.kind === "in" ? '<span class="st green">' + T("Cash in") + '</span>' : '<span class="st amber">' + T("Cash out") + '</span>';
        const amtSign = p.kind === "in" ? "+" : "−";
        doc.write('    <tr>');
        doc.write('      <td class="mono">' + esc(p.ref) + '</td>');
        doc.write('      <td>' + esc(p.party) + '</td>');
        doc.write('      <td>' + date(p.date) + '</td>');
        doc.write('      <td>' + dirHtml + '</td>');
        doc.write('      <td>' + esc(p.method) + '</td>');
        doc.write('      <td class="right" style="font-weight:700;' + (p.kind === "in" ? "color:#15803d" : "color:#b45309") + '">' + amtSign + money(p.amount, p.currency) + '</td>');
        doc.write('    </tr>');
      });
      
      doc.write('  </tbody>');
      doc.write('</table>');

      // Footer
      doc.write('<div class="footer">');
      doc.write('  ' + esc(B.company) + ' · © ' + new Date().getFullYear() + ' ' + esc(B.company) + (B.tagline ? ' · ' + esc(B.tagline) : '') + '<br>');
      doc.write('  ' + T("Confidential financial report generated for authorized console users only.") + '<br>');
      doc.write('</div>');

      doc.write('<script>window.onload = function() { window.print(); setTimeout(function() { window.frameElement.remove(); }, 150); };</script>');
      doc.write('</body></html>');
      
      doc.close();
    }

    function generateExcel() {
      let csv = "\uFEFF"; // UTF-8 BOM
      
      const dateStr = dateTime(new Date());
      
      // Title
      csv += '"' + T("COMPANY FINANCIAL STATEMENT") + '"\n';
      csv += '"' + T("Generated Date") + '","' + dateStr + '"\n\n';
      
      // Executive Summary
      csv += '"' + T("EXECUTIVE SUMMARY") + '"\n';
      csv += '"' + T("Metric") + '","' + T("Value (USD)") + '","' + T("Details") + '"\n';
      csv += '"' + T("Receivables (AR)") + '",' + ar.toFixed(2) + ',"' + arOpen.length + ' ' + T("open") + '"\n';
      csv += '"' + T("Payables (AP)") + '",' + ap.toFixed(2) + ',"' + apOpen.length + ' ' + T("open") + '"\n';
      csv += '"' + T("Net cash flow") + '",' + cash.toFixed(2) + ',"+' + cashIn.toFixed(2) + ' / -' + cashOut.toFixed(2) + '"\n';
      csv += '"' + T("Gross profit (est.)") + '",' + profit.toFixed(2) + ',""\n\n';
      
      // P&L
      csv += '"' + T("PROFIT & LOSS (INDICATIVE)") + '"\n';
      csv += '"' + T("Category") + '","' + T("Amount (USD)") + '"\n';
      csv += '"' + T("Revenue (invoiced)") + '",' + revenue.toFixed(2) + '\n';
      csv += '"− ' + T("Purchases (supplier bills)") + '",-' + purchaseCost.toFixed(2) + '\n';
      csv += '"− ' + T("Logistics costs") + '",-' + logisticsCost.toFixed(2) + '\n';
      csv += '"= ' + T("Gross profit") + '",' + profit.toFixed(2) + '\n\n';
      
      // VAT Summary
      csv += '"' + T("VAT SUMMARY") + '"\n';
      csv += '"' + T("Category") + '","' + T("Amount (USD)") + '"\n';
      csv += '"' + T("Calculated VAT (Sales)") + '",' + vatSales.toFixed(2) + '\n';
      csv += '"− ' + T("Deductible VAT (Purchases)") + '",-' + vatPurchases.toFixed(2) + '\n';
      if (netVat >= 0) {
        csv += '"= ' + T("Net VAT Payable") + '",' + netVat.toFixed(2) + '\n\n';
      } else {
        csv += '"= ' + T("Net VAT Receivable") + '",' + (-netVat).toFixed(2) + '\n\n';
      }

      // Receivables Aging
      csv += '"' + T("RECEIVABLES AGING") + '"\n';
      csv += '"' + T("Period") + '","' + T("Amount (USD)") + '"\n';
      csv += '"Current",' + aging.current.toFixed(2) + '\n';
      csv += '"1-30 ' + T("days") + '",' + aging.d30.toFixed(2) + '\n';
      csv += '"31-60 ' + T("days") + '",' + aging.d60.toFixed(2) + '\n';
      csv += '"60+ ' + T("days") + '",' + aging.d90.toFixed(2) + '\n\n';
      
      // Payments Ledger
      csv += '"' + T("PAYMENTS LEDGER") + '"\n';
      csv += '"' + T("Reference") + '","' + T("Party") + '","' + T("Date") + '","' + T("Direction") + '","' + T("Method") + '","' + T("Amount") + '","' + T("Currency") + '","' + T("Amount (USD Equivalent)") + '"\n';
      
      const sortedPayments = payments.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
      sortedPayments.forEach((p) => {
        const usdVal = toUSD(p.amount, p.currency);
        csv += '"' + p.ref.replace(/"/g, '""') + '","' + p.party.replace(/"/g, '""') + '","' + date(p.date) + '","' + (p.kind === "in" ? T("Cash in") : T("Cash out")) + '","' + p.method.replace(/"/g, '""') + '",' + p.amount + ',"' + p.currency + '",' + (p.kind === "in" ? usdVal : -usdVal).toFixed(2) + '\n';
      });

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", "Company_Statement_" + new Date().toISOString().slice(0, 10) + ".csv");
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    const ai = document.getElementById("aiBtn");
    if (ai) ai.addEventListener("click", () => aiAccountant(invoices, cmap));

    const exportPdfBtn = document.getElementById("exportPdfBtn");
    if (exportPdfBtn) exportPdfBtn.addEventListener("click", generatePDF);

    const exportExcelBtn = document.getElementById("exportExcelBtn");
    if (exportExcelBtn) exportExcelBtn.addEventListener("click", generateExcel);
  }

  async function track(el) {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const shipId = params.get("id");
    
    // We fetch the list of shipments
    const [list, clients, products] = await Promise.all([Store.list("shipments"), Store.list("clients"), Store.list("products")]);
    const s = list.find((x) => x.id === shipId || x.ref === shipId);
    
    if (!s) {
      el.innerHTML = 
        '<div style="max-width:500px; margin: 80px auto; text-align:center; padding:30px; background:var(--surface); border: 1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--sh-sm);">' +
          '<div style="color:var(--red); font-size:3rem; margin-bottom:16px; display:flex; align-items:center; justify-content:center;">' + icon("alert") + '</div>' +
          '<h2 style="font-size:1.5rem; font-weight:700;">' + UI.t("Shipment Not Found") + '</h2>' +
          '<p class="muted" style="margin-top:8px; font-size:0.9rem;">' + UI.t("The shipment reference or ID is invalid or has been removed.") + '</p>' +
          '<a href="/public/login" class="btn btn-primary" style="margin-top:20px; display:inline-block; text-decoration:none;">' + UI.t("Go to Console") + '</a>' +
        '</div>';
      return;
    }
    
    const client = clients.find((c) => c.id === s.client) || {};
    const trackHistory = (s.tracking || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const dotFor = (st) => SH_ST[st] || "slate";
    
    const timeline = trackHistory.length
      ? '<div class="timeline" style="margin-top:20px">' + trackHistory.map((t) =>
          '<div class="tl-item"><div class="tl-dot ' + dotFor(t.status) + '"></div>' +
          '<div class="tl-h"><b>' + esc(tr(t.status)) + "</b> — " + esc(t.location || "") + "</div>" +
          (t.note ? '<div style="font-size:.85rem;color:var(--ink-2);margin-top:2px">' + esc(t.note) + "</div>" : "") +
          '<div class="tl-m"><span>' + icon("users") + " " + esc(t.by || "—") + "</span><span>" + icon("clock") + " " + dateTime(t.ts) + "</span></div></div>").join("") + "</div>"
      : '<p class="muted" style="margin:8px 0">' + UI.t("No tracking events yet.") + '</p>';

    // brand the public portal to the workspace: its uploaded logo if any, else the platform mark
    const trackBrand = window.Workspace ? Workspace.brand() : { company: "WeboCloud", logo: null };
    const defaultMark = '<svg viewBox="0 0 64 64" style="width:40px; height:40px;" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#5cb12f" d="M32 5a27 27 0 0 1 0 54 13.5 13.5 0 0 1 0-27 13.5 13.5 0 0 0 0-27z"/><path fill="#1aa6df" d="M32 59a27 27 0 0 1 0-54 13.5 13.5 0 0 1 0 27 13.5 13.5 0 0 0 0 27z"/><circle cx="32" cy="18.5" r="4.2" fill="#1aa6df"/><circle cx="32" cy="45.5" r="4.2" fill="#5cb12f"/></svg>';
    const brandLogo = trackBrand.logo ? '<img src="' + esc(trackBrand.logo) + '" alt="" style="width:40px; height:40px; object-fit:contain; border-radius:8px;">' : defaultMark;

    el.innerHTML =
      '<div style="max-width: 680px; margin: 40px auto; padding: 0 16px;">' +
        '<div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">' +
          brandLogo +
          '<div>' +
            '<div style="font-family:var(--font-head); font-weight:800; font-size:1.4rem; letter-spacing:0.02em; color:var(--ink);">' + esc(trackBrand.company) + '</div>' +
            '<div style="font-size:0.7rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em;">' + UI.t("Public Tracking Portal") + '</div>' +
          '</div>' +
        '</div>' +
        
        '<div class="card" style="margin-bottom:24px; padding:0;">' +
          '<div class="card-h" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; padding:16px 20px;">' +
            '<div>' +
              '<span class="sub" style="text-transform:uppercase; font-size:0.75rem; font-weight:600; letter-spacing:0.05em;">' + UI.t("Shipment Reference") + '</span>' +
              '<h3 style="font-size:1.4rem; font-family:monospace; margin-top:4px; font-weight:700;">' + esc(s.ref) + '</h3>' +
            '</div>' +
            badge(s.status, SH_ST) +
          '</div>' +
          '<div class="card-b" style="padding: 24px;">' +
            '<div class="dgrid" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:20px;">' +
              '<div class="dfield"><div class="k">' + UI.t("Client") + '</div><div class="v">' + esc(client.name || "—") + '</div></div>' +
              '<div class="dfield"><div class="k">' + UI.t("Transport Mode") + '</div><div class="v"><span class="tag">' + esc(tr(s.mode)) + '</span></div></div>' +
              '<div class="dfield"><div class="k">' + UI.t("Route") + '</div><div class="v">' + icon("pin") + " " + esc(s.origin) + ' &rarr; ' + esc(s.destination) + '</div></div>' +
              '<div class="dfield"><div class="k">' + UI.t("Cargo Load") + '</div><div class="v">' + s.containers + ' ' + UI.t(s.containers > 1 ? "containers" : "container") + ' · ' + s.weightTons + 't</div></div>' +
              '<div class="dfield"><div class="k">' + UI.t("Departed") + '</div><div class="v">' + date(s.departed) + '</div></div>' +
              '<div class="dfield"><div class="k">' + UI.t("ETA") + '</div><div class="v" style="font-weight:600; color:var(--accent-600);">' + date(s.eta) + '</div></div>' +
            '</div>' +
            (() => {
              let items = s.items && s.items.length ? s.items : [];
              let itemsHtml = "";
              if (items.length === 0 && s.orderId) {
                try {
                  const orders = JSON.parse(localStorage.getItem("sap_" + (localStorage.getItem("sap_active_ws") || "") + "_orders")) || [];
                  const ord = orders.find(o => o.id === s.orderId);
                  if (ord && ord.items) items = ord.items;
                } catch(e) {}
              }
              if (items && items.length) {
                const rows = items.map(it => {
                  const p = products.find(x => x.id === it.product);
                  return '<tr>' +
                    '<td style="padding:8px 0; border-bottom:1px solid var(--line); font-size:0.86rem; color:var(--ink);">' + esc(p ? p.name : it.product) + '</td>' +
                    '<td style="padding:8px 0; border-bottom:1px solid var(--line); font-size:0.86rem; color:var(--ink); text-align:right; font-weight:700;">' + it.qty + '</td>' +
                    '</tr>';
                }).join("");
                itemsHtml = 
                  '<div style="margin-top:20px; border-top:1px solid var(--line); padding-top:16px;">' +
                    '<div style="font-size:0.75rem; font-weight:600; text-transform:uppercase; color:var(--muted); letter-spacing:0.05em; margin-bottom:8px;">' + UI.t("Shipped Items") + '</div>' +
                    '<table style="width:100%; border-collapse:collapse;">' +
                      '<thead><tr>' +
                        '<th style="text-align:left; font-size:0.75rem; color:var(--muted); padding-bottom:6px; font-weight:500;">' + UI.t("Product") + '</th>' +
                        '<th style="text-align:right; font-size:0.75rem; color:var(--muted); padding-bottom:6px; font-weight:500;">' + UI.t("Qty") + '</th>' +
                      '</tr></thead>' +
                      '<tbody>' + rows + '</tbody>' +
                    '</table>' +
                  '</div>';
              }
              return itemsHtml;
            })() +
          '</div>' +
        '</div>' +
        
        '<div class="card" style="padding:0;">' +
          '<div class="card-h" style="padding:16px 20px;">' +
            '<h3 style="display:flex; align-items:center; gap:8px;">' + icon("history") + ' ' + UI.t("Real-Time Tracking Status") + '</h3>' +
          '</div>' +
          '<div class="card-b" style="padding: 24px;">' +
            timeline +
          '</div>' +
        '</div>' +
        
        '<div style="text-align:center; margin-top:40px; font-size:0.8rem; color:var(--muted);">' +
          '© ' + new Date().getFullYear() + ' ' + esc(trackBrand.company) + (trackBrand.tagline ? ' · ' + esc(trackBrand.tagline) : '') +
        '</div>' +
      '</div>';
  }

  async function profile(el) {
    const me = Auth.current() || {};
    const [list, audit, invoices, orders] = await Promise.all([
      Store.list("users"), Store.list("audit"),
      Store.list("invoices"), Store.list("orders")
    ]);
    const myUserObj = list.find((u) => u.id === me.id || u.email === me.email) || me;
    
    // Compute performance
    const perfResults = Perf.compute(list, audit, invoices, orders);
    const myPerf = perfResults.find((p) => p.u.name === myUserObj.name) || {
      u: myUserObj,
      activeDays: 0,
      consistencyScore: 0,
      qualityScore: 0,
      revenue: 0,
      revenueScore: 0,
      seniorityScore: 0,
      allActions: 0,
      last30Actions: 0,
      perfScore: 0,
      percentile: 0,
      raiseRange: { label: "No Data", color: "var(--muted)" },
      trend: "flat"
    };

    // Filter audit logs for the current user
    const myAudit = audit.filter((a) => a.actor === myUserObj.name).slice(0, 50);

    // Render profile card
    const brandMark = '<div class="avatar" style="width:70px; height:70px; font-size:1.6rem; margin-bottom:12px; margin-left:auto; margin-right:auto;">' + UI.initials(myUserObj.name) + '</div>';
    
    const rolePill = '<span class="role-pill ' + (myUserObj.role === "Owner" ? "owner" : "emp") + '">' + esc(T(myUserObj.role)) + '</span>';
    
    const profileInfo = 
      '<div class="card" style="margin-bottom:18px;">' +
        '<div class="card-b" style="display:flex; flex-direction:column; align-items:center; text-align:center; padding:24px 16px;">' +
          brandMark +
          '<h3 style="font-size:1.3rem; font-weight:700; margin:6px 0 4px;">' + esc(myUserObj.name) + '</h3>' +
          '<div style="margin-bottom:16px;">' + rolePill + '</div>' +
          '<div style="width:100%; border-top:1px solid var(--line); padding-top:16px; text-align:left;">' +
            '<div class="dfield"><div class="k">' + T("Email") + '</div><div class="v">' + esc(myUserObj.email) + '</div></div>' +
            '<div class="dfield"><div class="k">' + T("Department") + '</div><div class="v">' + esc(myUserObj.dept || T("General")) + '</div></div>' +
            '<div class="dfield"><div class="k">' + T("Joined") + '</div><div class="v">' + (myUserObj.joined ? date(myUserObj.joined) : "—") + '</div></div>' +
          '</div>' +
        '</div>' +
      '</div>';
      
    // Render performance metrics
    const rr = myPerf.raiseRange || { label: "Needs Review", color: "#e53e3e" };
    
    const bar = (label, val, color) =>
      '<div style="margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:4px;">' +
          '<span style="color:var(--ink-2);">' + label + '</span>' +
          '<span style="font-weight:700;">' + Math.round(val) + ' / 100</span>' +
        '</div>' +
        '<div style="height:8px;border-radius:99px;background:var(--surface-2);overflow:hidden;">' +
          '<div style="height:100%;width:' + Math.round(val) + '%;background:' + color + ';border-radius:99px;transition:width .6s ease;"></div>' +
        '</div>' +
      '</div>';

    const perfCard = 
      '<div class="card" style="margin-bottom:18px;">' +
        '<div class="card-h"><h3>' + T("Performance Metrics") + '</h3></div>' +
        '<div class="card-b">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">' +
            '<div class="card" style="padding:14px;text-align:center;background:var(--surface-2);border:none;">' +
              '<div style="font-size:2rem;font-weight:800;color:' + rr.color + ';">' + myPerf.perfScore + '</div>' +
              '<div style="font-size:.75rem;color:var(--muted);text-transform:uppercase;font-weight:600;">PERF Score</div>' +
            '</div>' +
            '<div class="card" style="padding:14px;text-align:center;background:var(--surface-2);border:none;">' +
              '<div style="font-size:2rem;font-weight:800;color:var(--ink);">' + myPerf.percentile + '%ile</div>' +
              '<div style="font-size:.75rem;color:var(--muted);text-transform:uppercase;font-weight:600;">' + T("Team rank") + '</div>' +
            '</div>' +
          '</div>' +
          
          '<div style="background:' + rr.color + '18;border:1px solid ' + rr.color + '44;border-radius:var(--r);padding:12px 16px;margin-bottom:16px;text-align:center;">' +
            '<div style="font-size:.72rem;font-weight:700;color:' + rr.color + ';text-transform:uppercase;letter-spacing:.06em;">' + T("AI Raise Recommendation") + '</div>' +
            '<div style="font-size:1.3rem;font-weight:800;color:' + rr.color + ';margin:4px 0;">' + (rr.low > 0 ? "+" + rr.low + "–" + rr.high + "%" : T("Performance Improvement Plan")) + '</div>' +
            '<div style="font-size:.78rem;color:var(--ink-2);">' + T(rr.label) + '</div>' +
          '</div>' +
          
          bar(T("Quality (role-fit)"),    myPerf.qualityScore,     "#1aa6df") +
          bar(T("Revenue impact"),        myPerf.revenueScore,     "#1f9d6b") +
          bar(T("Consistency (30 days)"), myPerf.consistencyScore, "#7a4fb0") +
          bar(T("Seniority"),             myPerf.seniorityScore,   "#d97706") +
          
          '<div style="background:var(--surface-2);border-radius:var(--r);padding:12px 16px;margin-top:12px;">' +
            '<div style="display:flex;justify-content:space-between;font-size:.82rem;">' +
              '<span>' + T("Active days (30d)") + '</span><b>' + myPerf.activeDays + ' / 30</b>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-top:6px;">' +
              '<span>' + T("Actions (30d)") + '</span><b>' + myPerf.last30Actions + '</b>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-top:6px;">' +
              '<span>' + T("All-time actions") + '</span><b>' + myPerf.allActions + '</b>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-top:6px;">' +
              '<span>' + T("Trend") + '</span><b style="color:' + (myPerf.trend==="up"?"var(--green)":myPerf.trend==="down"?"var(--red)":"var(--muted)") + ';">' + (myPerf.trend === "up" ? "↑ " + T("Improving") : myPerf.trend === "down" ? "↓ " + T("Declining") : "→ " + T("Stable")) + '</b>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Render Salary Details & Raise History
    const salary = myUserObj.salary || 0;
    const currency = myUserObj.currency || "USD";
    const logs = (myUserObj.raiseLogs || []).slice().reverse();
    const logRows = logs.length
      ? logs.map(l =>
          '<tr><td>' + date(l.date) + '</td><td style="color:var(--green);font-weight:700;">+' + l.pct + '%</td><td>' + esc(l.note || "—") + '</td></tr>'
        ).join("")
      : '<tr><td colspan="3" style="color:var(--muted);text-align:center;">' + T("No raise history yet") + '</td></tr>';

    const salaryCard = 
      '<div class="card" style="margin-bottom:18px;">' +
        '<div class="card-h"><h3>' + T("Compensation & Raises") + '</h3></div>' +
        '<div class="card-b">' +
          '<div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface-2); padding:16px; border-radius:var(--r); margin-bottom:16px;">' +
            '<div>' +
              '<span style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; font-weight:600;">' + T("Current salary") + '</span>' +
              '<h4 style="font-size:1.4rem; font-weight:800; color:var(--navy-700); margin:4px 0 0;">' + money(salary, currency) + ' <span style="font-size:0.85rem; font-weight:500; color:var(--muted);">/ ' + T("month") + '</span></h4>' +
            '</div>' +
            icon("wallet", "text-muted") +
          '</div>' +
          '<h4 style="font-size:.82rem;font-weight:700;margin:12px 0 8px;color:var(--ink-2);">' + T("Raise history") + '</h4>' +
          '<div class="tbl-wrap" style="max-height:160px;overflow-y:auto;border:1px solid var(--line);">' +
            '<table class="tbl"><thead><tr><th>' + T("Date") + '</th><th>' + T("Raise") + '</th><th>' + T("Note") + '</th></tr></thead>' +
            '<tbody>' + logRows + '</tbody></table>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Render personal activity timeline
    let timelineHtml = '<p class="muted" style="text-align:center; padding:20px;">' + T("No activity logged yet.") + '</p>';
    if (myAudit.length) {
      timelineHtml = '<div class="timeline">';
      let lastDay = "";
      myAudit.forEach((a) => {
        const day = date(a.ts);
        if (day !== lastDay) { 
          timelineHtml += '<div class="sb-group" style="color:var(--muted);padding:14px 0 8px;letter-spacing:.08em;font-size:0.8rem;border-bottom:1px solid var(--line);margin-bottom:8px;">' + day + "</div>"; 
          lastDay = day; 
        }
        const dotClass = a.action === "create" ? "green" : a.action === "delete" ? "red" : a.action === "login" || a.action === "logout" ? "purple" : a.action === "update" ? "amber" : "";
        timelineHtml += 
          '<div class="tl-item" style="padding-bottom:14px;">' +
            '<div class="tl-dot ' + dotClass + '"></div>' +
            '<div class="tl-h" style="font-size:0.85rem;"><b>' + esc(a.summary) + '</b></div>' +
            '<div class="tl-m" style="font-size:0.75rem;"><span class="tag" style="text-transform:capitalize">' + esc(tr(a.action)) + ' · ' + esc(tr(a.entity)) + '</span>' +
            '<span>' + icon("clock") + ' ' + dateTime(a.ts).split(" ")[1] + '</span></div>' +
          '</div>';
      });
      timelineHtml += '</div>';
    }

    const activityCard = 
      '<div class="card">' +
        '<div class="card-h"><h3>' + T("My Recent Activity") + '</h3></div>' +
        '<div class="card-b" style="max-height: 800px; overflow-y: auto;">' +
          timelineHtml +
        '</div>' +
      '</div>';

    el.innerHTML = 
      '<div class="section-title">' +
        '<div>' +
          '<h2>' + T("My Profile") + '</h2>' +
          '<p>' + T("Personal account summary, performance scores, and logs") + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div>' + profileInfo + perfCard + salaryCard + '</div>' +
        '<div>' + activityCard + '</div>' +
      '</div>';
  }

  /* =============================================================
     MY WORK — the personal queue / workflow inbox
     ============================================================= */
  async function mywork(el) {
    const u = Auth.current() || {};
    const first = (u.name || "").split(" ")[0];
    const hr = new Date().getHours();
    const greet = hr < 12 ? T("Good morning") : hr < 18 ? T("Good afternoon") : T("Good evening");
    const w = await Workflow.myWork(u);

    const statCard = (n, label, cls) =>
      '<div class="mw-stat ' + cls + '"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>';

    function row(it) {
      return '<div class="mw-item ' + it.tone + '">' +
        '<div class="mw-ic">' + icon(it.icon) + '</div>' +
        '<div class="mw-tx"><div class="mw-t">' + esc(it.title) + '</div>' +
          (it.sub ? '<div class="mw-s">' + esc(it.sub) + (it.from ? ' · ' + esc(it.from) : "") + '</div>' : "") +
        '</div>' +
        '<button class="btn btn-ghost btn-sm mw-act" data-link="' + esc(it.link) + '" data-notif="' + esc(it.notifId || "") + '">' + esc(it.action) + '</button>' +
        '</div>';
    }
    function bucket(label, cls, items, emptyMsg) {
      return '<div class="mw-bucket">' +
        '<div class="mw-head ' + cls + '">' + esc(label) + ' <span class="mw-count">' + items.length + '</span></div>' +
        (items.length ? items.map(row).join("") :
          '<div class="mw-empty">' + icon("check") + " " + esc(emptyMsg) + '</div>') +
        '</div>';
    }

    el.innerHTML =
      '<div class="mw-wrap">' +
        '<div class="mw-greet"><h2>' + esc(greet) + ', ' + esc(first) + '</h2>' +
          '<p class="muted">' + T("Here is what needs you today.") + '</p></div>' +
        '<div class="mw-stats">' +
          statCard(w.urgent.length, T("Overdue / urgent"), "red") +
          statCard(w.waiting.length, T("Waiting on you"), "blue") +
          statCard(w.heads.length, T("Heads-up"), "slate") +
        '</div>' +
        bucket(T("Overdue / urgent"), "red", w.urgent, T("Nothing urgent — you're on top of it.")) +
        bucket(T("Waiting on you"), "blue", w.waiting, T("No open handoffs. Nice and clear.")) +
        bucket(T("Heads-up"), "slate", w.heads, T("No new updates.")) +
      '</div>';

    el.querySelectorAll(".mw-act").forEach((b) => b.addEventListener("click", async () => {
      const notif = b.dataset.notif;
      if (notif) { await Workflow.markRead(notif); if (window.App && App.refreshChrome) App.refreshChrome(); }
      const link = b.dataset.link || "#/dashboard";
      if (link === "#/mywork") { App.reload(); } else { location.hash = link; }
    }));
  }

  /* =============================================================
     PAYROLL — salaries, pay runs & payslips
     ============================================================= */
  function getActiveCountry() {
    if (window.Workspace && Workspace.active) {
      const active = Workspace.active();
      if (active && active.country && window.COUNTRIES) {
        const c = COUNTRIES.find((x) => x.code === active.country || x.name === active.country);
        if (c) return c;
      }
    }
    return { vat: 20, tax: 15, social: 14 }; // Default Turkey fallback
  }
  function payslipFor(salary) {
    const c = getActiveCountry();
    const TAX_RATE = c.tax / 100;
    const SGK_RATE = c.social / 100;
    const gross = Number(salary || 0);
    const tax = Math.round(gross * TAX_RATE);
    const sgk = Math.round(gross * SGK_RATE);
    return { gross, tax, sgk, net: gross - tax - sgk };
  }
  function periodLabel(d) {
    return (d || new Date()).toLocaleDateString(UI.getLang() === "tr" ? "tr-TR" : "en-US", { month: "long", year: "numeric" });
  }
  function pkpi(label, value, sub, color) {
    return '<div class="card" style="padding:16px 18px;">' +
      '<div style="font-size:.73rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;">' + esc(label) + '</div>' +
      '<div style="font-family:var(--font-head);font-weight:800;font-size:1.5rem;color:' + (color || "var(--navy-800)") + ';margin-top:4px;">' + value + '</div>' +
      (sub ? '<div style="font-size:.76rem;color:var(--muted);margin-top:2px;">' + esc(sub) + '</div>' : '') + '</div>';
  }

  async function payroll(el) {
    const [users, payruns] = await Promise.all([Store.list("users"), Store.list("payruns")]);
    const staff = users.filter((u) => u.active !== false);
    const canRun = Auth.can("payroll", "edit");
    const period = periodLabel();

    const lines = staff.map((u) => Object.assign(
      { id: u.id, name: u.name, role: u.role, dept: u.dept }, payslipFor(u.salary)));
    const tGross = lines.reduce((a, l) => a + l.gross, 0);
    const tNet = lines.reduce((a, l) => a + l.net, 0);
    const tDed = tGross - tNet;
    const withSalary = lines.filter((l) => l.gross > 0).length;

    const salaryRows = lines.length
      ? lines.map((l) =>
          '<tr data-row>' +
            '<td>' + avatar(l.name, l.role) + '</td>' +
            '<td>' + esc(l.dept || "—") + '</td>' +
            '<td>' + money(l.gross, "USD") + '</td>' +
            '<td style="color:var(--red)">−' + money(l.tax, "USD") + '</td>' +
            '<td style="color:var(--red)">−' + money(l.sgk, "USD") + '</td>' +
            '<td><b>' + money(l.net, "USD") + '</b></td>' +
          '</tr>').join("")
      : emptyRow(6, UI.t("Add employees and set their salaries in Team & Accounts."));

    const histRows = payruns.length
      ? payruns.map((r) =>
          '<tr data-run="' + esc(r.id) + '" style="cursor:pointer">' +
            '<td><b>' + esc(r.period) + '</b></td>' +
            '<td>' + (r.lines ? r.lines.length : 0) + '</td>' +
            '<td>' + money(r.gross, "USD") + '</td>' +
            '<td>' + money(r.net, "USD") + '</td>' +
            '<td><span class="st ' + (r.status === "Paid" ? "green" : "amber") + '">' + esc(UI.t(r.status || "Draft")) + '</span></td>' +
            '<td>' + date(r.date) + '</td>' +
          '</tr>').join("")
      : emptyRow(6, UI.t("No pay runs yet. Run payroll to generate the first one."));

    el.innerHTML =
      indTitle("payroll", "Payroll", "Salaries, pay runs & payslips") +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:14px;margin-bottom:22px;">' +
        pkpi(UI.t("Monthly gross"), money(tGross, "USD"), period, "var(--navy-800)") +
        pkpi(UI.t("Net payout"), money(tNet, "USD"), UI.t("After tax & SGK"), "var(--green)") +
        pkpi(UI.t("Deductions"), money(tDed, "USD"), "Tax " + getActiveCountry().tax + "% · Social " + getActiveCountry().social + "%", "var(--red)") +
        pkpi(UI.t("On payroll"), withSalary + " / " + staff.length, UI.t("employees"), "var(--accent)") +
      '</div>' +
      toolbar("payrollSearch", "", canRun ? ("Run payroll · " + period) : "", "payRun", "payroll") +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>' + UI.t("Employee") + '</th><th>' + UI.t("Department") + '</th><th>' + UI.t("Gross") + '</th><th>' + UI.t("Income tax") + '</th><th>' + UI.t("SGK") + '</th><th>' + UI.t("Net pay") + '</th>' +
      '</tr></thead><tbody>' + salaryRows + '</tbody></table></div>' +
      '<h3 style="margin:26px 0 12px;font-size:1rem;font-weight:700;color:var(--navy-700);">' + icon("history") + ' ' + UI.t("Recent payroll runs") + '</h3>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>' + UI.t("Period") + '</th><th>' + UI.t("Employees") + '</th><th>' + UI.t("Gross") + '</th><th>' + UI.t("Net") + '</th><th>' + UI.t("Status") + '</th><th>' + UI.t("Run date") + '</th>' +
      '</tr></thead><tbody>' + histRows + '</tbody></table></div>' +
      (() => {
        const c = getActiveCountry();
        return '<p class="hint" style="margin-top:14px">' + icon("wallet") + ' ' + UI.t("Net pay = gross − income tax (" + c.tax + "%) − social security (" + c.social + "%). Set each salary from Team & Accounts.") + '</p>';
      })();

    liveSearch("payrollSearch");

    const runBtn = document.getElementById("payRun");
    if (runBtn) runBtn.addEventListener("click", async () => {
      if (!lines.length) return toast(UI.t("No employees to pay"), "err");
      const rec = {
        period: period, date: new Date().toISOString().slice(0, 10), status: "Paid",
        gross: tGross, net: tNet, deductions: tDed,
        lines: lines.map((l) => ({ id: l.id, name: l.name, role: l.role, gross: l.gross, tax: l.tax, sgk: l.sgk, net: l.net }))
      };
      const exists = payruns.find((r) => r.period === period);
      if (exists) {
        await Store.update("payruns", exists.id, rec);
        Store.logAction("update", "payrun", exists.id, "Re-ran payroll for " + period + " — " + money(tNet, "USD") + " net");
        toast(UI.t("Payroll re-run") + " · " + money(tNet, "USD"));
      } else {
        const r = await Store.create("payruns", rec);
        Store.logAction("create", "payrun", r.id, "Ran payroll for " + period + " — " + lines.length + " employees, " + money(tNet, "USD") + " net");
        toast(UI.t("Payroll run complete") + " · " + money(tNet, "USD"));
      }
      App.reload();
    });

    el.querySelectorAll("tr[data-run]").forEach((row) => {
      row.addEventListener("click", () => {
        const r = payruns.find((x) => x.id === row.dataset.run);
        if (r) payslipModal(r);
      });
    });
  }

  function payslipModal(r) {
    const rows = (r.lines || []).map((l) =>
      '<tr><td>' + esc(l.name) + '</td><td>' + esc(tr(l.role || "")) + '</td><td>' + money(l.gross, "USD") + '</td>' +
      '<td style="color:var(--red)">−' + money(l.tax, "USD") + '</td><td style="color:var(--red)">−' + money(l.sgk, "USD") + '</td>' +
      '<td><b>' + money(l.net, "USD") + '</b></td></tr>').join("");
    modal({
      title: UI.t("Payslips") + " · " + r.period, wide: true,
      body:
        '<div style="display:flex;gap:22px;margin-bottom:14px;flex-wrap:wrap;">' +
          '<div><div class="muted" style="font-size:.74rem">' + UI.t("Gross") + '</div><div style="font-weight:800;font-size:1.2rem">' + money(r.gross, "USD") + '</div></div>' +
          '<div><div class="muted" style="font-size:.74rem">' + UI.t("Deductions") + '</div><div style="font-weight:800;font-size:1.2rem;color:var(--red)">−' + money(r.deductions, "USD") + '</div></div>' +
          '<div><div class="muted" style="font-size:.74rem">' + UI.t("Net") + '</div><div style="font-weight:800;font-size:1.2rem;color:var(--green)">' + money(r.net, "USD") + '</div></div>' +
        '</div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>' + UI.t("Employee") + '</th><th>' + UI.t("Role") + '</th><th>' + UI.t("Gross") + '</th><th>' + UI.t("Tax") + '</th><th>' + UI.t("SGK") + '</th><th>' + UI.t("Net") + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>',
      footer: '<button class="btn btn-primary" onclick="UI.closeModal()">' + UI.t("Close") + '</button>'
    });
  }

  /* =============================================================
     ATTENDANCE — clock-in & daily attendance (separate system)
     ============================================================= */
  const ATT_ST = { "Present": "green", "Late": "amber", "Absent": "red", "Leave": "purple", "Remote": "blue" };
  const WORK_START = 9 * 60 + 30; // 09:30 grace before "Late"
  function nowHM() { const d = new Date(); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function hmToMin(s) { if (!s) return null; const p = String(s).split(":"); return (+p[0]) * 60 + (+p[1] || 0); }
  function hoursBetween(a, b) { const x = hmToMin(a), y = hmToMin(b); if (x == null || y == null) return 0; return Math.max(0, +(((y - x) / 60).toFixed(1))); }

  async function attendance(el) {
    const [users, records] = await Promise.all([Store.list("users"), Store.list("attendance")]);
    const me = Auth.current() || {};
    const today = new Date().toISOString().slice(0, 10);
    const staff = users.filter((u) => u.active !== false);
    const todays = records.filter((a) => a.date === today);
    const byUser = {}; todays.forEach((a) => { byUser[a.userId] = a; });
    const canManage = Auth.isOwner() || me.role === "HR Manager";

    const present = todays.filter((a) => a.status === "Present").length;
    const late = todays.filter((a) => a.status === "Late").length;
    const leave = todays.filter((a) => a.status === "Leave").length;
    const checkedIn = todays.filter((a) => ["Present", "Late", "Remote"].includes(a.status)).length;
    const absent = Math.max(0, staff.length - checkedIn - leave);

    const mine = byUser[me.id];
    const clockState = !mine ? "in" : (mine.checkOut ? "done" : "out");
    const clockCard =
      '<div class="card" style="padding:18px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:22px;">' +
        '<div style="width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:' + avColor(me.name || "?") + ';color:#fff;font-weight:700;flex:0 0 auto;">' + initials(me.name || "?") + '</div>' +
        '<div style="flex:1;min-width:150px;">' +
          '<div style="font-weight:700;color:var(--navy-800);">' + esc(me.name || "You") + '</div>' +
          '<div style="font-size:.82rem;color:var(--muted);">' +
            (mine ? (UI.t("Checked in") + " " + esc(mine.checkIn || "—") + (mine.checkOut ? " · " + UI.t("out") + " " + esc(mine.checkOut) : "")) : UI.t("Not checked in yet")) +
          '</div>' +
        '</div>' +
        (mine ? '<span class="st ' + (ATT_ST[mine.status] || "slate") + '">' + esc(UI.t(mine.status)) + '</span>' : '') +
        (clockState === "in" ? '<button class="btn btn-primary" id="clockIn">' + icon("clock") + ' ' + UI.t("Check in") + '</button>' : '') +
        (clockState === "out" ? '<button class="btn btn-dark" id="clockOut">' + icon("clock") + ' ' + UI.t("Check out") + '</button>' : '') +
        (clockState === "done" ? '<span class="st green">' + UI.t("Day complete") + ' · ' + (mine.hours || 0) + 'h</span>' : '') +
      '</div>';

    const akpi = (label, value, color) =>
      '<div class="card" style="padding:14px 16px;text-align:center;">' +
        '<div style="font-family:var(--font-head);font-weight:800;font-size:1.7rem;color:' + color + ';">' + value + '</div>' +
        '<div style="font-size:.73rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600;">' + esc(label) + '</div>' +
      '</div>';

    const rosterRows = staff.map((u) => {
      const a = byUser[u.id];
      const st = a ? a.status : "Absent";
      return '<tr data-row data-uid="' + esc(u.id) + '">' +
        '<td>' + avatar(u.name, u.role) + '</td>' +
        '<td><span class="st ' + (ATT_ST[st] || "red") + '">' + esc(UI.t(st)) + '</span></td>' +
        '<td>' + esc(a && a.checkIn ? a.checkIn : "—") + '</td>' +
        '<td>' + esc(a && a.checkOut ? a.checkOut : "—") + '</td>' +
        '<td>' + (a && a.hours ? a.hours + "h" : "—") + '</td>' +
        '<td>' + esc(a && a.note ? a.note : "") + (canManage ? '<div class="row-actions" style="margin-top:2px"><button class="icon-btn" data-mark>' + icon("edit") + '</button></div>' : "") + '</td>' +
      '</tr>';
    }).join("");

    const recent = records.filter((a) => a.date !== today).slice(0, 30);
    const histRows = recent.length
      ? recent.map((a) =>
          '<tr><td>' + date(a.date) + '</td><td>' + esc(a.name) + '</td>' +
          '<td><span class="st ' + (ATT_ST[a.status] || "slate") + '">' + esc(UI.t(a.status)) + '</span></td>' +
          '<td>' + esc(a.checkIn || "—") + '</td><td>' + esc(a.checkOut || "—") + '</td><td>' + (a.hours ? a.hours + "h" : "—") + '</td></tr>').join("")
      : emptyRow(6, UI.t("No attendance history yet."));

    el.innerHTML =
      indTitle("attendance", "Attendance", "Clock-in & daily attendance") +
      clockCard +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:14px;margin-bottom:22px;">' +
        akpi(UI.t("Present"), present, "var(--green)") +
        akpi(UI.t("Late"), late, "var(--gold)") +
        akpi(UI.t("On leave"), leave, "#7a4fb0") +
        akpi(UI.t("Absent"), absent, "var(--red)") +
      '</div>' +
      '<div class="toolbar"><div class="search">' + icon("search") + '<input id="attSearch" placeholder="' + UI.t("Search…") + '" autocomplete="off"></div><div class="grow"></div>' +
        '<span class="muted" style="font-size:.82rem;align-self:center;">' + UI.t("Today") + ' · ' + today + '</span></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>' + UI.t("Employee") + '</th><th>' + UI.t("Status") + '</th><th>' + UI.t("Check-in") + '</th><th>' + UI.t("Check-out") + '</th><th>' + UI.t("Hours") + '</th><th>' + UI.t("Note") + '</th>' +
      '</tr></thead><tbody>' + rosterRows + '</tbody></table></div>' +
      '<h3 style="margin:26px 0 12px;font-size:1rem;font-weight:700;color:var(--navy-700);">' + icon("history") + ' ' + UI.t("Recent attendance") + '</h3>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>' + UI.t("Date") + '</th><th>' + UI.t("Employee") + '</th><th>' + UI.t("Status") + '</th><th>' + UI.t("Check-in") + '</th><th>' + UI.t("Check-out") + '</th><th>' + UI.t("Hours") + '</th>' +
      '</tr></thead><tbody>' + histRows + '</tbody></table></div>';

    liveSearch("attSearch");

    const ci = document.getElementById("clockIn");
    if (ci) ci.addEventListener("click", async () => {
      const t = nowHM();
      const status = hmToMin(t) > WORK_START ? "Late" : "Present";
      const r = await Store.create("attendance", { userId: me.id, name: me.name, date: today, status: status, checkIn: t, checkOut: "", hours: 0, note: "" });
      Store.logAction("create", "attendance", r.id, me.name + " checked in (" + status + ") at " + t);
      toast(UI.t("Checked in") + " · " + t + (status === "Late" ? " (" + UI.t("Late") + ")" : ""));
      App.reload();
    });
    const co = document.getElementById("clockOut");
    if (co) co.addEventListener("click", async () => {
      const t = nowHM();
      const hours = hoursBetween(mine.checkIn, t);
      await Store.update("attendance", mine.id, { checkOut: t, hours: hours });
      Store.logAction("update", "attendance", mine.id, me.name + " checked out at " + t + " (" + hours + "h)");
      toast(UI.t("Checked out") + " · " + hours + "h");
      App.reload();
    });

    if (canManage) el.querySelectorAll("tr[data-uid]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (!e.target.closest("[data-mark]")) return;
        const u = staff.find((x) => x.id === row.dataset.uid);
        if (u) attForm(u, byUser[u.id], today);
      });
    });
  }

  function attForm(u, a, today) {
    a = a || {};
    modal({
      title: UI.t("Mark attendance") + " · " + u.name,
      body:
        '<div class="form-row">' +
          field(UI.t("Status"), sel("status", a.status || "Present", ["Present", "Late", "Remote", "Leave", "Absent"])) +
          field(UI.t("Date"), '<input class="input" name="date" type="date" value="' + esc(a.date || today) + '">') +
        '</div>' +
        '<div class="form-row">' +
          field(UI.t("Check-in"), '<input class="input" name="checkIn" placeholder="09:00" value="' + esc(a.checkIn || "") + '">') +
          field(UI.t("Check-out"), '<input class="input" name="checkOut" placeholder="18:00" value="' + esc(a.checkOut || "") + '">') +
        '</div>' +
        field(UI.t("Note"), '<input class="input" name="note" value="' + esc(a.note || "") + '">'),
      footer: '<button class="btn btn-ghost" onclick="UI.closeModal()">' + UI.t("Cancel") + '</button><button class="btn btn-primary" data-save>' + UI.t("Save") + '</button>',
      onMount: (m) => {
        m.querySelector("[data-save]").addEventListener("click", async () => {
          const v = readForm(m);
          v.hours = hoursBetween(v.checkIn, v.checkOut);
          v.userId = u.id; v.name = u.name;
          if (a.id) {
            await Store.update("attendance", a.id, v);
            Store.logAction("update", "attendance", a.id, "Marked " + u.name + " " + v.status + " on " + v.date);
          } else {
            const r = await Store.create("attendance", v);
            Store.logAction("create", "attendance", r.id, "Marked " + u.name + " " + v.status + " on " + v.date);
          }
          toast(UI.t("Attendance saved"));
          closeModal(); App.reload();
        });
      }
    });
  }

  return { dashboard, mywork, quotes, orders, shipments, inventory, clients, suppliers, purchasing, finance, accounting, attendance, payroll, history, users, settings, track, profile, heroArt };


})();
