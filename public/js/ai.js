/* =================================================================
   MERVEKS SAP — AI Accounting
   A Gemini-backed "AI Accountant" for the Finance module. Builds a
   structured prompt from live invoice data and returns a cash-flow /
   collections analysis. When no API key is configured it falls back to
   a built-in offline analysis engine so the feature always works.
   ================================================================= */
window.AI = (function () {
  const cfg = window.SAP_CONFIG || {};

  function getKey() {
    const o = localStorage.getItem("sap_gemini_key");
    return (o !== null ? o : (cfg.GEMINI_API_KEY || "")).trim();
  }
  function setKey(k) { localStorage.setItem("sap_gemini_key", k || ""); }
  function model() { return cfg.GEMINI_MODEL || "gemini-2.0-flash"; }
  function hasKey() { return !!getKey(); }
  // AI can run live via a local key OR the server-side proxy (LIVE mode).
  function proxyAvailable() { return !!(window.Store && Store.hasAiProxy && Store.hasAiProxy()); }
  function liveAI() { return hasKey() || proxyAvailable(); }

  /* ---- low-level Gemini REST call ---- */
  async function callGemini(prompt) {
    const gen = { temperature: 0.4, maxOutputTokens: 1100 };
    // Prefer the server proxy in LIVE mode (key stays server-side).
    if (!hasKey() && proxyAvailable()) {
      return Store.aiChat({ prompt, generationConfig: gen });
    }
    const key = getKey();
    if (!key) throw new Error("no-key");
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model() + ":generateContent?key=" + encodeURIComponent(key);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: gen
      })
    });
    if (!res.ok) {
      let msg = "Gemini error " + res.status;
      try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch (x) {}
      throw new Error(msg);
    }
    const j = await res.json();
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts &&
      j.candidates[0].content.parts.map((p) => p.text).join("");
    if (!text) throw new Error("Empty response from Gemini");
    return text;
  }

  /* ---- aggregate finance figures ---- */
  function summarize(invoices, clientMap) {
    const today = new Date();
    const sum = (arr) => arr.reduce((a, i) => a + i.amount, 0);
    const paid = invoices.filter((i) => i.status === "Paid");
    const open = invoices.filter((i) => ["Sent", "Overdue", "Draft"].includes(i.status));
    const overdue = invoices.filter((i) => i.status === "Overdue").map((i) => ({
      no: i.no, client: (clientMap[i.client] || {}).name || i.client, amount: i.amount, currency: i.currency,
      days: Math.max(0, Math.round((today - new Date(i.due)) / 86400000))
    })).sort((a, b) => b.days - a.days);
    // outstanding by client
    const byClient = {};
    open.forEach((i) => { const n = (clientMap[i.client] || {}).name || i.client; byClient[n] = (byClient[n] || 0) + i.amount; });
    const topDebtors = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return {
      totalBilled: sum(invoices), collected: sum(paid), outstanding: sum(open), overdueTotal: sum(overdue),
      counts: { all: invoices.length, paid: paid.length, open: open.length, overdue: overdue.length },
      overdue, topDebtors
    };
  }

  /* ---- prompt for Gemini ---- */
  function buildPrompt(invoices, clientMap) {
    const rows = invoices.map((i) => ({
      no: i.no, client: (clientMap[i.client] || {}).name || i.client,
      amount: i.amount, currency: i.currency, status: i.status, issued: i.issued, due: i.due
    }));
    const lang = (window.UI && UI.getLang) ? UI.getLang() : "en";
    const languageNote = lang === "tr" 
      ? "IMPORTANT: You MUST write the report entirely in Turkish language (Türkçe)." 
      : "You MUST write the report entirely in English language.";
    return [
      "You are a senior accountant for MERVEKS, a Turkish logistics & trading company (railway freight, food supply, Nano-Z coating distribution).",
      "Analyse the following accounts-receivable ledger and produce a concise, professional report in Markdown.",
      languageNote,
      "Today's date is " + new Date().toISOString().slice(0, 10) + ".",
      "",
      "Structure the report with these sections (use ## headings):",
      lang === "tr" ? "1. Nakit pozisyonu — faturalanan, tahsil edilen, bekleyen, vadesi geçmiş toplamlar (karışık para birimlerine dikkat edin)." : "1. Cash position — billed, collected, outstanding, overdue totals (note mixed currencies).",
      lang === "tr" ? "2. Tahsilat önceliği — hangi vadesi geçmiş faturaların önce takip edileceği ve nedenleri." : "2. Collections priority — which overdue invoices to chase first and why.",
      lang === "tr" ? "3. Risk faktörleri — yoğunlaşma, yaşlandırma, kur riski." : "3. Risk flags — concentration, ageing, currency exposure.",
      lang === "tr" ? "4. Öneriler — 3 ila 5 somut sonraki adım." : "4. Recommendations — 3 to 5 concrete next actions.",
      "Keep it under 350 words. Be specific with numbers and client names. Do not invent data.",
      "",
      "Invoice ledger (JSON):",
      JSON.stringify(rows, null, 0)
    ].join("\n");
  }

  /* ---- offline analysis (no key) ---- */
  function offline(invoices, clientMap) {
    const s = summarize(invoices, clientMap);
    const lang = (window.UI && UI.getLang) ? UI.getLang() : "en";
    const m = (n) => "$" + Number(n).toLocaleString(lang === "tr" ? "tr-TR" : "en-US");
    let out = "";
    if (lang === "tr") {
      out += "## Nakit pozisyonu\n";
      out += "- **Toplam faturalanan:** " + m(s.totalBilled) + " (" + s.counts.all + " fatura)\n";
      out += "- **Tahsil edilen:** " + m(s.collected) + " (" + s.counts.paid + " ödenmiş)\n";
      out += "- **Bekleyen:** " + m(s.outstanding) + " (" + s.counts.open + " açık)\n";
      out += "- **Vadesi geçen:** " + m(s.overdueTotal) + " (" + s.counts.overdue + " fatura)\n";
      const collRate = s.totalBilled ? Math.round((s.collected / s.totalBilled) * 100) : 0;
      out += "- **Tahsilat oranı:** %" + collRate + "\n\n";

      out += "## Tahsilat önceliği\n";
      if (s.overdue.length) {
        s.overdue.slice(0, 5).forEach((o) => {
          out += "- **" + o.no + "** — " + o.client + ", " + m(o.amount) + " · **" + o.days + " gün gecikmiş**\n";
        });
      } else { out += "- Vadesi geçmiş fatura bulunmamaktadır. Alacaklar günceldir. ✓\n"; }
      out += "\n## Müşteri bazında bekleyen alacaklar\n";
      s.topDebtors.forEach(([n, v]) => { out += "- " + n + " — " + m(v) + "\n"; });

      out += "\n## Öneriler\n";
      if (s.overdue.length) {
        out += "1. Vadesi geçen " + s.counts.overdue + " fatura için bugün hatırlatma gönderin; en eskisinden başlayın (" + s.overdue[0].client + ").\n";
        out += "2. Ödeme tarihini teyit etmek için " + s.overdue[0].client + " firmasını arayın (" + s.overdue[0].no + ").\n";
      } else {
        out += "1. Alacaklar sağlıklı durumda — vade tarihinden önce " + s.counts.open + " açık faturayı takip etmeye devam edin.\n";
      }
      out += "3. Para birimi riskini izleyin — faturalar USD/EUR karışık; büyük EUR bakiyelerini korumak için hedging seçeneğini değerlendirin.\n";
      out += "4. Sürekli geç ödeme yapan müşteriler için vadeleri kısaltın; yeni yüksek değerli siparişlerde avans talep edin.\n";
    } else {
      out += "## Cash position\n";
      out += "- **Total billed:** " + m(s.totalBilled) + " across " + s.counts.all + " invoices\n";
      out += "- **Collected:** " + m(s.collected) + " (" + s.counts.paid + " paid)\n";
      out += "- **Outstanding:** " + m(s.outstanding) + " (" + s.counts.open + " open)\n";
      out += "- **Overdue:** " + m(s.overdueTotal) + " (" + s.counts.overdue + " invoices)\n";
      const collRate = s.totalBilled ? Math.round((s.collected / s.totalBilled) * 100) : 0;
      out += "- **Collection rate:** " + collRate + "%\n\n";

      out += "## Collections priority\n";
      if (s.overdue.length) {
        s.overdue.slice(0, 5).forEach((o) => {
          out += "- **" + o.no + "** — " + o.client + ", " + m(o.amount) + " · **" + o.days + " days overdue**\n";
        });
      } else { out += "- No overdue invoices. Receivables are current. ✓\n"; }
      out += "\n## Top outstanding by client\n";
      s.topDebtors.forEach(([n, v]) => { out += "- " + n + " — " + m(v) + "\n"; });

      out += "\n## Recommendations\n";
      if (s.overdue.length) {
        out += "1. Issue reminders today for the " + s.counts.overdue + " overdue invoice(s); start with the oldest (" + s.overdue[0].client + ").\n";
        out += "2. Call " + s.overdue[0].client + " to confirm payment date on " + s.overdue[0].no + ".\n";
      } else {
        out += "1. Receivables are healthy — keep monitoring the " + s.counts.open + " open invoice(s) before due dates.\n";
      }
      out += "3. Watch currency exposure — invoices are mixed USD/EUR; consider hedging large EUR balances.\n";
      out += "4. Tighten terms for clients with repeated late payment; require deposits on new high-value orders.\n";
    }
    return out;
  }

  /* ---- public: analyse the whole ledger ---- */
  async function analyzeFinance(invoices, clientMap) {
    if (liveAI()) {
      try {
        const text = await callGemini(buildPrompt(invoices, clientMap));
        return { source: "gemini", text };
      } catch (e) {
        return { source: "offline", error: e.message, text: offline(invoices, clientMap) };
      }
    }
    return { source: "offline", text: offline(invoices, clientMap) };
  }

  /* ---- public: explain a single invoice ---- */
  async function analyzeInvoice(inv, client) {
    const ctx = "Invoice " + inv.no + " — client " + ((client || {}).name || inv.client) + ", amount " + inv.currency + " " + inv.amount +
      ", status " + inv.status + ", issued " + inv.issued + ", due " + inv.due + ". Today is " + new Date().toISOString().slice(0, 10) + ".";
    const lang = (window.UI && UI.getLang) ? UI.getLang() : "en";
    const systemPrompt = lang === "tr"
      ? "You are an accountant for MERVEKS. In 3 short bullet points, assess this single invoice (collection risk, what action to take, any flag). Be concise. You MUST write the response in Turkish language."
      : "You are an accountant for MERVEKS. In 3 short bullet points, assess this single invoice (collection risk, what action to take, any flag). Be concise.";
    if (liveAI()) {
      try {
        const text = await callGemini(systemPrompt + "\n\n" + ctx);
        return { source: "gemini", text };
      } catch (e) { /* fall through */ }
    }
    // offline single-invoice note
    const due = new Date(inv.due), today = new Date();
    const days = Math.round((today - due) / 86400000);
    if (lang === "tr") {
      let risk = inv.status === "Paid" ? "Ödendi — işlem gerekmiyor." : inv.status === "Overdue" ? ("Yüksek — " + days + " gün gecikmiş.") : days > 0 ? "Yüksek — vadesi geçmiş." : ("Düşük — " + Math.abs(days) + " gün içinde.");
      let action = inv.status === "Paid" ? "Arşivleyin ve mutabakat yapın." : inv.status === "Overdue" ? "Son hatırlatıcıyı gönderin ve müşteriyi bugün arayın." : "Takip edin; vade tarihine yakın nezaket hatırlatması gönderin.";
      return { source: "offline", text: "- **Risk:** " + risk + "\n- **Eylem:** " + action + "\n- **Not:** " + inv.currency + " para biriminde " + (STATUS_TR[inv.status] || inv.status).toLowerCase() + " fatura riski." };
    }
    let risk = inv.status === "Paid" ? "Settled — no action." : inv.status === "Overdue" ? ("High — " + days + " days overdue.") : days > 0 ? "Elevated — past due." : ("Low — due in " + Math.abs(days) + " days.");
    let action = inv.status === "Paid" ? "Archive and reconcile." : inv.status === "Overdue" ? "Send final reminder and call the client today." : "Monitor; send courtesy reminder near due date.";
    return { source: "offline", text: "- **Risk:** " + risk + "\n- **Action:** " + action + "\n- **Note:** " + inv.currency + " exposure on a " + inv.status.toLowerCase() + " invoice." };
  }

  /* ---- multi-turn Gemini call (chat) ---- */
  async function callGeminiContents(contents) {
    const gen = { temperature: 0.5, maxOutputTokens: 900 };
    if (!hasKey() && proxyAvailable()) {
      return Store.aiChat({ contents, generationConfig: gen });
    }
    const key = getKey(); if (!key) throw new Error("no-key");
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model() + ":generateContent?key=" + encodeURIComponent(key);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents, generationConfig: gen }) });
    if (!res.ok) { let msg = "Gemini error " + res.status; try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch (x) {} throw new Error(msg); }
    const j = await res.json();
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts.map((p) => p.text).join("");
    if (!text) throw new Error("Empty response from Gemini");
    return text;
  }
  /* ---- read the whole company's books from the store ---- */
  async function companyData() {
    const cols = ["clients", "suppliers", "products", "quotes", "orders", "shipments", "invoices", "purchaseorders", "bills", "payments", "users"];
    const D = {};
    for (let i = 0; i < cols.length; i++) D[cols[i]] = (window.Store ? await Store.list(cols[i]) : []);
    return D;
  }
  function usd(n, cur) { return (window.UI && UI.toUSD) ? UI.toUSD(n, cur) : Number(n || 0); }

  /* ---- compute full financial picture (AR, AP, cash, P&L, inventory, payroll) ---- */
  function computeFinancials(D) {
    const cmap = Object.fromEntries((D.clients || []).map((c) => [c.id, c]));
    const smap = Object.fromEntries((D.suppliers || []).map((s) => [s.id, s]));
    const sumItems = (it) => (it || []).reduce((a, x) => a + x.qty * x.price, 0);
    const orderTotal = (o) => sumItems(o.items) + (o.freight || 0);
    const inv = D.invoices || [], bills = D.bills || [], pays = D.payments || [], prods = D.products || [], ship = D.shipments || [], ords = D.orders || [], quotes = D.quotes || [], users = D.users || [];
    const arList = inv.filter((i) => ["Sent", "Partial", "Overdue"].includes(i.status));
    const ar = arList.reduce((a, i) => a + usd((i.totalAmount !== undefined ? i.totalAmount : i.amount) - (i.paid || 0), i.currency), 0);
    const overdue = inv.filter((i) => i.status === "Overdue").map((i) => ({ no: i.no, client: (cmap[i.client] || {}).name || i.client, amount: usd((i.totalAmount !== undefined ? i.totalAmount : i.amount) - (i.paid || 0), i.currency) })).sort((a, b) => b.amount - a.amount);
    const overdueTotal = overdue.reduce((a, o) => a + o.amount, 0);
    const apList = bills.filter((b) => ["Unpaid", "Partial", "Overdue"].includes(b.status));
    const ap = apList.reduce((a, b) => a + usd(b.amount - (b.paid || 0), b.currency), 0);
    const cashIn = pays.filter((p) => p.kind === "in").reduce((a, p) => a + usd(p.amount, p.currency), 0);
    const cashOut = pays.filter((p) => p.kind === "out").reduce((a, p) => a + usd(p.amount, p.currency), 0);
    const revenue = inv.filter((i) => i.status !== "Draft").reduce((a, i) => a + usd(i.amount, i.currency), 0);
    const purchases = bills.reduce((a, b) => a + usd(b.amount, b.currency), 0);
    const logistics = ship.reduce((a, s) => a + (s.costs ? (s.costs.freight + s.costs.customs + s.costs.insurance) : 0), 0);
    const grossProfit = revenue - purchases - logistics;
    const grossMargin = revenue ? Math.round((grossProfit / revenue) * 100) : 0;
    const invCost = prods.reduce((a, p) => a + usd((p.stock || 0) * (p.cost || p.price || 0), p.currency), 0);
    const invRetail = prods.reduce((a, p) => a + usd((p.stock || 0) * (p.price || 0), p.currency), 0);
    const lowStock = prods.filter((p) => (p.stock || 0) <= (p.reorder || 0));
    const monthlyPayroll = users.filter((u) => u.active).reduce((a, u) => a + usd(u.salary || 0, u.currency || "USD"), 0);
    const headcount = users.filter((u) => u.active).length;
    const openOrders = ords.filter((o) => ["Pending", "Confirmed", "Shipped"].includes(o.status));
    const openOrdersValue = openOrders.reduce((a, o) => a + usd(orderTotal(o), o.currency), 0);
    const openQuotes = quotes.filter((q) => ["Draft", "Sent"].includes(q.status)).length;
    const activeShip = ship.filter((s) => !["Delivered", "Cancelled"].includes(s.status)).length;
    const byClient = {};
    arList.forEach((i) => { const n = (cmap[i.client] || {}).name || i.client; byClient[n] = (byClient[n] || 0) + usd((i.totalAmount !== undefined ? i.totalAmount : i.amount) - (i.paid || 0), i.currency); });
    const topDebtors = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 5);
    
    // Accrued VAT calculations
    const vatSales = inv.reduce((a, i) => a + usd(i.vatAmount !== undefined ? i.vatAmount : (i.amount * (i.vatRate || 0) / 100), i.currency), 0);
    const vatPurchases = bills.reduce((a, b) => a + usd(b.amount * 0.20, b.currency), 0);
    const netVat = vatSales - vatPurchases;

    return { cmap, smap, ar, overdue, overdueTotal, overdueCount: overdue.length, ap, apCount: apList.length, cashIn, cashOut, cash: cashIn - cashOut, revenue, purchases, logistics, grossProfit, grossMargin, invCost, invRetail, lowStock, monthlyPayroll, headcount, openOrders, openOrdersValue, openQuotes, activeShip, topDebtors, vatSales, vatPurchases, netVat };
  }

  /* ---- full-company context for Gemini ---- */
  function buildCompanyContext(D, F) {
    const lang = (window.UI && UI.getLang) ? UI.getLang() : "en";
    const cmap = F.cmap, smap = F.smap, r = Math.round;
    const pack = {
      kpis: { revenueUSD: r(F.revenue), purchasesUSD: r(F.purchases), logisticsUSD: r(F.logistics), grossProfitUSD: r(F.grossProfit), grossMarginPct: F.grossMargin, accountsReceivableUSD: r(F.ar), overdueUSD: r(F.overdueTotal), accountsPayableUSD: r(F.ap), netCashUSD: r(F.cash), inventoryCostUSD: r(F.invCost), inventoryRetailUSD: r(F.invRetail), monthlyPayrollUSD: r(F.monthlyPayroll), headcount: F.headcount, openOrders: F.openOrders.length, openOrdersValueUSD: r(F.openOrdersValue), activeShipments: F.activeShip },
      invoices: (D.invoices || []).map((i) => ({ no: i.no, client: (cmap[i.client] || {}).name, amount: i.amount, paid: i.paid || 0, cur: i.currency, status: i.status, due: i.due })),
      bills: (D.bills || []).map((b) => ({ no: b.no, supplier: (smap[b.supplier] || {}).name, amount: b.amount, paid: b.paid || 0, cur: b.currency, status: b.status, due: b.due })),
      payments: (D.payments || []).map((p) => ({ kind: p.kind, party: p.party, amount: p.amount, cur: p.currency, date: p.date })),
      products: (D.products || []).map((p) => ({ sku: p.sku, name: p.name, stock: p.stock, reorder: p.reorder, cost: p.cost, price: p.price, cur: p.currency })),
      shipments: (D.shipments || []).map((s) => ({ ref: s.ref, client: (cmap[s.client] || {}).name, status: s.status, costs: s.costs })),
      orders: (D.orders || []).map((o) => ({ ref: o.ref, client: (cmap[o.client] || {}).name, status: o.status, cur: o.currency })),
      payroll: (D.users || []).map((u) => ({ name: u.name, role: u.role, salary: u.salary, cur: u.currency, active: u.active }))
    };
    return [
      "You are the Chief Accountant (CFO) of MERVEKS, a Turkish logistics & trading company (railway freight, food supply, Nano-Z coating distribution).",
      "You have FULL read access to the company books provided below as JSON: sales invoices (accounts receivable), supplier bills (accounts payable), payments (cash in/out), inventory products (with cost & retail price), shipments (with freight/customs/insurance cost breakdowns), sales orders, and payroll (staff salaries).",
      "You are fully equipped to assist with: (1) Recording transactions (money flows, sales, expenses, payroll, bills); (2) Invoice & payment management; (3) Financial reporting (P&L, cash flow, balance sheet estimates); (4) Budgeting & cash runway forecasting; (5) Payroll & benefits tracking; (6) Tax compliance (VAT/KDV liability calculation); (7) Auditing & internal controls (verifying audit logs, checking entry errors); (8) Financial analysis for projects or capital decisions.",
      "Act as a professional chartered accountant: give precise figures, use correct terminology (AR, AP, COGS, gross margin, DSO, working capital, cash flow, runway, VAT, KDV), proactively flag risks and give concrete, actionable recommendations.",
      "Rules: use ONLY the data below — never invent numbers; if something isn't in the data, say so. Amounts are mixed USD/EUR/TRY; the pre-computed KPIs are converted to indicative USD. Keep answers focused (usually under 150 words) and use light Markdown.",
      lang === "tr" ? "IMPORTANT: Always answer in Turkish (Türkçe)." : "Answer in English.",
      "Today is " + new Date().toISOString().slice(0, 10) + ".",
      "COMPANY BOOKS (JSON): " + JSON.stringify(pack)
    ].join("\n");
  }

  /* ---- offline professional-accountant answerer (no key, reads whole company) ---- */
  function offlineAnswer(q, D, F) {
    const lang = (window.UI && UI.getLang) ? UI.getLang() : "en";
    const m = (n) => "$" + Math.round(Number(n || 0)).toLocaleString(lang === "tr" ? "tr-TR" : "en-US");
    const ql = (q || "").toLowerCase();
    const has = (...kw) => kw.some((k) => ql.includes(k));
    const tr = lang === "tr";
    if (has("profit", "margin", "p&l", "pnl", "kâr", "kar", "gross", "brüt")) {
      return tr
        ? "**Kâr-zarar (gösterge):** Gelir " + m(F.revenue) + " − Alımlar " + m(F.purchases) + " − Lojistik " + m(F.logistics) + " = **Brüt kâr " + m(F.grossProfit) + "** (marj **%" + F.grossMargin + "**)."
        : "**P&L (indicative):** Revenue " + m(F.revenue) + " − Purchases " + m(F.purchases) + " − Logistics " + m(F.logistics) + " = **Gross profit " + m(F.grossProfit) + "** (margin **" + F.grossMargin + "%**).";
    }
    if (has("inventory", "stock", "envanter", "stok", "depo")) {
      const low = F.lowStock.map((p) => p.name).slice(0, 4).join(", ");
      return tr
        ? "**Envanter:** maliyet değeri " + m(F.invCost) + ", perakende değeri " + m(F.invRetail) + ". Düşük stok: " + (F.lowStock.length ? F.lowStock.length + " ürün (" + low + ")" : "yok ✓") + "."
        : "**Inventory:** cost value " + m(F.invCost) + ", retail value " + m(F.invRetail) + ". Low stock: " + (F.lowStock.length ? F.lowStock.length + " items (" + low + ")" : "none ✓") + ".";
    }
    if (has("payroll", "salary", "salaries", "wage", "maaş", "bordro", "personel", "çalışan")) {
      return tr
        ? "**Bordro:** aktif " + F.headcount + " çalışan, aylık toplam **" + m(F.monthlyPayroll) + "** (yıllık ≈ " + m(F.monthlyPayroll * 12) + "). Aylık nakit çıkışının en büyük sabit kalemidir."
        : "**Payroll:** " + F.headcount + " active staff, **" + m(F.monthlyPayroll) + "/month** (≈ " + m(F.monthlyPayroll * 12) + "/yr). It's the largest fixed monthly cash outflow.";
    }
    if (has("payable", "supplier", "tedarik", "ödenecek", "ap ")) {
      return tr
        ? "**Borçlar (AP):** " + m(F.ap) + " ödenecek (" + F.apCount + " açık fatura). Nakit planlamasında AR tahsilatını AP vadeleriyle eşleştirin."
        : "**Payables (AP):** " + m(F.ap) + " owed across " + F.apCount + " open bills. Match AR collections to AP due dates for cash planning.";
    }
    if (has("cash", "nakit", "liquid", "likidite", "working capital", "işletme serma")) {
      return tr
        ? "**Nakit:** giriş " + m(F.cashIn) + ", çıkış " + m(F.cashOut) + ", net **" + m(F.cash) + "**. Alacak " + m(F.ar) + " − Borç " + m(F.ap) + " → net işletme sermayesi ≈ **" + m(F.ar - F.ap) + "**."
        : "**Cash:** in " + m(F.cashIn) + ", out " + m(F.cashOut) + ", net **" + m(F.cash) + "**. AR " + m(F.ar) + " − AP " + m(F.ap) + " → net working capital ≈ **" + m(F.ar - F.ap) + "**.";
    }
    if (has("shipment", "freight", "logistic", "sevkiyat", "nakliye", "lojistik")) {
      return tr
        ? "**Lojistik maliyeti:** toplam " + m(F.logistics) + " (navlun+gümrük+sigorta), " + F.activeShip + " aktif sevkiyat. Sipariş gelirine karşı sevkiyat marjını izleyin."
        : "**Logistics cost:** " + m(F.logistics) + " total (freight+customs+insurance) across " + F.activeShip + " active shipments. Watch shipment margin vs order revenue.";
    }
    if (has("order", "pipeline", "backlog", "sipariş", "teklif")) {
      return tr
        ? "**Sipariş hattı:** " + F.openOrders.length + " açık sipariş, değeri **" + m(F.openOrdersValue) + "**, ayrıca " + F.openQuotes + " açık teklif. Bu, gelecek gelirinizdir."
        : "**Order pipeline:** " + F.openOrders.length + " open orders worth **" + m(F.openOrdersValue) + "**, plus " + F.openQuotes + " open quotes — that's your forward revenue.";
    }
    if (has("overdue", "chase", "collect", "gecik", "tahsil", "takip")) {
      if (!F.overdue.length) return tr ? "Vadesi geçmiş fatura yok — alacaklar güncel. ✓" : "No overdue invoices — receivables are current. ✓";
      let t = tr ? "**Önce şunları takip edin:**\n" : "**Chase these first:**\n";
      F.overdue.slice(0, 5).forEach((o) => t += "- **" + o.no + "** — " + o.client + ", " + m(o.amount) + "\n");
      return t;
    }
    if (has("who", "owe", "top", "most", "borç", "müşteri", "en çok", "kim")) {
      let t = tr ? "**En çok bekleyen müşteriler:**\n" : "**Top outstanding by client:**\n";
      F.topDebtors.forEach(([n, v]) => t += "- " + n + " — " + m(v) + "\n");
      return t || (tr ? "Açık bakiye yok." : "No outstanding balances.");
    }
    if (has("risk", "exposure", "kur", "yoğun")) {
      return tr
        ? "**Riskler:** (1) " + F.overdueCount + " vadesi geçmiş fatura (" + m(F.overdueTotal) + "); (2) müşteri yoğunlaşması — en büyük: " + (F.topDebtors[0] ? F.topDebtors[0][0] : "-") + "; (3) USD/EUR kur riski; (4) " + F.lowStock.length + " düşük stok kalemi; (5) aylık bordro " + m(F.monthlyPayroll) + " sabit gideri."
        : "**Risks:** (1) " + F.overdueCount + " overdue invoices (" + m(F.overdueTotal) + "); (2) client concentration — largest: " + (F.topDebtors[0] ? F.topDebtors[0][0] : "-") + "; (3) USD/EUR FX exposure; (4) " + F.lowStock.length + " low-stock items; (5) fixed payroll " + m(F.monthlyPayroll) + "/mo.";
    }
    if (has("forecast", "predict", "next", "tahmin", "gelecek", "project", "runway")) {
      const proj = F.cash + F.ar - F.ap - F.monthlyPayroll;
      return tr
        ? "**Projeksiyon:** net nakit " + m(F.cash) + " + alacak " + m(F.ar) + " − borç " + m(F.ap) + " − 1 ay bordro " + m(F.monthlyPayroll) + " ≈ **" + m(proj) + "**. Gecikmiş " + m(F.overdueTotal) + " tahsil edilmezse düşer."
        : "**Projection:** net cash " + m(F.cash) + " + AR " + m(F.ar) + " − AP " + m(F.ap) + " − 1mo payroll " + m(F.monthlyPayroll) + " ≈ **" + m(proj) + "**. Slips if the " + m(F.overdueTotal) + " overdue isn't collected.";
    }
    if (has("tax", "vat", "kdv", "vergi", "uyum")) {
      return tr
        ? "**Vergi ve KDV Uyumu:** Satışlardan Hesaplanan KDV: " + m(F.vatSales) + ", alımlardan İndirilecek KDV (tahmini %20): " + m(F.vatPurchases) + ". Devlete Ödenecek Net KDV: **" + m(F.netVat) + "**. Beyannamenizi takip eden ayın 26'sına kadar vermeyi unutmayın."
        : "**Tax & VAT (KDV) Compliance:** Accrued Sales VAT: " + m(F.vatSales) + ", Deductible Purchases VAT (est. 20%): " + m(F.vatPurchases) + ". Net VAT Payable is **" + m(F.netVat) + "**. Ensure VAT declaration is filed by the 26th of next month.";
    }
    if (has("audit", "control", "error", "fraud", "trail", "reconcile", "denetim", "hata", "kontrol")) {
      return tr
        ? "**Denetim ve Kontroller:** Sistemde, her işlemi loglayan **" + D.audit.length + "** kayıt içeren değiştirilemez bir İşlem Geçmişi (Audit Trail) bulunur. Giriş yetkileri ve ödemeler faturalarla otomatik eşleştirilerek denetlenir."
        : "**Auditing & Controls:** The system maintains an immutable Activity History ledger (Audit Trail) with **" + D.audit.length + "** entries tracking all actions (logins, creates, edits). Receipts are matched to invoice totals to control for errors.";
    }
    if (has("analysis", "invest", "purchase", "project", "decision", "capex", "analiz", "yatırım", "karar")) {
      return tr
        ? "**Finansal Analiz:** Şirketin brüt marjı **%" + F.grossMargin + "** seviyesindedir. Açık sipariş hacmi: " + F.openOrders.length + " adet (" + m(F.openOrdersValue) + "). " + m(F.ar) + " tutarındaki alacaklar tahsil edilene kadar büyük CapEx yatırımlarının ertelenmesi önerilir."
        : "**Financial Analysis:** Gross margin is **" + F.grossMargin + "%** with a backlog of " + F.openOrders.length + " open orders valued at " + m(F.openOrdersValue) + ". Suggest postponing major capital expenditures (CapEx) until the outstanding " + m(F.ar) + " AR is collected.";
    }
    if (has("help", "what can", "yardım", "ne yap", "nasıl")) {
      return tr
        ? "Şirketin tüm defterlerini okuyabilirim. Sorabilecekleriniz: **kâr/zarar**, **nakit & işletme sermayesi**, **envanter değeri**, **bordro**, **borçlar (AP)**, **alacaklar (AR) & takip**, **sipariş hattı**, **lojistik maliyeti**, **riskler**, **nakit projeksiyonu**, **KDV/Vergi uyumu**, **denetim & kontroller**, **yatırım analizi**."
        : "I read the whole company's books. Ask about **P&L**, **cash & working capital**, **inventory value**, **payroll**, **payables (AP)**, **receivables (AR) & collections**, **order pipeline**, **logistics cost**, **risks**, **cash projection**, **tax/VAT compliance**, **auditing & controls**, or **financial/CapEx analysis**.";
    }
    return tr
      ? "**Genel mali durum:** Gelir " + m(F.revenue) + ", brüt kâr " + m(F.grossProfit) + " (%" + F.grossMargin + "), alacak " + m(F.ar) + ", borç " + m(F.ap) + ", net nakit " + m(F.cash) + ", envanter " + m(F.invCost) + ", aylık bordro " + m(F.monthlyPayroll) + ". Kâr, nakit, envanter, bordro veya riskleri sorabilirsiniz."
      : "**Financial snapshot:** Revenue " + m(F.revenue) + ", gross profit " + m(F.grossProfit) + " (" + F.grossMargin + "%), AR " + m(F.ar) + ", AP " + m(F.ap) + ", net cash " + m(F.cash) + ", inventory " + m(F.invCost) + ", payroll " + m(F.monthlyPayroll) + "/mo. Ask me about profit, cash, inventory, payroll or risks.";
  }

  /* ---- public: conversational chat turn (reads the whole company) ---- */
  async function chat(opts) {
    const history = opts.history || [], question = opts.question;
    const D = await companyData();
    const F = computeFinancials(D);
    if (liveAI()) {
      try {
        const lang = (window.UI && UI.getLang) ? UI.getLang() : "en";
        const contents = [
          { role: "user", parts: [{ text: buildCompanyContext(D, F) }] },
          { role: "model", parts: [{ text: lang === "tr" ? "Anlaşıldı. Şirketin tüm defterlerine erişiyorum ve baş muhasebeci olarak yanıtlayacağım." : "Understood. I have access to the full company books and will answer as your chief accountant." }] }
        ];
        history.forEach((mm) => contents.push({ role: mm.role === "assistant" ? "model" : "user", parts: [{ text: mm.text }] }));
        contents.push({ role: "user", parts: [{ text: question }] });
        const text = await callGeminiContents(contents);
        return { source: "gemini", text };
      } catch (e) { return { source: "offline", error: e.message, text: offlineAnswer(question, D, F) }; }
    }
    return { source: "offline", text: offlineAnswer(question, D, F) };
  }

  /* ---- strip Markdown for text-to-speech ---- */
  function strip(md) { return (md || "").replace(/[#*_`>]/g, " ").replace(/^[\s-]+/gm, "").replace(/\s+/g, " ").trim(); }

  /* ---- minimal Markdown → HTML for rendering results ---- */
  function render(md) {
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const lines = esc(md).split("\n");
    let html = "", inList = false;
    const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    lines.forEach((ln) => {
      if (/^##\s+/.test(ln)) { if (inList) { html += "</ul>"; inList = false; } html += "<h4 class='ai-h'>" + inline(ln.replace(/^##\s+/, "")) + "</h4>"; }
      else if (/^\d+\.\s+/.test(ln)) { if (!inList) { html += "<ul class='ai-ol'>"; inList = true; } html += "<li>" + inline(ln.replace(/^\d+\.\s+/, "")) + "</li>"; }
      else if (/^[-*]\s+/.test(ln)) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + inline(ln.replace(/^[-*]\s+/, "")) + "</li>"; }
      else { if (inList) { html += "</ul>"; inList = false; } if (ln.trim()) html += "<p>" + inline(ln) + "</p>"; }
    });
    if (inList) html += "</ul>";
    return html;
  }

  return { getKey, setKey, hasKey, model, analyzeFinance, analyzeInvoice, chat, render, strip, summarize };
})();
