/* =================================================================
   WeboCloud Portal Engine — Manufacturing & Industrial Plants Module
   (Smart Manufacturing, Precision OEM & Supply Chain Portal)
   ================================================================= */
(function() {
  "use strict";

  window.PortalTemplates = window.PortalTemplates || {};

  function renderManufacturing(products) {
    const hero = document.getElementById("portalHero"); if (hero) hero.style.display = "none";
    const trust = document.getElementById("trustStrip"); if (trust) trust.style.display = "none";
    const ab = document.getElementById("announceBar"); if (ab) ab.style.display = "none";

    const navCartBtn = document.getElementById("navCartBtn"); if (navCartBtn) navCartBtn.style.display = "flex";

    const S = window.PortalState || {};
    const sc = (S.config && S.config.storefrontConfig) || {};
    const co = (S.config && S.config.company) || "INDUSTRIAL MANUFACTURING PLANT";

    document.body.classList.add("is-mfg-theme");

    const navCats = document.getElementById("navCats");
    if (navCats) {
      const cats = ["CNC Machining", "Sheet Metal", "Injection Molding", "PCB Assembly", "Metrology", "Contact"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i === 0 ? 'active' : ''}" onclick="Portal.filterCat('${c}')">${c.toUpperCase()}</a></li>`
      ).join("");
    }

    const main = document.getElementById("portalMain"); if (!main) return;

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
          <p class="mfg-hero-sub">${sc.heroSub || "Custom 5-axis CNC machining, sheet metal fabrication, injection molding, and electronic SMT assembly with sub-micron accuracy."}</p>
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

        ${window.buildCatBar ? window.buildCatBar(products) : ''}

        <div class="product-grid mfg-product-grid" id="productGrid">
          ${products.map((p, i) => mfgProductCard(p, i)).join("")}
        </div>
      </section>

      <!-- INDUSTRIAL METAL FOOTER -->
      <footer class="mfg-dark-footer reveal">
        <div class="mfg-footer-inner">
          <div class="mfg-footer-col">
            <div class="mfg-footer-logo">${co}</div>
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
          Copyright © ${co}. 2026 All rights reserved.
        </div>
      </footer>
    `;

    if (window.buildCategories) window.buildCategories(products);
    if (window.bindCatBar) window.bindCatBar();
    if (window.bindProductCards) window.bindProductCards();
    if (window.revealOnScroll) window.revealOnScroll();
  }

  function mfgProductCard(p, i) {
    const badgeText = i % 3 === 0 ? "⚙️ CNC MACHINED" : i % 2 === 0 ? "⚡ PCB ASSEMBLY" : "🏭 RAW MATERIAL";

    return `
      <div class="product-card mfg-card reveal" data-id="${p.id}">
        <div class="mfg-card-top">
          <span class="mfg-badge">${badgeText}</span>
        </div>

        <div class="product-img-wrap mfg-img-wrap">
          <img src="${p.image || 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80'}" alt="${p.name}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80'" />
        </div>

        <div class="mfg-card-body">
          <h3 class="product-name mfg-prod-name">${p.name}</h3>
          <p class="mfg-prod-desc">${p.description || "Precision engineered industrial part manufactured to exact ASTM/ISO specifications with full CMM inspection."}</p>

          <div class="mfg-price-row">
            <div>
              <span class="mfg-curr">USD</span>
              <span class="mfg-price">$${Number(p.price||0).toFixed(2)}</span>
            </div>
            <button class="btn mfg-add-btn" onclick="event.stopPropagation();Portal.addToCart('${p.id}')">BUY / ORDER →</button>
          </div>
        </div>
      </div>
    `;
  }

  window.PortalTemplates.manufacturing = renderManufacturing;
})();
