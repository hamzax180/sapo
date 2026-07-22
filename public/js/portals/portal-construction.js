/* =================================================================
   WeboCloud Portal Engine — Construction & Heavy Contracting Module
   (Heavy Civil, Structural Engineering & RFP Tender Portal)
   ================================================================= */
(function() {
  "use strict";

  window.PortalTemplates = window.PortalTemplates || {};

  function renderConstruction(products) {
    const hero = document.getElementById("portalHero"); if (hero) hero.style.display = "none";
    const trust = document.getElementById("trustStrip"); if (trust) trust.style.display = "none";
    const ab = document.getElementById("announceBar"); if (ab) ab.style.display = "none";

    const navCartBtn = document.getElementById("navCartBtn"); if (navCartBtn) navCartBtn.style.display = "flex";

    const S = window.PortalState || {};
    const sc = (S.config && S.config.storefrontConfig) || {};
    const co = (S.config && S.config.company) || "HEAVY CONTRACTING & ENGINEERING";

    document.body.classList.add("is-construction-theme");

    const navCats = document.getElementById("navCats");
    if (navCats) {
      const cats = ["Capabilities", "Project Portfolio", "Equipment Fleet", "Tenders (RFP)", "Safety & OSHA", "Contact"];
      navCats.innerHTML = cats.map((c, i) =>
        `<li><a href="javascript:void(0)" class="${i === 0 ? 'active' : ''}" onclick="Portal.filterCat('${c}')">${c.toUpperCase()}</a></li>`
      ).join("");
    }

    const main = document.getElementById("portalMain"); if (!main) return;

    const capabilities = [
      { name: "CIVIL & EARTHWORKS", icon: "🏗️", tag: "Foundations, Piling & Highways", desc: "Mega earthmoving, deep pile foundations, bridge abutments and highway infrastructure." },
      { name: "COMMERCIAL HIGH-RISE", icon: "🏢", tag: "Skyscrapers & Office Towers", desc: "Structural steel framing, glass curtain walls, commercial towers and mixed-use developments." },
      { name: "INDUSTRIAL PLANTS", icon: "🏭", tag: "Factories & Logistics Hubs", desc: "Refineries, processing plants, automated warehouses and heavy industrial facilities." },
      { name: "HEAVY EQUIPMENT FLEET", icon: "🚜", tag: "Cranes, Excavators & Haulage", desc: "Heavy machinery rentals with certified operators and GPS site tracking." },
      { name: "BIM & STRUCTURAL DESIGN", icon: "📐", tag: "3D Modeling & Engineering", desc: "Building Information Modeling (BIM), load calculations and structural compliance supervision." },
      { name: "MEP & UTILITIES", icon: "⚡", tag: "HVAC, Electrical & Piping", desc: "High-voltage electrical grids, central HVAC plants, industrial plumbing and fire safety." }
    ];

    main.innerHTML = `
      <div class="cnst-top-bar reveal">
        <span>🏗️ ISO 9001 & OSHA Certified Heavy Engineering, Civil Infrastructure & General Contracting</span>
        <span class="cnst-hotline">📞 24/7 Site Equipment & Tender Line: +1 (800) BUILD-PRO</span>
      </div>

      <div class="cnst-subnav-bar reveal">
        <span class="cnst-subnav-title">COMMERCIAL & CIVIL ENGINEERING CONTRACTORS</span>
        <button class="cnst-tender-btn" onclick="document.getElementById('cnstTenderSection').scrollIntoView({behavior:'smooth'})">SUBMIT TENDER REQUEST (RFP) →</button>
      </div>

      <section class="cnst-hero reveal">
        <div class="cnst-hero-overlay"></div>
        <div class="cnst-hero-content">
          <div class="cnst-hero-badge">GENERAL CONTRACTING & INFRASTRUCTURE</div>
          <h1 class="cnst-hero-title">MEGA STRUCTURES & <span>HEAVY ENGINEERING</span></h1>
          <p class="cnst-hero-sub">${sc.heroSub || "Building bridges, high-rise commercial towers, highway networks, and industrial complexes with world-class engineering precision."}</p>
          <div class="cnst-hero-actions">
            <button class="btn cnst-btn-amber" onclick="document.getElementById('cnstTenderSection').scrollIntoView({behavior:'smooth'})">SUBMIT TENDER (RFP) →</button>
            <button class="btn cnst-btn-outline" onclick="document.getElementById('cnstEquipmentSection').scrollIntoView({behavior:'smooth'})">EQUIPMENT FLEET</button>
          </div>
        </div>
      </section>

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

      <section class="portal-section" id="cnstEquipmentSection">
        <div class="section-head" style="align-items:flex-end">
          <div>
            <div class="section-eyebrow" style="color:#d97706;font-weight:900">HEAVY EQUIPMENT & MATERIALS</div>
            <div class="section-title" style="font-size:2.4rem;font-weight:900;letter-spacing:-0.02em">FLEET & SITE PROCUREMENT</div>
            <div class="section-sub">${products.length} heavy equipment units & structural materials available for deployment</div>
          </div>
        </div>

        ${window.buildCatBar ? window.buildCatBar(products) : ''}

        <div class="product-grid cnst-product-grid" id="productGrid">
          ${products.map((p, i) => window.cnstProductCard ? window.cnstProductCard(p, i) : '').join("")}
        </div>
      </section>

      <footer class="cnst-dark-footer reveal">
        <div class="cnst-footer-inner">
          <div class="cnst-footer-col">
            <div class="cnst-footer-logo">${co}</div>
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
          Copyright © ${co}. 2026 All rights reserved.
        </div>
      </footer>
    `;

    if (window.buildCategories) window.buildCategories(products);
    if (window.bindCatBar) window.bindCatBar();
    if (window.bindProductCards) window.bindProductCards();
    if (window.revealOnScroll) window.revealOnScroll();
  }

  window.PortalTemplates.construction = renderConstruction;
})();
