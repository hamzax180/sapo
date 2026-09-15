"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const client = require("../lib/ai/client");
const runStore = require("../lib/codeagent/run-store");
const agentRunner = require("../lib/codeagent/agent-runner");
const { effortFor } = require("../lib/codeagent/model-loop");

function createMockDb() {
  const collections = {};
  function getCollection(name) {
    if (!collections[name]) {
      const docs = [];
      collections[name] = {
        async insertOne(doc) { docs.push(Object.assign({}, doc)); return { insertedId: doc.id }; },
        async findOne(query, opts) {
          let matches = docs.filter((d) => {
            for (const [k, v] of Object.entries(query)) {
              if (d[k] !== v) return false;
            }
            return true;
          });
          if (!matches.length) return null;
          if (opts && opts.sort) {
            const [sortKey, sortDir] = Object.entries(opts.sort)[0];
            matches.sort((a, b) => sortDir === -1 ? (b[sortKey] > a[sortKey] ? 1 : -1) : (a[sortKey] > b[sortKey] ? 1 : -1));
          }
          return Object.assign({}, matches[0]);
        },
        async updateOne(query, update) {
          const match = docs.find((d) => {
            for (const [k, v] of Object.entries(query)) {
              if (d[k] !== v) return false;
            }
            return true;
          });
          if (!match) return { modifiedCount: 0 };
          if (update.$set) Object.assign(match, update.$set);
          return { modifiedCount: 1 };
        },
        find(query, opts) {
          let res = docs.filter((d) => {
            for (const [k, v] of Object.entries(query)) {
              if (v && typeof v === "object" && v.$gt !== undefined) {
                if (d[k] <= v.$gt) return false;
              } else if (d[k] !== v) {
                return false;
              }
            }
            return true;
          });
          if (opts && opts.sort) {
            const [sortKey, sortDir] = Object.entries(opts.sort)[0];
            res.sort((a, b) => sortDir === -1 ? (b[sortKey] > a[sortKey] ? 1 : -1) : (a[sortKey] > b[sortKey] ? 1 : -1));
          }
          return {
            async toArray() { return res.map((d) => Object.assign({}, d)); }
          };
        },
        async createIndex() { return true; }
      };
    }
    return collections[name];
  }
  return { collection: getCollection };
}

const TESTS = [
  {
    effort: "fast",
    prompt: "Create a minimalist digital clock with 12h/24h toggle button in src/App.tsx",
    expectedTier: "eco"
  },
  {
    effort: "balanced",
    prompt: "Create a clean markdown note-taking app with preview pane in src/App.tsx",
    expectedTier: "eco"
  },
  {
    effort: "smart",
    prompt: "Create an interactive expense tracker with category filters and summary cards in src/App.tsx",
    expectedTier: "power"
  },
  {
    effort: "max",
    prompt: "Create a Kanban task board with columns, card reordering, and priority tags in src/App.tsx",
    expectedTier: "power"
  }
];

(async () => {
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("🧪 BENCHMARKING EFFORT SYSTEM ACROSS ALL MODES (FAST, BALANCED, SMART, MAX)");
  console.log("══════════════════════════════════════════════════════════════════\n");

  const results = [];

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const effConfig = effortFor(t.effort, "auto");
    console.log(`\n──────────────────────────────────────────────────────────────────`);
    console.log(`[TEST ${i + 1}/${TESTS.length}] EFFORT: ${t.effort.toUpperCase()} (Tier: ${effConfig.tier}, Max Turns: ${t.effort === "fast" ? 5 : t.effort === "balanced" ? 8 : t.effort === "smart" ? 12 : 16})`);
    console.log(`Prompt: "${t.prompt}"`);
    console.log(`──────────────────────────────────────────────────────────────────`);

    const mockDb = createMockDb();
    runStore.init({ getMasterDb: () => mockDb });

    const startTime = Date.now();
    const run = await runStore.createRun({
      projectId: null,
      owner: { userId: "usr_effort_test" },
      prompt: t.prompt,
      mode: "auto",
      effort: t.effort,
      chatId: "chat_effort_" + t.effort + "_" + Date.now()
    });

    let lastSeq = 0;
    let turnCount = 0;
    let checkCount = 0;

    // Simulate browser WebContainer client
    const monitor = setInterval(async () => {
      try {
        const events = await runStore.getEvents(run.id, lastSeq);
        for (const ev of events) {
          lastSeq = ev.seq;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          if (ev.type === "stage" && ev.payload.state === "start") {
            if (ev.payload.id && ev.payload.id.startsWith("turn-")) turnCount++;
            console.log(`  [+${elapsed}s] ${ev.payload.detail}`);
          } else if (ev.type === "file_written") {
            console.log(`  [+${elapsed}s] 📝 Wrote ${ev.payload.path} (${ev.payload.bytes} bytes)`);
          } else if (ev.type === "check_needed") {
            checkCount++;
            console.log(`  [+${elapsed}s] 🔍 WebContainer check #${checkCount}`);
            setTimeout(() => {
              agentRunner.reportCheckResult(run.id, { ok: true, errors: [], raw: "Build succeeded" });
            }, 300);
          }
        }
      } catch (e) {}
    }, 250);

    let outcome = null;
    try {
      outcome = await agentRunner.executeRun(run.id);
    } catch (err) {
      outcome = { ok: false, reason: err.message };
    }
    clearInterval(monitor);

    const durSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const hasAppTsx = !!(outcome.files && outcome.files["src/App.tsx"]);
    const appTsxLines = hasAppTsx ? outcome.files["src/App.tsx"].split("\n").length : 0;

    console.log(`\n  ✓ Result: ${outcome.ok ? "SUCCEEDED" : "FAILED"}`);
    console.log(`  ⏱️ Duration: ${durSec}s | Turns: ${turnCount} | Cost: $${(outcome.costUsd || 0).toFixed(5)}`);
    console.log(`  📂 Files: ${Object.keys(outcome.files || {}).join(", ")}`);
    console.log(`  📄 src/App.tsx: ${hasAppTsx ? appTsxLines + " lines" : "MISSING"}`);

    results.push({
      effort: t.effort,
      tier: effConfig.tier,
      durationSec: durSec,
      turns: turnCount,
      costUsd: outcome.costUsd || 0,
      ok: outcome.ok,
      hasAppTsx,
      fileCount: Object.keys(outcome.files || {}).length
    });
  }

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("📊 ALL EFFORT MODES COMPARISON SUMMARY TABLE");
  console.log("══════════════════════════════════════════════════════════════════");
  console.table(results);
})();
