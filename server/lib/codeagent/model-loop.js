/* =================================================================
   codeagent/model-loop.js — DeepSeek proposes file writes, single-shot
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md Phase 3 + §8. This is the FIRST place in
   the codebase where model output is allowed to become code that
   actually runs — which is exactly why the caller of proposeChanges()
   must be pointed at the daytona runtime and never local-runtime.js
   (see local-runtime.js's own header: "the code-generating agent must
   run ONLY there").

   Single-shot, no repair: one model call, whatever write_file calls
   it proposes get validated and returned as data. This module never
   executes anything itself — codeagent-phase3-demo.js is the one that
   takes the returned calls and runs them against a real sandbox's
   tools.js, so the execution boundary is a caller decision, not
   buried in here.

   Only `write_file` is offered as a tool. Not `run`, not npm install:
   the fixed scaffold's dependencies are already installed before the
   model ever sees the workspace (docs/CODE-AGENT-PLAN.md §1 — "one
   stack, not whatever the model picks"). A model that wants a package
   outside react/react-dom/tailwind will fail the build, and that
   failure is itself part of what Phase 3 is measuring.
   ================================================================= */
"use strict";

const crypto = require("crypto");
const client = require("../ai/client");

/* ---------- response cache (docs/AI-PROVIDER-PLAN.md §4.1) ----------
   "Don't call it" is the biggest cost lever there is — cheaper than any
   prefix-cache discount, because it's zero tokens, not fewer tokens. Two
   requests for the literal same design (a retry, a repeated test prompt,
   two people describing the same kind of shop the same way) produce the
   same files without a second call to DeepSeek.

   Exact-match only, deliberately — no fuzzy/semantic matching. "A barber
   shop landing page" and "a landing page for a barber shop" are different
   cache entries, not a near-miss worth guessing at; serving someone else's
   design for a prompt that only LOOKS similar is worse than a cache miss.

   In-memory, so it resets on restart — that's an accepted limitation
   (matches ai/client.js's own in-memory spend tracker), not an oversight;
   this is a request-storm dampener, not a durable store. PROMPT_VERSION
   is folded into the key so editing SYSTEM_PROMPT or the tool schema
   invalidates every entry at once rather than serving stale designs
   against a prompt that no longer matches what generated them. */
// Bumped whenever SYSTEM_PROMPT or the tool schema changes — the key
// folds this in, so an old entry can't serve a design generated under
// instructions that no longer apply. v2: engineer voice + size guidance.
const PROMPT_VERSION = "v2";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

function cacheKey(userPrompt) {
  const normalized = String(userPrompt || "").trim().toLowerCase().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(PROMPT_VERSION + "|" + normalized).digest("hex");
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
}
function clearCache() { cache.clear(); }

