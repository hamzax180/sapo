/* =================================================================
   Shared voice input.

   Why a shared file and not inline per page: this existed twice —
   code.html had it against #agVoiceBtn, home.html against #bhVoiceBtn —
   as the same forty lines with different ids, which meant the same four
   bugs in two places and a fix that was only ever half applied. Same
   reasoning as js/nav-loading.js, which says it plainly: this project has
   no build step, so inlining shared behaviour is how the
   duplicated-and-drifted rules elsewhere in here happened.

   The API is deliberately tiny because both composers already listen for
   `input` on their textarea (home.html autoGrow/syncSend, code.html the
   character counter and send-button state). This sets .value and fires
   one input event; everything downstream updates itself:

       SouqiVoice.attach({ button: micEl, input: textareaEl });

   ---- what was wrong before --------------------------------------------

   1. FINALISED SPEECH WAS LOST. onresult built a string from
      event.resultIndex to the end and assigned it to .value. With
      continuous recognition, resultIndex advances past a segment once it
      finalises, so the next event overwrote the box with only the newest
      segment: say two sentences with a pause and the first vanished. The
      fix is to accumulate finalised text ourselves and treat only the
      interim tail as volatile.

   2. IT DESTROYED WHAT YOU HAD TYPED. Assigning to .value replaced the
      whole composer, so half a typed prompt was gone the moment you
      pressed the mic. Speech now appends to whatever was already there.

   3. CHROME STOPS ON SILENCE. Even with continuous = true the recogniser
      ends after a stretch of quiet; onend cleared the button while the
      person was still talking to it. It now restarts for as long as the
      user's intent is still "listening" — with a loop guard, because a
      recogniser that ends instantly and forever would otherwise spin.

   4. A DENIED MICROPHONE LOOKED LIKE A DEAD BUTTON. onerror logged to the
      console and cleared a class. Now every error the API can raise has a
      sentence a person can act on — including the one you get for free on
      a non-HTTPS deployment, where the browser blocks the mic outright.

   Also: the language follows the document instead of being hardcoded to
   en-US on a site that ships Arabic and Turkish, Escape cancels and puts
   back what you had, and where speech recognition does not exist at all
   (Firefox) the button hides rather than alert()-ing about it.
   ================================================================= */
