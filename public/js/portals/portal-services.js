/* =================================================================
   WeboCloud Portal Engine — Professional Services & Advisory Module
   (Enterprise Strategy, Digital Transformation & Corporate RFP)
   ================================================================= */
(function() {
  "use strict";

  window.PortalTemplates = window.PortalTemplates || {};

  function renderServices(products) {
    const hero = document.getElementById("portalHero"); if (hero) hero.style.display = "none";
    const trust = document.getElementById("trustStrip"); if (trust) trust.style.display = "none";
    const ab = document.getElementById("announceBar"); if (ab) ab.style.display = "none";
    const pf = document.getElementById("portalFooter"); if (pf) pf.style.display = "none";

    // Hide Cart / Briefcase entirely for Services since it's strictly RFP-based
    const navCartBtn = document.getElementById("navCartBtn"); 
    if (navCartBtn) {
      navCartBtn.style.display = "none";
    }

    const S = window.PortalState || {};
    const sc = (S.config && S.config.storefrontConfig) || {};
    const co = (S.config && S.config.company) || "ENTERPRISE ADVISORY PARTNERS";

    document.body.classList.add("is-srv-theme");

    const navCats = document.getElementById("navCats");
    if (navCats) {
      const cats = ["Advisory Services", "Scoping Simulator", "Case Studies", "Our Partners", "RFP Inquiry"];
      navCats.innerHTML = cats.map((c, i) => {
        const idMap = ["srvCapabilitiesSection", "srvCalculatorSection", "srvCasesSection", "srvPartnersSection", "srvRfqSection"];
        return `<li><a href="javascript:void(0)" class="${i === 0 ? 'active' : ''}" onclick="document.getElementById('${idMap[i]}').scrollIntoView({behavior:'smooth'})">${c.toUpperCase()}</a></li>`;
      }).join("");
    }

    const main = document.getElementById("portalMain"); if (!main) return;

    const capabilities = [
      { name: "STRATEGY & GROWTH ADVISORY", icon: "📈", tag: "Market Entry & M&A Strategy", desc: "Corporate development, target due diligence, restructuring advisory, and high-impact strategy." },
      { name: "DIGITAL TRANSFORMATION", icon: "💻", tag: "Cloud Integration & Analytics", desc: "Enterprise cloud strategy, system automation, custom software, and AI-driven growth metrics." },
      { name: "FINANCIAL & RISK ADVISORY", icon: "🏦", tag: "Auditing & Risk Mitigation", desc: "Corporate governance auditing, tax compliance restructuring, cashflow management, and treasury support." },
      { name: "ORGANISATIONAL DESIGN", icon: "👥", tag: "Agile Culture & Talent Mapping", desc: "Change management, executive leadership training, HR alignment, and business transformation culture." },
      { name: "CYBERSECURITY & AUDITING", icon: "🛡️", tag: "ISO 27001 & Threat Analysis", desc: "Information security management, continuous security auditing, and complete ISO 27001 readiness." },
      { name: "ALLIANCES & VENTURES", icon: "🤝", tag: "Cross-Border Commercial Structures", desc: "Strategic joint venture frameworks, commercial partnership legal advice, and international expansion." }
    ];

    const partners = [
      { name: "Victoria Sterling", role: "Managing Partner — Corporate Strategy", img: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400&q=80", bio: "Former Tier-1 lead with 20+ years advising Fortune 100 boards on cross-border transactions and restructurings." },
      { name: "Marcus Vance", role: "Senior Partner — Digital Technology", img: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=400&q=80", bio: "Lead architect of multi-cloud banking migrations across EU and MENA regions. Specialist in industrial AI applications." },
      { name: "Sarah Lin, PhD", role: "Partner — Organisational Design", img: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400&q=80", bio: "Specialist in change management, post-merger culture integration, and agile transformation frameworks." }
    ];

    const caseStudies = [
      { client: "GLOBAL FINTECH GROUP", metric: "+38% EFFICIENCY BOOST", tags: "London / New York", title: "Corporate Restructuring & Automation", desc: "Re-engineered core accounting operations and back-office transaction pipelines, unlocking $14M in annual runway." },
      { client: "EUROPEAN AUTOMOTIVE OEM", metric: "50% LOGISTICS REDUCTION", tags: "Stuttgart / Tokyo", title: "Global Supply Chain Digitalization", desc: "Implemented predictive logistics analytics and multi-cloud container orchestration across 8 manufacturing plants." },
      { client: "METROPOLITAN BANK GROUP", metric: "ZERO COMPLIANCE DEFICIENCIES", tags: "Zurich / Dubai", title: "Enterprise ISO 27001 & Security Audit", desc: "Conducted continuous security audits and ISO certifications across 12 countries to guarantee compliance." }
    ];

    main.innerHTML = `
      <!-- TOP ADVISORY & CONTACT BAR -->
      <div class="srv-top-bar reveal">
        <span>💼 IMC & ASQ Certified Enterprise Management Consulting & Business Strategy</span>
        <span class="srv-hotline">📞 Executive Advisory Line: +1 (800) CONSULT-PRO</span>
      </div>

      <!-- SUB-HEADER BAR -->
      <div class="srv-subnav-bar reveal">
        <span class="srv-subnav-title">STRATEGIC MANAGEMENT & STRATEGY CONSULTING</span>
        <button class="srv-rfq-btn" onclick="document.getElementById('srvRfqSection').scrollIntoView({behavior:'smooth'})">REQUEST TAILORED PROPOSAL (RFP) →</button>
      </div>

      <!-- CORPORATE SLATE HERO BANNER -->
      <section class="srv-hero reveal">
        <div class="srv-hero-overlay"></div>
        <div class="srv-hero-content">
          <div class="srv-hero-badge">ENTERPRISE ADVISORY SERVICES</div>
          <h1 class="srv-hero-title">DRIVE PROGRESS WITH <span>STRATEGIC INSIGHTS</span></h1>
          <p class="srv-hero-sub">${sc.heroSub || "Providing strategic foresight, digital engineering, organizational design, and corporate restructuring to global industries."}</p>
          <div class="srv-hero-actions">
            <button class="btn srv-btn-teal" onclick="document.getElementById('srvRfqSection').scrollIntoView({behavior:'smooth'})">REQUEST TAILORED PROPOSAL →</button>
            <button class="btn srv-btn-outline" onclick="document.getElementById('srvCalculatorSection').scrollIntoView({behavior:'smooth'})">SCOPING ESTIMATOR</button>
          </div>
        </div>
      </section>

      <!-- LIVE ADVISORY STATS STRIP -->
      <section class="srv-stats-strip reveal">
        <div class="srv-stat-box">
          <div class="srv-stat-num">150+</div>
          <div class="srv-stat-label">FORTUNE 500 ENGAGEMENTS</div>
        </div>
        <div class="srv-stat-box">
          <div class="srv-stat-num">$500M+</div>
          <div class="srv-stat-label">BUSINESS VALUE UNLOCKED</div>
        </div>
        <div class="srv-stat-box">
          <div class="srv-stat-num">98%</div>
          <div class="srv-stat-label">CLIENT RETENTION RATE</div>
        </div>
        <div class="srv-stat-box">
          <div class="srv-stat-num">15+ YRS</div>
          <div class="srv-stat-label">AVERAGE ADVISER EXPERIENCE</div>
        </div>
      </section>

      <!-- BRAND TRUST WALL -->
      <section class="srv-brand-strip reveal">
        <div class="srv-brand-strip-inner">
          <span class="srv-brand-logo">🔲 VODAFONE PARTNER</span>
          <span class="srv-brand-logo">▲ AKBANK DIGITAL</span>
          <span class="srv-brand-logo">◉ TESLA OEM</span>
          <span class="srv-brand-logo">◆ GULF INDUSTRIAL</span>
          <span class="srv-brand-logo">▲ GREENSTART DE</span>
        </div>
      </section>

      <!-- CAPABILITIES GRID SECTION -->
      <section class="portal-section srv-cap-section reveal" id="srvCapabilitiesSection">
        <div class="srv-sec-hd">
          <div class="srv-sec-eyebrow">ADVISORY PORTFOLIO</div>
          <h2 class="srv-sec-title">OUR CONSULTING CAPABILITIES</h2>
        </div>

        <div class="srv-cap-grid">
          ${capabilities.map(c => `
            <div class="srv-cap-card">
              <div class="srv-cap-icon">${c.icon}</div>
              <span class="srv-cap-tag">${c.tag}</span>
              <h3 class="srv-cap-title">${c.name}</h3>
              <p class="srv-cap-desc">${c.desc}</p>
            </div>
          `).join("")}
        </div>
      </section>

      <!-- INTERACTIVE ENGAGEMENT SCOPING ESTIMATOR -->
      <section class="portal-section srv-calc-section reveal" id="srvCalculatorSection">
        <div class="srv-calc-wrap">
          <div class="srv-calc-info">
            <span class="srv-sec-eyebrow">ADVISORY SCOPING ESTIMATOR</span>
            <h2 class="srv-sec-title" style="margin-bottom:14px">SIMULATE YOUR CONSULTING PLAN</h2>
            <p style="color:#94a3b8; font-size:0.95rem; line-height:1.5; margin-bottom:24px">
              Select your strategic goals and team allocation settings. Our simulator calculates projected advisory hours, allocation structures, and budget expectations.
            </p>
            <div class="srv-calc-form">
              <div class="srv-form-field">
                <label>Engagement Strategy Area</label>
                <select id="calcArea" onchange="Portal.calcSrvProposal()">
                  <option value="growth">Strategy & Growth Advisory</option>
                  <option value="digital">Digital Transformation & AI Integration</option>
                  <option value="risk">Risk, Governance & Cybersecurity Audit</option>
                </select>
              </div>
              <div class="srv-form-field">
                <label>Senior Advisory Allocation</label>
                <select id="calcTeam" onchange="Portal.calcSrvProposal()">
                  <option value="standard">Partner + 2 Senior Consultants</option>
                  <option value="director">Project Director + 4 Consultants</option>
                  <option value="board">Executive Board Advisory Panel</option>
                </select>
              </div>
              <div class="srv-form-field">
                <label>Engagement Duration</label>
                <select id="calcDuration" onchange="Portal.calcSrvProposal()">
                  <option value="4">4 Weeks (Discovery Sprint)</option>
                  <option value="12">12 Weeks (Full Project Scoping)</option>
                  <option value="26">26 Weeks (Enterprise Integration)</option>
                </select>
              </div>
            </div>
          </div>

          <div class="srv-calc-result-card">
            <h3>PROJECTED ADVISORY SCOPE</h3>
            <div class="srv-result-divider"></div>
            
            <div class="srv-result-row">
              <span>Weekly Billable Hours</span>
              <strong id="resHours">40 hrs/wk</strong>
            </div>
            <div class="srv-result-row">
              <span>Dedicated Team Allocation</span>
              <strong id="resTeam">3 Specialists</strong>
            </div>
            <div class="srv-result-row">
              <span>Estimated Project Fee</span>
              <strong id="resPrice" class="srv-result-price">$25,000.00</strong>
            </div>

            <div class="srv-result-divider"></div>
            <button class="btn srv-btn-teal btn-full" onclick="Portal.applyEstimatorRfp()">APPLY SCOPE TO RFP FORM ↓</button>
          </div>
        </div>
      </section>

      <!-- CASE STUDIES SECTION -->
      <section class="portal-section srv-cases-section reveal" id="srvCasesSection">
        <div class="srv-sec-hd" style="text-align:center; margin-bottom:48px">
          <span class="srv-sec-eyebrow">CLIENT IMPACT</span>
          <h2 class="srv-sec-title">CASE STUDIES & STRATEGIC OUTCOMES</h2>
        </div>

        <div class="srv-cases-grid">
          ${caseStudies.map(cs => `
            <div class="srv-case-card">
              <div class="srv-case-metric">${cs.metric}</div>
              <div class="srv-case-meta">
                <span class="srv-case-client">${cs.client}</span>
                <span class="srv-case-tags">${cs.tags}</span>
              </div>
              <h3 class="srv-case-title">${cs.title}</h3>
              <p class="srv-case-desc">${cs.desc}</p>
            </div>
          `).join("")}
        </div>
      </section>

      <!-- OUR PARTNERS SECTION -->
      <section class="portal-section srv-partners-section reveal" id="srvPartnersSection">
        <div class="srv-sec-hd" style="text-align:center; margin-bottom:48px">
          <span class="srv-sec-eyebrow">SENIOR LEADERSHIP</span>
          <h2 class="srv-sec-title">OUR ADVISORY PARTNERS</h2>
        </div>

        <div class="srv-partners-grid">
          ${partners.map(p => `
            <div class="srv-partner-card">
              <div class="srv-partner-img">
                <img src="${p.img}" alt="${p.name}" />
              </div>
              <div class="srv-partner-body">
                <h3 class="srv-partner-name">${p.name}</h3>
                <span class="srv-partner-role">${p.role}</span>
                <p class="srv-partner-bio">${p.bio}</p>
              </div>
            </div>
          `).join("")}
        </div>
      </section>

      <!-- RFP / PROPOSAL REQUEST FORM SECTION -->
      <section class="portal-section srv-rfq-section reveal" id="srvRfqSection">
        <div class="srv-rfq-wrap">
          <div class="srv-rfq-info">
            <div class="section-eyebrow" style="color:#2dd4bf">REQUEST FOR PROPOSAL</div>
            <h2 class="srv-rfq-heading">SUBMIT YOUR PROJECT OUTLINE</h2>
            <p class="srv-rfq-text">Looking to optimize operations, implement digital platforms, or audit risk profile? Submit project outline below. Our senior advisory board will contact you with a tailored engagement scope within 24 hours.</p>
            
            <div class="srv-perk-list">
              <div class="srv-perk-item">✓ Phase-0 high-level scoping audit</div>
              <div class="srv-perk-item">✓ Formal non-disclosure agreement (NDA) guarantee</div>
              <div class="srv-perk-item">✓ Assigned Senior Partner & Project Director</div>
            </div>
          </div>

          <div class="srv-form-card">
            <form id="srvForm" onsubmit="event.preventDefault(); Portal.submitSrvRfq();">
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Company / Enterprise <span class="req">*</span></label><input class="pf-input" id="srvCo" placeholder="Apex Global Holdings" required /></div>
                <div class="pf-field"><label class="pf-label">Contact Executive <span class="req">*</span></label><input class="pf-input" id="srvPerson" placeholder="Victoria Sterling" required /></div>
              </div>
              <div class="pf-row">
                <div class="pf-field"><label class="pf-label">Corporate Email <span class="req">*</span></label><input class="pf-input" id="srvEmail" type="email" placeholder="v.sterling@apex.com" required /></div>
                <div class="pf-field"><label class="pf-label">Target Budget</label>
                  <select class="pf-select" id="srvBudget">
                    <option value="">Select Range…</option>
                    <option>$25k – $100k</option>
                    <option>$100k – $500k</option>
                    <option>$500k – $2M</option>
                    <option>&gt; $2M Enterprise Scope</option>
                  </select>
                </div>
              </div>
              <div class="pf-field"><label class="pf-label">Scope Details & Goals <span class="req">*</span></label><textarea class="pf-textarea" id="srvDesc" placeholder="Describe the current problems, operational objectives, and engagement timelines…" required style="min-height:90px"></textarea></div>
              <button type="submit" class="btn srv-btn-teal btn-full" id="srvSubmitBtn">SUBMIT FORMAL PROPOSAL REQUEST →</button>
            </form>
          </div>
        </div>
      </section>

      <!-- SLATE ADVISORY DARK FOOTER -->
      <footer class="srv-dark-footer reveal">
        <div class="srv-footer-inner">
          <div class="srv-footer-col">
            <div class="srv-footer-logo">${co}</div>
            <p class="srv-footer-desc">Professional corporate strategy, digital transformation, and executive advisory. Navigating complexity with clarity.</p>
            <div class="srv-cert-badge">ASQ & IMC CERTIFIED ADVISORY</div>
          </div>
          <div class="srv-footer-col">
            <h4>Advisory Services</h4>
            <a href="#">Corporate Strategy</a>
            <a href="#">Digital Integration</a>
            <a href="#">M&A Transaction Advisory</a>
            <a href="#">Risk Governance Audit</a>
          </div>
          <div class="srv-footer-col">
            <h4>Governance & Standards</h4>
            <a href="#">ISO 27001 Security</a>
            <a href="#">Compliance Auditing</a>
            <a href="#">Environmental Impact</a>
            <a href="#">Partner Ethics</a>
          </div>
          <div class="srv-footer-col">
            <h4>Tenders & RFP</h4>
            <a href="#">Submit Proposal</a>
            <a href="#">Service SLA Terms</a>
            <a href="#">Client Portal Access</a>
          </div>
          <div class="srv-footer-col">
            <h4>📍 Global HQ Operations</h4>
            <a href="#" class="srv-loc-link">Advisory Headquarters →</a>
          </div>
        </div>
        <div class="srv-footer-bottom">
          Copyright © ${co}. 2026 All rights reserved.
        </div>
      </footer>
    `;

    if (window.revealOnScroll) window.revealOnScroll();

    // Trigger initial scoping calculation
    Portal.calcSrvProposal();
  }

  // Scoping calculator logic
  function calcSrvProposal() {
    const area = document.getElementById("calcArea")?.value || "growth";
    const team = document.getElementById("calcTeam")?.value || "standard";
    const duration = parseInt(document.getElementById("calcDuration")?.value || "4");

    let hourlyRate = 250;
    if (area === "growth") hourlyRate = 350;
    else if (area === "digital") hourlyRate = 300;

    let weeklyHours = 40;
    let teamSize = 3;
    if (team === "standard") {
      weeklyHours = 40;
      teamSize = 3;
    } else if (team === "director") {
      weeklyHours = 80;
      teamSize = 5;
      hourlyRate *= 0.9; // volume discount
    } else if (team === "board") {
      weeklyHours = 20;
      teamSize = 4;
      hourlyRate *= 1.8; // premium partners
    }

    const totalFee = weeklyHours * duration * hourlyRate;

    const resHours = document.getElementById("resHours");
    const resTeam = document.getElementById("resTeam");
    const resPrice = document.getElementById("resPrice");

    if (resHours) resHours.textContent = weeklyHours + " hrs/wk";
    if (resTeam) resTeam.textContent = teamSize + " Specialists";
    if (resPrice) resPrice.textContent = "$" + totalFee.toLocaleString('en-US', {minimumFractionDigits: 2});
  }

  function applyEstimatorRfp() {
    const area = document.getElementById("calcArea");
    const team = document.getElementById("calcTeam");
    const duration = document.getElementById("calcDuration");
    const price = document.getElementById("resPrice")?.textContent;

    const areaText = area ? area.options[area.selectedIndex].text : "";
    const teamText = team ? team.options[team.selectedIndex].text : "";
    const durationText = duration ? duration.options[duration.selectedIndex].text : "";

    const descInput = document.getElementById("srvDesc");
    const budgetSelect = document.getElementById("srvBudget");

    if (descInput) {
      descInput.value = `Applied Scope from Simulator Plan:\n- Strategy Area: ${areaText}\n- Advisory Team: ${teamText}\n- Expected Timeline: ${durationText}\n- Calculated Budget Estimate: ${price}\n\nProject Scope Details: `;
      descInput.focus();
    }

    if (budgetSelect) {
      if (price.includes("$100,") || price.includes("$200,") || price.includes("$300,") || price.includes("$400,")) {
        budgetSelect.value = "$100k – $500k";
      } else if (price.includes("$25,") || price.includes("$30,") || price.includes("$40,") || price.includes("$50,") || price.includes("$60,") || price.includes("$80,")) {
        budgetSelect.value = "$25k – $100k";
      } else {
        budgetSelect.value = "$500k – $2M";
      }
    }

    // Smooth scroll to the form
    document.getElementById("srvRfqSection")?.scrollIntoView({behavior: "smooth"});
  }

  window.PortalTemplates.services = renderServices;
  window.Portal.calcSrvProposal = calcSrvProposal;
  window.Portal.applyEstimatorRfp = applyEstimatorRfp;
})();