function getFallbackAppCode(userPrompt) {
  const p = String(userPrompt || "").toLowerCase();
  if (p.includes("game") || p.includes("2d") || p.includes("arcade") || p.includes("play")) {
    return `import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [health, setHealth] = useState(100);

  const gameState = useRef({
    player: { x: 180, y: 340, width: 30, height: 30, speed: 6 },
    bullets: [] as { x: number; y: number; speed: number }[],
    enemies: [] as { x: number; y: number; width: number; height: number; speed: number; color: string }[],
    keys: { ArrowLeft: false, ArrowRight: false },
    score: 0,
    health: 100,
    active: false,
  });

  const startGame = () => {
    gameState.current = {
      player: { x: 180, y: 340, width: 30, height: 30, speed: 6 },
      bullets: [],
      enemies: [],
      keys: { ArrowLeft: false, ArrowRight: false },
      score: 0,
      health: 100,
      active: true,
    };
    setScore(0);
    setHealth(100);
    setGameOver(false);
    setGameStarted(true);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') gameState.current.keys.ArrowLeft = true;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') gameState.current.keys.ArrowRight = true;
      if (e.code === 'Space') {
        e.preventDefault();
        if (gameState.current.active) {
          gameState.current.bullets.push({
            x: gameState.current.player.x + 13,
            y: gameState.current.player.y,
            speed: 9,
          });
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') gameState.current.keys.ArrowLeft = false;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') gameState.current.keys.ArrowRight = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useEffect(() => {
    let animId: number;
    let lastEnemyTime = Date.now();

    const loop = () => {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, cvs.width, cvs.height);

      if (gameState.current.active) {
        const state = gameState.current;

        if (state.keys.ArrowLeft && state.player.x > 0) state.player.x -= state.player.speed;
        if (state.keys.ArrowRight && state.player.x < cvs.width - state.player.width) state.player.x += state.player.speed;

        if (Date.now() - lastEnemyTime > 800) {
          state.enemies.push({
            x: Math.random() * (cvs.width - 30),
            y: -30,
            width: 28,
            height: 28,
            speed: 2 + Math.random() * 2.5,
            color: ['#ef4444', '#f59e0b', '#ec4899'][Math.floor(Math.random() * 3)],
          });
          lastEnemyTime = Date.now();
        }

        ctx.fillStyle = '#38bdf8';
        for (let i = state.bullets.length - 1; i >= 0; i--) {
          const b = state.bullets[i];
          b.y -= b.speed;
          ctx.fillRect(b.x, b.y, 4, 10);
          if (b.y < -10) state.bullets.splice(i, 1);
        }

        for (let i = state.enemies.length - 1; i >= 0; i--) {
          const enemy = state.enemies[i];
          enemy.y += enemy.speed;
          ctx.fillStyle = enemy.color;
          ctx.beginPath();
          ctx.arc(enemy.x + 14, enemy.y + 14, 14, 0, Math.PI * 2);
          ctx.fill();

          for (let j = state.bullets.length - 1; j >= 0; j--) {
            const b = state.bullets[j];
            if (
              b.x >= enemy.x &&
              b.x <= enemy.x + enemy.width &&
              b.y >= enemy.y &&
              b.y <= enemy.y + enemy.height
            ) {
              state.enemies.splice(i, 1);
              state.bullets.splice(j, 1);
              state.score += 10;
              setScore(state.score);
              break;
            }
          }

          if (enemy.y > cvs.height) {
            state.enemies.splice(i, 1);
            state.health -= 15;
            setHealth(Math.max(0, state.health));
          }
        }

        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.moveTo(state.player.x + 15, state.player.y);
        ctx.lineTo(state.player.x, state.player.y + 30);
        ctx.lineTo(state.player.x + 30, state.player.y + 30);
        ctx.closePath();
        ctx.fill();

        if (state.health <= 0) {
          state.active = false;
          setGameOver(true);
          setHighScore((prev) => Math.max(prev, state.score));
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4 text-center">
        <div className="flex justify-between items-center border-b border-slate-800 pb-3">
          <div>
            <h1 className="text-2xl font-black tracking-wider text-sky-400">2D SPACE DEFENDER</h1>
            <p className="text-xs text-slate-400">Use ◀ ▶ or A/D to move, SPACE to shoot</p>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400">HIGH SCORE</div>
            <div className="text-lg font-bold text-amber-400">{highScore}</div>
          </div>
        </div>

        <div className="flex justify-between text-sm font-semibold px-2">
          <span>Score: <strong className="text-sky-400">{score}</strong></span>
          <span>Shield: <strong className={health > 30 ? "text-emerald-400" : "text-rose-500"}>{health}%</strong></span>
        </div>

        <div className="relative mx-auto rounded-xl overflow-hidden border-2 border-slate-800 bg-slate-900">
          <canvas ref={canvasRef} width={400} height={400} className="block w-full h-[400px]" />

          {(!gameStarted || gameOver) && (
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur flex flex-col items-center justify-center space-y-4 p-6">
              <h2 className="text-3xl font-extrabold text-white">
                {gameOver ? "GAME OVER 💥" : "READY TO PLAY? 🚀"}
              </h2>
              {gameOver && <p className="text-slate-300">Final Score: {score}</p>}
              <button
                onClick={startGame}
                className="bg-sky-500 hover:bg-sky-400 text-slate-950 font-black px-8 py-3 rounded-xl transition transform active:scale-95 shadow-lg shadow-sky-500/20"
              >
                {gameOver ? "PLAY AGAIN" : "START GAME"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
`;
  }

  if (p.includes("coffee") || p.includes("cafe") || p.includes("roast")) {
    return `import React, { useState } from 'react';

export default function App() {
  const [cart, setCart] = useState<{ id: number; name: string; price: number; qty: number }[]>([]);
  const menu = [
    { id: 1, name: "Artisanal Espresso", desc: "Rich & bold double shot from Ethiopian beans", price: 4.50 },
    { id: 2, name: "Caramel Cold Brew", desc: "Steeped 18 hours with house caramel drizzle", price: 5.75 },
    { id: 3, name: "Oat Milk Flat White", desc: "Silky steamed oat milk with espresso duo", price: 5.25 },
    { id: 4, name: "Matcha Latte", desc: "Uji ceremonial grade matcha with vanilla bean", price: 6.00 },
    { id: 5, name: "Butter Croissant", desc: "Freshly baked French flaky butter pastry", price: 3.75 },
  ];

  const addToCart = (item: typeof menu[0]) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === item.id);
      if (existing) {
        return prev.map((i) => (i.id === item.id ? { ...i, qty: i.qty + 1 } : i));
      }
      return [...prev, { id: item.id, name: item.name, price: item.price, qty: 1 }];
    });
  };

  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);

  return (
    <div className="min-h-screen bg-stone-900 text-stone-100 font-sans">
      <header className="border-b border-stone-800 bg-stone-950/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">☕</span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-amber-500">Velvet Roast Coffee</h1>
              <p className="text-xs text-stone-400">Craft Coffee & Artisanal Bakery</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="bg-stone-800 text-amber-400 px-3 py-1.5 rounded-full text-sm font-medium">
              🛒 {cart.reduce((s, i) => s + i.qty, 0)} items (\${total.toFixed(2)})
            </span>
          </div>
        </div>
      </header>

      <section className="py-16 px-6 bg-gradient-to-b from-stone-950 to-stone-900 text-center">
        <div className="max-w-3xl mx-auto space-y-4">
          <span className="inline-block bg-amber-500/10 text-amber-400 border border-amber-500/20 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider">
            Freshly Roasted Daily
          </span>
          <h2 className="text-4xl md:text-5xl font-extrabold text-stone-50">Exceptional Coffee, Crafted for You</h2>
          <p className="text-stone-400 text-lg">Order ahead for pickup or discover our single-origin roasts delivered to your door.</p>
        </div>
      </section>

      <main className="max-w-6xl mx-auto px-6 py-12 grid md:grid-cols-3 gap-8">
        <div className="md:col-span-2 space-y-6">
          <h3 className="text-2xl font-bold text-stone-100 flex items-center gap-2">
            <span>✨</span> Popular Menu
          </h3>
          <div className="grid sm:grid-cols-2 gap-4">
            {menu.map((item) => (
              <div key={item.id} className="bg-stone-800/60 border border-stone-700/50 rounded-xl p-5 hover:border-amber-500/50 transition duration-200 flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start mb-2">
                    <h4 className="font-semibold text-lg text-stone-100">{item.name}</h4>
                    <span className="text-amber-400 font-bold">\${item.price.toFixed(2)}</span>
                  </div>
                  <p className="text-stone-400 text-sm mb-4">{item.desc}</p>
                </div>
                <button onClick={() => addToCart(item)} className="w-full bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold py-2 rounded-lg transition text-sm">
                  Add to Order
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-stone-950 border border-stone-800 rounded-xl p-6 h-fit sticky top-24">
          <h3 className="text-xl font-bold mb-4 text-stone-100 flex items-center justify-between">
            <span>Your Order</span>
            <span className="text-xs font-normal text-stone-400">{cart.length} unique items</span>
          </h3>
          {cart.length === 0 ? (
            <p className="text-stone-500 text-sm py-8 text-center">Your cart is empty. Click any menu item to start your order!</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                {cart.map((i) => (
                  <div key={i.id} className="flex justify-between items-center text-sm border-b border-stone-800/80 pb-2">
                    <div>
                      <p className="font-medium text-stone-200">{i.name}</p>
                      <p className="text-xs text-stone-400">\${i.price.toFixed(2)} × {i.qty}</p>
                    </div>
                    <span className="font-bold text-amber-400">\${(i.price * i.qty).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-stone-800 pt-4 flex justify-between font-bold text-lg text-stone-100">
                <span>Total</span>
                <span className="text-amber-400">\${total.toFixed(2)}</span>
              </div>
              <button onClick={() => alert("Order placed successfully! Pickup ready in 10 mins.")} className="w-full bg-amber-500 hover:bg-amber-400 text-stone-950 font-bold py-3 rounded-lg text-center transition">
                Checkout & Pay
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
`;
  }

  return `import React, { useState } from 'react';

export default function App() {
  const [items, setItems] = useState<{ id: number; text: string; done: boolean }[]>([
    { id: 1, text: "Explore Souqi Platform Features", done: true },
    { id: 2, text: "Build custom storefront & operations app", done: false },
    { id: 3, text: "Connect domain & deploy to production", done: false },
  ]);
  const [text, setText] = useState("");

  const add = () => {
    if (!text.trim()) return;
    setItems((prev) => [...prev, { id: Date.now(), text: text.trim(), done: false }]);
    setText("");
  };

  const toggle = (id: number) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-slate-800 border border-slate-700 rounded-2xl shadow-xl p-8 space-y-6">
        <div className="flex items-center justify-between border-b border-slate-700 pb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-50">Souqi Operations App</h1>
            <p className="text-slate-400 text-sm">Interactive Task & Sourcing Dashboard</p>
          </div>
          <span className="bg-indigo-500/20 text-indigo-400 px-3 py-1 rounded-full text-xs font-semibold border border-indigo-500/30">Active</span>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Add new operation or item..."
            className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <button onClick={add} className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-5 py-2.5 rounded-xl text-sm transition">
            Add
          </button>
        </div>

        <div className="space-y-2">
          {items.map((i) => (
            <div key={i.id} onClick={() => toggle(i.id)} className="flex items-center gap-3 bg-slate-900/60 border border-slate-700/50 p-4 rounded-xl cursor-pointer hover:border-slate-600 transition">
              <input type="checkbox" checked={i.done} onChange={() => {}} className="w-4 h-4 text-indigo-600 rounded focus:ring-0" />
              <span className={\`flex-1 text-sm \${i.done ? 'line-through text-slate-500' : 'text-slate-200'}\`}>{i.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
`;
}

const TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite a file in the project. Paths are relative to the project root (e.g. \"src/App.tsx\", \"src/components/Hero.tsx\"). Content must be the COMPLETE file — this replaces whatever is there, it does not append.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path, e.g. src/App.tsx" },
          content: { type: "string", description: "The full, final content of the file." }
        },
        required: ["path", "content"]
      }
    }
  }
];

// Stable block FIRST, byte-identical across every call — this is the part
// DeepSeek's prefix cache can actually discount (docs/AI-PROVIDER-PLAN.md
// §4.2 / CODE-AGENT-PLAN.md §8). Never interpolate anything per-request
// (a business name, a timestamp) above this point.
const SYSTEM_PROMPT = `You are a senior front-end engineer building an app WITH someone, not a code generator handing back files. Talk to them the way a good colleague would: briefly, plainly, and like a person.

Alongside your file writes, write a short message (1-3 sentences) in your reply text:
- Say what you built or changed, in plain language — "Added a monthly total and a category filter", not "Implemented requested functionality".
- If you made a judgement call they didn't specify, say so in a few words: what you chose and why. ("I grouped expenses by month since you mentioned tracking over time — easy to switch to weekly.")
- If something in the request is genuinely ambiguous and the choice would be hard to undo, ask ONE specific question instead of guessing. Ask about the thing that actually matters, not trivia.
- No preamble, no "Certainly!", no restating their request back at them, no bullet-point summaries of every file you touched. Never claim you tested or verified something you did not.

You are not choosing the stack — it is fixed and already installed:
- React 18 + TypeScript, function components with hooks only
- Tailwind CSS utility classes for ALL styling — no separate .css files, no styled-components, no inline style objects
- The app's entry point is src/main.tsx, which renders src/App.tsx — you only ever need to write/overwrite src/App.tsx and, optionally, new files under src/components/ that App.tsx imports

Rules:
- Call write_file for every file you create or change. One call per file. Always write at least one file unless you are asking a clarifying question.
- src/App.tsx must have a default export and must compile under TypeScript strict mode.
- DO NOT import 'lucide-react', 'heroicons', or any uninstalled packages. ONLY import from 'react' or 'react-dom'. Use inline SVG elements, emoji, or Tailwind styled elements for icons.
- Do not write index.html, package.json, vite.config.ts, tailwind.config.js, or tsconfig.json — those are fixed and already correct.
- Do not fetch external images by URL you are unsure exists; prefer CSS gradients, solid colors, or emoji over broken <img> tags.
- Keep it to ONE file (src/App.tsx) unless the request clearly needs more. Every extra file is another full generation the user waits for.
- RESPONSIVE DESIGN IS MANDATORY: Every app you build MUST look great on BOTH mobile (375px) and desktop (1200px+). Use Tailwind responsive prefixes (sm:, md:, lg:) for layout. Mobile-first: default styles for mobile, then sm:/md:/lg: for wider screens. Use flex-wrap, grid with responsive columns (grid-cols-1 sm:grid-cols-2 lg:grid-cols-3), and relative units. Never use fixed px widths wider than 340px on any container or element. Test mentally: would this overflow or look broken on a 375px screen? If yes, fix it before writing.
- Aim for roughly 120-200 lines. Make it look considered — real spacing, hierarchy, an empty state — with realistic sample data, never lorem ipsum. Do NOT pad it out: no long hardcoded data arrays, no repeated near-identical blocks, no commentary comments. Concise, complete, and fast to generate beats exhaustive.`;

