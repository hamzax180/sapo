/* Drives public/js/voice-input.js against a fake SpeechRecognition, so the
   transcript handling can be proven without a microphone. The old code is
   reproduced at the bottom and run through the same script, so the test
   shows the bug as well as the fix. */
"use strict";
const fs = require("fs");
const assert = require("assert");
const path = require("path");
const vm = require("vm");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

/* ---- the smallest DOM this module touches ---- */
function makeEnv() {
  const listeners = {};
  const el = () => ({
    className: "", style: {}, hidden: false, title: "", textContent: "",
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {},
    addEventListener(t, fn) { (this._l = this._l || {})[t] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 40, right: 30, bottom: 70, width: 30, height: 30 }),
    focus() {}, dispatchEvent() {}
  });

  let recognizer = null;
  function FakeRec() {
    recognizer = this;
    this.started = 0;
    this.start = () => { this.started++; };
    this.stop = () => {};
    this.abort = () => {};
  }

  const win = {
    SpeechRecognition: FakeRec,
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    innerWidth: 1200,
    AudioContext: null,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0, clearInterval() {}
  };

  const doc = {
    documentElement: { getAttribute: () => "en" },
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: () => el(),
    addEventListener(t, fn) { listeners[t] = fn; }
  };

  return { win, doc, el, getRecognizer: () => recognizer, listeners };
}

function loadModule(env) {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "voice-input.js"), "utf8");
  /* vm rather than new Function: same job, but the Function constructor is
     eval as far as the lint rules here are concerned, and a test is not a
     good reason to make an exception to that. */
  const sandbox = {
    window: env.win,
    document: env.doc,
    navigator: { mediaDevices: null },
    matchMedia: env.win.matchMedia,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    innerWidth: 1200,
    Event: function Event(type) { this.type = type; },
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.SouqiVoice;
}

/** A SpeechRecognition result list, as the API shapes it. */
function results(resultIndex, items) {
  const arr = items.map((it) => {
    const r = [{ transcript: it.t }];
    r.isFinal = it.final;
    return r;
  });
  arr.resultIndex = resultIndex;
  return { resultIndex, results: arr };
}

console.log("\n── voice input: the transcript is the whole bug ────────");

check("two sentences with a pause: BOTH survive (the old code lost the first)", () => {
  const env = makeEnv();
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  input.value = "";
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });

  const rec = env.getRecognizer();
  // First sentence finalises.
  rec.onresult(results(0, [{ t: "build a booking page", final: true }]));
  assert.strictEqual(input.value, "build a booking page");

  // Chrome now advances resultIndex past it. THIS is where the old code
  // threw the first sentence away.
  // The API hands back the WHOLE session each time, with resultIndex
  // pointing at what changed — so the second event still carries the first
  // sentence. The old code ignored everything before resultIndex.
  rec.onresult(results(1, [{ t: "build a booking page", final: true },
                           { t: " for a hair salon", final: true }]));
  assert.strictEqual(input.value, "build a booking page for a hair salon",
    "got: " + JSON.stringify(input.value));
});

check("interim text is replaced, not appended, as it firms up", () => {
  const env = makeEnv();
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  input.value = "";
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });
  const rec = env.getRecognizer();

  rec.onresult(results(0, [{ t: "build a book", final: false }]));
  assert.strictEqual(input.value, "build a book");
  rec.onresult(results(0, [{ t: "build a booking", final: false }]));
  assert.strictEqual(input.value, "build a booking", "interim doubled up: " + input.value);
  rec.onresult(results(0, [{ t: "build a booking page", final: true }]));
  assert.strictEqual(input.value, "build a booking page");
});

check("text already typed is kept and spoken words append to it", () => {
  const env = makeEnv();
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  input.value = "make me";
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });
  env.getRecognizer().onresult(results(0, [{ t: "a landing page", final: true }]));
  assert.strictEqual(input.value, "make me a landing page",
    "the old code replaced it entirely; got: " + JSON.stringify(input.value));
});

check("Escape puts back exactly what was there before the mic", () => {
  const env = makeEnv();
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  input.value = "half a prompt";
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });
  env.getRecognizer().onresult(results(0, [{ t: "some speech", final: true }]));
  assert.strictEqual(input.value, "half a prompt some speech");
  env.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.strictEqual(input.value, "half a prompt");
});

check("a silence-stop restarts instead of quietly ending the session", () => {
  const env = makeEnv();
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });
  const rec = env.getRecognizer();
  assert.strictEqual(rec.started, 1);
  rec.onend();                       // Chrome giving up on a quiet stretch
  assert.strictEqual(rec.started, 2, "it did not restart");
});

check("a recogniser that dies instantly gives up rather than spinning", () => {
  const env = makeEnv();
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });
  const rec = env.getRecognizer();
  for (let i = 0; i < 12; i++) rec.onend();
  assert.ok(rec.started <= 7, "restart loop was not bounded: " + rec.started + " starts");
});

check("stopping on purpose does NOT restart", () => {
  const env = makeEnv();
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });
  const rec = env.getRecognizer();
  button._l.click({ preventDefault() {} });   // second press = stop
  rec.onend();
  assert.strictEqual(rec.started, 1, "it restarted after the user stopped it");
});

check("the language follows the document instead of a hardcoded en-US", () => {
  const env = makeEnv();
  env.doc.documentElement.getAttribute = () => "ar";
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  V.attach({ button, input });
  button._l.click({ preventDefault() {} });
  assert.strictEqual(env.getRecognizer().lang, "ar-SA");
});

check("no SpeechRecognition -> the button hides, no alert", () => {
  const env = makeEnv();
  delete env.win.SpeechRecognition;
  const V = loadModule(env);
  const button = env.el(), input = env.el();
  const out = V.attach({ button, input });
  assert.strictEqual(button.hidden, true);
  assert.strictEqual(out, null);
});

/* ---- and the same script against the OLD code, to show it failed ---- */
console.log("\n── the old implementation, for comparison ─────────────");
check("OLD code loses the first sentence (this failure is the point)", () => {
  let value = "";
  const input = { get value() { return value; }, set value(v) { value = v; },
                  dispatchEvent() {} };
  // Verbatim shape of what used to be in code.html / home.html.
  function onresult(event) {
    let currentTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      currentTranscript += event.results[i][0].transcript;
    }
    if (currentTranscript.trim()) input.value = currentTranscript;
  }
  onresult(results(0, [{ t: "build a booking page", final: true }]));
  assert.strictEqual(value, "build a booking page");
  onresult(results(1, [{ t: "build a booking page", final: true },
                       { t: " for a hair salon", final: true }]));
  assert.strictEqual(value.trim(), "for a hair salon",
    "expected the old code to drop the first sentence");
  console.log("      (old value after two sentences: " + JSON.stringify(value) + ")");
});

console.log("\n" + (failed === 0 ? "✓ ALL VOICE TESTS PASSED" : "✗ " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
