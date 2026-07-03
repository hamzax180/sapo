/* =================================================================
   MERVEKS SAP — Workflow engine
   Turns the data into a relay employees pass between each other:
     Trade drafts a quote → hands the order to Operations → who books
     the shipment → hands the invoice to Finance → who collects it.
   Provides:
     • notify()/assign()  — create a task/handoff for a teammate
     • myWork(user)        — the 3-bucket personal queue (urgent / waiting / heads-up)
     • unread()/markRead() — the notification bell
   Works in DEMO (localStorage) and LIVE (Mongo) transparently via Store.
   ================================================================= */
window.Workflow = (function () {
  // Which role owns each stage of the chain (used for auto-handoffs).
  const STAGE_ROLE = {
    order: "Operations Manager",   // a confirmed order → Operations books the shipment
    shipment: "Operations Manager",
    invoice: "Finance Officer",    // a delivered shipment → Finance issues & collects
    payment: "Owner",
    quote: "Trade Specialist"
  };

  let _usersCache = null;
  async function users() { if (!_usersCache) _usersCache = await Store.list("users"); return _usersCache; }
  function invalidate() { _usersCache = null; }

  /* first active user holding a role — the default assignee for that stage */
  async function defaultAssignee(role) {
    const us = await users();
    return (us.find((u) => u.role === role && u.active) || us.find((u) => u.role === role) || null);
  }
  async function userName(id) { const us = await users(); const u = us.find((x) => x.id === id); return u ? u.name : id; }

  /* ---- create a notification / task for a teammate ---- */
  async function notify(n) {
    const actor = (window.Auth && Auth.current()) || {};
    const rec = {
      id: "N-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
      ts: new Date().toISOString(),
      to: n.to,
      fromName: n.fromName || actor.name || "System",
      type: n.type || "info",
      title: n.title || "",
      body: n.body || "",
      entity: n.entity || "",
      entityId: n.entityId || "",
      link: n.link || "#/mywork",
      read: false
    };
    if (n.to) await Store.create("notifications", rec);
    return rec;
  }

  /* ---- hand a record off to someone (sets assignedTo + notifies) ---- */
  async function assign(collection, id, toUserId, opts) {
    opts = opts || {};
    await Store.update(collection, id, { assignedTo: toUserId });
    if (window.Store && Store.logAction) Store.logAction("update", opts.entity || collection, id, "Handed off " + (opts.ref || id) + " → " + (await userName(toUserId)));
    await notify({
      to: toUserId, type: opts.type || "handoff",
      title: opts.title || "New task assigned",
      body: opts.body || "", entity: opts.entity || collection, entityId: id, link: opts.link || "#/mywork"
    });
  }

  /* hand off to whichever active user owns the next stage's role */
  async function handoffToStage(stage, collection, id, opts) {
    const u = await defaultAssignee(STAGE_ROLE[stage] || "Owner");
    if (!u) return null;
    await assign(collection, id, u.id, opts);
    return u;
  }

  /* ---- the bell ---- */
  async function listFor(userId) {
    const all = await Store.list("notifications");
    return all.filter((n) => n.to === userId).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  }
  async function unread(userId) { return (await listFor(userId)).filter((n) => !n.read).length; }
  async function markRead(id) { await Store.update("notifications", id, { read: true }); }
  async function markAllRead(userId) {
    const list = await listFor(userId);
    for (const n of list) if (!n.read) await Store.update("notifications", n.id, { read: true });
  }

  /* ---- the 3-bucket personal queue ---- */
  async function myWork(user) {
    const can = (a) => window.Auth && Auth.can(a, "view");
    const [invoices, shipments, products, orders, quotes, pos, notes] = await Promise.all([
      Store.list("invoices"), Store.list("shipments"), Store.list("products"),
      Store.list("orders"), Store.list("quotes"), Store.list("purchaseorders"), listFor(user.id)
    ]);
    const urgent = [], waiting = [], heads = [];

    /* URGENT — live alerts, shown to anyone with the relevant permission */
    if (can("finance")) {
      invoices.filter((i) => i.status === "Overdue").forEach((i) =>
        urgent.push({ tone: "red", icon: "receipt", title: "Invoice " + (i.no || i.id) + " overdue",
          sub: UI.money(i.amount - (i.paid || 0), i.currency) + " · " + UI.t("chase the client"), link: "#/finance", action: UI.t("Chase") }));
    }
    if (can("shipments")) {
      shipments.filter((s) => ["Customs", "On Hold"].includes(s.status)).forEach((s) =>
        urgent.push({ tone: "red", icon: "truck", title: UI.t("Shipment") + " " + s.ref + " · " + UI.t(s.status),
          sub: (s.origin || "") + " → " + (s.destination || ""), link: "#/shipments", action: UI.t("Resolve") }));
    }
    if (can("inventory")) {
      products.filter((p) => (p.stock || 0) <= (p.reorder || 0)).forEach((p) =>
        urgent.push({ tone: "red", icon: "package", title: p.name + " · " + UI.t("low stock"),
          sub: (p.stock || 0) + " " + UI.t("in stock") + " · " + UI.t("reorder at") + " " + (p.reorder || 0), link: "#/inventory", action: UI.t("Reorder") }));
    }

    /* WAITING — explicit handoffs / mentions / tasks addressed to me */
    const handledIds = {};
    notes.filter((n) => !n.read && ["handoff", "mention", "task"].includes(n.type)).forEach((n) => {
      handledIds[n.entityId] = true;
      waiting.push({ tone: "blue", icon: n.type === "mention" ? "chat" : "handoff", title: n.title, sub: n.body,
        link: n.link, action: n.type === "mention" ? UI.t("Reply") : UI.t("Open"), notifId: n.id, from: n.fromName });
    });
    /* plus any record assigned to me that needs action and has no notification yet */
    const mine = (arr, ok) => arr.filter((r) => r.assignedTo === user.id && ok(r) && !handledIds[r.id]);
    if (can("orders")) mine(orders, (o) => ["Pending", "Confirmed"].includes(o.status) && !o.shipmentId).forEach((o) =>
      waiting.push({ tone: "blue", icon: "cart", title: UI.t("Order") + " " + o.ref + " · " + UI.t("book shipment"), sub: UI.t("Assigned to you"), link: "#/orders", action: UI.t("Open") }));
    if (can("shipments")) mine(shipments, (s) => s.status === "Booked").forEach((s) =>  // On Hold already surfaces under urgent
      waiting.push({ tone: "blue", icon: "truck", title: UI.t("Shipment") + " " + s.ref + " · " + UI.t(s.status), sub: UI.t("Assigned to you"), link: "#/shipments", action: UI.t("Open") }));
    if (can("finance")) mine(invoices, (i) => ["Draft", "Sent"].includes(i.status)).forEach((i) =>
      waiting.push({ tone: "blue", icon: "receipt", title: UI.t("Invoice") + " " + (i.no || i.id) + " · " + UI.t(i.status), sub: UI.t("Assigned to you"), link: "#/finance", action: UI.t("Open") }));
    if (can("quotes")) mine(quotes, (q) => ["Draft", "Sent"].includes(q.status)).forEach((q) =>
      waiting.push({ tone: "blue", icon: "quote", title: UI.t("Quote") + " " + (q.ref || q.id) + " · " + UI.t(q.status), sub: UI.t("Assigned to you"), link: "#/quotes", action: UI.t("Open") }));
    if (can("purchasing")) mine(pos, (p) => ["Draft", "Sent"].includes(p.status)).forEach((p) =>
      waiting.push({ tone: "blue", icon: "bag", title: "PO " + (p.ref || p.id) + " · " + UI.t(p.status), sub: UI.t("Assigned to you"), link: "#/purchasing", action: UI.t("Open") }));

    /* HEADS-UP — unread FYI notifications */
    notes.filter((n) => !n.read && ["info", "alert"].includes(n.type)).forEach((n) =>
      heads.push({ tone: "slate", icon: "bell", title: n.title, sub: n.body, link: n.link, action: UI.t("View"), notifId: n.id, from: n.fromName }));

    return { urgent, waiting, heads };
  }

  async function summary(user) {
    const w = await myWork(user);
    return { urgent: w.urgent.length, waiting: w.waiting.length, heads: w.heads.length, total: w.urgent.length + w.waiting.length };
  }

  return { defaultAssignee, notify, assign, handoffToStage, listFor, unread, markRead, markAllRead, myWork, summary, invalidate, STAGE_ROLE };
})();