(function () {
  "use strict";
  if (window.SouqiVoice) return; // guard against a double include

  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  var reduceMotion = false;
  try { reduceMotion = matchMedia("(prefers-reduced-motion:reduce)").matches; } catch (e) {}

  /* Web Speech wants a BCP-47 tag; applyLanguage() in js/ui.js only ever
     sets the short code on <html>. Anything not listed falls through to
     the tag as given, so adding a language to the site does not require
     touching this. */
  var LOCALES = { en: "en-US", ar: "ar-SA", tr: "tr-TR" };

  var ERRORS = {
    "not-allowed": "Microphone access is blocked. Allow it for this site in your browser settings, then try again.",
    "service-not-allowed": "This browser will not allow speech recognition here. On a site served over plain HTTP the microphone is blocked outright.",
    "audio-capture": "No microphone found. Check that one is connected and not in use by another app.",
    "network": "Speech recognition needs a network connection, and it could not reach the service.",
    "no-speech": "Didn't catch anything that time.",
    "aborted": ""   // the user cancelled; saying so would be noise
  };

  var CSS =
    /* The recording pill. Anchored to the button rather than docked into a
       composer, because the two pages that use this have different composer
       markup and neither should have to grow a slot for it. */
    ".sq-voice{position:fixed;z-index:2147483600;display:flex;align-items:center;gap:10px;" +
      "padding:8px 10px 8px 12px;border-radius:999px;pointer-events:auto;" +
      "background:var(--card,#fff);border:1px solid var(--line,#e4e4e7);" +
      "box-shadow:0 8px 26px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.08);" +
      "font:inherit;font-size:.82rem;color:var(--ink,#18181b);" +
      "opacity:0;transform:translateY(4px);transition:opacity .16s ease,transform .16s ease}" +
    ".sq-voice.on{opacity:1;transform:none}" +
    /* Bars are driven from a real AnalyserNode, so this is the actual input
       level and not a decorative loop. */
    ".sq-voice-bars{display:flex;align-items:center;gap:2px;height:18px}" +
    ".sq-voice-bars i{display:block;width:3px;min-height:3px;height:3px;border-radius:2px;" +
      "background:var(--accent,#1aa6df);transition:height .07s linear}" +
    ".sq-voice-time{font-variant-numeric:tabular-nums;color:var(--mut,#71717a);min-width:34px}" +
    ".sq-voice-stop{flex:none;width:24px;height:24px;border:0;border-radius:6px;cursor:pointer;" +
      "background:#ef4444;color:#fff;display:grid;place-items:center;font:inherit;padding:0}" +
    ".sq-voice-stop::before{content:\"\";width:8px;height:8px;border-radius:1px;background:currentColor}" +
    /* Errors and the unsupported case share one bubble. */
    ".sq-voice-msg{position:fixed;z-index:2147483600;max-width:280px;padding:9px 12px;border-radius:10px;" +
      "background:var(--card,#fff);border:1px solid var(--line,#e4e4e7);color:var(--ink,#18181b);" +
      "box-shadow:0 8px 26px rgba(0,0,0,.16);font:inherit;font-size:.8rem;line-height:1.45;" +
      "opacity:0;transform:translateY(4px);transition:opacity .16s ease,transform .16s ease}" +
    ".sq-voice-msg.on{opacity:1;transform:none}" +
    "@media (prefers-reduced-motion:reduce){" +
      ".sq-voice,.sq-voice-msg{transition:none}" +
      ".sq-voice-bars i{transition:none}}";

  var styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
    var s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /** Sit the element just above its button, clamped to the viewport. */
  function anchor(el, button, gap) {
    var b = button.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var left = Math.min(Math.max(8, b.left + b.width / 2 - r.width / 2), innerWidth - r.width - 8);
    var top = b.top - r.height - (gap || 10);
    // No room above (a composer pinned to the top of a short window) — go below.
    if (top < 8) top = b.bottom + (gap || 10);
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  function attach(opts) {
    var button = opts && opts.button;
    var input = opts && opts.input;
    if (!button || !input) return null;

    ensureStyle();

    // Nothing to attach to. Hiding beats an alert() explaining that the
    // button you just pressed was never going to work.
    if (!SpeechRec) { button.hidden = true; return null; }

    var recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;

    var listening = false;     // what the USER wants, not what the API is doing
    var baseText = "";         // the composer's contents when we started
    var finalText = "";        // everything the recogniser has committed
    var committed = 0;         // how many of ev.results are already in finalText
    var startedAt = 0;
    var restarts = 0;
    var lastRestart = 0;

    var pill = null, bars = [], timeEl = null, msgEl = null;
    var timer = null, raf = null;
    var audioCtx = null, stream = null, analyser = null, data = null;

    /* ---- the composer ---- */

    function compose(spoken) {
      var text = spoken.trim();
      if (!baseText) return text;
      return /\s$/.test(baseText) ? baseText + text : baseText + " " + text;
    }

    function write(spoken) {
      input.value = compose(spoken);
      // Both composers already react to this: autoGrow and the send-button
      // state on home, the character counter on the builder.
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    /* ---- the pill ---- */

    function buildPill() {
      pill = document.createElement("div");
      pill.className = "sq-voice";
      pill.setAttribute("role", "status");
      var barWrap = document.createElement("span");
      barWrap.className = "sq-voice-bars";
      for (var i = 0; i < 9; i++) {
        var bar = document.createElement("i");
        barWrap.appendChild(bar);
        bars.push(bar);
      }
      timeEl = document.createElement("span");
      timeEl.className = "sq-voice-time";
      timeEl.textContent = "0:00";
      var stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "sq-voice-stop";
      stopBtn.title = "Stop";
      stopBtn.setAttribute("aria-label", "Stop recording");
      stopBtn.addEventListener("click", function (e) { e.preventDefault(); stop(); });
      pill.appendChild(barWrap);
      pill.appendChild(timeEl);
      pill.appendChild(stopBtn);
      document.body.appendChild(pill);
    }

    function tickTime() {
      var s = Math.floor((Date.now() - startedAt) / 1000);
      timeEl.textContent = Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
    }

    /* A second microphone stream purely for the level meter. Separate from
       the one SpeechRecognition opens for itself — there is no API to read
       levels off the recogniser. If the browser refuses a second consumer
       (Safari has been known to), the pill still shows the timer and the
       button still pulses; only the bars are lost. */
    function startMeter() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        if (!listening) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
        var src = audioCtx.createMediaStreamSource(s);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.72;
        src.connect(analyser);
        data = new Uint8Array(analyser.frequencyBinCount);
        if (!reduceMotion) draw();
      }).catch(function () { /* no meter; the timer still runs */ });
    }

    function draw() {
      raf = requestAnimationFrame(draw);
      if (!analyser) return;
      analyser.getByteFrequencyData(data);
      // One band per bar, low frequencies first — speech lives down there,
      // so the bars move with the voice rather than with room hiss.
      var per = Math.max(1, Math.floor(data.length / bars.length / 2));
      for (var i = 0; i < bars.length; i++) {
        var sum = 0;
        for (var j = 0; j < per; j++) sum += data[i * per + j] || 0;
        var level = (sum / per) / 255;
        bars[i].style.height = Math.max(3, Math.round(3 + level * 15)) + "px";
      }
    }

    function stopMeter() {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
      analyser = null;
      bars.forEach(function (b) { b.style.height = "3px"; });
    }

    /* ---- messages ---- */

    function say(text) {
      if (!text) return;
      if (!msgEl) {
        msgEl = document.createElement("div");
        msgEl.className = "sq-voice-msg";
        msgEl.setAttribute("role", "alert");
        document.body.appendChild(msgEl);
      }
      msgEl.textContent = text;
      msgEl.classList.add("on");
      anchor(msgEl, button);
      clearTimeout(say._t);
      say._t = setTimeout(function () { msgEl.classList.remove("on"); }, 5200);
    }

    /* ---- start / stop / cancel ---- */

    function start() {
      if (listening) return;
      baseText = input.value || "";
      finalText = "";
      committed = 0;
      restarts = 0;
      listening = true;
      startedAt = Date.now();

      var lang = (document.documentElement.getAttribute("lang") || "en").toLowerCase();
      recognition.lang = LOCALES[lang] || lang || "en-US";

      try {
        recognition.start();
      } catch (e) {
        // Already running (a stop that has not settled yet). Let it be.
        listening = false;
        return;
      }

      button.classList.add("listening");
      button.setAttribute("aria-pressed", "true");
      button.title = "Stop (Esc cancels)";

      if (!pill) buildPill();
      pill.classList.add("on");
      anchor(pill, button);
      tickTime();
      timer = setInterval(tickTime, 250);
      window.addEventListener("resize", reanchor);
      window.addEventListener("scroll", reanchor, true);
      startMeter();
    }

    function reanchor() { if (pill && listening) anchor(pill, button); }

    function settle() {
      listening = false;
      button.classList.remove("listening");
      button.setAttribute("aria-pressed", "false");
      button.title = "Voice Input Mode — Speak to type";
      if (pill) pill.classList.remove("on");
      if (timer) { clearInterval(timer); timer = null; }
      window.removeEventListener("resize", reanchor);
      window.removeEventListener("scroll", reanchor, true);
      stopMeter();
    }

    function stop() {
      if (!listening) return;
      listening = false;            // set BEFORE stop(), so onend does not restart
      try { recognition.stop(); } catch (e) {}
      settle();
      input.focus();
    }

    function cancel() {
      if (!listening) return;
      listening = false;
      try { recognition.abort(); } catch (e) {}
      // Put back exactly what was there before the mic was pressed.
      input.value = baseText;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      settle();
      input.focus();
    }

    /* ---- wiring ---- */

    button.addEventListener("click", function (e) {
      e.preventDefault();
      if (listening) stop(); else start();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && listening) { e.preventDefault(); cancel(); }
    });

    recognition.onresult = function (ev) {
      /* ev.results is CUMULATIVE — every segment of the session, not just the
         new one — so this walks the whole list and commits each finalised
         segment exactly once, by index. The old code instead summed from
         ev.resultIndex and assigned the result, which threw away everything
         before the newest segment the moment one finalised.

         Committing by index rather than trusting each final to arrive once
         also means a re-delivered final cannot double up. */
      var interim = "";
      for (var i = 0; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (res.isFinal) {
          if (i >= committed) { finalText += res[0].transcript; committed = i + 1; }
        } else {
          interim += res[0].transcript;
        }
      }
      write(finalText + interim);
    };

    recognition.onend = function () {
      if (!listening) { settle(); return; }
      /* Chrome ends the session after a silence. The user has not asked to
         stop, so start again — but a recogniser that ends the instant it
         starts would spin here, so give up after a few in quick succession. */
      var now = Date.now();
      if (now - lastRestart < 900) restarts++; else restarts = 0;
      lastRestart = now;
      if (restarts > 4) { settle(); return; }
      try { recognition.start(); } catch (e) { settle(); }
    };

    recognition.onerror = function (ev) {
      var code = ev && ev.error;
      // no-speech is routine: Chrome raises it on a quiet stretch and then
      // ends, and onend restarts. Only surface it if we are giving up.
      if (code === "no-speech" && listening) return;
      var text = ERRORS.hasOwnProperty(code) ? ERRORS[code] : "Voice input stopped unexpectedly.";
      listening = false;
      settle();
      say(text);
    };

    return { start: start, stop: stop, cancel: cancel };
  }

  window.SouqiVoice = { attach: attach, supported: !!SpeechRec };
})();
