"use strict";

const assert = require("assert");
const runStore = require("../lib/codeagent/run-store");
const agentRunner = require("../lib/codeagent/agent-runner");
const client = require("../lib/ai/client");

// In-memory DB
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

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.log("  ✗ " + name + "\n      " + e.message);
  }
}

(async () => {
  console.log("\n── agent-runner unit tests ─────────────────────────");

  const mockDb = createMockDb();
  runStore.init({ getMasterDb: () => mockDb });

  const owner = { userId: "usr_test", anonId: null };

  await check("agentRunner executes multi-turn tool flow and completes", async () => {
    // Mock client responses
    let step = 0;
    const fetchStub = async (url, opts) => {
      step++;
      if (step === 1) {
        // Step 1: Model writes src/App.tsx
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "I will write the initial App component.",
                tool_calls: [{
                  id: "call_1",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "src/App.tsx", content: "export default function App() { return <h1>Barber</h1>; }" })
                  }
                }]
              },
              finish_reason: "tool_calls"
            }]
          })
        };
      } else {
        // Step 2: Model completes task
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "All files written and verified.",
                tool_calls: [{
                  id: "call_2",
                  function: {
                    name: "complete_task",
                    arguments: JSON.stringify({ summary: "Built the Barber shop landing page." })
                  }
                }]
              },
              finish_reason: "tool_calls"
            }]
          })
        };
      }
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: null,
      owner,
      prompt: "Build a Barber shop landing page",
      mode: "auto",
      effort: "smart"
    });

    const outcome = await agentRunner.executeRun(run.id);

    assert.strictEqual(outcome.ok, true);
    assert.ok(outcome.files["src/App.tsx"]);
    assert.strictEqual(outcome.summary, "Built the Barber shop landing page.");

    const finalRun = await runStore.getRun(run.id, owner);
    assert.strictEqual(finalRun.status, "succeeded");
  });

  await check("agentRunner halts when run is cancelled mid-flight", async () => {
    const fetchStub = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_slow",
              function: { name: "write_file", arguments: JSON.stringify({ path: "src/Test.tsx", content: "test" }) }
            }]
          }
        }]
      })
    });

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: null,
      owner,
      prompt: "Large project",
      mode: "auto",
      effort: "smart"
    });

    // Cancel immediately
    await runStore.cancelRun(run.id, owner, "User cancelled");

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.cancelled, true);
  });

  await check("agentRunner answers conversational inquiry without tools when app already exists", async () => {
    const fetchStub = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: "The previous error was a missing import of Button component in src/App.tsx."
          }
        }]
      })
    });

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: "proj_123",
      owner,
      prompt: "what was the error",
      mode: "auto",
      effort: "smart",
      baseFiles: { "src/App.tsx": "export default function App() { return null; }" }
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.summary, "The previous error was a missing import of Button component in src/App.tsx.");
    const finalRun = await runStore.getRun(run.id, owner);
    assert.strictEqual(finalRun.status, "succeeded");
  });

  await check("agentRunner in build mode bypasses question detection and directly writes code", async () => {
    let toolsOffered = null;
    const fetchStub = async (_url, init) => {
      const body = JSON.parse(init.body);
      toolsOffered = body.tools;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "Building the navbar.",
              tool_calls: [{
                id: "call_build",
                function: {
                  name: "complete_task",
                  arguments: JSON.stringify({ summary: "Added navbar." })
                }
              }]
            },
            finish_reason: "tool_calls"
          }]
        })
      };
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: "proj_456",
      owner,
      prompt: "why don't you add a navbar?",
      mode: "build",
      effort: "smart",
      baseFiles: { "src/App.tsx": "export default function App() { return null; }" }
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    // In build mode, dynamic tools schema must be offered to the model
    assert.ok(Array.isArray(toolsOffered) && toolsOffered.length > 0);
    assert.ok(toolsOffered.some(t => t.function && t.function.name === "write_file"));
  });

  await check("agentRunner answers conversational prompt without tools on fresh project", async () => {
    let toolsOffered = null;
    const fetchStub = async (_url, init) => {
      const body = JSON.parse(init.body);
      toolsOffered = body.tools;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "I'm doing well, thanks! What would you like me to build for you today?"
            }
          }]
        })
      };
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: null,
      owner,
      prompt: "how are you",
      mode: "auto",
      effort: "smart",
      baseFiles: {}
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.summary, "I'm doing well, thanks! What would you like me to build for you today?");
    assert.ok(Array.isArray(toolsOffered));
    assert.ok(!toolsOffered.some(t => t.function && (t.function.name === "write_file" || t.function.name === "edit_file")));
  });

  console.log("\n" + (failed === 0 ? "✓ ALL AGENT-RUNNER TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
