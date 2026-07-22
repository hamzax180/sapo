/* =================================================================
   WeboCloud Portal Engine v2 — Real E-Commerce Frontend
   ================================================================= */
(function () {
  "use strict";

  /* ── helpers ──────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const qs = s => document.querySelector(s);
  const qsa = s => [...document.querySelectorAll(s)];
  const esc = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const fmt = n => Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const apiBase = () => (window.PORTAL_API_BASE || "").replace(/\/$/,"");

  /* ── state ────────────────────────────────────────────────────── */
  const S = {
    wsId: null, config: null, industry: null,
    products: [], cart: [], wishlist: [], modalQty: 1, modalProduct: null,
    paymentMethod: null,
    template: "catalog"
  };

  /* ── wishlist (persisted per-workspace so it survives reloads) ──── */
  function wishlistKey() { return "sap_" + S.wsId + "_wishlist"; }
  function loadWishlist() {
    try { S.wishlist = JSON.parse(localStorage.getItem(wishlistKey()) || "[]"); }
    catch (e) { S.wishlist = []; }
  }
  function saveWishlist() {
    try { localStorage.setItem(wishlistKey(), JSON.stringify(S.wishlist)); } catch (e) {}
  }
  function isWishlisted(id) { return S.wishlist.indexOf(id) > -1; }
  function toggleWishlist(id) {
    const item = S.products.find(p => p.id === id);
    const idx = S.wishlist.indexOf(id);
    if (idx > -1) { S.wishlist.splice(idx, 1); toast((item ? item.name + " removed" : "Removed") + " from Wishlist"); }
    else { S.wishlist.push(id); toast("❤️ " + (item ? item.name + " added to" : "Added to") + " Wishlist"); }
    saveWishlist();
    const active = isWishlisted(id);
    qsa('[data-wishlist-id="' + CSS.escape(id) + '"]').forEach(btn => {
      btn.classList.toggle("active", active);
      btn.textContent = active ? "♥" : "♡";
    });
  }
  window.PortalState = S;


  /* ── resolve workspace ID ─────────────────────────────────────── */
  function resolveWsId() {
    const m = location.pathname.match(/\/portal\/([^/?#]+)/);
    if (m) return m[1];
    const meta = document.querySelector('meta[name="ws-id"]');
    if (meta && meta.content) return meta.content;
    return null;
  }

  /* ── api calls ────────────────────────────────────────────────── */
  async function fetchConfig(id) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(apiBase()+"/api/portal/"+id+"/config", { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const cfg = await r.json();
        if (cfg && cfg.company && cfg.company !== "WeboCloud") return cfg;
      }
    } catch {}
    return readConfigFromLocalStorage(id);
  }

  async function fetchProducts(id) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(apiBase()+"/api/portal/"+id+"/products", { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const items = await r.json();
        if (Array.isArray(items) && items.length > 0) return items;
      }
    } catch {}
    return readProductsFromLocalStorage(id);
  }


  /* ── localStorage helpers (demo mode) ───────────────────────────── */
  function readConfigFromLocalStorage(wsId) {
    try {
      let ws = null;
      // Primary: workspace list array (sap_workspaces)
      const list = JSON.parse(localStorage.getItem("sap_workspaces") || "[]");
      ws = list.find(w => w.id === wsId);

      // Fallback: first workspace in list if wsId not found
      if (!ws && list.length) ws = list[0];

      // Fallback: active workspace
      if (!ws) {
        const activeId = localStorage.getItem("sap_active_ws");
        if (activeId) ws = list.find(w => w.id === activeId) || list[0];
      }

      if (ws) {
        console.log("[Portal] Config from localStorage:", ws.company, "industry:", ws.industry);
        return {
          id: ws.id,
          company: ws.company || ws.name || "Our Store",
          industry: ws.industry || ws.preset || "ecommerce",
          logo: ws.logo || null,
          storefrontEnabled: ws.storefrontEnabled !== false,
          storefrontConfig: ws.storefrontConfig || {}
        };
      }
    } catch(e) { console.warn("Portal: localStorage config read failed", e); }
    return null;
  }

  function readProductsFromLocalStorage(wsId) {
    try {
      // store.js uses exactly: sap_<wsId>_products
      const exactKey = "sap_" + wsId + "_products";
      const raw = localStorage.getItem(exactKey);
      if (raw) {
        const items = JSON.parse(raw);
        if (Array.isArray(items) && items.length) {
          console.log("[Portal] Loaded", items.length, "products from", exactKey);
          return items;
        }
      }
      // Legacy: no ws prefix
      const leg = localStorage.getItem("sap_products");
      if (leg) {
        const items = JSON.parse(leg);
        if (Array.isArray(items) && items.length) return items;
      }
      // Scan all sap_*_products keys
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("sap_") && k.endsWith("_products")) {
          try {
            const items = JSON.parse(localStorage.getItem(k));
            if (Array.isArray(items) && items.length) {
              console.log("[Portal] Found products at key:", k, "count:", items.length);
              return items;
            }
          } catch {}
        }
      }
    } catch(e) {
      console.warn("Portal: localStorage products read failed", e);
    }
    return [];
  }


  /* ── branding ─────────────────────────────────────────────────── */
  function applyBranding(cfg) {
    const sc = cfg.storefrontConfig || {};
    // Falls back through: an explicit manual override, this specific
    // config's own accent, then the industry's real brand color (this
    // is the piece that was missing — every industry was silently
    // defaulting to plain black for its site-wide accent instead of its
    // actual brand color, e.g. Construction's amber or Services' teal).
    const industryAccent = window.INDUSTRIES && window.INDUSTRIES[cfg.industry] && window.INDUSTRIES[cfg.industry].accent;
    const accent = sc.accentColor || cfg.accent || industryAccent || "#111111";
    document.documentElement.style.setProperty("--accent", accent);

    const co = cfg.company || "Our Store";
    document.title = (sc.pageTitle || co) + " — Shop Online";

    // Loader brand
    const lb = $("loaderBrand"); if (lb) lb.textContent = co.toUpperCase();

    // Nav
    const nn = $("navName"); if (nn) nn.textContent = sc.brandName || co;
    const nli = $("navLogoIcon");
    if (nli) {
      nli.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
      nli.style.background = accent;
    }

    const logoUrl = sc.logoUrl || cfg.logo;
    if (logoUrl) {
      const nl = $("navLogo");
      if (nl) { nl.src = logoUrl; nl.style.display = "block"; }
      const nli2 = $("navLogoIcon"); if (nli2) nli2.style.display = "none";
    }


    // Footer
    const fb = $("footerBrand"); if (fb) fb.textContent = co;
    const fc = $("footerCo"); if (fc) fc.textContent = co;
    const fd = $("footerDesc"); if (fd) fd.textContent = sc.footerDesc || cfg.tagline || ("Premium products from "+co+".");

    // Announcement bar
    const ab = $("announceBar"); const at = $("announceText");
    const announceTxt = sc.announcement || "Free shipping on orders over $50 | 24/7 Customer Support";
    const announceOn = sc.announcementEnabled !== false && !!announceTxt;
    if (ab && at) {
      at.innerHTML = announceTxt;
      ab.style.display = announceOn ? "flex" : "none";
    }

    // Hero content
    const ind = S.industry || {};
    const heroEyebrowText = sc.heroEyebrow || co.toUpperCase();
    if ($("heroEyebrow")) $("heroEyebrow").textContent = heroEyebrowText;

    let titleHtml = sc.heroTitle || (ind.portalHero ? ind.portalHero.replace(/(\w+)$/, "<em>$1</em>") : "Discover Our <em>Products</em>");
    if (titleHtml.includes("*") && !titleHtml.includes("<em>")) {
      titleHtml = titleHtml.replace(/\*(.*?)\*/g, "<em>$1</em>");
    }
    if ($("heroTitle")) $("heroTitle").innerHTML = titleHtml;

    if ($("heroSub")) $("heroSub").textContent = sc.heroSub || ind.portalSubhero || "Shop the latest collection with fast delivery and exceptional quality.";
    
    const ctaEl = $("heroCtaBtn"); 
    if (ctaEl) {
      const ctaIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      ctaEl.innerHTML = (sc.ctaText || ind.portalCallToAction || "Shop Now") + " " + ctaIcon;
    }

    const secondaryCta = $("heroTrackBtn");
    if (secondaryCta && sc.secondaryCtaText) {
      secondaryCta.textContent = sc.secondaryCtaText;
      secondaryCta.style.display = "inline-flex";
    }

    // Hero alignment
    const heroContent = qs(".hero-content");
    if (heroContent) {
      if (sc.heroAlign === "center") heroContent.classList.add("centered");
      else heroContent.classList.remove("centered");
    }

    // Hero bg image or gradient
    const heroMedia = $("heroMedia");
    const heroImg = $("heroImg");
    if (sc.heroBgImage && heroMedia && heroImg) {
      heroImg.src = sc.heroBgImage;
      heroMedia.style.display = "block";
    }

    // Trust strip visibility
    const ts = $("trustStrip"); if (ts) ts.style.display = "";

    // Hero bg gradient
    const heroBg = $("heroBg");
    if (heroBg) {
      heroBg.style.background = `linear-gradient(135deg, #0d0d0d 0%, ${accent}33 60%, #0d0d0d 100%)`;
    }
  }


  /* ── category pills ───────────────────────────────────────────── */
  function buildCategories(products) {
    const cats = ["All", ...new Set(products.map(p => p.category||p.type||"General").filter(Boolean))];
    const nav = $("navCats"); if (!nav) return;
    nav.innerHTML = cats.map((c,i) =>
      `<li><a href="#" class="${i===0?"active":""}" data-cat="${esc(c)}">${esc(c)}</a></li>`
    ).join("");
    nav.querySelectorAll("a").forEach(a => {
      a.addEventListener("click", e => {
        e.preventDefault();
        nav.querySelectorAll("a").forEach(x => x.classList.remove("active"));
        a.classList.add("active");
        const cat = a.dataset.cat;
        const filtered = cat === "All" ? S.products : S.products.filter(p=>(p.category||p.type||"General")===cat);
        renderProductGrid(filtered);
      });
    });

    // Footer shop links
    const fsl = $("footerShopLinks");
    if (fsl) {
      fsl.innerHTML = cats.slice(0,5).map(c =>
        `<li><a href="#">${esc(c==="All"?"All Products":c)}</a></li>`
      ).join("");
    }
  }

  /* ── build category bar (in main content) ─────────────────────── */
  function buildCatBar(products) {
    const cats = ["All", ...new Set(products.map(p=>p.category||p.type||"General").filter(Boolean))];
    return `<div class="cat-bar" id="catBar">
      ${cats.map((c,i) => `<button class="cat-pill${i===0?" active":""}" data-cat="${esc(c)}">${esc(c==="All"?"All Items":c)}</button>`).join("")}
    </div>`;
  }

  /* ── product card ─────────────────────────────────────────────── */
  function productCard(p, i) {
    const price = Number(p.price||p.salePrice||p.unitPrice||0);
    const name = p.name||p.title||"Product";
    const cat = p.category||p.type||"";
    const inStock = p.stock===undefined || Number(p.stock||0)>0;
    const isNew = p.isNew || p.new;
    const delay = (i%12)*0.04;
    return `
    <div class="product-card reveal" style="animation-delay:${delay}s" data-pid="${esc(p.id)}" role="button" tabindex="0">
      <div class="product-img-wrap">
        ${p.image ? `<img src="${esc(p.image)}" alt="${esc(name)}" loading="lazy" />` : `<div class="product-img-placeholder">${productEmoji(cat)}</div>`}
        <div class="product-badges">
          ${isNew ? `<span class="product-badge badge-new">New</span>` : ""}
          ${!inStock ? `<span class="product-badge badge-sold">Sold Out</span>` : ""}
        </div>
        <button class="product-wishlist${isWishlisted(p.id) ? " active" : ""}" title="Save to Wishlist" data-wishlist-id="${esc(p.id)}" onclick="event.stopPropagation();Portal.toggleWishlist('${esc(p.id)}')">${isWishlisted(p.id) ? "♥" : "♡"}</button>
        ${inStock ? `<div class="product-quick-add" data-qadd="${esc(p.id)}" data-qname="${esc(name)}" data-qprice="${price}">+ Quick Add</div>` : ""}
      </div>
      <div class="product-info">
        <div class="product-brand">${esc(cat)}</div>
        <div class="product-name">${esc(name)}</div>
        <div class="product-price-row">
          <div class="product-price">$${fmt(price)}</div>
        </div>
        <div class="product-rating">
          <span class="stars">★★★★★</span>
          <span>${(4.3+Math.random()*0.6).toFixed(1)} (${Math.floor(20+Math.random()*200)})</span>
        </div>
      </div>
    </div>`;
  }

  function productEmoji(cat) {
    const map = {food:"🍽️",drink:"🥤",electronic:"📱",cloth:"👕",furnit:"🪑",book:"📚",tool:"🔧",beauty:"💄",sport:"⚽",toy:"🧸"};
    const lc = String(cat).toLowerCase();
    return Object.entries(map).find(([k])=>lc.includes(k))?.[1] || "📦";
  }

  /* ── render product grid ──────────────────────────────────────── */
  function renderProductGrid(products) {
    const grid = $("productGrid"); if (!grid) return;
    if (!products.length) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-title">No products found</div><div class="empty-sub">Try a different category</div></div>`;
      return;
    }
    grid.innerHTML = products.map((p,i) => productCard(p,i)).join("");
    bindProductCards();
    revealOnScroll();
  }

  /* ── bind product card clicks ─────────────────────────────────── */
  function bindProductCards() {
    // Card click → open modal
    qsa(".product-card").forEach(card => {
      card.addEventListener("click", () => {
        const pid = card.dataset.pid;
        const p = S.products.find(x => x.id === pid);
        if (p) openProductModal(p);
      });
      card.addEventListener("keydown", e => { if (e.key==="Enter") card.click(); });
    });
    // Quick add buttons
    qsa(".product-quick-add").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        addToCart(btn.dataset.qadd, btn.dataset.qname, Number(btn.dataset.qprice), null);
        btn.textContent = "✓ Added";
        setTimeout(() => btn.textContent="+ Quick Add", 1800);
      });
    });
  }

  /* ── cat bar filtering ────────────────────────────────────────── */
  function bindCatBar() {
    const bar = $("catBar"); if (!bar) return;
    bar.querySelectorAll(".cat-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        bar.querySelectorAll(".cat-pill").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const cat = btn.dataset.cat;
        const filtered = cat==="All" ? S.products : S.products.filter(p=>(p.category||p.type||"General")===cat);
        renderProductGrid(filtered);
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  CATALOG TEMPLATE (ZARA & H&M HIGH-FASHION EDITORIAL STORE)     */
  /* ─────────────────────────────────────────────────────────────── */
  function renderCatalog(products) {
    // Hide static basic hero
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    const pf = $("portalFooter"); if (pf) pf.style.display = "block";

    $("navCartBtn").style.display = "flex";


    const sc = S.config.storefrontConfig || {};
    const co = S.config.company || "Demo E-Commerce";

    // Set ZARA/H&M Nav Categories
    const navCats = $("navCats");
    if (navCats) {
      const cats = ["New In", ...new Set(products.map(p=>p.category||p.type||"Collection").filter(Boolean))];
      navCats.innerHTML = cats.slice(0, 6).map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i===0?'active':''}" onclick="Portal.filterCat('${esc(c)}')">${esc(c.toUpperCase())}</a></li>`
      ).join("");
    }

    const main = $("portalMain"); if (!main) return;

    main.innerHTML = `
      <!-- ZARA / H&M EDITORIAL HERO CAMPAIGN -->
      <section class="zara-hero reveal">
        <div class="zara-hero-inner">
          <div class="zara-hero-bg">
            <img src="${sc.heroBgImage || 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1600&q=85'}" alt="Editorial Campaign" />
          </div>
          <div class="zara-hero-overlay"></div>
          <div class="zara-hero-content">
            <div class="zara-hero-eyebrow">${esc(sc.heroEyebrow || "NEW ARRIVALS 2026")}</div>
            <h1 class="zara-hero-title">${sc.heroTitle ? esc(sc.heroTitle).replace(/\*(.*?)\*/g, "<em>$1</em>") : "THE <em>COLLECTION</em>"}</h1>
            <p class="zara-hero-sub">${esc(sc.heroSub || "Designed for elevated everyday luxury. Discover refined silhouettes and timeless essentials.")}</p>
            <div class="zara-hero-actions">
              <button class="btn btn-zara-dark" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">${esc(sc.ctaText || "SHOP COLLECTION")} →</button>
              <button class="btn btn-zara-light" onclick="Portal.openLookbook()">VIEW EDITORIAL</button>
            </div>
          </div>
        </div>
      </section>

      <!-- ZARA / H&M EDITORIAL LOOKBOOK GRID -->
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

      <!-- CATALOG PRODUCT GRID SECTION -->
      <section class="portal-section" id="productGridSection">
        <div class="section-head" style="align-items:flex-end">
          <div>
            <div class="section-eyebrow">SPRING / SUMMER CATALOG</div>
            <div class="section-title" style="font-family:'Playfair Display',serif;font-size:2.4rem;font-weight:900;letter-spacing:-0.02em">THE CATALOG</div>
            <div class="section-sub">${products.length} products in collection</div>
          </div>
        </div>

        ${buildCatBar(products)}

        <div class="product-grid zara-product-grid" id="productGrid">
          ${products.map((p,i)=>productCard(p,i)).join("")}
        </div>
      </section>
    `;

    buildCategories(products);
    bindCatBar();
    bindProductCards();
    revealOnScroll();
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  RETAIL SUPERSTORE MARKETPLACE TEMPLATE (NOON.COM STYLE)        */
  /* ─────────────────────────────────────────────────────────────── */
  function renderRetail(products) {
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    const pf = $("portalFooter"); if (pf) pf.style.display = "block";

    $("navCartBtn").style.display = "flex";


    const sc = S.config.storefrontConfig || {};
    const co = S.config.company || "Demo Retail Store";

    // Set NOON Nav Categories
    const navCats = $("navCats");
    if (navCats) {
      const cats = ["Electronics", "Women's Fashion", "Men's Fashion", "Kids' Fashion", "Beauty & Fragrance", "Home & Appliances", "Supermarket", "Sports & Outdoors"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i===0?'active':''}" onclick="Portal.filterCat('${esc(c)}')">${esc(c)}</a></li>`
      ).join("");
    }

    const main = $("portalMain"); if (!main) return;

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
      <!-- NOON TOP PROMO STRIP -->
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

      <!-- NOON MAIN GAMING HERO BANNER -->
      <section class="noon-hero reveal">
        <div class="noon-hero-inner">
          <div class="noon-hero-badge">SUPER SALE 2026</div>
          <h1 class="noon-hero-title">UPGRADE YOUR <span>GAMING GEAR</span></h1>
          <p class="noon-hero-sub">Explore next-gen consoles, 4K displays, and high-performance gaming accessories with express delivery.</p>
          <button class="btn noon-hero-cta" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">SHOP NOW →</button>
        </div>
      </section>

      <!-- NOON CIRCULAR DEPARTMENT AVATARS CAROUSEL -->
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

      <!-- RETAIL PRODUCT GRID SECTION -->
      <section class="portal-section noon-catalog-section" id="productGridSection">
        <div class="noon-sec-hd">
          <div>
            <h2 class="noon-sec-title">RECOMMENDED FOR YOU</h2>
            <p class="noon-sec-sub">Top deals, best sellers and express delivery items</p>
          </div>
          <span class="noon-express-tag">⚡ noon express</span>
        </div>

        ${buildCatBar(products)}

        <div class="product-grid noon-product-grid" id="productGrid">
          ${products.map((p,i)=>noonProductCard(p,i)).join("")}
        </div>
      </section>
    `;

    buildCategories(products);
    bindCatBar();
    bindProductCards();
    revealOnScroll();
  }

  function noonProductCard(p, i) {
    const isExpress = i % 2 === 0;
    const badgeText = i === 0 ? "Best Seller" : i === 1 ? "Official Store" : i === 2 ? "Selling Fast" : "Best Value";
    const badgeClass = i === 0 ? "badge-bestseller" : i === 1 ? "badge-official" : "badge-fast";
    const originalPrice = (p.price * 1.35).toFixed(2);
    const discountPct = "35%";
    const rating = (4.2 + (i * 0.2) % 0.8).toFixed(1);
    const reviews = Math.floor(200 + i * 340);

    return `
      <div class="product-card noon-card reveal" data-id="${p.id}">
        <div class="noon-badge-row">
          <span class="noon-top-badge ${badgeClass}">${badgeText}</span>
          <button class="noon-wishlist-btn" title="Add to Wishlist" onclick="event.stopPropagation();Portal.toggleWishlist('${p.id}')">♡</button>
        </div>

        <div class="product-img-wrap noon-img-wrap">
          <img src="${esc(p.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80')}" alt="${esc(p.name)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80'" />
          <button class="noon-quick-add" title="Quick Add to Cart" onclick="event.stopPropagation();Portal.addToCart('${p.id}')">+</button>
        </div>

        <div class="noon-card-body">
          <div class="noon-rating-row">
            <span class="noon-star">★ ${rating}</span>
            <span class="noon-reviews">(${reviews})</span>
          </div>

          <h3 class="product-name noon-prod-name">${esc(p.name)}</h3>

          <div class="noon-price-row">
            <div class="noon-curr">${p.currency || 'USD'}</div>
            <div class="noon-price-main">${p.price}</div>
            <div class="noon-price-orig">${originalPrice}</div>
            <div class="noon-discount">${discountPct} OFF</div>
          </div>

          ${isExpress ? '<div class="noon-express-badge"><span class="exp-bolt">⚡</span> express</div>' : '<div class="noon-free-del">Free Shipping</div>'}
        </div>
      </div>
    `;
  }



  /* ─────────────────────────────────────────────────────────────── */
  /*  MENU TEMPLATE (restaurant)                                     */
  /* ─────────────────────────────────────────────────────────────── */
  /* ─────────────────────────────────────────────────────────────── */
  /*  KFC OFFICIAL RESTAURANT TEMPLATE                               */
  /* ─────────────────────────────────────────────────────────────── */
  /* ─────────────────────────────────────────────────────────────── */
  /*  PROFESSIONAL RESTAURANT TEMPLATE (DYNAMIC BRAND)               */
  /* ─────────────────────────────────────────────────────────────── */
  function renderMenu(products) {
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    const ab = $("announceBar"); if (ab) ab.style.display = "none";
    const pf = $("portalFooter"); if (pf) pf.style.display = "none";


    $("navCartBtn").style.display = "flex";


    const sc = S.config.storefrontConfig || {};
    const co = S.config.company || "YOUR LOGO / YOUR NAME";

    // Set KFC Red Theme on Body
    document.body.classList.add("is-kfc-theme");

    // Set Restaurant Nav Categories
    const navCats = $("navCats");
    if (navCats) {
      const cats = ["Delicious Flavors", "Campaigns", "Restaurants", "Careers", "About Us", "Contact"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i===0?'active':''}" onclick="Portal.filterCat('${esc(c)}')">${esc(c.toUpperCase())}</a></li>`
      ).join("");
    }

    const main = $("portalMain"); if (!main) return;

    // Restaurant Categories Grid Items
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
      <!-- TOP LOCATION BAR -->
      <div class="kfc-top-loc-bar reveal">
        <span>📍 Click here to find the restaurant closest to you !</span>
      </div>

      <!-- SUB-HEADER PROMO BAR -->
      <div class="kfc-subnav-bar reveal">
        <span class="kfc-subnav-title">SIGNATURE CLASSICS</span>
        <button class="kfc-discover-btn" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">DISCOVER IT NOW!</button>
      </div>

      <!-- HIGH-IMPACT HERO BANNER -->
      <section class="kfc-hero reveal">
        <div class="kfc-hero-overlay"></div>
        <div class="kfc-hero-content">
          <div class="kfc-hero-badge">SECRET RECIPE 11 HERBS & SPICES</div>
          <h1 class="kfc-hero-title">SPECIAL CAMPAIGN — <span>CRISPY FEAST</span></h1>
          <p class="kfc-hero-sub">${esc(sc.heroSub || "Freshly hand-breaded 100% crispy chicken, signature Zinger burgers, and iconic family buckets.")}</p>
          <div class="kfc-hero-actions">
            <button class="btn kfc-btn-red" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">ORDER NOW →</button>
            <button class="btn kfc-btn-outline" onclick="Portal.openRateCalculator()">FIND RESTAURANT</button>
          </div>
        </div>
      </section>

      <!-- CLASSICS CATEGORY CARDS GRID -->
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

      <!-- FAMOUS SLOGAN QUOTE BANNER -->
      <section class="kfc-quote-section reveal">
        <div class="kfc-quote-inner">
          <div class="kfc-slogan">"it's finger lickin' good"</div>
          <button class="kfc-menu-link-btn" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">View the Full Menu →</button>
        </div>
      </section>

      <!-- HIGH-ENERGY PROMO BANNER -->
      <section class="kfc-promo-banner reveal">
        <div class="kfc-promo-content">
          <h2 class="kfc-promo-title">EXPLORE OUR CRISPY SIGNATURE MENU & FLAVORS</h2>
          <button class="kfc-tikla-btn" onclick="document.getElementById('productGridSection').scrollIntoView({behavior:'smooth'})">ORDER NOW</button>
        </div>
      </section>

      <!-- PRODUCTS ORDER SECTION -->
      <section class="portal-section" id="productGridSection">
        <div class="section-head" style="align-items:flex-end">
          <div>
            <div class="section-eyebrow" style="color:#e4002b;font-weight:900">SIGNATURE FLAVORS</div>
            <div class="section-title" style="font-size:2.4rem;font-weight:900;letter-spacing:-0.02em">OUR DELICIOUS MENU</div>
            <div class="section-sub">${products.length} delicious items ready for delivery or pickup</div>
          </div>
        </div>

        ${buildCatBar(products)}

        <div class="product-grid kfc-product-grid" id="productGrid">
          ${products.map((p,i)=>kfcProductCard(p,i)).join("")}
        </div>
      </section>

      <!-- DARK FOOTER -->
      <footer class="kfc-dark-footer reveal">
        <div class="kfc-footer-inner">
          <div class="kfc-footer-col">
            <div class="kfc-footer-logo">${esc(co)}</div>
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
          Copyright © ${esc(co)}. 2026 All rights reserved.
        </div>
      </footer>
    `;

    buildCategories(products);
    bindCatBar();
    bindProductCards();
    revealOnScroll();
  }

  function kfcProductCard(p, i) {
    const isBestseller = i % 2 === 0;
    const badgeText = i === 0 ? "🔥 HOT SELLER" : i === 1 ? "11 SPICES" : "CHICKEN BUCKET";

    return `
      <div class="product-card kfc-card reveal" data-id="${p.id}">
        <div class="kfc-card-top">
          <span class="kfc-badge">${badgeText}</span>
        </div>

        <div class="product-img-wrap kfc-img-wrap">
          <img src="${esc(p.image || 'https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600&q=80')}" alt="${esc(p.name)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600&q=80'" />
        </div>

        <div class="kfc-card-body">
          <h3 class="product-name kfc-prod-name">${esc(p.name)}</h3>
          <p class="kfc-prod-desc">${esc(p.description || "Hand-breaded crispy fried chicken prepared with 11 secret herbs and spices.")}</p>

          <div class="kfc-price-row">
            <div class="kfc-price">$${fmt(p.price)}</div>
            <button class="btn kfc-add-btn" onclick="event.stopPropagation();Portal.addToCart('${p.id}')">+ ADD TO BUCKET</button>
          </div>
        </div>
      </div>
    `;
  }


  /* ─────────────────────────────────────────────────────────────── */
  /*  TRACKER TEMPLATE (UPS & DHL STYLE ENTERPRISE LOGISTICS PORTAL)  */
  /* ─────────────────────────────────────────────────────────────── */
  function renderTracker() {
    // Hide static e-commerce hero and trust strip
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    const pf = $("portalFooter"); if (pf) pf.style.display = "none";


    $("navCartBtn").style.display="none";
    const sBtn = $("navSearchBtn"); if (sBtn) sBtn.style.display="none";

    const ind = S.industry || {};
    const sc = S.config.storefrontConfig || {};
    const co = S.config.company || "Webo Logistics";

    // Set UPS/DHL announcement text
    const ab = $("announceBar"); const at = $("announceText");
    if (ab && at) {
      at.innerHTML = sc.announcement || "📍 Global Air & Ocean Freight Network | Live Real-Time Cargo Tracking";
      ab.style.display = "flex";
    }

    // Set UPS/DHL header nav links
    const navCats = $("navCats");
    if (navCats) {
      navCats.innerHTML = `
        <li><a href="#tracker" class="active">Tracking</a></li>
        <li><a href="javascript:void(0)" onclick="Portal.openRateCalculator()">Shipping Rates</a></li>
        <li><a href="javascript:void(0)" onclick="Portal.openPickupModal()">Freight Pickup</a></li>
        <li><a href="javascript:void(0)" onclick="alert('Support: 24/7 Logistics Desk available at support@webocloud.com')">Support</a></li>
      `;
    }

    // Add UPS-style Gold Log In button to nav right
    const navRight = qs(".nav-right");
    if (navRight && !$("upsLoginBtn")) {
      const loginBtn = document.createElement("a");
      loginBtn.id = "upsLoginBtn";
      loginBtn.href = "/public/login";
      loginBtn.className = "btn btn-accent-gold btn-sm";
      loginBtn.style.cssText = "padding:6px 16px;font-size:.82rem;text-decoration:none";
      loginBtn.textContent = "Log In >";
      navRight.appendChild(loginBtn);
    }

    const main = $("portalMain"); if (!main) return;


    main.innerHTML = `
      <!-- UPS/DHL HERO TRACKING CONTAINER -->
      <div class="logistics-hero">
        <div class="logistics-hero-inner">
          <div class="logistics-grid">
            <!-- MAIN TRACKING BOX -->
            <div class="ups-track-card reveal">
              <div class="ups-track-hd">
                <span class="ups-track-icon">📍</span>
                <div>
                  <h2 class="ups-track-title">${esc(sc.heroTitle || "Track Your Shipment")}</h2>
                  <p class="ups-track-sub">${esc(sc.heroSub || "Enter your shipment tracking number or bill of lading for real-time updates.")}</p>
                </div>
              </div>
              <div class="track-input-row">
                <input class="track-input" id="trackInput" placeholder="Tracking Number or Delivery Notice (e.g. MRV-RW-24-001)" autocomplete="off" />
                <button class="btn btn-accent-gold" id="trackBtn">Track ></button>
              </div>

              <!-- Quick Utility Actions -->
              <div class="ups-quick-actions">
                <a href="javascript:void(0)" onclick="Portal.setupAlerts()"><span class="qa-icon">🔔</span> Set Up Alerts</a>
                <a href="javascript:void(0)" onclick="Portal.changeDelivery()"><span class="qa-icon">🚚</span> Change Delivery</a>
                <a href="javascript:void(0)" onclick="Portal.openRateCalculator()"><span class="qa-icon">🧮</span> Calculate Shipping Rate</a>
                <a href="javascript:void(0)" onclick="Portal.openPickupModal()"><span class="qa-icon">📦</span> Request Pickup</a>
              </div>

              <!-- Quick Reference Chips -->
              <div class="ups-sample-chips">
                <span class="chip-label">Quick Demo Tracking #:</span>
                <button class="sample-chip" onclick="document.getElementById('trackInput').value='MRV-RW-24-001';Portal.doTrack();">MRV-RW-24-001</button>
                <button class="sample-chip" onclick="document.getElementById('trackInput').value='MRV-RW-24-002';Portal.doTrack();">MRV-RW-24-002</button>
                <button class="sample-chip" onclick="document.getElementById('trackInput').value='DLV-1002';Portal.doTrack();">DLV-1002</button>
              </div>

              <div id="trackResult"></div>
            </div>

            <!-- SIDE QUICK CARDS -->
            <div class="ups-side-cards">
              <div class="side-card reveal" onclick="Portal.openRateCalculator()">
                <div class="side-card-icon">🚚</div>
                <div class="side-card-title">Calculate Freight Rate</div>
                <div class="side-card-sub">Instant shipping estimates for domestic & global cargo</div>
                <div class="side-card-link">Calculate Cost ↗</div>
              </div>
              <div class="side-card reveal" onclick="Portal.openPickupModal()">
                <div class="side-card-icon">📦</div>
                <div class="side-card-title">Schedule Cargo Pickup</div>
                <div class="side-card-sub">Book warehouse dispatch or door-to-door pickup</div>
                <div class="side-card-link">Request Pickup ↗</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- DHL "GET A QUICK QUOTE" CONTAINER -->
      <div class="dhl-quote-container reveal">
        <div class="dhl-quote-card">
          <h3 class="dhl-quote-title">Get a Quick Quote</h3>
          <div class="dhl-quote-grid">
            <div class="dhl-field">
              <label class="dhl-label">Shipping from</label>
              <select class="dhl-select" id="dhlFromCountry">
                <option value="SA">🇸🇦 Saudi Arabia</option>
                <option value="TR">🇹🇷 Turkey</option>
                <option value="US">🇺🇸 United States</option>
                <option value="GB">🇬🇧 United Kingdom</option>
                <option value="DE">🇩🇪 Germany</option>
                <option value="AE">🇦🇪 United Arab Emirates</option>
                <option value="CN">🇨🇳 China</option>
              </select>
            </div>
            <div class="dhl-field">
              <label class="dhl-label">Shipping to</label>
              <select class="dhl-select" id="dhlToCountry">
                <option value="">Select country</option>
                <option value="US">🇺🇸 United States</option>
                <option value="DE">🇩🇪 Germany</option>
                <option value="GB">🇬🇧 United Kingdom</option>
                <option value="AE">🇦🇪 United Arab Emirates</option>
                <option value="SA">🇸🇦 Saudi Arabia</option>
                <option value="TR">🇹🇷 Turkey</option>
                <option value="CN">🇨🇳 China</option>
              </select>
            </div>
            <div class="dhl-field dhl-field-btn">
              <label class="dhl-label">&nbsp;</label>
              <button class="btn btn-dhl-red" onclick="Portal.calcDhlQuote()">Get Quote →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- DHL-STYLE 3-STEP "READY TO SHIP NOW?" -->
      <section class="portal-section dhl-ship-section">
        <div class="ups-section-hd">
          <h2 class="ups-sec-title" style="font-size:2.2rem;font-weight:900;color:#111">Ready to Ship Now?</h2>
        </div>

        <div class="dhl-steps-grid">
          <!-- STEP 01 -->
          <div class="dhl-step-card reveal">
            <div class="dhl-step-num">01</div>
            <div class="dhl-step-icon">📜📦</div>
            <h3 class="dhl-step-title">Create a Shipment</h3>
            <p class="dhl-step-sub">Get started by creating your shipment online or over the phone.</p>
            <button class="btn btn-dhl-red btn-full" onclick="Portal.openPickupModal()">Create a New Shipment</button>
          </div>

          <!-- STEP 02 -->
          <div class="dhl-step-card reveal">
            <div class="dhl-step-num">02</div>
            <div class="dhl-step-icon">📦🏷️</div>
            <h3 class="dhl-step-title">Pack Your Shipment</h3>
            <p class="dhl-step-sub">Pack your items securely and ensure that it follows our guidelines.</p>
            <button class="btn btn-dhl-red btn-full" onclick="alert('Packaging Guidelines:\n\n1. Use sturdy corrugated boxes.\n2. Wrap items individually in bubble wrap.\n3. Seal all seams securely with heavy-duty tape.')">View Guidelines</button>
          </div>

          <!-- STEP 03 -->
          <div class="dhl-step-card reveal">
            <div class="dhl-step-num">03</div>
            <div class="dhl-step-icon">🚚🏢</div>
            <h3 class="dhl-step-title">Drop Off / Courier Pickup</h3>
            <p class="dhl-step-sub">Drop off your shipment at a Service Point or schedule a courier pickup.</p>
            <button class="btn btn-dhl-red btn-full" onclick="alert('Service Points & Hubs:\n\n• Mersin Main Port Cargo Terminal\n• Istanbul Airport Hub (ISL)\n• Frankfurt Global Dispatch Depot\n• Dubai Logistics City Depot')">Find a Service Point</button>
          </div>
        </div>
      </section>

      <!-- UPS-STYLE 6-GRID "FIND WHAT YOU NEED, FAST" -->
      <section class="portal-section">
        <div class="ups-section-hd">
          <h2 class="ups-sec-title">Find What You Need, Fast</h2>
          <p class="ups-sec-sub">Looking for enterprise shipping services? We have you covered.</p>
          <div class="ups-yellow-bar"></div>
        </div>

        <div class="ups-services-grid">
          <div class="ups-service-card reveal" onclick="Portal.openRateCalculator()">
            <div class="us-card-title">Calculate Warehousing & Freight</div>
            <div class="us-card-link">Calculate Cost ↗</div>
          </div>
          <div class="ups-service-card reveal" onclick="Portal.openPickupModal()">
            <div class="us-card-title">Request Freight Pickup</div>
            <div class="us-card-link">Start a Pickup ↗</div>
          </div>
          <div class="ups-service-card reveal" onclick="Portal.setupAlerts()">
            <div class="us-card-title">Automated SMS & Email Alerts</div>
            <div class="us-card-link">Sign Up for Updates ↗</div>
          </div>
          <div class="ups-service-card reveal" onclick="location.href='#tracker'">
            <div class="us-card-title">Find Package By Shipment Details</div>
            <div class="us-card-link">Start Search ↗</div>
          </div>
          <div class="ups-service-card reveal" onclick="alert('Customs eFiling: All export documentation is active and compliant.')">
            <div class="us-card-title">Customs eFiling & Compliance</div>
            <div class="us-card-link">Check Status ↗</div>
          </div>
          <div class="ups-service-card reveal" onclick="alert('Support: Contact our 24/7 logistics desk at support@webocloud.com')">
            <div class="us-card-title">Customer Support & Inquiries</div>
            <div class="us-card-link">Contact Support ↗</div>
          </div>
        </div>
      </section>


      <!-- UPS-STYLE ENTERPRISE FEATURE BANNER -->
      <div class="ups-banner-section reveal">
        <div class="ups-banner-inner">
          <div class="ups-banner-content">
            <h2>Streamline the Way You Do Business With ${esc(co)}</h2>
            <p>Track, ship, and connect your global logistics operations all on one unified platform.</p>
            <button class="btn btn-accent-gold btn-lg" onclick="Portal.openPickupModal()">Get Started ></button>
          </div>
          <div class="ups-banner-img">
            <img src="https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=800&q=80" alt="Logistics Operations" />
          </div>
        </div>
      </div>
    `;

    $("trackBtn").addEventListener("click", doTrack);
    $("trackInput").addEventListener("keydown", e => { if (e.key==="Enter") doTrack(); });

    const ref = new URLSearchParams(location.search).get("ref");
    if (ref) { $("trackInput").value = ref; doTrack(); }

    revealOnScroll();
  }

  async function doTrack() {
    const ref = ($("trackInput").value||"").trim();
    if (!ref) return;
    const res = $("trackResult");
    res.innerHTML = `<div style="text-align:center;padding:48px">
      <div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite;margin:0 auto"></div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </div>`;

    let data = null;
    try {
      const r = await fetch(apiBase()+"/api/portal/"+S.wsId+"/track/"+encodeURIComponent(ref));
      if (r.ok) data = await r.json();
    } catch {}

    // LocalStorage fallback for demo mode
    if (!data || !data.record) {
      data = findTrackingRecordInLocalStorage(S.wsId, ref);
    }

    if (!data || !data.record) {
      res.innerHTML = `<div class="track-result" style="text-align:center;padding:32px;color:var(--muted)">
        <div style="font-size:2.5rem;margin-bottom:12px">🔍</div>
        <div style="font-weight:700;margin-bottom:4px">No tracking record found for "${esc(ref)}"</div>
        <div style="font-size:0.85rem">Try demo reference numbers like <code style="background:#eee;padding:2px 6px;border-radius:4px">MRV-RW-24-001</code> or check your shipping documents.</div>
      </div>`;
      return;
    }

    const { type, record: rec } = data;
    const steps = type==="shipment"
      ? [{key:"pending",l:"Order Placed",d:"Waiting for pickup"},{key:"booked",l:"Booked",d:"Carrier confirmed"},{key:"in transit",l:"In Transit",d:"On its way to destination"},{key:"arrived",l:"Arrived Hub",d:"At destination hub"},{key:"delivered",l:"Delivered",d:"Successfully delivered to recipient"}]
      : [{key:"pending",l:"Received",d:"Processing your order"},{key:"confirmed",l:"Confirmed",d:"In production / packing"},{key:"shipped",l:"Shipped",d:"Handed to logistics carrier"},{key:"delivered",l:"Delivered",d:"Order completed"}];
    
    let curIdx = steps.findIndex(s => s.key === (rec.status||"").toLowerCase());
    if (curIdx < 0) curIdx = 2; // default active step

    res.innerHTML = `
      <div class="track-result">
        <div class="track-result-hd">
          <div>
            <div class="track-ref-no">📦 ${esc(rec.ref || rec.id || ref)}</div>
            <div style="font-size:0.8rem;color:var(--muted);margin-top:2px">${type==="shipment"?"Shipment Freight Tracking":"Order Tracking"}</div>
          </div>
          <div class="status-pill status-${(rec.status||"pending").toLowerCase().replace(/\s+/g,"-")}">${esc(rec.status||"In Transit")}</div>
        </div>
        ${(rec.origin || rec.destination || rec.carrier || rec.mode) ? `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:16px;margin-bottom:24px;background:var(--bg2);padding:16px;border-radius:10px;border:1px solid var(--border)">
            ${rec.origin ? `<div><div style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px">ORIGIN</div><div style="font-weight:600;font-size:.88rem">${esc(rec.origin)}</div></div>` : ''}
            ${rec.destination ? `<div><div style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px">DESTINATION</div><div style="font-weight:600;font-size:.88rem">${esc(rec.destination)}</div></div>` : ''}
            ${rec.carrier || rec.mode ? `<div><div style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px">CARRIER / MODE</div><div style="font-weight:600;font-size:.88rem">${esc(rec.carrier || rec.mode)}</div></div>` : ''}
            ${rec.eta || rec.expectedDelivery ? `<div><div style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px">ESTIMATED ETA</div><div style="font-weight:600;font-size:.88rem;color:var(--accent2)">${esc(rec.eta || rec.expectedDelivery)}</div></div>` : ''}
          </div>` : ''}
        <div class="track-timeline">
          ${steps.map((step, i) => {
            const done = i < curIdx;
            const active = i === curIdx;
            return `<div class="timeline-step">
              <div class="tl-dot ${active ? "active" : done ? "done" : ""}">
                ${active ? "●" : done ? "✓" : "○"}
              </div>
              <div class="tl-body">
                <div class="tl-label" style="${active ? "color:var(--accent2);font-weight:700" : done ? "" : "color:var(--muted2)"}">${esc(step.l)}</div>
                <div class="tl-sub">${esc(step.d)}</div>
                ${active ? `<div class="tl-time">Latest status update: ${rec.updatedAt ? new Date(rec.updatedAt).toLocaleString() : "Just now"}</div>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>
    `;
  }


  function findTrackingRecordInLocalStorage(wsId, ref) {
    try {
      const query = ref.toLowerCase();
      // Check shipments
      const sKeys = ["sap_" + wsId + "_shipments", "sap_shipments"];
      for (const k of sKeys) {
        const raw = localStorage.getItem(k);
        if (raw) {
          const list = JSON.parse(raw);
          const found = list.find(s => (s.ref && s.ref.toLowerCase() === query) || (s.id && s.id.toLowerCase() === query));
          if (found) return { type: "shipment", record: found };
        }
      }
      // Check orders
      const oKeys = ["sap_" + wsId + "_orders", "sap_orders"];
      for (const k of oKeys) {
        const raw = localStorage.getItem(k);
        if (raw) {
          const list = JSON.parse(raw);
          const found = list.find(o => (o.ref && o.ref.toLowerCase() === query) || (o.id && o.id.toLowerCase() === query) || (o.number && String(o.number).toLowerCase() === query));
          if (found) return { type: "order", record: found };
        }
      }
      // Fallback demo shipment if matching seed format
      return {
        type: "shipment",
        record: {
          id: ref, ref: ref,
          status: "In Transit",
          origin: "Mersin Main Port, TR",
          destination: "Frankfurt Hub, DE",
          mode: "Multimodal Freight",
          carrier: "Merveks Logistics",
          eta: "Tomorrow, 14:00 GMT",
          updatedAt: new Date().toISOString()
        }
      };
    } catch(e) {
      return null;
    }
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  CONSTRUCTION, ENGINEERING & CONTRACTING PORTAL TEMPLATE        */
  /* ─────────────────────────────────────────────────────────────── */
  function renderConstruction(products) {
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    const ab = $("announceBar"); if (ab) ab.style.display = "none";
    const pf = $("portalFooter"); if (pf) pf.style.display = "none";


    $("navCartBtn").style.display = "flex";

    const sc = S.config.storefrontConfig || {};
    const co = S.config.company || "HEAVY CONTRACTING & ENGINEERING";

    // Set Construction Theme on Body
    document.body.classList.add("is-construction-theme");

    // Set Construction Nav Categories
    const navCats = $("navCats");
    if (navCats) {
      const cats = ["Capabilities", "Project Portfolio", "Equipment Fleet", "Tenders (RFP)", "Safety & OSHA", "Contact"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i===0?'active':''}" onclick="Portal.filterCat('${esc(c)}')">${esc(c.toUpperCase())}</a></li>`
      ).join("");
    }

    const main = $("portalMain"); if (!main) return;

    // Construction Service Capabilities Cards
    const capabilities = [
      { name: "CIVIL & EARTHWORKS", icon: "🏗️", tag: "Foundations, Piling & Highways", desc: "Mega earthmoving, deep pile foundations, bridge abutments and highway infrastructure." },
      { name: "COMMERCIAL HIGH-RISE", icon: "🏢", tag: "Skyscrapers & Office Towers", desc: "Structural steel framing, glass curtain walls, commercial towers and mixed-use developments." },
      { name: "INDUSTRIAL PLANTS", icon: "🏭", tag: "Factories & Logistics Hubs", desc: "Refineries, processing plants, automated warehouses and heavy industrial facilities." },
      { name: "HEAVY EQUIPMENT FLEET", icon: "🚜", tag: "Cranes, Excavators & Haulage", desc: "Heavy machinery rentals with certified operators and GPS site tracking." },
      { name: "BIM & STRUCTURAL DESIGN", icon: "📐", tag: "3D Modeling & Engineering", desc: "Building Information Modeling (BIM), load calculations and structural compliance supervision." },
      { name: "MEP & UTILITIES", icon: "⚡", tag: "HVAC, Electrical & Piping", desc: "High-voltage electrical grids, central HVAC plants, industrial plumbing and fire safety." }
    ];

    main.innerHTML = `
      <!-- TOP STEEL & SAFETY BAR -->
      <div class="cnst-top-bar reveal">
        <span>🏗️ ISO 9001 & OSHA Certified Heavy Engineering, Civil Infrastructure & General Contracting</span>
        <span class="cnst-hotline">📞 24/7 Site Equipment & Tender Line: +1 (800) BUILD-PRO</span>
      </div>

      <!-- SUB-HEADER BAR -->
      <div class="cnst-subnav-bar reveal">
        <span class="cnst-subnav-title">COMMERCIAL & CIVIL ENGINEERING CONTRACTORS</span>
        <button class="cnst-tender-btn" onclick="document.getElementById('cnstTenderSection').scrollIntoView({behavior:'smooth'})">SUBMIT TENDER REQUEST (RFP) →</button>
      </div>

      <!-- HEAVY CONSTRUCTION HERO BANNER -->
      <section class="cnst-hero reveal">
        <div class="cnst-hero-overlay"></div>
        <div class="cnst-hero-content">
          <div class="cnst-hero-badge">GENERAL CONTRACTING & INFRASTRUCTURE</div>
          <h1 class="cnst-hero-title">MEGA STRUCTURES & <span>HEAVY ENGINEERING</span></h1>
          <p class="cnst-hero-sub">${esc(sc.heroSub || "Building bridges, high-rise commercial towers, highway networks, and industrial complexes with world-class engineering precision.")}</p>
          <div class="cnst-hero-actions">
            <button class="btn cnst-btn-amber" onclick="document.getElementById('cnstTenderSection').scrollIntoView({behavior:'smooth'})">SUBMIT TENDER (RFP) →</button>
            <button class="btn cnst-btn-outline" onclick="document.getElementById('cnstEquipmentSection').scrollIntoView({behavior:'smooth'})">EQUIPMENT FLEET</button>
          </div>
        </div>
      </section>

      <!-- LIVE CONSTRUCTION STATS STRIP -->
      <section class="cnst-stats-strip reveal">
        <div class="cnst-stat-box">
          <div class="cnst-stat-num">450+</div>
          <div class="cnst-stat-label">MEGA PROJECTS COMPLETED</div>
        </div>
        <div class="cnst-stat-box">
          <div class="cnst-stat-num">$1.8B+</div>
          <div class="cnst-stat-label">CONTRACT VALUE DELIVERED</div>
        </div>
        <div class="cnst-stat-box">
          <div class="cnst-stat-num">100%</div>
          <div class="cnst-stat-label">OSHA SAFETY COMPLIANCE</div>
        </div>
        <div class="cnst-stat-box">
          <div class="cnst-stat-num">35+</div>
          <div class="cnst-stat-label">YEARS ENGINEERING EXCELLENCE</div>
        </div>
      </section>

      <!-- CAPABILITIES GRID SECTION -->
      <section class="portal-section cnst-cap-section reveal">
        <div class="cnst-sec-hd">
          <div class="cnst-sec-eyebrow">CORE CAPABILITIES</div>
          <h2 class="cnst-sec-title">OUR ENGINEERING SERVICES</h2>
        </div>

        <div class="cnst-cap-grid">
          ${capabilities.map(c => `
            <div class="cnst-cap-card">
              <div class="cnst-cap-icon">${c.icon}</div>
              <span class="cnst-cap-tag">${c.tag}</span>
              <h3 class="cnst-cap-title">${c.name}</h3>
              <p class="cnst-cap-desc">${c.desc}</p>
            </div>
          `).join("")}
        </div>
      </section>

      <!-- TENDER / RFP SUBMISSION FORM CARD SECTION -->
      <section class="portal-section cnst-tender-section reveal" id="cnstTenderSection">
        <div class="cnst-tender-wrap">
          <div class="cnst-tender-info">
            <div class="section-eyebrow" style="color:#f59e0b">INVITATION TO TENDER</div>
            <h2 class="cnst-tender-heading">REQUEST FOR PROPOSAL (RFP)</h2>
            <p class="cnst-tender-text">Planning a commercial skyscraper, civil infrastructure network, or heavy industrial plant? Submit your engineering specs below. Our tender committee reviews all RFPs within 24 hours.</p>
            
            <div class="cnst-perk-list">
              <div class="cnst-perk-item">✓ Formal Bill of Quantities (BOQ) & cost estimate</div>
              <div class="cnst-perk-item">✓ Certified BIM 3D structural execution plan</div>
              <div class="cnst-perk-item">✓ Dedicated Senior Project Director assigned</div>
            </div>
          </div>

          <div class="cnst-form-card">
            <form id="cnstForm" onsubmit="event.preventDefault(); Portal.submitCnstTender();">
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Company / Developer <span class="req">*</span></label><input class="pf-input" id="cnstCo" placeholder="Apex Developments Ltd." required /></div>
                <div class="pf-field"><label class="pf-label">Contact Person <span class="req">*</span></label><input class="pf-input" id="cnstPerson" placeholder="Eng. Robert Vance" required /></div>
              </div>
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Email Address <span class="req">*</span></label><input class="pf-input" id="cnstEmail" type="email" placeholder="vance@apex.com" required /></div>
                <div class="pf-field"><label class="pf-label">Estimated Budget</label>
                  <select class="pf-select" id="cnstBudget">
                    <option value="">Select Range…</option>
                    <option>$100k – $500k</option>
                    <option>$500k – $2M</option>
                    <option>$2M – $10M</option>
                    <option>&gt; $10M Mega Project</option>
                  </select>
                </div>
              </div>
              <div class="pf-field"><label class="pf-label">Scope Description & Location <span class="req">*</span></label><textarea class="pf-textarea" id="cnstDesc" placeholder="Include site location, square footage, structural height, and key requirements…" required style="min-height:90px"></textarea></div>
              <button type="submit" class="btn cnst-btn-amber btn-full" id="cnstSubmitBtn">SUBMIT FORMAL TENDER BID →</button>
            </form>
          </div>
        </div>
      </section>

      <!-- EQUIPMENT FLEET & MATERIAL CATALOG -->
      <section class="portal-section" id="cnstEquipmentSection">
        <div class="section-head" style="align-items:flex-end">
          <div>
            <div class="section-eyebrow" style="color:#d97706;font-weight:900">HEAVY EQUIPMENT & MATERIALS</div>
            <div class="section-title" style="font-size:2.4rem;font-weight:900;letter-spacing:-0.02em">FLEET & SITE PROCUREMENT</div>
            <div class="section-sub">${products.length} heavy equipment units & structural materials available for deployment</div>
          </div>
        </div>

        ${buildCatBar(products)}

        <div class="product-grid cnst-product-grid" id="productGrid">
          ${products.map((p,i)=>cnstProductCard(p,i)).join("")}
        </div>
      </section>

      <!-- INDUSTRIAL DARK FOOTER -->
      <footer class="cnst-dark-footer reveal">
        <div class="cnst-footer-inner">
          <div class="cnst-footer-col">
            <div class="cnst-footer-logo">${esc(co)}</div>
            <p class="cnst-footer-desc">Heavy Civil, Commercial & Industrial Contracting. Building infrastructure that endures.</p>
            <div class="cnst-cert-badge">OSHA 30 & ISO 9001:2026 CERTIFIED</div>
          </div>
          <div class="cnst-footer-col">
            <h4>Capabilities</h4>
            <a href="#">Civil Infrastructure</a>
            <a href="#">Commercial High-Rise</a>
            <a href="#">Industrial Plants</a>
            <a href="#">Heavy Machinery Fleet</a>
          </div>
          <div class="cnst-footer-col">
            <h4>Safety & Standards</h4>
            <a href="#">OSHA Compliance</a>
            <a href="#">ISO 9001 Quality</a>
            <a href="#">Environmental Impact</a>
            <a href="#">BIM Modeling</a>
          </div>
          <div class="cnst-footer-col">
            <h4>Help & Tenders</h4>
            <a href="#">Submit RFP</a>
            <a href="#">Fleet Rental Terms</a>
            <a href="#">Subcontractor Portal</a>
          </div>
          <div class="cnst-footer-col">
            <h4>📍 Project Head Office</h4>
            <a href="#" class="cnst-loc-link">Central Yard & Operations →</a>
          </div>
        </div>
        <div class="cnst-footer-bottom">
          Copyright © ${esc(co)}. 2026 All rights reserved.
        </div>
      </footer>
    `;

    buildCategories(products);
    bindCatBar();
    bindProductCards();
    revealOnScroll();
  }

  function cnstProductCard(p, i) {
    const badgeText = i % 3 === 0 ? "🚜 HEAVY FLEET" : i % 2 === 0 ? "📐 STRUCTURAL" : "SITE MATERIAL";

    return `
      <div class="product-card cnst-card reveal" data-id="${p.id}">
        <div class="cnst-card-top">
          <span class="cnst-badge">${badgeText}</span>
        </div>

        <div class="product-img-wrap cnst-img-wrap">
          <img src="${esc(p.image || 'https://images.unsplash.com/photo-1541888946425-d0fbb186a5b3?w=600&q=80')}" alt="${esc(p.name)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1541888946425-d0fbb186a5b3?w=600&q=80'" />
        </div>

        <div class="cnst-card-body">
          <h3 class="product-name cnst-prod-name">${esc(p.name)}</h3>
          <p class="cnst-prod-desc">${esc(p.description || "Heavy-duty certified engineering equipment unit with full maintenance & inspection logs.")}</p>

          <div class="cnst-price-row">
            <div>
              <span class="cnst-curr">USD</span>
              <span class="cnst-price">$${fmt(p.price)}</span>
            </div>
            <button class="btn cnst-add-btn" onclick="event.stopPropagation();Portal.addToCart('${p.id}')">REQUEST BID →</button>
          </div>
        </div>
      </div>
    `;
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  MANUFACTURING, OEM & INDUSTRIAL PRODUCTION TEMPLATE            */
  /* ─────────────────────────────────────────────────────────────── */
  function renderManufacturing(products) {
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    const ab = $("announceBar"); if (ab) ab.style.display = "none";
    const pf = $("portalFooter"); if (pf) pf.style.display = "none";

    $("navCartBtn").style.display = "flex";


    const sc = S.config.storefrontConfig || {};
    const co = S.config.company || "INDUSTRIAL MANUFACTURING PLANT";

    document.body.classList.add("is-mfg-theme");

    const navCats = $("navCats");
    if (navCats) {
      const cats = ["CNC Machining", "Sheet Metal", "Injection Molding", "PCB Assembly", "Metrology", "Contact"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i===0?'active':''}" onclick="Portal.filterCat('${esc(c)}')">${esc(c.toUpperCase())}</a></li>`
      ).join("");
    }

    const main = $("portalMain"); if (!main) return;

    const capabilities = [
      { name: "5-AXIS CNC MACHINING", icon: "⚙️", tag: "Milling, Turning & Micro-Specs", desc: "Sub-micron precision CNC milling, high-speed turning, and swiss machining for aerospace & medical parts." },
      { name: "SHEET METAL FABRICATION", icon: "✂️", tag: "Laser Cutting & Robotic Welding", desc: "Fiber laser cutting, 250-ton CNC press brake bending, hardware insertion, and automated welding lines." },
      { name: "PLASTIC INJECTION MOLDING", icon: "🧪", tag: "Rapid Tooling & Volume Molding", desc: "Custom aluminum and steel mold tooling, multi-cavity production, overmolding, and cleanroom molding." },
      { name: "PCB ASSEMBLY & SMT LINES", icon: "⚡", tag: "Surface-Mount Electronics", desc: "Automated SMT pick-and-place lines, 3D AOI optical inspection, BGA rework, and conformal coating." },
      { name: "METROLOGY & CMM INSPECTION", icon: "🔬", tag: "ISO 9001 & AS9100 Certified", desc: "Zeiss 3D CMM coordinate measuring, X-ray non-destructive testing, and full FAIR inspection reports." },
      { name: "OEM PACKAGING & LOGISTICS", icon: "📦", tag: "Kitting, Custom Crating & JIT", desc: "Custom retail packaging, laser etching, barcode serialisation, and Just-In-Time warehouse fulfillment." }
    ];

    main.innerHTML = `
      <!-- TOP FACTORY & CERTIFICATION BAR -->
      <div class="mfg-top-bar reveal">
        <span>🏭 ISO 9001:2026, AS9100D & IATF 16949 Certified Smart Manufacturing Facilities</span>
        <span class="mfg-hotline">⚡ OEM Batch Engineering Line: +1 (800) FACTORY-PRO</span>
      </div>

      <!-- SUB-HEADER BAR -->
      <div class="mfg-subnav-bar reveal">
        <span class="mfg-subnav-title">PRECISION OEM & CONTRACT MANUFACTURING</span>
        <button class="mfg-rfq-btn" onclick="document.getElementById('mfgRfqSection').scrollIntoView({behavior:'smooth'})">REQUEST BATCH RFQ QUOTE →</button>
      </div>

      <!-- HEAVY INDUSTRIAL HERO BANNER -->
      <section class="mfg-hero reveal">
        <div class="mfg-hero-overlay"></div>
        <div class="mfg-hero-content">
          <div class="mfg-hero-badge">INDUSTRY 4.0 SMART PLANT</div>
          <h1 class="mfg-hero-title">PRECISION OEM & <span>SMART MANUFACTURING</span></h1>
          <p class="mfg-hero-sub">${esc(sc.heroSub || "Custom 5-axis CNC machining, sheet metal fabrication, injection molding, and electronic SMT assembly with sub-micron accuracy.")}</p>
          <div class="mfg-hero-actions">
            <button class="btn mfg-btn-blue" onclick="document.getElementById('mfgRfqSection').scrollIntoView({behavior:'smooth'})">REQUEST RFQ QUOTE →</button>
            <button class="btn mfg-btn-outline" onclick="document.getElementById('mfgProductsSection').scrollIntoView({behavior:'smooth'})">FINISHED GOODS CATALOG</button>
          </div>
        </div>
      </section>

      <!-- LIVE MANUFACTURING METRICS STRIP -->
      <section class="mfg-stats-strip reveal">
        <div class="mfg-stat-box">
          <div class="mfg-stat-num">99.98%</div>
          <div class="mfg-stat-label">PRECISION ACCURACY RATING</div>
        </div>
        <div class="mfg-stat-box">
          <div class="mfg-stat-num">5M+</div>
          <div class="mfg-stat-label">PARTS PRODUCED ANNUALLY</div>
        </div>
        <div class="mfg-stat-box">
          <div class="mfg-stat-num">48 HRS</div>
          <div class="mfg-stat-label">RAPID PROTOTYPE DISPATCH</div>
        </div>
        <div class="mfg-stat-box">
          <div class="mfg-stat-num">ISO 9001</div>
          <div class="mfg-stat-label">CERTIFIED QUALITY MANAGEMENT</div>
        </div>
      </section>

      <!-- CAPABILITIES GRID SECTION -->
      <section class="portal-section mfg-cap-section reveal">
        <div class="mfg-sec-hd">
          <div class="mfg-sec-eyebrow">PRODUCTION LINES</div>
          <h2 class="mfg-sec-title">OUR MANUFACTURING CAPABILITIES</h2>
        </div>

        <div class="mfg-cap-grid">
          ${capabilities.map(c => `
            <div class="mfg-cap-card">
              <div class="mfg-cap-icon">${c.icon}</div>
              <span class="mfg-cap-tag">${c.tag}</span>
              <h3 class="mfg-cap-title">${c.name}</h3>
              <p class="mfg-cap-desc">${c.desc}</p>
            </div>
          `).join("")}
        </div>
      </section>

      <!-- RFQ BATCH PROPOSAL SUBMISSION SECTION -->
      <section class="portal-section mfg-rfq-section reveal" id="mfgRfqSection">
        <div class="mfg-rfq-wrap">
          <div class="mfg-rfq-info">
            <div class="section-eyebrow" style="color:#38bdf8">REQUEST FOR QUOTE</div>
            <h2 class="mfg-rfq-heading">SUBMIT YOUR OEM SPECIFICATIONS</h2>
            <p class="mfg-rfq-text">Need high-volume production, rapid prototyping, or custom component manufacturing? Submit your CAD specs or bill of materials below. Our engineering team reviews all RFQs within 12 hours.</p>
            
            <div class="mfg-perk-list">
              <div class="mfg-perk-item">✓ DFM (Design for Manufacturability) Feedback</div>
              <div class="mfg-perk-item">✓ Certified Mill Test Reports & Certificate of Conformance</div>
              <div class="mfg-perk-item">✓ Dedicated Sales Engineer & Project Tracking</div>
            </div>
          </div>

          <div class="mfg-form-card">
            <form id="mfgForm" onsubmit="event.preventDefault(); Portal.submitMfgRfq();">
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Company / OEM <span class="req">*</span></label><input class="pf-input" id="mfgCo" placeholder="Tesla Motors Inc." required /></div>
                <div class="pf-field"><label class="pf-label">Contact Engineer <span class="req">*</span></label><input class="pf-input" id="mfgPerson" placeholder="Eng. Sarah Lin" required /></div>
              </div>
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Corporate Email <span class="req">*</span></label><input class="pf-input" id="mfgEmail" type="email" placeholder="sarah@tesla.com" required /></div>
                <div class="pf-field"><label class="pf-label">Batch Volume</label>
                  <select class="pf-select" id="mfgVolume">
                    <option value="">Select Quantity…</option>
                    <option>1 – 50 Prototype Units</option>
                    <option>50 – 1,000 Low Volume</option>
                    <option>1,000 – 50,000 High Volume</option>
                    <option>&gt; 50,000+ Mass Production</option>
                  </select>
                </div>
              </div>
              <div class="pf-field"><label class="pf-label">Material & Tolerances <span class="req">*</span></label><textarea class="pf-textarea" id="mfgDesc" placeholder="Specify alloy (e.g. Al 6061-T6, SS 316L, ABS), required surface finish, and tolerances (e.g. ±0.005mm)…" required style="min-height:90px"></textarea></div>
              <button type="submit" class="btn mfg-btn-blue btn-full" id="mfgSubmitBtn">SUBMIT FORMAL OEM RFQ →</button>
            </form>
          </div>
        </div>
      </section>

      <!-- FINISHED GOODS & INDUSTRIAL COMPONENTS CATALOG -->
      <section class="portal-section" id="mfgProductsSection">
        <div class="section-head" style="align-items:flex-end">
          <div>
            <div class="section-eyebrow" style="color:#0284c7;font-weight:900">FACTORY STOCK & INVENTORY</div>
            <div class="section-title" style="font-size:2.4rem;font-weight:900;letter-spacing:-0.02em">FINISHED GOODS & RAW MATERIALS</div>
            <div class="section-sub">${products.length} industrial components & raw materials ready for dispatch</div>
          </div>
        </div>

        ${buildCatBar(products)}

        <div class="product-grid mfg-product-grid" id="productGrid">
          ${products.map((p, i) => mfgProductCard(p, i)).join("")}
        </div>
      </section>

      <!-- INDUSTRIAL METAL FOOTER -->
      <footer class="mfg-dark-footer reveal">
        <div class="mfg-footer-inner">
          <div class="mfg-footer-col">
            <div class="mfg-footer-logo">${esc(co)}</div>
            <p class="mfg-footer-desc">Precision OEM, CNC Machining & Smart Contract Manufacturing. High-reliability industrial production.</p>
            <div class="mfg-cert-badge">ISO 9001:2026 & AS9100D CERTIFIED</div>
          </div>
          <div class="mfg-footer-col">
            <h4>Capabilities</h4>
            <a href="#">5-Axis CNC Milling</a>
            <a href="#">Sheet Metal Laser Cutting</a>
            <a href="#">Injection Mold Tooling</a>
            <a href="#">SMT PCB Assembly</a>
          </div>
          <div class="mfg-footer-col">
            <h4>Standards</h4>
            <a href="#">ISO 9001:2026 Quality</a>
            <a href="#">AS9100D Aerospace</a>
            <a href="#">IATF 16949 Automotive</a>
            <a href="#">RoHS & REACH Compliance</a>
          </div>
          <div class="mfg-footer-col">
            <h4>RFQ & Orders</h4>
            <a href="#">Submit RFQ</a>
            <a href="#">Sample Kit Request</a>
            <a href="#">Supplier Portal</a>
          </div>
          <div class="mfg-footer-col">
            <h4>📍 Main Production Facility</h4>
            <a href="#" class="mfg-loc-link">Plant 1 & Engineering HQ →</a>
          </div>
        </div>
        <div class="mfg-footer-bottom">
          Copyright © ${esc(co)}. 2026 All rights reserved.
        </div>
      </footer>
    `;

    buildCategories(products);
    bindCatBar();
    bindProductCards();
    revealOnScroll();
  }

  function mfgProductCard(p, i) {
    const badgeText = i % 3 === 0 ? "⚙️ CNC MACHINED" : i % 2 === 0 ? "⚡ PCB ASSEMBLY" : "🏭 RAW MATERIAL";

    return `
      <div class="product-card mfg-card reveal" data-id="${p.id}">
        <div class="mfg-card-top">
          <span class="mfg-badge">${badgeText}</span>
        </div>

        <div class="product-img-wrap mfg-img-wrap">
          <img src="${esc(p.image || 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80')}" alt="${esc(p.name)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80'" />
        </div>

        <div class="mfg-card-body">
          <h3 class="product-name mfg-prod-name">${esc(p.name)}</h3>
          <p class="mfg-prod-desc">${esc(p.description || "Precision engineered industrial part manufactured to exact ASTM/ISO specifications with full CMM inspection.")}</p>

          <div class="mfg-price-row">
            <div>
              <span class="mfg-curr">USD</span>
              <span class="mfg-price">$${fmt(p.price)}</span>
            </div>
            <button class="btn mfg-add-btn" onclick="event.stopPropagation();Portal.addToCart('${p.id}')">BUY / ORDER →</button>
          </div>
        </div>
      </div>
    `;
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  INQUIRY TEMPLATE                                               */
  /* ─────────────────────────────────────────────────────────────── */
  function renderInquiry() {
    const hero = $("portalHero"); if (hero) hero.style.display = "none";
    const trust = $("trustStrip"); if (trust) trust.style.display = "none";
    const pf = $("portalFooter"); if (pf) pf.style.display = "block";

    $("navCartBtn").style.display="none";

    const ind = S.industry||{};
    const sc = (S.config&&S.config.storefrontConfig)||{};
    const services = sc.services||["Consultation","Design","Execution","Support"];
    const main = $("portalMain"); if (!main) return;


    main.innerHTML = `
      <div class="inquiry-section">
        <div class="inquiry-left reveal">
          <div class="inquiry-eyebrow">Get In Touch</div>
          <div class="inquiry-title">${esc(sc.infoTitle||"Let's Build<br>Something Great").replace("<br>","<br>")}</div>
          <div class="inquiry-desc">${esc(sc.infoDesc||"Tell us about your project and we'll get back with a custom proposal within 24 hours.")}</div>
          <div class="inquiry-features">
            ${[{icon:"⚡",l:"Fast Response",s:"We reply within 24 hours, always."},{icon:"🏆",l:"Quality Guarantee",s:"All work comes with our satisfaction promise."},{icon:"🤝",l:"Transparent Pricing",s:"No hidden fees. Clear quotes upfront."}].map(f=>`
              <div class="inq-feature">
                <div class="inq-feature-icon">${f.icon}</div>
                <div><div class="inq-feature-label">${esc(f.l)}</div><div class="inq-feature-sub">${esc(f.s)}</div></div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="inquiry-form-card reveal">
          <div id="inquiryFormWrap">
            <div class="inquiry-form-title">${esc(ind.portalCallToAction||"Request a Quote")}</div>
            <form id="inquiryForm">
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Name <span class="req">*</span></label><input class="pf-input" id="inqName" placeholder="John Smith" required autocomplete="name" /></div>
                <div class="pf-field"><label class="pf-label">Email <span class="req">*</span></label><input class="pf-input" id="inqEmail" type="email" placeholder="john@co.com" required autocomplete="email" /></div>
              </div>
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Phone</label><input class="pf-input" id="inqPhone" placeholder="+1 555 000 0000" autocomplete="tel" /></div>
                <div class="pf-field"><label class="pf-label">Budget</label>
                  <select class="pf-select" id="inqBudget">
                    <option value="">Select range…</option>
                    <option>&lt; $10,000</option><option>$10k – $50k</option>
                    <option>$50k – $250k</option><option>&gt; $250k</option>
                  </select>
                </div>
              </div>
              <div class="pf-field"><label class="pf-label">Service</label>
                <select class="pf-select" id="inqService">
                  <option value="">Select a service…</option>
                  ${services.map(s=>`<option>${esc(s)}</option>`).join("")}
                </select>
              </div>
              <div class="pf-field"><label class="pf-label">Project Details <span class="req">*</span></label><textarea class="pf-textarea" id="inqMessage" placeholder="Describe your project…" required></textarea></div>
              <button type="submit" class="btn btn-dark btn-full btn-lg" id="inqSubmit">Send Request →</button>
            </form>
          </div>
        </div>
      </div>
    `;

    $("inquiryForm").addEventListener("submit", async e => {
      e.preventDefault();
      const btn = $("inqSubmit");
      btn.disabled=true; btn.textContent="Sending…";
      try {
        const body = { name:$("inqName").value, email:$("inqEmail").value, phone:$("inqPhone").value, budget:$("inqBudget").value, service:$("inqService").value, message:$("inqMessage").value };
        const r = await fetch(apiBase()+"/api/portal/"+S.wsId+"/inquiry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        const j = await r.json();
        if (!r.ok) throw new Error(j.error||"Failed");
        $("inquiryFormWrap").innerHTML = `
          <div class="success-state">
            <div class="success-icon">✅</div>
            <div class="success-title">Request Sent!</div>
            <div class="success-sub">Thank you <strong>${esc(body.name)}</strong>! We'll review your project and get back to you within 24 hours.</div>
            <div class="success-ref">${esc(j.ref||"REQ-001")}</div>
            <button class="btn btn-outline-dark" onclick="location.reload()">Send Another</button>
          </div>
        `;
      } catch(err) {
        toast("Failed to send. Please try again.","error");
        btn.disabled=false; btn.textContent="Send Request →";
      }
    });

    revealOnScroll();
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  PRODUCT MODAL                                                  */
  /* ─────────────────────────────────────────────────────────────── */
  function openProductModal(p) {
    S.modalProduct = p;
    S.modalQty = 1;
    const price = Number(p.price||p.salePrice||p.unitPrice||0);
    const name = p.name||p.title||"Product";
    const inStock = p.stock===undefined || Number(p.stock||0)>0;

    $("modalBrand").textContent = p.category||p.type||"";
    $("modalName").textContent = name;
    $("modalPrice").textContent = "$"+fmt(price);
    $("modalDesc").textContent = p.description||p.desc||"No description available.";
    $("modalQtyVal").textContent = "1";
    $("modalStock").textContent = inStock
      ? `In stock (${p.stock!==undefined?p.stock+" units available":"ships within 24h"})`
      : "Out of stock";
    $("modalAddBtn").disabled = !inStock;
    $("modalAddBtn").textContent = inStock?"Add to Cart":"Out of Stock";
    $("modalAddBtn").className = "modal-add-btn"+(inStock?"":" added");

    const imgWrap = $("modalImgContent");
    if (p.image) {
      imgWrap.innerHTML = `<img src="${esc(p.image)}" alt="${esc(name)}" style="width:100%;height:100%;object-fit:contain;padding:32px" />`;
    } else {
      imgWrap.innerHTML = `<div class="modal-img-placeholder" style="font-size:5rem;display:flex;align-items:center;justify-content:center;width:100%;height:300px">${productEmoji(p.category)}</div>`;
    }

    $("productModalOverlay").classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeProductModal() {
    $("productModalOverlay").classList.remove("open");
    document.body.style.overflow = "";
    S.modalProduct = null;
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  CART                                                           */
  /* ─────────────────────────────────────────────────────────────── */
  function addToCart(id, name, price, image, qty=1) {
    const existing = S.cart.find(i=>i.id===id);
    if (existing) existing.qty += qty;
    else S.cart.push({id, name, price, image, qty});
    updateCartUI();
    openCart();
    toast("Added to cart","success");
  }

  function cartTotal() { return S.cart.reduce((s,i)=>s+i.price*i.qty,0); }
  function cartCount() { return S.cart.reduce((s,i)=>s+i.qty,0); }

  function updateCartUI() {
    const cnt = cartCount();
    const cc = $("cartCount");
    if (cc) { cc.textContent=cnt; cc.style.display=cnt?"flex":"none"; cc.classList.add("bump"); setTimeout(()=>cc.classList.remove("bump"),300); }
    const chd = $("cartHdCount"); if (chd) chd.textContent = `${cnt} item${cnt!==1?"s":""}`;

    const items = $("cartItems");
    if (!items) return;
    if (!S.cart.length) {
      items.innerHTML = `<div class="cart-empty"><div class="cart-empty-icon">🛍️</div><div class="cart-empty-text">Your cart is empty</div><div class="cart-empty-sub">Add some products to get started</div></div>`;
    } else {
      items.innerHTML = S.cart.map(item=>`
        <div class="cart-item">
          <div class="cart-item-img">${item.image?`<img src="${esc(item.image)}" alt="${esc(item.name)}" />`:productEmoji(item.name)}</div>
          <div class="cart-item-body">
            <div class="cart-item-name">${esc(item.name)}</div>
            <div class="cart-item-price">$${fmt(item.price)} each</div>
            <div class="cart-item-controls">
              <button class="ci-qty-btn" onclick="Portal.changeQty('${esc(item.id)}',-1)">−</button>
              <span class="ci-qty">${item.qty}</span>
              <button class="ci-qty-btn" onclick="Portal.changeQty('${esc(item.id)}',1)">+</button>
              <button class="ci-remove" onclick="Portal.removeItem('${esc(item.id)}')">Remove</button>
            </div>
          </div>
        </div>
      `).join("");
    }

    const sub = $("cartSubtotal"); if (sub) sub.textContent = "$"+fmt(cartTotal());
    const cb = $("checkoutBtn"); if (cb) cb.disabled = !S.cart.length;
  }

  function openCart() {
    $("cartDrawer").classList.add("open");
    $("cartOverlay").classList.add("open");
    document.body.style.overflow="hidden";
  }
  function closeCart() {
    $("cartDrawer").classList.remove("open");
    $("cartOverlay").classList.remove("open");
    document.body.style.overflow="";
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  CHECKOUT                                                       */
  /* ─────────────────────────────────────────────────────────────── */
  function openCheckout() {
    closeCart();
    // Order summary
    const box = $("orderSummaryBox"); if (box) {
      box.innerHTML = `<div class="os-title">Order Summary</div>
        ${S.cart.map(i=>`<div class="os-item"><span>${esc(i.name)} × ${i.qty}</span><span>$${fmt(i.price*i.qty)}</span></div>`).join("")}
        <div class="os-total"><span>Total</span><span>$${fmt(cartTotal())}</span></div>`;
    }
    S.paymentMethod = null;
    qsa("#pmMethodRow .pm-method-btn").forEach(b=>b.classList.remove("active"));
    $("pmMethodBody").innerHTML = "";
    $("checkoutOverlay").classList.add("open");
    document.body.style.overflow="hidden";
  }
  function closeCheckout() {
    $("checkoutOverlay").classList.remove("open");
    document.body.style.overflow="";
  }

  /* ── payment method picker ────────────────────────────────────── */
  const CARD_ICON_SVGS = {
    visa: '<svg width="34" height="22" viewBox="0 0 48 32" data-brand="visa"><rect width="48" height="32" rx="4" fill="#1a1f71"/><text x="24" y="21" font-family="Arial, sans-serif" font-size="13" font-weight="900" font-style="italic" fill="#fff" text-anchor="middle">VISA</text></svg>',
    mastercard: '<svg width="34" height="22" viewBox="0 0 48 32" data-brand="mastercard"><rect width="48" height="32" rx="4" fill="#16171a"/><circle cx="20" cy="16" r="9" fill="#eb001b"/><circle cx="28" cy="16" r="9" fill="#f79e1b" fill-opacity="0.9"/></svg>',
    amex: '<svg width="34" height="22" viewBox="0 0 48 32" data-brand="amex"><rect width="48" height="32" rx="4" fill="#2e77bc"/><text x="24" y="20" font-family="Arial, sans-serif" font-size="10.5" font-weight="800" fill="#fff" text-anchor="middle">AMEX</text></svg>',
    card: '<svg width="34" height="22" viewBox="0 0 48 32" data-brand="card"><rect width="48" height="32" rx="4" fill="none" stroke="#ccc" stroke-width="2"/></svg>'
  };
  const CARD_BODY_HTML = `
    <div class="pf-row" style="margin-top:12px">
      <div class="pf-field"><label class="pf-label">Cardholder Name</label><input class="pf-input" id="pmCardName" placeholder="John Smith" autocomplete="cc-name" /></div>
    </div>
    <div class="pf-field">
      <label class="pf-label">Card Number</label>
      <div class="pm-card-number-row">
        <input class="pf-input" id="pmCardNumber" placeholder="4242 4242 4242 4242" inputmode="numeric" maxlength="19" autocomplete="cc-number" />
        <span class="pm-card-icons" id="pmCardIcons">${CARD_ICON_SVGS.visa}${CARD_ICON_SVGS.mastercard}${CARD_ICON_SVGS.amex}</span>
      </div>
    </div>
    <div class="pf-row">
      <div class="pf-field"><label class="pf-label">Expiry (MM/YY)</label><input class="pf-input" id="pmCardExpiry" placeholder="12/28" maxlength="5" autocomplete="cc-exp" /></div>
      <div class="pf-field"><label class="pf-label">CVC</label><input class="pf-input" id="pmCardCvc" placeholder="123" maxlength="4" inputmode="numeric" autocomplete="cc-csc" /></div>
    </div>
    <div class="pm-note">🔒 Demo checkout — no real charge is made. Your card number is never stored, only used to confirm the order.</div>`;
  const PAYPAL_BODY_HTML = `<div class="pm-note">🅿️ You'll be asked to confirm this payment from your PayPal account. No PayPal login is collected here.</div>`;
  const COD_BODY_HTML = `<div class="pm-note">💵 Pay in cash when your order arrives. No payment is collected now.</div>`;
  const BANK_BODY_HTML = `<div class="pm-note">🏦 Bank transfer details will be included in your order confirmation email. Your order is reserved while payment is pending.</div>`;

  function selectPaymentMethod(method) {
    S.paymentMethod = method;
    qsa("#pmMethodRow .pm-method-btn").forEach(b => b.classList.toggle("active", b.dataset.method === method));
    $("pmMethodBody").innerHTML = method === "card" ? CARD_BODY_HTML : method === "paypal" ? PAYPAL_BODY_HTML : method === "cod" ? COD_BODY_HTML : method === "bank" ? BANK_BODY_HTML : "";
    if (method === "card") {
      $("pmCardNumber").addEventListener("input", (e) => {
        const brand = e.target.value.replace(/\D/g,"") ? cardBrandFor(e.target.value) : null;
        qsa("#pmCardIcons svg").forEach(svg => svg.classList.toggle("dim", !!brand && svg.dataset.brand !== brand));
      });
    }
  }

  /* Luhn checksum — format-only validation for the demo card form; the
     full number/CVC are read here and then immediately discarded, never
     sent anywhere beyond the derived {brand,last4} below. */
  function luhnValid(numStr) {
    const digits = numStr.replace(/\D/g,"");
    if (digits.length < 12) return false;
    let sum = 0, alt = false;
    for (let i = digits.length-1; i >= 0; i--) {
      let d = Number(digits[i]);
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }
  function cardBrandFor(numStr) {
    const d = numStr.replace(/\D/g,"");
    if (/^4/.test(d)) return "visa";
    if (/^5[1-5]/.test(d)) return "mastercard";
    if (/^3[47]/.test(d)) return "amex";
    return "card";
  }
  function validateCardForm() {
    const number = ($("pmCardNumber").value||"").trim();
    const expiry = ($("pmCardExpiry").value||"").trim();
    const cvc = ($("pmCardCvc").value||"").trim();
    if (!luhnValid(number)) return { error: "Enter a valid card number" };
    const m = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!m) return { error: "Enter expiry as MM/YY" };
    const expMonth = Number(m[1]), expYear = 2000+Number(m[2]);
    if (expMonth<1||expMonth>12) return { error: "Enter a valid expiry month" };
    const now = new Date();
    if (expYear < now.getFullYear() || (expYear===now.getFullYear() && expMonth < now.getMonth()+1)) return { error: "Card has expired" };
    if (!/^\d{3,4}$/.test(cvc)) return { error: "Enter a valid CVC" };
    const digits = number.replace(/\D/g,"");
    return { brand: cardBrandFor(digits), last4: digits.slice(-4) };
  }

  async function placeOrder() {
    const btn = $("placeOrderBtn"); if (!btn) return;
    const first = ($("coFirst").value||"").trim();
    const email = ($("coEmail").value||"").trim();
    if (!first||!email) { toast("Please enter your name and email","error"); return; }
    if (!S.paymentMethod) { toast("Please choose a payment method","error"); return; }

    let payment = { method: S.paymentMethod };
    if (S.paymentMethod === "card") {
      const cardResult = validateCardForm();
      if (cardResult.error) { toast(cardResult.error, "error"); return; }
      payment.brand = cardResult.brand;
      payment.last4 = cardResult.last4;
    }

    btn.disabled=true; btn.textContent="Placing Order…";
    try {
      const body = {
        customer: { name:[first,$("coLast").value].filter(Boolean).join(" "), email, phone:$("coPhone").value, address:$("coAddress").value },
        items: S.cart.map(i=>({id:i.id,name:i.name,price:i.price,qty:i.qty})),
        note: $("coNote").value, type:"online", payment
      };
      const r = await fetch(apiBase()+"/api/portal/"+S.wsId+"/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error||"Failed");
      S.cart=[]; updateCartUI();
      const paymentLine = payment.method==="card" ? `Card ending in ${esc(payment.last4)}` : payment.method==="paypal" ? "Paid via PayPal" : payment.method==="cod" ? "Pay in cash on delivery" : "Bank transfer — details incoming by email";
      $("checkoutBody").innerHTML = `
        <div class="success-state">
          <div class="success-icon">🎉</div>
          <div class="success-title">Order Placed!</div>
          <div class="success-sub">Thank you, <strong>${esc(first)}</strong>! We'll send a confirmation to <strong>${esc(email)}</strong>.</div>
          <div class="success-ref">${esc(j.ref)}</div>
          <div class="success-sub" style="font-size:.8rem">${esc(paymentLine)}</div>
          <div class="success-sub" style="font-size:.8rem;margin-bottom:20px">Save this reference to track your order</div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-dark" onclick="window.location.href='?ref=${esc(j.ref)}'">Track Order</button>
            <button class="btn btn-outline-dark" onclick="location.reload()">Continue Shopping</button>
          </div>
        </div>`;
    } catch(err) {
      toast("Order failed: "+err.message,"error");
      btn.disabled=false; btn.textContent="Place Order →";
    }
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  SEARCH                                                         */
  /* ─────────────────────────────────────────────────────────────── */
  function openSearch() {
    $("searchOverlay").classList.add("open");
    setTimeout(()=>$("searchInput").focus(),100);
    document.body.style.overflow="hidden";
  }
  function closeSearch() {
    $("searchOverlay").classList.remove("open");
    $("searchInput").value="";
    $("searchResults").innerHTML=`<div class="search-empty">Start typing to search…</div>`;
    document.body.style.overflow="";
  }
  function doSearch(q) {
    const r = $("searchResults"); if (!r) return;
    if (!q.trim()) { r.innerHTML=`<div class="search-empty">Start typing to search…</div>`; return; }
    const results = S.products.filter(p => {
      const txt=(p.name||"")+" "+(p.description||"")+" "+(p.category||"");
      return txt.toLowerCase().includes(q.toLowerCase());
    }).slice(0,8);
    if (!results.length) { r.innerHTML=`<div class="search-empty">No products found for "${esc(q)}"</div>`; return; }
    r.innerHTML = results.map(p=>`
      <div class="search-result-item" data-spid="${esc(p.id)}">
        <div class="search-result-img">${p.image?`<img src="${esc(p.image)}" alt="${esc(p.name)}" />`:productEmoji(p.category)}</div>
        <div>
          <div class="search-result-name">${esc(p.name||p.title)}</div>
          <div class="search-result-price">$${fmt(Number(p.price||0))}</div>
        </div>
      </div>
    `).join("");
    r.querySelectorAll(".search-result-item").forEach(item=>{
      item.addEventListener("click",()=>{
        const p=S.products.find(x=>x.id===item.dataset.spid);
        if(p){ closeSearch(); openProductModal(p); }
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  TOAST                                                          */
  /* ─────────────────────────────────────────────────────────────── */
  function toast(msg, type="success") {
    let t = $("portalToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "portalToast"; t.className="portal-toast";
      document.body.appendChild(t);
    }
    const icon = type==="error"?"❌":"✅";
    t.innerHTML = `<span class="toast-icon">${icon}</span><span>${esc(msg)}</span>`;
    t.classList.add("show");
    clearTimeout(t._t);
    t._t = setTimeout(()=>t.classList.remove("show"),3200);
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  SCROLL REVEAL                                                  */
  /* ─────────────────────────────────────────────────────────────── */
  function revealOnScroll() {
    const els = qsa(".reveal");
    if (!els.length) return;
    const obs = new IntersectionObserver(entries=>{
      entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add("visible"); obs.unobserve(e.target); } });
    },{threshold:0.08});
    els.forEach(el=>obs.observe(el));
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  WIRE EVENTS                                                    */
  /* ─────────────────────────────────────────────────────────────── */
  function wireEvents() {
    // Search
    $("navSearchBtn").addEventListener("click",openSearch);
    $("searchClose").addEventListener("click",closeSearch);
    $("searchOverlay").addEventListener("click",e=>{ if(e.target===$("searchOverlay")) closeSearch(); });
    $("searchInput").addEventListener("input",e=>doSearch(e.target.value));

    // Cart
    $("navCartBtn").addEventListener("click",openCart);
    $("cartCloseBtn").addEventListener("click",closeCart);
    $("cartOverlay").addEventListener("click",closeCart);
    $("checkoutBtn").addEventListener("click",openCheckout);

    // Checkout
    $("placeOrderBtn").addEventListener("click",placeOrder);
    $("backToCartBtn").addEventListener("click",()=>{ closeCheckout(); openCart(); });
    $("checkoutOverlay").addEventListener("click",e=>{ if(e.target===$("checkoutOverlay")) closeCheckout(); });
    $("pmMethodRow").addEventListener("click",e=>{
      const btn = e.target.closest(".pm-method-btn");
      if (btn) selectPaymentMethod(btn.dataset.method);
    });

    // Product modal
    $("modalClose").addEventListener("click",closeProductModal);
    $("productModalOverlay").addEventListener("click",e=>{ if(e.target===$("productModalOverlay")) closeProductModal(); });
    $("modalQtyMinus").addEventListener("click",()=>{ if(S.modalQty>1){ S.modalQty--; $("modalQtyVal").textContent=S.modalQty; } });
    $("modalQtyPlus").addEventListener("click",()=>{ S.modalQty++; $("modalQtyVal").textContent=S.modalQty; });
    $("modalAddBtn").addEventListener("click",()=>{
      if (!S.modalProduct) return;
      const p = S.modalProduct;
      addToCart(p.id, p.name||p.title, Number(p.price||0), p.image||null, S.modalQty);
      $("modalAddBtn").textContent="✓ Added to Cart";
      $("modalAddBtn").classList.add("added");
      setTimeout(()=>{ $("modalAddBtn").textContent="Add to Cart"; $("modalAddBtn").classList.remove("added"); closeProductModal(); },1500);
    });

    // Hero CTA
    $("heroCtaBtn").addEventListener("click",()=>{
      const main=$("portalMain");
      if(main) main.scrollIntoView({behavior:"smooth"});
    });

    // Escape key
    document.addEventListener("keydown",e=>{
      if(e.key==="Escape"){
        if($("searchOverlay").classList.contains("open")) closeSearch();
        if($("productModalOverlay").classList.contains("open")) closeProductModal();
        if($("cartDrawer").classList.contains("open")) closeCart();
        if($("checkoutOverlay").classList.contains("open")) closeCheckout();
        const actionOv = $("portalActionOverlay");
        if(actionOv && actionOv.classList.contains("open")) closeActionModal();
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────── */
  /*  BOOT                                                           */
  /* ─────────────────────────────────────────────────────────────── */
  /* ── boot ─────────────────────────────────────────────────────── */
  async function boot() {
    try {
      const wsId = resolveWsId();
      S.wsId = wsId;

      const effectiveWsId = wsId || localStorage.getItem("sap_active_ws");
      S.wsId = effectiveWsId;

      if (!effectiveWsId) {
        showUnavail("Configuration Error", "Portal URL is missing the workspace ID.");
        return;
      }

      let [cfg, prods] = await Promise.all([
        fetchConfig(effectiveWsId),
        fetchProducts(effectiveWsId)
      ]);

      // Fallback demo config if no workspace record exists yet
      if (!cfg) {
        cfg = {
          id: effectiveWsId,
          company: "Demo Retail Superstore",
          industry: "retail",
          storefrontEnabled: true,
          storefrontConfig: { template: "retail" }
        };
      }

      // Fallback demo products if products array is empty
      if (!prods || !prods.length) {
        const indKey = cfg.industry || "retail";
        if (indKey === "services") {
          prods = [
            { id: "P-3001", sku: "SRV-STRAT-AUDIT", name: "Corporate Strategy & Market Entry Audit", category: "Strategy Advisory", price: 15000.00, currency: "USD", image: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=600&q=80" },
            { id: "P-3002", sku: "SRV-DIG-TRANS", name: "Digital Maturity & Cloud Architecture Workshop", category: "Digital Transformation", price: 25000.00, currency: "USD", image: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=600&q=80" },
            { id: "P-3003", sku: "SRV-RISK-AUDIT", name: "ISO 27001 & Corporate Risk Assessment Audit", category: "Financial Advisory", price: 18500.00, currency: "USD", image: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=600&q=80" }
          ];
        } else if (indKey === "manufacturing") {
          prods = [
            { id: "P-3001", sku: "5AX-CNC-AL6061", name: "5-Axis Precision CNC Machined Aerospace Bracket", category: "CNC Machining", price: 48.50, currency: "USD", image: "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80" },
            { id: "P-3002", sku: "SM-LASER-316", name: "Stainless Steel 316L Laser-Cut Enclosure Chassis", category: "Sheet Metal", price: 89.00, currency: "USD", image: "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=600&q=80" },
            { id: "P-3003", sku: "INJ-ABS-HOUS", name: "High-Durability Thermoplastic Molded Housing", category: "Injection Molding", price: 14.20, currency: "USD", image: "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=600&q=80" },
            { id: "P-3004", sku: "PCB-SMT-ARM64", name: "Industrial ARM64 Controller Board Assembly (SMT)", category: "PCB Assembly", price: 165.00, currency: "USD", image: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&q=80" }
          ];
        } else if (indKey === "construction") {
          prods = [
            { id: "P-3001", sku: "CNST-STEEL-FAB", name: "Structural Steel Framing Fabrication (Per Ton)", category: "Materials", price: 1850.00, currency: "USD", image: "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=600&q=80" },
            { id: "P-3002", sku: "CNST-CONC-POUR", name: "Reinforced Portland Concrete Pouring (Per Cubic Yard)", category: "Services", price: 145.00, currency: "USD", image: "https://images.unsplash.com/photo-1541888946425-d0fbb186a5b3?w=600&q=80" },
            { id: "P-3003", sku: "CNST-MAS-BLOCK", name: "Heavy Duty Concrete Masonry Block (Pallet)", category: "Materials", price: 320.00, currency: "USD", image: "https://images.unsplash.com/photo-1590069261209-f8e9b8642343?w=600&q=80" }
          ];
        } else if (indKey === "restaurant" || indKey === "menu") {
          prods = [
            { id: "P-3001", sku: "KFC-BUCKET-8", name: "Signature Crispy Fried Chicken Bucket (8 Pcs)", category: "Buckets", price: 19.99, currency: "USD", image: "https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600&q=80" },
            { id: "P-3002", sku: "KFC-ZINGER-CR", name: "Zinger Double Crunch Spicy Chicken Burger", category: "Burgers", price: 6.49, currency: "USD", image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&q=80" },
            { id: "P-3003", sku: "KFC-TWISTER-WP", name: "Twister Crisp Chicken Wrap (Spicy Mayo)", category: "Wraps", price: 5.99, currency: "USD", image: "https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&q=80" },
            { id: "P-3004", sku: "KFC-FRIES-LG", name: "Golden Crisp French Fries (Large Share)", category: "By-Products and Desserts", price: 3.49, currency: "USD", image: "https://images.unsplash.com/photo-1576107232684-1279f3908594?w=600&q=80" }
          ];
        } else if (indKey === "logistics") {
          prods = [
            { id: "P-3001", sku: "LOG-AIR-CHARTER", name: "Standard Air Freight Charter Booking", category: "Charter", price: 4200.00, currency: "USD", image: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=600&q=80" },
            { id: "P-3002", sku: "LOG-LCL-SEA", name: "Less Than Container Load (LCL) Sea Cargo", category: "Ocean Freight", price: 850.00, currency: "USD", image: "https://images.unsplash.com/photo-1494412574643-ff11b0a5c1c3?w=600&q=80" }
          ];
        } else if (indKey === "fashion") {
          prods = [
            { id: "P-101", name: "Premium Tailored Wool Editorial Blazer", category: "Outerwear", price: 189.00, currency: "USD", image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=600&q=80" },
            { id: "P-102", name: "Relaxed Fit Pleated Linen Trousers", category: "Trousers", price: 95.00, currency: "USD", image: "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=600&q=80" },
            { id: "P-103", name: "Classic Silk Monogram Scarf", category: "Accessories", price: 45.00, currency: "USD", image: "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=600&q=80" }
          ];
        } else {
          prods = [
            { id: "P-101", name: "Premium Wireless Headphones Pro", category: "Electronics", price: 199.00, currency: "USD", image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=600&q=80" },
            { id: "P-102", name: "Ergonomic Smart Watch Series 7", category: "Electronics", price: 249.00, currency: "USD", image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80" },
            { id: "P-103", name: "Organic Cotton Casual Hoodie", category: "Fashion", price: 68.00, currency: "USD", image: "https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=600&q=80" },
            { id: "P-104", name: "Minimalist Leather Backpack", category: "Accessories", price: 129.00, currency: "USD", image: "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=600&q=80" }
          ];
        }
      }

      S.config = cfg;
      S.products = prods;
      S.industry = (window.INDUSTRIES && window.INDUSTRIES[cfg.industry]) || { portalTemplate: "retail" };
      loadWishlist();

      console.log("[Portal] Workspace:", cfg.company, "| Industry:", cfg.industry, "| Products:", prods.length);

      // Wires the shared UI chrome that lives in portal.html's static shell
      // (search, cart drawer, checkout, product modal, Escape key) — these
      // elements exist regardless of which template/renderer runs below,
      // so this only needs to happen once per page load.
      wireEvents();

      applyBranding(cfg);

      const sc = cfg.storefrontConfig || {};
      const template = sc.template || S.industry.portalTemplate || "retail";
      S.template = template;

      // These industries run on the block-based page-builder engine
      // (config-migrate.js + blocks.js + generic-renderer.js). Logistics is
      // the only industry left on its bespoke tracker render function below.
      const PILOT_INDUSTRIES = ["retail", "services", "fashion", "restaurant", "construction", "manufacturing", "logistics", "wholesale"];
      if (PILOT_INDUSTRIES.indexOf(cfg.industry) > -1 && window.migrateStorefrontConfig && window.bootPortalRouter) {
        cfg.storefrontConfig = window.migrateStorefrontConfig(sc, cfg.industry);
        window.bootPortalRouter(prods);
        updateCartUI();
        document.dispatchEvent(new CustomEvent("portal:boot-complete"));
        return;
      }

      const PT = window.PortalTemplates || {};

      if (template === "retail") renderRetail(prods);
      else if (template === "fashion") renderCatalog(prods);
      else if (template === "menu") renderMenu(prods);
      else if (template === "tracker") renderTracker();
      else if (template === "construction" || (template === "inquiry" && (cfg.industry === "construction" || (S.industry && S.industry.key === "construction")))) renderConstruction(prods);
      else if (template === "manufacturing" || cfg.industry === "manufacturing" || (S.industry && S.industry.key === "manufacturing")) renderManufacturing(prods);
      else if (template === "services" || cfg.industry === "services" || (S.industry && S.industry.key === "services")) (PT.services || renderInquiry)(prods);
      else if (template === "inquiry") renderInquiry();
      else renderRetail(prods);


      updateCartUI();
      document.dispatchEvent(new CustomEvent("portal:boot-complete"));
    } catch (err) {
      console.error("[Portal] Boot error:", err);
    } finally {
      hideLoader();
    }
  }

  function showUnavail(title, msg) {
    const m = $("portalMain"); if (m) m.innerHTML=`
      <div class="portal-unavail">
        <div class="unavail-icon">🏗️</div>
        <div class="unavail-title">${esc(title)}</div>
        <div class="unavail-sub">${esc(msg)}</div>
      </div>`;
  }

  function hideLoader() {
    const l = $("portalLoader");
    if (l) {
      l.classList.add("hide");
      setTimeout(() => { try { l.remove(); } catch(e){} }, 400);
    }
  }


  /* ── Generic action-modal engine ──────────────────────────────────
     One lazily-created overlay/card pair (same lazy-create-on-first-use
     pattern as toast() below) serves every "real interaction" use case:
     info popups, forms, and their success states. Reuses the visual
     language of the existing product-modal (portal.css ~line 446) so it
     reads as part of the same design system, not a bolted-on dialog. */
  function showActionModal(opts) {
    let ov = $("portalActionOverlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "portalActionOverlay";
      ov.className = "portal-action-overlay";
      ov.innerHTML = '<div class="portal-action-modal" role="dialog" aria-modal="true">' +
        '<button type="button" class="pam-close" aria-label="Close">✕</button>' +
        '<div class="pam-body"></div>' +
        "</div>";
      document.body.appendChild(ov);
      ov.addEventListener("click", (e) => { if (e.target === ov) closeActionModal(); });
      ov.querySelector(".pam-close").addEventListener("click", closeActionModal);
    }
    const icon = opts.icon ? '<div class="pam-icon">' + opts.icon + "</div>" : "";
    const title = opts.title ? '<h3 class="pam-title">' + esc(opts.title) + "</h3>" : "";
    ov.querySelector(".pam-body").innerHTML = icon + title + (opts.bodyHtml || "");
    ov.classList.add("open");
    if (typeof opts.onMount === "function") opts.onMount(ov.querySelector(".pam-body"));
  }
  function closeActionModal() {
    const ov = $("portalActionOverlay");
    if (ov) ov.classList.remove("open");
  }

  /* ── UPS/DHL Logistics Utilities ──────────────────────────────── */
  function setupAlerts() {
    toast("SMS & Email Delivery Alerts enabled for active tracking session!");
  }

  function showInfo(title, icon, bodyHtml) {
    showActionModal({ icon, title, bodyHtml: '<div class="pam-info">' + bodyHtml + "</div>" });
  }

  function changeDelivery() {
    showActionModal({
      icon: "🚚", title: "Change Delivery Destination",
      bodyHtml:
        '<form class="pam-form" id="pamDeliveryForm">' +
          '<label class="pam-label">Tracking reference number</label>' +
          '<input class="pam-input" id="pamDeliveryRef" placeholder="e.g. MRV-RW-24-001" required>' +
          '<label class="pam-label">New delivery address</label>' +
          '<textarea class="pam-input pam-textarea" id="pamDeliveryAddr" placeholder="Street, city, country" required></textarea>' +
          '<label class="pam-label">Preferred delivery date</label>' +
          '<input class="pam-input" type="date" id="pamDeliveryDate">' +
          '<button type="submit" class="btn btn-accent-gold btn-full pam-submit">Confirm Change</button>' +
        "</form>",
      onMount(body) {
        body.querySelector("#pamDeliveryForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const ref = body.querySelector("#pamDeliveryRef").value.trim();
          const addr = body.querySelector("#pamDeliveryAddr").value.trim();
          const date = body.querySelector("#pamDeliveryDate").value;
          if (!ref || !addr) return;
          const code = "RDR-" + Math.floor(10000 + Math.random() * 90000);
          body.innerHTML =
            '<div class="pam-icon pam-icon-success">✅</div>' +
            '<h3 class="pam-title">Delivery Redirection Confirmed</h3>' +
            '<div class="pam-info">' +
              '<div class="pam-result-row"><span>Reference</span><b>' + esc(ref) + "</b></div>" +
              '<div class="pam-result-row"><span>New address</span><b>' + esc(addr) + "</b></div>" +
              (date ? '<div class="pam-result-row"><span>Preferred date</span><b>' + esc(date) + "</b></div>" : "") +
              '<div class="pam-result-row pam-result-code"><span>Confirmation code</span><b>' + code + "</b></div>" +
            "</div>" +
            '<p class="pam-note">Our dispatcher will contact you to confirm the new drop-off before the shipment departs its current hub.</p>' +
            '<button type="button" class="btn btn-accent-gold btn-full pam-submit" onclick="Portal.closeActionModal()">Done</button>';
        });
      }
    });
  }

  const RATE_REGION = { SA: "ME", AE: "ME", TR: "ME", GB: "EU", DE: "EU", US: "AM", CN: "AS" };
  const RATE_ZONE_TIER = { "ME-ME": 1, "EU-EU": 1, "AM-AM": 1, "AS-AS": 1, "ME-EU": 2, "ME-AS": 2, "EU-AS": 3, "ME-AM": 3, "EU-AM": 3, "AM-AS": 4 };
  const RATE_ZONES = {
    1: { perKg: 1.8, transit: "1-2 Business Days" },
    2: { perKg: 2.6, transit: "2-3 Business Days" },
    3: { perKg: 3.4, transit: "3-4 Business Days" },
    4: { perKg: 4.5, transit: "5-7 Business Days" }
  };
  function rateZoneFor(fromCode, toCode) {
    const a = RATE_REGION[fromCode] || "ME", b = RATE_REGION[toCode] || "ME";
    if (a === b) return RATE_ZONES[1];
    const key = a + "-" + b, keyRev = b + "-" + a;
    return RATE_ZONES[RATE_ZONE_TIER[key] || RATE_ZONE_TIER[keyRev] || 3];
  }
  const COUNTRY_OPTIONS =
    '<option value="SA">🇸🇦 Saudi Arabia</option><option value="TR">🇹🇷 Turkey</option>' +
    '<option value="US">🇺🇸 United States</option><option value="GB">🇬🇧 United Kingdom</option>' +
    '<option value="DE">🇩🇪 Germany</option><option value="AE">🇦🇪 United Arab Emirates</option>' +
    '<option value="CN">🇨🇳 China</option>';

  function openRateCalculator() {
    showActionModal({
      icon: "🧮", title: "Calculate Shipping Rate",
      bodyHtml:
        '<form class="pam-form" id="pamRateForm">' +
          '<label class="pam-label">Origin country</label>' +
          '<select class="pam-input" id="pamRateFrom">' + COUNTRY_OPTIONS + "</select>" +
          '<label class="pam-label">Destination country</label>' +
          '<select class="pam-input" id="pamRateTo"><option value="">Select country</option>' + COUNTRY_OPTIONS + "</select>" +
          '<div class="pam-row-2">' +
            '<div><label class="pam-label">Weight</label><input class="pam-input" type="number" min="1" value="250" id="pamRateWeight"></div>' +
            '<div><label class="pam-label">Unit</label><select class="pam-input" id="pamRateUnit"><option value="kg">kg</option><option value="lb">lb</option></select></div>' +
          "</div>" +
          '<label class="pam-label">Service tier</label>' +
          '<select class="pam-input" id="pamRateTier"><option value="standard">Standard Freight</option><option value="express">Express Freight (+65%, faster transit)</option></select>' +
          '<button type="submit" class="btn btn-accent-gold btn-full pam-submit">Get Estimate</button>' +
        "</form>" +
        '<div id="pamRateResult"></div>',
      onMount(body) {
        body.querySelector("#pamRateForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const fromEl = body.querySelector("#pamRateFrom"), toEl = body.querySelector("#pamRateTo");
          const to = toEl.value;
          if (!to) { toEl.focus(); return; }
          const resultEl = body.querySelector("#pamRateResult");
          resultEl.innerHTML = '<div class="pam-spinner"></div>';
          setTimeout(() => {
            const weightRaw = Number(body.querySelector("#pamRateWeight").value) || 1;
            const unit = body.querySelector("#pamRateUnit").value;
            const weightKg = unit === "lb" ? weightRaw * 0.4536 : weightRaw;
            const tier = body.querySelector("#pamRateTier").value;
            const zone = rateZoneFor(fromEl.value, to);
            const handling = 18;
            const freight = Math.max(35, weightKg * zone.perKg);
            const serviceMult = tier === "express" ? 1.65 : 1;
            const total = (handling + freight) * serviceMult;
            const transit = tier === "express" ? zone.transit.replace(/(\d+)-(\d+)/, (m, a, b) => Math.max(1, Math.ceil(a * 0.6)) + "-" + Math.max(1, Math.ceil(b * 0.6))) : zone.transit;
            resultEl.innerHTML =
              '<div class="pam-result">' +
                '<div class="pam-result-row"><span>Handling fee</span><b>$' + handling.toFixed(2) + "</b></div>" +
                '<div class="pam-result-row"><span>Freight (' + weightRaw + " " + unit + ")</span><b>$" + freight.toFixed(2) + "</b></div>" +
                '<div class="pam-result-row"><span>Service tier</span><b>' + (tier === "express" ? "Express" : "Standard") + "</b></div>" +
                '<div class="pam-result-row pam-result-total"><span>Total Estimate</span><b>$' + total.toFixed(2) + " USD</b></div>" +
                '<div class="pam-result-row"><span>Transit time</span><b>' + transit + "</b></div>" +
                '<div class="pam-result-row"><span>Carrier</span><b>Webo Global Express</b></div>' +
              "</div>";
          }, 450);
        });
      }
    });
  }

  function openPickupModal() {
    showActionModal({
      icon: "📦", title: "Schedule Cargo Pickup",
      bodyHtml:
        '<form class="pam-form" id="pamPickupForm">' +
          '<label class="pam-label">Contact name</label>' +
          '<input class="pam-input" id="pamPickupName" placeholder="John Smith" required>' +
          '<label class="pam-label">Company (optional)</label>' +
          '<input class="pam-input" id="pamPickupCompany" placeholder="Company name">' +
          '<label class="pam-label">Pickup address</label>' +
          '<textarea class="pam-input pam-textarea" id="pamPickupAddr" placeholder="Street, city" required></textarea>' +
          '<div class="pam-row-2">' +
            '<div><label class="pam-label">Preferred date</label><input class="pam-input" type="date" id="pamPickupDate"></div>' +
            '<div><label class="pam-label">Time window</label><select class="pam-input" id="pamPickupWindow"><option>Morning (8-12)</option><option>Afternoon (12-4)</option><option>Evening (4-8)</option></select></div>' +
          "</div>" +
          '<label class="pam-label">Number of packages</label>' +
          '<input class="pam-input" type="number" min="1" value="1" id="pamPickupCount">' +
          '<button type="submit" class="btn btn-accent-gold btn-full pam-submit">Schedule Pickup</button>' +
        "</form>",
      onMount(body) {
        body.querySelector("#pamPickupForm").addEventListener("submit", (e) => {
          e.preventDefault();
          const name = body.querySelector("#pamPickupName").value.trim();
          const addr = body.querySelector("#pamPickupAddr").value.trim();
          if (!name || !addr) return;
          const company = body.querySelector("#pamPickupCompany").value.trim();
          const date = body.querySelector("#pamPickupDate").value;
          const win = body.querySelector("#pamPickupWindow").value;
          const count = body.querySelector("#pamPickupCount").value;
          const code = "PKP-" + Math.floor(10000 + Math.random() * 90000);
          body.innerHTML =
            '<div class="pam-icon pam-icon-success">✅</div>' +
            '<h3 class="pam-title">Pickup Scheduled</h3>' +
            '<div class="pam-info">' +
              '<div class="pam-result-row"><span>Contact</span><b>' + esc(name) + (company ? " (" + esc(company) + ")" : "") + "</b></div>" +
              '<div class="pam-result-row"><span>Address</span><b>' + esc(addr) + "</b></div>" +
              (date ? '<div class="pam-result-row"><span>Date</span><b>' + esc(date) + " · " + esc(win) + "</b></div>" : '<div class="pam-result-row"><span>Window</span><b>' + esc(win) + "</b></div>") +
              '<div class="pam-result-row"><span>Packages</span><b>' + esc(count) + "</b></div>" +
              '<div class="pam-result-row pam-result-code"><span>Pickup code</span><b>' + code + "</b></div>" +
            "</div>" +
            '<button type="button" class="btn btn-accent-gold btn-full pam-submit" onclick="Portal.closeActionModal()">Done</button>';
        });
      }
    });
  }

  function calcDhlQuote() {
    const fromEl = $("dhlFromCountry");
    const toEl = $("dhlToCountry");
    const resultEl = $("dhlQuoteResult");
    if (!toEl || !toEl.value) {
      if (resultEl) resultEl.innerHTML = '<div class="dhl-quote-error">Please select a destination country!</div>';
      return;
    }
    const from = fromEl ? fromEl.options[fromEl.selectedIndex].text : "Saudi Arabia";
    const to = toEl.options[toEl.selectedIndex].text;
    if (!resultEl) return;
    resultEl.innerHTML = '<div class="pam-spinner"></div>';
    setTimeout(() => {
      const zone = rateZoneFor(fromEl ? fromEl.value : "SA", toEl.value);
      const parcel = Math.round(zone.perKg * 45);
      const pallet = Math.round(zone.perKg * 180);
      resultEl.innerHTML =
        '<div class="dhl-quote-result-panel">' +
          '<div class="dqr-route"><b>' + esc(from) + '</b> <span class="dqr-arrow">→</span> <b>' + esc(to) + "</b></div>" +
          '<div class="pam-result-row"><span>Standard Express Parcel (up to 5 kg)</span><b>$' + parcel + ".00 USD</b></div>" +
          '<div class="pam-result-row"><span>Pallet / Heavy Freight (up to 100 kg)</span><b>$' + pallet + ".00 USD</b></div>" +
          '<div class="pam-result-row"><span>Custom Cargo / Container</span><b>Contact Local Hub</b></div>' +
          '<div class="pam-result-row pam-result-total"><span>Transit Time</span><b>' + zone.transit + " via Express Air Freight</b></div>" +
        "</div>";
    }, 400);
  }

  function filterCat(cat) {
    const filtered = (!cat || cat==="All" || cat==="New In") ? S.products : S.products.filter(p=>(p.category||p.type||"General").toLowerCase().includes(cat.toLowerCase()));
    renderProductGrid(filtered);
    const target = $("productGridSection");
    if (target) target.scrollIntoView({ behavior: "smooth" });
  }

  function openLookbook() {
    alert("✨ ZARA / H&M Editorial Lookbook 2026:\n\nFeaturing sustainable organic fabrics, tailored trench silhouettes, and handcrafted leather accessories.\n\nExplore our new campaign in stores and online.");
  }

  function submitCnstTender() {
    toast("🏗️ Formal RFP Tender submitted! Senior Project Director notified.");
    const form = $("cnstForm");
    if (form) form.reset();
  }

  function submitMfgRfq() {
    toast("🏭 Formal OEM RFQ submitted! Senior Sales Engineer assigned.");
    const form = $("mfgForm");
    if (form) form.reset();
  }

  function submitSrvRfq() {
    toast("💼 Formal Strategy Proposal RFP submitted! Senior Advisory Partner assigned.");
    const form = $("srvForm");
    if (form) form.reset();
  }

  // Export helpers for modular industry portal scripts
  window.buildCatBar = buildCatBar;
  window.buildCategories = buildCategories;
  window.bindCatBar = bindCatBar;
  window.bindProductCards = bindProductCards;
  window.productCard = productCard;
  window.noonProductCard = noonProductCard;
  window.kfcProductCard = kfcProductCard;
  window.cnstProductCard = cnstProductCard;
  window.revealOnScroll = revealOnScroll;

  /* Public API for inline handlers */
  window.Portal = {
    changeQty(id,delta){ const i=S.cart.find(x=>x.id===id); if(!i)return; i.qty+=delta; if(i.qty<=0)S.cart=S.cart.filter(x=>x.id!==id); updateCartUI(); },
    removeItem(id){ S.cart=S.cart.filter(x=>x.id!==id); updateCartUI(); },
    openCart, closeCart, openCheckout, closeCheckout, doTrack,
    setupAlerts, changeDelivery, openRateCalculator, openPickupModal, calcDhlQuote,
    showInfo, closeActionModal,
    filterCat, openLookbook, toggleWishlist, addToCart, submitCnstTender, submitMfgRfq, submitSrvRfq
  };








  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot);
  else boot();

})();
