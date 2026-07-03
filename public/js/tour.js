/* =================================================================
   MERVEKS SAP — guided onboarding tour (role-aware, self-navigating)
   Runs the first time an employee signs in (once per user) and can be
   replayed from the "?" button. The tour is tailored to the signed-in
   role — the Owner gets the full "you control everything" walkthrough,
   each employee gets a tour scoped to what they can actually access.
   As it goes, it OPENS each page itself so people see the real screen.
   Bilingual: TR / EN / RU.
   ================================================================= */
window.Tour = (function () {
  const KEY = (uid) => "sap_tour_v1_" + (uid || "anon");
  const lang = () => (window.UI && UI.getLang ? UI.getLang() : "tr");
  const L = (o) => o[lang()] || o.en;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const NARROW = () => window.innerWidth <= 880;

  /* every page that can appear in the tour, in a natural walking order.
     Each is shown only if the current role may view it. */
  const PAGES = [
    { id: "mywork", t: { tr: "İşlerim", en: "My Work", ru: "Мои задачи" },
      b: { tr: "Her gün buradan başla — görevlerin, sana devredilen işler ve acil olan her şey.", en: "Start here every day — your tasks, handoffs and anything urgent.", ru: "Начинайте отсюда каждый день — задачи, передачи и всё срочное." } },
    { id: "dashboard", t: { tr: "Panel", en: "Dashboard", ru: "Панель" },
      b: { tr: "İşletmenin canlı özeti: sevkiyatlar, siparişler ve nakit bir bakışta.", en: "A live snapshot of the business: shipments, orders and cash at a glance.", ru: "Живой обзор бизнеса: отгрузки, заказы и деньги." } },
    { id: "quotes", t: { tr: "Teklifler", en: "Quotations", ru: "Предложения" },
      b: { tr: "Fiyat tekliflerini hazırla ve gönder; kabul edilince otomatik siparişe dönüşür.", en: "Build and send price offers; accepted ones turn into orders automatically.", ru: "Создавайте предложения; принятые автоматически становятся заказами." } },
    { id: "orders", t: { tr: "Siparişler", en: "Orders", ru: "Заказы" },
      b: { tr: "Onaylanan satışlar burada — sevkiyat ve fatura buradan başlar.", en: "Confirmed sales live here — shipments and invoices start from here.", ru: "Подтверждённые продажи здесь — отсюда начинаются отгрузки и счета." } },
    { id: "clients", t: { tr: "Müşteriler", en: "Clients", ru: "Клиенты" },
      b: { tr: "Müşteri hesapları, iletişim bilgileri ve ödeme vadeleri.", en: "Customer accounts, contacts and payment terms.", ru: "Клиенты, контакты и условия оплаты." } },
    { id: "shipments", t: { tr: "Sevkiyatlar", en: "Shipments", ru: "Отгрузки" },
      b: { tr: "Yük hareketlerini takip et: demiryolu, karayolu ve deniz.", en: "Track freight in motion: rail, road and sea.", ru: "Отслеживайте грузы в пути: ж/д, авто и море." } },
    { id: "inventory", t: { tr: "Envanter", en: "Inventory", ru: "Склад" },
      b: { tr: "Stok seviyeleri ve ürünler; kritik stok burada uyarır.", en: "Stock levels and products; low stock is flagged here.", ru: "Остатки и товары; низкий запас отмечается здесь." } },
    { id: "purchasing", t: { tr: "Satın Alma", en: "Purchasing", ru: "Закупки" },
      b: { tr: "Tedarikçi siparişlerini ve faturalarını yönet.", en: "Manage purchase orders and supplier bills.", ru: "Управляйте заказами поставщикам и счетами." } },
    { id: "suppliers", t: { tr: "Tedarikçiler", en: "Suppliers", ru: "Поставщики" },
      b: { tr: "Tedarik ortakların ve performansları.", en: "Your procurement partners and their performance.", ru: "Ваши поставщики и их показатели." } },
    { id: "finance", t: { tr: "Finans", en: "Finance", ru: "Финансы" },
      b: { tr: "Faturalar, tahsilatlar ve ödemeler tek yerde.", en: "Invoices, collections and payments in one place.", ru: "Счета, поступления и платежи в одном месте." } },
    { id: "accounting", t: { tr: "Muhasebe", en: "Accounting", ru: "Бухгалтерия" },
      b: { tr: "Alacaklar, borçlar, nakit ve kâr-zarar — ve yapay zeka muhasebeci.", en: "Receivables, payables, cash and P&L — plus your AI accountant.", ru: "Дебиторка, кредиторка, деньги и P&L — и ИИ-бухгалтер." } },
    { id: "users", t: { tr: "Ekip ve Hesaplar", en: "Team & Accounts", ru: "Команда и аккаунты" },
      b: { tr: "Çalışan hesaplarını, rolleri ve erişim yetkilerini yönet.", en: "Manage employee accounts, roles and their access.", ru: "Управляйте аккаунтами сотрудников, ролями и доступом." } }
  ];

  function intro(role, first) {
    if (role === "Owner") return { tr: "Selam " + first + " 👑 — sen Kurucusun. Her şeyi görür ve yönetirsin: satış, operasyon, finans ve tüm ekip. Hadi her yeri gezelim.",
      en: "Hey " + first + " 👑 — you're the Owner. You can see and control everything: sales, operations, finance and your whole team. Let me show you around.",
      ru: "Привет, " + first + " 👑 — вы Владелец. Вы видите и контролируете всё: продажи, операции, финансы и команду. Давайте всё покажу." };
    if (role === "Operations Manager") return { tr: "Merhaba " + first + " — işleri sen yürütürsün. Teklifler, siparişler, sevkiyatlar, stok ve satın alma senin alanın.",
      en: "Hi " + first + " — you keep things moving. Quotes, orders, shipments, stock and purchasing are your world.",
      ru: "Привет, " + first + " — вы держите всё в движении: заявки, заказы, отгрузки, склад и закупки." };
    if (role === "Finance Officer") return { tr: "Merhaba " + first + " — para tarafı sende. Faturalar, tahsilatlar ve müşteri hesapları.",
      en: "Hi " + first + " — you own the money side: invoices, collections and client accounts.",
      ru: "Привет, " + first + " — за вами финансы: счета, поступления и клиенты." };
    return { tr: "Merhaba " + first + " — satışı sen büyütürsün: teklifler, siparişler, müşteriler ve kurduğun sevkiyatlar.",
      en: "Hi " + first + " — you drive sales: quotes, orders, clients and the shipments you set up.",
      ru: "Привет, " + first + " — вы развиваете продажи: предложения, заказы, клиенты и отгрузки." };
  }

  function steps() {
    const u = (window.Auth && Auth.current()) || {};
    const first = (u.name || "").split(" ")[0] || "";
    const allow = (id) => id === "mywork" || (window.Auth && Auth.can(id, "view"));

    const out = [{ sel: null, t: L({ tr: "Hoş geldin!", en: "Welcome!", ru: "Добро пожаловать!" }), b: L(intro(u.role, first)) }];

    PAGES.filter((p) => allow(p.id)).forEach((p) =>
      out.push({ sel: '.sb-link[data-nav="' + p.id + '"]', nav: "#/" + p.id, t: L(p.t), b: L(p.b) }));

    out.push({ sel: "#notifWrap", t: L({ tr: "Bildirimler", en: "Notifications", ru: "Уведомления" }),
      b: L({ tr: "Sana iş atandığında veya senden bahsedildiğinde burada belirir.", en: "When work is assigned to you or someone mentions you, it shows up here.", ru: "Когда вам назначают работу или упоминают вас, это появится здесь." }) });

    const finishB = u.role === "Owner"
      ? { tr: "Hepsi bu! Her şey senin kontrolünde. Dili sağ üstten değiştir, bu turu ? düğmesiyle tekrar izle.", en: "That's it — it's all under your control. Switch language top-right, replay this tour anytime with the ? button.", ru: "Вот и всё — всё под вашим контролем. Язык справа вверху, повтор тура — кнопкой ?." }
      : { tr: "Hazırsın! Güne “İşlerim”den başla. Bu turu istediğin an ? düğmesiyle tekrar izleyebilirsin.", en: "You're ready! Start your day from My Work. Replay this tour anytime with the ? button.", ru: "Готово! Начинайте день с «Моих задач». Повтор тура — кнопкой ?." };
    out.push({ sel: null, nav: "#/mywork", t: L({ tr: "Hazırsın 🎉", en: "You're all set 🎉", ru: "Готово 🎉" }), b: L(finishB), finish: true });
    return out;
  }

  let idx = 0, list = [], spot = null, pop = null, onResize = null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  function openSidebar(open) {
    const sb = document.getElementById("sidebar"), bd = document.getElementById("sbBackdrop");
    if (!sb) return;
    if (open && NARROW()) { sb.classList.add("open"); if (bd) bd.classList.add("open"); }
    else if (!open) { sb.classList.remove("open"); if (bd) bd.classList.remove("open"); }
  }

  function buildEls() {
    spot = document.createElement("div"); spot.className = "tour-spot";
    pop = document.createElement("div"); pop.className = "tour-pop";
    document.body.appendChild(spot); document.body.appendChild(pop);
    onResize = () => render();
    window.addEventListener("resize", onResize);
  }

  function teardown(done) {
    openSidebar(false);
    if (spot) spot.remove(); if (pop) pop.remove(); spot = pop = null;
    if (onResize) window.removeEventListener("resize", onResize);
    const u = (window.Auth && Auth.current()) || {};
    if (done) localStorage.setItem(KEY(u.id), "1");
  }

  // navigate (if the step opens a page) then render the spotlight
  async function go(i) {
    idx = i; const s = list[idx]; if (!s) return;
    if (s.sel && s.sel.indexOf(".sb-link") === 0) openSidebar(true);   // reveal the menu so the link is visible
    if (s.nav && location.hash !== s.nav) {
      if (window.App) location.hash = s.nav; else location.hash = s.nav;
      await wait(430);                                                 // let the page paint
    }
    render();
  }

  function render() {
    const s = list[idx]; if (!s || !pop) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const el = s.sel ? document.querySelector(s.sel) : null;
    const visible = el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
    const last = idx === list.length - 1;

    const dots = list.map((_, i) => '<i class="' + (i === idx ? "on" : "") + '"></i>').join("");
    pop.innerHTML =
      '<div class="tour-step">' + (idx + 1) + " / " + list.length + "</div>" +
      '<h4 class="tour-title">' + s.t + "</h4>" +
      '<p class="tour-body">' + s.b + "</p>" +
      '<div class="tour-dots">' + dots + "</div>" +
      '<div class="tour-btns">' +
        (last ? "" : '<button class="btn btn-ghost btn-sm" data-skip>' + L({ tr: "Atla", en: "Skip", ru: "Пропустить" }) + "</button>") +
        '<span class="grow"></span>' +
        (idx > 0 ? '<button class="btn btn-ghost btn-sm" data-back>' + L({ tr: "Geri", en: "Back", ru: "Назад" }) + "</button>" : "") +
        '<button class="btn btn-primary btn-sm" data-next>' + (last ? L({ tr: "Başla", en: "Got it", ru: "Понятно" }) : L({ tr: "İleri", en: "Next", ru: "Далее" })) + "</button>" +
      "</div>";

    pop.querySelector("[data-next]").onclick = () => { if (last) { teardown(true); location.hash = "#/mywork"; } else { go(idx + 1); } };
    const back = pop.querySelector("[data-back]"); if (back) back.onclick = () => go(idx - 1);
    const skip = pop.querySelector("[data-skip]"); if (skip) skip.onclick = () => teardown(true);

    const pw = pop.offsetWidth, ph = pop.offsetHeight, PAD = 6;
    if (visible) {
      const r = el.getBoundingClientRect();
      spot.style.display = "block";
      spot.style.top = (r.top - PAD) + "px"; spot.style.left = (r.left - PAD) + "px";
      spot.style.width = (r.width + PAD * 2) + "px"; spot.style.height = (r.height + PAD * 2) + "px";
      let top, left;
      if (r.left < vw * 0.33 && vw > 720) { left = r.right + 16; top = clamp(r.top, 12, vh - ph - 12); }
      else if (r.bottom + ph + 18 < vh) { top = r.bottom + 12; left = clamp(r.left, 12, vw - pw - 12); }
      else { top = clamp(r.top - ph - 12, 12, vh - ph - 12); left = clamp(r.right - pw, 12, vw - pw - 12); }
      pop.style.top = top + "px"; pop.style.left = left + "px";
    } else {
      spot.style.display = "block";
      spot.style.width = spot.style.height = "0px";
      spot.style.top = (vh / 2) + "px"; spot.style.left = (vw / 2) + "px";
      pop.style.top = clamp((vh - ph) / 2, 12, vh - ph - 12) + "px";
      pop.style.left = ((vw - pw) / 2) + "px";
    }
  }

  function start() {
    if (pop) teardown(false);
    list = steps(); buildEls(); go(0);
  }

  function maybeStart() {
    const u = (window.Auth && Auth.current()) || {};
    if (!u.id || localStorage.getItem(KEY(u.id))) return;
    setTimeout(start, 700);
  }

  return { start, maybeStart };
})();
