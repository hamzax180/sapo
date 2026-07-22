/* =================================================================
   MERVEKS SAP — shared UI kit + auth
   Icons, formatters, toasts, modals, drawer, confirm dialogs and the
   lightweight session/auth helper used across every view.
   ================================================================= */

/* ---------------- Auth ---------------- */
window.Auth = (function () {
  const KEY = "sap_session";

  /* role → permissions. Owner = everything; employees are scoped. */
  const ROLE_PERMS = {
    "Owner":               { nav: "*", edit: "*", del: "*", users: true, ai: true, connect: true },
    "HR Manager":          { nav: ["dashboard", "attendance", "payroll", "users"], edit: ["attendance", "payroll", "users"], del: [], users: true, ai: false, connect: false },
    "Operations Manager":  { nav: ["dashboard", "quotes", "orders", "shipments", "inventory", "purchasing", "clients", "suppliers", "attendance"], edit: ["quotes", "orders", "shipments", "inventory", "purchasing", "attendance"], del: [], users: false, ai: false, connect: false },
    "Finance Officer":     { nav: ["dashboard", "clients", "finance", "attendance", "payroll"], edit: ["finance", "attendance"], del: [], users: false, ai: true, connect: false },
    "Trade Specialist":    { nav: ["dashboard", "quotes", "orders", "shipments", "inventory", "clients", "suppliers", "attendance"], edit: ["quotes", "orders", "clients", "suppliers", "inventory", "attendance"], del: [], users: false, ai: false, connect: false }
  };

  function perms() { const u = current(); return (u && ROLE_PERMS[u.role]) || ROLE_PERMS["Trade Specialist"]; }
  function can(area, action) {
    const p = perms();
    if (!current()) return false;
    if (!action || action === "view") return p.nav === "*" || p.nav.indexOf(area) > -1;
    if (action === "edit") return p.edit === "*" || (p.edit.indexOf && p.edit.indexOf(area) > -1);
    if (action === "delete") return p.del === "*" || (p.del.indexOf && p.del.indexOf(area) > -1);
    if (action === "users") return !!p.users;
    if (action === "ai") return !!p.ai;
    if (action === "connect") return !!p.connect;
    return false;
  }
  function isOwner() { const u = current(); return u && u.role === "Owner"; }

  function current() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }

  /* Sign in. In multi-tenant mode the caller passes the chosen company's
     workspace id so we read that company's user list (and scope all data to
     it). LIVE backend mode is unchanged. */
  async function login(email, password, wsId) {
    if (Store.isConnected && Store.isConnected()) {
      const session = await Store.login(email, password);
      if (!session) return null;
      localStorage.setItem(KEY, JSON.stringify(session));
      Store.logAction("login", "session", session.id, session.name + " signed in");
      return session;
    }
    if (wsId && window.Workspace) Workspace.setActive(wsId);   // namespace before reading users
    const users = await Store.list("users");
    const u = users.find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase() && x.password === password && x.active);
    if (!u) return null;
    const session = { id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept };
    localStorage.setItem(KEY, JSON.stringify(session));
    Store.logAction("login", "session", u.id, u.name + " signed in");
    return session;
  }

  /* Sign in with just an email + password — no need to pick a company first.
     We search every registered company on this device for a matching user and
     sign into whichever one owns that email. */
  async function loginAny(email, password) {
    if (Store.isConnected && Store.isConnected()) return login(email, password);
    const list = (window.Workspace ? Workspace.all() : []);
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      let users = [];
      try { users = JSON.parse(localStorage.getItem("sap_" + w.id + "_users")) || []; } catch (e) {}
      const u = users.find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase() && x.password === password && x.active);
      if (u) {
        if (window.Workspace) Workspace.setActive(w.id);
        const session = { id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept };
        localStorage.setItem(KEY, JSON.stringify(session));
        Store.logAction("login", "session", u.id, u.name + " signed in");
        return session;
      }
    }
    return null;
  }

  /* department a role belongs to (for the Team module) */
  const DEPT_FOR = { "Owner": "Management", "HR Manager": "Human Resources", "Operations Manager": "Operations", "Finance Officer": "Finance", "Trade Specialist": "Sales" };

  /* Register a brand-new company. Creates an isolated workspace, the owner
     account, any employee accounts (with roles), optionally loads the
     industry sample pack, then signs the owner in. */
  async function register(opts) {
    opts = opts || {};
    const presets = window.INDUSTRIES || {};
    const ind = presets[opts.industry] ? opts.industry : "logistics";
    const wsId = "ws_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // make this company active first so the Store writes into its namespace
    if (window.Workspace) Workspace.setActive(wsId);
    else if (Store.setActiveWs) Store.setActiveWs(wsId);

    const pack = opts.sampleData && window.Workspace ? Workspace.sampleFor(ind) : {};
    if (pack) delete pack.sap_users;            // never overwrite the real team
    if (Store.installWorkspaceData) Store.installWorkspaceData(pack, wsId);

    const today = new Date().toISOString().slice(0, 10);
    const ownerUser = {
      id: "U-001", name: opts.owner || "Owner",
      email: String(opts.email || "").toLowerCase(), password: opts.password || "",
      role: "Owner", dept: "Management", active: true,
      joined: today, salary: 0, currency: "USD", raiseLogs: []
    };
    const users = [ownerUser];
    (opts.employees || []).forEach((e, i) => {
      if (!e || !e.email) return;
      const role = ROLE_PERMS[e.role] ? e.role : "Trade Specialist";
      users.push({
        id: "U-" + String(i + 2).padStart(3, "0"),
        name: (e.name && e.name.trim()) || String(e.email).split("@")[0],
        email: String(e.email).toLowerCase(), password: e.password || "",
        role: role, dept: DEPT_FOR[role] || "Operations", active: true,
        joined: today, salary: 0, currency: "USD", raiseLogs: []
      });
    });
    localStorage.setItem("sap_" + wsId + "_users", JSON.stringify(users));

    if (window.Workspace) {
      Workspace.add({
        id: wsId,
        company: opts.company || "My Company",
        owner: ownerUser.name, email: ownerUser.email,
        industry: ind,
        country: opts.country || "TR",
        tagline: opts.tagline || (presets[ind] && presets[ind].tagline) || "",
        logo: opts.logo || null,
        sampleData: !!opts.sampleData,
        team: users.length,
        dbType: opts.dbType || "local",
        dbUri: opts.dbUri || "",
        createdAt: new Date().toISOString()
      });
      Workspace.setActive(wsId);
    }

    // Best-effort: also register this workspace's ownership in the platform's
    // master DB (if a backend is reachable) so storefront/portal edits can be
    // saved and verified server-side later. No-ops silently in pure demo mode.
    if (window.Store && Store.registerWorkspace) {
      Store.registerWorkspace({
        id: wsId, company: opts.company || "My Company", industry: ind,
        country: opts.country || "TR", ownerEmail: ownerUser.email,
        dbType: opts.dbType || "local", dbUri: opts.dbUri || "",
        logo: opts.logo || null, tagline: opts.tagline || ""
      });
    }

    const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, role: ownerUser.role, dept: ownerUser.dept };
    localStorage.setItem(KEY, JSON.stringify(session));
    Store.logAction("register", "workspace", ownerUser.id, (opts.company || "Workspace") + " created (" + ind + ")");
    return session;
  }
  function logout() {
    const u = current();
    if (u) Store.logAction("logout", "session", u.id, u.name + " signed out");
    localStorage.removeItem(KEY);
    if (window.Workspace) Workspace.clearActive();   // back to the company picker
  }
  function requireAuth() {
    if (!current()) {
      if (location.hash.startsWith("#/track")) return true;
      location.href = "login.html"; return false;
    }
    return true;
  }
  return { current, login, loginAny, register, logout, requireAuth, can, isOwner, ROLE_PERMS };
})();