/**
 * The model's own words alongside its tool calls — trimmed to something
 * safe to render as a chat line.
 *
 * Capped and stripped rather than passed through: `content` is free-form
 * model output, and this ends up in the transcript and the UI. Fenced
 * code blocks are dropped because the files themselves are already the
 * output — a model that also pastes the component into prose would
 * double the message for no added information.
 */
function modelNote(message) {
  let text = (message && typeof message.content === "string") ? message.content : "";
  if (!text) return "";
  text = text.replace(/```[\s\S]*?```/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) return "";
  return text.length > 600 ? text.slice(0, 600).trimEnd() + "…" : text;
}

function validateWriteFileArgs(args) {
  if (!args || typeof args !== "object") throw new Error("tool call arguments were not an object");
  if (typeof args.path !== "string" || !args.path.trim()) throw new Error("write_file: \"path\" must be a non-empty string");
  if (typeof args.content !== "string") throw new Error("write_file: \"content\" must be a string");
  if (args.path.startsWith("/") || args.path.includes("..")) throw new Error("write_file: \"" + args.path + "\" is not a safe relative path");
  if (!/^src\//.test(args.path)) throw new Error("write_file: only files under src/ are allowed, got \"" + args.path + "\"");
  return { path: args.path, content: args.content };
}

/** Parses and validates every tool_call in a message. Malformed JSON in
    ONE call fails the whole batch — a half-applied write set is worse
    than no writes, since the caller can't tell which half is safe to run. */
function parseToolCalls(message) {
  const calls = (message && message.tool_calls) || [];
  if (!calls.length) return { ok: false, reason: "model returned no tool calls", content: message && message.content };
  const parsed = [];
  for (const c of calls) {
    if (!c.function || c.function.name !== "write_file") {
      return { ok: false, reason: "unexpected tool call: " + (c.function && c.function.name) };
    }
    let args;
    try { args = JSON.parse(c.function.arguments); }
    catch (e) { return { ok: false, reason: "malformed JSON in tool call arguments: " + e.message, raw: c.function.arguments }; }
    try { parsed.push(validateWriteFileArgs(args)); }
    catch (e) { return { ok: false, reason: e.message, raw: c.function.arguments }; }
  }
  return { ok: true, calls: parsed };
}

// 8000, not an initial 3000: found live, not by estimate — a real
// multi-section landing page truncated mid-JSON-string at ~3000 tokens
// (the tool call's arguments are the WHOLE file as an escaped JSON string,
// so a cut-off completion is a cut-off file, which then fails JSON.parse —
// indistinguishable from "malformed output" without this context). 8000 is
// headroom, not the expected size — a real single-file page runs well
// under it in practice.
const MAX_TOKENS = 4000;
const TEMPERATURE = 0.3;
const CALL_TIMEOUT_MS = 60000;

// Found live against a REAL follow-up, not an estimate: index.js builds a
// follow-up's userPrompt as "The current src/App.tsx is:\n\n" + the whole
// file + "\n\nChange request: " + what the user actually typed — and the
// actual request is the LAST thing in that string. A single-file app is
// routinely 8-15KB once it has real content, so the old 2000-char cap sliced
// the message down to a fragment of the file dump and silently dropped the
// change request entirely — the model never saw it, so it never had a
// chance to act on it. Confirmed by reading a real project's revision
// history: two consecutive follow-ups asking for a "money sharing" /
// "rent and utilities" feature produced zero occurrences of "money", "rent",
// "utility", or "price" in the output, across all three revisions. 30000
// chars (~7.5K tokens) comfortably fits a large single-file app plus the
// request; the extra input tokens cost a fraction of a cent (docs/
// CODE-AGENT-PLAN.md §10's own pricing table), so the 2000 figure was never
// a deliberate cost tradeoff, just sized for a short freeform first prompt
// and never revisited for what a follow-up actually needs to carry.
const MAX_USER_PROMPT_CHARS = 30000;

/**
 * One model call, with the "retry once on malformed tool-call JSON, then a
 * clean failure" policy (docs/CODE-AGENT-PLAN.md §8) — this is a syntax
 * retry, never a code-quality one. Shared by proposeChanges (single-shot)
 * and proposeWithRepair (Phase 4): both need "make one good-faith attempt
 * at valid tool calls," they just do different things with the result.
 *
 * Returns the raw assistant `message` (not just the parsed calls) because
 * the repair loop needs it verbatim to continue the conversation — an
 * assistant message with tool_calls has to reappear exactly as sent before
 * the required tool-role responses can follow it (see the protocol note
 * below), and a caller can't reconstruct that from parsed args alone.
 */
// Found live: "malformed tool call twice in a row" on a real request (a
// team-tasks dashboard) that failed identically both times, at almost
// exactly MAX_TOKENS worth of output (an "unterminated string" a few
// characters short of 8000 tokens' worth of JSON). The model wasn't
// writing bad syntax — the completion was being CUT OFF mid-string by the
// token cap, which JSON.parse then reports as malformed. The retry was
// reusing the exact same maxTokens that had just proven insufficient, so
// a genuinely large single-file app failed the same way every time,
// permanently, with no path to success. finishReason distinguishes the
// two cases (client.js surfaces the provider's own finish_reason): a
// truncated completion gets a bigger budget on retry instead of an
// identical doomed one; an actually-malformed completion (finishReason
// "stop"/"tool_calls") still just retries once at the normal size, since
// more tokens wouldn't fix a real syntax mistake.
const RETRY_MAX_TOKENS = 8000;

async function attemptOnce(messages) {
  const res = await client.chat({ route: "json", messages, tools: TOOLS_SCHEMA, maxTokens: MAX_TOKENS, temperature: TEMPERATURE, timeoutMs: CALL_TIMEOUT_MS });
  if (!res.ok) return { ok: false, reason: res.reason || "model call failed", disabled: res.disabled, breakerOpen: res.breakerOpen, budgetExceeded: res.budgetExceeded };

  const parsed = parseToolCalls(res.message);
  // `note` is the model's own prose alongside its tool calls — what it
  // built and why, or a judgement call it made. It was being discarded
  // entirely (only .calls was ever read), which is why the agent could
  // never say anything and every build landed as a silent wall of files.
  if (parsed.ok) return { ok: true, calls: parsed.calls, note: modelNote(res.message), message: res.message, retried: false, usage: res.usage, costUsd: res.costUsd };

  const truncated = res.finishReason === "length";
  const retryMaxTokens = truncated ? RETRY_MAX_TOKENS : MAX_TOKENS;

  // Protocol requirement, found live against the real API (a stub never
  // catches this — nothing enforces it client-side): an assistant message
  // that carries `tool_calls` MUST be immediately followed by one `tool`
  // role message per call, addressed by `tool_call_id`, before anything
  // else. Skipping straight to a `user` message is a 400 from the
  // provider, not a retry.
  const toolResponses = (res.message.tool_calls || []).map((c) => ({
    role: "tool", tool_call_id: c.id, content: "Error: " + parsed.reason
  }));
  const retryAsk = truncated
    ? "Your last response was cut off before it finished (" + parsed.reason + "). Call write_file again — write a SHORTER, simpler version of the same file if needed so the full write_file call fits."
    : "Your last response was not usable: " + parsed.reason + ". Call write_file again with valid arguments.";
  const retryMessages = messages.concat([res.message], toolResponses, [{ role: "user", content: retryAsk }]);
  const retryRes = await client.chat({ route: "json", messages: retryMessages, tools: TOOLS_SCHEMA, maxTokens: retryMaxTokens, temperature: TEMPERATURE, timeoutMs: CALL_TIMEOUT_MS });
  if (!retryRes.ok) return { ok: false, reason: retryRes.reason || "retry call failed" };
  const retryParsed = parseToolCalls(retryRes.message);
  if (!retryParsed.ok) {
    const retryTruncated = retryRes.finishReason === "length";
    const reason = retryTruncated
      ? "the file was still too large to finish writing even with a larger budget: " + retryParsed.reason
      : "malformed tool call twice in a row: " + retryParsed.reason;
    return { ok: false, reason: reason };
  }
  return {
    ok: true, calls: retryParsed.calls, message: retryRes.message, retried: true,
    usage: retryRes.usage, costUsd: (res.costUsd || 0) + (retryRes.costUsd || 0)
  };
}

/**
 * One model call. No repair, no re-generation of code — see attemptOnce for
 * the one syntax-level retry this still does. Checks the response cache
 * first (see header) — a hit returns the exact same file set for $0 and no
 * network call at all.
 *
 * @param {string} userPrompt
 * @returns {Promise<{ok:boolean, calls?:Array<{path,content}>, reason?:string, usage?:object, costUsd?:number, cached?:boolean}>}
 */
async function proposeChanges(userPrompt) {
  const key = cacheKey(userPrompt);
  const cached = cacheGet(key);
  if (cached) return Object.assign({}, cached, { cached: true, costUsd: 0 });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: String(userPrompt || "").slice(0, MAX_USER_PROMPT_CHARS) }
  ];
  const attempt = await attemptOnce(messages);
  if (!attempt.ok) {
    const fallbackContent = getFallbackAppCode(userPrompt);
    const fallbackCalls = [{ path: "src/App.tsx", content: fallbackContent }];
    return { ok: true, calls: fallbackCalls, note: "Built template app (AI model unavailable).", retried: false, cached: false, costUsd: 0 };
  }

  const result = { ok: true, calls: attempt.calls, note: attempt.note, retried: attempt.retried, cached: false, usage: attempt.usage, costUsd: attempt.costUsd };
  cacheSet(key, result);
  return result;
}

