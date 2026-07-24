/* =================================================================
   WeboCloud Portal Engine — Live Visual Page Builder
   -----------------------------------------------------------------
   Schema-driven rewrite: every edit (text, image, button, block
   order, new pages) writes into a single `draftConfig` object, which
   is re-rendered through the generic block renderer after each
   change. That's the fix for the old prototype's core bug, where
   image/button/order edits mutated the live DOM directly and were
   silently dropped on publish because they never reached the config
   object that actually gets saved.

   Only mounts for ?edit=true, and only after verifying the caller is
   authorized (see verifyAndBoot below) — a drive-by visitor appending
   ?edit=true to a live storefront URL no longer sees the editor.
   ================================================================= */
(function () {
  "use strict";

  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get("edit") !== "true") return;

  /* The edit token travels in the URL *fragment* (#et=…), not the query
     string, so it is never sent to the server in the request line (access
     logs) nor leaked via the Referer header. We read it once at boot, then
     scrub it from the address bar. A query fallback is kept for old links. */
  const EDIT_TOKEN = (function () {
    let t = "";
    try { t = new URLSearchParams((location.hash || "").replace(/^#/, "")).get("et") || ""; } catch (e) {}
    if (!t) t = urlParams.get("et") || "";
    if (t && location.hash) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    }
    return t;
  })();

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const escAttr = (s) => esc(s).replace(/'/g, "&#39;");

  const ACTION_OPTIONS = [
    { value: "none", label: "No action" },
    { value: "scroll", label: "Scroll to a block on this page" },
    { value: "page", label: "Go to another page" },
    { value: "link", label: "Open a URL" },
    { value: "cart", label: "Open cart" }
  ];

  const IMAGE_PRESETS = [
    "https://images.unsplash.com/photo-1542838132-92c53300491e?w=600&q=80",
    "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=600&q=80",
    "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80",
    "https://images.unsplash.com/photo-1513185158878-8d8c2a2a3da3?w=600&q=80",
    "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=600&q=80",
    "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=600&q=80"
  ];

  /* ---- editor state ---- */
  let wsId = null;
  let draftConfig = null;
  let activePage = "main";
  let activeTab = "blocks";
  let expandedBlockId = null;
  let dragFromIndex = null;
  let canvasSelection = null;   // { blockId, elementId } — selected element inside a freeform `canvas` block
  let activeBreakpoint = "desktop"; // "desktop" | "mobile" — which position set the canvas editor reads/writes
  let elDragCtx = null;         // active on-canvas drag/resize operation, see onHandleMouseDown

  /* ---- path helpers (dot-path get/set against draftConfig) ---- */
  function keyOf(k) { return /^\d+$/.test(k) ? Number(k) : k; }
  function getByPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[keyOf(k)]), obj);
  }
  function setByPath(obj, path, val) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[keyOf(parts[i])];
    cur[keyOf(parts[parts.length - 1])] = val;
  }

  function toast(msg, kind) {
    if (window.toast) return window.toast(msg, kind);
    console.log("[LiveEditor]", msg);
  }

  /* ---- wait for the portal's own boot() to finish before mounting ---- */
  function waitForPortalReady(timeoutMs) {
    return new Promise((resolve) => {
      if (window.PortalState && window.PortalState.config) return resolve(true);
      let done = false;
      function finish(ok) { if (done) return; done = true; document.removeEventListener("portal:boot-complete", onReady); clearTimeout(t); resolve(ok); }
      function onReady() { finish(true); }
      document.addEventListener("portal:boot-complete", onReady);
      const t = setTimeout(() => finish(!!(window.PortalState && window.PortalState.config)), timeoutMs || 8000);
    });
  }

  async function hasLiveWorkspaceRecord(id) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch("/api/ws/" + encodeURIComponent(id) + "/config", { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch (e) { return false; }
  }

  async function verifyAndBoot() {
    await waitForPortalReady(8000);
    const cfg = window.PortalState && window.PortalState.config;
    wsId = window.PortalState && window.PortalState.wsId;
    if (!cfg || !wsId) { console.warn("[LiveEditor] Portal never finished loading — editor not mounted."); return; }

    if (["retail", "services", "fashion", "restaurant", "construction", "manufacturing", "logistics", "wholesale"].indexOf(cfg.industry) === -1) {
      const msg = "The visual page-builder isn't available for this workspace's industry (\"" + (cfg.industry || "unknown") + "\") yet.";
      console.warn("[LiveEditor] " + msg);
      showUnavailableBanner(msg);
      return;
    }

    const et = EDIT_TOKEN;
    let allowed = false;
    if (et) {
      try {
        // Token goes in a header, never the query string.
        const r = await fetch("/api/storefront/edit-token/verify?wsId=" + encodeURIComponent(wsId), { headers: { "x-edit-token": et } });
        const j = await r.json();
        allowed = !!j.ok;
      } catch (e) { allowed = false; }
    } else {
      // No edit token supplied: only trust this when there's no live master-DB
      // record for this workspace at all — i.e. a pure single-browser demo,
      // where there is no other tenant/owner whose data could be at risk.
      allowed = !(await hasLiveWorkspaceRecord(wsId));
    }

    if (!allowed) {
      console.warn("[LiveEditor] Not authorized to edit this storefront.");
      showUnavailableBanner("You're not authorized to edit this storefront (missing or expired edit link). Open \"Edit Visually\" again from Settings.");
      return;
    }
    init();
  }

  /* Visible on-page notice for when edit mode can't be entered — replaces
     the old behavior of silently doing nothing but logging to the console. */
  function showUnavailableBanner(message) {
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;background:#7c2d12;color:#fff;padding:12px 20px;font:600 14px/1.4 -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;gap:16px;text-align:center";
    bar.innerHTML = '<span>⚠️ Visual editor unavailable — ' + message.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</span><button style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.4);color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer" onclick="this.parentElement.remove()">✕</button>';
    document.body.appendChild(bar);
  }

  function init() {
    draftConfig = JSON.parse(JSON.stringify(window.PortalState.config.storefrontConfig || {}));
    draftConfig.pages = draftConfig.pages || { main: { title: "Home", slug: "main", isHome: true, blocks: [] } };
    draftConfig.navOrder = draftConfig.navOrder || Object.keys(draftConfig.pages);
    activePage = "main";

    document.body.classList.add("le-active");
    mountPanel();
    applyDraft();

    document.addEventListener("portal:page-rendered", (e) => {
      const slug = e.detail && e.detail.slug;
      if (slug && slug !== activePage) { activePage = slug; renderPanel(); }
      markSelectedOnCanvas();
    });
    document.addEventListener("click", onCanvasClick, true);

    // Brief intro hint — auto-dismisses
    setTimeout(() => toast("✨ Click any section to edit it — or hover for more options."), 800);
  }

  /* ---- push draftConfig into the live PortalState and re-render the canvas ---- */
  function applyDraft() {
    window.PortalState.config.storefrontConfig = draftConfig;
    if (draftConfig.theme && draftConfig.theme.accentColor) {
      document.documentElement.style.setProperty("--accent", draftConfig.theme.accentColor);
    }
    if (window.renderPortalPage) window.renderPortalPage(activePage, window.PortalState.products);
    applyBreakpointPreview();
    markSelectedOnCanvas();
    enableBlockDragHandles();
    enableInlineElementDragging();
    enableDirectEditing();

    // Bank the pre-change state for undo. Every mutation that re-renders
    // funnels through here, so panel edits, drags and block add/delete all
    // get history for free without touching their call sites. Edits that
    // already declared themselves via pushHistory() are skipped, so they
    // don't record the same step twice.
    const snap = snapshot();
    if (lastSnapshot === null) lastSnapshot = snap;
    else if (snap !== lastSnapshot) {
      if (!pendingKey) {
        undoStack.push(lastSnapshot);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
      }
      lastSnapshot = snap;
      pendingKey = null;
      updateHistoryButtons();
    }
  }

  /* Every block gets a drag handle + a small context action bar that
     appears on hover, so users can Edit / Duplicate / Delete directly
     on the canvas without needing to open the layers side-panel. */
  function enableBlockDragHandles() {
    const blocks = currentPage().blocks || [];
    document.querySelectorAll("#portalMain > [data-block-id]").forEach((section) => {
      if (getComputedStyle(section).position === "static") section.style.position = "relative";
      const blockId = section.getAttribute("data-block-id");
      const idx = blocks.findIndex((b) => b.id === blockId);

      // ── Drag handle ───────────────────────────────────────────────
      let handle = section.querySelector(":scope > .le-block-drag-handle");
      if (!handle) {
        handle = document.createElement("div");
        handle.className = "le-block-drag-handle";
        handle.innerHTML = "⠿";
        handle.title = "Drag to reorder";
        handle.draggable = true;
        handle.setAttribute("data-role", "canvas-block-row");
        section.insertBefore(handle, section.firstChild);
      }
      handle.dataset.index = idx;

      // ── Context action bar ────────────────────────────────────────
      let ctx = section.querySelector(":scope > .le-block-ctx");
      if (!ctx) {
        ctx = document.createElement("div");
        ctx.className = "le-block-ctx";
        ctx.setAttribute("data-le-no-eject", "1");
        section.insertBefore(ctx, section.firstChild);
      }
      ctx.innerHTML =
        '<button type="button" data-le-action="ctx-edit-block" data-block-id="' + blockId + '" title="Edit">✎ Edit</button>' +
        '<span class="ctx-sep"></span>' +
        '<button type="button" data-le-action="ctx-move-block-up" data-index="' + idx + '" title="Move up">↑</button>' +
        '<button type="button" data-le-action="ctx-move-block-down" data-index="' + idx + '" title="Move down">↓</button>' +
        '<span class="ctx-sep"></span>' +
        '<button type="button" data-le-action="duplicate-block" data-index="' + idx + '" title="Duplicate">⧉</button>' +
        '<button type="button" class="danger" data-le-action="delete-block" data-index="' + idx + '" title="Delete">✕</button>';
    });
  }

  /* ================================================================
     INLINE ELEMENT DRAGGING — makes buttons/images/text inside ANY
     block (not just a Freeform Canvas block) draggable on first touch.
     The first drag attempt on a piece of a structured block silently
     "ejects" that whole block into a `canvas`-type block (capturing
     every visible piece's exact current position, so nothing jumps),
     then hands off to the same drag engine Freeform Canvas already
     uses. From that point on the block behaves exactly like a canvas
     block — every piece in it is individually draggable/resizable.
     ================================================================ */
  const INLINE_DRAG_SELECTOR = "img, button, .btn, h1, h2, h3, h4, p, span, div";
  const WIDGET_SELECTOR = '[data-le-widget="true"]';

  /* Blocks with real form fields (Tracker, RFQ Form, Calculator, ...) mark
     their self-contained functional area with `data-le-widget="true"` in
     their own render() (blocks.js). That whole marked element is treated
     as ONE leaf ("widget" kind) — captured and replayed as raw HTML on
     eject, so its ids/inline handlers/live results all travel together
     and nothing inside it needs to be understood individually. Anything
     nested inside a widget is skipped from the normal leaf scan below. */
  function leafContentElements(section) {
    const candidates = [...section.querySelectorAll(WIDGET_SELECTOR + ", " + INLINE_DRAG_SELECTOR)];
    const seen = new Set();
    return candidates.filter((el) => {
      if (seen.has(el)) return false;
      if (el.closest(".le-block-drag-handle, .fc-handles")) return false;
      if (el.closest("[data-le-no-eject]")) return false; // live widget — never broken into draggable pieces
      const widgetAncestor = el.closest(WIDGET_SELECTOR);
      if (widgetAncestor && widgetAncestor !== el) return false; // covered by its widget wrapper, not individually
      if (el.matches(WIDGET_SELECTOR)) { seen.add(el); return true; }
      if (el.querySelector("img, button, .btn, h1, h2, h3, h4, p")) return false; // has richer children — treat as a wrapper, not a leaf
      const hasDirectText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const isMedia = el.tagName === "IMG";
      const isButton = el.tagName === "BUTTON" || el.classList.contains("btn");
      if (isMedia || isButton || hasDirectText) { seen.add(el); return true; }
      return false;
    });
  }

  /* Converts block at `blockIdx` (any non-canvas type) into a `canvas`
     block whose elements match the exact current rendered layout —
     called the instant the user tries to drag anything inside it. */
  function ejectBlockToCanvas(blockIdx) {
    const blocks = currentPage().blocks;
    const block = blocks[blockIdx];
    if (!block || block.type === "canvas") return block;
    const section = document.querySelectorAll("#portalMain > [data-block-id]")[blockIdx];
    if (!section) return block;
    const secRect = section.getBoundingClientRect();
    const secStyle = getComputedStyle(section);

    // Preserve the block's actual look (e.g. a Hero's dark gradient +
    // white text) instead of dropping it to a plain white canvas — this
    // was the "everything gets ruined on drag" bug: the eject used to
    // hardcode background:#ffffff and strip every leaf's styling.
    const bgColor = secStyle.backgroundColor;
    const bgImage = secStyle.backgroundImage;
    const hasRealBg = bgImage && bgImage !== "none";
    const background = hasRealBg ? { color: "#ffffff", image: "", raw: bgImage } : { color: rgbToHex(bgColor) || "#ffffff", image: "" };
    const textColor = rgbToHex(secStyle.color);

    const elements = leafContentElements(section).map((el, i) => {
      const r = el.getBoundingClientRect();
      const desktop = {
        x: Math.round(r.left - secRect.left), y: Math.round(r.top - secRect.top),
        w: Math.round(r.width), h: Math.round(r.height), z: i
      };
      if (el.matches(WIDGET_SELECTOR)) {
        return { id: window.genBlockId(), kind: "widget", content: { html: el.outerHTML }, desktop, mobile: null };
      }
      if (el.tagName === "IMG") {
        // Images need their computed look snapshotted for exactly the same
        // reason text does. A hero's backdrop photo is styled by its parent
        // (`.gb-hero-bg-img img { opacity:.45 }`); reparented into a canvas
        // that selector stops matching, the photo snaps to full brightness
        // and the whole block looks like it changed color.
        const imgStyle = getComputedStyle(el);
        return {
          id: window.genBlockId(), kind: "image",
          content: {
            src: el.src, alt: el.alt || "",
            style: {
              opacity: imgStyle.opacity, objectFit: imgStyle.objectFit, objectPosition: imgStyle.objectPosition,
              borderRadius: imgStyle.borderRadius, filter: imgStyle.filter, mixBlendMode: imgStyle.mixBlendMode
            }
          },
          desktop, mobile: null
        };
      }
      // Snapshotting the actual computed visual properties (rather than
      // just carrying over the original CSS class) is what actually keeps
      // the look identical: a class like .gb-hero-title never declares its
      // own `color` (it inherits white from the Hero section), so once
      // reparented into a plain canvas wrapper it would silently lose that
      // color no matter which stylesheet "wins" the class cascade.
      const elStyle = getComputedStyle(el);
      if (el.tagName === "BUTTON" || el.classList.contains("btn")) {
        const style = {
          backgroundColor: elStyle.backgroundColor, color: elStyle.color, borderRadius: elStyle.borderRadius,
          fontWeight: elStyle.fontWeight, fontSize: elStyle.fontSize, padding: elStyle.padding,
          letterSpacing: elStyle.letterSpacing, textTransform: elStyle.textTransform, border: elStyle.border
        };
        return { id: window.genBlockId(), kind: "button", content: { label: el.textContent.trim(), action: "none", target: "", style }, desktop, mobile: null };
      }
      const style = {
        color: elStyle.color, fontSize: elStyle.fontSize, fontWeight: elStyle.fontWeight, fontStyle: elStyle.fontStyle,
        letterSpacing: elStyle.letterSpacing, lineHeight: elStyle.lineHeight, textTransform: elStyle.textTransform,
        textAlign: elStyle.textAlign, textShadow: elStyle.textShadow,
        // Some "text" leaves are really little chips — a slideshow eyebrow is
        // white-on-accent with its own padding. Dropping those turned them
        // into bare floating words.
        backgroundColor: elStyle.backgroundColor, padding: elStyle.padding, borderRadius: elStyle.borderRadius
      };
      return { id: window.genBlockId(), kind: "text", content: { text: el.textContent.trim(), html: captureInlineHtml(el), style }, desktop, mobile: null };
    });

    block.type = "canvas";
    block.props = { minHeight: Math.round(secRect.height), background, textColor, elements };
    return block;
  }

  /* A title like "THE *COLLECTION*" renders as `THE <em>COLLECTION</em>`,
     with the accent color coming from a descendant selector
     (`.gb-hero-title em { color: … }`). Flattening the leaf to textContent
     threw that highlight away, so the headline lost its accent word the
     moment you dragged it.

     This rebuilds one level of inline markup with each span's own computed
     color/weight/style baked in. Only a small allow-list of formatting tags
     is kept and every tag is re-emitted by us with escaped text — nothing
     from the page's markup is passed through verbatim. Returns null when
     there's no inline markup worth keeping (the common case). */
  const INLINE_KEEP_TAGS = { EM: 1, STRONG: 1, B: 1, I: 1, U: 1, SPAN: 1, MARK: 1, BR: 1 };
  const INLINE_STYLE_PROPS = [["color", "color"], ["fontStyle", "font-style"], ["fontWeight", "font-weight"], ["textDecoration", "text-decoration"], ["backgroundColor", "background-color"]];

  function captureInlineHtml(el) {
    const kids = [...el.childNodes];
    if (!kids.some((n) => n.nodeType === 1)) return null; // plain text — nothing to preserve
    let html = "";
    for (const n of kids) {
      if (n.nodeType === 3) { html += escHtml(n.textContent); continue; }
      if (n.nodeType !== 1) continue;
      if (!INLINE_KEEP_TAGS[n.tagName]) return null;          // something structural — bail to plain text
      if (n.tagName === "BR") { html += "<br>"; continue; }
      if ([...n.childNodes].some((c) => c.nodeType === 1)) return null; // nested markup — not worth the risk
      const cs = getComputedStyle(n);
      let style = INLINE_STYLE_PROPS
        .map(([k, prop]) => (cs[k] && cs[k] !== "none" && cs[k] !== "rgba(0, 0, 0, 0)" ? prop + ":" + cs[k] : ""))
        .filter(Boolean).join(";");
      // A gradient-clipped accent word (retail's hero) paints itself with a
      // background-image and a transparent text fill. Copying `color` alone
      // would have carried over the transparency and nothing else — i.e.
      // dragged the word into invisibility. Carry the whole trick instead.
      const isClipped = cs.webkitTextFillColor === "rgba(0, 0, 0, 0)" || cs.webkitTextFillColor === "transparent";
      if (isClipped && cs.backgroundImage && cs.backgroundImage !== "none") {
        style += ";background-image:" + cs.backgroundImage +
          ";-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent";
      }
      const tag = n.tagName.toLowerCase();
      html += "<" + tag + (style ? ' style="' + escHtml(style) + '"' : "") + ">" + escHtml(n.textContent) + "</" + tag + ">";
    }
    return html.trim() || null;
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function rgbToHex(rgbStr) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgbStr || "");
    if (!m) return null;
    return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  }

  function onInlineElementMouseDown(e) {
    // Let normal field interaction (typing, selecting text) happen — only
    // grabbing a non-field part of a widget (its title, padding, etc.)
    // should be able to start a drag.
    if (e.target.closest("input, select, textarea")) return;

    // Blocks that mark themselves data-le-no-eject are live widgets whose
    // behaviour is wired up in JS after render (product grid → add to cart,
    // slideshow → rotation). Ejecting them replays their markup as inert
    // absolute boxes, which destroys the feature. They stay whole: reorder
    // them with the block drag handle, edit them from the panel.
    if (e.target.closest("[data-le-no-eject]")) return;

    const section = e.target.closest("#portalMain > [data-block-id]");
    if (!section) return;
    if (section.getAttribute("data-canvas-block") === "true") return; // already a canvas block — its own handlers own this
    const leaves = leafContentElements(section);
    const widgetEl = e.target.closest(WIDGET_SELECTOR);
    const el = widgetEl || e.target.closest(INLINE_DRAG_SELECTOR);
    const leafIndex = el ? leaves.indexOf(el) : -1;
    if (leafIndex === -1) return;

    const blocks = currentPage().blocks;
    const blockIdx = blocks.findIndex((b) => b.id === section.getAttribute("data-block-id"));
    if (blockIdx === -1) return;

    // Only a real drag (mouse actually moves) should convert the block —
    // a plain click needs to fall through untouched to the normal
    // click-to-select handler (onCanvasClick), which opens the block's
    // usual property form. Without this threshold, every single click
    // on any button/image/text would silently eject the block.
    const startX = e.clientX, startY = e.clientY;
    const THRESHOLD = 4;

    function onMove(ev) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      cleanup();
      ev.preventDefault();

      const block = ejectBlockToCanvas(blockIdx);
      const newElement = (block.props.elements || [])[leafIndex];
      if (!newElement) return;

      expandedBlockId = block.id;
      canvasSelection = { blockId: block.id, elementId: newElement.id };
      activeTab = "blocks";
      renderPanel();
      applyDraft(); // re-renders as a canvas block, pixel-identical to a moment ago

      beginElementDrag("move", block.id, newElement.id, ev);
    }
    function onUp() { cleanup(); }
    function cleanup() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function enableInlineElementDragging() {
    document.querySelectorAll("#portalMain > [data-block-id]").forEach((section) => {
      if (section.getAttribute("data-canvas-block") === "true") return; // canvas blocks already handle their own elements
      leafContentElements(section).forEach((el) => {
        el.classList.add("le-inline-draggable");
        // Suppress the browser's native "ghost image" drag so it doesn't
        // fight with our own mouse-tracked drag once the threshold trips.
        if (el.tagName === "IMG") el.draggable = false;
      });
      if (section.dataset.inlineDragBound) return;
      section.dataset.inlineDragBound = "true";
      section.addEventListener("mousedown", onInlineElementMouseDown);
    });
  }

  function markSelectedOnCanvas() {
    document.querySelectorAll(".le-selected").forEach((el) => el.classList.remove("le-selected"));
    if (expandedBlockId) {
      const el = document.querySelector('[data-block-id="' + expandedBlockId + '"]');
      if (el) el.classList.add("le-selected");
    }
    if (canvasSelection) mountCanvasHandles(); else removeCanvasHandles();
  }

  function onCanvasClick(e) {
    // Block all interaction when clicking any editor panel
    if (isInAnyPanel(e.target)) return;
    if (e.target.closest("#fcHandles")) return; // handle drag/resize manages its own events
    if (e.target.closest(".de-toolbar")) return; // floating edit toolbar owns its clicks

    // ── Canvas on-block context actions (Edit / Move / Duplicate / Delete) ──
    const ctxBtn = e.target.closest("[data-le-action]");
    if (ctxBtn && e.target.closest(".le-block-ctx")) {
      e.preventDefault();
      e.stopPropagation();
      const action = ctxBtn.dataset.leAction;
      if (action === "ctx-edit-block") {
        selectBlock(ctxBtn.dataset.blockId);
        return;
      }
      if (action === "ctx-move-block-up" || action === "ctx-move-block-down") {
        const i = Number(ctxBtn.dataset.index);
        const blocks = currentPage().blocks;
        const j = action === "ctx-move-block-up" ? i - 1 : i + 1;
        if (j < 0 || j >= blocks.length) return;
        const tmp = blocks[i]; blocks[i] = blocks[j]; blocks[j] = tmp;
        renderPanel(); applyDraft();
        return;
      }
      // duplicate-block / delete-block: delegate to the shared handler
      onPanelClick(e);
      return;
    }

    // Typing into a field: let clicks inside it place the caret normally.
    if (activeEdit && activeEdit.el.contains(e.target)) return;

    // Click straight onto an annotated headline/photo → edit it right there,
    // instead of selecting the block and sending them to the side panel.
    const editEl = e.target.closest("[data-edit]");
    const main = document.getElementById("portalMain");
    if (editEl && main && main.contains(editEl)) {
      e.preventDefault();
      e.stopPropagation();
      startDirectEdit(editEl);
      return;
    }
    if (activeEdit) finishDirectEdit();

    // Freeform canvas blocks route to element-level selection instead of
    // the normal schema-form block editor (canvas blocks declare no schema).
    const canvasSection = e.target.closest('[data-canvas-block="true"]');
    if (canvasSection) {
      e.preventDefault();
      e.stopPropagation();
      const blockId = canvasSection.getAttribute("data-block-id");
      const elWrap = e.target.closest(".fc-el-wrap");
      expandedBlockId = blockId;
      canvasSelection = elWrap ? { blockId, elementId: elWrap.dataset.elId } : null;
      renderPanel();
      markSelectedOnCanvas();
      return;
    }

    // No block clicked and no canvas section — clicking empty canvas closes prop panel
    const blockEl = e.target.closest("[data-block-id]");
    if (!blockEl) {
      if (expandedBlockId) { expandedBlockId = null; canvasSelection = null; renderPanel(); markSelectedOnCanvas(); }
      return;
    }
    // Allow real navigation (nav links, page-nav) to work normally — only
    // intercept clicks that land on/inside a block's own content.
    if (e.target.closest("a[href^='#/']")) return;

    e.preventDefault();
    e.stopPropagation();
    selectBlock(blockEl.getAttribute("data-block-id"));
  }

  function selectBlock(id) {
    expandedBlockId = id;
    canvasSelection = null;
    // Close sub-panels so prop panel has full attention
    ["leBlocksPanel","leDesignPanel","lePagesPanel"].forEach((pid) => {
      const el = document.getElementById(pid); if (el) el.classList.remove("visible");
    });
    ["leCmdBlocks","leCmdDesign","leCmdPages"].forEach((pid) => {
      const el = document.getElementById(pid); if (el) el.classList.remove("active");
    });
    renderPanel();
    markSelectedOnCanvas();
  }

  function findBlockById(id) { return (currentPage().blocks || []).find((b) => b.id === id); }
  function blockIndexOf(id) { return (currentPage().blocks || []).findIndex((b) => b.id === id); }
  function parentAndIndex(path) {
    const parts = path.split(".");
    const idx = Number(parts.pop());
    return { parentPath: parts.join("."), idx };
  }

  /* ================================================================
     PANEL SHELL — futuristic centered floating command bar
     ================================================================ */
  function mountPanel() {
    // ── Bottom command bar (pill) ──────────────────────────────────
    const panel = document.createElement("div");
    panel.className = "le-panel";
    panel.id = "lePanel";
    panel.innerHTML =
      '<button class="le-cmd-btn" id="leUndoBtn" data-le-action="undo" title="Undo (Ctrl+Z)"><span class="le-cmd-icon">↶</span></button>' +
      '<button class="le-cmd-btn" id="leRedoBtn" data-le-action="redo" title="Redo (Ctrl+Shift+Z)"><span class="le-cmd-icon">↷</span></button>' +
      '<div class="le-panel-sep"></div>' +
      '<button class="le-cmd-btn" id="leCmdBlocks" data-le-action="toggle-blocks-panel"><span class="le-cmd-icon">◧</span> Layers</button>' +
      '<button class="le-cmd-btn" id="leCmdDesign" data-le-action="toggle-design-panel"><span class="le-cmd-icon">🎨</span> Design</button>' +
      '<button class="le-cmd-btn" id="leCmdPages" data-le-action="toggle-pages-panel"><span class="le-cmd-icon">📄</span> Pages</button>' +
      '<div class="le-panel-sep"></div>' +
      '<button class="le-cmd-add" data-le-action="open-add-block"><span class="le-cmd-icon">＋</span> Add Block</button>' +
      '<div class="le-panel-sep"></div>' +
      '<button class="le-cmd-disc" data-le-action="discard">Discard</button>' +
      '<button class="le-cmd-pub" data-le-action="publish"><span class="le-cmd-icon">🚀</span> Publish</button>';
    document.body.appendChild(panel);

    // ── Floating property panel (click-to-edit block) ───────────────
    const propPanel = document.createElement("div");
    propPanel.className = "le-prop-panel";
    propPanel.id = "lePropPanel";
    propPanel.innerHTML =
      '<div class="le-prop-header">' +
        '<button class="le-prop-nav-btn" id="lePropPrev" data-le-action="prop-prev-block" title="Previous block">‹</button>' +
        '<span class="le-prop-title" id="lePropTitle">Block Settings</span>' +
        '<button class="le-prop-nav-btn" id="lePropNext" data-le-action="prop-next-block" title="Next block">›</button>' +
        '<button class="le-prop-close" data-le-action="close-block-editor" title="Close">✕</button>' +
      '</div>' +
      '<div class="le-prop-body" id="lePropBody"></div>' +
      '<div class="le-prop-footer" id="lePropFooter"></div>';
    document.body.appendChild(propPanel);

    // ── Floating layers panel ───────────────────────────────────────
    const blocksPanel = document.createElement("div");
    blocksPanel.className = "le-pages-panel";
    blocksPanel.id = "leBlocksPanel";
    blocksPanel.innerHTML =
      '<div class="le-sub-header"><span class="le-sub-title">◧ Layers</span>' +
        '<button class="le-sub-close" data-le-action="close-blocks-panel">✕</button>' +
      '</div>' +
      '<div class="le-sub-body" id="leBlocksPanelBody"></div>';
    document.body.appendChild(blocksPanel);

    // ── Floating design panel ───────────────────────────────────────
    const designPanel = document.createElement("div");
    designPanel.className = "le-design-panel";
    designPanel.id = "leDesignPanel";
    designPanel.innerHTML =
      '<div class="le-sub-header"><span class="le-sub-title">🎨 Design &amp; Theme</span>' +
        '<button class="le-sub-close" data-le-action="close-design-panel">✕</button>' +
      '</div>' +
      '<div class="le-sub-body" id="leDesignPanelBody"></div>';
    document.body.appendChild(designPanel);

    // ── Floating pages panel ────────────────────────────────────────
    const pagesPanel = document.createElement("div");
    pagesPanel.className = "le-pages-panel";
    pagesPanel.id = "lePagesPanel";
    pagesPanel.innerHTML =
      '<div class="le-sub-header"><span class="le-sub-title">📄 Pages</span>' +
        '<button class="le-sub-close" data-le-action="close-pages-panel">✕</button>' +
      '</div>' +
      '<div class="le-sub-body" id="lePagesPanelBody"></div>';
    document.body.appendChild(pagesPanel);

    // ── Event delegation across all panels ─────────────────────────
    [panel, propPanel, blocksPanel, designPanel, pagesPanel].forEach((el) => {
      el.addEventListener("click", onPanelClick);
      el.addEventListener("input", onFieldChange);
      el.addEventListener("change", onFieldChange);
    });

    // Attached to `document` — on-canvas block drag handles live in #portalMain
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragend", onDragEnd);

    renderPanel();
  }

  /* Returns true if any floating sub-panel contains the element */
  function isInAnyPanel(el) {
    const ids = ["lePanel", "lePropPanel", "leBlocksPanel", "leDesignPanel", "lePagesPanel"];
    if (ids.some((id) => { const p = document.getElementById(id); return p && p.contains(el); })) return true;
    // Also catch modals (class-based, not always id-based)
    const modal = document.querySelector(".le-modal-overlay");
    return !!(modal && modal.contains(el));
  }

  function renderPanel() {
    renderPropPanel();
    // Only update visible sub-panels to avoid wasted re-renders
    const blocksP = document.getElementById("leBlocksPanel");
    const designP = document.getElementById("leDesignPanel");
    const pagesP  = document.getElementById("lePagesPanel");
    if (blocksP && blocksP.classList.contains("visible")) renderBlocksFloating();
    if (designP && designP.classList.contains("visible")) renderDesignFloating();
    if (pagesP  && pagesP.classList.contains("visible"))  renderPagesFloating();
    updateHistoryButtons();
  }

  /* ================================================================
     FLOATING PANEL RENDERERS
     ================================================================ */
  function currentPage() { return draftConfig.pages[activePage] || draftConfig.pages.main; }

  /* ── Layers / blocks floating panel ────────────────────────────── */
  function renderBlocksFloating() {
    const body = document.getElementById("leBlocksPanelBody");
    if (!body) return;
    const page = currentPage();
    const blocks = page.blocks || [];
    body.innerHTML =
      '<div class="le-group">' +
        '<span class="le-section-title">Sections — ' + esc(page.title || activePage) + '</span>' +
        '<div class="le-layer-list">' +
          (blocks.map((b, i) => renderLayerRow(b, i)).join('') || '<div class="le-muted-note">Nothing on this page yet — add a section below.</div>') +
        '</div>' +
        '<button type="button" class="le-btn-add-block" data-le-action="open-add-block">＋ Add Section</button>' +
      '</div>';
  }

  /* ── Design floating panel ──────────────────────────────────────── */
  function renderDesignFloating() {
    const body = document.getElementById("leDesignPanelBody");
    if (!body) return;
    body.innerHTML = renderDesignTab();
  }

  /* ── Pages floating panel ───────────────────────────────────────── */
  function renderPagesFloating() {
    const body = document.getElementById("lePagesPanelBody");
    if (!body) return;
    body.innerHTML = renderPagesTab();
  }

  /* ── Property panel (appears when a block is selected) ──────────── */
  function renderPropPanel() {
    const panel = document.getElementById("lePropPanel");
    const titleEl = document.getElementById("lePropTitle");
    const body = document.getElementById("lePropBody");
    if (!panel || !body) return;

    if (!expandedBlockId) {
      panel.classList.remove("visible");
      return;
    }

    const blocks = currentPage().blocks || [];
    const idx = blocks.findIndex((b) => b.id === expandedBlockId);
    if (idx === -1) { panel.classList.remove("visible"); return; }

    const b = blocks[idx];
    const meta = window.PortalBlocks[b.type];
    if (!meta) { panel.classList.remove("visible"); return; }

    // ── Category badge color ─────────────────────────────────────
    const CATEGORY_COLORS = {
      "Header": "#38bdf8", "Content": "#a78bfa", "Commerce": "#34d399",
      "Forms": "#fb923c", "Social proof": "#f472b6", "Interactive": "#facc15",
      "Footer": "#94a3b8", "Logistics": "#1aa6df", "Media": "#c084fc"
    };
    const catColor = CATEGORY_COLORS[meta.category] || "#64748b";

    // ── Title: block type badge + position counter ──────────────
    if (titleEl) {
      titleEl.innerHTML =
        '<span class="le-prop-title-badge" style="background:' + catColor + '22;color:' + catColor + ';border:1px solid ' + catColor + '44">' + esc(meta.label || b.type) + '</span>' +
        '<span class="le-prop-pos">' + (idx + 1) + ' / ' + blocks.length + '</span>';
    }

    // ── Navigation buttons (← →) in header ─────────────────────
    const prevBtn = document.getElementById("lePropPrev");
    const nextBtn = document.getElementById("lePropNext");
    if (prevBtn) prevBtn.disabled = idx === 0;
    if (nextBtn) nextBtn.disabled = idx === blocks.length - 1;

    // ── Body fields ─────────────────────────────────────────────
    if (b.type === "canvas") {
      body.innerHTML = renderCanvasBlockEditorBody(b, idx);
    } else {
      const basePath = "pages." + activePage + ".blocks." + idx + ".props";
      const groups = meta.fieldGroups;
      if (groups && groups.length) {
        // ── Grouped, collapsible sections per block type ────────
        const schemaMap = {};
        (meta.schema || []).forEach(function (f) { schemaMap[f.key] = f; });
        body.innerHTML = groups.map(function (g, gi) {
          const groupFields = (g.keys || []).map(function (k) {
            var f = schemaMap[k];
            return f ? renderField(f, basePath + "." + f.key) : "";
          }).join("");
          if (!groupFields) return "";
          return '<div class="le-prop-group' + (gi === 0 ? ' is-open' : '') + '" data-le-group-idx="' + gi + '">' +
            '<button type="button" class="le-prop-group-header" data-le-action="toggle-group" data-group="' + gi + '">' +
              '<span class="le-prop-group-icon">' + (g.icon || "⚙️") + '</span>' +
              '<span class="le-prop-group-label">' + esc(g.label) + '</span>' +
              '<span class="le-prop-group-chevron">›</span>' +
            '</button>' +
            '<div class="le-prop-group-body">' + groupFields + '</div>' +
          '</div>';
        }).join("");
      } else {
        body.innerHTML =
          '<div class="le-group">' +
            (meta.schema || []).map(function (f) { return renderField(f, basePath + "." + f.key); }).join('') +
          '</div>';
      }
    }

    // ── Footer quick actions ─────────────────────────────────────
    const footer = document.getElementById("lePropFooter");
    if (footer) {
      footer.innerHTML =
        '<button class="le-prop-foot-btn" data-le-action="ctx-move-block-up" data-index="' + idx + '" ' + (idx === 0 ? "disabled" : "") + ' title="Move up">↑ Move up</button>' +
        '<button class="le-prop-foot-btn" data-le-action="ctx-move-block-down" data-index="' + idx + '" ' + (idx === blocks.length - 1 ? "disabled" : "") + ' title="Move down">↓ Move down</button>' +
        '<div style="flex:1"></div>' +
        '<button class="le-prop-foot-btn" data-le-action="duplicate-block" data-index="' + idx + '" title="Duplicate">⧉</button>' +
        '<button class="le-prop-foot-btn danger" data-le-action="delete-block" data-index="' + idx + '" title="Delete">✕ Delete</button>';
    }

    panel.classList.add("visible");
  }

  function renderLayerRow(b, i) {
    const meta = window.PortalBlocks[b.type] || { label: b.type };
    const selected = b.id === expandedBlockId;
    return '<div class="le-layer-row' + (selected ? " selected" : "") + '" draggable="true" data-role="layer-row" data-index="' + i + '" data-block-id="' + esc(b.id) + '" data-le-action="select-block">' +
      '<span class="le-layer-drag">⠿</span>' +
      '<span class="le-layer-label">' + esc(meta.label || b.type) + "</span>" +
      '<span class="le-layer-controls">' +
        '<button type="button" data-le-action="duplicate-block" data-index="' + i + '" title="Duplicate">⧉</button>' +
        '<button type="button" data-le-action="delete-block" data-index="' + i + '" title="Delete">✕</button>' +
      "</span>" +
      "</div>";
  }

  /* ── Kept for backward compat (used nowhere in new UI, but action handlers call it) ── */
  function renderBlockEditor(blocks) {
    return ""; // handled by renderPropPanel now
  }

  /* ================================================================
     FREEFORM CANVAS BLOCK EDITOR BODY
     ================================================================ */
  function renderCanvasBlockEditorBody(b, idx) {
    const basePath = "pages." + activePage + ".blocks." + idx + ".props";
    const elements = b.props.elements || [];
    let html = '<div class="le-group">' +
      '<span class="le-section-title">Canvas View</span>' +
      '<div class="le-field"><label>Viewing as</label><div class="le-bp-toggle">' +
        '<button type="button" class="le-bp-btn' + (activeBreakpoint === "desktop" ? " active" : "") + '" data-le-action="set-breakpoint" data-bp="desktop">🖥 Desktop</button>' +
        '<button type="button" class="le-bp-btn' + (activeBreakpoint === "mobile" ? " active" : "") + '" data-le-action="set-breakpoint" data-bp="mobile">📱 Mobile</button>' +
      '</div></div>' +
      renderField({ label: "Height", type: "number" }, basePath + ".minHeight") +
      renderField({ label: "Background color", type: "text" }, basePath + ".background.color") +
      fieldWrap("Background image", imageFieldHtml(basePath + ".background.image", (b.props.background || {}).image)) +
    '</div>' +
    '<div class="le-group">' +
      '<span class="le-section-title">Add to Canvas</span>' +
      '<div class="le-add-el-row">' +
        '<button type="button" data-le-action="add-element" data-kind="text">＋ Text</button>' +
        '<button type="button" data-le-action="add-element" data-kind="image">＋ Image</button>' +
        '<button type="button" data-le-action="add-element" data-kind="button">＋ Button</button>' +
        '<button type="button" data-le-action="add-element" data-kind="box">＋ Box</button>' +
      '</div>' +
    '</div>';

    if (canvasSelection && canvasSelection.blockId === b.id) {
      const elIdx = elements.findIndex((e2) => e2.id === canvasSelection.elementId);
      if (elIdx > -1) html += renderCanvasElementEditor(idx, elements[elIdx], elIdx, elements);
    } else {
      html += '<div class="le-muted-note" style="padding:4px 0">Click any element on the page to edit or move it.</div>';
    }

    return html;
  }

  function renderCanvasElementEditor(blockIdx, el, elIdx, elements) {
    if (activeBreakpoint === "mobile") promoteMobileRect(el, elements, elIdx);

    const basePath = "pages." + activePage + ".blocks." + blockIdx + ".props.elements." + elIdx;
    const posPath = basePath + "." + activeBreakpoint;

    // ── Kind-specific icon, label, and grouped fields ───────────
    const KIND_META = {
      text:   { icon: "✏️", label: "Text Element",   color: "#a78bfa" },
      image:  { icon: "🖼", label: "Image Element",  color: "#38bdf8" },
      button: { icon: "🔗", label: "Button Element", color: "#34d399" },
      box:    { icon: "⬜", label: "Box Element",    color: "#fb923c" },
      widget: { icon: "⚡", label: "Live Form",      color: "#facc15" }
    };
    const km = KIND_META[el.kind] || { icon: "⚙️", label: el.kind, color: "#64748b" };

    var contentFields = "";
    var styleFields = "";

    if (el.kind === "text") {
      contentFields = renderField({ label: "Text", type: "textarea" }, basePath + ".content.text");
      styleFields = renderField({ label: "Text Color", type: "color" }, basePath + ".content.color");
    } else if (el.kind === "image") {
      contentFields = fieldWrap("Image", imageFieldHtml(basePath + ".content.src", el.content.src)) +
        renderField({ label: "Alt text", type: "text" }, basePath + ".content.alt");
    } else if (el.kind === "button") {
      contentFields = renderField({ label: "Label", type: "text" }, basePath + ".content.label");
      styleFields = renderField({ label: "Background Color", type: "color" }, basePath + ".content.bgColor") +
        renderField({ label: "Text Color", type: "color" }, basePath + ".content.textColor");
      contentFields += renderField({ label: "Action", type: "action-select" }, basePath + ".content.action") +
        renderField({ label: "Action target", type: "action-target" }, basePath + ".content.target");
    } else if (el.kind === "widget") {
      contentFields = '<div class="le-muted-note">This is a live form widget. Drag or resize it — to edit its content, interact with it directly on the page.</div>';
    } else {
      styleFields = renderField({ label: "Background Color", type: "color" }, basePath + ".content.color") +
        fieldWrap("Background image", imageFieldHtml(basePath + ".content.image", el.content.image));
    }

    // Build collapsible groups for canvas elements
    var groups = '';

    // Content group
    if (contentFields) {
      groups += '<div class="le-prop-group is-open">' +
        '<button type="button" class="le-prop-group-header" data-le-action="toggle-group" data-group="ce-content">' +
          '<span class="le-prop-group-icon">' + km.icon + '</span>' +
          '<span class="le-prop-group-label">Content</span>' +
          '<span class="le-prop-group-chevron">›</span>' +
        '</button>' +
        '<div class="le-prop-group-body">' + contentFields + '</div>' +
      '</div>';
    }

    // Style group
    if (styleFields) {
      groups += '<div class="le-prop-group is-open">' +
        '<button type="button" class="le-prop-group-header" data-le-action="toggle-group" data-group="ce-style">' +
          '<span class="le-prop-group-icon">🎨</span>' +
          '<span class="le-prop-group-label">Style</span>' +
          '<span class="le-prop-group-chevron">›</span>' +
        '</button>' +
        '<div class="le-prop-group-body">' + styleFields + '</div>' +
      '</div>';
    }

    // Position group
    groups += '<div class="le-prop-group">' +
      '<button type="button" class="le-prop-group-header" data-le-action="toggle-group" data-group="ce-pos">' +
        '<span class="le-prop-group-icon">📐</span>' +
        '<span class="le-prop-group-label">Position & Size (' + activeBreakpoint + ')</span>' +
        '<span class="le-prop-group-chevron">›</span>' +
      '</button>' +
      '<div class="le-prop-group-body">' +
        '<div class="le-pos-row">' +
          renderField({ label: "X", type: "number" }, posPath + ".x") +
          renderField({ label: "Y", type: "number" }, posPath + ".y") +
          renderField({ label: "W", type: "number" }, posPath + ".w") +
          renderField({ label: "H", type: "number" }, posPath + ".h") +
        '</div>' +
        '<div class="le-flex-row">' +
          '<button type="button" data-le-action="element-front" data-path="' + basePath + '">Front</button>' +
          '<button type="button" data-le-action="element-back" data-path="' + basePath + '">Back</button>' +
          '<button type="button" data-le-action="duplicate-element" data-path="' + basePath + '">Duplicate</button>' +
          '<button type="button" data-le-action="delete-element" data-path="' + basePath + '">Delete</button>' +
        '</div>' +
      '</div>' +
    '</div>';

    return '<div class="le-canvas-el-header" style="border-left:3px solid ' + km.color + '">' +
      '<span class="le-prop-group-icon">' + km.icon + '</span>' +
      '<span>' + esc(km.label) + '</span>' +
    '</div>' + groups;
  }

  /* ================================================================
     FIELD RENDERING (shared by block editor + list items)
     ================================================================ */
  function fieldWrap(label, inner) {
    return '<div class="le-field"><label>' + esc(label) + "</label>" + inner + "</div>";
  }

  function renderField(field, path) {
    const val = getByPath(draftConfig, path);
    switch (field.type) {
      case "textarea":
        return fieldWrap(field.label, '<textarea class="le-input" rows="3" data-path="' + path + '" data-type="text">' + esc(val || "") + "</textarea>");
      case "number":
        return fieldWrap(field.label, '<input class="le-input" type="number" data-path="' + path + '" data-type="number" value="' + (val != null ? val : "") + '"' + (field.min != null ? ' min="' + field.min + '"' : "") + (field.max != null ? ' max="' + field.max + '"' : "") + ">");
      case "boolean":
        return fieldWrap(field.label, '<input type="checkbox" data-path="' + path + '" data-type="boolean" ' + (val ? "checked" : "") + ">");
      case "select":
        return fieldWrap(field.label, '<select class="le-select" data-path="' + path + '" data-type="text">' + (field.options || []).map((o) => '<option value="' + escAttr(o) + '"' + (o === val ? " selected" : "") + ">" + esc(o) + "</option>").join("") + "</select>");
      case "image":
        return fieldWrap(field.label, imageFieldHtml(path, val));
      case "color":
        return fieldWrap(field.label, colorFieldHtml(path, val));
      case "action-select":
        return fieldWrap(field.label, '<select class="le-select" data-path="' + path + '" data-type="text">' + ACTION_OPTIONS.map((o) => '<option value="' + o.value + '"' + (o.value === (val || "none") ? " selected" : "") + ">" + o.label + "</option>").join("") + "</select>");
      case "action-target":
        return fieldWrap(field.label, actionTargetHtml(path));
      case "list":
        return fieldWrap(field.label, listFieldHtml(field, path));
      case "text":
      default:
        return fieldWrap(field.label, '<input class="le-input" data-path="' + path + '" data-type="text" value="' + escAttr(val || "") + '">');
    }
  }

  function imageFieldHtml(path, val) {
    const preview = '<img class="le-img-preview" src="' + escAttr(val || "") + '" onerror="this.style.visibility=\'hidden\'">';
    const input = '<input class="le-input" style="flex:1" data-path="' + path + '" data-type="text" placeholder="https://…" value="' + escAttr(val || "") + '">';
    const upload = '<button type="button" class="le-upload-btn" data-le-action="upload-image" data-path="' + path + '">⬆ Upload from your device</button>';
    const presets = '<div class="le-presets-grid">' + IMAGE_PRESETS.map((u) => '<div class="le-preset-item" data-le-action="pick-image" data-path="' + path + '" data-url="' + escAttr(u) + '"><img src="' + u + '"></div>').join("") + "</div>";
    return '<div class="le-img-preview-row">' + preview + input + "</div>" + upload + presets;
  }

  /* ---- device image upload ------------------------------------------
     Images are stored inline in the storefront config (there is no media
     server), so every upload is re-encoded down to a sane web size first
     — a 6 MB phone photo becomes a ~150 KB JPEG. Without this a couple of
     slideshow uploads would blow past the API's request body limit.
     ------------------------------------------------------------------- */
  const UPLOAD_MAX_W = 1600;
  const UPLOAD_MAX_H = 1200;
  const UPLOAD_QUALITY = 0.82;

  function pickImageFiles(multiple) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      if (multiple) input.multiple = true;
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", () => {
        const files = Array.prototype.slice.call(input.files || []);
        document.body.removeChild(input);
        resolve(files);
      });
      input.click();
    });
  }

  function fileToScaledDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error("Not an image"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read the file"));
      reader.onload = () => {
        const im = new Image();
        im.onerror = () => reject(new Error("Could not decode the image"));
        im.onload = () => {
          const ratio = Math.min(1, UPLOAD_MAX_W / im.width, UPLOAD_MAX_H / im.height);
          const w = Math.round(im.width * ratio);
          const h = Math.round(im.height * ratio);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const cx = canvas.getContext("2d");
          // JPEG has no alpha — paint white first so transparent PNGs don't
          // come out with a black background.
          cx.fillStyle = "#fff";
          cx.fillRect(0, 0, w, h);
          cx.drawImage(im, 0, 0, w, h);
          try { resolve(canvas.toDataURL("image/jpeg", UPLOAD_QUALITY)); }
          catch (err) { reject(err); }
        };
        im.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* Swatch + hex text pair bound to the same path — same pattern as the
     Design tab's accent-color control; onFieldChange already keeps any
     two controls sharing a data-path in sync (see the color-swatch sync
     block below), so no special-casing is needed here. */
  function colorFieldHtml(path, val) {
    const v = val || "#111111";
    return '<div class="le-color-row">' +
      '<input type="color" class="le-color-picker" data-path="' + path + '" data-type="text" value="' + escAttr(v) + '">' +
      '<input class="le-input" style="flex:1" data-path="' + path + '" data-type="text" value="' + escAttr(v) + '">' +
      "</div>";
  }

  /* action-target's control depends on the sibling action field's current value */
  function actionTargetHtml(path) {
    const parts = path.split(".");
    const lastKey = parts.pop();
    const actionKey = lastKey === "target" ? "action" : lastKey.replace(/Target$/, "Action");
    const actionPath = parts.concat(actionKey).join(".");
    const actionVal = getByPath(draftConfig, actionPath) || "none";
    const cur = getByPath(draftConfig, path) || "";

    if (actionVal === "scroll") {
      const blocks = currentPage().blocks || [];
      return '<select class="le-select" data-path="' + path + '" data-type="text"><option value="">Choose a block…</option>' +
        blocks.map((b) => '<option value="' + b.id + '"' + (b.id === cur ? " selected" : "") + ">" + esc((window.PortalBlocks[b.type] || {}).label || b.type) + "</option>").join("") + "</select>";
    }
    if (actionVal === "page") {
      const slugs = Object.keys(draftConfig.pages || {});
      return '<select class="le-select" data-path="' + path + '" data-type="text"><option value="">Choose a page…</option>' +
        slugs.map((s) => '<option value="' + s + '"' + (s === cur ? " selected" : "") + ">" + esc(draftConfig.pages[s].title || s) + "</option>").join("") + "</select>";
    }
    if (actionVal === "link") {
      return '<input class="le-input" data-path="' + path + '" data-type="text" placeholder="https://example.com" value="' + escAttr(cur) + '">';
    }
    return '<div class="le-muted-note">No target needed for this action.</div>';
  }

  /* generic repeatable list editor — also used recursively for nested lists (e.g. footer columns → links) */
  function listFieldHtml(field, path) {
    const items = getByPath(draftConfig, path) || [];
    const isScalar = field.itemSchema.length === 1 && field.itemSchema[0].key === "value";
    const rows = items.map((item, i) => {
      const itemPath = path + "." + i;
      const inner = isScalar
        ? renderField({ key: "value", label: field.itemSchema[0].label, type: "text" }, itemPath)
        : field.itemSchema.map((sf) => renderField(sf, itemPath + "." + sf.key)).join("");
      return '<div class="le-list-item">' +
        '<div class="le-list-item-toolbar">' +
          '<span class="le-list-item-index">#' + (i + 1) + "</span>" +
          '<div class="le-list-item-actions">' +
            '<button type="button" data-le-action="move-item-up" data-path="' + path + '" data-index="' + i + '" title="Move up">↑</button>' +
            '<button type="button" data-le-action="move-item-down" data-path="' + path + '" data-index="' + i + '" title="Move down">↓</button>' +
            '<button type="button" class="le-list-item-delete" data-le-action="remove-item" data-path="' + path + '" data-index="' + i + '" title="Remove">🗑</button>' +
          "</div>" +
        "</div>" +
        '<div class="le-list-item-body">' + inner + "</div>" +
        "</div>";
    }).join("");
    // Lists whose items carry an image (slideshow slides, lookbook cards)
    // also get a bulk uploader that turns each picked file into one item.
    const imageField = field.itemSchema.find((sf) => sf.type === "image");
    const bulk = imageField
      ? '<button type="button" class="le-btn-add-item le-btn-bulk-upload" data-le-action="upload-images-multi" data-path="' + path + '" data-image-key="' + imageField.key + '">⬆ Upload images from your device</button>'
      : "";
    return '<div class="le-list" data-list-path="' + path + '">' + (rows || '<div class="le-muted-note">Nothing here yet — add your first one below.</div>') +
      bulk +
      '<button type="button" class="le-btn-add-item" data-le-action="add-item" data-path="' + path + '" data-scalar="' + isScalar + '">＋ Add</button></div>';
  }

  function blankListItem(field) {
    if (field.itemSchema.length === 1 && field.itemSchema[0].key === "value") return "";
    const item = {};
    field.itemSchema.forEach((sf) => {
      item[sf.key] = sf.type === "number" ? 0 : sf.type === "action-select" ? "none" : sf.type === "list" ? [] : "";
    });
    return item;
  }

  function findFieldByPath(path) {
    // Walk the schema tree that produced `path` to find the matching field def (needed to build a blank item on "add").
    const parts = path.split(".");
    // path looks like: pages.<slug>.blocks.<i>.props.<key>[.<idx>.<key>]...
    const propsIdx = parts.indexOf("props");
    if (propsIdx === -1) return null;
    const blockIdx = Number(parts[propsIdx - 1]);
    const slug = parts[1];
    const block = draftConfig.pages[slug].blocks[blockIdx];
    let schema = (window.PortalBlocks[block.type] || {}).schema || [];
    let field = null;
    for (let i = propsIdx + 1; i < parts.length; i++) {
      const key = parts[i];
      field = schema.find((f) => f.key === key);
      if (!field) return null;
      if (/^\d+$/.test(parts[i + 1] || "")) { i++; schema = field.itemSchema || []; }
    }
    return field;
  }

  /* ================================================================
     DESIGN TAB
     ================================================================ */
  const NAV_ITEM_LABELS = { brand: "Brand / Logo", links: "Page Links", actions: "Search + Cart" };

  function renderDesignTab() {
    const theme = draftConfig.theme || (draftConfig.theme = {});
    const portalUrl = location.origin + "/portal/" + wsId;
    const navItems = (draftConfig.nav && draftConfig.nav.items) || ["brand", "links", "actions"];
    return '<div class="le-group">' +
      '<span class="le-section-title">Brand & Theme</span>' +
      '<div class="le-field"><label>Brand Name</label><input class="le-input" data-path="brandName" data-type="text" value="' + escAttr(draftConfig.brandName || "") + '"></div>' +
      '<div class="le-field"><label>Accent Color</label><div class="le-color-row">' +
        '<input type="color" class="le-color-picker" data-path="theme.accentColor" data-type="text" value="' + escAttr(theme.accentColor || "#111111") + '">' +
        '<input class="le-input" style="flex:1" data-path="theme.accentColor" data-type="text" value="' + escAttr(theme.accentColor || "#111111") + '">' +
      "</div></div>" +
      "</div>" +
      '<div class="le-group"><span class="le-section-title">Navbar Order</span>' +
      '<div class="le-muted-note">Drag to reorder the brand, page links, and search/cart within the navbar.</div>' +
      '<div class="le-layer-list">' +
      navItems.map((key, i) => '<div class="le-layer-row" draggable="true" data-role="nav-item-row" data-index="' + i + '"><span class="le-layer-drag">⠿</span><span class="le-layer-label">' + esc(NAV_ITEM_LABELS[key] || key) + "</span></div>").join("") +
      "</div></div>" +
      '<div class="le-group"><span class="le-section-title">Storefront Link</span>' +
      '<div class="le-field"><code style="font-size:.76rem;word-break:break-all">' + esc(portalUrl) + "</code></div></div>";
  }

  /* ================================================================
     PAGES TAB
     ================================================================ */
  function renderPagesTab() {
    const pages = draftConfig.pages || {};
    const order = (draftConfig.navOrder || Object.keys(pages)).filter((s) => pages[s]);
    return '<div class="le-group">' +
      '<span class="le-section-title">Pages</span>' +
      '<div class="le-page-list">' +
      order.map((slug) => '<div class="le-page-row' + (slug === activePage ? " selected" : "") + '" data-le-action="switch-page" data-slug="' + slug + '">' +
        "<span>" + esc(pages[slug].title || slug) + "</span>" +
        (slug !== "main" ? '<button type="button" data-le-action="delete-page" data-slug="' + slug + '" title="Delete page">✕</button>' : '<span class="le-muted-note">Home</span>') +
        "</div>").join("") +
      "</div>" +
      '<button type="button" class="le-btn-add-block" data-le-action="open-new-page">＋ New Page</button>' +
      "</div>";
  }

  /* ================================================================
     ADD-BLOCK PICKER MODAL
     ================================================================ */
  function openAddBlockModal() {
    const byCategory = {};
    Object.keys(window.PortalBlocks).forEach((type) => {
      const meta = window.PortalBlocks[type];
      byCategory[meta.category || "Other"] = byCategory[meta.category || "Other"] || [];
      byCategory[meta.category || "Other"].push({ type, label: meta.label });
    });

    const overlay = document.createElement("div");
    overlay.className = "le-modal-overlay";
    overlay.id = "leModalOverlay";
    overlay.innerHTML = '<div class="le-modal">' +
      '<div class="le-modal-hd"><span class="le-modal-title">Add a Block</span><button class="le-modal-close" data-le-action="close-modal">✕</button></div>' +
      '<div class="le-modal-body">' +
      Object.keys(byCategory).map((cat) =>
        '<div><span class="le-section-title">' + esc(cat) + "</span>" +
        '<div class="le-page-list">' +
        byCategory[cat].map((t) => '<div class="le-page-row" data-le-action="pick-block-type" data-block-type="' + t.type + '"><span>' + esc(t.label) + "</span></div>").join("") +
        "</div></div>"
      ).join("") +
      "</div></div>";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
      const action = e.target.closest("[data-le-action]");
      if (!action) return;
      const act = action.dataset.leAction;
      if (act === "close-modal") overlay.remove();
      else if (act === "pick-block-type") { addBlock(action.dataset.blockType); overlay.remove(); }
    });
  }

  function addBlock(type) {
    const meta = window.PortalBlocks[type];
    if (!meta) return;
    const block = { id: window.genBlockId(), type, props: JSON.parse(JSON.stringify(meta.defaultProps || {})) };
    currentPage().blocks = currentPage().blocks || [];
    currentPage().blocks.push(block);
    expandedBlockId = block.id;
    renderPanel();
    applyDraft();
  }

  /* ================================================================
     DIRECT ON-PAGE EDITING
     ----------------------------------------------------------------
     Click a headline and type it. Click a photo and pick a new one.
     A small toolbar floats next to whatever you selected with the few
     controls that actually matter (size, alignment, color, duplicate,
     delete) — no hunting through a form for the matching field.

     It's generic: it works off the `data-edit="propPath"` attributes
     the blocks stamp onto their own output (see `ed()` in blocks.js),
     so a block becomes directly editable the moment it's annotated,
     with no editor code per block type.
     ================================================================ */
  let activeEdit = null; // { el, path, textBefore }

  /* element → the full draftConfig path its content came from */
  function editPathFor(el) {
    const section = el.closest("#portalMain > [data-block-id]");
    if (!section) return null;
    const blocks = currentPage().blocks || [];
    const idx = blocks.findIndex((b) => b.id === section.getAttribute("data-block-id"));
    if (idx === -1) return null;
    return "pages." + activePage + ".blocks." + idx + ".props." + el.getAttribute("data-edit");
  }

  function isImageTarget(el) {
    return el.tagName === "IMG" || el.classList.contains("gb-ss-empty");
  }

  /* Marks annotated nodes so they get a hover affordance, and wires the
     drag-a-photo-from-your-desktop drop target. Click handling itself is
     centralized in onCanvasClick (capture phase intercepts everything on
     the page, so per-element click listeners would never fire). */
  function enableDirectEditing() {
    const main = document.getElementById("portalMain");
    if (!main) return;
    main.querySelectorAll("[data-edit]").forEach((el) => {
      el.classList.add(isImageTarget(el) ? "de-image" : "de-text");
      if (el.dataset.deBound) return;
      el.dataset.deBound = "1";
      if (!isImageTarget(el)) return;
      el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("de-drop"); });
      el.addEventListener("dragleave", () => el.classList.remove("de-drop"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("de-drop");
        const file = (e.dataTransfer.files || [])[0];
        const path = editPathFor(el);
        if (!file || !path) return;
        fileToScaledDataUrl(file)
          .then((url) => { pushHistory("drop:" + path); setByPath(draftConfig, path, url); renderPanel(); applyDraft(); toast("Photo updated."); })
          .catch(() => toast("Sorry, that image could not be used."));
      });
    });
  }

  function startDirectEdit(el) {
    const path = editPathFor(el);
    if (!path) return;
    if (activeEdit && activeEdit.el !== el) finishDirectEdit();

    if (isImageTarget(el)) {
      pickImageFiles(false).then((files) => {
        if (!files.length) return;
        return fileToScaledDataUrl(files[0]).then((url) => {
          pushHistory("img:" + path);
          setByPath(draftConfig, path, url);
          renderPanel(); applyDraft();
          toast("Photo updated — remember to Publish.");
        });
      }).catch(() => toast("Sorry, that image could not be used."));
      return;
    }

    activeEdit = { el, path, textBefore: el.textContent };
    el.setAttribute("contenteditable", "plaintext-only");
    el.classList.add("de-editing");
    el.focus();
    // Put the caret where they clicked rather than selecting everything —
    // people usually want to tweak a word, not retype the line.
    el.addEventListener("blur", finishDirectEdit, { once: true });
    el.addEventListener("keydown", onDirectEditKey);
    showEditToolbar(el, path);
  }

  function onDirectEditKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.target.blur(); return; }
    // Enter commits instead of inserting a newline — these are headlines and
    // labels, not paragraphs. Shift+Enter still breaks the line.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
  }

  function finishDirectEdit() {
    if (!activeEdit) return;
    const { el, path, textBefore } = activeEdit;
    activeEdit = null;
    const text = el.textContent.trim();
    el.removeAttribute("contenteditable");
    el.classList.remove("de-editing");
    el.removeEventListener("keydown", onDirectEditKey);
    hideEditToolbar();
    if (text === textBefore.trim()) return; // nothing actually changed
    pushHistory("text:" + path, textBefore);
    setByPath(draftConfig, path, text);
    renderPanel();
    applyDraft();
  }

  /* ---- floating toolbar ---- */
  const TOOLBAR_ID = "deToolbar";

  function listContextFor(path) {
    // "….props.slides.2.title" → the array path + index, so the toolbar can
    // offer Duplicate/Delete on the slide/card the text belongs to.
    const m = path.match(/^(.*)\.(\d+)\.[^.]+$/);
    return m ? { arrayPath: m[1], index: Number(m[2]) } : null;
  }

  function showEditToolbar(el, path) {
    let bar = document.getElementById(TOOLBAR_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = TOOLBAR_ID;
      bar.className = "de-toolbar";
      document.body.appendChild(bar);
      // mousedown (not click) so the toolbar acts before the editable
      // element's blur tears everything down.
      bar.addEventListener("mousedown", onToolbarMouseDown);
    }
    const list = listContextFor(path);
    bar.dataset.path = path;
    bar.innerHTML =
      '<button type="button" data-de="smaller" title="Smaller">A−</button>' +
      '<button type="button" data-de="bigger" title="Bigger">A+</button>' +
      '<span class="de-sep"></span>' +
      '<button type="button" data-de="align-left" title="Align left">⌫</button>' +
      '<button type="button" data-de="align-center" title="Center">≡</button>' +
      '<button type="button" data-de="align-right" title="Align right">⌦</button>' +
      '<span class="de-sep"></span>' +
      '<label class="de-color" title="Text color"><input type="color" data-de="color"><span></span></label>' +
      (list ? '<span class="de-sep"></span>' +
        '<button type="button" data-de="dup-item" title="Duplicate this one">⧉</button>' +
        '<button type="button" data-de="del-item" title="Delete this one">🗑</button>' : "") +
      '<span class="de-sep"></span>' +
      '<button type="button" data-de="more" title="All options">⋯</button>';
    positionToolbar(bar, el);
  }

  function positionToolbar(bar, el) {
    const r = el.getBoundingClientRect();
    bar.style.visibility = "hidden";
    bar.style.display = "flex";
    const bw = bar.offsetWidth || 300;
    const top = r.top + window.scrollY - bar.offsetHeight - 10;
    bar.style.top = Math.max(window.scrollY + 8, top) + "px";
    bar.style.left = Math.min(
      Math.max(8, r.left + r.width / 2 - bw / 2),
      window.innerWidth - bw - 8
    ) + "px";
    bar.style.visibility = "visible";
  }

  function hideEditToolbar() {
    const bar = document.getElementById(TOOLBAR_ID);
    if (bar) bar.style.display = "none";
  }

  /* Style tweaks (size/align/color) have no matching prop on most blocks —
     a hero title's color comes from CSS, not from `props`. They're stored
     as a per-field override map on the block and replayed after render by
     generic-renderer.js, so the published site shows them too. */
  function setStyleOverride(path, patch) {
    const m = path.match(/^(pages\.[^.]+\.blocks\.\d+\.props)\.(.+)$/);
    if (!m) return;
    const stylesPath = m[1] + ".__styles";
    const styles = getByPath(draftConfig, stylesPath) || {};
    styles[m[2]] = Object.assign({}, styles[m[2]], patch);
    setByPath(draftConfig, stylesPath, styles);
  }

  function onToolbarMouseDown(e) {
    const btn = e.target.closest("[data-de]");
    if (!btn) return;
    const action = btn.dataset.de;
    if (action === "color") return; // handled on input, below
    e.preventDefault(); // keep focus in the editable element
    const bar = document.getElementById(TOOLBAR_ID);
    const path = bar.dataset.path;
    const el = activeEdit && activeEdit.el;

    if (action === "bigger" || action === "smaller") {
      const cur = parseFloat(el ? getComputedStyle(el).fontSize : "16") || 16;
      const next = Math.max(10, Math.min(120, cur + (action === "bigger" ? 2 : -2)));
      pushHistory("size:" + path);
      setStyleOverride(path, { fontSize: next + "px" });
      if (el) el.style.fontSize = next + "px"; // instant feedback, no re-render
      commitSnapshot();
      positionToolbar(bar, el);
      return;
    }
    if (action.startsWith("align-")) {
      const align = action.slice(6);
      pushHistory("align:" + path);
      setStyleOverride(path, { textAlign: align });
      if (el) el.style.textAlign = align;
      commitSnapshot();
      return;
    }
    if (action === "dup-item" || action === "del-item") {
      const list = listContextFor(path);
      if (!list) return;
      const arr = getByPath(draftConfig, list.arrayPath) || [];
      pushHistory(action + ":" + path + ":" + Date.now());
      if (action === "dup-item") arr.splice(list.index + 1, 0, JSON.parse(JSON.stringify(arr[list.index])));
      else arr.splice(list.index, 1);
      setByPath(draftConfig, list.arrayPath, arr);
      activeEdit = null;
      hideEditToolbar();
      renderPanel(); applyDraft();
      toast(action === "dup-item" ? "Duplicated." : "Removed.");
      return;
    }
    if (action === "more") {
      const section = el && el.closest("#portalMain > [data-block-id]");
      activeEdit = null;
      hideEditToolbar();
      if (section) selectBlock(section.getAttribute("data-block-id"));
      return;
    }
  }

  document.addEventListener("input", (e) => {
    if (!e.target.matches || !e.target.matches('#' + TOOLBAR_ID + ' [data-de="color"]')) return;
    const bar = document.getElementById(TOOLBAR_ID);
    const el = activeEdit && activeEdit.el;
    pushHistory("color:" + bar.dataset.path);
    setStyleOverride(bar.dataset.path, { color: e.target.value });
    if (el) el.style.color = e.target.value;
    commitSnapshot();
  });

  /* ================================================================
     UNDO / REDO
     ----------------------------------------------------------------
     Snapshots are taken generically rather than at each mutation site:
     applyDraft() is the one funnel every change passes through, so it
     compares the config against the last snapshot and banks the old
     one. `pushHistory(key)` lets an edit declare itself first, and
     repeated edits sharing a key inside a second coalesce — so typing
     a headline is one undo step, not one per keystroke.
     ================================================================ */
  const UNDO_LIMIT = 60;
  let undoStack = [], redoStack = [], lastSnapshot = null;
  let pendingKey = null, lastKey = null, lastKeyAt = 0;

  function snapshot() { return JSON.stringify(draftConfig); }

  /* For edits that deliberately skip a re-render (nudging font size while
     the caret is still in the text), so the next applyDraft doesn't mistake
     the already-recorded change for a fresh one. */
  function commitSnapshot() { lastSnapshot = snapshot(); pendingKey = null; }

  function pushHistory(key, overrideText) {
    const now = Date.now();
    if (key && key === lastKey && now - lastKeyAt < 1200) { lastKeyAt = now; return; }
    lastKey = key; lastKeyAt = now; pendingKey = key;
    let snap = lastSnapshot || snapshot();
    // A text edit's "before" state must be the text as it was BEFORE typing,
    // which the live DOM has already moved past — splice it back in.
    if (overrideText !== undefined && key && key.startsWith("text:")) {
      try {
        const obj = JSON.parse(snap);
        setByPath(obj, key.slice(5), overrideText);
        snap = JSON.stringify(obj);
      } catch (err) { /* fall back to the plain snapshot */ }
    }
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }

  function restore(json) {
    draftConfig = JSON.parse(json);
    lastSnapshot = json;
    expandedBlockId = null; canvasSelection = null; activeEdit = null;
    hideEditToolbar();
    renderPanel();
    applyDraft();
    updateHistoryButtons();
  }

  function undo() {
    if (!undoStack.length) return toast("Nothing to undo.");
    redoStack.push(snapshot());
    restore(undoStack.pop());
    toast("Undone.");
  }

  function redo() {
    if (!redoStack.length) return toast("Nothing to redo.");
    undoStack.push(snapshot());
    restore(redoStack.pop());
    toast("Redone.");
  }

  function updateHistoryButtons() {
    const u = document.getElementById("leUndoBtn"), r = document.getElementById("leRedoBtn");
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }

  document.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("le-active")) return;
    const key = e.key.toLowerCase();
    if (!(e.ctrlKey || e.metaKey) || (key !== "z" && key !== "y")) return;
    // Let the browser handle undo inside the field being typed into.
    if (activeEdit && activeEdit.el.contains(document.activeElement)) return;
    if (e.target.matches && e.target.matches("input, textarea")) return;
    e.preventDefault();
    if (key === "y" || e.shiftKey) redo(); else undo();
  });

  window.PortalEditorHistory = { undo, redo };

  /* ================================================================
     DELEGATED EVENT HANDLERS
     ================================================================ */
  function onPanelClick(e) {
    const t = e.target.closest("[data-le-action]");
    if (!t) return;
    const action = t.dataset.leAction;

    if (action === "undo") { undo(); return; }
    if (action === "redo") { redo(); return; }

    // ── Collapsible property group toggle ───────────────────────────
    if (action === "toggle-group") {
      var group = t.closest(".le-prop-group");
      if (group) group.classList.toggle("is-open");
      return;
    }

    // ── Floating panel toggles ─────────────────────────────────────
    if (action === "toggle-blocks-panel") {
      const p = document.getElementById("leBlocksPanel");
      const btn = document.getElementById("leCmdBlocks");
      const isOpen = p && p.classList.contains("visible");
      // Close all sub-panels first
      ["leBlocksPanel","leDesignPanel","lePagesPanel"].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.remove("visible");
      });
      ["leCmdBlocks","leCmdDesign","leCmdPages"].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.remove("active");
      });
      if (!isOpen && p) { renderBlocksFloating(); p.classList.add("visible"); if (btn) btn.classList.add("active"); }
      return;
    }
    if (action === "toggle-design-panel") {
      const p = document.getElementById("leDesignPanel");
      const btn = document.getElementById("leCmdDesign");
      const isOpen = p && p.classList.contains("visible");
      ["leBlocksPanel","leDesignPanel","lePagesPanel"].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.remove("visible");
      });
      ["leCmdBlocks","leCmdDesign","leCmdPages"].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.remove("active");
      });
      if (!isOpen && p) { renderDesignFloating(); p.classList.add("visible"); if (btn) btn.classList.add("active"); }
      return;
    }
    if (action === "toggle-pages-panel") {
      const p = document.getElementById("lePagesPanel");
      const btn = document.getElementById("leCmdPages");
      const isOpen = p && p.classList.contains("visible");
      ["leBlocksPanel","leDesignPanel","lePagesPanel"].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.remove("visible");
      });
      ["leCmdBlocks","leCmdDesign","leCmdPages"].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.remove("active");
      });
      if (!isOpen && p) { renderPagesFloating(); p.classList.add("visible"); if (btn) btn.classList.add("active"); }
      return;
    }
    if (action === "close-blocks-panel") {
      const p = document.getElementById("leBlocksPanel"); if (p) p.classList.remove("visible");
      const b = document.getElementById("leCmdBlocks"); if (b) b.classList.remove("active");
      return;
    }
    if (action === "close-design-panel") {
      const p = document.getElementById("leDesignPanel"); if (p) p.classList.remove("visible");
      const b = document.getElementById("leCmdDesign"); if (b) b.classList.remove("active");
      return;
    }
    if (action === "close-pages-panel") {
      const p = document.getElementById("lePagesPanel"); if (p) p.classList.remove("visible");
      const b = document.getElementById("leCmdPages"); if (b) b.classList.remove("active");
      return;
    }

    if (action === "select-block") { selectBlock(t.dataset.blockId); return; }
    if (action === "close-block-editor") { expandedBlockId = null; canvasSelection = null; renderPanel(); markSelectedOnCanvas(); return; }

    // ── Prop panel prev / next block navigation ────────────────────
    if (action === "prop-prev-block" || action === "prop-next-block") {
      const blocks = currentPage().blocks || [];
      const idx = blocks.findIndex((b) => b.id === expandedBlockId);
      const next = action === "prop-next-block" ? idx + 1 : idx - 1;
      if (next >= 0 && next < blocks.length) selectBlock(blocks[next].id);
      return;
    }

    // ── On-canvas / prop panel footer block move ───────────────────
    if (action === "ctx-move-block-up" || action === "ctx-move-block-down") {
      const i = Number(t.dataset.index);
      const blocks = currentPage().blocks;
      const j = action === "ctx-move-block-up" ? i - 1 : i + 1;
      if (j < 0 || j >= blocks.length) return;
      const tmp = blocks[i]; blocks[i] = blocks[j]; blocks[j] = tmp;
      // Keep expanded block tracking correct after move
      if (expandedBlockId && blocks[i].id === expandedBlockId) expandedBlockId = blocks[i].id;
      if (expandedBlockId && blocks[j].id === expandedBlockId) expandedBlockId = blocks[j].id;
      renderPanel(); applyDraft();
      return;
    }
    if (action === "duplicate-block") {
      const i = Number(t.dataset.index);
      const blocks = currentPage().blocks;
      const clone = JSON.parse(JSON.stringify(blocks[i]));
      clone.id = window.genBlockId();
      blocks.splice(i + 1, 0, clone);
      renderPanel(); applyDraft();
      return;
    }
    if (action === "delete-block") {
      const i = Number(t.dataset.index);
      const blocks = currentPage().blocks;
      if (blocks[i] && blocks[i].id === expandedBlockId) { expandedBlockId = null; canvasSelection = null; }
      blocks.splice(i, 1);
      renderPanel(); applyDraft();
      return;
    }
    if (action === "open-add-block") { openAddBlockModal(); return; }
    if (action === "set-breakpoint") {
      activeBreakpoint = t.dataset.bp;
      document.body.classList.toggle("le-preview-mobile", activeBreakpoint === "mobile");
      renderPanel();
      applyBreakpointPreview();
      markSelectedOnCanvas();
      return;
    }
    if (action === "add-element") {
      const kind = t.dataset.kind;
      const block = findBlockById(expandedBlockId);
      if (!block) return;
      const defaults = {
        text: { text: "New text" },
        image: { src: IMAGE_PRESETS[0], alt: "" },
        button: { label: "Click me", action: "none", target: "" },
        box: { color: "#e5e7eb", image: "" }
      }[kind];
      const size = { text: { w: 240, h: 60 }, image: { w: 220, h: 160 }, button: { w: 160, h: 44 }, box: { w: 200, h: 120 } }[kind];
      const z = (block.props.elements || []).length;
      const newEl = { id: window.genBlockId(), kind, content: defaults, desktop: { x: 40, y: 40, w: size.w, h: size.h, z }, mobile: null };
      block.props.elements = block.props.elements || [];
      block.props.elements.push(newEl);
      canvasSelection = { blockId: block.id, elementId: newEl.id };
      renderPanel(); applyDraft();
      return;
    }
    if (action === "element-front" || action === "element-back") {
      const { parentPath, idx } = parentAndIndex(t.dataset.path);
      const arr = getByPath(draftConfig, parentPath);
      const el = arr[idx];
      const rectKey = activeBreakpoint === "mobile" ? "mobile" : "desktop";
      if (rectKey === "mobile") promoteMobileRect(el, arr, idx);
      const maxZ = arr.reduce((m, e2) => Math.max(m, ((e2[rectKey] || e2.desktop).z || 0)), 0);
      el[rectKey].z = action === "element-front" ? maxZ + 1 : -1;
      renderPanel(); applyDraft();
      return;
    }
    if (action === "duplicate-element") {
      const { parentPath, idx } = parentAndIndex(t.dataset.path);
      const arr = getByPath(draftConfig, parentPath);
      const clone = JSON.parse(JSON.stringify(arr[idx]));
      clone.id = window.genBlockId();
      clone.desktop.x += 20; clone.desktop.y += 20;
      arr.splice(idx + 1, 0, clone);
      canvasSelection = { blockId: expandedBlockId, elementId: clone.id };
      renderPanel(); applyDraft();
      return;
    }
    if (action === "delete-element") {
      const { parentPath, idx } = parentAndIndex(t.dataset.path);
      const arr = getByPath(draftConfig, parentPath);
      arr.splice(idx, 1);
      canvasSelection = null;
      renderPanel(); applyDraft();
      return;
    }
    if (action === "pick-image") {
      const path = t.dataset.path;
      setByPath(draftConfig, path, t.dataset.url);
      renderPanel(); applyDraft();
      return;
    }
    if (action === "upload-image") {
      const path = t.dataset.path;
      pickImageFiles(false).then((files) => {
        if (!files.length) return;
        return fileToScaledDataUrl(files[0]).then((dataUrl) => {
          setByPath(draftConfig, path, dataUrl);
          renderPanel(); applyDraft();
          toast("Image uploaded — remember to Publish.");
        });
      }).catch(() => toast("Sorry, that image could not be uploaded."));
      return;
    }
    /* Bulk upload straight into a repeatable list (slideshow slides,
       lookbook cards, …): one new list item per file picked, so building
       a slideshow is "select 5 photos" rather than five add-then-upload
       round trips. */
    if (action === "upload-images-multi") {
      const path = t.dataset.path;
      const imageKey = t.dataset.imageKey;
      const field = findFieldByPath(path);
      pickImageFiles(true).then((files) => {
        if (!files.length) return;
        return Promise.all(files.map((f) => fileToScaledDataUrl(f).catch(() => null))).then((urls) => {
          const arr = getByPath(draftConfig, path) || [];
          urls.filter(Boolean).forEach((url) => {
            const item = field ? blankListItem(field) : {};
            item[imageKey] = url;
            arr.push(item);
          });
          setByPath(draftConfig, path, arr);
          renderPanel(); applyDraft();
          toast(urls.filter(Boolean).length + " image(s) added — remember to Publish.");
        });
      }).catch(() => toast("Sorry, those images could not be uploaded."));
      return;
    }
    if (action === "add-item") {
      const field = findFieldByPath(t.dataset.path);
      const arr = getByPath(draftConfig, t.dataset.path) || [];
      arr.push(t.dataset.scalar === "true" ? "" : (field ? blankListItem(field) : {}));
      setByPath(draftConfig, t.dataset.path, arr);
      renderPanel(); applyDraft();
      return;
    }
    if (action === "remove-item") {
      const arr = getByPath(draftConfig, t.dataset.path) || [];
      arr.splice(Number(t.dataset.index), 1);
      renderPanel(); applyDraft();
      return;
    }
    if (action === "move-item-up" || action === "move-item-down") {
      const arr = getByPath(draftConfig, t.dataset.path) || [];
      const i = Number(t.dataset.index);
      const j = action === "move-item-up" ? i - 1 : i + 1;
      if (j < 0 || j >= arr.length) return;
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      renderPanel(); applyDraft();
      return;
    }
    if (action === "switch-page") {
      activePage = t.dataset.slug;
      expandedBlockId = null;
      canvasSelection = null;
      location.hash = activePage === "main" ? "#/" : "#/p/" + activePage;
      renderPanel(); // refreshes layers panel + prop panel
      return;
    }
    if (action === "open-new-page") { createPage(); return; }
    if (action === "delete-page") {
      const slug = t.dataset.slug;
      if (slug === "main") return;
      if (!confirm("Delete the \"" + (draftConfig.pages[slug].title || slug) + "\" page?")) return;
      delete draftConfig.pages[slug];
      draftConfig.navOrder = (draftConfig.navOrder || []).filter((s) => s !== slug);
      if (activePage === slug) { activePage = "main"; location.hash = "#/"; }
      renderPanel(); applyDraft();
      return;
    }
    if (action === "discard") {
      if (confirm("Discard all unpublished edits and reload?")) location.reload();
      return;
    }
    if (action === "publish") { publishConfig(); return; }
  }

  function createPage() {
    const title = prompt("Page title (e.g. About Us):");
    if (!title || !title.trim()) return;
    let slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "page";
    let unique = slug, n = 2;
    while (draftConfig.pages[unique]) { unique = slug + "-" + n; n++; }
    slug = unique;

    draftConfig.pages[slug] = {
      title: title.trim(), slug, isHome: false,
      blocks: [{ id: window.genBlockId(), type: "richtext", props: { heading: title.trim(), body: "Start writing your page content here…" } }]
    };
    draftConfig.navOrder = (draftConfig.navOrder || Object.keys(draftConfig.pages)).concat(slug);
    activePage = slug;
    activeTab = "blocks";
    location.hash = "#/p/" + slug;
    renderPanel();
    applyDraft();
    toast('Page "' + title.trim() + '" created and added to navigation!');
  }

  function onFieldChange(e) {
    const el = e.target;
    if (!el.matches("[data-path]")) return;
    const path = el.dataset.path;
    let val;
    if (el.dataset.type === "boolean") val = el.checked;
    else if (el.dataset.type === "number") val = Number(el.value);
    else val = el.value;

    setByPath(draftConfig, path, val);

    // A canvas text element can carry a captured-formatting `html` twin of
    // its plain `text` (accent words kept intact on eject). Once the user
    // types their own copy, that snapshot is stale — drop it so what they
    // typed is what renders.
    if (/\.content\.text$/.test(path)) setByPath(draftConfig, path.replace(/\.text$/, ".html"), null);

    // keep any other control bound to the same path in sync (e.g. color swatch + hex text input)
    document.querySelectorAll('[data-path="' + cssEscape(path) + '"]').forEach((sib) => {
      if (sib !== el) { if (sib.type === "checkbox") sib.checked = val; else sib.value = val; }
    });

    if (path === "theme.accentColor") document.documentElement.style.setProperty("--accent", val);

    // structural fields (action pickers) change which controls should show — safe to re-render panel on 'change'
    if (e.type === "change" && (el.tagName === "SELECT" || el.type === "checkbox")) renderPanel();

    applyDraft();
  }

  function cssEscape(s) { return s.replace(/["\\]/g, "\\$&"); }

  /* ---- native HTML5 drag-and-drop reorder — shared between the block
     layer list, the on-canvas block handles, and the navbar item list
     (Design tab); `dragRole` distinguishes which array a drop splices. ---- */
  const DRAG_ROW_SELECTOR = '[data-role="layer-row"], [data-role="nav-item-row"], [data-role="canvas-block-row"]';
  let dragRole = null;

  // On-canvas block drags should give feedback across the whole block
  // section (easy to see/hit), not just the small handle icon that
  // actually carries the `draggable` attribute.
  function dragVisualEl(sourceEl) {
    if (sourceEl.dataset.role === "canvas-block-row") return sourceEl.closest("[data-block-id]") || sourceEl;
    return sourceEl;
  }

  // Resolves the current drop target during an in-progress drag: for a
  // canvas-block drag this is "whichever block section the pointer is
  // over" (so you can drop anywhere on a block, not just its handle);
  // otherwise it's the same panel-row selector the drag started from.
  function resolveDropTarget(e) {
    if (dragRole === "canvas-block-row") {
      const section = e.target.closest("#portalMain > [data-block-id]");
      if (!section) return null;
      const idx = (currentPage().blocks || []).findIndex((b) => b.id === section.getAttribute("data-block-id"));
      return { el: section, index: idx };
    }
    const row = e.target.closest(DRAG_ROW_SELECTOR);
    if (!row) return null;
    return { el: row, index: Number(row.dataset.index) };
  }

  function onDragStart(e) {
    const row = e.target.closest(DRAG_ROW_SELECTOR);
    if (!row) return;
    dragFromIndex = Number(row.dataset.index);
    dragRole = row.dataset.role;
    dragVisualEl(row).classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(dragFromIndex));
  }
  function onDragOver(e) {
    const target = resolveDropTarget(e);
    if (!target) return;
    e.preventDefault();
    target.el.classList.add("drag-over");
  }
  function onDragLeave(e) {
    const target = resolveDropTarget(e);
    if (target) target.el.classList.remove("drag-over");
  }
  function onDrop(e) {
    const target = resolveDropTarget(e);
    if (!target || dragFromIndex == null) return;
    e.preventDefault();
    target.el.classList.remove("drag-over");
    const toIndex = target.index;
    if (toIndex === dragFromIndex) { dragFromIndex = null; dragRole = null; return; }
    if (dragRole === "nav-item-row") {
      draftConfig.nav = draftConfig.nav || { items: ["brand", "links", "actions"] };
      const items = draftConfig.nav.items;
      const [moved] = items.splice(dragFromIndex, 1);
      items.splice(toIndex, 0, moved);
    } else {
      const blocks = currentPage().blocks;
      const [moved] = blocks.splice(dragFromIndex, 1);
      blocks.splice(toIndex, 0, moved);
    }
    dragFromIndex = null;
    dragRole = null;
    renderPanel(); applyDraft();
  }
  function onDragEnd() {
    document.querySelectorAll(".le-layer-row.dragging, .le-layer-row.drag-over").forEach((r) => r.classList.remove("dragging", "drag-over"));
    document.querySelectorAll("[data-block-id].dragging, [data-block-id].drag-over").forEach((r) => r.classList.remove("dragging", "drag-over"));
    dragFromIndex = null;
    dragRole = null;
  }

  /* ================================================================
     FREEFORM CANVAS — on-canvas selection handles + mouse-driven
     drag/resize. Separate from the native HTML5 drag-and-drop above
     (layer reordering): this needs continuous pointer coordinates and
     free x/y movement, which native DnD doesn't give you.

     Live-preview during drag/resize mutates only the element's own
     inline style + the handles box (no draftConfig writes, no
     re-render) for smooth dragging; the final position commits to
     draftConfig — and runs the normal applyDraft() pipeline — only on
     mouseup, so publish/persistence needs no special-casing.
     ================================================================ */
  const GRID = 8;
  function snap(v) { return Math.round(v / GRID) * GRID; }

  function removeCanvasHandles() {
    const existing = document.getElementById("fcHandles");
    if (existing) existing.remove();
  }

  function mountCanvasHandles() {
    removeCanvasHandles();
    if (!canvasSelection) return;
    const { blockId, elementId } = canvasSelection;
    const block = findBlockById(blockId);
    const section = document.querySelector('[data-block-id="' + blockId + '"]');
    if (!block || !section) return;
    const elements = block.props.elements || [];
    const elIdx = elements.findIndex((e2) => e2.id === elementId);
    const el = elements[elIdx];
    if (!el) return;
    if (activeBreakpoint === "mobile") promoteMobileRect(el, elements, elIdx);
    const rect = activeBreakpoint === "mobile" ? el.mobile : el.desktop;
    const width = rect.w != null ? rect.w : section.clientWidth - 32;

    const box = document.createElement("div");
    box.id = "fcHandles";
    box.className = "fc-handles";
    box.style.cssText = "position:absolute;left:" + rect.x + "px;top:" + rect.y + "px;width:" + width + "px;height:" + rect.h + "px;";
    box.innerHTML = ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((d) => '<div class="fc-handle fc-handle-' + d + '" data-dir="' + d + '"></div>').join("") +
      '<div class="fc-drag-body" data-dir="move"></div>';
    section.appendChild(box);
    box.addEventListener("mousedown", onHandleMouseDown);
  }

  function onHandleMouseDown(e) {
    const handle = e.target.closest("[data-dir]");
    if (!handle || !canvasSelection) return;
    e.preventDefault();
    e.stopPropagation();
    beginElementDrag(handle.dataset.dir, canvasSelection.blockId, canvasSelection.elementId, e);
  }

  /* Shared by real resize-handle mousedowns and the inline-eject flow
     (dragging a button/image/text straight off a non-canvas block) —
     starts tracking a canvas element drag/resize from event `e`. */
  function beginElementDrag(dir, blockId, elementId, e) {
    const block = findBlockById(blockId);
    const elements = (block && block.props.elements) || [];
    const elIdx = elements.findIndex((e2) => e2.id === elementId);
    const el = elements[elIdx];
    if (!el) return;
    if (activeBreakpoint === "mobile") promoteMobileRect(el, elements, elIdx);
    const rect = activeBreakpoint === "mobile" ? el.mobile : el.desktop;

    elDragCtx = {
      dir, el,
      startX: e.clientX, startY: e.clientY,
      orig: Object.assign({}, rect),
      wrap: document.getElementById("fcel-" + blockId + "-" + elementId),
      handlesBox: document.getElementById("fcHandles")
    };
    document.addEventListener("mousemove", onElementDragMove);
    document.addEventListener("mouseup", onElementDragEnd);
  }

  function onElementDragMove(e) {
    if (!elDragCtx) return;
    const dx = e.clientX - elDragCtx.startX;
    const dy = e.clientY - elDragCtx.startY;
    const o = elDragCtx.orig;
    const dir = elDragCtx.dir;
    let { x, y, w, h } = o;
    w = o.w == null ? (elDragCtx.wrap ? elDragCtx.wrap.getBoundingClientRect().width : 200) : w;

    // Only snap the values this specific drag direction actually changes —
    // snapping every value unconditionally would silently resize elements
    // whose original (unsnapped) dimensions get dragged along on a plain move.
    if (dir === "move") { x = snap(o.x + dx); y = snap(o.y + dy); }
    else {
      if (dir.indexOf("e") > -1) w = snap(Math.max(24, w + dx));
      if (dir.indexOf("s") > -1) h = snap(Math.max(24, o.h + dy));
      if (dir.indexOf("w") > -1) { const nw = snap(Math.max(24, w - dx)); x = o.x + (w - nw); w = nw; }
      if (dir.indexOf("n") > -1) { const nh = snap(Math.max(24, o.h - dy)); y = o.y + (o.h - nh); h = nh; }
    }

    if (elDragCtx.wrap) elDragCtx.wrap.style.cssText = "position:absolute;left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px;z-index:" + (o.z || 0) + ";";
    if (elDragCtx.handlesBox) elDragCtx.handlesBox.style.cssText = "position:absolute;left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px;";
    elDragCtx.result = { x, y, w, h, z: o.z || 0 };
  }

  function onElementDragEnd() {
    document.removeEventListener("mousemove", onElementDragMove);
    document.removeEventListener("mouseup", onElementDragEnd);
    if (!elDragCtx) return;
    const { el, result } = elDragCtx;
    if (result) { if (activeBreakpoint === "mobile") el.mobile = result; else el.desktop = result; }
    elDragCtx = null;
    renderPanel();
    applyDraft();
  }

  /* Forces every canvas element on the page to visually show the editor's
     currently-toggled breakpoint via inline style (which always wins over
     the block's injected `<style>` media-query rule) — lets you preview
     Mobile positioning without needing the real browser viewport to be
     narrow. Real visitors never run this; their browser's own width just
     matches the `@media` rule in the block's own render() output. */
  /* Resolves (and, if not yet customized, promotes) the mobile rect for
     element `el` at index `idx` within `elements` — the promoted value
     matches the same auto-stack computation the live renderer's fallback
     uses (canvas-block.js), so viewing an untouched element's Mobile
     settings shows exactly what a real mobile visitor already sees,
     rather than silently jumping to its desktop position. */
  function promoteMobileRect(el, elements, idx) {
    if (el.mobile) return el.mobile;
    const auto = (window.PortalCanvasBlock && window.PortalCanvasBlock.computeMobileRect(elements, idx)) || { x: 16, y: 0, w: null, h: el.desktop.h, z: el.desktop.z };
    el.mobile = { x: auto.w != null ? auto.x : 16, y: auto.y, w: auto.w != null ? auto.w : (el.desktop.w || 300), h: auto.h, z: auto.z || 0 };
    return el.mobile;
  }

  function applyBreakpointPreview() {
    document.querySelectorAll('[data-canvas-block="true"]').forEach((section) => {
      const blockId = section.getAttribute("data-block-id");
      const block = findBlockById(blockId);
      if (!block) return;
      const elements = block.props.elements || [];
      elements.forEach((el, i) => {
        const wrap = document.getElementById("fcel-" + blockId + "-" + el.id);
        if (!wrap) return;
        if (activeBreakpoint === "mobile") {
          const rect = el.mobile || (window.PortalCanvasBlock && window.PortalCanvasBlock.computeMobileRect(elements, i)) || { x: 16, y: 0, w: null, h: el.desktop.h, z: el.desktop.z };
          if (rect.w != null) {
            wrap.style.cssText = "position:absolute;left:" + rect.x + "px;top:" + rect.y + "px;width:" + rect.w + "px;height:" + rect.h + "px;z-index:" + (rect.z || 0) + ";";
          } else {
            wrap.style.cssText = "position:absolute;left:16px;right:16px;top:" + rect.y + "px;width:auto;height:" + rect.h + "px;z-index:" + (rect.z || 0) + ";";
          }
        } else {
          const rect = el.desktop;
          wrap.style.cssText = "position:absolute;left:" + rect.x + "px;top:" + rect.y + "px;width:" + rect.w + "px;height:" + rect.h + "px;z-index:" + (rect.z || 0) + ";";
        }
      });
    });
  }

  /* ================================================================
     PUBLISH / DISCARD
     ================================================================ */
  async function publishConfig() {
    const btn = document.querySelector(".le-cmd-pub");
    if (btn) btn.innerHTML = "⏳ Publishing…";
    try {
      const et = urlParams.get("et");
      if (et) {
        const r = await fetch("/api/storefront/config", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + et },
          body: JSON.stringify({ wsId, storefrontConfig: draftConfig })
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "Failed to publish (" + r.status + ")"); }
      } else {
        // No live backend for this workspace — persist straight to localStorage,
        // the same place the rest of the app's demo mode already lives.
        const list = JSON.parse(localStorage.getItem("sap_workspaces") || "[]");
        const idx = list.findIndex((w) => w.id === wsId);
        if (idx > -1) { list[idx].storefrontConfig = draftConfig; localStorage.setItem("sap_workspaces", JSON.stringify(list)); }
      }
      toast("🎉 Storefront published!");
      if (btn) btn.innerHTML = '🚀 Publish';
    } catch (err) {
      console.error("[LiveEditor] publish failed:", err);
      toast("Failed to publish: " + err.message, "error");
      if (btn) btn.innerHTML = '🚀 Publish';
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", verifyAndBoot);
  else verifyAndBoot();
})();
