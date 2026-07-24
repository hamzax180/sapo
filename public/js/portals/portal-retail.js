/* =================================================================
   WeboCloud Portal Engine — Retail Superstore Marketplace Module
   (NOON.com & Amazon Style Mega Retail Marketplace)
   ================================================================= */
(function() {
  "use strict";

  window.PortalTemplates = window.PortalTemplates || {};

  function renderRetail(products) {
    const hero = document.getElementById("portalHero"); if (hero) hero.style.display = "none";
    const trust = document.getElementById("trustStrip"); if (trust) trust.style.display = "none";

    const navCartBtn = document.getElementById("navCartBtn"); if (navCartBtn) navCartBtn.style.display = "flex";

    const S = window.PortalState || {};
    const sc = (S.config && S.config.storefrontConfig) || {};
    const co = (S.config && S.config.company) || "Demo Retail Store";

    document.body.classList.add("is-noon-theme");

    const navCats = document.getElementById("navCats");
    if (navCats) {
      const cats = ["Electronics", "Women's Fashion", "Men's Fashion", "Kids' Fashion", "Beauty & Fragrance", "Home & Appliances", "Supermarket", "Sports & Outdoors"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i === 0 ? 'active' : ''}" onclick="Portal.filterCat('${c}')">${c}</a></li>`
      ).join("");
    }

    const main = document.getElementById("portalMain"); if (!main) return;

    const departments = [
      { name: "Deals", icon: "🔥", tag: "UP TO 70% OFF", bg: "linear-gradient(135deg, #fff3b0, #ffd000)" },
      { name: "Coupons", icon: "🏷️", tag: "EXTRA SAVINGS", bg: "linear-gradient(135deg, #ffe0d3, #ff6b4a)" },
      { name: "Electronics", icon: "🎮", tag: "GAMING & TECH", bg: "linear-gradient(135deg, #d4f0ff, #38b6ff)" },
      { name: "Mobiles", icon: "📱", tag: "5G PHONES", bg: "linear-gradient(135deg, #e3f2fd, #2196f3)" },
      { name: "Beauty", icon: "💄", tag: "SKINCARE", bg: "linear-gradient(135deg, #fce4ec, #f06292)" },
      { name: "Fashion", icon: "👗", tag: "NEW STYLES", bg: "linear-gradient(135deg, #f3e5f5, #ab47bc)" },
      { name: "Laptops", icon: "💻", tag: "WORK & PLAY", bg: "linear-gradient(135deg, #e8eaf6, #3f51b5)" },
      { name: "Home & Kitchen", icon: "🍽️", tag: "APPLIANCES", bg: "linear-gradient(135deg, #fff3e0, #ff9800)" }
    ];

    main.innerHTML = `
      <div class="noon-top-banner reveal">
        <div class="noon-banner-inner">
          <span class="noon-val-tag">valu*</span>
          <span class="noon-val-title">BUY NOW, PAY LATER</span>
          <span class="noon-val-pill">up to 3 months</span>
          <div class="noon-val-perks">
            <span><b>0%</b> INTEREST</span>
            <span><b>0%</b> PURCHASE FEES</span>
            <span><b>0%</b> DOWN PAYMENT</span>
          </div>
        </div>
      </div>

      <section class="noon-hero reveal">
        <div class="noon-hero-inner">
          <div class="noon-hero-badge">SUPER SALE 2026</div>
          <h1 class="noon-hero-title">UPGRADE YOUR <span>GAMING GEAR</span></h1>
          <p class="noon-hero-sub">Explore next-gen consoles, 4K displays, and high-performance gaming accessories with express delivery.</p>
          <button class="btn noon-hero-cta" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">SHOP NOW →</button>
        </div>
      </section>

      <section class="noon-dept-section reveal">
        <div class="noon-dept-track">
          ${departments.map(d => `
            <div class="noon-dept-card" onclick="Portal.filterCat('${d.name}')">
              <div class="noon-dept-avatar" style="background:${d.bg}">
                <span class="noon-dept-icon">${d.icon}</span>
              </div>
              <div class="noon-dept-name">${d.name}</div>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="portal-section noon-catalog-section" id="productGridSection">
        <div class="noon-sec-hd">
          <div>
            <h2 class="noon-sec-title">RECOMMENDED FOR YOU</h2>
            <p class="noon-sec-sub">Based on popular items in your region</p>
          </div>
        </div>

        ${window.buildCatBar ? window.buildCatBar(products) : ''}

        <div class="product-grid noon-product-grid" id="productGrid">
          ${products.map((p, i) => window.noonProductCard ? window.noonProductCard(p, i) : '').join("")}
        </div>
      </section>
    `;

    if (window.buildCategories) window.buildCategories(products);
    if (window.bindCatBar) window.bindCatBar();
    if (window.bindProductCards) window.bindProductCards();
    if (window.revealOnScroll) window.revealOnScroll();
  }

  window.PortalTemplates.retail = renderRetail;
})();
