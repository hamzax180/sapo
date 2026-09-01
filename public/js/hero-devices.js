/* =================================================================
   Hero device screens — a canvas arcade on the laptop, a calculator on
   the phone. Replaces two static JPEGs that could not animate.

   Own file (like nav-loading.js) because it is long and self-contained;
   unlike that one it does NOT inject its own CSS — these styles are
   hero-specific and live with the rest of the hero in home.html.

   Everything runs off ONE requestAnimationFrame loop, including the
   calculator tape. That is deliberate: a single cancel stops both
   devices, setTimeout gets clamped to >=1s in background tabs (which
   makes a tape visibly stutter on return), and having zero timers to
   track is what stops this leaking the way the previous version did.
   ================================================================= */
(function () {
  "use strict";
  if (window.__heroDevices) return;

  var macStage = document.getElementById("macStage");
  var phoneStage = document.getElementById("phoneStage");
  var cv = document.getElementById("arcCanvas");
  var hero = document.querySelector(".bh-hero");
  if (!macStage || !phoneStage || !cv || !hero) return;

  var ctx = cv.getContext("2d", { alpha: false });
  var hud = {
    score: document.getElementById("arcScore"),
    level: document.getElementById("arcLevel"),
    bars: document.getElementById("arcBars"),
    shieldRow: document.getElementById("arcShieldRow"),
    hudRoot: document.getElementById("arcHud"),
    over: document.getElementById("arcOver"),
    overScore: document.getElementById("arcOverScore")
  };

  /* ---------- deterministic PRNG ----------
     Seeded so the reduced-motion frame and the first second of motion are
     identical on every load — makes a screenshot diff meaningful. */
  var seed = 0x5eed;
  function rnd() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rr(a, b) { return a + rnd() * (b - a); }

  /* ---------- canvas sizing ---------- */
  var W = 0, H = 0, dpr = 0, HY = 0, skyGrad = null, gridGrad = null, scan = null;
  var DPR_CAP = 2;

  function fit() {
    var r = cv.getBoundingClientRect();
    var w = Math.round(r.width), h = Math.round(r.height);
    var d = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    if (!w || !h) return false;
    if (w === W && h === H && d === dpr) return false;
    W = w; H = h; dpr = d;
    // Round the backing store to whole pixels: a fractional DPR (Windows
    // at 125%/150%) against a fractional CSS size makes the browser
    // resample at composite time, which softens the 1px grid lines.
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    // Assigning .width resets ALL context state, so the transform has to
    // be re-applied here and nowhere else.
    ctx.setTransform(d, 0, 0, d, 0, 0);
    HY = Math.round(H * 0.40);
    buildCaches();
    return true;
  }

  function buildCaches() {
    skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, "#12082a");
    skyGrad.addColorStop(0.46, "#2a0f45");
    skyGrad.addColorStop(1, "#050210");

    gridGrad = ctx.createLinearGradient(0, HY, 0, H);
    gridGrad.addColorStop(0, "rgba(255,47,208,0)");
    gridGrad.addColorStop(0.18, "rgba(255,47,208,0.30)");
    gridGrad.addColorStop(1, "rgba(0,240,255,0.85)");

    var sc = document.createElement("canvas");
    sc.width = 1; sc.height = 4;
    var sx = sc.getContext("2d");
    sx.fillStyle = "rgba(0,0,0,0.10)";
    sx.fillRect(0, 0, 1, 1);
    scan = ctx.createPattern(sc, "repeat");
  }

  /* ---------- pools ---------- */
  function pool(n, make) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) { a[i] = make(); a[i].on = false; }
    return a;
  }
  function take(a) {
    for (var i = 0; i < a.length; i++) if (!a[i].on) { a[i].on = true; return a[i]; }
    return null;
  }

  var stars = pool(90, function () { return { x: 0, y: 0, z: 0 }; });
  var bullets = pool(24, function () { return { x: 0, y: 0, vy: 0 }; });
  var rocks = pool(14, function () { return { x: 0, y: 0, vx: 0, vy: 0, r: 0, a: 0, va: 0, sh: null }; });
  var parts = pool(140, function () { return { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, c: 0 }; });

  rocks.forEach(function (k) {
    var v = new Float32Array(8);
    for (var i = 0; i < 8; i++) v[i] = 0.72 + rnd() * 0.5;
    k.sh = v;
  });

  /* ================= SHOOTER ================= */
  var ship = { x: 0, y: 0, vx: 0, bank: 0, inv: 0 };
  var score = 0, level = 1, shield = 5, shake = 0, flash = 0, fireT = 0, spawnT = 0;

  function resetShooter() {
    score = 0; level = 1; shield = 5; shake = 0; flash = 0;
    ship.x = W / 2; ship.vx = 0; ship.bank = 0; ship.inv = 0;
    bullets.forEach(function (b) { b.on = false; });
    rocks.forEach(function (r) { r.on = false; });
    parts.forEach(function (p) { p.on = false; });
    stars.forEach(function (s) { s.on = true; s.x = rnd() * W; s.y = rnd() * HY; s.z = rnd(); });
  }

  function boom(x, y, n, hue) {
    for (var i = 0; i < n; i++) {
      var p = take(parts); if (!p) return;
      var a = rnd() * Math.PI * 2, sp = rr(30, 150);
      p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.max = p.life = rr(0.3, 0.75); p.c = hue;
    }
  }

  function updShooter(dt, t) {
    ship.y = H - 62;
    var target = W * 0.5 + Math.sin(t * 0.63) * W * 0.26 + Math.sin(t * 1.87 + 1.1) * W * 0.09;
    ship.vx += (target - ship.x) * 6.5 * dt;
    ship.vx *= 0.86;
    ship.x += ship.vx * dt;
    ship.bank = Math.max(-0.3, Math.min(0.3, ship.vx * 0.0016));
    if (ship.inv > 0) ship.inv -= dt;
    if (shake > 0) shake -= dt * 3.4;
    if (flash > 0) flash -= dt * 3.2;

    fireT -= dt;
    if (fireT <= 0) {
      fireT = 0.16;
      var b = take(bullets);
      if (b) { b.x = ship.x; b.y = ship.y - 12; b.vy = -340; }
    }
    spawnT -= dt;
    if (spawnT <= 0) {
      spawnT = Math.max(0.42, 0.62 - level * 0.03);
      var k = take(rocks);
      if (k) {
        k.r = rr(8, 17); k.x = rr(k.r, W - k.r); k.y = HY - 6;
        k.vx = rr(-22, 22); k.vy = rr(46, 84); k.a = rnd() * 6.28; k.va = rr(-1.6, 1.6);
      }
    }

    var i, j;
    for (i = 0; i < bullets.length; i++) {
      var bu = bullets[i]; if (!bu.on) continue;
      bu.y += bu.vy * dt;
      if (bu.y < HY - 10) bu.on = false;
    }
    for (i = 0; i < rocks.length; i++) {
      var rk = rocks[i]; if (!rk.on) continue;
      rk.x += rk.vx * dt; rk.y += rk.vy * dt; rk.a += rk.va * dt;
      if (rk.x < rk.r || rk.x > W - rk.r) rk.vx *= -1;
      if (rk.y > H + 24) { rk.on = false; continue; }
      for (j = 0; j < bullets.length; j++) {
        var b2 = bullets[j]; if (!b2.on) continue;
        var dx = b2.x - rk.x, dy = b2.y - rk.y;
        if (dx * dx + dy * dy < rk.r * rk.r) {
          b2.on = false; rk.on = false;
          boom(rk.x, rk.y, 12, 0);
          score += 25 * level;
          if (rk.r > 11) {
            for (var s2 = 0; s2 < 2; s2++) {
              var nk = take(rocks); if (!nk) break;
              nk.r = rk.r * 0.62; nk.x = rk.x; nk.y = rk.y;
              nk.vx = rr(-70, 70); nk.vy = rr(50, 90); nk.a = rnd() * 6.28; nk.va = rr(-2.4, 2.4);
            }
          }
          break;
        }
      }
      if (rk.on && ship.inv <= 0) {
        var sx = ship.x - rk.x, sy = ship.y - rk.y;
        if (sx * sx + sy * sy < (rk.r + 9) * (rk.r + 9)) {
          rk.on = false; boom(ship.x, ship.y, 24, 1);
          shake = 1; flash = 1; ship.inv = 1.2;
          shield--;
          // Deliberately no GAME OVER here — a hero that advertises
          // failure is an own goal, and the endless restart chain that
          // needed is exactly what leaked in the previous version.
          if (shield <= 0) { shield = 5; score = Math.max(0, score - 150); }
        }
      }
    }
    for (i = 0; i < parts.length; i++) {
      var p = parts[i]; if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) { p.on = false; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 120 * dt;
    }
    level = Math.min(9, 1 + Math.floor(score / 500));
  }

  function drawGrid(t) {
    var span = H - HY;
    var frac = (t * 0.62) % 1;
    var vx = W * 0.5 + (ship.x - W * 0.5) * 0.14;
    ctx.lineWidth = 1;
    ctx.strokeStyle = gridGrad;
    ctx.beginPath();
    // Horizontal lines are a 1/z projection of a ground plane: screen y =
    // HY + span/z. Subtracting a fractional phase from z scrolls them,
    // and the 1/z curve is what makes them accelerate toward the viewer.
    for (var i = 1; i <= 15; i++) {
      var y = HY + span / (i - frac);
      if (y > H + 1) continue;
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    // Verticals are lines of constant ground-x — they converge on the
    // vanishing point and do NOT scroll. Scrolling them too is the usual
    // mistake that makes this read as a moving texture, not perspective.
    for (var j = -8; j <= 8; j++) {
      ctx.moveTo(vx, HY);
      ctx.lineTo(vx + j * 74, H);
    }
    ctx.stroke();
  }

  function drawShooter(t) {
    ctx.fillStyle = skyGrad; ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      ctx.fillRect(s.x, s.y, s.z > 0.7 ? 1.6 : 1, s.z > 0.7 ? 1.6 : 1);
    }
    // sun
    var sy = HY - 34, sr = 30;
    var sg = ctx.createLinearGradient(0, sy - sr, 0, sy + sr);
    sg.addColorStop(0, "#ffd166"); sg.addColorStop(1, "#ff2fd0");
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(W * 0.5, sy, sr, 0, 6.284); ctx.fill();
    ctx.fillStyle = "#12082a";
    for (var b = 0; b < 5; b++) ctx.fillRect(W * 0.5 - sr, sy + 4 + b * 6, sr * 2, 2 + b * 0.7);

    drawGrid(t);

    for (var k = 0; k < rocks.length; k++) {
      var rk = rocks[k]; if (!rk.on) continue;
      ctx.save(); ctx.translate(rk.x, rk.y); ctx.rotate(rk.a);
      ctx.beginPath();
      for (var v = 0; v < 8; v++) {
        var a = (v / 8) * 6.283, rad = rk.r * rk.sh[v];
        v ? ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad)
          : ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fillStyle = "#3a1d5c"; ctx.fill();
      ctx.strokeStyle = "#b06bff"; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }

    if (!(ship.inv > 0 && ((t * 8) | 0) % 2)) {
      ctx.save(); ctx.translate(ship.x, ship.y); ctx.rotate(ship.bank);
      ctx.beginPath();
      ctx.moveTo(0, -13); ctx.lineTo(9, 9); ctx.lineTo(0, 4); ctx.lineTo(-9, 9);
      ctx.closePath();
      ctx.fillStyle = "#00f0ff"; ctx.fill();
      ctx.fillStyle = "rgba(255,180,60," + (0.55 + rnd() * 0.4) + ")";
      ctx.beginPath(); ctx.moveTo(-4, 8); ctx.lineTo(0, 8 + rr(7, 15)); ctx.lineTo(4, 8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // One state change buys real additive bloom. Never shadowBlur here —
    // it commonly costs 5-10x the primitive it decorates.
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "#8ef6ff";
    for (var m = 0; m < bullets.length; m++) {
      var bu = bullets[m]; if (!bu.on) continue;
      ctx.fillRect(bu.x - 1.2, bu.y - 7, 2.4, 10);
    }
    for (var q = 0; q < parts.length; q++) {
      var p = parts[q]; if (!p.on) continue;
      var al = p.life / p.max;
      ctx.fillStyle = p.c ? "rgba(255,120,90," + al + ")" : "rgba(0,240,255," + al + ")";
      ctx.fillRect(p.x - 1.3, p.y - 1.3, 2.6, 2.6);
    }
    ctx.globalCompositeOperation = "source-over";

    if (flash > 0) {
      ctx.fillStyle = "rgba(255,60,90," + flash * 0.32 + ")";
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ================= RUNNER ================= */
  var run = { x: 0, y: 0, vy: 0, ground: 0, t: 0, dead: 0, score: 0, obs: [], scroll: 0 };

  function resetRunner() {
    run.ground = H - 58; run.x = W * 0.24; run.y = run.ground; run.vy = 0;
    run.t = 0; run.dead = 0; run.score = 0; run.scroll = 0;
    run.obs = [{ x: W + 60, h: 16 }, { x: W + 300, h: 22 }];
    hud.over.classList.remove("on");
  }

  function updRunner(dt) {
    if (run.dead > 0) { run.dead += dt; return; }
    run.t += dt;
    run.scroll += 150 * dt;
    run.score += dt * 42;
    // Hop on a fixed cadence — it is a showreel, not a playable game.
    if (run.y >= run.ground && Math.sin(run.t * 3.1) > 0.55) run.vy = -260;
    run.vy += 900 * dt;
    run.y += run.vy * dt;
    if (run.y > run.ground) { run.y = run.ground; run.vy = 0; }
    for (var i = 0; i < run.obs.length; i++) {
      var o = run.obs[i];
      o.x -= 150 * dt;
      if (o.x < -30) { o.x = W + rr(140, 300); o.h = rr(14, 26); }
      if (Math.abs(o.x - run.x) < 12 && run.y > run.ground - o.h - 4) {
        run.dead = 0.001;
        hud.overScore.textContent = "Score " + Math.floor(run.score);
        hud.over.classList.add("on");
      }
    }
  }

  function drawRunner() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#1b2a4a"); g.addColorStop(0.55, "#2d4a7c"); g.addColorStop(1, "#4a7ba8");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#1e3a5f";
    for (var i = 0; i < 6; i++) {
      var hx = ((i * 150 - run.scroll * 0.25) % (W + 300)) - 150;
      ctx.beginPath(); ctx.arc(hx, run.ground + 26, 78, Math.PI, 0); ctx.fill();
    }
    ctx.fillStyle = "#2f7d4f";
    ctx.fillRect(0, run.ground + 8, W, H - run.ground);
    ctx.fillStyle = "#3da065";
    for (var t = 0; t < Math.ceil(W / 28) + 1; t++) {
      var tx = (t * 28 - (run.scroll % 28));
      ctx.fillRect(tx, run.ground + 8, 14, 3);
    }

    ctx.fillStyle = "#8b5cf6";
    for (var o = 0; o < run.obs.length; o++) {
      var ob = run.obs[o];
      ctx.fillRect(ob.x - 5, run.ground + 8 - ob.h, 10, ob.h);
    }

    ctx.save();
    ctx.translate(run.x, run.y);
    if (run.dead > 0) ctx.rotate(run.dead * 6);
    ctx.fillStyle = "#f2542d";
    ctx.fillRect(-7, -16, 14, 16);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(2, -12, 3, 3);
    ctx.restore();
  }

  /* ================= HUD ================= */
  var lastScoreTxt = "", lastLevelTxt = "", lastShield = -1, hudT = 0;
  function syncHud(dt, mode) {
    hudT -= dt;
    if (hudT > 0) return;
    hudT = 0.085;
    var s, l;
    if (mode === "runner") { s = Math.floor(run.score); l = 1; }
    else { s = score; l = level; }
    var st = ("00000" + s).slice(-6);
    if (st !== lastScoreTxt) { hud.score.textContent = st; lastScoreTxt = st; }
    var lt = ("0" + l).slice(-2);
    if (lt !== lastLevelTxt) { hud.level.textContent = lt; lastLevelTxt = lt; }
    if (mode !== "runner" && shield !== lastShield) {
      lastShield = shield;
      var kids = hud.bars.children;
      for (var i = 0; i < kids.length; i++) kids[i].className = i < shield ? "" : "off";
    }
  }

  hud.bars.innerHTML = "<i></i><i></i><i></i><i></i><i></i>";

  /* ================= CALCULATOR ================= */
  var KEYS = [
    ["AC", "fn"], ["+/−", "fn"], ["%", "fn"], ["÷", "op"],
    ["7", ""], ["8", ""], ["9", ""], ["×", "op"],
    ["4", ""], ["5", ""], ["6", ""], ["−", "op"],
    ["1", ""], ["2", ""], ["3", ""], ["+", "op"],
    ["0", "zero"], [".", ""], ["=", "op"]
  ];
  var keyMap = Object.create(null);
  var calcKeys = document.getElementById("calcKeys");
  var calcOut = document.getElementById("calcOut");
  var calcExpr = document.getElementById("calcExpr");

  (function buildKeys() {
    var frag = document.createDocumentFragment();
    KEYS.forEach(function (k) {
      var d = document.createElement("div");
      d.className = "ioscalc-key " + k[1];
      d.textContent = k[0];
      frag.appendChild(d);
      keyMap[k[0]] = d;
    });
    calcKeys.appendChild(frag);
  })();

  // Each step carries the key to light AND the exact display state, so
  // there is no expression parser and no float-precision surprises — the
  // strings are authored, which also guarantees they fit the display.
  var TAPES = [
    [["AC", "0", ""], ["1", "1", ""], ["2", "12", ""], ["4", "124", ""], ["0", "1,240", ""],
     ["×", "1,240", "1,240 ×"], ["3", "3", "1,240 × 3"], ["=", "3,720", "1,240 × 3 ="]],
    [["AC", "0", ""], ["9", "9", ""], ["5", "95", ""], ["0", "950", ""], ["0", "9,500", ""],
     ["÷", "9,500", "9,500 ÷"], ["4", "4", "9,500 ÷ 4"], ["=", "2,375", "9,500 ÷ 4 ="]],
    [["AC", "0", ""], ["8", "8", ""], ["6", "86", ""],
     ["+", "86", "86 +"], ["5", "5", "86 + 5"], ["7", "57", "86 + 57"], ["=", "143", "86 + 57 ="]]
  ];
  var ti = 0, ki = 0, nextAt = 0, lit = null, litUntil = 0;

  function gapFor(label) {
    if (label === "AC") return 520;
    if (label === "=") return 1750;
    return "+−×÷".indexOf(label) >= 0 ? 440 : 265;
  }

  function tapeStep(sim) {
    var ms = sim * 1000;
    if (lit && ms >= litUntil) { lit.classList.remove("hit"); lit = null; }
    if (ms < nextAt) return;
    var step = TAPES[ti][ki];
    var node = keyMap[step[0]];
    if (node) { node.classList.add("hit"); lit = node; litUntil = ms + 90; }
    calcOut.textContent = step[1];
    calcExpr.innerHTML = step[2] || "&nbsp;";
    nextAt = ms + gapFor(step[0]);
    if (++ki >= TAPES[ti].length) { ki = 0; ti = (ti + 1) % TAPES.length; }
  }

  /* ================= LOOP + LIFECYCLE ================= */
  var raf = 0, last = 0, sim = 0, acc = 0, mode = "shooter", modeT = 0, started = false;

  function update(dt, t) {
    modeT += dt;
    if (modeT > 12) {
      modeT = 0;
      mode = mode === "shooter" ? "runner" : "shooter";
      hud.hudRoot.classList.toggle("runner", mode === "runner");
      hud.over.classList.remove("on");
      if (mode === "shooter") { resetShooter(); } else { resetRunner(); }
    }
    if (mode === "shooter") { updShooter(dt, t); }
    else {
      updRunner(dt);
      if (run.dead > 2.6) resetRunner();
    }
  }

  function draw(t) {
    ctx.save();
    if (mode === "shooter" && shake > 0) {
      ctx.translate((rnd() - 0.5) * shake * 8, (rnd() - 0.5) * shake * 8);
      drawShooter(t);
    } else if (mode === "shooter") { drawShooter(t); }
    else { drawRunner(); }
    ctx.fillStyle = scan; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    var dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05;  // a GC pause must not teleport everything
    acc += dt;
    // 1/61 not 1/60: rAF deltas jitter around 16.66ms, and a 1/60 gate
    // drops roughly every other frame to 30fps on a 60Hz display.
    if (acc < 1 / 61) return;
    var step = acc; acc = 0;
    sim += step;
    update(step, sim);
    draw(sim);
    syncHud(step, mode);
    tapeStep(sim);
    if (!started) { started = true; macStage.classList.add("live"); phoneStage.classList.add("live"); }
  }

  function start() {
    if (raf) return;              // idempotent: two events in one tick
    if (!fit() && !W) return;     // nothing to draw into yet
    last = performance.now();
    acc = 0;
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  var mqSmall = matchMedia("(max-width:1100px)");
  var mqReduce = matchMedia("(prefers-reduced-motion:reduce)");
  var saveData = !!(navigator.connection && navigator.connection.saveData);
  var inView = false, cleanups = [], resizeT = 0;

  function on(t, e, f) {
    t.addEventListener(e, f);
    cleanups.push(function () { t.removeEventListener(e, f); });
  }
  function reduced() { return mqReduce.matches || saveData; }
  function shouldRun() { return !mqSmall.matches && !reduced() && inView && !document.hidden; }
  function sync() { if (shouldRun()) start(); else stop(); }

  function renderStatic() {
    if (!fit() && !W) return;
    seed = 0x5eed;
    resetShooter();
    // Fast-forward without drawing so the frozen frame is a composed
    // moment (bullets in flight, ship banked) rather than an empty start.
    for (var i = 0; i < 126; i++) updShooter(1 / 30, i / 30);
    draw(4.2);
    syncHud(1, "shooter");
    var t = TAPES[0][TAPES[0].length - 1];
    calcOut.textContent = t[1];
    calcExpr.innerHTML = t[2];
    macStage.classList.add("live");
    phoneStage.classList.add("live");
  }

  // Observe the HERO, not the devices: they sit at left:-300px /
  // right:-160px and are partly outside the viewport by design, so
  // observing them directly misfires at narrow widths.
  var io = new IntersectionObserver(function (es) {
    inView = es[0].isIntersecting;
    sync();
  }, { rootMargin: "150px 0px", threshold: 0 });
  io.observe(hero);

  function onSmall() {
    sync();
    // Release the backing store when the devices are display:none — at
    // DPR 2 that is ~2.9MB held for something nobody can see.
    if (mqSmall.matches) { cv.width = cv.height = 0; W = H = dpr = 0; }
    else { fit(); }
  }
  function onReduce() { if (reduced()) { stop(); renderStatic(); } else { sync(); } }

  on(mqSmall, "change", onSmall);
  on(mqReduce, "change", onReduce);
  on(document, "visibilitychange", sync);
  on(window, "resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { fit(); }, 150);
  });

  if (reduced()) renderStatic(); else sync();

  window.__heroDevices = {
    destroy: function () {
      stop();
      io.disconnect();
      clearTimeout(resizeT);
      cleanups.forEach(function (f) { f(); });
      cleanups.length = 0;
      cv.width = cv.height = 0;
      window.__heroDevices = null;
    },
    _state: function () {
      return { raf: raf, mode: mode, inView: inView, started: started, W: W, H: H, dpr: dpr };
    }
  };
})();
