/* =================================================================
   WeboCloud Portal Engine — Enterprise Logistics & Tracker Module
   (UPS & DHL Style Tracking Portal)
   ================================================================= */
(function() {
  "use strict";

  window.PortalTemplates = window.PortalTemplates || {};

  function renderTracker() {
    const hero = document.getElementById("portalHero"); if (hero) hero.style.display = "none";
    const trust = document.getElementById("trustStrip"); if (trust) trust.style.display = "none";

    const navCartBtn = document.getElementById("navCartBtn"); if (navCartBtn) navCartBtn.style.display = "none";
    const sBtn = document.getElementById("navSearchBtn"); if (sBtn) sBtn.style.display = "none";

    const S = window.PortalState || {};
    const sc = (S.config && S.config.storefrontConfig) || {};
    const co = (S.config && S.config.company) || "Webo Logistics";

    const ab = document.getElementById("announceBar");
    const at = document.getElementById("announceText");
    if (ab && at) {
      at.innerHTML = sc.announcement || "📍 Global Air & Ocean Freight Network | Live Real-Time Cargo Tracking";
      ab.style.display = "flex";
    }

    const navCats = document.getElementById("navCats");
    if (navCats) {
      navCats.innerHTML = `
        <li><a href="#tracker" class="active">Tracking</a></li>
        <li><a href="javascript:void(0)" onclick="Portal.openRateCalculator()">Shipping Rates</a></li>
        <li><a href="javascript:void(0)" onclick="Portal.openPickupModal()">Freight Pickup</a></li>
        <li><a href="javascript:void(0)" onclick="alert('Support: 24/7 Logistics Desk available at support@webocloud.com')">Support</a></li>
      `;
    }

    const main = document.getElementById("portalMain"); if (!main) return;

    main.innerHTML = `
      <div class="logistics-hero">
        <div class="logistics-hero-inner">
          <div class="logistics-grid">
            <div class="ups-track-card reveal">
              <div class="ups-track-hd">
                <span class="ups-track-icon">📍</span>
                <div>
                  <h2 class="ups-track-title">${sc.heroTitle || "Track Your Shipment"}</h2>
                  <p class="ups-track-sub">${sc.heroSub || "Enter your shipment tracking number or bill of lading for real-time updates."}</p>
                </div>
              </div>
              <div class="track-input-row">
                <input class="track-input" id="trackInput" placeholder="Tracking Number or Delivery Notice (e.g. MRV-RW-24-001)" autocomplete="off" />
                <button class="btn btn-accent-gold" id="trackBtn">Track ></button>
              </div>

              <div class="ups-quick-actions">
                <a href="javascript:void(0)" onclick="Portal.setupAlerts()"><span class="qa-icon">🔔</span> Set Up Alerts</a>
                <a href="javascript:void(0)" onclick="Portal.changeDelivery()"><span class="qa-icon">🚚</span> Change Delivery</a>
                <a href="javascript:void(0)" onclick="Portal.openRateCalculator()"><span class="qa-icon">🧮</span> Calculate Shipping Rate</a>
                <a href="javascript:void(0)" onclick="Portal.openPickupModal()"><span class="qa-icon">📦</span> Request Pickup</a>
              </div>

              <div class="ups-sample-chips">
                <span class="chip-label">Quick Demo Tracking #:</span>
                <button class="sample-chip" onclick="document.getElementById('trackInput').value='MRV-RW-24-001';Portal.doTrack();">MRV-RW-24-001</button>
                <button class="sample-chip" onclick="document.getElementById('trackInput').value='MRV-RW-24-002';Portal.doTrack();">MRV-RW-24-002</button>
                <button class="sample-chip" onclick="document.getElementById('trackInput').value='DLV-1002';Portal.doTrack();">DLV-1002</button>
              </div>

              <div id="trackResult"></div>
            </div>

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
    `;

    const trackBtn = document.getElementById("trackBtn");
    if (trackBtn) trackBtn.addEventListener("click", () => window.Portal && window.Portal.doTrack && window.Portal.doTrack());
    const trackInput = document.getElementById("trackInput");
    if (trackInput) trackInput.addEventListener("keydown", e => { if (e.key === "Enter") window.Portal && window.Portal.doTrack && window.Portal.doTrack(); });

    if (window.revealOnScroll) window.revealOnScroll();
  }

  window.PortalTemplates.tracker = renderTracker;
})();