/* ---------------- UI kit ---------------- */
window.UI = (function () {
  /* ---- SVG icons (Lucide-style, 24x24 stroke) ---- */
  const I = {
    grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>',
    truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    factory: '<path d="M2 20h20M4 20V9l5 4V9l5 4V9l5 4v7"/>',
    utensils: '<path d="M3 2v7a3 3 0 0 0 3 3 3 3 0 0 0 3-3V2M6 2v20M16 2c-1.5 0-3 1.5-3 4v6h3M16 2v20"/>',
    hammer: '<path d="M14 7l5 5M3 21l8.5-8.5M12.5 6.5l5 5 3-3a3.5 3.5 0 0 0-5-5l-3 3z"/><path d="M9 9l6 6"/>',
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2 13h20"/>',
    cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
    receipt: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2V2l-3 2-3-2-3 2-3-2-3 2z"/><path d="M8 8h8M8 12h8"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    dollar: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    package: '<path d="M16.5 9.4L7.5 4.2M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    building: '<path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-3"/><path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/>',
    star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
    sparkles: '<path d="M12 3l1.8 4.6L18.4 9.4 13.8 11.2 12 15.8 10.2 11.2 5.6 9.4 10.2 7.6z"/><path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/><path d="M5 15l.6 1.5L7 17l-1.4.5L5 19l-.6-1.5L3 17l1.4-.5z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
    route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h7a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h7"/>',
    key: '<circle cx="8" cy="15" r="5"/><path d="M11.5 11.5 21 2M16 7l3 3M19 4l3 3"/>',
    quote: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/>',
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
    pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    receive: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    trend: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
    handoff: '<path d="M5 12h14M13 6l6 6-6 6"/><circle cx="4" cy="12" r="1.4"/>',
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-4-1L3 20l1.1-3.3A8.4 8.4 0 1 1 21 11.5z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'
  };
  function icon(name, cls) {
    // width/height default keeps icons ~1em even if a CSS rule is missing/cached;
    // any explicit CSS (.btn svg, .ai-orb svg, …) still overrides these attributes.
    return '<svg class="' + (cls || "") + '" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (I[name] || "") + "</svg>";
  }

  /* ---- formatters ---- */
  const CUR = { USD: "$", EUR: "€", TRY: "₺", RUB: "₽" };
  // indicative FX → USD base, so multi-currency figures can be summed in Accounting
  const FX = { USD: 1, EUR: 1.08, TRY: 0.031, RUB: 0.011 };
  function toUSD(n, cur) { return Number(n || 0) * (FX[cur] || 1); }
  function usd(n, cur) { return money(toUSD(n, cur), "USD"); }
  function money(n, cur) {
    const sym = CUR[cur] || (cur ? cur + " " : "$");
    const lang = getLang();
    return sym + Number(n || 0).toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { maximumFractionDigits: 0 });
  }
  function num(n) {
    const lang = getLang();
    return Number(n || 0).toLocaleString(lang === "tr" ? "tr-TR" : "en-US");
  }
  function date(s) {
    if (!s) return "—";
    const lang = getLang();
    return new Date(s).toLocaleDateString(lang === "tr" ? "tr-TR" : "en-US", { day: "2-digit", month: "short", year: "numeric" });
  }
  function dateTime(s) {
    if (!s) return "—";
    const lang = getLang();
    return new Date(s).toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function rel(s) {
    const diff = (Date.now() - new Date(s).getTime()) / 1000;
    if (diff < 60) return t("just now");
    if (diff < 3600) return Math.floor(diff / 60) + " " + t("m ago");
    if (diff < 86400) return Math.floor(diff / 3600) + " " + t("h ago");
    if (diff < 604800) return Math.floor(diff / 86400) + " " + t("d ago");
    return date(s);
  }
  function initials(name) {
    return String(name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  }
  const FLAG = { TR: "🇹🇷", RU: "🇷🇺", AZ: "🇦🇿", IR: "🇮🇷", GE: "🇬🇪", DE: "🇩🇪", US: "🇺🇸" };
  function flag(cc) { return FLAG[cc] || "🏳️"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // deterministic avatar colour from a string
  function avColor(s) {
    const palette = ["#1d4d7a", "#1f74c4", "#1f9d6b", "#c89a3c", "#7a4fb0", "#2f6fb0", "#c0492f", "#163655"];
    let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  /* ---- toast ---- */
  function toast(msg, type) {
    let wrap = document.querySelector(".toasts");
    if (!wrap) { wrap = document.createElement("div"); wrap.className = "toasts"; document.body.appendChild(wrap); }
    const t = document.createElement("div");
    t.className = "toast " + (type || "ok");
    t.innerHTML = icon(type === "err" ? "alert" : "check") + "<span>" + esc(msg) + "</span>";
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateY(8px)"; setTimeout(() => t.remove(), 250); }, 2600);
  }

  /* ---- modal ---- */
  function modal({ title, body, footer, wide, onMount }) {
    closeModal();
    const ov = document.createElement("div"); ov.className = "overlay"; ov.id = "ui-overlay";
    const m = document.createElement("div"); m.className = "modal" + (wide ? " wide" : ""); m.id = "ui-modal";
    m.innerHTML =
      '<div class="modal-h"><h3>' + esc(title) + '</h3><button class="x" aria-label="Close">&times;</button></div>' +
      '<div class="modal-b">' + body + "</div>" +
      (footer ? '<div class="modal-f">' + footer + "</div>" : "");
    document.body.appendChild(ov); document.body.appendChild(m);
    requestAnimationFrame(() => { ov.classList.add("open"); m.classList.add("open"); });
    ov.addEventListener("click", closeModal);
    m.querySelector(".x").addEventListener("click", closeModal);
    if (onMount) onMount(m);
    return m;
  }
  function closeModal() {
    const ov = document.getElementById("ui-overlay"), m = document.getElementById("ui-modal");
    if (m) { m.classList.remove("open"); setTimeout(() => m.remove(), 240); }
    if (ov) { ov.classList.remove("open"); setTimeout(() => ov.remove(), 240); }
  }

  /* ---- drawer ---- */
  function drawer({ kicker, title, body, footer }) {
    closeDrawer();
    const ov = document.createElement("div"); ov.className = "overlay"; ov.id = "ui-dov";
    const d = document.createElement("aside"); d.className = "drawer"; d.id = "ui-drawer";
    d.innerHTML =
      '<div class="drawer-h"><div class="dk">' + esc(kicker || "") + '</div><h2>' + esc(title) + "</h2></div>" +
      '<div class="drawer-b">' + body + "</div>" +
      (footer ? '<div class="drawer-f">' + footer + "</div>" : "");
    document.body.appendChild(ov); document.body.appendChild(d);
    requestAnimationFrame(() => { ov.classList.add("open"); d.classList.add("open"); });
    ov.addEventListener("click", closeDrawer);
    return d;
  }
  function closeDrawer() {
    const ov = document.getElementById("ui-dov"), d = document.getElementById("ui-drawer");
    if (d) { d.classList.remove("open"); setTimeout(() => d.remove(), 300); }
    if (ov) { ov.classList.remove("open"); setTimeout(() => ov.remove(), 300); }
  }

  /* ---- confirm ---- */
  function confirm({ title, message, danger, okLabel }, onOk) {
    modal({
      title: title || t("Are you sure?"),
      body: '<p style="margin:0;color:var(--ink-2);line-height:1.6">' + esc(message) + "</p>",
      footer: '<button class="btn btn-ghost" data-c>' + t("Cancel") + '</button><button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" data-ok>' + esc(okLabel || t("Confirm")) + "</button>",
      onMount: (m) => {
        m.querySelector("[data-c]").addEventListener("click", closeModal);
        m.querySelector("[data-ok]").addEventListener("click", () => { closeModal(); onOk(); });
      }
    });
  }

  const LANG_KEY = "sap_lang";
  const TRANSLATIONS = {
    tr: {
      "Sign in — MERVEKS SAP": "Giriş Yap — MERVEKS SAP",
      "SAP Console": "SAP Konsolu",
      "Move trade<br>with total<br>confidence.": "Ticareti<br>tam güvenle<br>yönetin.",
      "Move trade<br />with total<br />confidence.": "Ticareti<br />tam güvenle<br />yönetin.",
      "Railway, food supply, Nano-Z Coating distribution and procurement — one console, full visibility and a complete history of every action. Built on a single motto: <b style=\"color:#fff\">trust</b>.": "Demiryolu, gıda tedariki, Nano-Z Kaplama dağıtımı ve satın alma — tek konsol, tam görünürlük ve her işlemin eksiksiz geçmişi. Tek bir motto üzerine kuruldu: <b style=\"color:#fff\">güven</b>.",
      "Established": "Kuruluş",
      "Hubs · TR": "Merkez · TR",
      "Per wagon": "Vagon Başına",
      "Service lines": "Hizmet Hattı",
      "Welcome back": "Tekrar hoş geldiniz",
      "Sign in to the MERVEKS operations console.": "MERVEKS operasyon konsoluna giriş yapın.",
      "Email": "E-posta",
      "Password": "Şifre",
      "Sign in to console": "Konsola giriş yap",
      "Owner": "Kurucu",
      "Employee": "Çalışan",
      "Also: ": "Ayrıca: ",
      "Invalid email or password. Try the demo credentials below.": "Geçersiz e-posta veya şifre. Aşağıdaki demo kimlik bilgilerini deneyin.",
      "Mersin": "Mersin",
      "Istanbul": "İstanbul",
      "Moscow": "Moskova",
      "Baku": "Bakü",
      "Tehran": "Tahran",
      "© 2013–2026 MERVEKS · Mersin & Istanbul, Türkiye": "© 2013–2026 MERVEKS · Mersin & İstanbul, Türkiye",
      "© 2013–2026 MERVEKS · Mersin & İstanbul, Türkiye": "© 2013–2026 MERVEKS · Mersin & İstanbul, Türkiye",
      "Main": "Ana Menü",
      "Operations": "Operasyonlar",
      "Network": "Bağlantılar",
      "System": "Sistem",
      "Dashboard": "Kontrol Paneli",
      "Operations overview": "Operasyonel genel bakış",
      /* ---- per-industry module labels (relabelled nav titles) ---- */
      "Deliveries": "Teslimatlar",
      "Fulfilment & carriers": "Sipariş karşılama ve kuryeler",
      "Outbound logistics": "Giden lojistik",
      "Customers": "Müşteriler",
      "Buyer accounts": "Alıcı hesapları",
      "Products": "Ürünler",
      "Catalogue & stock": "Katalog ve stok",
      "Vendors": "Satıcılar",
      "Supply partners": "Tedarik ortakları",
      "Replenishment partners": "İkmal ortakları",
      "Buyers": "Alıcılar",
      "Trade accounts": "Ticari hesaplar",
      "Sales": "Satışlar",
      "Counter & online sales": "Tezgah ve çevrimiçi satış",
      "Stock": "Stok",
      "Shelf & back-store stock": "Raf ve depo stoğu",
      "Store orders": "Mağaza siparişleri",
      "Restock Orders": "İkmal Siparişleri",
      "Inbound purchasing": "Gelen satın alma",
      "Revenue & Invoices": "Gelir ve Faturalar",
      "Receivables": "Alacaklar",
      "Price Offers": "Fiyat Teklifleri",
      "Trade quotations": "Ticari teklifler",
      "Stock Orders": "Stok Siparişleri",
      "Replenishment": "İkmal",
      /* ---- shipment modes & parcel units ---- */
      "Courier": "Kurye",
      "Parcel": "Koli",
      "Express": "Ekspres",
      "Pickup": "Teslim Alma",
      "Local Delivery": "Yerel Teslimat",
      "Rail": "Demiryolu",
      "parcel": "koli",
      "parcels": "koli",
      /* ---- dashboard hero scene labels ---- */
      "Delivered": "Teslim Edildi",
      "Central DC": "Merkez Depo",
      "LIVE SALES": "CANLI SATIŞ",
      "Raw": "Ham",
      "Press": "Pres",
      "Finished": "Bitmiş",
      "Kitchen": "Mutfak",
      "On site": "Sahada",
      "Proposal": "Teklif",
      "Billed": "Faturalandı",
      /* ---- manufacturing / restaurant / construction / services labels ---- */
      "Production Orders": "Üretim Emirleri",
      "Work orders & runs": "İş emirleri ve üretim",
      "Industrial buyers": "Endüstriyel alıcılar",
      "Materials & Goods": "Malzeme ve Ürünler",
      "Raw materials & finished stock": "Hammadde ve bitmiş stok",
      "Dispatch": "Sevkiyat",
      "Outbound freight": "Giden navlun",
      "Raw-material partners": "Hammadde ortakları",
      "Material Orders": "Malzeme Siparişleri",
      "Raw-material procurement": "Hammadde tedariki",
      "Guests": "Misafirler",
      "Guests & catering clients": "Misafirler ve catering",
      "Menu & Stock": "Menü ve Stok",
      "Ingredients & menu items": "Malzemeler ve menü",
      "Produce & beverage partners": "Gıda ve içecek ortakları",
      "Supply Orders": "Tedarik Siparişleri",
      "Kitchen procurement": "Mutfak tedariki",
      "Table & online orders": "Masa ve online siparişler",
      "Tenders": "İhaleler",
      "Bids & estimates": "Teklifler ve tahminler",
      "Projects": "Projeler",
      "Active projects": "Aktif projeler",
      "Developers & owners": "Geliştiriciler ve sahipler",
      "Materials": "Malzemeler",
      "Site materials & equipment": "Şantiye malzeme ve ekipman",
      "Site Deliveries": "Şantiye Teslimatları",
      "Material logistics": "Malzeme lojistiği",
      "Material & equipment partners": "Malzeme ve ekipman ortakları",
      "Site procurement": "Şantiye tedariki",
      "Proposals": "Teklifler",
      "Scopes & estimates": "Kapsam ve tahminler",
      "Engagements": "Projeler",
      "Client accounts": "Müşteri hesapları",
      "Billing & Invoices": "Faturalama",
      /* ---- new ship modes ---- */
      "Heavy Haul": "Ağır Taşıma",
      "Crane Lift": "Vinç Kaldırma",
      "Remote": "Uzaktan",
      "On-site": "Yerinde",
      "Shipments": "Sevkiyatlar",
      "Logistics & freight": "Lojistik ve navlun",
      "Inventory": "Envanter",
      "Products & stock": "Ürünler ve stok",
      "Orders": "Siparişler",
      "Purchase orders": "Satın alma siparişleri",
      "Clients": "Müşteriler",
      "Customer accounts": "Müşteri hesapları",
      "Suppliers": "Tedarikçiler",
      "Procurement partners": "Tedarik ortakları",
      "Finance & Invoices": "Finans ve Faturalar",
      "Finance": "Finans",
      "Invoices & receivables": "Faturalar ve alacaklar",
      "Activity History": "İşlem Geçmişi",
      "Audit trail": "Denetim günlüğü",
      "Team & Accounts": "Ekip ve Yetkiler",
      "Owner & employee access": "Kurucu ve çalışan erişimi",
      "Settings": "Ayarlar",
      "System & connection": "Sistem ve bağlantı",
      "Visit merveks.com": "merveks.com'u Ziyaret Et",
      "Live data": "Canlı Veri",
      "Demo data": "Demo Veri",
      "Sign out": "Çıkış yap",
      "Loading…": "Yükleniyor…",
      "Take a tour": "Tanıtım turu",
      "Notifications": "Bildirimler",
      "Mark all read": "Tümünü okundu işaretle",
      "You're all caught up.": "Her şey güncel.",
      "Open My Work": "İşlerim'i aç",
      "My Work": "İşlerim",
      "Your tasks & handoffs": "Görevlerin ve devirler",
      "Good morning": "Günaydın",
      "Good afternoon": "İyi günler",
      "Good evening": "İyi akşamlar",
      "Here is what needs you today.": "Bugün seni bekleyenler.",
      "Overdue / urgent": "Gecikmiş / acil",
      "Waiting on you": "Seni bekleyen",
      "Heads-up": "Bilgilendirme",
      "Nothing urgent — you're on top of it.": "Acil bir şey yok — her şey kontrol altında.",
      "No open handoffs. Nice and clear.": "Bekleyen devir yok. Tertemiz.",
      "No new updates.": "Yeni güncelleme yok.",
      "Open": "Aç", "Reply": "Yanıtla", "View": "Görüntüle", "Chase": "Takip et", "Resolve": "Çöz", "Reorder": "Sipariş ver",
      "Assigned to you": "Sana atandı",
      "low stock": "düşük stok", "in stock": "stokta", "reorder at": "yeniden sipariş eşiği", "chase the client": "müşteriyi ara",
      "book shipment": "sevkiyat oluştur",
      "Shipment": "Sevkiyat", "Order": "Sipariş", "Invoice": "Fatura", "Quote": "Teklif",
      "delivered": "teslim edildi", "issue the invoice.": "faturayı oluştur.",
      "Ready to invoice": "Faturaya hazır", "New order to book": "Oluşturulacak yeni sipariş", "Invoice to collect": "Tahsil edilecek fatura",
      "New supplier bill": "Yeni tedarikçi faturası", "Invoice paid": "Fatura ödendi", "fully paid": "tamamen ödendi",
      "handed to": "şuna devredildi", "create the shipment.": "sevkiyatı oluştur.",
      "send it and follow up payment.": "gönder ve ödemeyi takip et.", "schedule payment.": "ödemeyi planla.",
      "MENU": "MENÜ",
      "Owner": "Kurucu",
      "Operations Manager": "Operasyon Müdürü",
      "Finance Officer": "Finans Yetkilisi",
      "Trade Specialist": "Ticaret Uzmanı",
      "Search…": "Ara…",
      "New shipment": "Yeni sevkiyat",
      "New product": "Yeni ürün",
      "New client": "Yeni müşteri",
      "New supplier": "Yeni tedarikçi",
      "New order": "Yeni sipariş",
      "New invoice": "Yeni fatura",
      "New employee": "Yeni çalışan",
      "Nothing here yet": "Henüz burada bir şey yok",
      "No records match your filter.": "Filtrenizle eşleşen kayıt bulunamadı.",
      "active shipments": "aktif sevkiyat",
      "open orders": "açık sipariş",
      "receivable": "alacak",
      "We move trade with one motto — <b>trust</b>.": "Ticareti tek bir motto ile yönetiyoruz — <b>güven</b>.",
      "Active shipments": "Aktif sevkiyatlar",
      "on rail": "demiryolunda",
      "Open orders": "Açık siparişler",
      "total": "toplam",
      "Inventory value (est.)": "Tahmini envanter değeri",
      "low": "kritik",
      "Outstanding receivables": "Bekleyen alacaklar",
      "overdue": "vadesi geçmiş",
      "Revenue trend": "Gelir trendi",
      "Last 8 weeks · k USD": "Son 8 hafta · bin USD",
      "Shipments in transit": "Transit halindeki sevkiyatlar",
      "View all": "Tümünü gör",
      "Reference": "Referans",
      "Client": "Müşteri",
      "Route": "Rota",
      "Status": "Durum",
      "ETA": "Tahmini Varış",
      "No active shipments.": "Aktif sevkiyat bulunmamaktadır.",
      "Service mix": "Hizmet dağılımı",
      "By transport mode": "Taşıma moduna göre",
      "shipments": "sevkiyat",
      "Low-stock alerts": "Kritik stok uyarıları",
      "items": "ürün",
      "All products above reorder level. ✓": "Tüm ürünler kritik stok seviyesinin üzerinde. ✓",
      "Recent activity": "Son işlemler",
      "History": "Geçmiş",
      "Logistics & Shipments": "Lojistik ve Sevkiyatlar",
      "Railway container, road and sea freight · up to 28 t per booking": "Demiryolu konteyner, karayolu ve denizyolu navlun · rezervasyon başına 28 tona kadar",
      "No shipments in this status.": "Bu durumda sevkiyat bulunmamaktadır.",
      "Mode": "Taşıma Türü",
      "Load": "Yük",
      "ctr": "konteyner",
      "Post tracking update": "Takip Güncellemesi Ekle",
      "Location": "Konum",
      "e.g. Tbilisi, GE": "Örn. Tiflis, GE",
      "Note": "Not",
      "What happened?": "Ne oldu?",
      "Post update": "Güncellemeyi Kaydet",
      "Read-only — your role can't post tracking updates.": "Salt Okunur — rolünüz takip güncellemesi ekleyemez.",
      "Origin": "Çıkış",
      "Destination": "Varış",
      "Containers": "Konteyner Sayısı",
      "Weight": "Ağırlık",
      "tonnes": "ton",
      "Departed": "Çıkış Tarihi",
      "Documents": "Belgeler",
      "Tracking history": "Takip Geçmişi",
      "No tracking events yet.": "Henüz takip güncellemesi girilmemiş.",
      "Close": "Kapat",
      "Edit shipment": "Sevkiyatı düzenle",
      "Edit shipment form title": "Sevkiyatı Düzenle",
      "New shipment form title": "Yeni Sevkiyat",
      "Weight (t)": "Ağırlık (ton)",
      "Departed date": "Çıkış Tarihi",
      "ETA date": "Tahmini Varış",
      "Cancel": "İptal",
      "Save changes": "Değişiklikleri kaydet",
      "Create shipment": "Sevkiyat oluştur",
      "Delete shipment?": "Sevkiyatı sil?",
      "Delete": "Sil",
      "Inventory & Products": "Envanter ve Ürünler",
      "Nano-Z Coating distribution &amp; food supply stock across warehouses": "Depolardaki Nano-Z Kaplama dağıtımı ve gıda tedariki stoğu",
      "Product": "Ürün",
      "Warehouse": "Depo",
      "Stock level": "Stok Seviyesi",
      "Unit price": "Birim Fiyatı",
      "No products in this category.": "Bu kategoride ürün bulunmamaktadır.",
      "Edit product": "Ürünü Düzenle",
      "Product name": "Ürün Adı",
      "Stock on hand": "Mevcut Stok",
      "Reorder level": "Kritik Stok Seviyesi",
      "Unit": "Birim",
      "Currency": "Para Birimi",
      "Add product": "Ürün ekle",
      "Delete product?": "Ürünü sil?",
      "Multinational accounts served by MERVEKS supply-chain operations": "MERVEKS tedarik zinciri operasyonları tarafından sunulan uluslararası hesaplar",
      "Country": "Ülke",
      "Sector": "Sektör",
      "Primary contact": "Birincil İletişim",
      "Rating": "Değerlendirme",
      "No clients yet.": "Henüz müşteri bulunmuyor.",
      "Edit client": "Müşteriyi Düzenle",
      "Company name": "Firma Adı",
      "Contact person": "Yetkili Kişi",
      "Phone": "Telefon",
      "Rating (1-5)": "Değerlendirme (1-5)",
      "Create client": "Müşteri oluştur",
      "Delete client?": "Müşteriyi sil?",
      "Suppliers": "Tedarikçiler",
      "Procurement &amp; sourcing partners for distribution and technical consulting": "Dağıtım ve teknik danışmanlık için satın alma ve tedarik ortakları",
      "Contact": "Yetkili",
      "No suppliers yet.": "Henüz tedarikçi bulunmuyor.",
      "Edit supplier": "Tedarikçiyi Düzenle",
      "Supplier name": "Tedarikçi Adı",
      "Create supplier": "Tedarikçi oluştur",
      "Delete supplier?": "Tedarikçiyi sil?",
      "Orders": "Siparişler",
      "Purchase orders across distribution &amp; supply lines": "Dağıtım ve tedarik hatlarındaki satın alma siparişleri",
      "Order ref": "Sipariş Ref",
      "Items": "Kalemler",
      "No orders in this status.": "Bu durumda sipariş bulunmamaktadır.",
      "Order": "Sipariş",
      "Line items": "Sipariş kalemleri",
      "Qty": "Adet",
      "Price": "Fiyat",
      "Sub": "Ara Toplam",
      "Advance status": "Durumu ilerlet",
      "Create order": "Sipariş oluştur",
      "Delete order?": "Siparişi sil?",
      "Finance & Invoices": "Finans ve Faturalar",
      "Receivables across all service lines": "Tüm hizmet hatlarındaki alacaklar",
      "Collected (paid)": "Tahsil Edilen (Ödenmiş)",
      "Outstanding": "Bekleyen Alacaklar",
      "Overdue": "Vadesi Geçmiş",
      "Invoice": "Fatura No",
      "Issued": "Kesim Tarihi",
      "Due": "Vade Tarihi",
      "Amount": "Tutar",
      "No invoices in this status.": "Bu durumda fatura bulunmamaktadır.",
      "AI Accountant": "YZ Muhasebeci",
      "Receivables analysis": "Alacak Analizi",
      "Powered by Google Gemini (": "Google Gemini ile desteklenmektedir (",
      "Offline analysis engine · add a Gemini key in Settings for live AI": "Çevrimdışı analiz motoru · aktif yapay zeka için Ayarlar kısmına Gemini anahtarı ekleyin",
      "Re-run": "Yeniden Çalıştır",
      "Assessing invoice…": "Fatura değerlendiriliyor…",
      "Edit invoice": "Faturayı Düzenle",
      "Invoice no.": "Fatura No",
      "Create invoice": "Fatura oluştur",
      "Delete invoice?": "Faturayı sil?",
      "Activity History": "İşlem Geçmişi",
      "Audit trail of all console creations, edits and deletions": "Tüm konsol ekleme, düzenleme ve silme işlemlerinin denetim kaydı",
      "Action": "Eylem",
      "Actor": "Yapan",
      "Target": "Hedef",
      "Summary": "Özet",
      "Time": "Zaman",
      "No audit records found.": "Denetim kaydı bulunamadı.",
      "Owner and employee accounts · roles control what each person can access": "Kurucu ve çalışan hesapları · roller kimlerin erişimi olacağını kontrol eder",
      "Member": "Üye",
      "Department": "Departman",
      "Joined": "Katılım Tarihi",
      "Active": "Aktif",
      "Disabled": "Pasif",
      "Edit employee": "Çalışanı Düzenle",
      "Full name": "Adı Soyadı",
      "Role": "Rol",
      "Department form label": "Departman",
      "Active status": "Aktif Hesap",
      "Create employee": "Çalışan oluştur",
      "Delete employee?": "Çalışanı sil?",
      "Connection, AI, team access &amp; data controls": "Bağlantı, YZ, ekip erişimi ve veri kontrolleri",
      "Backend connection": "Sunucu bağlantısı",
      "Enter REST API root URL to switch to live database. Leave blank to run offline on local demo data.": "Canlı veritabanına geçmek için REST API kök URL'sini girin. Çevrimdışı demo verilerinde çalışmak için boş bırakın.",
      "Connection base URL": "Bağlantı kök URL'si",
      "e.g. https://api.merveks.com/sap": "Örn. https://api.merveks.com/sap",
      "Save settings": "Ayarları kaydet",
      "Disconnect (demo mode)": "Bağlantıyı kes (demo modu)",
      "AI Accounting (Gemini)": "YZ Muhasebe (Gemini)",
      "Add a Google Gemini API key to enable live invoice analysis and collection reports.": "Canlı fatura analizi ve tahsilat raporlarını etkinleştirmek için Google Gemini API anahtarı ekleyin.",
      "Gemini API key": "Gemini API anahtarı",
      "Save API key": "API anahtarını kaydet",
      "Use offline engine": "Çevrimdışı motoru kullan",
      "Team & access": "Ekip ve yetkiler",
      "Your role": "Rolünüz",
      "As Owner you have full access and can manage employee accounts and permissions in the Team module.": "Kurucu olarak tam erişime sahipsiniz; çalışan hesaplarını ve yetkilerini Ekip modülünden yönetebilirsiniz.",
      "Your access is scoped to your role. Contact the Owner to change permissions.": "Erişiminiz rolünüzle sınırlıdır. Yetkileri değiştirmek için Kurucu ile iletişime geçin.",
      "Company & data": "Şirket ve veriler",
      "Company": "Şirket",
      "MERVEKS — Logistics & Trade": "MERVEKS — Lojistik ve Ticaret",
      "Marketing site": "Pazarlama sitesi",
      "Established info": "Kuruluş: 2013 · Mersin & İstanbul, Türkiye",
      "Reset restores the original demo dataset and clears any local changes (demo mode only).": "Sıfırlama, orijinal demo veri kümesini geri yükler ve tüm yerel değişiklikleri temizler (yalnızca demo modu).",
      "Reset demo data": "Demo verilerini sıfırla",
      "Reset demo data?": "Demo verilerini sıfırla?",
      "All local changes will be discarded and the original MERVEKS demo dataset restored.": "Tüm yerel değişiklikler atılacak ve orijinal MERVEKS demo veri kümesi geri yüklenecektir.",
      "Reset": "Sıfırla",
      "Manage team": "Ekibi Yönet",
      "Select language": "Dil seçin",
      "Language": "Dil",

      // Dialog / Confirm
      "Emin misiniz?": "Emin misiniz?",
      "İptal": "İptal",
      "Onayla": "Onayla",
      "Are you sure?": "Emin misiniz?",
      "Cancel": "İptal",
      "Confirm": "Onayla",
      "Good morning": "Günaydın",
      "Good afternoon": "Tünaydın",
      "Good evening": "İyi akşamlar",
      "just now": "az önce",
      "m ago": "dk önce",
      "h ago": "sa önce",
      "d ago": "gün önce",
      "Inventory description": "Depolardaki Nano-Z Kaplama dağıtımı ve gıda tedariki stoğu",
      "Clients description": "MERVEKS tedarik zinciri operasyonları tarafından sunulan uluslararası hesaplar",
      "Suppliers description": "Dağıtım ve teknik danışmanlık için satın alma ve tedarik ortakları",
      "Since": "Başlangıç",
      "now": "şimdi",
      "Receivables analysis": "Alacak analizi",
      "Powered by Google Gemini": "Google Gemini ile güçlendirildi",
      "Offline analysis engine · add a Gemini key in Settings for live AI": "Çevrimdışı analiz motoru · canlı yapay zeka için Ayarlar'dan Gemini anahtarı ekleyin",
      "Billed": "Faturalanan",
      "Collected": "Tahsil edilen",
      "Analysing": "Analiz ediliyor",
      "invoices…": "fatura…",
      "Thinking…": "Düşünülüyor…",
      "Offline": "Çevrimdışı",
      "Gemini unavailable": "Gemini kullanılamıyor",
      "showing offline analysis": "çevrimdışı analiz gösteriliyor",
      "Shipment QR Code": "Sevkiyat QR Kodu",
      "Download": "İndir",
      "Print": "Yazdır",
      "Scan QR Code": "QR Kodu Tara",
      "Position the cargo barcode / QR code inside the camera view.": "Kargo barkodunu / QR kodunu kamera kadrajına ortalayın.",
      "Starting camera…": "Kamera başlatılıyor…",
      "QR Code scanned successfully": "QR Kod başarıyla tarandı",
      "Invalid shipment QR Code link": "Geçersiz sevkiyat QR Kodu bağlantısı",
      "Camera access denied or unavailable.": "Kamera erişimi reddedildi veya kullanılamıyor.",
      "Public Tracking Portal": "Kamuya Açık Takip Portalı",
      "Console Sign In": "Konsol Girişi",
      "Shipment Reference": "Sevkiyat Referansı",
      "Transport Mode": "Taşıma Türü",
      "Cargo Load": "Kargo Yükü",
      "Real-Time Tracking Status": "Gerçek Zamanlı Takip Durumu",
      "Shipment Not Found": "Sevkiyat Bulunamadı",
      "The shipment reference or ID is invalid or has been removed.": "Sevkiyat referansı veya ID geçersiz ya da silinmiş.",
      "Go to Console": "Konsola Git",
      "Open public tracking page": "Kamuya açık takip sayfasını aç",
      "Top Performers Leaderboard": "En Aktif Çalışanlar",
      "Team Contributions Today": "Bugünkü Ekip Katkıları",
      "No activity today": "Bugün henüz işlem yapılmadı",
      "actions": "işlem",
      "hrs": "sa",
      "Sales": "Satış",
      "Procurement": "Satın Alma",
      "Quotations": "Teklifler",
      "Purchasing": "Satın Alma",
      "Accounting": "Muhasebe",
      "AR · AP · cash · P&L": "Alacaklar · Borçlar · Nakit · K/Z",
      "Price offers": "Fiyat Teklifleri",
      "My Profile": "Profilim",
      "Download Client Guide (PDF)": "Müşteri Kılavuzunu İndir (PDF)",
      "Client Guide (EN)": "Müşteri Kılavuzu (EN)",
      "Client Guide (TR)": "Müşteri Kılavuzu (TR)",
      "Track Your Shipment": "Sevkiyatınızı Takip Edin",
      "Enter your shipment reference number below to track in real-time.": "Gerçek zamanlı takip için sevkiyat referans numarasını girin.",
      "e.g. SH-2026-001": "Örn. SH-2026-001",
      "Track": "Takip Et",
      "Please enter a shipment reference.": "Lütfen bir sevkiyat referansı girin.",
      "VAT (KDV) Rate": "KDV Oranı",
      "VAT (KDV) Amount": "KDV Tutarı",
      "Subtotal (Matrah)": "Matrah (KDV Hariç)",
      "Grand Total": "KDV Dahil Toplam",
      "VAT Summary": "KDV Özeti",
      "Calculated VAT (Sales)": "Hesaplanan KDV (Satış)",
      "Deductible VAT (Purchases)": "İndirilecek KDV (Alış)",
      "Net VAT Payable": "Ödenecek KDV",
      "Net VAT Receivable": "Devreden KDV",
      "Personal account summary, performance scores, and logs": "Kişisel hesap özeti, performans skorları ve kayıtları",
      "Performance Metrics": "Performans Metrikleri",
      "Compensation & Raises": "Maaş & Zamlar",
      "My Recent Activity": "Son İşlemlerim",
      "No activity logged yet.": "Henüz kaydedilmiş işlem yok.",
      "month": "ay",
      "Joined": "Katılım",
      "General": "Genel",
      "Company Financial Statement": "Şirket Finansal Raporu",
      "Export PDF": "PDF Dışa Aktar",
      "Export Excel": "Excel Dışa Aktar",
      "Confidential financial report generated for authorized console users only.": "Yalnızca yetkili konsol kullanıcıları için oluşturulmuş gizli finansal rapor.",
      "COMPANY FINANCIAL STATEMENT": "ŞİRKET FİNANSAL RAPORU",
      "EXECUTIVE SUMMARY": "YÖNETİCİ ÖZETİ",
      "Metric": "Metrik",
      "Value (USD)": "Değer (USD)",
      "Details": "Detaylar",
      "PROFIT & LOSS (INDICATIVE)": "KÂR & ZARAR (GÖSTERGE)",
      "Amount (USD)": "Tutar (USD)",
      "RECEIVABLES AGING": "ALACAK YAŞLANDIRMA",
      "PAYMENTS LEDGER": "ÖDEMELER DEFTERİ",
      "Amount (USD Equivalent)": "Tutar (USD Karşılığı)",
      "Sales orders": "Satış Siparişleri",
      "Procurement & bills": "Satın Alma ve Faturalar",
      "Performance": "Performans",
      "Salary": "Maaş",
      "Raise Recommendation": "Maaş Artış Önerisi",
      "Consistency": "İstikrar",
      "Revenue Impact": "Gelir Etkisi",
      "Suggested Raise": "Önerilen Artış",
      "Log Raise": "Maaş Artışı Kaydet",
      "active days": "aktif gün",
      "AI Raise Recommendation": "YZ Maaş Artışı Önerisi",
      "Performance Improvement Plan": "Performans Geliştirme Planı",
      "Team rank": "Ekip sıralaması",
      "Quality (role-fit)": "Kalite (rol uyumu)",
      "Revenue impact": "Gelir etkisi",
      "Consistency (30 days)": "İstikrar (30 gün)",
      "Seniority": "Kıdem",
      "Active days (30d)": "Aktif gün (30g)",
      "Actions (30d)": "İşlem (30g)",
      "All-time actions": "Tüm zamanlar işlem",
      "Improving": "İyileşiyor",
      "Declining": "Düşüşte",
      "Stable": "Dengeli",
      "No performance data yet.": "Henüz performans verisi yok.",
      "Current salary": "Mevcut maaş",
      "Log a raise": "Maaş artışı kaydet",
      "Raise %": "Maaş artışı %",
      "e.g. Annual review": "Örn. Yıllık değerlendirme",
      "Raise history": "Maaş artış geçmişi",
      "Date": "Tarih",
      "Raise": "Maaş Artışı",
      "No raise history yet": "Henüz maaş artış geçmişi yok",
      "Profile": "Profil",
      "Salary & Raise": "Maaş & Artış",
      "Name, email and password are required": "Ad, e-posta ve şifre zorunludur",
      "Raise logged": "Maaş artışı kaydedildi",
      "Account updated": "Hesap güncellendi",
      "Account created": "Hesap oluşturuldu",
      "will lose access immediately.": "erişimi hemen kaybedecek.",
      "Delete": "Sil",
      "Are you sure?": "Emin misiniz?",
      "Confirm": "Onayla",
      "You can't delete your own account": "Kendi hesabınızı silemezsiniz",
      "Voice replies on": "Sesli yanıtlar açık",
      "Voice replies off": "Sesli yanıtlar kapalı",
      "Voice input is not supported in this browser": "Bu tarayıcıda sesli giriş desteklenmiyor",
      "Ask anything": "Bir şey sorun",
      "Speak": "Konuş",
      "Read replies aloud": "Yanıtları sesli oku",
      "Send": "Gönder",
      "Reconnecting…": "Yeniden bağlanılıyor…",
      "Accept & create order": "Kabul et ve sipariş oluştur",
      "Add at least one item": "En az bir kalem ekleyin",
      "Add item": "Kalem ekle",
      "Bill": "Fatura",
      "Bill / warehouse": "Fatura / depo",
      "Cash in": "Kasa girişi",
      "Cash out": "Kasa çıkışı",
      "Category": "Kategori",
      "Client added: ": "Müşteri eklendi: ",
      "Client created": "Müşteri oluşturuldu",
      "Client deleted": "Müşteri silindi",
      "Client deleted: ": "Müşteri silindi: ",
      "Client updated": "Müşteri güncellendi",
      "Client updated: ": "Müşteri güncellendi: ",
      "Company name is required": "Şirket adı zorunludur",
      "Connection, AI, team access & data controls": "Bağlantı, YZ, ekip erişimi ve veri kontrolleri",
      "Converted to order": "Siparişe dönüştürüldü",
      "Cost": "Maliyet",
      "Costs & margin": "Maliyetler ve kâr marjı",
      "Create purchase order": "Satın alma siparişi oluştur",
      "Create quote": "Teklif oluştur",
      "Delete?": "Sil?",
      "Deleted": "Silindi",
      "Demo data restored": "Demo verileri geri yüklendi",
      "Demo mode": "Demo modu",
      "Direction": "Yön",
      "Edit purchase order": "Satın alma siparişini düzenle",
      "Edit quote": "Teklifi düzenle",
      "Enter an amount": "Bir tutar girin",
      "Freight": "Navlun",
      "Gemini key saved": "Gemini anahtarı kaydedildi",
      "Generate invoice": "Fatura oluştur",
      "Goods received & bill created": "Mallar teslim alındı ve fatura oluşturuldu",
      "Gross profit": "Brüt kâr",
      "Gross profit (est.)": "Brüt kâr (tahmini)",
      "Insurance": "Sigorta",
      "Invoice created": "Fatura oluşturuldu",
      "Invoice deleted": "Fatura silindi",
      "Invoice generated": "Fatura üretildi",
      "Invoice no. and amount are required": "Fatura no ve tutar zorunludur",
      "Invoice updated": "Fatura güncellendi",
      "Item": "Kalem",
      "Key cleared": "Anahtar temizlendi",
      "Linked records": "Bağlantılı kayıtlar",
      "Logistics costs": "Lojistik maliyetleri",
      "Margin": "Marj",
      "Method": "Yöntem",
      "Net cash flow": "Net nakit akışı",
      "New purchase order": "Yeni satın alma siparişi",
      "New quote": "Yeni teklif",
      "New shipment (": "Yeni sevkiyat (",
      "No activity": "İşlem yok",
      "Notes": "Notlar",
      "Offline engine": "Çevrimdışı motor",
      "Order created": "Sipariş oluşturuldu",
      "Order created from quote": "Tekliften sipariş oluşturuldu",
      "Order deleted": "Sipariş silindi",
      "Order revenue": "Sipariş geliri",
      "Owner has full control. Operations manages logistics, inventory & orders. Finance manages invoices & AI accounting. Trade manages clients, suppliers, inventory & orders. Employees cannot delete records or manage the team.": "Kurucu tam yetkiye sahiptir. Operasyon; lojistik, envanter ve siparişleri yönetir. Finans; faturaları ve yapay zeka muhasebesini yönetir. Ticaret; müşterileri, tedarikçileri, envanteri ve siparişleri yönetir. Çalışanlar kayıt silemez veya ekibi yönetemez.",
      "PO ref": "SAS Ref",
      "Party": "Taraf",
      "Payables (AP)": "Borçlar (AP)",
      "Payment recorded": "Ödeme kaydedildi",
      "Payments ledger": "Ödemeler defteri",
      "Please enter a location for the update": "Lütfen güncelleme için bir konum girin",
      "Price offers — the start of the sales chain": "Fiyat teklifleri — satış zincirinin başlangıcı",
      "Procurement from suppliers → receive goods → payables": "Tedarikçilerden satın alma → malları teslim alma → borçlar",
      "Product added": "Ürün eklendi",
      "Product added: ": "Ürün eklendi: ",
      "Product deleted": "Ürün silindi",
      "Product deleted: ": "Ürün silindi: ",
      "Product updated": "Ürün güncellendi",
      "Product updated: ": "Ürün güncellendi: ",
      "Profit & loss (indicative)": "Kâr ve zarar (tahmini)",
      "Purchase Orders": "Satın Alma Siparişleri",
      "Purchase order": "Satın alma siparişi",
      "Purchase order created": "Satın alma siparişi oluşturuldu",
      "Purchase orders across distribution & supply lines": "Dağıtım ve tedarik hatlarındaki satın alma siparişleri",
      "Purchases (supplier bills)": "Satın almalar (tedarikçi faturaları)",
      "Quality (role-fit)": "Kalite (rol uyumu)",
      "Quotation": "Teklif",
      "Quote created": "Teklif oluşturuldu",
      "Quote updated": "Teklif güncellendi",
      "Raise range shown": "Maaş artış aralığı gösteriliyor",
      "Receivables (AR)": "Alacaklar (AR)",
      "Receivables aging": "Alacak yaşlandırma",
      "Receivables, payables, cash & profit — indicative USD": "Alacaklar, borçlar, nakit ve kâr — gösterge niteliğinde USD",
      "Receive & create bill": "Teslim al ve fatura oluştur",
      "Reference and destination are required": "Referans ve varış noktası zorunludur",
      "Revenue (invoiced)": "Gelir (faturalandırılmış)",
      "Saved": "Kaydedildi",
      "Supplier bill": "Tedarikçi faturası",
      "Supplier created": "Tedarikçi oluşturuldu",
      "Supplier deleted": "Tedarikçi silindi",
      "Supplier deleted: ": "Tedarikçi silindi: ",
      "Supplier name is required": "Tedarikçi adı zorunludur",
      "Supplier updated": "Tedarikçi güncellendi",
      "Supplier updated: ": "Tedarikçi güncellendi: ",
      "Switched to demo mode": "Demo moduna geçildi",
      "The role determines which modules and actions this account can use.": "Rol, bu hesabın hangi modülleri ve eylemleri kullanabileceğini belirler.",
      "This shipment will be permanently removed.": "Bu sevkiyat kalıcı olarak kaldırılacaktır.",
      "Total cost": "Toplam maliyet",
      "Update added · ": "Güncelleme eklendi · ",
      "Using offline engine": "Çevrimdışı motor kullanılıyor",
      "Valid until": "Geçerlilik tarihi",
      "days": "gün",
      "entries": "girdi",
      "not yet": "henüz değil",
      "open": "açık",
      "paid": "ödendi",
      "will be removed from inventory.": "envanterden kaldırılacaktır.",
      "will be removed.": "kaldırılacaktır.",
      "will lose access immediately.": "erişimi hemen kaybedecektir.",
      "Exceptional": "Olağanüstü",
      "Strong": "Güçlü",
      "Good": "İyi",
      "Average": "Ortalama",
      "Needs Review": "Değerlendirilmesi Gerekiyor",
      "Performance Improvement Plan": "Performans Geliştirme Planı",
      "Are you sure?": "Emin misiniz?",
      "Confirm": "Onayla",
      "Cancel": "İptal",
      "Mersin & Istanbul, Türkiye": "Mersin & İstanbul, Türkiye",
      "Account deleted": "Hesap silindi",
      "Quote": "Teklif",
      "Record payment": "Ödeme Kaydet",
      "Shipment": "Sevkiyat",
      "Shipment created": "Sevkiyat oluşturuldu",
      "Shipment deleted": "Sevkiyat silindi",
      "Shipment updated": "Sevkiyat güncellendi",
      "Shipment updated: ": "Sevkiyat güncellendi: ",
      "Supplier": "Tedarikçi",
      "Supplier Bills": "Tedarikçi Faturaları",
      "Supplier added: ": "Tedarikçi eklendi: ",
      "Total": "Toplam",
      "Trend": "Trend"
    }
  };

  function getLang() { return localStorage.getItem(LANG_KEY) || "tr"; }
  function setLang(lang) { localStorage.setItem(LANG_KEY, lang); }
  function t(key) {
    const lang = getLang();
    if (lang === "en") return key;
    return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || key;
  }
  window.t = t;

  function translatePage() {
    document.querySelectorAll("[data-t]").forEach((el) => {
      const key = el.dataset.t;
      if (el.tagName === "INPUT" && (el.type === "text" || el.type === "email" || el.type === "password" || el.type === "search")) {
        el.placeholder = t(key);
      } else {
        el.innerHTML = t(key);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    translatePage();
    const ls = document.getElementById("langSelect");
    if (ls) {
      ls.value = getLang();
      ls.addEventListener("change", (e) => {
        setLang(e.target.value);
        location.reload();
      });
    }
  });

  return { icon, money, usd, toUSD, num, date, dateTime, rel, initials, flag, esc, avColor, toast, modal, closeModal, drawer, closeDrawer, confirm, getLang, setLang, t, translatePage };
})();
