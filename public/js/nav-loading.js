/* =================================================================
   Shared navigation loading indicator.

   Why a shared file and not inline CSS/JS per page: this needs to be on
   every page, and this project has no build step — inlining it would mean
   maintaining the same block in a dozen HTML files, which is how the
   duplicated-and-drifted rules elsewhere in here happened.

   Visual language matches home.html's existing .bh-boot treatment (accent
   progress bar + ring spinner on the site's own tokens) so a navigation
   reads as the same product, not a second loader design.

   Exposes window.SouqiLoading.{show,hide} so a slow in-page action ("an
   event that hasn't loaded yet") can use the same indicator as navigation.
   ================================================================= */
(function () {
  "use strict";
  if (window.SouqiLoading) return; // guard against a double include

  var reduce = false;
  try { reduce = matchMedia("(prefers-reduced-motion:reduce)").matches; } catch (e) {}

  var CSS =
    '.sq-load{position:fixed;inset:0 0 auto 0;height:3px;z-index:2147483646;pointer-events:none;' +
      'opacity:0;transition:opacity .18s ease}' +
    '.sq-load.on{opacity:1}' +
    '.sq-load i{display:block;height:100%;width:0;border-radius:0 3px 3px 0;' +
      'background:linear-gradient(90deg,var(--accent,#1aa6df),#7c5cff);' +
      'box-shadow:0 0 10px color-mix(in srgb,var(--accent,#1aa6df) 60%,transparent);' +
      'transition:width .25s cubic-bezier(.16,1,.3,1)}' +
    /* The dim + spinner only appear if the navigation is actually slow —
       see the DELAY constant. A spinner that flashes on every fast click
       makes the site feel slower than doing nothing at all. */
    '.sq-load-veil{position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;' +
      'background:color-mix(in srgb,var(--paper,#faf7f2) 72%,transparent);' +
      '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);' +
      'opacity:0;pointer-events:none;transition:opacity .2s ease}' +
    '.sq-load-veil.on{opacity:1;pointer-events:auto}' +
    '.sq-load-veil s{width:26px;height:26px;border-radius:50%;text-decoration:none;' +
      'border:2.5px solid var(--line,#e7e1d7);border-top-color:var(--accent,#1aa6df);' +
      'animation:sqSpin .7s linear infinite}' +
    '@keyframes sqSpin{to{transform:rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){.sq-load-veil s{animation:none}' +
      '.sq-load i{transition:none}}';

  var style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  var bar, barFill, veil, creep, veilTimer, active = false;
  var DELAY = 320; // ms before the veil joins the bar

  function build() {
    if (bar) return;
    bar = document.createElement("div");
    bar.className = "sq-load";
    barFill = document.createElement("i");
    bar.appendChild(barFill);
    veil = document.createElement("div");
    veil.className = "sq-load-veil";
    veil.innerHTML = "<s></s>";
    document.body.appendChild(bar);
    document.body.appendChild(veil);
  }

  function show() {
    build();
    if (active) return;
    active = true;
    var pct = 8;
    barFill.style.width = pct + "%";
    bar.classList.add("on");
    // Creep toward 90% and stop — the last 10% belongs to the load
    // actually finishing, so the bar never claims to be done early.
    clearInterval(creep);
    creep = setInterval(function () {
      pct += Math.max(0.4, (90 - pct) * 0.08);
      if (pct >= 90) { pct = 90; clearInterval(creep); }
      barFill.style.width = pct + "%";
    }, reduce ? 400 : 160);
    clearTimeout(veilTimer);
    veilTimer = setTimeout(function () { if (active) veil.classList.add("on"); }, DELAY);
  }

  function hide() {
    if (!bar) return;
    clearInterval(creep);
    clearTimeout(veilTimer);
    active = false;
    veil.classList.remove("on");
    barFill.style.width = "100%";
    setTimeout(function () {
      bar.classList.remove("on");
      setTimeout(function () { if (!active) barFill.style.width = "0"; }, 200);
    }, 160);
  }

  window.SouqiLoading = { show: show, hide: hide };

  function sameOrigin(a) {
    return a.protocol === location.protocol && a.host === location.host;
  }

  document.addEventListener("click", function (e) {
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab / download
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    if (a.target && a.target !== "_self") return;
    if (a.hasAttribute("download")) return;
    if (a.hasAttribute("onclick") || a.getAttribute("onclick")) return; // modal or JS trigger
    var href = a.getAttribute("href") || "";
    // In-page anchors, and any scheme that doesn't navigate the document
    if (!href || href.charAt(0) === "#") return;
    if (/^(mailto:|tel:|javascript:|blob:|data:)/i.test(href)) return;
    if (!sameOrigin(a)) return;
    // Same URL — the browser won't navigate, so a bar would hang forever
    if (a.href === location.href) return;
    setTimeout(function () {
      if (!e.defaultPrevented) show();
    }, 0);
  }, false);

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || e.defaultPrevented) return;
    // A form the page handles itself (preventDefault in its own listener)
    // never navigates; those should call SouqiLoading.show() explicitly.
    if (f.getAttribute("target") && f.getAttribute("target") !== "_self") return;
    show();
  }, false);

  // Back/forward cache restores the old page fully rendered — the bar must
  // not still be creeping from the navigation that took the user away.
  window.addEventListener("pageshow", hide);
  window.addEventListener("pagehide", hide);
})();