const DEFAULT_MAX_REPAIR_ROUNDS = 6; // docs/CODE-AGENT-PLAN.md §2 hard cap

/**
 * Propose → write → build → if it fails, feed the ACTUAL errors back and
 * try again, capped. This is Phase 4 — "the phase that makes it feel like
 * Replit" per the plan, because a one-shot generator that gives up on the
 * first TypeScript error isn't an agent, it's autocomplete.
 *
 * Unlike proposeChanges, this DOES execute — it needs the real build
 * result to know whether to keep going, so it takes `tools` (from
 * tools.js, bound to a real sandbox) directly. The safety boundary does
 * NOT move: the CALLER still decides which runtime's tools to hand in,
 * and that must be the daytona runtime, never local-runtime.js, for
 * exactly the reason proposeChanges' own file header explains — this
 * function is not an exception to that, it just makes the execution
 * explicit instead of leaving it to the caller in a second step.
 *
 * Not cached — proposeChanges' cache is keyed on "the design for this
 * prompt," and a repair loop's result is round-dependent (a fixed version
 * of the design, not the design itself), so there's no single stable
 * answer to cache without conflating the two.
 *
 * @param {object} opts
 * @param {string} opts.userPrompt
 * @param {object} opts.tools        from tools.js, bound to a real sandbox
 * @param {number} [opts.maxRounds]  hard cap on REPAIR attempts, i.e. total tries = maxRounds + 1 (default 6, docs/CODE-AGENT-PLAN.md §2)
 * @param {(info:{round:number, ok:boolean, calls, errors?}) => void} [opts.onRound]
 */
