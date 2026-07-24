/* =================================================================
   WeboCloud Portal Engine — storefrontConfig v2 migration adapter
   -----------------------------------------------------------------
   The v1 storefrontConfig only carried a handful of flat text fields
   (heroTitle, heroSub, accentColor, ...) that a hardcoded per-industry
   template function read directly. v2 introduces a `pages` map of
   ordered blocks so the generic block-based renderer/editor can work
   for any page, not just a fixed set of fields.

   This module is additive and non-destructive: workspaces already on
   v2 pass through untouched; workspaces still on v1 (or with no
   storefrontConfig at all) get a synthesized v2 config built from
   their existing flat fields, but ONLY for the two piloted industries
   (retail, services) — every other industry keeps using its existing
   bespoke render function until it's ported in a later phase.
   ================================================================= */
(function () {
  "use strict";

  function genBlockId() {
    return "blk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  window.genBlockId = genBlockId;

  const PILOT_INDUSTRIES = ["retail", "services", "fashion", "restaurant", "construction", "manufacturing", "logistics", "wholesale"];

  /* v2 = flat pages map (first block engine release).
     v3 = every industry additionally ships a slideshow, and the
          product-led industries get their own products page. */
  const CURRENT_VERSION = 3;

  function isV2(cfg) {
    return !!(cfg && cfg.pages && cfg.themeVersion >= 2);
  }
  window.isStorefrontConfigV2 = isV2;

  const b = (type, props) => ({ id: genBlockId(), type, props: props || {} });
  const img = (id, w) => "https://images.unsplash.com/" + id + "?w=" + (w || 1600) + "&q=85";

  /* =================================================================
     SLIDESHOWS — one per industry, pre-filled with on-topic imagery.
     Every slide's image is an editable `image` field, so a business
     replaces these with its own photos from the live editor's Upload
     button (no URL typing required).
     ================================================================= */
  const SLIDESHOWS = {
    logistics: {
      title: "Our Network In Motion", subtitle: "Air · Ocean · Rail · Road",
      slides: [
        { image: img("photo-1494412574643-ff11b0a5c1c3"), eyebrow: "OCEAN FREIGHT", title: "Container Shipping *Worldwide*", desc: "FCL and LCL sailings across every major trade lane, with live milestone tracking." },
        { image: img("photo-1586528116311-ad8dd3c8310d"), eyebrow: "AIR CARGO", title: "Time-Critical *Air Freight*", desc: "Charter and consolidated air capacity when the delivery date cannot move." },
        { image: img("photo-1553413077-190dd305871c"), eyebrow: "WAREHOUSING", title: "Bonded *Distribution Hubs*", desc: "Cross-docking, customs clearance and last-mile dispatch under one roof." }
      ]
    },
    fashion: {
      title: "The Lookbook", subtitle: "Season Highlights",
      slides: [
        { image: img("photo-1490481651871-ab68de25d43d"), eyebrow: "CAPSULE 01", title: "Tailored *Silhouettes*", desc: "Sculpted outerwear and clean lines built from natural fibres." },
        { image: img("photo-1515886657613-9f3515b0c78f"), eyebrow: "CAPSULE 02", title: "Everyday *Luxury*", desc: "Elevated essentials designed to be worn far beyond the season." },
        { image: img("photo-1483985988355-763728e1935b"), eyebrow: "ACCESSORIES", title: "The Finishing *Details*", desc: "Silk, leather and hardware — the pieces that complete the look." }
      ]
    },
    wholesale: {
      title: "Inside Our Distribution Network", subtitle: "Trade Supply At Scale",
      slides: [
        { image: img("photo-1553413077-190dd305871c"), eyebrow: "CENTRAL DC", title: "10,000+ SKUs *In Stock*", desc: "Deep inventory held across our central and regional distribution hubs." },
        { image: img("photo-1586528116311-ad8dd3c8310d"), eyebrow: "DISPATCH", title: "48-Hour *Turnaround*", desc: "Pick, pack and multimodal dispatch on verified trade accounts." },
        { image: img("photo-1504307651254-35680f356dfd"), eyebrow: "BULK PRICING", title: "Tiered *Volume Rates*", desc: "Pricing that scales with order volume across the full catalogue." }
      ]
    },
    retail: {
      title: "This Week In Store", subtitle: "Featured Campaigns",
      slides: [
        { image: img("photo-1505740420928-5e560c06d30e"), eyebrow: "SUPER SALE", title: "Up To *70% Off* Audio", desc: "Premium headphones and speakers at their lowest price of the season.", ctaLabel: "Shop the sale", ctaAction: "none", ctaTarget: "" },
        { image: img("photo-1523275335684-37898b6baf30"), eyebrow: "NEW ARRIVALS", title: "Smart Wearables *Just Landed*", desc: "The latest fitness and lifestyle wearables, in stock and ready to ship." },
        { image: img("photo-1556905055-8f358a7a47b2"), eyebrow: "EVERYDAY VALUE", title: "Essentials For *Less*", desc: "Restocked weekly — the everyday items your basket is never without." }
      ]
    },
    manufacturing: {
      title: "Inside The Plant", subtitle: "Production Capabilities",
      slides: [
        { image: img("photo-1581091226825-a6a2a5aee158"), eyebrow: "PRECISION MACHINING", title: "5-Axis *CNC Cells*", desc: "Sub-micron milling and turning running lights-out around the clock." },
        { image: img("photo-1504307651254-35680f356dfd"), eyebrow: "FABRICATION", title: "Sheet Metal & *Robotic Welding*", desc: "Fiber laser cutting, press-brake forming and automated weld lines." },
        { image: img("photo-1518770660439-4636190af475"), eyebrow: "ELECTRONICS", title: "SMT *PCB Assembly*", desc: "High-speed pick-and-place with full AOI inspection and traceability." }
      ]
    },
    restaurant: {
      title: "Straight From The Kitchen", subtitle: "Today's Favourites",
      slides: [
        { image: img("photo-1626082927389-6cd097cdc6ec"), eyebrow: "SIGNATURE", title: "Hand-Breaded *Crispy Chicken*", desc: "Marinated overnight, breaded by hand and fried fresh to order." },
        { image: img("photo-1568901346375-23c9450c58cd"), eyebrow: "BURGERS", title: "The *Double Crunch*", desc: "Two crispy fillets, signature sauce, toasted brioche." },
        { image: img("photo-1576107232684-1279f3908594"), eyebrow: "SIDES", title: "Golden *Crisp Fries*", desc: "Skin-on, seasoned and served hot with every order." }
      ]
    },
    construction: {
      title: "Projects On Site", subtitle: "Recent Builds",
      slides: [
        { image: img("photo-1541888946425-d0fbb186a5b3"), eyebrow: "CIVIL & EARTHWORKS", title: "Foundations Built To *Endure*", desc: "Deep piling, bridge abutments and highway infrastructure." },
        { image: img("photo-1590069261209-f8e9b8642343"), eyebrow: "COMMERCIAL", title: "High-Rise *Structural Steel*", desc: "Curtain-wall towers and mixed-use developments delivered on programme." },
        { image: img("photo-1504307651254-35680f356dfd"), eyebrow: "INDUSTRIAL", title: "Plants & *Logistics Hubs*", desc: "Processing facilities and automated warehouses, turnkey." }
      ]
    },
    services: {
      title: "How We Work With Clients", subtitle: "Advisory In Practice",
      slides: [
        { image: img("photo-1486406146926-c627a92ad1ab"), eyebrow: "STRATEGY", title: "Boardroom *Advisory*", desc: "Market entry, M&A and corporate development for global operators." },
        { image: img("photo-1573496359142-b8d87734a5a2"), eyebrow: "TRANSFORMATION", title: "Teams Embedded *On The Ground*", desc: "Senior practitioners working alongside your people, not above them." },
        { image: img("photo-1560250097-0b93528c311a"), eyebrow: "OUTCOMES", title: "Measured *Business Value*", desc: "Every engagement scoped against numbers you can audit." }
      ]
    }
  };

  function slideshowBlock(industryKey) {
    const s = SLIDESHOWS[industryKey];
    if (!s) return null;
    return b("slideshow", {
      title: s.title, subtitle: s.subtitle,
      height: "medium", autoplay: true, interval: 5,
      showArrows: true, showDots: true, showCaptions: true, overlay: 45,
      slides: s.slides.map((sl) => Object.assign({ eyebrow: "", title: "", desc: "", ctaLabel: "", ctaAction: "none", ctaTarget: "" }, sl))
    });
  }

  /* =================================================================
     PRODUCT PAGES — industries that actually sell a catalogue get a
     dedicated page of their own, generated automatically, with the
     home page keeping a short "featured" strip that links to it.
     Logistics (tracking-led) and Services (RFP-led) don't sell from a
     grid, so they're deliberately absent.
     ================================================================= */
  const PRODUCT_PAGES = {
    retail:        { slug: "shop",       title: "Shop",       gridTitle: "All Products",                 gridSub: "Every item currently in stock, ready to ship",              featured: "Recommended For You", cta: "Shop all products" },
    fashion:       { slug: "collection", title: "Collection", gridTitle: "The Full Collection",           gridSub: "Every piece from the current season",                       featured: "Featured Pieces",     cta: "View the collection" },
    restaurant:    { slug: "menu",       title: "Menu",       gridTitle: "Our Full Menu",                 gridSub: "Available for delivery and pickup",                          featured: "Today's Favourites",  cta: "See the full menu" },
    wholesale:     { slug: "catalogue",  title: "Catalogue",  gridTitle: "Wholesale Catalogue",           gridSub: "Browse the full trade product range",                        featured: "Popular Lines",       cta: "Browse the catalogue" },
    manufacturing: { slug: "products",   title: "Products",   gridTitle: "Finished Goods & Raw Materials", gridSub: "Industrial components & materials ready for dispatch",      featured: "In Production Now",   cta: "View all products" },
    construction:  { slug: "equipment",  title: "Equipment",  gridTitle: "Fleet & Site Procurement",      gridSub: "Heavy equipment units & structural materials for deployment", featured: "Available This Month", cta: "View fleet & materials" }
  };

  function productPageFor(industryKey) {
    const p = PRODUCT_PAGES[industryKey];
    if (!p) return null;
    const ss = SLIDESHOWS[industryKey];
    return {
      title: p.title, slug: p.slug, isHome: false,
      blocks: [
        b("hero", {
          eyebrow: "", eyebrowStyle: "text", title: p.gridTitle, subtitle: p.gridSub,
          bgImage: (ss && ss.slides[0] && ss.slides[0].image) || "", align: "center", buttons: []
        }),
        // Blank heading — the page hero above already carries the title.
        b("product-grid", { title: "", subtitle: "", showCatBar: true, limit: 0, ctaLabel: "", ctaAction: "none", ctaTarget: "" })
      ]
    };
  }

  /* Home-page product grid for an industry that has its own products page:
     a capped preview that links through, instead of dumping the whole
     catalogue onto the landing page. */
  function featuredGridProps(industryKey) {
    const p = PRODUCT_PAGES[industryKey];
    if (!p) return null;
    return { title: p.featured, subtitle: "", showCatBar: false, limit: 4, ctaLabel: p.cta, ctaAction: "page", ctaTarget: p.slug };
  }

  /* ---- default block sets, seeded from the industry's current bespoke look ---- */
  function defaultBlocksFor(industryKey, sc, ind) {

    if (industryKey === "wholesale") {
      return [
        b("topbar", { message: "📦 Trade Accounts Welcome — Bulk Pricing on Every Order" }),
        b("hero", {
          eyebrow: "WHOLESALE & DISTRIBUTION", eyebrowStyle: "text",
          title: sc.heroTitle || (ind && ind.portalHero) || "*Wholesale* Catalogue",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Browse our product range and place a trade order — bulk pricing, dedicated account management, and multimodal freight built in.",
          bgImage: sc.heroBgImage || img("photo-1553413077-190dd305871c", 1400),
          align: sc.heroAlign || "center",
          accentColor: sc.heroAccentColor || "#0f9d6b",
          buttons: [
            { id: genBlockId(), label: sc.ctaText || (ind && ind.portalCallToAction) || "Request Quote", action: "scroll", target: "" },
            { id: genBlockId(), label: "Browse Catalogue", action: "page", target: "catalogue" }
          ]
        }),
        slideshowBlock("wholesale"),
        b("stats", {
          accentColor: "#0f9d6b",
          items: [
            { value: "10,000+", label: "SKUs in stock" },
            { value: "48h", label: "Dispatch turnaround" },
            { value: "2", label: "Regional distribution hubs" },
            { value: "100%", label: "Trade account verified" }
          ]
        }),
        b("brand-wall", { items: ["Trusted by 500+ Trade Buyers", "Central DC Certified", "Regional Hub Network", "Multimodal Freight Partners"] }),
        b("card-grid", {
          title: "Why Buy Wholesale With Us", subtitle: "Trade Benefits", columns: 3,
          items: [
            { icon: "📦", title: "Bulk Pricing", tag: "Volume Discounts", desc: "Tiered pricing that scales with order volume across our full catalogue.", color: "#0f9d6b" },
            { icon: "🚚", title: "Multimodal Freight", tag: "Road · Rail · Sea", desc: "Flexible shipping options from our Central DC and Regional Hub.", color: "#0f9d6b" },
            { icon: "🤝", title: "Dedicated Trade Accounts", tag: "Buyer Support", desc: "A dedicated account manager for recurring orders and custom terms.", color: "#0f9d6b" }
          ]
        }),
        b("rfq-form", {
          title: "Request a Trade Quote", subtitle: "Bulk Order Pricing",
          perks: ["Tiered volume pricing", "Dedicated trade account manager", "Multimodal freight options (Road/Rail/Sea)"],
          submitLabel: "Request Quote"
        }),
        b("product-grid", featuredGridProps("wholesale")),
        b("footer-rich", {
          accentColor: "#0f9d6b", bgColor: "#08261c",
          tagline: "Trade supply, at scale.",
          desc: "Bulk buying and selling between suppliers and trade buyers, backed by a two-hub distribution network.",
          contactAddress: "Central Distribution Centre", contactPhone: "+90 324 000 0000", contactEmail: "trade@example.com",
          socials: [{ label: "LinkedIn", href: "#" }, { label: "X", href: "#" }],
          newsletter: true, newsletterTitle: "Trade price list", newsletterSub: "Monthly bulk pricing and new-line announcements.",
          legal: "All rights reserved.",
          columns: [
            { title: "Trade", links: [{ label: "Request a Quote", href: "#" }, { label: "Bulk Pricing", href: "#" }, { label: "Trade Accounts", href: "#" }] },
            { title: "Logistics", links: [{ label: "Delivery Options", href: "#" }, { label: "Regional Hubs", href: "#" }] }
          ]
        })
      ];
    }

    if (industryKey === "retail") {
      return [
        b("topbar", { message: "BUY NOW, PAY LATER — 0% interest · 0% purchase fees · 0% down payment" }),
        b("hero", {
          eyebrow: "SUPER SALE 2026", eyebrowStyle: "badge",
          title: sc.heroTitle || (ind && ind.portalHero) || "Upgrade Your *Gaming Gear*",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Explore next-gen consoles, 4K displays, and high-performance gaming accessories with express delivery.",
          bgImage: sc.heroBgImage || "",
          align: sc.heroAlign || "center",
          accentColor: sc.heroAccentColor || "#38b6ff", titleGradient: sc.heroTitleGradient || "#ff4081",
          buttons: [{ id: genBlockId(), label: sc.ctaText || (ind && ind.portalCallToAction) || "Shop Now", action: "page", target: "shop" }]
        }),
        slideshowBlock("retail"),
        b("card-grid", {
          title: "Shop by Department", subtitle: "", columns: 4,
          items: [
            { icon: "🔥", title: "Deals", tag: "Up to 70% off", color: "#ffd000" },
            { icon: "🎮", title: "Electronics", tag: "Gaming & tech", color: "#38b6ff" },
            { icon: "👗", title: "Fashion", tag: "New styles", color: "#ab47bc" },
            { icon: "🍽️", title: "Home & Kitchen", tag: "Appliances", color: "#ff9800" }
          ]
        }),
        b("product-grid", featuredGridProps("retail")),
        b("footer-rich", {
          accentColor: "#38b6ff", bgColor: "#0b1220",
          tagline: "Everything you need. In one basket.",
          desc: "Electronics, fashion and home essentials — restocked weekly and shipped express.",
          contactAddress: "Main Store &amp; Back Store", contactPhone: "+90 324 000 0000", contactEmail: "hello@example.com",
          socials: [{ label: "Instagram", href: "#" }, { label: "Facebook", href: "#" }, { label: "TikTok", href: "#" }],
          newsletter: true, newsletterTitle: "Get the deals first", newsletterSub: "Weekly offers and early access to sales.",
          legal: "All rights reserved.",
          columns: [
            { title: "Shop", links: [{ label: "All Products", href: "#/p/shop" }, { label: "Deals", href: "#" }, { label: "New Arrivals", href: "#" }] },
            { title: "Help", links: [{ label: "Track Order", href: "#" }, { label: "Returns &amp; Refunds", href: "#" }, { label: "Contact Us", href: "#" }] }
          ]
        })
      ];
    }

    if (industryKey === "services") {
      return [
        b("topbar", { message: "IMC & ASQ Certified Enterprise Management Consulting & Business Strategy" }),
        b("hero", {
          eyebrow: "ENTERPRISE ADVISORY SERVICES",
          title: sc.heroTitle || (ind && ind.portalHero) || "Drive Progress With *Strategic Insights*",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Providing strategic foresight, digital engineering, organizational design, and corporate restructuring to global industries.",
          bgImage: sc.heroBgImage || "",
          align: sc.heroAlign || "center",
          buttons: [
            { id: genBlockId(), label: sc.ctaText || (ind && ind.portalCallToAction) || "Request Proposal", action: "scroll", target: "" },
            { id: genBlockId(), label: "Scoping Estimator", action: "scroll", target: "" }
          ]
        }),
        slideshowBlock("services"),
        b("stats", {
          accentColor: "#0f766e",
          items: [
            { value: "150+", label: "Fortune 500 engagements" },
            { value: "$500M+", label: "Business value unlocked" },
            { value: "98%", label: "Client retention rate" },
            { value: "15+ yrs", label: "Average adviser experience" }
          ]
        }),
        b("brand-wall", { items: ["Vodafone Partner", "Akbank Digital", "Tesla OEM", "Gulf Industrial", "GreenStart DE"] }),
        b("card-grid", {
          title: "Our Consulting Capabilities", subtitle: "Advisory Portfolio", columns: 3,
          items: [
            { icon: "📈", title: "Strategy & Growth Advisory", tag: "Market Entry & M&A Strategy", desc: "Corporate development, target due diligence, restructuring advisory, and high-impact strategy.", color: "#0f766e" },
            { icon: "💻", title: "Digital Transformation", tag: "Cloud Integration & Analytics", desc: "Enterprise cloud strategy, system automation, custom software, and AI-driven growth metrics.", color: "#2563eb" },
            { icon: "🏦", title: "Financial & Risk Advisory", tag: "Auditing & Risk Mitigation", desc: "Corporate governance auditing, tax compliance restructuring, and treasury support.", color: "#7c3aed" }
          ]
        }),
        b("calculator", { title: "Simulate Your Consulting Plan", subtitle: "Advisory Scoping Estimator" }),
        b("case-studies", {
          title: "Case Studies & Strategic Outcomes", subtitle: "Client Impact",
          accentColor: "#0f766e",
          items: [
            { metric: "+38% Efficiency Boost", client: "Global Fintech Group", tags: "London / New York", title: "Corporate Restructuring & Automation", desc: "Re-engineered core accounting operations and back-office transaction pipelines." },
            { metric: "50% Logistics Reduction", client: "European Automotive OEM", tags: "Stuttgart / Tokyo", title: "Global Supply Chain Digitalization", desc: "Implemented predictive logistics analytics and multi-cloud orchestration." }
          ]
        }),
        b("partner-grid", {
          title: "Our Advisory Partners", subtitle: "Senior Leadership",
          accentColor: "#0f766e",
          items: [
            { name: "Victoria Sterling", role: "Managing Partner — Corporate Strategy", img: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400&q=80", bio: "20+ years advising Fortune 100 boards on cross-border transactions." },
            { name: "Marcus Vance", role: "Senior Partner — Digital Technology", img: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=400&q=80", bio: "Lead architect of multi-cloud banking migrations across EU and MENA." }
          ]
        }),
        b("rfq-form", {
          title: "Submit Your Project Outline", subtitle: "Request For Proposal",
          perks: ["Phase-0 high-level scoping audit", "Formal non-disclosure agreement (NDA) guarantee", "Assigned Senior Partner & Project Director"],
          submitLabel: "Submit Formal Proposal Request"
        }),
        b("footer-rich", {
          accentColor: "#0f766e", bgColor: "#07211f",
          tagline: "Strategy that survives contact with reality.",
          desc: "Corporate strategy, digital transformation and executive advisory for global operators.",
          contactAddress: "Head Office", contactPhone: "+90 324 000 0000", contactEmail: "proposals@example.com",
          socials: [{ label: "LinkedIn", href: "#" }, { label: "X", href: "#" }],
          newsletter: true, newsletterTitle: "Advisory insights", newsletterSub: "Quarterly research and sector briefings.",
          legal: "All rights reserved.",
          columns: [
            { title: "Advisory", links: [{ label: "Corporate Strategy", href: "#" }, { label: "Digital Integration", href: "#" }, { label: "Risk & Governance", href: "#" }] },
            { title: "Engage Us", links: [{ label: "Submit an RFP", href: "#" }, { label: "Case Studies", href: "#" }, { label: "Our Partners", href: "#" }] }
          ]
        })
      ];
    }

    if (industryKey === "fashion") {
      return [
        b("hero", {
          eyebrow: sc.heroEyebrow || "NEW ARRIVALS 2026",
          title: sc.heroTitle || (ind && ind.portalHero) || "THE *COLLECTION*",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Designed for elevated everyday luxury. Discover refined silhouettes and timeless essentials.",
          bgImage: sc.heroBgImage || img("photo-1490481651871-ab68de25d43d"),
          align: sc.heroAlign || "center",
          buttons: [{ id: genBlockId(), label: sc.ctaText || (ind && ind.portalCallToAction) || "Shop Collection", action: "page", target: "collection" }]
        }),
        slideshowBlock("fashion"),
        b("editorial-grid", {
          title: "Editorial Lookbook", subtitle: "Curated seasonal trends and campaign highlights",
          items: [
            { tag: "CAPSULE 01", title: "Tailored Silhouettes", linkLabel: "Explore Runway", image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=800&q=80" },
            { tag: "CAPSULE 02", title: "Essential Accessories", linkLabel: "Discover Details", image: "https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&q=80" }
          ]
        }),
        b("product-grid", featuredGridProps("fashion")),
        b("footer-rich", {
          accentColor: "#c9a227", bgColor: "#101010",
          tagline: "Considered clothing, made to last.",
          desc: "Elevated everyday luxury — refined silhouettes cut from natural fibres.",
          contactAddress: "Boutique Store &amp; Main Warehouse", contactPhone: "+90 324 000 0000", contactEmail: "studio@example.com",
          socials: [{ label: "Instagram", href: "#" }, { label: "Pinterest", href: "#" }],
          newsletter: true, newsletterTitle: "Join the list", newsletterSub: "Lookbooks, private sales and new season drops.",
          legal: "All rights reserved.",
          columns: [
            { title: "Shop", links: [{ label: "The Collection", href: "#/p/collection" }, { label: "New In", href: "#" }, { label: "Accessories", href: "#" }] },
            { title: "Client Care", links: [{ label: "Shipping &amp; Returns", href: "#" }, { label: "Size Guide", href: "#" }, { label: "Garment Care", href: "#" }] }
          ]
        })
      ];
    }

    if (industryKey === "restaurant") {
      return [
        b("topbar", { message: "📍 Click here to find the restaurant closest to you!" }),
        b("hero", {
          eyebrow: "SIGNATURE RECIPE",
          title: sc.heroTitle || (ind && ind.portalHero) || "Special Campaign — *Crispy Feast*",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Freshly hand-breaded crispy favorites, signature burgers, and iconic family buckets.",
          bgImage: sc.heroBgImage || img("photo-1626082927389-6cd097cdc6ec"),
          align: sc.heroAlign || "center",
          buttons: [{ id: genBlockId(), label: sc.ctaText || (ind && ind.portalCallToAction) || "Order Now", action: "page", target: "menu" }]
        }),
        slideshowBlock("restaurant"),
        b("editorial-grid", {
          title: "Signature Classics", subtitle: "",
          items: [
            { tag: "BURGERS", title: "Crispy Zinger & Double Crunch", linkLabel: "Order Now", image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&q=80" },
            { tag: "BUCKETS", title: "100% Crisp Fried Chicken Buckets", linkLabel: "Order Now", image: "https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=800&q=80" }
          ]
        }),
        b("quote-banner", { quote: "It's finger lickin' good", ctaLabel: "View the Full Menu", ctaAction: "page", ctaTarget: "menu" }),
        b("product-grid", featuredGridProps("restaurant")),
        b("footer-rich", {
          accentColor: "#e11d48", bgColor: "#180a0d",
          tagline: "Freshly made. Every single day.",
          desc: "Hand-breaded favourites, signature burgers and family buckets, ready for delivery or pickup.",
          contactAddress: "Main Kitchen", contactPhone: "+90 324 000 0000", contactEmail: "orders@example.com",
          socials: [{ label: "Instagram", href: "#" }, { label: "Facebook", href: "#" }],
          newsletter: true, newsletterTitle: "Offers straight to your inbox", newsletterSub: "Campaigns, new items and treats.",
          legal: "All rights reserved.",
          columns: [
            { title: "Menu", links: [{ label: "Full Menu", href: "#/p/menu" }, { label: "Campaigns", href: "#" }, { label: "Boxes & Buckets", href: "#" }] },
            { title: "About", links: [{ label: "Our Restaurants", href: "#" }, { label: "Allergen Info", href: "#" }, { label: "Careers", href: "#" }] }
          ]
        })
      ];
    }

    if (industryKey === "construction") {
      return [
        b("topbar", { message: "🏗️ ISO 9001 & OSHA Certified Heavy Engineering, Civil Infrastructure & General Contracting" }),
        b("hero", {
          eyebrow: "GENERAL CONTRACTING & INFRASTRUCTURE",
          title: sc.heroTitle || (ind && ind.portalHero) || "Mega Structures & *Heavy Engineering*",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Building bridges, high-rise commercial towers, and industrial complexes with world-class engineering precision.",
          bgImage: sc.heroBgImage || "",
          align: sc.heroAlign || "center",
          buttons: [
            { id: genBlockId(), label: sc.ctaText || (ind && ind.portalCallToAction) || "Submit Tender (RFP)", action: "scroll", target: "" },
            { id: genBlockId(), label: "Equipment Fleet", action: "page", target: "equipment" }
          ]
        }),
        slideshowBlock("construction"),
        b("stats", {
          accentColor: "#b45309",
          items: [
            { value: "450+", label: "Mega projects completed" },
            { value: "$1.8B+", label: "Contract value delivered" },
            { value: "100%", label: "OSHA safety compliance" },
            { value: "35+ yrs", label: "Engineering excellence" }
          ]
        }),
        b("card-grid", {
          title: "Our Engineering Services", subtitle: "Core Capabilities", columns: 3,
          items: [
            { icon: "🏗️", title: "Civil & Earthworks", tag: "Foundations, Piling & Highways", desc: "Mega earthmoving, deep pile foundations, bridge abutments and highway infrastructure.", color: "#b45309" },
            { icon: "🏢", title: "Commercial High-Rise", tag: "Skyscrapers & Office Towers", desc: "Structural steel framing, glass curtain walls, and mixed-use developments.", color: "#1e3a8a" },
            { icon: "🏭", title: "Industrial Plants", tag: "Factories & Logistics Hubs", desc: "Refineries, processing plants, automated warehouses and heavy industrial facilities.", color: "#7f1d1d" }
          ]
        }),
        b("rfq-form", {
          title: "Request For Proposal (RFP)", subtitle: "Invitation To Tender",
          perks: ["Formal Bill of Quantities (BOQ) & cost estimate", "Certified BIM 3D structural execution plan", "Dedicated Senior Project Director assigned"],
          submitLabel: "Submit Formal Tender Bid"
        }),
        b("product-grid", featuredGridProps("construction")),
        b("footer-rich", {
          accentColor: "#b45309", bgColor: "#160f07",
          tagline: "Building infrastructure that endures.",
          desc: "Heavy civil, commercial and industrial contracting delivered to programme.",
          contactAddress: "Central Yard", contactPhone: "+90 324 000 0000", contactEmail: "tenders@example.com",
          socials: [{ label: "LinkedIn", href: "#" }],
          newsletter: true, newsletterTitle: "Tender notices", newsletterSub: "New project awards and prequalification notices.",
          legal: "All rights reserved.",
          columns: [
            { title: "Capabilities", links: [{ label: "Civil Infrastructure", href: "#" }, { label: "Commercial High-Rise", href: "#" }, { label: "Industrial Plants", href: "#" }] },
            { title: "Tenders", links: [{ label: "Submit an RFP", href: "#" }, { label: "Equipment Fleet", href: "#/p/equipment" }, { label: "Safety & Compliance", href: "#" }] }
          ]
        })
      ];
    }

    if (industryKey === "manufacturing") {
      return [
        b("topbar", { message: "🏭 ISO 9001:2026, AS9100D & IATF 16949 Certified Smart Manufacturing Facilities" }),
        b("hero", {
          eyebrow: "INDUSTRY 4.0 SMART PLANT",
          title: sc.heroTitle || (ind && ind.portalHero) || "Precision OEM & *Smart Manufacturing*",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Custom 5-axis CNC machining, sheet metal fabrication, injection molding, and electronic SMT assembly.",
          bgImage: sc.heroBgImage || "",
          align: sc.heroAlign || "center",
          buttons: [
            { id: genBlockId(), label: sc.ctaText || (ind && ind.portalCallToAction) || "Request RFQ Quote", action: "scroll", target: "" },
            { id: genBlockId(), label: "Finished Goods Catalog", action: "page", target: "products" }
          ]
        }),
        slideshowBlock("manufacturing"),
        b("stats", {
          accentColor: "#d97706",
          items: [
            { value: "99.98%", label: "Precision accuracy rating" },
            { value: "5M+", label: "Parts produced annually" },
            { value: "48 hrs", label: "Rapid prototype dispatch" },
            { value: "ISO 9001", label: "Certified quality management" }
          ]
        }),
        b("card-grid", {
          title: "Our Manufacturing Capabilities", subtitle: "Production Lines", columns: 3,
          items: [
            { icon: "⚙️", title: "5-Axis CNC Machining", tag: "Milling, Turning & Micro-Specs", desc: "Sub-micron precision CNC milling, high-speed turning, and swiss machining.", color: "#d97706" },
            { icon: "✂️", title: "Sheet Metal Fabrication", tag: "Laser Cutting & Robotic Welding", desc: "Fiber laser cutting, CNC press brake bending, and automated welding lines.", color: "#0369a1" },
            { icon: "🧪", title: "Plastic Injection Molding", tag: "Rapid Tooling & Volume Molding", desc: "Custom mold tooling, multi-cavity production, and cleanroom molding.", color: "#15803d" }
          ]
        }),
        b("rfq-form", {
          title: "Submit Your OEM Specifications", subtitle: "Request For Quote",
          perks: ["DFM (Design for Manufacturability) Feedback", "Certified Mill Test Reports & Certificate of Conformance", "Dedicated Sales Engineer & Project Tracking"],
          submitLabel: "Submit Formal OEM RFQ"
        }),
        b("product-grid", featuredGridProps("manufacturing")),
        b("footer-rich", {
          accentColor: "#d97706", bgColor: "#150f06",
          tagline: "Precision, at production volume.",
          desc: "Custom CNC machining, sheet metal fabrication, injection moulding and SMT assembly.",
          contactAddress: "Plant 1 · Finished Goods Store", contactPhone: "+90 324 000 0000", contactEmail: "rfq@example.com",
          socials: [{ label: "LinkedIn", href: "#" }],
          newsletter: true, newsletterTitle: "Capability updates", newsletterSub: "New machining capacity and certifications.",
          legal: "All rights reserved.",
          columns: [
            { title: "Capabilities", links: [{ label: "5-Axis CNC Milling", href: "#" }, { label: "Sheet Metal", href: "#" }, { label: "SMT PCB Assembly", href: "#" }] },
            { title: "Work With Us", links: [{ label: "Submit an RFQ", href: "#" }, { label: "Finished Goods", href: "#/p/products" }, { label: "Quality & Certs", href: "#" }] }
          ]
        })
      ];
    }

    if (industryKey === "logistics") {
      return [
        b("tracker", {
          title: sc.heroTitle || (ind && ind.portalHero) || "Track Your Shipment",
          subtitle: sc.heroSub || (ind && ind.portalSubhero) || "Enter your shipment tracking number or bill of lading for real-time updates.",
          inputPlaceholder: "Tracking Number or Delivery Notice (e.g. MRV-RW-24-001)",
          submitLabel: sc.ctaText || (ind && ind.portalCallToAction) || "Track",
          sampleRefs: ["MRV-RW-24-001", "MRV-RW-24-002", "DLV-1002"],
          sideCards: [
            { icon: "🚚", title: "Calculate Freight Rate", desc: "Instant shipping estimates for domestic & global cargo" },
            { icon: "📦", title: "Schedule Cargo Pickup", desc: "Book warehouse dispatch or door-to-door pickup" }
          ]
        }),
        slideshowBlock("logistics"),
        b("steps", {
          title: "Ready to Ship Now?",
          items: [
            { icon: "📜📦", title: "Create a Shipment", desc: "Get started by creating your shipment online or over the phone.", buttonLabel: "Create a New Shipment" },
            { icon: "📦🏷️", title: "Pack Your Shipment", desc: "Pack your items securely and ensure that it follows our guidelines.", buttonLabel: "View Guidelines" },
            { icon: "🚚🏢", title: "Drop Off / Courier Pickup", desc: "Drop off your shipment at a Service Point or schedule a courier pickup.", buttonLabel: "Find a Service Point" }
          ]
        }),
        b("link-grid", {
          title: "Find What You Need, Fast",
          subtitle: "Looking for enterprise shipping services? We have you covered.",
          items: [
            { title: "Calculate Warehousing & Freight", linkLabel: "Calculate Cost" },
            { title: "Request Freight Pickup", linkLabel: "Start a Pickup" },
            { title: "Automated SMS & Email Alerts", linkLabel: "Sign Up for Updates" },
            { title: "Find Package By Shipment Details", linkLabel: "Start Search" },
            { title: "Customs eFiling & Compliance", linkLabel: "Check Status" },
            { title: "Customer Support & Inquiries", linkLabel: "Contact Support" }
          ]
        }),
        b("image-banner", {
          title: "Streamline the Way You Do Business With " + (sc.brandName || (ind && ind.name) || "Us"),
          subtitle: "Track, ship, and connect your global logistics operations all on one unified platform.",
          buttonLabel: "Get Started", action: "none", target: "",
          image: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=800&q=80"
        }),
        b("footer-rich", {
          accentColor: "#1aa6df", bgColor: "#061621",
          tagline: "Your cargo, always accounted for.",
          desc: "Global air and ocean freight with live milestone tracking and customs clearance.",
          contactAddress: "Mersin Main · Istanbul DC", contactPhone: "+90 324 000 0000", contactEmail: "desk@example.com",
          socials: [{ label: "LinkedIn", href: "#" }, { label: "X", href: "#" }],
          newsletter: true, newsletterTitle: "Service notices", newsletterSub: "Schedule changes, port updates and rate news.",
          legal: "All rights reserved.",
          columns: [
            { title: "Services", links: [{ label: "Freight Tracking", href: "#" }, { label: "Rate Calculator", href: "#" }, { label: "Customs Clearance", href: "#" }] },
            { title: "Support", links: [{ label: "24/7 Logistics Desk", href: "#" }, { label: "Schedule a Pickup", href: "#" }, { label: "Claims", href: "#" }] }
          ]
        })
      ];
    }

    return [];
  }

  /* ---- v2 → v3, applied to configs a business may already have edited.
     Purely additive: existing blocks, their props and their order are
     never touched. We only add what v3 introduced (a slideshow, and a
     products page for catalogue industries) if it isn't there yet, so
     nobody loses customisation by being upgraded. ---- */
  function upgradeV2toV3(cfg, industryKey) {
    const pages = cfg.pages || {};
    const main = pages.main;
    if (!main || !Array.isArray(main.blocks)) return cfg;

    const hasType = (type) => Object.keys(pages).some((s) =>
      ((pages[s] || {}).blocks || []).some((blk) => blk.type === type));

    if (!hasType("slideshow")) {
      const ss = slideshowBlock(industryKey);
      if (ss) {
        // Slot it directly under whatever opens the page (hero or tracker),
        // which is where a slideshow reads as part of the intro rather than
        // an afterthought pinned to the bottom.
        const openerIdx = main.blocks.findIndex((blk) => blk.type === "hero" || blk.type === "tracker");
        main.blocks.splice(openerIdx + 1, 0, ss);
      }
    }

    const pp = PRODUCT_PAGES[industryKey];
    if (pp && !pages[pp.slug]) {
      const page = productPageFor(industryKey);
      if (page) {
        pages[pp.slug] = page;
        cfg.navOrder = (cfg.navOrder || Object.keys(pages)).filter((s) => s !== pp.slug).concat([pp.slug]);
        // Demote the home grid to a featured preview that links to the new
        // page, rather than leaving the whole catalogue on the landing page.
        const homeGrid = main.blocks.find((blk) => blk.type === "product-grid");
        if (homeGrid) homeGrid.props = Object.assign({}, homeGrid.props, featuredGridProps(industryKey));
      }
    }

    cfg.pages = pages;
    cfg.themeVersion = CURRENT_VERSION;
    return cfg;
  }

  /**
   * migrateStorefrontConfig(rawConfig, industryKey) → storefrontConfig
   * Non-destructive: never mutates rawConfig in place.
   */
  function migrateStorefrontConfig(rawConfig, industryKey) {
    const cfg = JSON.parse(JSON.stringify(rawConfig || {}));

    if (PILOT_INDUSTRIES.indexOf(industryKey) === -1) return cfg; // untouched industries keep their bespoke renderer
    if (cfg.themeVersion >= CURRENT_VERSION) return cfg;
    if (isV2(cfg)) return upgradeV2toV3(cfg, industryKey);

    const sc = cfg || {};
    const ind = (window.INDUSTRIES && window.INDUSTRIES[industryKey]) || null;

    cfg.themeVersion = CURRENT_VERSION;
    cfg.theme = Object.assign({ accentColor: sc.accentColor || (ind && ind.accent) || "#111111" }, cfg.theme || {});
    cfg.pages = {
      main: {
        title: "Home", slug: "main", isHome: true,
        blocks: defaultBlocksFor(industryKey, sc, ind).filter(Boolean)
      }
    };
    cfg.navOrder = ["main"];

    // Catalogue-led industries (retail, fashion, restaurant, …) get their
    // products page generated for them; tracking/RFP-led ones don't sell
    // from a grid, so they deliberately get none.
    const productPage = productPageFor(industryKey);
    if (productPage) {
      cfg.pages[productPage.slug] = productPage;
      cfg.navOrder.push(productPage.slug);
    }

    // Nav bar item order — "actions" is the existing search+cart group (kept
    // together; they share a flex-gap wrapper in portal.html), reorderable
    // relative to the brand/logo and the page-nav links.
    cfg.nav = cfg.nav || { items: ["brand", "links", "actions"] };
    return cfg;
  }

  window.migrateStorefrontConfig = migrateStorefrontConfig;
})();
