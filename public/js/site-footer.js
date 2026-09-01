/* =================================================================
   site-footer.js — injects the shared marketing footer
   -----------------------------------------------------------------
   One source of truth for a block that would otherwise be pasted
   into every page and drift. Pages opt in with:

     <link rel="stylesheet" href="css/site-footer.css">
     <script src="js/site-footer.js" defer></script>

   Deliberately NOT added to the app shells (code, settings, portal,
   admin, mobile, checkout): a marketing footer inside the builder's
   chat column or the settings modal is noise, not navigation.

   The data-t attributes match home.html's, so on pages that load
   js/ui.js the existing translator picks the footer up; on pages
   that don't, the inline English text is what shows. Either way the
   markup is identical, which is the point.
   ================================================================= */
(function () {
  "use strict";

  // A page that already ships its own footer keeps it — this is additive.
  if (document.querySelector(".site-foot, .bh-foot")) return;

  var YEAR = new Date().getFullYear();

  var html =
    '<div class="sf-wrap">' +
      '<div class="sf-grid">' +
        '<div class="sf-brandcol">' +
          '<a class="sf-brand" href="/"><img src="/assets/logo.png" alt=""><span>Souqi</span></a>' +
        '</div>' +
        '<div>' +
          '<h5 data-t="Product">Product</h5>' +
          '<ul>' +
            '<li><a href="/agent" data-t="AI Website Builder">AI Website Builder</a></li>' +
            '<li><a href="/agent" data-t="AI App Builder">AI App Builder</a></li>' +
            '<li><a href="/pricing" data-t="Pricing">Pricing</a></li>' +
            '<li><a href="/agent" data-t="Agent">Agent</a></li>' +
          '</ul>' +
        '</div>' +
        '<div>' +
          '<h5 data-t="Company">Company</h5>' +
          '<ul>' +
            '<li><a href="mailto:sales@souqi.site" data-t="Contact sales">Contact sales</a></li>' +
            '<li><a href="/login" data-t="Log in">Log in</a></li>' +
            '<li><a href="/agent" data-t="Start building">Start building</a></li>' +
          '</ul>' +
        '</div>' +
        '<div>' +
          '<h5 data-t="Legal">Legal</h5>' +
          '<ul>' +
            '<li><a href="/terms" data-t="Terms of Service">Terms of Service</a></li>' +
            '<li><a href="/privacy" data-t="Privacy">Privacy</a></li>' +
          '</ul>' +
        '</div>' +
      '</div>' +
      '<div class="sf-legal">' +
        '<span>\u00a9 ' + YEAR + ' Souqi Cloud \u00b7 <span data-t="Cloud Operations Platform">Cloud Operations Platform</span></span>' +
        '<span><a href="https://souqi.site">souqi.site</a></span>' +
      '</div>' +
    '</div>';

  function mount() {
    var foot = document.createElement("footer");
    foot.className = "site-foot";
    foot.innerHTML = html;
    document.body.appendChild(foot);
    // Pages with js/ui.js translate on load, which may already have run by
    // the time this mounts — re-run it so the footer is not left in English
    // on a page the visitor has set to Turkish or Arabic.
    // ui.js exposes it on window.UI, not as a bare global.
    var tp = (window.UI && window.UI.translatePage) || window.translatePage;
    if (typeof tp === "function") {
      try { tp(); } catch (e) { /* footer still renders in English */ }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