async function proposeWithRepair({ userPrompt, tools, maxRounds, onRound }) {
  const cap = (maxRounds !== null && maxRounds !== undefined) ? maxRounds : DEFAULT_MAX_REPAIR_ROUNDS;
  let messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: String(userPrompt || "").slice(0, MAX_USER_PROMPT_CHARS) }
  ];
  let totalCost = 0;
  let jsonRetries = 0;

  for (let round = 0; round <= cap; round++) {
    const attempt = await attemptOnce(messages);
    if (!attempt.ok) {
      return {
        ok: false, reason: attempt.reason, round, rounds: round + 1, costUsd: totalCost,
        disabled: attempt.disabled, breakerOpen: attempt.breakerOpen, budgetExceeded: attempt.budgetExceeded
      };
    }
    totalCost += attempt.costUsd || 0;
    if (attempt.retried) jsonRetries += 1;

    for (const c of attempt.calls) await tools.write_file(c.path, c.content);
    const build = await tools.build(180000);

    if (onRound) onRound({ round, ok: build.ok, calls: attempt.calls, errors: build.ok ? undefined : build.errors });

    if (build.ok) {
      return { ok: true, calls: attempt.calls, note: attempt.note, round, rounds: round + 1, repaired: round > 0, costUsd: totalCost, jsonRetries };
    }
    if (round === cap) {
      return { ok: false, reason: "build still failing after " + (cap + 1) + " attempt(s)", round, rounds: round + 1, lastErrors: build.errors, costUsd: totalCost };
    }

    // Feed the ACTUAL structured build errors back (build-parser.js's
    // {file,line,message}, not raw compiler noise), capped so a huge error
    // dump doesn't eat the next round's own token budget.
    const toolResponses = (attempt.message.tool_calls || []).map((c) => ({
      role: "tool", tool_call_id: c.id, content: "File written, but the build failed — see the next message for the errors."
    }));
    const errorSummary = build.errors.slice(0, 8)
      .map((e) => (e.file ? e.file + ":" + e.line + " — " + e.message : e.message))
      .join("\n");
    messages = messages.concat([attempt.message], toolResponses, [
      { role: "user", content: "The build failed with these errors:\n" + errorSummary + "\n\nFix them. Call write_file again with the corrected file(s) — rewrite the WHOLE file, not a diff." }
    ]);
  }
}

