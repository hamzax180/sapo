/* =================================================================
   MERVEKS SAP — data store
   Single data layer the whole app talks to. Transparently switches
   between LIVE (REST backend) and DEMO (localStorage) so views never
   care which mode is active. Every mutation is recorded to the audit
   trail that powers the History module.
   ================================================================= */
window.Store = (function () {
  const cfg = window.SAP_CONFIG || {};
  const COLLECTIONS = ["users", "clients", "suppliers", "products", "quotes", "orders", "shipments", "invoices", "purchaseorders", "bills", "payments", "payruns", "attendance", "notifications", "audit"];

  /* ---- multi-tenant namespacing ----
     Every company that signs up gets its own data namespace so several
     businesses can live on one device. The active workspace id (set at
     login / sign-up) prefixes every collection key:
        active  →  sap_<wsId>_clients
        none    →  sap_clients   (legacy / never auto-seeded)               */
  function curWs() { try { return localStorage.getItem("sap_active_ws"); } catch (e) { return null; } }
  function setActiveWs(id) { if (id) localStorage.setItem("sap_active_ws", id); else localStorage.removeItem("sap_active_ws"); }
  const key = (c) => { const w = curWs(); return w ? ("sap_" + w + "_" + c) : ("sap_" + c); };
  const nsKey = (ws, c) => ws ? ("sap_" + ws + "_" + c) : ("sap_" + c);

  let connected = false;            // resolved at init()
  let base = (cfg.API_BASE || "").trim().replace(/\/$/, "");

  /* ---- localStorage helpers ---- */
  function lsGet(c) { try { return JSON.parse(localStorage.getItem(key(c))) || []; } catch (e) { return []; } }
  function lsSet(c, v) { localStorage.setItem(key(c), JSON.stringify(v)); }

  /* ---- connection ---- */
  async function init() {
    // a runtime override from Settings takes precedence over config.js
    const override = localStorage.getItem("sap_api_base");
    if (override !== null) base = override.trim().replace(/\/$/, "");

    if (base) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3500);
        const r = await fetch(base + (cfg.HEALTH_PATH || "/health"), { signal: ctrl.signal });
        clearTimeout(t);
        connected = r.ok;
      } catch (e) { connected = false; }
    } else {
      connected = false;
    }
    // Multi-tenant: each company's data is created at sign-up and isolated by
    // namespace — there is no auto-seeded demo dataset any more.
    return connected;
  }

  function isConnected() { return connected; }
  function mode() { return connected ? "live" : "demo"; }
  function siteUrl() { return cfg.SITE_URL || "#"; }

  function setApiBase(url) {
    localStorage.setItem("sap_api_base", url || "");
  }
  function getApiBase() {
    const o = localStorage.getItem("sap_api_base");
    return o !== null ? o : (cfg.API_BASE || "");
  }

  /* ---- id helper ---- */
  function nextId(c) {
    const prefix = { clients: "C-1", suppliers: "S-2", products: "P-3", quotes: "Q-4", orders: "O-5", shipments: "SH-7", invoices: "I-9", purchaseorders: "PO-6", bills: "B-8", payments: "PM-9", users: "U-0", audit: "A-0" }[c] || "X-";
    const n = lsGet(c).length + Math.floor(Math.random() * 50) + 100;
    return prefix + n;
  }

  /* ---- multi-tenant header management ---- */
  function getHeaders(extra = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, extra);
    const token = localStorage.getItem("sap_token");
    if (token) headers["Authorization"] = "Bearer " + token;

    if (window.Workspace) {
      const active = Workspace.active();
      if (active) {
        headers["x-workspace-id"] = active.id;
        if (active.dbType) headers["x-workspace-db-type"] = active.dbType;
        if (active.dbUri) headers["x-workspace-db-uri"] = active.dbUri;
      }
    }
    return headers;
  }

  /* ---- CRUD (async; LIVE uses REST, DEMO uses localStorage) ---- */
  async function list(c) {
    if (connected) {
      const r = await fetch(base + "/" + c, { headers: getHeaders() });
      return r.json();
    }
    return lsGet(c);
  }

  async function get(c, id) {
    const all = await list(c);
    return all.find((x) => x.id === id);
  }

  async function create(c, record) {
    record = Object.assign({ id: nextId(c) }, record);
    if (connected) {
      const r = await fetch(base + "/" + c, { method: "POST", headers: getHeaders(), body: JSON.stringify(record) });
      record = await r.json();
    } else {
      const all = lsGet(c);
      all.unshift(record);
      lsSet(c, all);
    }
    return record;
  }

  async function update(c, id, patch) {
    let result;
    if (connected) {
      const r = await fetch(base + "/" + c + "/" + id, { method: "PUT", headers: getHeaders(), body: JSON.stringify(patch) });
      result = await r.json();
    } else {
      const all = lsGet(c);
      const i = all.findIndex((x) => x.id === id);
      if (i > -1) { all[i] = Object.assign({}, all[i], patch); result = all[i]; lsSet(c, all); }
    }
    return result;
  }

  async function remove(c, id) {
    if (connected) {
      await fetch(base + "/" + c + "/" + id, { method: "DELETE", headers: getHeaders() });
    } else {
      lsSet(c, lsGet(c).filter((x) => x.id !== id));
    }
    return true;
  }

  /* ---- auth (LIVE verifies a hashed password server-side) ---- */
  async function login(email, password) {
    if (!connected) return null; // caller falls back to local demo check
    try {
      const r = await fetch(base + "/auth/login", {
        method: "POST", headers: getHeaders(),
        body: JSON.stringify({ email: String(email).toLowerCase(), password })
      });
      if (!r.ok) return null;
      const j = await r.json();
      if (j && j.token) localStorage.setItem("sap_token", j.token);
      return (j && j.user) || null;
    } catch (e) { return null; }
  }

  /* ---- AI proxy (LIVE keeps the Gemini key on the server) ---- */
  async function aiChat(payload) {
    if (!connected) throw new Error("not-connected");
    const r = await fetch(base + "/ai/chat", {
      method: "POST", headers: getHeaders(),
      body: JSON.stringify(payload)
    });
    if (!r.ok) { let m = "ai-proxy " + r.status; try { const e = await r.json(); if (e.error) m = e.error; } catch (x) {} throw new Error(m); }
    const j = await r.json();
    if (!j || !j.text) throw new Error("empty ai response");
    return j.text;
  }
  function hasAiProxy() { return connected; }

  /* ---- audit trail ---- */
  function logAction(action, entity, entityId, summary, meta) {
    const actor = (window.Auth && Auth.current() && Auth.current().name) || "System";
    const entry = { id: "A-" + Date.now(), ts: new Date().toISOString(), actor, action, entity, entityId, summary };
    if (meta) entry.meta = meta;
    if (connected) {
      fetch(base + "/audit", { method: "POST", headers: getHeaders(), body: JSON.stringify(entry) }).catch(() => {});
    } else {
      const all = lsGet("audit");
      all.unshift(entry);
      lsSet("audit", all.slice(0, 600));
    }
    return entry;
  }

  /* Returns audit entries from the last N days */
  async function auditWindow(days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const all = await list("audit");
    return all.filter(function(a) { return a.ts && new Date(a.ts) >= cutoff; });
  }

  /* ---- new-workspace bootstrap (used by sign-up) ----
     Clears the target company's namespace, then installs the chosen
     industry's sample pack. The pack is keyed by full "sap_*" collection
     keys (e.g. "sap_clients"); we strip that prefix and re-write each
     collection into the workspace namespace. */
  function installWorkspaceData(pack, wsId) {
    const ws = wsId || curWs();
    COLLECTIONS.forEach((c) => localStorage.removeItem(nsKey(ws, c)));
    if (pack) Object.keys(pack).forEach((rawKey) => {
      const c = rawKey.replace(/^sap_/, "");
      localStorage.setItem(nsKey(ws, c), JSON.stringify(pack[rawKey]));
    });
  }

  /* Reset the active company back to its sign-up state — empty, or its
     industry sample pack — while keeping the whole team (owner + employees). */
  function resetWorkspace() {
    const w = window.Workspace && Workspace.active && Workspace.active();
    if (!w) { COLLECTIONS.forEach((c) => localStorage.removeItem(key(c))); return; }
    const team = lsGet("users");
    const pack = (w.sampleData && window.Workspace) ? Workspace.sampleFor(w.industry) : {};
    if (pack) delete pack.sap_users;
    installWorkspaceData(pack, w.id);
    lsSet("users", team);
  }
  // legacy alias still referenced in a couple of places
  function resetDemo() { resetWorkspace(); }

  /* Permanently delete a company's data namespace (used when a throwaway
     demo company is discarded on logout). */
  function purgeWorkspace(wsId) {
    if (!wsId) return;
    COLLECTIONS.forEach((c) => localStorage.removeItem(nsKey(wsId, c)));
  }

  return {
    init, isConnected, mode, siteUrl, setApiBase, getApiBase, setActiveWs,
    list, get, create, update, remove, logAction, auditWindow, resetDemo,
    installWorkspaceData, resetWorkspace, purgeWorkspace,
    login, aiChat, hasAiProxy,
    COLLECTIONS
  };
})();
