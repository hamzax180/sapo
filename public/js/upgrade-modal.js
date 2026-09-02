/* =================================================================
   js/upgrade-modal.js — the plans dialog, injected once
   -----------------------------------------------------------------
   Pages opt in with:

     <link rel="stylesheet" href="css/upgrade-modal.css">
     <script src="js/upgrade-modal.js" defer></script>

   and then call window.openUpgradeModal(event) from whatever should
   open it. The markup is built here rather than pasted into each page
   for one reason: it carries prices. Three copies of 0/00/8/0
   is three chances for the product to quote a number that is no longer
   true, and nothing warns you when they drift apart.

   Same shape as js/site-footer.js and js/nav-loading.js — the only
   other shared frontend modules — including the double-include guard,
   since more than one page has been known to pull in both.
   ================================================================= */
(function () {
  "use strict";

  if (window.openUpgradeModal) return;   // already loaded on this page

  /* Monthly is the default, so these are the monthly figures; the
     yearly toggle swaps them. Kept together here rather than inline in
     the markup so there is one obvious place to change a price. */
  var PRICES = {
    monthly: { core: "$20", pro: "$100" },
    yearly:  { core: "$18", pro: "$90"  }
  };

  var MARKUP = "<div class=\"ag-modal-backdrop\" id=\"agUpgradeModal\">\r\n  <div class=\"ag-modal-card\">\r\n    <button type=\"button\" class=\"ag-modal-close\" id=\"agUpgradeModalClose\" title=\"Close\">✕</button>\r\n    <div class=\"up-header\">\r\n      <h1>Upgrade</h1>\r\n      <p>Choose the best plan for you</p>\r\n      \r\n      <div class=\"billing-toggle\">\r\n        <button type=\"button\" id=\"modalBtnMonthly\" class=\"active\">Monthly</button>\r\n        <button type=\"button\" id=\"modalBtnYearly\">Yearly <span class=\"discount-pill\">🏷️ Up to 10% off</span></button>\r\n      </div>\r\n    </div>\r\n\r\n    <div class=\"up-grid\">\r\n      <!-- Starter Plan -->\r\n      <div class=\"up-card\">\r\n        <div class=\"up-card-top\">\r\n          <span class=\"up-card-title\">Starter</span>\r\n          <span class=\"up-badge-current\">Current plan</span>\r\n        </div>\r\n        <div class=\"up-price-row\">\r\n          <span class=\"amt\">Free</span>\r\n        </div>\r\n        <div class=\"up-subtitle\">For exploring what's possible</div>\r\n        <ul class=\"up-feats\">\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Free daily Agent credits</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Built-in database for full-stack apps</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Create slides, videos, animations</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Publish up to 1 project</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Publish private or password-protected deployments</span></li>\r\n        </ul>\r\n        <button class=\"up-btn up-btn-disabled\" disabled>Your current plan</button>\r\n      </div>\r\n\r\n      <!-- Souqi Core Plan (Featured) -->\r\n      <div class=\"up-card featured\">\r\n        <div class=\"up-card-top\">\r\n          <span class=\"up-card-title\">Souqi Core</span>\r\n        </div>\r\n        <div class=\"up-price-row\">\r\n          <span class=\"amt\" id=\"modalCorePrice\">$20</span>\r\n          <span class=\"unit\">per month</span>\r\n        </div>\r\n        <div class=\"up-subtitle\">For personal projects &amp; simple apps</div>\r\n        <ul class=\"up-feats\">\r\n          <li class=\"up-feat-item plus\"><span class=\"mark\">+</span><span>Everything in Starter</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>$20 of monthly credits</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Invite up to 5 collaborators</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Work in parallel with up to 2 agents</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Publish projects in any region</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Unlimited workspaces</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Remove \"Made with Souqi\" badge</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Souqi AI Integrations</span></li>\r\n        </ul>\r\n        <a href=\"/checkout?plan=core\" class=\"up-btn up-btn-primary\">Continue with Core &rarr;</a>\r\n      </div>\r\n\r\n      <!-- Souqi Pro Plan -->\r\n      <div class=\"up-card\">\r\n        <div class=\"up-card-top\">\r\n          <span class=\"up-card-title\">Souqi Pro</span>\r\n        </div>\r\n        <div class=\"up-price-row\">\r\n          <span class=\"amt\" id=\"modalProPrice\">$100</span>\r\n          <span class=\"unit\">per month</span>\r\n        </div>\r\n        <div class=\"up-subtitle\">For commercial and professional builds</div>\r\n        <ul class=\"up-feats\">\r\n          <li class=\"up-feat-item plus\"><span class=\"mark\">+</span><span>Everything in Core</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>$100 monthly credits</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Invite up to 15 collaborators</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Invite up to 50 viewers</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Work in parallel with up to 10 agents</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Access to the most powerful models</span></li>\r\n          <li class=\"up-feat-item check\"><span class=\"mark\">✓</span><span>Database rollbacks for up to 28 days</span></li>\r\n        </ul>\r\n        <select class=\"up-select\" id=\"modalProCreditSelect\">\r\n          <option value=\"100\">$100 credits</option>\r\n          <option value=\"250\">$250 credits</option>\r\n          <option value=\"500\">$500 credits</option>\r\n        </select>\r\n        <a href=\"/checkout?plan=pro\" class=\"up-btn up-btn-primary\">Continue with Pro &rarr;</a>\r\n      </div>\r\n    </div>\r\n\r\n    <div class=\"up-disclaimer\">\r\n      *Prices are subject to tax depending on your location. Souqi Agent is powered by large language models. While it can produce powerful results, its behavior is probabilistic — meaning it may occasionally make mistakes.\r\n    </div>\r\n  </div>\r\n</div>\r";

  var mounted = false;

  function mount() {
    if (mounted) return document.getElementById("agUpgradeModal");
    var host = document.createElement("div");
    host.innerHTML = MARKUP;
    var modal = host.firstElementChild;
    document.body.appendChild(modal);
    mounted = true;
    wire(modal);
    return modal;
  }

  function wire(modal) {
    var closeBtn = document.getElementById("agUpgradeModalClose");
    if (closeBtn) closeBtn.addEventListener("click", window.closeUpgradeModal);

    // Backdrop only — a click inside the card must not dismiss it.
    modal.addEventListener("click", function (e) {
      if (e.target === modal) window.closeUpgradeModal();
    });

    var mBtn = document.getElementById("modalBtnMonthly");
    var yBtn = document.getElementById("modalBtnYearly");
    var cPrice = document.getElementById("modalCorePrice");
    var pPrice = document.getElementById("modalProPrice");
    if (!mBtn || !yBtn) return;

    function show(period) {
      mBtn.classList.toggle("active", period === "monthly");
      yBtn.classList.toggle("active", period === "yearly");
      if (cPrice) cPrice.textContent = PRICES[period].core;
      if (pPrice) pPrice.textContent = PRICES[period].pro;
    }
    mBtn.addEventListener("click", function () { show("monthly"); });
    yBtn.addEventListener("click", function () { show("yearly"); });
    show("monthly");
  }

  window.openUpgradeModal = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    // The nav progress bar may have started if this came from a link.
    if (window.SouqiLoading) window.SouqiLoading.hide();
    mount().classList.add("open");
  };

  window.closeUpgradeModal = function () {
    var modal = document.getElementById("agUpgradeModal");
    if (modal) modal.classList.remove("open");
  };

  window.isUpgradeModalOpen = function () {
    var modal = document.getElementById("agUpgradeModal");
    return !!(modal && modal.classList.contains("open"));
  };

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && window.isUpgradeModalOpen()) window.closeUpgradeModal();
  });
})();
