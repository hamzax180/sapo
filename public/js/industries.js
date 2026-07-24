/* =================================================================
   MERVEKS SAP — industry registry + workspace profile
   -----------------------------------------------------------------
   A new business signs up, picks an industry and uploads a logo. That
   choice is saved as a "workspace profile" in localStorage. The rest of
   the app reads this profile to fit itself to the business:
     • branding   — company name + uploaded logo replace MERVEKS
     • navigation — each industry shows its own modules…
     • labels     — …under its own names (Shipments → Deliveries, etc.)
     • data       — start empty, or load that industry's sample pack

   When NO workspace exists, everything falls back to the original
   MERVEKS logistics demo, so nothing breaks for the seeded console.
   ================================================================= */
window.INDUSTRIES = {
  logistics: {
    key: "logistics",
    name: "Logistics & Trade",
    tagline: "Logistics & Trade",
    blurb: "Freight, shipments, customs and distribution across borders.",
    icon: "truck",
    accent: "#1aa6df",
    // "portal template" tells the portal frontend which UI to render
    portalTemplate: "tracker",
    portalHero: "Track Your Shipment",
    portalSubhero: "Enter your shipment reference number to get real-time updates.",
    portalCallToAction: "Track Now",
    // "*" = every module; otherwise an explicit, ordered allow-list
    modules: "*",
    labels: {},
    // logistics / fulfilment shape — used by the shipment & inventory forms
    shipModes: ["Railway", "Road", "Sea", "Multimodal"],
    freightDetails: true,            // show containers + tonnage columns
    refPrefix: "MRV-RW-24-",
    origin: "Mersin, TR",
    warehouses: ["Mersin Main", "Mersin Cold Store", "Istanbul DC"]
  },
  fashion: {
    key: "fashion",
    name: "Fashion & Apparel",
    tagline: "Fashion & Luxury Editorial",
    blurb: "Apparel, luxury collections, seasonal drops and lookbooks.",
    icon: "bag",
    accent: "#111111",
    portalTemplate: "fashion",
    portalHero: "THE COLLECTION 2026",
    portalSubhero: "Elevated everyday luxury. Designed with refined silhouettes.",
    portalCallToAction: "Shop Collection",
    modules: ["dashboard", "mywork", "orders", "clients", "inventory", "purchasing", "suppliers", "finance", "accounting", "history", "users", "settings"],
    labels: {
      orders:    ["Orders", "Customer orders"],
      inventory: ["Catalog", "Apparel & collections"]
    },
    shipModes: ["Courier", "Express Air", "Boutique Pickup"],
    freightDetails: false,
    refPrefix: "FSH-",
    origin: "Central Warehouse",
    warehouses: ["Boutique Store", "Main Warehouse"]
  },

  wholesale: {
    key: "wholesale",
    name: "Wholesale / Distribution",
    tagline: "Wholesale & Distribution",
    blurb: "Bulk buying and selling between suppliers and trade buyers.",
    icon: "package",
    accent: "#0f9d6b",
    portalTemplate: "catalog",
    portalHero: "Wholesale Catalogue",
    portalSubhero: "Browse our product range and place a trade order.",
    portalCallToAction: "Request Quote",
    modules: ["dashboard", "mywork", "quotes", "orders", "clients", "inventory", "shipments", "purchasing", "suppliers", "finance", "accounting", "history", "users", "settings"],
    labels: {
      clients:   ["Buyers", "Trade accounts"],
      shipments: ["Deliveries", "Outbound logistics"],
      quotes:    ["Price Offers", "Trade quotations"]
    },
    shipModes: ["Road", "Rail", "Sea", "Multimodal"],
    freightDetails: true,
    refPrefix: "DLV-",
    origin: "Central DC",
    warehouses: ["Central DC", "Regional Hub"]
  },
  retail: {
    key: "retail",
    name: "Retail Superstore",
    tagline: "Retail & Superstore",
    blurb: "Store sales, stock on shelves and supplier replenishment.",
    icon: "bag",
    accent: "#feee00",
    portalTemplate: "retail",
    portalHero: "Welcome to Our Store",
    portalSubhero: "Browse our full range and order online.",
    portalCallToAction: "Shop Now",
    modules: ["dashboard", "mywork", "orders", "clients", "inventory", "purchasing", "suppliers", "finance", "accounting", "history", "users", "settings"],
    labels: {
      orders:    ["Sales", "Counter & online sales"],
      clients:   ["Customers", "Customer accounts"],
      inventory: ["Stock", "Shelf & back-store stock"],
      suppliers: ["Vendors", "Replenishment partners"],
      purchasing: ["Stock Orders", "Replenishment"]
    },

    shipModes: ["Pickup", "Courier", "Local Delivery"],
    freightDetails: false,
    refPrefix: "DLV-",
    origin: "Store",
    warehouses: ["Store Floor", "Back Store"]
  },
  manufacturing: {
    key: "manufacturing",
    name: "Manufacturing",
    tagline: "Production & Supply",
    blurb: "Raw materials, production runs, finished goods and dispatch.",
    icon: "factory",
    accent: "#d97706",
    portalTemplate: "manufacturing",
    portalHero: "Precision OEM & Smart Manufacturing",
    portalSubhero: "Custom CNC machining, sheet metal, injection molding & batch production.",
    portalCallToAction: "Request RFQ Quote",

    modules: ["dashboard", "mywork", "quotes", "orders", "clients", "inventory", "shipments", "purchasing", "suppliers", "finance", "accounting", "attendance", "payroll", "history", "users", "settings"],
    labels: {
      orders:    ["Production Orders", "Work orders & runs"],
      clients:   ["Buyers", "Industrial buyers"],
      inventory: ["Materials & Goods", "Raw materials & finished stock"],
      shipments: ["Dispatch", "Outbound freight"],
      suppliers: ["Suppliers", "Raw-material partners"],
      purchasing: ["Material Orders", "Raw-material procurement"]
    },
    shipModes: ["Road", "Rail", "Sea", "Multimodal"],
    freightDetails: true,
    refPrefix: "DSP-",
    origin: "Plant 1",
    warehouses: ["Raw Material Store", "Finished Goods", "Plant 1"]
  },
  restaurant: {
    key: "restaurant",
    name: "Restaurant / Food Service",
    tagline: "Food Service",
    blurb: "Menu, table & online orders, kitchen stock and supplier deliveries.",
    icon: "utensils",
    accent: "#e11d48",
    portalTemplate: "menu",
    portalHero: "Order Online",
    portalSubhero: "Fresh food, delivered to your door or ready for pickup.",
    portalCallToAction: "Order Now",
    modules: ["dashboard", "mywork", "orders", "clients", "inventory", "purchasing", "suppliers", "finance", "accounting", "attendance", "payroll", "history", "users", "settings"],
    labels: {
      orders:    ["Orders", "Table & online orders"],
      clients:   ["Guests", "Guests & catering clients"],
      inventory: ["Menu & Stock", "Ingredients & menu items"],
      suppliers: ["Suppliers", "Produce & beverage partners"],
      purchasing: ["Supply Orders", "Kitchen procurement"],
      finance:   ["Revenue & Invoices", "Sales & receivables"]
    },
    shipModes: ["Pickup", "Courier", "Local Delivery"],
    freightDetails: false,
    refPrefix: "DLV-",
    origin: "Main Kitchen",
    warehouses: ["Dry Store", "Cold Store", "Bar"]
  },
  construction: {
    key: "construction",
    name: "Construction",
    tagline: "Projects & Build",
    blurb: "Projects, material procurement, site deliveries and subcontractors.",
    icon: "hammer",
    accent: "#b45309",
    portalTemplate: "inquiry",
    portalHero: "Start Your Project",
    portalSubhero: "Tell us about your project and get a free quote.",
    portalCallToAction: "Get a Quote",
    modules: ["dashboard", "mywork", "quotes", "orders", "clients", "inventory", "shipments", "purchasing", "suppliers", "finance", "accounting", "attendance", "payroll", "history", "users", "settings"],
    labels: {
      quotes:    ["Tenders", "Bids & estimates"],
      orders:    ["Projects", "Active projects"],
      clients:   ["Clients", "Developers & owners"],
      inventory: ["Materials", "Site materials & equipment"],
      shipments: ["Site Deliveries", "Material logistics"],
      suppliers: ["Suppliers", "Material & equipment partners"],
      purchasing: ["Material Orders", "Site procurement"]
    },
    shipModes: ["Road", "Heavy Haul", "Crane Lift"],
    freightDetails: true,
    refPrefix: "SITE-",
    origin: "Central Yard",
    warehouses: ["Central Yard", "Site Store"]
  },
  services: {
    key: "services",
    name: "Services / Consulting",
    tagline: "Professional Services",
    blurb: "Client projects, billable work, proposals and invoicing.",
    icon: "briefcase",
    accent: "#0f766e",
    portalTemplate: "services",
    portalHero: "Professional Strategy & Advisory",
    portalSubhero: "Strategy, digital transformation, financial advisory & corporate risk mitigation.",
    portalCallToAction: "Request RFP Proposal",

    modules: ["dashboard", "mywork", "quotes", "orders", "clients", "finance", "accounting", "attendance", "payroll", "history", "users", "settings"],
    labels: {
      quotes:    ["Proposals", "Scopes & estimates"],
      orders:    ["Projects", "Engagements"],
      clients:   ["Clients", "Client accounts"],
      finance:   ["Billing & Invoices", "Receivables"]
    },
    shipModes: ["Remote", "On-site"],
    freightDetails: false,
    refPrefix: "ENG-",
    origin: "Head Office",
    warehouses: ["Head Office"]
  }
};

