/* =================================================================
   MERVEKS SAP — lightweight SVG charts (no dependencies)
   Sparklines, animated area chart, donut and number count-up used to
   give the dashboard a premium, "wow" feel while staying on-brand.
   ================================================================= */
window.Charts = (function () {
  let uid = 0;
  const id = (p) => p + (++uid) + Math.random().toString(36).slice(2, 6);

  /* animate a number from 0 → target */
  function countUp(el, target, opts) {
    opts = opts || {};
    const dur = opts.dur || 1100;
    const fmt = opts.format || ((v) => Math.round(v).toLocaleString("en-US"));
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      el.textContent = fmt(target * e);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(target);
    }
    requestAnimationFrame(tick);
  }

  /* tiny sparkline with gradient fill */
  function sparkline(values, opts) {
    opts = opts || {};
    const w = opts.w || 240, h = opts.h || 40, pad = 3;
    const min = Math.min(...values), max = Math.max(...values), range = (max - min) || 1;
    const step = (w - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) => [pad + i * step, h - pad - ((v - min) / range) * (h - pad * 2)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = line + " L" + pts[pts.length - 1][0].toFixed(1) + " " + h + " L" + pts[0][0].toFixed(1) + " " + h + " Z";
    const g = id("sp"), color = opts.color || "var(--accent)";
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + color + '" stop-opacity=".30"/>' +
      '<stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + g + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      "</svg>";
  }

  /* animated area / line chart */
  function area(labels, values, opts) {
    opts = opts || {};
    const w = opts.w || 680, h = opts.h || 230, padL = 6, padR = 6, padT = 14, padB = 26;
    const max = (Math.max(...values) * 1.18) || 1;
    const iw = w - padL - padR, ih = h - padT - padB;
    const step = iw / (values.length - 1);
    const pts = values.map((v, i) => [padL + i * step, padT + ih - (v / max) * ih]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const areaP = line + " L" + pts[pts.length - 1][0].toFixed(1) + " " + (padT + ih) + " L" + padL + " " + (padT + ih) + " Z";
    const g = id("ar");
    let grid = "";
    for (let i = 0; i <= 3; i++) { const y = padT + (ih * i) / 3; grid += '<line x1="' + padL + '" y1="' + y + '" x2="' + (w - padR) + '" y2="' + y + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 5"/>'; }
    let lab = "";
    labels.forEach((l, i) => { const x = padL + i * step; lab += '<text x="' + x.toFixed(1) + '" y="' + (h - 7) + '" font-size="10.5" fill="var(--muted)" text-anchor="middle">' + l + "</text>"; });
    const len = 2000;
    const dots = pts.map((p, i) => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.4" fill="#fff" stroke="var(--accent)" stroke-width="2" style="opacity:0;animation:fadeIn .4s ease ' + (0.5 + i * 0.07) + 's forwards"><title>' + labels[i] + ": " + values[i] + "</title></circle>").join("");
    return '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" style="width:100%;height:' + h + 'px;display:block">' +
      '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="var(--accent)" stop-opacity=".26"/>' +
      '<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>' +
      grid +
      '<path d="' + areaP + '" fill="url(#' + g + ')" style="opacity:0;animation:fadeIn .8s ease .3s forwards"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" style="stroke-dasharray:' + len + ";stroke-dashoffset:" + len + ';animation:draw 1.3s var(--ease) forwards"/>' +
      dots + lab + "</svg>";
  }

  /* donut with animated segments and a centered total */
  function donut(segments, opts) {
    opts = opts || {};
    const size = opts.size || 172, r = opts.r || 62, sw = opts.sw || 22, c = size / 2;
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    const circ = 2 * Math.PI * r;
    let offset = 0, arcs = "";
    segments.forEach((s, i) => {
      const len = (s.value / total) * circ;
      arcs += '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="' + s.color + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-dasharray="' + (len - 2) + " " + (circ - len + 2) + '" stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 ' + c + " " + c + ')" style="opacity:0;animation:fadeIn .5s ease ' + (i * 0.12) + 's forwards"><title>' + s.label + ": " + s.value + "</title></circle>";
      offset += len;
    });
    return '<svg viewBox="0 0 ' + size + " " + size + '" width="' + size + '" height="' + size + '">' + arcs +
      '<text x="' + c + '" y="' + (c - 1) + '" text-anchor="middle" font-size="32" font-weight="800" font-family="var(--font-head)" fill="var(--ink)">' + total + "</text>" +
      '<text x="' + c + '" y="' + (c + 19) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' + (opts.centerLabel || "total") + "</text></svg>";
  }

  return { countUp, sparkline, area, donut };
})();
