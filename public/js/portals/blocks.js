/* =================================================================
   WeboCloud Portal Engine — Block Library
   -----------------------------------------------------------------
   Registry of reusable, editable "block" types. Each entry declares:
     - label / category    → shown in the editor's "+ Add Block" picker
     - defaultProps         → seeded when a block is added fresh
     - schema               → drives the editor's auto-generated
                               property form (see live-editor.js)
     - render(props, ctx)   → returns the block's HTML string

   `render` is the single source of truth for what a block looks like —
   both the live storefront and the editor's canvas call it, so there
   is never a case where what the editor shows differs from what gets
   published (the bug this whole engine replaces).

   ctx passed to render(): { blockId, products, pages, esc }
   ================================================================= */
(function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function emphasize(text) {
    return esc(text).replace(/\*(.*?)\*/g, "<em>$1</em>");
  }

  /* ---- shared button rendering (hero CTA buttons, rfq submit, etc.) ----
     Actions are dispatched through window.PortalGB (defined in
     generic-renderer.js) rather than window.Portal, since these scripts
     load BEFORE portal.js — which is what defines window.Portal — and
     the onclick string is only evaluated later, at click time, but we
     still don't want a hard load-order dependency on Portal existing. */
  function renderButton(btn, cls) {
    const label = esc(btn.label || "Button");
    const onclick = "PortalGB.runBlockAction(" + JSON.stringify(btn.action || "none") + "," + JSON.stringify(btn.target || "") + ")";
    return '<button class="' + cls + '" data-btn-id="' + esc(btn.id || "") + '" onclick=\'' + onclick + '\'>' + label + '</button>';
  }

  /* ---- editable-field annotation --------------------------------
     `ed("title")` stamps ` data-edit="title"` onto the element a prop
     renders into. That one attribute is what lets the live editor be
     generic: it can turn ANY annotated text node into click-to-type
     and ANY annotated image into click-to-upload without knowing a
     thing about the block it lives in. Paths use dots for nesting and
     the item index for lists — e.g. "slides.2.title".

     Unannotated output still works exactly as before; it just stays
     panel-only. So this can be rolled out block by block.
     ---------------------------------------------------------------- */
  const ed = (path) => ' data-edit="' + path + '"';
  window.PortalEdAttr = ed;

  const PortalBlocks = {};

  /* ---------------------------------------------------------------- */
  PortalBlocks.topbar = {
    label: "Top Announcement Bar", category: "Header",
    defaultProps: { message: "Free shipping on orders over $50", ctaLabel: "", ctaAction: "none", ctaTarget: "" },
    schema: [
      { key: "message", label: "Message", type: "text" },
      { key: "ctaLabel", label: "Button label (optional)", type: "text" },
      { key: "ctaAction", label: "Button action", type: "action-select" },
      { key: "ctaTarget", label: "Action target", type: "action-target" }
    ],
    render(props, ctx) {
      const cta = props.ctaLabel
        ? renderButton({ label: props.ctaLabel, action: props.ctaAction, target: props.ctaTarget }, "gb-topbar-cta")
        : "";
      return '<div class="gb-topbar" data-block-id="' + ctx.blockId + '"><span' + ed("message") + ">" + esc(props.message || "") + "</span>" + cta + "</div>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks.hero = {
    label: "Hero Banner", category: "Header",
    defaultProps: { eyebrow: "", eyebrowStyle: "text", title: "Welcome to *Our Store*", subtitle: "", bgImage: "", align: "center", accentColor: "", titleGradient: "", buttons: [] },
    schema: [
      { key: "eyebrow", label: "Eyebrow tag", type: "text" },
      { key: "eyebrowStyle", label: "Eyebrow style", type: "select", options: ["text", "badge"] },
      { key: "title", label: "Title (use *word* for accent)", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "textarea" },
      { key: "bgImage", label: "Background image", type: "image" },
      { key: "align", label: "Alignment", type: "select", options: ["left", "center"] },
      { key: "accentColor", label: "Accent Color (*word* highlight)", type: "color" },
      { key: "titleGradient", label: "Accent Gradient End (optional 2nd color)", type: "color" },
      { key: "buttons", label: "Buttons", type: "list", itemSchema: [
        { key: "label", label: "Label", type: "text" },
        { key: "action", label: "Action", type: "action-select" },
        { key: "target", label: "Action target", type: "action-target" }
      ] }
    ],
    render(props, ctx) {
      const bg = props.bgImage ? '<div class="gb-hero-bg-img"><img src="' + esc(props.bgImage) + '" alt=""' + ed("bgImage") + ' /></div>' : "";
      const buttons = (props.buttons || []).map((b, i) =>
        renderButton(b, "gb-hero-btn " + (i === 0 ? "gb-hero-btn-primary" : "gb-hero-btn-outline"))
      ).join("");
      const accentStyle = (props.accentColor ? "--gb-hero-accent:" + esc(props.accentColor) + ";" : "") +
        (props.titleGradient ? "--gb-hero-accent2:" + esc(props.titleGradient) + ";" : "");
      const eyebrowCls = props.eyebrowStyle === "badge" ? "gb-hero-badge" : "gb-hero-eyebrow";
      const gradientCls = props.titleGradient ? " gb-has-gradient" : "";
      return '<section class="portal-section gb-hero gb-align-' + (props.align || "center") + gradientCls + '" data-block-id="' + ctx.blockId + '"' + (accentStyle ? ' style="' + accentStyle + '"' : "") + '>' +
        bg +
        '<div class="gb-hero-inner">' +
          (props.eyebrow ? '<div class="' + eyebrowCls + '"' + ed("eyebrow") + ">" + esc(props.eyebrow) + "</div>" : "") +
          '<h1 class="gb-hero-title"' + ed("title") + ">" + emphasize(props.title || "") + "</h1>" +
          (props.subtitle ? '<p class="gb-hero-sub"' + ed("subtitle") + ">" + esc(props.subtitle) + "</p>" : "") +
          (buttons ? '<div class="gb-hero-actions">' + buttons + "</div>" : "") +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks.stats = {
    label: "Stats Strip", category: "Content",
    defaultProps: { items: [{ value: "100+", label: "Happy clients" }], accentColor: "" },
    schema: [
      { key: "items", label: "Stats", type: "list", itemSchema: [{ key: "value", label: "Value", type: "text" }, { key: "label", label: "Label", type: "text" }] },
      { key: "accentColor", label: "Number Color", type: "color" }
    ],
    render(props, ctx) {
      const valueStyle = props.accentColor ? ' style="color:' + esc(props.accentColor) + '"' : "";
      return '<section class="portal-section gb-stats" data-block-id="' + ctx.blockId + '">' +
        (props.items || []).map((s, i) => '<div class="gb-stat-box"><div class="gb-stat-value"' + valueStyle + ed("items." + i + ".value") + '>' + esc(s.value) + '</div><div class="gb-stat-label"' + ed("items." + i + ".label") + '>' + esc(s.label) + "</div></div>").join("") +
        "</section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["brand-wall"] = {
    label: "Brand / Trust Wall", category: "Content",
    defaultProps: { items: ["Partner One", "Partner Two", "Partner Three"] },
    schema: [{ key: "items", label: "Names", type: "list", itemSchema: [{ key: "value", label: "Name", type: "text" }] }],
    render(props, ctx) {
      const items = (props.items || []).map((it) => typeof it === "string" ? it : it.value);
      return '<section class="portal-section gb-brand-wall" data-block-id="' + ctx.blockId + '">' +
        items.map((n) => '<span class="gb-brand-item">' + esc(n) + "</span>").join("") +
        "</section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["card-grid"] = {
    label: "Card Grid (capabilities / departments)", category: "Content",
    defaultProps: { title: "Section Title", subtitle: "", columns: 3, items: [{ icon: "⭐", title: "Card title", tag: "", desc: "Card description" }] },
    schema: [
      { key: "title", label: "Section title", type: "text" },
      { key: "subtitle", label: "Eyebrow / subtitle", type: "text" },
      { key: "columns", label: "Columns", type: "number", min: 2, max: 5 },
      { key: "items", label: "Cards", type: "list", itemSchema: [
        { key: "icon", label: "Icon / emoji", type: "text" },
        { key: "title", label: "Title", type: "text" },
        { key: "tag", label: "Tag", type: "text" },
        { key: "desc", label: "Description", type: "textarea" },
        { key: "color", label: "Accent Color", type: "color" }
      ] }
    ],
    render(props, ctx) {
      return '<section class="portal-section" data-block-id="' + ctx.blockId + '">' +
        '<div class="section-head">' +
          (props.subtitle ? '<div class="section-eyebrow"' + ed("subtitle") + '>' + esc(props.subtitle) + "</div>" : "") +
          (props.title ? '<div class="section-title"' + ed("title") + '>' + esc(props.title) + "</div>" : "") +
        "</div>" +
        '<div class="gb-card-grid" style="--gb-cols:' + (Number(props.columns) || 3) + '">' +
          (props.items || []).map((c, i) => {
            const ip = "items." + i + ".";
            return '<div class="gb-card"' + (c.color ? ' style="border-top:3px solid ' + esc(c.color) + '"' : '') + '>' +
              (c.icon ? '<div class="gb-card-icon"' + (c.color ? ' style="color:' + esc(c.color) + '"' : '') + ed(ip + "icon") + '>' + esc(c.icon) + "</div>" : "") +
              (c.tag ? '<span class="gb-card-tag"' + (c.color ? ' style="color:' + esc(c.color) + '"' : '') + ed(ip + "tag") + '>' + esc(c.tag) + "</span>" : "") +
              '<div class="gb-card-title"' + ed(ip + "title") + '>' + esc(c.title) + "</div>" +
              (c.desc ? '<div class="gb-card-desc"' + ed(ip + "desc") + '>' + esc(c.desc) + "</div>" : "") +
            "</div>";
          }).join("") +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["editorial-grid"] = {
    label: "Editorial / Lookbook Grid", category: "Content",
    defaultProps: { title: "Editorial", subtitle: "", items: [{ tag: "CAPSULE 01", title: "Collection name", linkLabel: "Explore", image: "" }] },
    schema: [
      { key: "title", label: "Section title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "text" },
      { key: "items", label: "Cards", type: "list", itemSchema: [
        { key: "image", label: "Image", type: "image" },
        { key: "tag", label: "Tag", type: "text" },
        { key: "title", label: "Title", type: "text" },
        { key: "linkLabel", label: "Link label", type: "text" }
      ] }
    ],
    render(props, ctx) {
      return '<section class="portal-section gb-editorial" data-block-id="' + ctx.blockId + '">' +
        '<div class="section-head">' +
          (props.title ? '<div class="section-title"' + ed("title") + '>' + esc(props.title) + "</div>" : "") +
          (props.subtitle ? '<div class="section-sub"' + ed("subtitle") + '>' + esc(props.subtitle) + "</div>" : "") +
        "</div>" +
        '<div class="gb-editorial-grid">' +
          (props.items || []).map((it, i) => {
            const ip = "items." + i + ".";
            return '<div class="gb-editorial-card">' +
              '<img src="' + esc(it.image || "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800&q=80") + '" alt="' + esc(it.title || "") + '"' + ed(ip + "image") + '>' +
              '<div class="gb-editorial-info">' +
                (it.tag ? '<div class="gb-editorial-tag"' + ed(ip + "tag") + '>' + esc(it.tag) + "</div>" : "") +
                '<h3 class="gb-editorial-title"' + ed(ip + "title") + '>' + esc(it.title) + "</h3>" +
                (it.linkLabel ? '<div class="gb-editorial-link"' + ed(ip + "linkLabel") + '>' + esc(it.linkLabel) + " →</div>" : "") +
              "</div>" +
            "</div>";
          }).join("") +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["product-grid"] = {
    label: "Product / Service Grid", category: "Commerce",
    defaultProps: { title: "Our Products", subtitle: "", showCatBar: true, limit: 0, ctaLabel: "", ctaAction: "none", ctaTarget: "" },
    schema: [
      { key: "title", label: "Section title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "text" },
      { key: "showCatBar", label: "Show category filter bar", type: "boolean" },
      { key: "limit", label: "Max items to show (0 = all)", type: "number", min: 0, max: 60 },
      { key: "ctaLabel", label: "Button under grid (optional)", type: "text" },
      { key: "ctaAction", label: "Button action", type: "action-select" },
      { key: "ctaTarget", label: "Action target", type: "action-target" }
    ],
    render(props, ctx) {
      const all = ctx.products || [];
      // A "featured" grid on the home page shows a capped preview and sends
      // shoppers to the full products page; the products page itself uses
      // limit 0 and renders everything.
      const limit = Number(props.limit) || 0;
      const products = limit > 0 ? all.slice(0, limit) : all;
      // The category bar re-renders the whole grid on click (portal.js →
      // bindCatBar), which would blow past a limit — so it's only offered
      // on unlimited grids.
      const withCatBar = props.showCatBar !== false && limit === 0;
      const cta = props.ctaLabel
        ? '<div class="gb-grid-cta">' + renderButton({ label: props.ctaLabel, action: props.ctaAction, target: props.ctaTarget }, "gb-hero-btn gb-hero-btn-solid") + "</div>"
        : "";
      // An explicitly blank title means "no heading here" — used by the
      // generated products page, where the page hero already names it.
      const title = props.title === undefined ? "Our Products" : props.title;
      const head = (title || props.subtitle)
        ? '<div class="section-head"><div>' +
            (title ? '<div class="section-title">' + esc(title) + "</div>" : "") +
            (props.subtitle ? '<div class="section-sub"' + ed("subtitle") + '>' + esc(props.subtitle) + "</div>" : "") +
          "</div></div>"
        : "";
      // data-le-no-eject: the grid's cards are wired up by JS after render
      // (bindProductCards → product modal → add to cart). Letting the editor
      // "eject" it into free-floating canvas pieces would replay them as
      // inert HTML — i.e. silently delete the shop. Move it as a whole block
      // instead; its contents come from the product catalogue, not layout.
      return '<section class="portal-section" id="productGridSection" data-le-no-eject="true" data-block-id="' + ctx.blockId + '">' + head +
        (withCatBar && window.buildCatBar ? window.buildCatBar(all) : "") +
        '<div class="product-grid" id="productGrid">' +
          products.map((p, i) => (window.productCard ? window.productCard(p, i) : "")).join("") +
        "</div>" + cta + "</section>";
    },
    afterRender() {
      if (window.buildCategories) window.buildCategories((window.PortalState || {}).products || []);
      if (window.bindCatBar) window.bindCatBar();
      if (window.bindProductCards) window.bindProductCards();
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks.calculator = {
    label: "Interactive Estimator", category: "Interactive",
    defaultProps: { title: "Estimate Your Project", subtitle: "" },
    schema: [
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Eyebrow", type: "text" }
    ],
    render(props, ctx) {
      const id = ctx.blockId;
      return '<section class="portal-section" data-block-id="' + id + '">' +
        '<div class="gb-calc" data-le-widget="true">' +
          '<div>' +
            (props.subtitle ? '<div class="section-eyebrow" style="color:#38bdf8">' + esc(props.subtitle) + "</div>" : "") +
            '<div class="section-title" style="color:#fff">' + esc(props.title || "Estimate Your Project") + "</div>" +
            '<div class="gb-calc-form">' +
              '<div class="gb-calc-field"><label>Scope</label><select id="calc_' + id + '_area" onchange="PortalGB.runCalculator(\'' + id + '\')"><option value="1">Standard</option><option value="1.4">Expanded</option><option value="2.2">Enterprise</option></select></div>' +
              '<div class="gb-calc-field"><label>Team size</label><select id="calc_' + id + '_team" onchange="PortalGB.runCalculator(\'' + id + '\')"><option value="3">Small (3)</option><option value="6">Medium (6)</option><option value="10">Large (10)</option></select></div>' +
              '<div class="gb-calc-field"><label>Duration</label><select id="calc_' + id + '_weeks" onchange="PortalGB.runCalculator(\'' + id + '\')"><option value="4">4 weeks</option><option value="12">12 weeks</option><option value="26">26 weeks</option></select></div>' +
            "</div>" +
          "</div>" +
          '<div class="gb-calc-result">' +
            "<h3>Projected Scope</h3>" +
            '<div class="gb-calc-row"><span>Team allocation</span><strong id="calc_' + id + '_resTeam">3 specialists</strong></div>' +
            '<div class="gb-calc-row"><span>Duration</span><strong id="calc_' + id + '_resWeeks">4 weeks</strong></div>' +
            '<div class="gb-calc-row"><span>Estimated fee</span><strong class="gb-calc-price" id="calc_' + id + '_resPrice">$12,000</strong></div>' +
          "</div>" +
        "</div></section>";
    },
    afterRender(props, ctx) { if (window.PortalGB && window.PortalGB.runCalculator) window.PortalGB.runCalculator(ctx.blockId); }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["case-studies"] = {
    label: "Case Studies", category: "Social proof",
    defaultProps: { title: "Case Studies", subtitle: "", accentColor: "", items: [{ metric: "+30% growth", client: "Client name", tags: "", title: "Project title", desc: "Short outcome description." }] },
    schema: [
      { key: "title", label: "Section title", type: "text" },
      { key: "subtitle", label: "Eyebrow", type: "text" },
      { key: "accentColor", label: "Metric Color", type: "color" },
      { key: "items", label: "Case studies", type: "list", itemSchema: [
        { key: "metric", label: "Headline metric", type: "text" },
        { key: "client", label: "Client", type: "text" },
        { key: "tags", label: "Location / tags", type: "text" },
        { key: "title", label: "Title", type: "text" },
        { key: "desc", label: "Description", type: "textarea" }
      ] }
    ],
    render(props, ctx) {
      const metricStyle = props.accentColor ? ' style="color:' + esc(props.accentColor) + '"' : "";
      return '<section class="portal-section" data-block-id="' + ctx.blockId + '">' +
        '<div class="section-head" style="text-align:center;justify-content:center">' +
          (props.subtitle ? '<div class="section-eyebrow"' + ed("subtitle") + '>' + esc(props.subtitle) + "</div>" : "") +
          '<div class="section-title"' + ed("title") + '>' + esc(props.title || "Case Studies") + "</div>" +
        "</div>" +
        '<div class="gb-cases-grid">' +
          (props.items || []).map((c) =>
            '<div class="gb-case-card">' +
              '<div class="gb-case-metric"' + metricStyle + '>' + esc(c.metric) + "</div>" +
              '<div class="gb-case-meta"><span>' + esc(c.client) + "</span><span>" + esc(c.tags) + "</span></div>" +
              '<div class="gb-case-title">' + esc(c.title) + "</div>" +
              '<div class="gb-case-desc">' + esc(c.desc) + "</div>" +
            "</div>"
          ).join("") +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["partner-grid"] = {
    label: "Team / Partner Showcase", category: "Social proof",
    defaultProps: { title: "Our Team", subtitle: "", accentColor: "", items: [{ name: "Name", role: "Role", img: "", bio: "Short bio." }] },
    schema: [
      { key: "title", label: "Section title", type: "text" },
      { key: "subtitle", label: "Eyebrow", type: "text" },
      { key: "accentColor", label: "Role Text Color", type: "color" },
      { key: "items", label: "People", type: "list", itemSchema: [
        { key: "name", label: "Name", type: "text" },
        { key: "role", label: "Role", type: "text" },
        { key: "img", label: "Photo", type: "image" },
        { key: "bio", label: "Bio", type: "textarea" }
      ] }
    ],
    render(props, ctx) {
      const roleStyle = props.accentColor ? ' style="color:' + esc(props.accentColor) + '"' : "";
      return '<section class="portal-section" data-block-id="' + ctx.blockId + '">' +
        '<div class="section-head" style="text-align:center;justify-content:center">' +
          (props.subtitle ? '<div class="section-eyebrow"' + ed("subtitle") + '>' + esc(props.subtitle) + "</div>" : "") +
          '<div class="section-title"' + ed("title") + '>' + esc(props.title || "Our Team") + "</div>" +
        "</div>" +
        '<div class="gb-partners-grid">' +
          (props.items || []).map((p) =>
            '<div class="gb-partner-card">' +
              '<div class="gb-partner-img"><img src="' + esc(p.img || "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?w=400&q=80") + '" alt="' + esc(p.name) + '" /></div>' +
              '<div class="gb-partner-name">' + esc(p.name) + "</div>" +
              '<span class="gb-partner-role"' + roleStyle + '>' + esc(p.role) + "</span>" +
              '<div class="gb-partner-bio">' + esc(p.bio) + "</div>" +
            "</div>"
          ).join("") +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["rfq-form"] = {
    label: "Quote / Proposal Request Form", category: "Forms",
    defaultProps: { title: "Request a Quote", subtitle: "", perks: [], submitLabel: "Send Request" },
    schema: [
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Eyebrow", type: "text" },
      { key: "perks", label: "Bullet points", type: "list", itemSchema: [{ key: "value", label: "Point", type: "text" }] },
      { key: "submitLabel", label: "Submit button label", type: "text" }
    ],
    render(props, ctx) {
      const perks = (props.perks || []).map((it) => typeof it === "string" ? it : it.value);
      const id = ctx.blockId;
      return '<section class="portal-section" data-block-id="' + id + '">' +
        '<div class="gb-rfq">' +
          '<div>' +
            (props.subtitle ? '<div class="section-eyebrow"' + ed("subtitle") + '>' + esc(props.subtitle) + "</div>" : "") +
            '<div class="section-title"' + ed("title") + '>' + esc(props.title || "Request a Quote") + "</div>" +
            (perks.length ? '<ul class="gb-rfq-perks">' + perks.map((p) => "<li>" + esc(p) + "</li>").join("") + "</ul>" : "") +
          "</div>" +
          '<form id="rfqForm_' + id + '" data-le-widget="true" onsubmit="event.preventDefault();PortalGB.submitRfqBlock(\'' + id + '\')">' +
            '<div class="pf-row">' +
              '<div class="pf-field"><label class="pf-label">Name / Company <span class="req">*</span></label><input class="pf-input" id="rfq_' + id + '_name" required /></div>' +
              '<div class="pf-field"><label class="pf-label">Email <span class="req">*</span></label><input class="pf-input" type="email" id="rfq_' + id + '_email" required /></div>' +
            "</div>" +
            '<div class="pf-field"><label class="pf-label">Phone</label><input class="pf-input" id="rfq_' + id + '_phone" /></div>' +
            '<div class="pf-field"><label class="pf-label">Details <span class="req">*</span></label><textarea class="pf-textarea" id="rfq_' + id + '_message" required></textarea></div>' +
            '<button type="submit" class="btn btn-dark btn-full" id="rfqSubmit_' + id + '">' + esc(props.submitLabel || "Send Request") + " →</button>" +
          "</form>" +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["quote-banner"] = {
    label: "Quote / Slogan Banner", category: "Content",
    defaultProps: { quote: "Your slogan goes here.", textColor: "", bgColor: "", ctaLabel: "", ctaAction: "none", ctaTarget: "" },
    schema: [
      { key: "quote", label: "Quote / slogan", type: "text" },
      { key: "textColor", label: "Text Color", type: "color" },
      { key: "bgColor", label: "Background Color", type: "color" },
      { key: "ctaLabel", label: "Button label (optional)", type: "text" },
      { key: "ctaAction", label: "Button action", type: "action-select" },
      { key: "ctaTarget", label: "Action target", type: "action-target" }
    ],
    render(props, ctx) {
      const cta = props.ctaLabel ? renderButton({ label: props.ctaLabel, action: props.ctaAction, target: props.ctaTarget }, "gb-hero-btn gb-hero-btn-primary") : "";
      const style = (props.bgColor ? "background:" + esc(props.bgColor) + ";" : "") + (props.textColor ? "color:" + esc(props.textColor) + ";" : "");
      return '<section class="portal-section gb-quote-banner" data-block-id="' + ctx.blockId + '"' + (style ? ' style="' + style + '"' : "") + '>' +
        '<div class="gb-quote-text"' + ed("quote") + '>"' + esc(props.quote || "") + '"</div>' + cta +
        "</section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["footer-rich"] = {
    label: "Footer", category: "Footer",
    defaultProps: {
      desc: "", tagline: "", accentColor: "", bgColor: "", newsletter: true,
      newsletterTitle: "Stay in the loop", newsletterSub: "News, offers and updates — no spam.",
      contactAddress: "", contactPhone: "", contactEmail: "",
      socials: [], legal: "All rights reserved.",
      columns: [{ title: "Company", links: [{ label: "About", href: "#" }] }]
    },
    schema: [
      { key: "tagline", label: "Big closing line", type: "text" },
      { key: "desc", label: "Brand description", type: "textarea" },
      { key: "accentColor", label: "Accent color", type: "color" },
      { key: "bgColor", label: "Background color", type: "color" },
      { key: "newsletter", label: "Show email signup", type: "boolean" },
      { key: "newsletterTitle", label: "Signup heading", type: "text" },
      { key: "newsletterSub", label: "Signup subtext", type: "text" },
      { key: "contactAddress", label: "Address", type: "text" },
      { key: "contactPhone", label: "Phone", type: "text" },
      { key: "contactEmail", label: "Email", type: "text" },
      { key: "socials", label: "Social links", type: "list", itemSchema: [
        { key: "label", label: "Name", type: "text" },
        { key: "href", label: "URL", type: "text" }
      ] },
      { key: "legal", label: "Legal line", type: "text" },
      { key: "columns", label: "Link columns", type: "list", itemSchema: [
        { key: "title", label: "Column title", type: "text" },
        { key: "links", label: "Links", type: "list", itemSchema: [
          { key: "label", label: "Label", type: "text" },
          { key: "href", label: "URL", type: "text" }
        ] }
      ] }
    ],
    render(props, ctx) {
      const brand = (window.PortalState && window.PortalState.config && window.PortalState.config.company) || "";
      // Each industry ships its own accent so the footer reads as part of
      // that brand rather than a generic slate block on every site.
      const style = (props.accentColor ? "--gbf-accent:" + esc(props.accentColor) + ";" : "") +
        (props.bgColor ? "--gbf-bg:" + esc(props.bgColor) + ";" : "");

      const cols = (props.columns || []).map((col) =>
        '<div class="gb-foot-col"><h4>' + esc(col.title) + "</h4>" +
          (col.links || []).map((l) => '<a href="' + esc(l.href || "#") + '">' + esc(l.label) + "</a>").join("") +
        "</div>"
      ).join("");

      const contactRows = [
        props.contactAddress ? '<li><span class="gb-foot-ic">📍</span>' + esc(props.contactAddress) + "</li>" : "",
        props.contactPhone ? '<li><span class="gb-foot-ic">📞</span><a href="tel:' + esc(props.contactPhone.replace(/\s/g, "")) + '">' + esc(props.contactPhone) + "</a></li>" : "",
        props.contactEmail ? '<li><span class="gb-foot-ic">✉</span><a href="mailto:' + esc(props.contactEmail) + '">' + esc(props.contactEmail) + "</a></li>" : ""
      ].join("");
      const contact = contactRows ? '<div class="gb-foot-col"><h4>Get in touch</h4><ul class="gb-foot-contact">' + contactRows + "</ul></div>" : "";

      const socials = (props.socials || []).length
        ? '<div class="gb-foot-socials">' + props.socials.map((sc) =>
            '<a href="' + esc(sc.href || "#") + '" target="_blank" rel="noopener" title="' + esc(sc.label) + '">' + esc(sc.label) + "</a>").join("") + "</div>"
        : "";

      const news = props.newsletter !== false
        ? '<div class="gb-foot-news">' +
            '<div class="gb-foot-news-title"' + ed("newsletterTitle") + ">" + esc(props.newsletterTitle || "Stay in the loop") + "</div>" +
            '<div class="gb-foot-news-sub"' + ed("newsletterSub") + ">" + esc(props.newsletterSub || "") + "</div>" +
            '<form class="gb-foot-form" onsubmit="return PortalGB.subscribeFooter(event, this)">' +
              '<input type="email" placeholder="Your email address" required aria-label="Email address">' +
              '<button type="submit">Subscribe</button>' +
            "</form>" +
          "</div>"
        : "";

      return '<footer class="portal-section gb-footer-rich" data-block-id="' + ctx.blockId + '"' + (style ? ' style="' + style + '"' : "") + ">" +
        (props.tagline ? '<div class="gb-foot-tagline"' + ed("tagline") + ">" + esc(props.tagline) + "</div>" : "") +
        '<div class="gb-footer-rich-inner">' +
          '<div class="gb-foot-brand">' +
            (brand ? '<div class="gb-foot-brand-name">' + esc(brand) + "</div>" : "") +
            '<div class="gb-footer-desc"' + ed("desc") + ">" + esc(props.desc || "") + "</div>" +
            socials +
          "</div>" +
          cols + contact +
          news +
        "</div>" +
        '<div class="gb-foot-bottom">' +
          "<span>© " + new Date().getFullYear() + " " + esc(brand || "") + ". " + esc(props.legal || "All rights reserved.") + "</span>" +
          '<span class="gb-foot-powered">Powered by <a href="https://webocloud.com" target="_blank" rel="noopener">WeboCloud</a></span>' +
        "</div>" +
      "</footer>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks.richtext = {
    label: "Text Block", category: "Content",
    defaultProps: { heading: "Section heading", body: "Write your content here." },
    schema: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "body", label: "Body text", type: "textarea" }
    ],
    render(props, ctx) {
      return '<section class="portal-section gb-richtext" data-block-id="' + ctx.blockId + '">' +
        (props.heading ? "<h2>" + esc(props.heading) + "</h2>" : "") +
        "<p>" + esc(props.body || "").replace(/\n/g, "<br>") + "</p>" +
        "</section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks.tracker = {
    label: "Shipment Tracker", category: "Logistics",
    defaultProps: {
      title: "Track Your Shipment",
      subtitle: "Enter your shipment tracking number or bill of lading for real-time updates.",
      inputPlaceholder: "Tracking Number or Delivery Notice (e.g. MRV-RW-24-001)",
      submitLabel: "Track",
      sampleRefs: ["MRV-RW-24-001", "MRV-RW-24-002", "DLV-1002"],
      sideCards: [
        { icon: "🚚", title: "Calculate Freight Rate", desc: "Instant shipping estimates for domestic & global cargo" },
        { icon: "📦", title: "Schedule Cargo Pickup", desc: "Book warehouse dispatch or door-to-door pickup" }
      ],
      quoteTitle: "Get a Quick Quote"
    },
    schema: [
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "textarea" },
      { key: "inputPlaceholder", label: "Input placeholder", type: "text" },
      { key: "submitLabel", label: "Submit button label", type: "text" },
      { key: "sampleRefs", label: "Example tracking numbers", type: "list", itemSchema: [{ key: "value", label: "Reference", type: "text" }] },
      { key: "sideCards", label: "Quick-action cards", type: "list", itemSchema: [
        { key: "icon", label: "Icon / emoji", type: "text" },
        { key: "title", label: "Title", type: "text" },
        { key: "desc", label: "Description", type: "textarea" }
      ] },
      { key: "quoteTitle", label: "Quote widget title", type: "text" }
    ],
    /* Reuses the site's existing global Portal.doTrack()/openRateCalculator()/
       openPickupModal() functions (portal.js) unchanged — they already work
       against these exact element ids regardless of which renderer produced
       them, so no new tracking logic is needed here. */
    render(props, ctx) {
      const refs = (props.sampleRefs || []).map((r) => (typeof r === "string" ? r : r.value));
      const cards = props.sideCards || [];
      const cardActions = ["Portal.openRateCalculator()", "Portal.openPickupModal()"];
      return '<section class="portal-section" data-block-id="' + ctx.blockId + '">' +
        '<div class="logistics-hero"><div class="logistics-hero-inner"><div class="logistics-grid">' +
          '<div class="ups-track-card" data-le-widget="true">' +
            '<div class="ups-track-hd"><span class="ups-track-icon">📍</span><div>' +
              '<h2 class="ups-track-title">' + esc(props.title || "Track Your Shipment") + "</h2>" +
              '<p class="ups-track-sub">' + esc(props.subtitle || "") + "</p>" +
            "</div></div>" +
            '<div class="track-input-row">' +
              '<input class="track-input" id="trackInput" placeholder="' + esc(props.inputPlaceholder || "") + '" autocomplete="off">' +
              '<button class="btn btn-accent-gold" id="trackBtn" onclick="Portal.doTrack()">' + esc(props.submitLabel || "Track") + " &gt;</button>" +
            "</div>" +
            '<div class="ups-quick-actions">' +
              '<a href="javascript:void(0)" onclick="Portal.setupAlerts()"><span class="qa-icon">🔔</span> Set Up Alerts</a>' +
              '<a href="javascript:void(0)" onclick="Portal.changeDelivery()"><span class="qa-icon">🚚</span> Change Delivery</a>' +
              '<a href="javascript:void(0)" onclick="Portal.openRateCalculator()"><span class="qa-icon">🧮</span> Calculate Shipping Rate</a>' +
              '<a href="javascript:void(0)" onclick="Portal.openPickupModal()"><span class="qa-icon">📦</span> Request Pickup</a>' +
            "</div>" +
            (refs.length ? '<div class="ups-sample-chips"><span class="chip-label">Quick Demo Tracking #:</span>' +
              refs.map((r) => '<button class="sample-chip" onclick="document.getElementById(\'trackInput\').value=' + JSON.stringify(r) + ';Portal.doTrack();">' + esc(r) + "</button>").join("") +
            "</div>" : "") +
            '<div id="trackResult"></div>' +
          "</div>" +
          '<div class="ups-side-cards">' +
            cards.map((c, i) => '<div class="side-card" onclick="' + (cardActions[i] || "") + '">' +
              '<div class="side-card-icon">' + esc(c.icon) + "</div>" +
              '<div class="side-card-title">' + esc(c.title) + "</div>" +
              '<div class="side-card-sub">' + esc(c.desc) + "</div>" +
              '<div class="side-card-link">Learn More ↗</div>' +
            "</div>").join("") +
          "</div>" +
        "</div></div></div>" +
        '<div class="dhl-quote-container">' +
          '<div class="dhl-quote-card" data-le-widget="true">' +
            '<h3 class="dhl-quote-title">' + esc(props.quoteTitle || "Get a Quick Quote") + "</h3>" +
            '<div class="dhl-quote-grid">' +
              '<div class="dhl-field"><label class="dhl-label">Shipping from</label>' +
                '<select class="dhl-select" id="dhlFromCountry">' +
                  '<option value="SA">🇸🇦 Saudi Arabia</option><option value="TR">🇹🇷 Turkey</option>' +
                  '<option value="US">🇺🇸 United States</option><option value="GB">🇬🇧 United Kingdom</option>' +
                  '<option value="DE">🇩🇪 Germany</option><option value="AE">🇦🇪 United Arab Emirates</option>' +
                  '<option value="CN">🇨🇳 China</option>' +
                "</select></div>" +
              '<div class="dhl-field"><label class="dhl-label">Shipping to</label>' +
                '<select class="dhl-select" id="dhlToCountry">' +
                  '<option value="">Select country</option><option value="US">🇺🇸 United States</option>' +
                  '<option value="DE">🇩🇪 Germany</option><option value="GB">🇬🇧 United Kingdom</option>' +
                  '<option value="AE">🇦🇪 United Arab Emirates</option><option value="SA">🇸🇦 Saudi Arabia</option>' +
                  '<option value="TR">🇹🇷 Turkey</option><option value="CN">🇨🇳 China</option>' +
                "</select></div>" +
              '<div class="dhl-field dhl-field-btn"><label class="dhl-label">&nbsp;</label>' +
                '<button class="btn btn-dhl-red" onclick="Portal.calcDhlQuote()">Get Quote →</button>' +
              "</div>" +
            "</div>" +
            '<div id="dhlQuoteResult"></div>' +
          "</div>" +
        "</div>" +
      "</section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks.steps = {
    label: "Numbered Steps", category: "Logistics",
    defaultProps: {
      title: "Ready to Ship Now?",
      items: [
        { icon: "📜📦", title: "Create a Shipment", desc: "Get started by creating your shipment online or over the phone.", buttonLabel: "Create a New Shipment" },
        { icon: "📦🏷️", title: "Pack Your Shipment", desc: "Pack your items securely and ensure that it follows our guidelines.", buttonLabel: "View Guidelines" },
        { icon: "🚚🏢", title: "Drop Off / Courier Pickup", desc: "Drop off your shipment at a Service Point or schedule a courier pickup.", buttonLabel: "Find a Service Point" }
      ]
    },
    schema: [
      { key: "title", label: "Section title", type: "text" },
      { key: "items", label: "Steps", type: "list", itemSchema: [
        { key: "icon", label: "Icon / emoji", type: "text" },
        { key: "title", label: "Title", type: "text" },
        { key: "desc", label: "Description", type: "textarea" },
        { key: "buttonLabel", label: "Button label", type: "text" }
      ] }
    ],
    render(props, ctx) {
      const items = props.items || [];
      // Fixed by position (matches the original template) — these are
      // utility hooks (guideline popups, the pickup modal), not something
      // an owner would want to re-target to a different kind of action.
      const actions = [
        "Portal.openPickupModal()",
        "Portal.showInfo('Packaging Guidelines','📦','<ul class=\\'pam-list\\'><li>Use sturdy corrugated boxes.</li><li>Wrap items individually in bubble wrap.</li><li>Seal all seams securely with heavy-duty tape.</li></ul>')",
        "Portal.showInfo('Service Points & Hubs','🏢','<ul class=\\'pam-list\\'><li>Mersin Main Port Cargo Terminal</li><li>Istanbul Airport Hub (ISL)</li><li>Frankfurt Global Dispatch Depot</li><li>Dubai Logistics City Depot</li></ul>')"
      ];
      return '<section class="portal-section dhl-ship-section" data-block-id="' + ctx.blockId + '">' +
        '<div class="ups-section-hd"><h2 class="ups-sec-title" style="font-size:2.2rem;font-weight:900">' + esc(props.title || "Ready to Ship Now?") + "</h2></div>" +
        '<div class="dhl-steps-grid">' +
          items.map((s, i) => '<div class="dhl-step-card">' +
            '<div class="dhl-step-num">' + String(i + 1).padStart(2, "0") + "</div>" +
            '<div class="dhl-step-icon">' + esc(s.icon) + "</div>" +
            '<h3 class="dhl-step-title">' + esc(s.title) + "</h3>" +
            '<p class="dhl-step-sub">' + esc(s.desc) + "</p>" +
            '<button class="btn btn-dhl-red btn-full" onclick="' + (actions[i] || "") + '">' + esc(s.buttonLabel || "Learn More") + "</button>" +
          "</div>").join("") +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["link-grid"] = {
    label: "Quick Links Grid", category: "Logistics",
    defaultProps: {
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
    },
    schema: [
      { key: "title", label: "Section title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "text" },
      { key: "items", label: "Links", type: "list", itemSchema: [
        { key: "title", label: "Title", type: "text" },
        { key: "linkLabel", label: "Link label", type: "text" }
      ] }
    ],
    render(props, ctx) {
      const items = props.items || [];
      const actions = [
        "Portal.openRateCalculator()",
        "Portal.openPickupModal()",
        "Portal.setupAlerts()",
        "document.getElementById('trackInput') && document.getElementById('trackInput').scrollIntoView({behavior:'smooth'})",
        "Portal.showInfo('Customs eFiling','📋','<p class=\\'pam-text\\'>All export documentation is active and compliant.</p><div class=\\'pam-result-row\\'><span>Status</span><b>✅ Cleared</b></div>')",
        "Portal.showInfo('Support','💬','<p class=\\'pam-text\\'>Contact our 24/7 logistics desk any time.</p><div class=\\'pam-result-row\\'><span>Email</span><b>support@webocloud.com</b></div><div class=\\'pam-result-row\\'><span>Hotline</span><b>+1 (800) 555-0134</b></div>')"
      ];
      return '<section class="portal-section" data-block-id="' + ctx.blockId + '">' +
        '<div class="ups-section-hd">' +
          '<h2 class="ups-sec-title">' + esc(props.title || "Find What You Need, Fast") + "</h2>" +
          (props.subtitle ? '<p class="ups-sec-sub">' + esc(props.subtitle) + "</p>" : "") +
          '<div class="ups-yellow-bar"></div>' +
        "</div>" +
        '<div class="ups-services-grid">' +
          items.map((it, i) => '<div class="ups-service-card" onclick="' + (actions[i] || "") + '">' +
            '<div class="us-card-title">' + esc(it.title) + "</div>" +
            '<div class="us-card-link">' + esc(it.linkLabel || "Learn More") + " ↗</div>" +
          "</div>").join("") +
        "</div></section>";
    }
  };

  /* ---------------------------------------------------------------- */
  PortalBlocks["image-banner"] = {
    label: "Image + Text Banner", category: "Content",
    defaultProps: {
      title: "Streamline the Way You Do Business",
      subtitle: "Track, ship, and connect your global logistics operations all on one unified platform.",
      buttonLabel: "Get Started", action: "none", target: "",
      image: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=800&q=80"
    },
    schema: [
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "textarea" },
      { key: "buttonLabel", label: "Button label", type: "text" },
      { key: "action", label: "Button action", type: "action-select" },
      { key: "target", label: "Action target", type: "action-target" },
      { key: "image", label: "Image", type: "image" }
    ],
    render(props, ctx) {
      const btn = props.buttonLabel ? renderButton({ label: props.buttonLabel, action: props.action, target: props.target }, "btn btn-accent-gold btn-lg") : "";
      return '<div class="ups-banner-section portal-section" data-block-id="' + ctx.blockId + '">' +
        '<div class="ups-banner-inner">' +
          '<div class="ups-banner-content">' +
            "<h2>" + esc(props.title || "") + "</h2>" +
            "<p>" + esc(props.subtitle || "") + "</p>" +
            btn +
          "</div>" +
          '<div class="ups-banner-img"><img src="' + esc(props.image || "") + '" alt=""></div>' +
        "</div>" +
      "</div>";
    }
  };

  /* ----------------------------------------------------------------
     Image Slideshow / Carousel
     Every industry ships with one of these (see config-migrate.js), and
     every slide's image is an `image` field — which the live editor
     renders with an Upload button, so a business can drop its own
     photos straight in without touching a URL.

     Slides crossfade rather than translate: no width maths, so the
     block survives the editor's mobile-preview resize and the canvas
     re-render without needing a layout pass.
     ---------------------------------------------------------------- */
  const SS_HEIGHTS = ["short", "medium", "tall", "full"];

  PortalBlocks.slideshow = {
    label: "Image Slideshow", category: "Media",
    defaultProps: {
      title: "", subtitle: "",
      height: "medium", autoplay: true, interval: 5,
      showArrows: true, showDots: true, showCaptions: true, overlay: 45,
      slides: [
        { image: "", eyebrow: "", title: "Your first slide", desc: "Upload a photo and write a short caption.", ctaLabel: "", ctaAction: "none", ctaTarget: "" }
      ]
    },
    schema: [
      { key: "title", label: "Section title (optional)", type: "text" },
      { key: "subtitle", label: "Section subtitle", type: "text" },
      { key: "height", label: "Height", type: "select", options: SS_HEIGHTS },
      { key: "autoplay", label: "Auto-advance slides", type: "boolean" },
      { key: "interval", label: "Seconds per slide", type: "number", min: 2, max: 20 },
      { key: "showArrows", label: "Show arrows", type: "boolean" },
      { key: "showDots", label: "Show dots", type: "boolean" },
      { key: "showCaptions", label: "Show slide captions", type: "boolean" },
      { key: "overlay", label: "Image darkening (0–80)", type: "number", min: 0, max: 80 },
      { key: "slides", label: "Slides", type: "list", itemSchema: [
        { key: "image", label: "Slide image", type: "image" },
        { key: "eyebrow", label: "Eyebrow tag", type: "text" },
        { key: "title", label: "Title", type: "text" },
        { key: "desc", label: "Description", type: "textarea" },
        { key: "ctaLabel", label: "Button label", type: "text" },
        { key: "ctaAction", label: "Button action", type: "action-select" },
        { key: "ctaTarget", label: "Action target", type: "action-target" }
      ] }
    ],
    render(props, ctx) {
      const slides = (props.slides || []).length ? props.slides : [{}];
      const height = SS_HEIGHTS.indexOf(props.height) > -1 ? props.height : "medium";
      const shade = Math.max(0, Math.min(80, Number(props.overlay == null ? 45 : props.overlay))) / 100;
      const showCaps = props.showCaptions !== false;

      const slideHtml = slides.map((s, i) => {
        const cta = showCaps && s.ctaLabel
          ? renderButton({ label: s.ctaLabel, action: s.ctaAction, target: s.ctaTarget }, "gb-ss-cta")
          : "";
        const sp = "slides." + i + ".";
        const cap = showCaps && (s.eyebrow || s.title || s.desc || cta)
          ? '<div class="gb-ss-caption">' +
              (s.eyebrow ? '<span class="gb-ss-eyebrow"' + ed(sp + "eyebrow") + ">" + esc(s.eyebrow) + "</span>" : "") +
              (s.title ? '<h3 class="gb-ss-title"' + ed(sp + "title") + ">" + emphasize(s.title) + "</h3>" : "") +
              (s.desc ? '<p class="gb-ss-desc"' + ed(sp + "desc") + ">" + esc(s.desc) + "</p>" : "") +
              cta +
            "</div>"
          : "";
        // Never lazy-load a slide: an off-screen carousel image doesn't
        // trigger the lazy loader reliably, so the slide would turn up
        // blank the first time it rotates in. Later slides are fetched at
        // low priority instead, keeping the first one the fast paint.
        const media = s.image
          ? '<img class="gb-ss-img" src="' + esc(s.image) + '" alt="' + esc(s.title || "") + '" fetchpriority="' + (i === 0 ? "high" : "low") + '"' + ed(sp + "image") + ">"
          : '<div class="gb-ss-empty"' + ed(sp + "image") + '><span class="gb-ss-empty-icon">🖼</span><span>Add a photo for this slide</span></div>';
        return '<div class="gb-ss-slide' + (i === 0 ? " is-active" : "") + '" data-ss-index="' + i + '" aria-hidden="' + (i === 0 ? "false" : "true") + '">' +
          media + '<div class="gb-ss-shade" style="opacity:' + shade + '"></div>' + cap +
        "</div>";
      }).join("");

      const arrows = props.showArrows !== false && slides.length > 1
        ? '<button type="button" class="gb-ss-arrow gb-ss-prev" data-ss-nav="prev" aria-label="Previous slide">‹</button>' +
          '<button type="button" class="gb-ss-arrow gb-ss-next" data-ss-nav="next" aria-label="Next slide">›</button>'
        : "";
      const dots = props.showDots !== false && slides.length > 1
        ? '<div class="gb-ss-dots">' + slides.map((s, i) =>
            '<button type="button" class="gb-ss-dot' + (i === 0 ? " is-active" : "") + '" data-ss-go="' + i + '" aria-label="Go to slide ' + (i + 1) + '"></button>'
          ).join("") + "</div>"
        : "";

      const head = (props.title || props.subtitle)
        ? '<div class="section-head">' +
            "<div>" +
            (props.subtitle ? '<div class="section-eyebrow"' + ed("subtitle") + '>' + esc(props.subtitle) + "</div>" : "") +
            (props.title ? '<div class="section-title"' + ed("title") + '>' + esc(props.title) + "</div>" : "") +
            "</div></div>"
        : "";

      // data-le-no-eject: a carousel is one live widget, not a stack of
      // layout pieces. Without this, dragging a caption flattened every
      // slide — including the faded-out ones — into loose absolute boxes
      // and the slideshow stopped being a slideshow.
      return '<section class="portal-section gb-slideshow-sec" data-le-no-eject="true" data-block-id="' + ctx.blockId + '">' + head +
        '<div class="gb-slideshow gb-ss-h-' + height + '" data-ss-root="' + ctx.blockId + '"' +
          ' data-ss-autoplay="' + (props.autoplay !== false ? "1" : "0") + '"' +
          ' data-ss-interval="' + (Math.max(2, Number(props.interval) || 5) * 1000) + '">' +
          '<div class="gb-ss-viewport">' + slideHtml + "</div>" + arrows + dots +
        "</div></section>";
    },
    afterRender(props, ctx) {
      if (window.initPortalSlideshow) window.initPortalSlideshow(ctx.blockId);
    }
  };

  /* ---- slideshow runtime -------------------------------------------
     Timers live in a module-level registry keyed by block id so a
     re-render (live editor, hash route change) always tears the old
     one down first — otherwise every edit would stack another timer
     onto the same block and the slides would race. ------------------ */
  const ssTimers = {};

  window.initPortalSlideshow = function (blockId) {
    // Sweep timers whose block is no longer on the page — navigating to
    // another page leaves its slideshows detached, and a timer ticking
    // over detached nodes would otherwise run for the rest of the visit.
    Object.keys(ssTimers).forEach((id) => {
      if (!document.querySelector('[data-ss-root="' + id + '"]')) {
        clearInterval(ssTimers[id]);
        delete ssTimers[id];
      }
    });

    const root = document.querySelector('[data-ss-root="' + blockId + '"]');
    if (ssTimers[blockId]) { clearInterval(ssTimers[blockId]); delete ssTimers[blockId]; }
    if (!root) return;

    const slides = Array.prototype.slice.call(root.querySelectorAll(".gb-ss-slide"));
    const dots = Array.prototype.slice.call(root.querySelectorAll(".gb-ss-dot"));
    if (slides.length < 2) return;
    let index = 0;

    function go(next) {
      index = (next + slides.length) % slides.length;
      slides.forEach((s, i) => {
        s.classList.toggle("is-active", i === index);
        s.setAttribute("aria-hidden", i === index ? "false" : "true");
      });
      dots.forEach((d, i) => d.classList.toggle("is-active", i === index));
    }

    root.querySelectorAll("[data-ss-nav]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        go(index + (btn.dataset.ssNav === "next" ? 1 : -1));
        restart();
      });
    });
    dots.forEach((d) => d.addEventListener("click", (e) => { e.stopPropagation(); go(Number(d.dataset.ssGo)); restart(); }));

    // touch swipe — horizontal drags only, so vertical page scrolling still works
    let startX = null;
    root.addEventListener("touchstart", (e) => { startX = e.touches[0].clientX; }, { passive: true });
    root.addEventListener("touchend", (e) => {
      if (startX == null) return;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 45) { go(index + (dx < 0 ? 1 : -1)); restart(); }
      startX = null;
    }, { passive: true });

    function restart() {
      if (ssTimers[blockId]) clearInterval(ssTimers[blockId]);
      if (root.dataset.ssAutoplay !== "1") return;
      // Don't auto-advance while the live editor is open — a slide rotating
      // away mid-edit means you're suddenly editing a different slide than
      // the one you clicked. Arrows and dots still work for previewing.
      if (document.body.classList.contains("le-active")) return;
      ssTimers[blockId] = setInterval(() => go(index + 1), Number(root.dataset.ssInterval) || 5000);
    }
    root.addEventListener("mouseenter", () => { if (ssTimers[blockId]) clearInterval(ssTimers[blockId]); });
    root.addEventListener("mouseleave", restart);
    restart();
  };

  window.PortalBlocks = PortalBlocks;
  window.genBlockId = window.genBlockId || function () { return "blk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); };
})();
