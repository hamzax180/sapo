/* =================================================================
   WeboCloud Portal Engine — High-Fashion Editorial Catalog Module
   (ZARA & H&M Style High-Fashion Storefront)
   ================================================================= */
(function() {
  "use strict";

  window.PortalTemplates = window.PortalTemplates || {};

  function renderCatalog(products) {
    const hero = document.getElementById("portalHero"); if (hero) hero.style.display = "none";
    const trust = document.getElementById("trustStrip"); if (trust) trust.style.display = "none";

    const navCartBtn = document.getElementById("navCartBtn"); if (navCartBtn) navCartBtn.style.display = "flex";

    const S = window.PortalState || {};
    const sc = (S.config && S.config.storefrontConfig) || {};
    const co = (S.config && S.config.company) || "Demo E-Commerce";

    const navCats = document.getElementById("navCats");
    if (navCats) {
      const cats = ["New In", ...new Set(products.map(p => p.category || p.type || "Collection").filter(Boolean))];
      navCats.innerHTML = cats.slice(0, 6).map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i === 0 ? 'active' : ''}" onclick="Portal.filterCat('${c}')">${c.toUpperCase()}</a></li>`
      ).join("");
    }

    const main = document.getElementById("portalMain"); if (!main) return;

    main.innerHTML = `
      <section class="zara-hero reveal">
        <div class="zara-hero-inner">
          <div class="zara-hero-bg">
            <img src="${sc.heroBgImage || 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1600&q=85'}" alt="Editorial Campaign" />
          </div>
          <div class="zara-hero-overlay"></div>
          <div class="zara-hero-content">
            <div class="zara-hero-eyebrow">${sc.heroEyebrow || "NEW ARRIVALS 2026"}</div>
            <h1 class="zara-hero-title">${sc.heroTitle ? sc.heroTitle.replace(/\*(.*?)\*/g, "<em>$1</em>") : "THE <em>COLLECTION</em>"}</h1>
            <p class="zara-hero-sub">${sc.heroSub || "Designed for elevated everyday luxury. Discover refined silhouettes and timeless essentials."}</p>
            <div class="zara-hero-actions">
              <button class="btn btn-zara-dark" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">${sc.ctaText || "SHOP COLLECTION"} →</button>
              <button class="btn btn-zara-light" onclick="Portal.openLookbook()">VIEW EDITORIAL</button>
            </div>
          </div>
        </div>
      </section>

      <section class="zara-editorial-section reveal">
        <div class="zara-sec-hd">
          <h2 class="zara-sec-title">EDITORIAL LOOKBOOK</h2>
          <p class="zara-sec-sub">Curated seasonal trends and campaign highlights</p>
        </div>

        <div class="zara-editorial-grid">
          <div class="zara-edit-card" onclick="Portal.filterCat('Apparel')">
            <img src="https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=800&q=80" alt="Tailored Silhouettes" />
            <div class="zara-edit-info">
              <div class="zara-edit-tag">CAPSULE 01</div>
              <h3 class="zara-edit-title">TAILORED SILHOUETTES</h3>
              <div class="zara-edit-link">Explore Runway →</div>
            </div>
          </div>

          <div class="zara-edit-card" onclick="Portal.filterCat('Accessories')">
            <img src="https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&q=80" alt="Essential Accessories" />
            <div class="zara-edit-info">
              <div class="zara-edit-tag">CAPSULE 02</div>
              <h3 class="zara-edit-title">ESSENTIAL ACCESSORIES</h3>
              <div class="zara-edit-link">Discover Details →</div>
            </div>
          </div>
        </div>
      </section>

      <section class="portal-section" id="productGridSection">
        <div class="section-head" style="align-items:flex-end">
          <div>
            <div class="section-eyebrow">SPRING / SUMMER CATALOG</div>
            <div class="section-title" style="font-family:'Playfair Display',serif;font-size:2.4rem;font-weight:900;letter-spacing:-0.02em">THE CATALOG</div>
            <div class="section-sub">${products.length} products in collection</div>
          </div>
        </div>

        ${window.buildCatBar ? window.buildCatBar(products) : ''}

        <div class="product-grid zara-product-grid" id="productGrid">
          ${products.map((p, i) => window.productCard ? window.productCard(p, i) : '').join("")}
        </div>
      </section>
    `;

    if (window.buildCategories) window.buildCategories(products);
    if (window.bindCatBar) window.bindCatBar();
    if (window.bindProductCards) window.bindProductCards();
    if (window.revealOnScroll) window.revealOnScroll();
  }

  window.PortalTemplates.fashion = renderCatalog;
})();
