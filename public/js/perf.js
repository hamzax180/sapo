/* =================================================================
   MERVEKS SAP — Employee Performance Engine  (perf.js)
   Computes multi-dimensional performance scores for each user.
   Called by the Team & Accounts view and the employee detail drawer.
   Pure computation — no DOM, no UI imports.
   ================================================================= */
window.Perf = (function () {

  /* ---- Role -> primary KPI entity weights ---- */
  const ROLE_WEIGHTS = {
    "Owner":              { shipment:1, order:1, client:1, supplier:1, invoice:1, quote:1, product:1, purchaseorder:1 },
    "Operations Manager": { shipment:1, order:1, purchaseorder:1, product:0.5, client:0.3, invoice:0.3, quote:0.3 },
    "Finance Officer":    { invoice:1, payment:1, bill:1, order:0.4, quote:0.4, client:0.3 },
    "Trade Specialist":   { quote:1, client:1, order:1, supplier:0.8, shipment:0.5, invoice:0.3 },
    "Employee":           { shipment:0.8, order:0.8, product:0.8, client:0.5, invoice:0.5 }
  };

  /* ---- Action weights ---- */
  const ACTION_W = { create: 3, update: 1.5, delete: -1, login: 0.2, logout: 0 };

  /* ---- Raise tiers ---- */
  const RAISE_TABLE = [
    { min: 90, label: "Exceptional",  low: 12, high: 15, color: "#1f9d6b" },
    { min: 75, label: "Strong",       low: 8,  high: 11, color: "#1aa6df" },
    { min: 60, label: "Good",         low: 5,  high: 7,  color: "#7a4fb0" },
    { min: 40, label: "Average",      low: 2,  high: 4,  color: "#d97706" },
    { min: 0,  label: "Needs Review", low: 0,  high: 0,  color: "#e53e3e" }
  ];

  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function compute(users, audit, invoices, orders) {
    const now = new Date();
    const w30 = daysAgo(30);
    const w56 = daysAgo(56);

    const active = users.filter(function(u){ return u.active !== false; });

    var perUser = {};
    active.forEach(function(u){
      perUser[u.name] = { last30: [], last56: [], all: [] };
    });

    audit.forEach(function(a){
      if (!perUser[a.actor]) return;
      var tsDate = new Date(a.ts);
      var entry = Object.assign({}, a, { _ts: tsDate });
      perUser[a.actor].all.push(entry);
      if (tsDate >= w30) perUser[a.actor].last30.push(entry);
      if (tsDate >= w56) perUser[a.actor].last56.push(entry);
    });

    /* Revenue attribution */
    var invoiceRevenue = {};
    (invoices || []).forEach(function(inv){
      if (inv.status === "Paid") {
        var creator = audit.find(function(a){ return a.action === "create" && a.entity === "invoice" && a.entityId === inv.id; });
        if (creator && perUser[creator.actor] !== undefined) {
          invoiceRevenue[creator.actor] = (invoiceRevenue[creator.actor] || 0) + (inv.amount || 0);
        }
      }
    });
    (orders || []).forEach(function(ord){
      if (ord.status === "Completed" || ord.status === "Shipped") {
        var creator = audit.find(function(a){ return a.action === "create" && a.entity === "order" && a.entityId === ord.id; });
        if (creator && perUser[creator.actor] !== undefined) {
          var total = (ord.items || []).reduce(function(s,it){ return s + it.qty * it.price; }, 0) + (ord.freight || 0);
          invoiceRevenue[creator.actor] = (invoiceRevenue[creator.actor] || 0) + total * 0.3;
        }
      }
    });

    var results = active.map(function(u){
      var e30  = perUser[u.name].last30;
      var e56  = perUser[u.name].last56;
      var eAll = perUser[u.name].all;
      var roleW = ROLE_WEIGHTS[u.role] || ROLE_WEIGHTS["Employee"];

      /* Consistency */
      var daySet = new Set(e30.map(function(a){ return a.ts.slice(0,10); }));
      var activeDays = daySet.size;
      var consistencyScore = Math.min(100, (activeDays / 30) * 100);

      /* Quality */
      var rawQuality = 0;
      e30.forEach(function(a){
        rawQuality += (roleW[a.entity] || 0.2) * (ACTION_W[a.action] || 0);
      });
      var myCreates = new Set(e30.filter(function(a){ return a.action === "create"; }).map(function(a){ return a.entityId; }));
      var myDeletes = e30.filter(function(a){ return a.action === "delete" && myCreates.has(a.entityId); }).length;
      var reworkRate = myCreates.size > 0 ? myDeletes / myCreates.size : 0;
      var qualityMult = Math.max(0.5, 1 - reworkRate);
      var qualityScore = Math.min(100, rawQuality * qualityMult * 3);

      /* Revenue */
      var revenue = invoiceRevenue[u.name] || 0;

      /* Seniority */
      var joinYear = u.joined ? new Date(u.joined).getFullYear() : now.getFullYear();
      var seniority = Math.min(10, now.getFullYear() - joinYear);
      var seniorityScore = seniority * 10;

      /* Sparkline — 8 weekly buckets */
      var sparkData = [0,0,0,0,0,0,0,0];
      e56.forEach(function(a){
        var dBack = Math.floor((now - a._ts) / 86400000);
        var bucket = Math.min(7, Math.floor(dBack / 7));
        sparkData[7 - bucket]++;
      });

      var todayStr = now.toISOString().slice(0,10);
      return {
        u: u,
        activeDays: activeDays,
        consistencyScore: consistencyScore,
        qualityScore: qualityScore,
        revenue: revenue,
        seniorityScore: seniorityScore,
        reworkRate: reworkRate,
        sparkData: sparkData,
        allActions: eAll.length,
        todayActions: e30.filter(function(a){ return a.ts.slice(0,10) === todayStr; }).length,
        last30Actions: e30.length
      };
    });

    /* Normalise revenue */
    var maxRev = Math.max(1, Math.max.apply(null, results.map(function(r){ return r.revenue; })));
    results.forEach(function(r){
      r.revenueScore = Math.min(100, (r.revenue / maxRev) * 100);
    });

    /* PERF score */
    results.forEach(function(r){
      r.perfScore = Math.round(
        r.consistencyScore * 0.25 +
        r.qualityScore     * 0.35 +
        r.revenueScore     * 0.30 +
        r.seniorityScore   * 0.10
      );
    });

    /* Percentile */
    var sorted = results.map(function(r){ return r.perfScore; }).sort(function(a,b){ return a - b; });
    results.forEach(function(r){
      var below = sorted.filter(function(s){ return s < r.perfScore; }).length;
      r.percentile = Math.round((below / Math.max(1, sorted.length - 1)) * 100);
    });

    /* Raise range */
    results.forEach(function(r){
      r.raiseRange = RAISE_TABLE.find(function(t){ return r.percentile >= t.min; }) || RAISE_TABLE[RAISE_TABLE.length - 1];
    });

    /* Trend */
    results.forEach(function(r){
      var recent = r.sparkData.slice(6).reduce(function(a,b){ return a+b; }, 0);
      var prior  = r.sparkData.slice(4,6).reduce(function(a,b){ return a+b; }, 0);
      r.trend = recent > prior * 1.1 ? "up" : recent < prior * 0.9 ? "down" : "flat";
    });

    results.sort(function(a,b){ return b.perfScore - a.perfScore; });
    return results;
  }

  return { compute: compute, RAISE_TABLE: RAISE_TABLE };
})();
