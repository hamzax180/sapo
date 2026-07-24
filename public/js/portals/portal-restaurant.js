/* =================================================================
   WeboCloud Portal Engine — Official Restaurant & Menu Module
   (Signature Classics Restaurant & Online Food Ordering)
   ================================================================= */
(function() {
  "use strict";

  window.PortalTemplates = window.PortalTemplates || {};

  function renderMenu(products) {
    const hero = document.getElementById("portalHero"); if (hero) hero.style.display = "none";
    const trust = document.getElementById("trustStrip"); if (trust) trust.style.display = "none";
    const ab = document.getElementById("announceBar"); if (ab) ab.style.display = "none";

    const navCartBtn = document.getElementById("navCartBtn"); if (navCartBtn) navCartBtn.style.display = "flex";

    const S = window.PortalState || {};
    const sc = (S.config && S.config.storefrontConfig) || {};
    const co = (S.config && S.config.company) || "YOUR LOGO / YOUR NAME";

    document.body.classList.add("is-kfc-theme");

    const navCats = document.getElementById("navCats");
    if (navCats) {
      const cats = ["Delicious Flavors", "Campaigns", "Restaurants", "Careers", "About Us", "Contact"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i === 0 ? 'active' : ''}" onclick="Portal.filterCat('${c}')">${c.toUpperCase()}</a></li>`
      ).join("");
    }

    const main = document.getElementById("portalMain"); if (!main) return;

    const kfcCategories = [
      { name: "BURGERS", tag: "Crispy Zinger & Double Crunch", img: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&q=80" },
      { name: "WRAPS", tag: "Twister & Crisp Wraps", img: "https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&q=80" },
      { name: "BOXES", tag: "Zinger Box & Full Meal Deals", img: "https://images.unsplash.com/photo-1513185158878-8d8c2a2a3da3?w=600&q=80" },
      { name: "BUCKETS", tag: "100% Crisp Fried Chicken Buckets", img: "https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600&q=80" },
      { name: "CHICKENS WITH SAUCE", tag: "Hot Wings & Tenders", img: "https://images.unsplash.com/photo-1562967914-608f82629710?w=600&q=80" },
      { name: "BY-PRODUCTS AND DESSERTS", tag: "Fries, Biscuits & Treats", img: "https://images.unsplash.com/photo-1576107232684-1279f3908594?w=600&q=80" },
      { name: "BEVERAGES", tag: "Cold Shakes & Refreshing Drinks", img: "https://images.unsplash.com/photo-1543253687-c931c8e01820?w=600&q=80" },
      { name: "SAUCES", tag: "Garlic Dip, BBQ & Secret Sauce", img: "https://images.unsplash.com/photo-1472476443507-c7a5948772fc?w=600&q=80" }
    ];

    main.innerHTML = `
      <div class="kfc-top-loc-bar reveal">
        <span>📍 Click here to find the restaurant closest to you !</span>
      </div>

      <div class="kfc-subnav-bar reveal">
        <span class="kfc-subnav-title">SIGNATURE CLASSICS</span>
        <button class="kfc-discover-btn" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">DISCOVER IT NOW!</button>
      </div>

      <section class="kfc-hero reveal">
        <div class="kfc-hero-overlay"></div>
        <div class="kfc-hero-content">
          <div class="kfc-hero-badge">SECRET RECIPE 11 HERBS & SPICES</div>
          <h1 class="kfc-hero-title">SPECIAL CAMPAIGN — <span>CRISPY FEAST</span></h1>
          <p class="kfc-hero-sub">${sc.heroSub || "Freshly hand-breaded 100% crispy chicken, signature Zinger burgers, and iconic family buckets."}</p>
          <div class="kfc-hero-actions">
            <button class="btn kfc-btn-red" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">ORDER NOW →</button>
            <button class="btn kfc-btn-outline" onclick="Portal.openRateCalculator()">FIND RESTAURANT</button>
          </div>
        </div>
      </section>

      <section class="portal-section kfc-classics-section reveal">
        <div class="kfc-sec-hd">
          <h2 class="kfc-sec-title">SIGNATURE CLASSICS</h2>
        </div>

        <div class="kfc-cat-grid">
          ${kfcCategories.map(c => `
            <div class="kfc-cat-card" onclick="Portal.filterCat('${c.name}')">
              <div class="kfc-cat-img-wrap">
                <img src="${c.img}" alt="${c.name}" />
              </div>
              <h3 class="kfc-cat-title">${c.name}</h3>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="kfc-quote-section reveal">
        <div class="kfc-quote-inner">
          <div class="kfc-slogan">"it's finger lickin' good"</div>
          <button class="kfc-menu-link-btn" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">View the Full Menu →</button>
        </div>
      </section>

      <section class="kfc-promo-banner reveal">
        <div class="kfc-promo-content">
          <h2 class="kfc-promo-title">EXPLORE OUR CRISPY SIGNATURE MENU & FLAVORS</h2>
          <button class="kfc-tikla-btn" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">ORDER NOW</button>
        </div>
      </section>

      <section class="portal-section" id="productGridSection">
        <div class="section-head" style="align-items:flex-end">
          <div>
            <div class="section-eyebrow" style="color:#e4002b;font-weight:900">SIGNATURE FLAVORS</div>
            <div class="section-title" style="font-size:2.4rem;font-weight:900;letter-spacing:-0.02em">OUR DELICIOUS MENU</div>
            <div class="section-sub">${products.length} delicious items ready for delivery or pickup</div>
          </div>
        </div>

        ${window.buildCatBar ? window.buildCatBar(products) : ''}

        <div class="product-grid kfc-product-grid" id="productGrid">
          ${products.map((p, i) => window.kfcProductCard ? window.kfcProductCard(p, i) : '').join("")}
        </div>
      </section>

      <footer class="kfc-dark-footer reveal">
        <div class="kfc-footer-inner">
          <div class="kfc-footer-col">
            <div class="kfc-footer-logo">${co}</div>
            <p class="kfc-footer-desc">Freshly hand-breaded crispy favorites prepared every single day.</p>
          </div>
          <div class="kfc-footer-col">
            <h4>Institutional</h4>
            <a href="#">About Company</a>
            <a href="#">Our Restaurants</a>
            <a href="#">Contact Us</a>
          </div>
          <div class="kfc-footer-col">
            <h4>Menu Flavors</h4>
            <a href="#">Campaigns</a>
            <a href="#">Burgers</a>
            <a href="#">Wrappers</a>
            <a href="#">Boxes & Buckets</a>
          </div>
          <div class="kfc-footer-col">
            <h4>Help</h4>
            <a href="#">Cookie Policy</a>
            <a href="#">Privacy Policy</a>
            <a href="#">Terms of Use</a>
          </div>
          <div class="kfc-footer-col">
            <h4>📍 Locations</h4>
            <a href="#" class="kfc-loc-link">Find Nearest Hub →</a>
          </div>
        </div>
        <div class="kfc-footer-bottom">
          Copyright © ${co}. 2026 All rights reserved.
        </div>
      </footer>
    `;

    if (window.buildCategories) window.buildCategories(products);
    if (window.bindCatBar) window.bindCatBar();
    if (window.bindProductCards) window.bindProductCards();
    if (window.revealOnScroll) window.revealOnScroll();
  }

  window.PortalTemplates.menu = renderMenu;
})();