/**
 * Like proposeWithRepair, but delegates build execution to the caller.
 * Used for WebContainer builds where the client runs the build.
 *
 * @param {object} opts
 * @param {string} opts.userPrompt
 * @param {number} [opts.maxRounds=3]
 * @param {function} opts.onFiles - async (files: {path,content}[]) => {ok, errors: [{file,line,col,code,message}], raw?}
 *   Called with proposed files. Caller writes + builds them and returns build result.
 * @param {function} [opts.onRound] - (info) => void, same shape as proposeWithRepair
 * @returns {Promise<{ok, calls?, round?, rounds, repaired?, costUsd, reason?}>}
 */
async function proposeWithClientBuild({ userPrompt, maxRounds, onFiles, onRound }) {
  const cap = (maxRounds !== null && maxRounds !== undefined) ? maxRounds : 3;
  let messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: String(userPrompt || "").slice(0, MAX_USER_PROMPT_CHARS) }
  ];
  let totalCost = 0;
  let jsonRetries = 0;

  const key = cacheKey(userPrompt);
  const cached = cacheGet(key);

  if (cached) {
    const build = await onFiles(cached.calls);
    if (onRound) onRound({ round: 0, ok: build.ok, calls: cached.calls, errors: build.ok ? undefined : build.errors });
    if (build.ok) {
      return Object.assign({}, cached, { round: 0, rounds: 1, repaired: false, cached: true, costUsd: 0, jsonRetries: 0 });
    }
    // If cached design fails to build, we continue to a fresh round 0 to get the `message` needed for the repair loop.
  }

  for (let round = 0; round <= cap; round++) {
    let attempt = await attemptOnce(messages);
    if (!attempt.ok) {
      // Fallback: if LLM provider is overloaded or failing, generate clean fallback App.tsx
      const fallbackContent = getFallbackAppCode(userPrompt);
      const fallbackCalls = [{ path: "src/App.tsx", content: fallbackContent }];
      const fallbackBuild = await onFiles(fallbackCalls);
      if (fallbackBuild.ok) {
        if (onRound) onRound({ round, ok: true, calls: fallbackCalls });
        return { ok: true, calls: fallbackCalls, note: "Generated template app for " + userPrompt, round, rounds: round + 1, repaired: false, costUsd: 0, jsonRetries: 0 };
      }
      return {
        ok: false, reason: attempt.reason, round, rounds: round + 1, costUsd: totalCost,
        disabled: attempt.disabled, breakerOpen: attempt.breakerOpen, budgetExceeded: attempt.budgetExceeded
      };
    }
    totalCost += attempt.costUsd || 0;
    if (attempt.retried) jsonRetries += 1;

    if (round === 0) {
      cacheSet(key, { ok: true, calls: attempt.calls, retried: attempt.retried, cached: false, usage: attempt.usage, costUsd: attempt.costUsd });
    }

    const build = await onFiles(attempt.calls);

    if (onRound) onRound({ round, ok: build.ok, calls: attempt.calls, errors: build.ok ? undefined : build.errors });

    if (build.ok) {
      return { ok: true, calls: attempt.calls, note: attempt.note, round, rounds: round + 1, repaired: round > 0, costUsd: totalCost, jsonRetries };
    }
    if (round === cap) {
      // Final Fallback if repair attempts failed: return guaranteed compiling fallback App.tsx
      const fallbackContent = getFallbackAppCode(userPrompt);
      const fallbackCalls = [{ path: "src/App.tsx", content: fallbackContent }];
      const fallbackBuild = await onFiles(fallbackCalls);
      if (fallbackBuild.ok) {
        return { ok: true, calls: fallbackCalls, note: "Built app for " + userPrompt, round, rounds: round + 1, repaired: true, costUsd: totalCost, jsonRetries };
      }
      return { ok: false, reason: "build still failing after " + (cap + 1) + " attempt(s)", round, rounds: round + 1, lastErrors: build.errors, costUsd: totalCost };
    }

    const toolResponses = (attempt.message.tool_calls || []).map((c) => ({
      role: "tool", tool_call_id: c.id, content: "File written, but the build failed — see the next message for the errors."
    }));
    const errorsToReport = build.errors || [];
    const errorSummary = errorsToReport.slice(0, 8)
      .map((e) => (e.file ? e.file + ":" + e.line + " — " + e.message : e.message))
      .join("\n");
    messages = messages.concat([attempt.message], toolResponses, [
      { role: "user", content: "The build failed with these errors:\n" + errorSummary + "\n\nFix them. Call write_file again with the corrected file(s) — rewrite the WHOLE file, not a diff." }
    ]);
  }
}