/* ---------------- Workspaces (multi-tenant) ----------------
   Several companies can register on one device. They are stored as a list
   under "sap_workspaces"; the one currently signed in is pointed to by
   "sap_active_ws". Each company's records live in its own Store namespace. */
window.Workspace = (function () {
  const LIST_KEY = "sap_workspaces";
  const ACTIVE_KEY = "sap_active_ws";

  function all() { try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; } catch (e) { return []; } }
  function saveAll(list) { localStorage.setItem(LIST_KEY, JSON.stringify(list)); }
  function activeId() { try { return localStorage.getItem(ACTIVE_KEY) || null; } catch (e) { return null; } }
  function active() { const id = activeId(); return id ? (all().find((w) => w.id === id) || null) : null; }
  function byId(id) { return all().find((w) => w.id === id) || null; }

  function add(ws) { const list = all(); list.push(ws); saveAll(list); return ws; }
  function update(id, patch) { const list = all(); const i = list.findIndex((w) => w.id === id); if (i > -1) { list[i] = Object.assign({}, list[i], patch); saveAll(list); return list[i]; } return null; }
  function remove(id) { saveAll(all().filter((w) => w.id !== id)); if (activeId() === id) clearActive(); }
  function setActive(id) { if (id) localStorage.setItem(ACTIVE_KEY, id); else localStorage.removeItem(ACTIVE_KEY); if (window.Store && Store.setActiveWs) Store.setActiveWs(id || null); }
  function clearActive() { localStorage.removeItem(ACTIVE_KEY); if (window.Store && Store.setActiveWs) Store.setActiveWs(null); }

  /* back-compat aliases used around the app */
  function get() { return active(); }
  function set(p) { update(p.id, p); }
  function clear() { clearActive(); }
  function exists() { return !!active(); }

  /* Active industry key — falls back to logistics if nothing is active. */
  function industryKey() { const w = active(); return (w && w.industry) || "logistics"; }
  function preset() { return INDUSTRIES[industryKey()] || INDUSTRIES.logistics; }

  /* Branding — the active company's values, else neutral platform defaults. */
  const cfg = window.SAP_CONFIG || {};
  function company() { const w = active(); return (w && w.company) || "WeboCloud"; }
  function tagline() { const w = active(); return (w && w.tagline) || preset().tagline || cfg.TAGLINE || ""; }
  function logo() { const w = active(); return (w && w.logo) || null; }
  function email() { const w = active(); return (w && w.email) || ""; }
  function ownerName() { const w = active(); return (w && w.owner) || ""; }

  /* Brand bundle used by every customer-facing document (invoice PDF, shipment
     label, payslip, accounting report, public track portal). Always reflects
     the signed-in workspace so nothing prints a foreign company's name. */
  function brand() {
    return {
      company: company(),
      tagline: tagline(),
      email: email(),
      logo: logo(),
      industry: preset().name
    };
  }

  /* Navigation — is a module visible for this industry? */
  function modules() { return preset().modules; }
  function hasModule(id) {
    const m = modules();
    if (m === "*" ) return true;
    // these are always reachable regardless of the preset
    if (id === "dashboard" || id === "mywork" || id === "settings" || id === "history" || id === "users" || id === "attendance" || id === "payroll") return true;
    return m.indexOf(id) > -1;
  }
  /* Label override for a nav id → [label, subtitle] or null. */
  function label(id) { const l = preset().labels || {}; return l[id] || null; }

  /* Operational shape of the active industry — consumed by the shipment,
     inventory and purchasing forms so a retail shop never sees "Railway"
     or "Mersin Main" as a default. Falls back to the logistics preset. */
  const LOG = INDUSTRIES.logistics;
  function shipModes()  { return preset().shipModes  || LOG.shipModes; }
  function freightDetails() { const p = preset(); return p.freightDetails !== undefined ? p.freightDetails : true; }
  function refPrefix()  { return preset().refPrefix  || LOG.refPrefix; }
  function origin()     { return preset().origin     || LOG.origin; }
  function warehouses() { return preset().warehouses || LOG.warehouses; }

  /* Sample-data pack for the "load sample data" toggle, keyed by the same
     localStorage collection keys the Store uses. Logistics reuses the rich
     MERVEKS seed; the others get a small, coherent starter set. */
  function sampleFor(key) {
    if (key === "logistics") return (window.SEED_DATA ? window.SEED_DATA() : {});
    return window.SAMPLE_PACKS ? window.SAMPLE_PACKS(key) : {};
  }

  function checkSubscription() {
    // TEMP TEST BYPASS: payment lock disabled app-wide for testing.
    // Delete this early return to restore the real paywall.
    return { locked: false, trial: false };

    const w = active();
    if (!w) return { locked: false, trial: false };
    if (w.email === "admin@demo.com" || String(w.company).startsWith("Demo ")) {
      return { locked: false, trial: false };
    }
    const isPaid = !!w.paid;
    if (isPaid) return { locked: false, trial: false };

    // No trial period - immediately locked until payment
    return { locked: true, trial: false };
  }

  return {
    all, active, activeId, byId, add, update, remove, setActive, clearActive,
    get, set, clear, exists,
    industryKey, preset,
    company, tagline, logo, email, ownerName, brand,
    modules, hasModule, label,
    shipModes, freightDetails, refPrefix, origin, warehouses,
    sampleFor,
    checkSubscription
  };
})();
