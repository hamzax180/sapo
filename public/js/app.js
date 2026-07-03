/* =================================================================
   MERVEKS SAP — application shell & router
   Boots the console: guards auth, resolves the data connection, paints
   the sidebar / top bar, and routes hash changes to module views.
   ================================================================= */
window.App = (function () {
  const { icon, esc } = UI;

  const NAV = [
    { group: "Main" },
    { id: "dashboard", label: "Dashboard", ic: "grid" },
    { id: "mywork", label: "My Work", ic: "inbox", count: "mywork" },
    { group: "Sales" },
    { id: "quotes", label: "Quotations", ic: "quote", count: "quotes" },
    { id: "orders", label: "Orders", ic: "cart", count: "orders" },
    { id: "clients", label: "Clients", ic: "building" },
    { group: "Operations" },
    { id: "shipments", label: "Shipments", ic: "truck", count: "shipments" },
    { id: "inventory", label: "Inventory", ic: "box" },
    { group: "Procurement" },
    { id: "purchasing", label: "Purchasing", ic: "bag", count: "purchasing" },
    { id: "suppliers", label: "Suppliers", ic: "factory" },
    { group: "Finance" },
    { id: "finance", label: "Finance & Invoices", ic: "receipt" },
    { id: "accounting", label: "Accounting", ic: "pie" },
    { group: "People" },
    { id: "attendance", label: "Attendance", ic: "clock" },
    { id: "payroll", label: "Payroll", ic: "wallet" },
    { id: "users", label: "Team & Accounts", ic: "shield" },
    { group: "System" },
    { id: "history", label: "Activity History", ic: "history" },
    { id: "settings", label: "Settings", ic: "settings" }
  ];
  const TITLES = {
    dashboard: ["Dashboard", "Operations overview"],
    mywork: ["My Work", "Your tasks & handoffs"],
    quotes: ["Quotations", "Price offers"],
    orders: ["Orders", "Sales orders"],
    clients: ["Clients", "Customer accounts"],
    shipments: ["Shipments", "Logistics & freight"],
    inventory: ["Inventory", "Products & stock"],
    purchasing: ["Purchasing", "Procurement & bills"],
    suppliers: ["Suppliers", "Procurement partners"],
    finance: ["Finance", "Invoices & receivables"],
    accounting: ["Accounting", "AR · AP · cash · P&L"],
    attendance: ["Attendance", "Clock-in & daily attendance"],
    payroll: ["Payroll", "Salaries, pay runs & payslips"],
    history: ["Activity History", "Audit trail"],
    users: ["Team & Accounts", "Owner & employee access"],
    settings: ["Settings", "System & connection"]
  };
  // settings, track and profile are always reachable; everything else is
  // permission-gated AND must be enabled for the workspace's industry.
  const inIndustry = (id) => !window.Workspace || Workspace.hasModule(id);
  const canRoute = (id) =>
    id === "settings" || id === "track" || id === "profile" || id === "mywork" ||
    (Auth.can(id, "view") && inIndustry(id));

  let current = "dashboard";
  let counts = {};
  let unread = 0;

  function route() {
    const h = (location.hash || "#/dashboard").replace("#/", "");
    const path = h.split("?")[0];
    if (!Views[path] || !canRoute(path)) return "dashboard";
    return path;
  }

  async function loadCounts() {
    const [sh, or, qu, po] = await Promise.all([Store.list("shipments"), Store.list("orders"), Store.list("quotes"), Store.list("purchaseorders")]);
    counts = {
      shipments: sh.filter((s) => !["Delivered", "Cancelled"].includes(s.status)).length,
      orders: or.filter((o) => ["Pending", "Confirmed", "Shipped"].includes(o.status)).length,
      quotes: qu.filter((q) => ["Draft", "Sent"].includes(q.status)).length,
      purchasing: po.filter((p) => ["Draft", "Sent"].includes(p.status)).length
    };
    // personal work queue + unread notifications (for the My Work badge and the bell)
    try {
      const u = Auth.current();
      if (u && window.Workflow) { counts.mywork = (await Workflow.summary(u)).total; unread = await Workflow.unread(u.id); }
    } catch (e) { /* non-fatal */ }
  }

  function sidebarHTML() {
    // keep only items the current role may see
    const items = NAV.filter((n) => n.group || canRoute(n.id));
    let links = "";
    items.forEach((n, i) => {
      if (n.group) {
        // skip a group header that has no visible item before the next group
        let has = false;
        for (let j = i + 1; j < items.length && !items[j].group; j++) { has = true; break; }
        if (has) links += '<div class="sb-group">' + UI.t(n.group) + "</div>";
        return;
      }
      const cnt = n.count && counts[n.count] ? '<span class="badge-count">' + counts[n.count] + "</span>" : "";
      // each industry can rename a module (e.g. Shipments → Deliveries)
      const ov = window.Workspace && Workspace.label(n.id);
      const lbl = ov ? ov[0] : n.label;
      links += '<button class="sb-link" data-nav="' + n.id + '">' + icon(n.ic) + "<span>" + UI.t(lbl) + "</span>" + cnt + "</button>";
    });
    // workspace branding: uploaded logo + company name, else the MERVEKS mark
    const defaultMark = '<svg viewBox="0 0 64 64" class="brand-mark" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="sb-grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1aa6df"/><stop offset="100%" stop-color="#5cb12f"/></linearGradient></defs><circle cx="20" cy="27" r="7.5" fill="url(#sb-grad)"/><circle cx="32" cy="23" r="9.5" fill="url(#sb-grad)"/><circle cx="44" cy="27" r="7.5" fill="url(#sb-grad)"/><rect x="12.5" y="29" width="39" height="8" fill="url(#sb-grad)"/><path d="M14 37 L20 50 L27 40 L32 50 L37 40 L44 50 L50 37 Z" fill="url(#sb-grad)"/><path d="M20 20 L26 35 L32 25 L38 35 L44 20" fill="none" stroke="#0b1e33" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const ws = window.Workspace;
    const logo = ws && ws.logo();
    const mark = logo ? '<img src="' + logo + '" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:7px" />' : defaultMark;
    const company = ws ? ws.company() : "WEBOCLOUD";
    const sub = ws ? (ws.tagline() || UI.t("SAP Console")) : "Operations Console";
    
    const subStatus = window.Workspace && Workspace.checkSubscription ? Workspace.checkSubscription() : { locked: false, trial: false };
    const trialBadge = subStatus.trial ? '<div style="margin-top:4px;"><span style="background:#eef8fe; color:var(--accent); border:1px solid #9cc4e4; font-size:0.65rem; font-weight:700; padding:2px 6px; border-radius:999px; text-transform:uppercase; letter-spacing:0.03em; display:inline-block;">1 Day Trial</span></div>' : '';

    // legacy MERVEKS demo links to merveks.com; a registered workspace
    // shows its own name instead of a foreign marketing link
    const foot = (ws && ws.exists())
      ? '<div class="sb-foot"><span class="sb-site" style="opacity:.7">' + icon("shield") + "<span>" + esc(company) + "</span></span></div>"
      : '<div class="sb-foot"><a class="sb-site" href="' + Store.siteUrl() + '" target="_blank" rel="noopener">' + icon("external") + "<span>" + UI.t("Visit merveks.com") + '</span></a></div>';
    return (
      '<div class="sb-brand"><div class="sb-logo">' + mark + '</div><div><div class="bt">' + esc(company) + '</div><div class="bs">' + esc(sub) + '</div>' + trialBadge + '</div></div>' +
      '<nav class="sb-nav">' + links + "</nav>" +
      foot
    );
  }

  function topbarHTML() {
    const live = Store.isConnected();
    const u = Auth.current() || {};
    const lang = UI.getLang();
    
    let activeLangName = "Türkçe";
    if (lang === "en") activeLangName = "English";

    const langDropdownHTML = 
      '<div class="lang-dropdown" id="langDropdown">' +
        '<button class="lang-trigger" id="langTrigger">' +
          '<span class="lang-current">' + activeLangName + '</span>' +
          '<svg class="lang-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
        '</button>' +
        '<ul class="lang-list" id="langList">' +
          '<li data-value="en" class="lang-item' + (lang === "en" ? " active" : "") + '">English</li>' +
          '<li data-value="tr" class="lang-item' + (lang === "tr" ? " active" : "") + '">Türkçe</li>' +
        '</ul>' +
      '</div>';
      
    const translatedRole = UI.t(u.role);
    
    return (
      '<button class="hamburger" id="hamburger">' +
        '<span>' + UI.t("MENU") + '</span>' +
        '<div class="menu-icon"><span></span><span></span><span></span></div>' +
      '</button>' +
      '<div class="tb-spacer"></div>' +
      '<button class="help-btn" id="tourBtn" title="' + UI.t("Take a tour") + '" aria-label="' + UI.t("Take a tour") + '">' + icon("help") + "</button>" +
      '<div class="notif-wrap" id="notifWrap">' +
        '<button class="notif-btn" id="notifBtn" title="' + UI.t("Notifications") + '" aria-label="' + UI.t("Notifications") + '">' + icon("bell") +
          (unread ? '<span class="notif-dot">' + (unread > 9 ? "9+" : unread) + "</span>" : "") + "</button>" +
        '<div class="notif-panel" id="notifPanel"></div>' +
      "</div>" +
      langDropdownHTML +

      '<div class="tb-user" id="userMenu"><div class="avatar">' + UI.initials(u.name) + "</div>" +
        '<div><div class="un">' + esc(u.name || "") + '</div><div class="ur">' + esc(translatedRole || "") + "</div></div>" +
        '<button class="icon-btn" id="logoutBtn" title="' + UI.t("Sign out") + '" style="border:none;background:none">' + icon("logout") + "</button></div>"
    );
  }

  function setActive() {
    document.querySelectorAll(".sb-link").forEach((l) => l.classList.toggle("active", l.dataset.nav === current));
  }

  // re-render the persistent chrome (sidebar counts + connection pill)
  async function refreshChrome() {
    await loadCounts();
    document.getElementById("sidebar").innerHTML = sidebarHTML();
    document.getElementById("topbar").innerHTML = topbarHTML();
    wireChrome();
    setActive();
  }

  function wireChrome() {
    document.querySelectorAll(".sb-link").forEach((l) =>
      l.addEventListener("click", () => { location.hash = "#/" + l.dataset.nav; closeSidebar(); }));
    const lo = document.getElementById("logoutBtn");
    if (lo) {
      lo.addEventListener("click", (e) => {
        e.stopPropagation();
        // throwaway demo companies are discarded on logout; real ones stay
        let demo = null;
        if (window.Workspace && Workspace.exists()) {
          const w = Workspace.active();
          if (w && (String(w.company).startsWith("Demo ") || w.email === "admin@demo.com")) demo = w;
        }
        Auth.logout();   // also clears the active-company pointer
        if (demo) {
          if (window.Store && Store.purgeWorkspace) Store.purgeWorkspace(demo.id);
          if (window.Workspace) Workspace.remove(demo.id);
          location.href = "signup.html";
        } else {
          location.href = "login.html";
        }
      });
    }
    
    const um = document.getElementById("userMenu");
    if (um) {
      um.addEventListener("click", (e) => {
        if (e.target.closest("#logoutBtn")) return;
        location.hash = "#/profile";
      });
    }
    
    const hb = document.getElementById("hamburger");
    if (hb) {
      hb.addEventListener("click", () => {
        if (window.innerWidth > 880) {
          const app = document.getElementById("app");
          app.classList.toggle("sidebar-collapsed");
          localStorage.setItem("sap_sidebar_collapsed", app.classList.contains("sidebar-collapsed"));
        } else {
          openSidebar();
        }
      });
    }
    
    // Wire the help / guided-tour button
    const tb = document.getElementById("tourBtn");
    if (tb && window.Tour) tb.addEventListener("click", () => Tour.start());

    // Wire the notification bell + dropdown
    const nb = document.getElementById("notifBtn");
    const np = document.getElementById("notifPanel");
    const nw = document.getElementById("notifWrap");
    if (nb && np && nw) {
      nb.addEventListener("click", async (e) => {
        e.stopPropagation();
        const open = nw.classList.toggle("open");
        if (open) await renderNotifs(np, nw);
      });
      np.addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", () => nw.classList.remove("open"));
    }

    // Wire custom language dropdown
    const trigger = document.getElementById("langTrigger");
    const dropdown = document.getElementById("langDropdown");
    if (trigger && dropdown) {
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.toggle("open");
      });
      document.addEventListener("click", () => {
        dropdown.classList.remove("open");
      });
      dropdown.querySelectorAll(".lang-item").forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          UI.setLang(item.dataset.value);
          location.reload();
        });
      });
    }
  }

  // render the notification dropdown contents
  async function renderNotifs(np, nw) {
    const u = Auth.current();
    if (!u || !window.Workflow) { np.innerHTML = ""; return; }
    const list = await Workflow.listFor(u.id);
    const anyUnread = list.some((n) => !n.read);
    const head = '<div class="np-head"><span>' + UI.t("Notifications") + "</span>" +
      (anyUnread ? '<button class="np-all" id="npAll">' + UI.t("Mark all read") + "</button>" : "") + "</div>";
    const body = list.length
      ? list.slice(0, 12).map((n) =>
          '<button class="np-item' + (n.read ? "" : " unread") + '" data-link="' + esc(n.link || "#/mywork") + '" data-id="' + esc(n.id) + '">' +
            '<div class="np-t">' + esc(n.title) + "</div>" +
            '<div class="np-b">' + esc(n.body) + "</div>" +
            '<div class="np-m">' + esc(n.fromName || "") + " · " + UI.rel(n.ts) + "</div>" +
          "</button>").join("")
      : '<div class="np-empty">' + UI.t("You're all caught up.") + "</div>";
    np.innerHTML = head + '<div class="np-list">' + body + "</div>" +
      '<button class="np-foot" id="npOpen">' + icon("inbox") + UI.t("Open My Work") + "</button>";

    np.querySelectorAll(".np-item").forEach((b) => b.addEventListener("click", async () => {
      await Workflow.markRead(b.dataset.id);
      nw.classList.remove("open");
      location.hash = b.dataset.link || "#/mywork";
      refreshChrome();
    }));
    const all = document.getElementById("npAll");
    if (all) all.addEventListener("click", async (e) => { e.stopPropagation(); await Workflow.markAllRead(u.id); await renderNotifs(np, nw); refreshChrome(); });
    const open = document.getElementById("npOpen");
    if (open) open.addEventListener("click", () => { nw.classList.remove("open"); location.hash = "#/mywork"; });
  }

  function openSidebar() { document.getElementById("sidebar").classList.add("open"); document.getElementById("sbBackdrop").classList.add("open"); }
  function closeSidebar() { document.getElementById("sidebar").classList.remove("open"); document.getElementById("sbBackdrop").classList.remove("open"); }

  async function reload() {
    current = route();
    const isPublic = current === "track";
    
    // Toggle public guest page mode
    const appEl = document.getElementById("app");
    if (appEl) {
      appEl.classList.toggle("public-mode", isPublic);
    }
    const sb = document.getElementById("sidebar");
    const tb = document.getElementById("topbar");
    if (sb) sb.style.display = isPublic ? "none" : "";
    if (tb) tb.style.display = isPublic ? "none" : "";
    
    if (!isPublic) {
      setActive();
    }
    
    const el = document.getElementById("view");
    
    // Check subscription status
    const subStatus = window.Workspace && Workspace.checkSubscription ? Workspace.checkSubscription() : { locked: false, trial: false };
    if (subStatus.locked && !isPublic) {
      el.innerHTML = `
        <div class="lock-overlay" style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; text-align:center; padding:40px 20px;">
          <div style="background:#fdf2f2; color:#9b1c1c; width:80px; height:80px; border-radius:50%; display:grid; place-items:center; margin-bottom:24px; box-shadow:0 8px 24px rgba(155,28,28,0.15);">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>
          <h2 style="font-family:var(--font-head); font-weight:800; color:var(--navy-800); font-size:1.8rem; margin-bottom:12px; letter-spacing:-0.01em;">COMPANY ACCOUNT LOCKED UNTIL PAYMENT</h2>
          <p style="color:var(--muted); font-size:0.98rem; max-width:440px; line-height:1.5; margin-bottom:28px;">To activate your company account and start using WeboCloud SAP Console, please complete your subscription payment.</p>
          <a href="checkout.html" class="btn btn-primary" style="padding:14px 32px; font-weight:700; font-size:1rem; border-radius:12px; box-shadow:0 6px 20px rgba(26,166,223,0.25); text-decoration:none;">GO TO PAYMENT</a>
        </div>
      `;
      const sidebarNav = document.querySelector(".sb-nav");
      if (sidebarNav) {
        sidebarNav.style.pointerEvents = "none";
        sidebarNav.style.opacity = "0.5";
      }
      return;
    } else {
      const sidebarNav = document.querySelector(".sb-nav");
      if (sidebarNav) {
        sidebarNav.style.pointerEvents = "";
        sidebarNav.style.opacity = "";
      }
    }

    el.innerHTML = '<div class="view-loading"><div class="spinner"></div><span>' + UI.t("Loading…") + '</span></div>';
    await Views[current](el);
    await loadCounts();
    
    // update only the nav counts without nuking the sidebar
    if (!isPublic) {
      document.querySelectorAll(".sb-link[data-nav]").forEach((l) => {
        const navDef = NAV.find((n) => n.id === l.dataset.nav);
        const existing = l.querySelector(".badge-count");
        if (navDef && navDef.count) {
          const c = counts[navDef.count];
          if (c) { if (existing) existing.textContent = c; else l.insertAdjacentHTML("beforeend", '<span class="badge-count">' + c + "</span>"); }
          else if (existing) existing.remove();
        }
      });
    }
    window.scrollTo(0, 0);
  }

  async function boot() {
    if (!Auth.requireAuth()) return;
    await Store.init();
    // brand the shell to the signed-in company
    if (window.Workspace) {
      const co = Workspace.company();
      document.title = co + " — Operations Console";
      const plw = document.getElementById("plWord");
      if (plw) plw.textContent = (co || "").toUpperCase();
    }
    await loadCounts();
    current = route();

    // Restore collapsed state on boot
    const collapsed = localStorage.getItem("sap_sidebar_collapsed") === "true";
    const app = document.getElementById("app");
    if (collapsed && window.innerWidth > 880) {
      app.classList.add("sidebar-collapsed");
    }

    document.getElementById("sidebar").innerHTML = sidebarHTML();
    document.getElementById("topbar").innerHTML = topbarHTML();
    document.getElementById("sbBackdrop").addEventListener("click", closeSidebar);
    wireChrome();

    document.getElementById("app").hidden = false;
    window.addEventListener("hashchange", reload);
    await reload();

    // reveal the app and fade out the preloader
    const pl = document.getElementById("preloader");
    if (pl) { pl.classList.add("hide"); setTimeout(() => pl.remove(), 600); }

    // first-login guided tour (once per user)
    if (window.Tour) Tour.maybeStart();
  }

  return { boot, reload, refreshChrome };
})();

window.showSidebarAnimation = function(navId, text, colorClass) {
  const btn = document.querySelector(`.sb-link[data-nav="${navId}"]`);
  if (!btn) return;
  btn.querySelectorAll('.sb-anim-bubble').forEach(b => b.remove());
  const bubble = document.createElement('span');
  bubble.className = `sb-anim-bubble anim-${colorClass}`;
  bubble.textContent = text;
  btn.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2800);
};

document.addEventListener("DOMContentLoaded", App.boot);
