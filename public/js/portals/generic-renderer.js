/* =================================================================
   WeboCloud Portal Engine — Generic block-based page renderer
   -----------------------------------------------------------------
   Consumes storefrontConfig v2 (`pages` map of blocks — see
   config-migrate.js) and renders whichever page the hash router is
   currently on using the shared PortalBlocks registry (blocks.js).
   This is what lets Retail/Services support free block reordering,
   add/remove, and brand-new pages instead of one hardcoded template
   function per industry.
   ================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function currentSlug() {
    const m = (location.hash || "").match(/^#\/p\/([^/?]+)/);
    return m ? m[1] : "main";
  }

  /* ---- render whichever page `slug` points to (default: main/home) ---- */
  function renderPortalPage(slug, products) {
    const S = window.PortalState || {};
    const cfg = S.config || {};
    const sc = cfg.storefrontConfig || {};
    const pages = sc.pages || {};
    const page = pages[slug] || pages.main;
    const main = $("portalMain");
    if (!main || !page) return;

    // Generic pages have their own hero/topbar blocks — hide the static
    // markup shell that the bespoke templates rely on.
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    // The static shell footer stays out of the way on pages that carry their
    // own footer-rich block, but comes back for pages that don't (e.g. the
    // auto-generated products page) so no page ends up footer-less.
    const hasOwnFooter = (page.blocks || []).some((b) => b.type === "footer-rich");
    const pf = $("portalFooter"); if (pf) pf.style.display = hasOwnFooter ? "none" : "block";

    document.title = (page.title || cfg.company || "Store") + (page.isHome ? "" : " — " + (cfg.company || "Store"));

    const blocks = page.blocks || [];
    const ctx = { products: products || S.products || [] };
    main.innerHTML = blocks.map((b) => {
      const type = window.PortalBlocks[b.type];
      if (!type) return "";
      try { return type.render(b.props || {}, Object.assign({ blockId: b.id }, ctx)); }
      catch (e) { console.error("[Portal] block render failed:", b.type, e); return ""; }
    }).join("");

    blocks.forEach((b) => {
      const type = window.PortalBlocks[b.type];
      if (type && typeof type.afterRender === "function") {
        try { type.afterRender(b.props || {}, { blockId: b.id, products: ctx.products }); }
        catch (e) { console.error("[Portal] block afterRender failed:", b.type, e); }
      }
    });

    applyStyleOverrides(main, blocks);
    buildNavFromPages(pages, sc.navOrder || Object.keys(pages), slug);
    applyNavItemOrder((sc.nav && sc.nav.items) || ["brand", "links", "actions"]);

    // The nav cart icon only makes sense where there's something to add to
    // it — shown when THIS page has a product-grid block, hidden otherwise
    // (e.g. Logistics/Services, which are quote/RFQ-driven, never do).
    const cartBtn = $("navCartBtn");
    if (cartBtn) cartBtn.style.display = blocks.some((b) => b.type === "product-grid") ? "flex" : "none";

    if (window.revealOnScroll) window.revealOnScroll();
    document.dispatchEvent(new CustomEvent("portal:page-rendered", { detail: { slug: page.slug || slug } }));
  }

  /* ---- per-field style tweaks made straight on the page ----------
     The editor's floating toolbar (size / alignment / color) writes into
     a block's `props.__styles`, keyed by the same `data-edit` path the
     block stamped on its output. Most of those properties have no prop to
     live in — a hero title's color comes from CSS — so they're replayed
     here as inline styles after render. Runs for real visitors too, which
     is what makes the tweaks actually publish.
     ---------------------------------------------------------------- */
  const ALLOWED_STYLE_PROPS = ["fontSize", "color", "textAlign", "fontWeight", "letterSpacing"];

  function applyStyleOverrides(main, blocks) {
    (blocks || []).forEach((b) => {
      const styles = (b.props || {}).__styles;
      if (!styles) return;
      const section = main.querySelector('[data-block-id="' + b.id + '"]');
      if (!section) return;
      Object.keys(styles).forEach((editPath) => {
        const el = section.querySelector('[data-edit="' + editPath + '"]');
        if (!el) return;
        const patch = styles[editPath] || {};
        ALLOWED_STYLE_PROPS.forEach((k) => { if (patch[k]) el.style[k] = patch[k]; });
      });
    });
  }

  /* ---- nav bar built from the pages map instead of a hardcoded category list ---- */
  function buildNavFromPages(pages, navOrder, activeSlug) {
    const navCats = $("navCats");
    if (!navCats) return;
    navCats.innerHTML = navOrder.filter((slug) => pages[slug]).map((slug) => {
      const p = pages[slug];
      const href = slug === "main" ? "#/" : "#/p/" + slug;
      return '<li><a href="' + href + '" class="' + (slug === activeSlug ? "active" : "") + '">' + esc(p.title || slug) + "</a></li>";
    }).join("");
  }

  /* ---- reorders the nav bar's top-level groups (brand / links / actions)
     by physically re-appending the existing DOM nodes into .nav-inner in the
     requested order — .nav-inner is a 3-column CSS grid, so DOM order alone
     determines left-to-right placement, no markup changes needed. ---- */
  const NAV_GROUP_SELECTOR = { brand: "#navBrand", links: "#navCats", actions: ".nav-right" };
  function applyNavItemOrder(order) {
    const inner = document.querySelector(".nav-inner");
    if (!inner) return;
    (order || []).forEach((key) => {
      const sel = NAV_GROUP_SELECTOR[key];
      const el = sel && document.querySelector(sel);
      if (el) inner.appendChild(el);
    });
  }
  window.applyNavItemOrder = applyNavItemOrder;

  /* ---- client-side hash router ---- */
  function boot(products) {
    const render = () => renderPortalPage(currentSlug(), (window.PortalState || {}).products);
    window.addEventListener("hashchange", render);
    render();
  }
  window.bootPortalRouter = boot;
  window.renderPortalPage = renderPortalPage;

  /* =================================================================
     PortalGB — action dispatch for generic-block buttons/forms.
     Kept separate from window.Portal (defined later, by portal.js)
     so these scripts don't depend on load order (see blocks.js).
     ================================================================= */
  const calcState = {}; // per-block calculator state, keyed by blockId

  const PortalGB = {
    goToPage(slug) { location.hash = slug === "main" ? "#/" : "#/p/" + slug; },

    scrollToBlock(blockId) {
      if (!blockId) return;
      const el = document.querySelector('[data-block-id="' + blockId + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth" });
    },

    runBlockAction(action, target) {
      if (action === "page") return PortalGB.goToPage(target);
      if (action === "scroll") return PortalGB.scrollToBlock(target);
      if (action === "cart") return window.Portal && window.Portal.openCart && window.Portal.openCart();
      if (action === "link" && target) return window.open(target, "_blank");
      // "none" or unrecognized — no-op
    },

    /* Footer newsletter signup. There's no mailing-list backend yet, so this
       acknowledges the submit rather than pretending to deliver it — the
       address is kept in the form so nothing is silently swallowed. */
    subscribeFooter(e, form) {
      e.preventDefault();
      form.classList.add("sent");
      const btn = form.querySelector("button");
      if (btn) { btn.textContent = "Subscribed ✓"; btn.disabled = true; }
      const input = form.querySelector("input");
      if (input) input.disabled = true;
      return false;
    },

    runCalculator(blockId) {
      const area = document.getElementById("calc_" + blockId + "_area");
      const team = document.getElementById("calc_" + blockId + "_team");
      const weeks = document.getElementById("calc_" + blockId + "_weeks");
      const areaMult = area ? Number(area.value) : 1;
      const teamSize = team ? Number(team.value) : 3;
      const weekCount = weeks ? Number(weeks.value) : 4;
      const rate = 250 * areaMult;
      const fee = rate * teamSize * weekCount;
      calcState[blockId] = { teamSize, weekCount, fee };

      const resTeam = document.getElementById("calc_" + blockId + "_resTeam");
      const resWeeks = document.getElementById("calc_" + blockId + "_resWeeks");
      const resPrice = document.getElementById("calc_" + blockId + "_resPrice");
      if (resTeam) resTeam.textContent = teamSize + " specialists";
      if (resWeeks) resWeeks.textContent = weekCount + " weeks";
      if (resPrice) resPrice.textContent = "$" + fee.toLocaleString("en-US");
    },

    async submitRfqBlock(blockId) {
      const btn = document.getElementById("rfqSubmit_" + blockId);
      const name = document.getElementById("rfq_" + blockId + "_name");
      const email = document.getElementById("rfq_" + blockId + "_email");
      const phone = document.getElementById("rfq_" + blockId + "_phone");
      const message = document.getElementById("rfq_" + blockId + "_message");
      if (!name || !email || !message || !name.value || !email.value || !message.value) return;

      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      try {
        const S = window.PortalState || {};
        const apiBase = (window.PORTAL_API_BASE || "").replace(/\/$/, "");
        const r = await fetch(apiBase + "/api/portal/" + S.wsId + "/inquiry", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.value, email: email.value, phone: phone ? phone.value : "", message: message.value })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        if (btn) { btn.textContent = "✓ Request sent — thank you!"; }
        [name, email, phone, message].forEach((el) => { if (el) el.disabled = true; });
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = "Send Request →"; }
        if (window.toast) window.toast("Failed to send. Please try again.", "error");
      }
    }
  };

  window.PortalGB = PortalGB;
})();