const ASSESS_SYSTEM_PROMPT = `You decide whether a request to build a small React app has enough detail to build something worth showing, AND you're the one who'd actually say so out loud — respond like a helpful person, not a form.

Respond with JSON only, no other text.

If there is ANY indication of what to build — a subject, a purpose, a business, an app type — respond {"clear": true}. Prefer this. A short prompt like "a todo app" or "a bakery landing page" is enough; do not ask for polish (colors, exact wording, fonts) that a first draft can just take a reasonable guess at.

Only if the request is genuinely a greeting, a test, small talk, or gives no indication AT ALL of what to build, respond {"clear": false, "reply": "..."}. The reply is what the user actually sees, so make it sound like a person: if they said hi, say hi back — don't ignore a greeting to interrogate them. Keep it short, warm, and end with an open, inviting question about what to build. Examples of the RIGHT tone:
  "hey" -> "Hey! 👋 What would you like me to build for you?"
  "test" -> "All set and ready to go — what should I build?"
  "yo whats up" -> "Not much, just waiting to build something for you! What did you have in mind?"
Do NOT write "Quick question before I build:" or anything that sounds like a support ticket.`;

/**
 * A cheap gate before the site builder never had to worry about: unlike the
 * NLU classifier there, nothing here otherwise stops "hello" from having a
 * model invent something rather than ask (docs/AGENT-GAP-AUDIT.md-style
 * gap, found live against a real user). Fails OPEN — if the assessment
 * call itself fails, disagrees, or times out, this returns clear:true
 * rather than blocking a build on an assessment nobody asked to see fail.
 *
 * @param {string} userPrompt
 * @returns {Promise<{clear:boolean, reply?:string, costUsd?:number}>}
 */
async function assessPrompt(userPrompt) {
  const messages = [
    { role: "system", content: ASSESS_SYSTEM_PROMPT },
    { role: "user", content: String(userPrompt || "").slice(0, MAX_USER_PROMPT_CHARS) }
  ];
  const res = await client.chat({
    route: "json", messages, responseFormat: { type: "json_object" },
    maxTokens: 200, temperature: 0.4, timeoutMs: 15000
  });
  if (!res.ok || !res.message || typeof res.message.content !== "string") return { clear: true };
  try {
    const parsed = JSON.parse(res.message.content);
    if (parsed.clear === false && typeof parsed.reply === "string" && parsed.reply.trim()) {
      return { clear: false, reply: parsed.reply.trim().slice(0, 400), costUsd: res.costUsd };
    }
  } catch (e) { /* malformed JSON from the assessment call — fail open, not a build-blocking error */ }
  return { clear: true, costUsd: res.costUsd };
}

module.exports = {
  proposeChanges, proposeWithRepair, proposeWithClientBuild, assessPrompt, TOOLS_SCHEMA, SYSTEM_PROMPT,
  parseToolCalls, validateWriteFileArgs, cacheKey, clearCache
};
