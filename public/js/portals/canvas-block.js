/* =================================================================
   WeboCloud Portal Engine — Freeform Canvas block
   -----------------------------------------------------------------
   Unlike every other block in blocks.js (fixed flow layout driven by
   props), `canvas` holds a free list of absolutely-positioned
   elements (text / image / button / box) that the live editor lets
   you drag/resize directly on the page. It's additive — existing
   flow blocks (hero, stats, card-grid, ...) are untouched and keep
   using the side-panel property-form editing model; `canvas` is
   opted into via "+ Add Block" when pixel-level control is wanted.

   Each element has an independent `desktop` and `mobile` position
   rect. `mobile` starts `null` (not yet customized) and is computed
   live at render time as a simple stacked, full-width fallback —
   consistently for both the editor canvas and real visitors — until
   the user drags/resizes it while the editor is in Mobile view mode,
   at which point live-editor.js writes a concrete `mobile` rect that
   "promotes" it out of auto-layout.
   ================================================================= */
(function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const MOBILE_BREAKPOINT = 768;
  const MOBILE_GAP = 12;

  /* Resolves the effective mobile rect for element at `idx` — either its
     own explicit override, or an auto-computed stacked position based on
     the elements before it (also auto or explicit) in array order. */
  function computeMobileRect(elements, idx) {
    const el = elements[idx];
    if (el.mobile) return Object.assign({ auto: false }, el.mobile);
    let y = MOBILE_GAP;
    for (let i = 0; i < idx; i++) {
      const prevH = (elements[i].mobile && elements[i].mobile.h) || elements[i].desktop.h;
      y += prevH + MOBILE_GAP;
    }
    return { x: 16, y, w: null, h: el.desktop.h, z: el.desktop.z || 0, auto: true };
  }

  function rectCSS(rect, isAuto) {
    if (isAuto) {
      return "left:16px;right:16px;width:auto;top:" + rect.y + "px;height:" + rect.h + "px;z-index:" + (rect.z || 0) + ";";
    }
    return "left:" + rect.x + "px;top:" + rect.y + "px;width:" + rect.w + "px;height:" + rect.h + "px;z-index:" + (rect.z || 0) + ";";
  }

  function elementCSS(blockId, el, idx, elements) {
    const domId = "fcel-" + blockId + "-" + el.id;
    const mobileRect = computeMobileRect(elements, idx);
    return (
      "#" + domId + "{position:absolute;" + rectCSS(el.desktop, false) + "}\n" +
      "@media (max-width:" + MOBILE_BREAKPOINT + "px){#" + domId + "{" + rectCSS(mobileRect, mobileRect.auto) + "}}"
    );
  }

  /* Builds an inline style string from a computed-style snapshot taken at
     eject time (live-editor.js's ejectBlockToCanvas) — this is what keeps
     a dragged hero title/button looking exactly the same instead of
     falling back to plain generic text: the snapshot is applied as inline
     style, which always wins regardless of which stylesheet loaded last. */
  function snapshotStyleCSS(style, propMap) {
    if (!style) return "";
    return propMap.map(([key, cssProp]) => (style[key] ? cssProp + ":" + esc(style[key]) : "")).filter(Boolean).join(";");
  }
  const TEXT_STYLE_PROPS = [["color", "color"], ["fontSize", "font-size"], ["fontWeight", "font-weight"], ["fontStyle", "font-style"], ["letterSpacing", "letter-spacing"], ["lineHeight", "line-height"], ["textTransform", "text-transform"], ["textAlign", "text-align"], ["textShadow", "text-shadow"], ["backgroundColor", "background-color"], ["padding", "padding"], ["borderRadius", "border-radius"]];
  const BUTTON_STYLE_PROPS = [["backgroundColor", "background-color"], ["color", "color"], ["borderRadius", "border-radius"], ["fontWeight", "font-weight"], ["fontSize", "font-size"], ["padding", "padding"], ["letterSpacing", "letter-spacing"], ["textTransform", "text-transform"], ["border", "border"]];
  // Without these an ejected backdrop photo loses its opacity/fit and the
  // block reads as a completely different color. See ejectBlockToCanvas.
  const IMAGE_STYLE_PROPS = [["opacity", "opacity"], ["objectFit", "object-fit"], ["objectPosition", "object-position"], ["borderRadius", "border-radius"], ["filter", "filter"], ["mixBlendMode", "mix-blend-mode"]];

  function renderElementBody(el) {
    const c = el.content || {};
    if (el.kind === "text") {
      let style = snapshotStyleCSS(c.style, TEXT_STYLE_PROPS);
      if (c.style && c.style.textAlign) style += ";justify-content:" + (c.style.textAlign === "center" ? "center" : c.style.textAlign === "right" ? "flex-end" : "flex-start");
      if (c.color) style += ";color:" + esc(c.color); // explicit user edit — applied last so it wins
      // `html` is a sanitized re-emission of the leaf's inline formatting
      // (accent <em> words and the like), built by live-editor.js at eject
      // time with every text node escaped. Editing the text in the panel
      // clears it (see onFieldChange), so it can never go stale against
      // whatever the user typed.
      const body = c.html || esc(c.text || "").replace(/\n/g, "<br>");
      return '<div class="fc-el fc-text"' + (style ? ' style="' + style + '"' : "") + '>' + body + "</div>";
    }
    if (el.kind === "image") {
      const style = snapshotStyleCSS(c.style, IMAGE_STYLE_PROPS);
      return '<img class="fc-el fc-image" src="' + esc(c.src || "") + '" alt="' + esc(c.alt || "") + '"' + (style ? ' style="' + style + '"' : "") + ">";
    }
    if (el.kind === "button") {
      const onclick = "PortalGB.runBlockAction(" + JSON.stringify(c.action || "none") + "," + JSON.stringify(c.target || "") + ")";
      let style = snapshotStyleCSS(c.style, BUTTON_STYLE_PROPS);
      if (c.bgColor) style += ";background:" + esc(c.bgColor); // explicit user edits — applied last so they win
      if (c.textColor) style += ";color:" + esc(c.textColor);
      return '<button class="fc-el fc-button"' + (style ? ' style="' + style + '"' : "") + " onclick='" + onclick + "'>" + esc(c.label || "Button") + "</button>";
    }
    if (el.kind === "widget") {
      // Raw markup captured verbatim at eject time (see live-editor.js
      // ejectBlockToCanvas) — same ids/inline handlers, so whatever
      // global function it wired up (Portal.doTrack(), an RFQ submit
      // handler, ...) keeps working unchanged inside its new wrapper.
      return '<div class="fc-el fc-widget">' + (c.html || "") + "</div>";
    }
    // box
    const bg = c.image
      ? 'background-image:url(' + JSON.stringify(c.image) + ');background-size:cover;background-position:center;'
      : "background-color:" + esc(c.color || "#e5e7eb") + ";";
    return '<div class="fc-el fc-box" style="' + bg + '"></div>';
  }

  function renderElement(blockId, el, idx, elements) {
    const domId = "fcel-" + blockId + "-" + el.id;
    return '<div class="fc-el-wrap" id="' + domId + '" data-el-id="' + esc(el.id) + '" data-el-kind="' + esc(el.kind) + '">' +
      renderElementBody(el) +
      "</div>";
  }

  window.PortalBlocks = window.PortalBlocks || {};
  window.PortalBlocks.canvas = {
    label: "Freeform Canvas", category: "Freeform",
    defaultProps: { minHeight: 400, background: { color: "#ffffff", image: "" }, elements: [] },
    schema: [], // edited entirely on-canvas (drag/resize), not through the side-panel form
    render(props, ctx) {
      const elements = props.elements || [];
      const bg = props.background || {};
      // `raw` (when present) is the exact computed background captured at
      // eject time — e.g. a hero's CSS gradient — which the plain
      // color/image fields below can't represent on their own.
      const bgStyle = bg.raw ? "background:" + esc(bg.raw) + ";" :
        (bg.image ? "background-image:url(" + JSON.stringify(bg.image) + ");background-size:cover;background-position:center;" : "") +
        "background-color:" + esc(bg.color || "#ffffff") + ";";
      const textStyle = props.textColor ? "color:" + esc(props.textColor) + ";" : "";
      const styleTag = "<style>" + elements.map((el, i) => elementCSS(ctx.blockId, el, i, elements)).join("\n") + "</style>";
      return '<section class="portal-section fc-canvas" data-block-id="' + ctx.blockId + '" data-canvas-block="true" style="position:relative;min-height:' + (Number(props.minHeight) || 400) + 'px;' + bgStyle + textStyle + '">' +
        styleTag +
        elements.map((el, i) => renderElement(ctx.blockId, el, i, elements)).join("") +
        "</section>";
    }
  };

  /* exported so live-editor.js can compute the same auto-mobile rect when
     the user is in Mobile view mode and about to "promote" it to explicit */
  window.PortalCanvasBlock = { computeMobileRect, MOBILE_BREAKPOINT };
})();
