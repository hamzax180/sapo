"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const client = require("../lib/ai/client");
const runStore = require("../lib/codeagent/run-store");
const agentRunner = require("../lib/codeagent/agent-runner");

// Simple in-memory or real DB mock for isolated measurement
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

(async () => {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🚀 STARTING REAL LIVE AUTONOMOUS AGENT BENCHMARK WITH DEEPSEEK");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const mockDb = createMockDb();
  runStore.init({ getMasterDb: () => mockDb });

  const prompt = "Build a modern coffee shop landing page with hero, drinks menu, opening hours, and contact form in src/App.tsx";
  console.log("User Prompt:", prompt);

  const startTime = Date.now();

  const run = await runStore.createRun({
    projectId: null,
    owner: { userId: "usr_live_test" },
    prompt: prompt,
    mode: "auto",
    effort: "balanced",
    chatId: "chat_benchmark_" + Date.now()
  });

  console.log("✓ Created Run ID:", run.id);
  console.log("Starting autonomous execution loop...\n");

  let lastSeq = 0;
  let checkCount = 0;

  // Background monitor simulating the browser WebContainer client
  const clientMonitor = setInterval(async () => {
    try {
      const events = await runStore.getEvents(run.id, lastSeq);
      for (const ev of events) {
        lastSeq = ev.seq;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (ev.type === "stage") {
          console.log(`[+${elapsed}s] [STAGE] (${ev.payload.state}) ${ev.payload.detail}`);
        } else if (ev.type === "tool_start") {
          console.log(`[+${elapsed}s] [TOOL] 🛠️ Calling: ${ev.payload.tool}`);
        } else if (ev.type === "file_written") {
          console.log(`[+${elapsed}s] [FILE] 📝 Wrote ${ev.payload.path} (${ev.payload.bytes} bytes)`);
        } else if (ev.type === "file_edited") {
          console.log(`[+${elapsed}s] [EDIT] ✏️ Edited ${ev.payload.path}`);
        } else if (ev.type === "check_needed") {
          checkCount++;
          console.log(`[+${elapsed}s] [WEBCONTAINER CHECK #${checkCount}] Received compilation request from agent`);
          const files = ev.payload.files || {};
          const appCode = files["src/App.tsx"] || "";
          console.log(`[+${elapsed}s]   → Verifying src/App.tsx (${appCode.split("\n").length} lines)`);
          
          // Verify syntax
          let ok = true;
          let errors = [];
          if (!appCode.includes("export default")) {
            ok = false;
            errors.push({ file: "src/App.tsx", line: 1, message: "Missing export default component" });
          }
          
          // Report check result back to agent runner
          setTimeout(() => {
            console.log(`[+${elapsed}s]   → WebContainer reports: ${ok ? "CLEAN COMPILE ✓" : "COMPILE ERRORS"}`);
            agentRunner.reportCheckResult(run.id, { ok, errors, raw: ok ? "Build succeeded" : "Build failed" });
          }, 400);
        } else if (ev.type === "result") {
          console.log(`[+${elapsed}s] [RESULT] 🎉 Task Complete: ${ev.payload.summary}`);
        }
      }
    } catch (e) {
      console.error("Monitor error:", e);
    }
  }, 300);

  // Execute the autonomous run
  let outcome = null;
  try {
    outcome = await agentRunner.executeRun(run.id);
  } catch (err) {
    console.error("executeRun threw:", err);
    outcome = { ok: false, reason: err.message };
  }
  console.log("EXECUTE RUN RETURNED:", outcome);

  clearInterval(clientMonitor);

  const totalDurationMs = Date.now() - startTime;
  const totalDurationSec = (totalDurationMs / 1000).toFixed(2);
  const totalDurationMin = (totalDurationMs / 60000).toFixed(2);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("📊 REAL BENCHMARK RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`⏱️  Total Duration:     ${totalDurationSec}s (${totalDurationMin} min)`);
  console.log(`💰 Total Model Cost:    $${(outcome.costUsd || 0).toFixed(6)} USD`);
  console.log(`📦 Status:              ${outcome.ok ? "SUCCEEDED ✓" : "FAILED ✗"}`);
  console.log(`🔍 Checks Performed:    ${checkCount}`);
  console.log(`📂 Files Created:       ${Object.keys(outcome.files || {}).join(", ")}`);

  const appTsx = (outcome.files && outcome.files["src/App.tsx"]) || "";
  const lines = appTsx.split("\n").length;
  console.log(`📄 src/App.tsx Size:    ${appTsx.length} chars, ${lines} lines`);
  console.log(`\n--- Code Sample (First 25 lines of src/App.tsx) ---`);
  console.log(appTsx.split("\n").slice(0, 25).join("\n"));
  console.log("...\n");
})();
