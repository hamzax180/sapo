/* =================================================================
   Souqi — server-side RBAC (single source of truth)
   -----------------------------------------------------------------
   Mirrors the role matrix the console UI uses (public/js/ui.js), but
   ENFORCED on the server. The browser copy is for UX only; this copy
   is authoritative. Keep the two in sync.
   ================================================================= */
"use strict";

// Role → allowed nav (read), edit (write) and del (delete) areas.
// "*" means all areas.
const ROLE_PERMS = Object.freeze({
  "Owner": { nav: "*", edit: "*", del: "*" },
  "HR Manager": {
    nav: ["dashboard", "attendance", "payroll", "users"],
    edit: ["attendance", "payroll", "users"],
    del: []
  },
  "Operations Manager": {
    nav: ["dashboard", "quotes", "orders", "shipments", "inventory", "purchasing", "clients", "suppliers", "attendance"],
    edit: ["quotes", "orders", "shipments", "inventory", "purchasing", "attendance"],
    del: []
  },
  "Finance Officer": {
    nav: ["dashboard", "clients", "finance", "attendance", "payroll"],
    edit: ["finance", "attendance"],
    del: []
  },
  "Trade Specialist": {
    nav: ["dashboard", "quotes", "orders", "shipments", "inventory", "clients", "suppliers", "attendance"],
    edit: ["quotes", "orders", "clients", "suppliers", "inventory", "attendance"],
    del: []
  }
});

// Which functional "area" each data collection belongs to.
const COLLECTION_AREA = Object.freeze({
  users: "users",
  clients: "clients",
  suppliers: "suppliers",
  products: "inventory",
  quotes: "quotes",
  orders: "orders",
  shipments: "shipments",
  invoices: "finance",
  purchaseorders: "purchasing",
  bills: "finance",
  payments: "finance",
  notifications: "dashboard",
  audit: "audit"
});

function areaFor(collection) {
  return COLLECTION_AREA[collection] || collection;
}

function inList(list, area) {
  return list === "*" || (Array.isArray(list) && list.indexOf(area) !== -1);
}

/**
 * Can `role` perform `action` on `collection`?
 * action ∈ { "read", "create", "update", "delete" }.
 *
 * Two collections are special:
 *   • audit         — append-only history. Any authenticated role may
 *                     append (create); only the Owner may read; nobody
 *                     may update or delete through the API.
 *   • notifications — low-risk; any role may read/create/update (e.g.
 *                     mark-as-read); only del-privileged roles may delete.
 */
function can(role, collection, action) {
  const perms = ROLE_PERMS[role];
  if (!perms) return false;
  const area = areaFor(collection);

  if (collection === "audit") {
    if (action === "read") return role === "Owner";
    if (action === "create") return true;
    return false; // no update / delete via API
  }

  if (collection === "notifications") {
    if (action === "delete") return inList(perms.del, "dashboard");
    return true; // read / create / update for any authenticated role
  }

  if (action === "read") return inList(perms.nav, area);
  if (action === "create" || action === "update") return inList(perms.edit, area);
  if (action === "delete") return inList(perms.del, area);
  return false;
}

/** Map an HTTP method to a permission action. */
function actionForMethod(method) {
  switch (String(method).toUpperCase()) {
    case "GET": return "read";
    case "POST": return "create";
    case "PUT":
    case "PATCH": return "update";
    case "DELETE": return "delete";
    default: return "read";
  }
}

module.exports = { ROLE_PERMS, COLLECTION_AREA, can, actionForMethod, areaFor };
