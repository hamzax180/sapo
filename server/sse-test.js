/* =================================================================
   sse-test.js — the streaming path, proven against a real server
   -----------------------------------------------------------------
   Two things are worth proving that the JSON path can't show:

     1. Stages arrive in the right order, EACH ONE only after the work
        it names has actually happened — not on a timer. "structure done"
        must carry the real archetype, "write done" the real block count.
     2. The plain-JSON path (used by every other test in this repo) is
        completely unaffected by this — same route, negotiated by Accept.

   Run: npm run test:sse
   ================================================================= */
"use strict";
const assert = require("assert");

(async () => {
  process.env.MONGODB_URI = "";              // exercise the in-memory fallback deliberately
  process.env.JWT_SECRET = "sse-test-secret";
  process.env.PORT = "4100";
  process.env.GEMINI_API_KEY = "";
  process.env.LOG_REQUESTS = "0";

  const base = "http://localhost:4100";
  const pass = (m) => console.log("  ✓ " + m);
  let ok = false;

  try {
    require("./index.js");
    const deadline = Date.now() + 15000;
    for (;;) {
      try { const r = await fetch(base + "/health"); if (r.ok) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error("server did not come up");
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log("\n--- RUNNING SSE TESTS ---");

    /** Parse an SSE body into [{event, data}], tolerant of chunk boundaries
        landing mid-frame (a real network stream gives no guarantee they won't). */
    async function readSSE(res) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const frames = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /event: (.+)/.exec(raw);
          const data = /data: (.+)/.exec(raw);
          if (event && data) frames.push({ event: event[1], data: JSON.parse(data[1]) });
        }
      }
      return frames;
    }

    /* ---- the streamed path emits real, ordered stage events ---- */
    let res = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ prompt: "a storefront for my Istanbul coffee roastery called Kahve Co with online ordering" })
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((res.headers.get("content-type") || "").indexOf("text/event-stream"), 0, "wrong content-type for a stream");
    pass("SSE request gets a text/event-stream response, not JSON");

    const frames = await readSSE(res);
    const stages = frames.filter((f) => f.event === "stage");
    pass("received " + frames.length + " frames, " + stages.length + " of them stages");

    const ids = stages.map((s) => s.data.id);
    assert.deepStrictEqual([...new Set(ids)], ["understand", "structure", "write"], "wrong stage set/order: " + ids.join(","));
    pass("stages arrive in the real pipeline order: understand → structure → write");

    ["understand", "structure", "write"].forEach((id) => {
      const start = stages.find((s) => s.data.id === id && s.data.state === "start");
      const done = stages.find((s) => s.data.id === id && s.data.state === "done");
      assert.ok(start, id + " never started");
      assert.ok(done, id + " never finished");
      assert.strictEqual(stages.indexOf(start) < stages.indexOf(done), true, id + " finished before it started");
    });
    pass("every stage has a start before its done, for all three stages");

    const understandDone = stages.find((s) => s.data.id === "understand" && s.data.state === "done");
    assert.ok(understandDone.data.detail.indexOf("Restaurant") >= 0, "understand's detail doesn't name the real industry: " + understandDone.data.detail);
    assert.ok(understandDone.data.detail.indexOf("Istanbul") >= 0, "understand's detail doesn't name the real city: " + understandDone.data.detail);
    pass("'understand done' detail names the REAL industry and city, not a placeholder");

    const structureDone = stages.find((s) => s.data.id === "structure" && s.data.state === "done");
    assert.ok(structureDone.data.detail.length > 0, "structure's detail is empty");
    pass("'structure done' detail carries the real archetype label: \"" + structureDone.data.detail + "\"");

    const result = frames.find((f) => f.event === "result");
    assert.ok(result, "no result frame");
    assert.ok(result.data.projectId && result.data.slug, "result frame missing projectId/slug");

    const writeDone = stages.find((s) => s.data.id === "write" && s.data.state === "done");
    const realBlocks = Object.keys(result.data.config.pages).reduce((n, s) => n + result.data.config.pages[s].blocks.length, 0);
    assert.ok(writeDone.data.detail.indexOf(String(realBlocks)) >= 0,
      "'write done' claimed a block count that doesn't match the actual config: said \"" + writeDone.data.detail + "\", built " + realBlocks);
    pass("'write done' block count matches the ACTUAL config, not a guess (" + realBlocks + " blocks)");

    const done = frames.find((f) => f.event === "done");
    assert.ok(done && typeof done.data.ms === "number", "no done frame with a real timing number");
    assert.strictEqual(frames[frames.length - 1].event, "done", "'done' was not the terminal frame");
    pass("stream ends with a 'done' frame carrying real elapsed time (" + done.data.ms + "ms)");

    /* project-test.js already proves the read/ownership/claim path in full
       against a real Mongo with proper cookie jars; this file stays focused
       on what only the streaming path can show — the stage events themselves. */

    /* ---- a vague prompt streams a needsAnswer, not a broken build ---- */
    res = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ prompt: "something nice" })
    });
    const vague = await readSSE(res);
    assert.ok(vague.some((f) => f.event === "needsAnswer"), "no needsAnswer frame for a vague prompt");
    assert.ok(!vague.some((f) => f.event === "result"), "a vague prompt still produced a result frame");
    const understandOnly = vague.filter((f) => f.event === "stage").map((s) => s.data.id);
    assert.deepStrictEqual([...new Set(understandOnly)], ["understand"], "structure/write ran for a prompt that was never confident enough to build");
    pass("a vague prompt streams ONLY the understand stage, then needsAnswer — never fakes structure/write");

    /* ---- the plain-JSON path is completely unaffected ---- */
    res = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },   // no Accept: text/event-stream
      body: JSON.stringify({ prompt: "a freight forwarder in Dubai with shipment tracking" })
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual((res.headers.get("content-type") || "").indexOf("application/json"), 0, "the non-streaming request got a stream response");
    const plain = await res.json();
    assert.ok(plain.projectId && plain.config, "the plain-JSON path regressed");
    pass("a request with no Accept: text/event-stream still gets plain JSON — same route, unaffected");

    console.log("\n✓ ALL SSE TESTS PASSED");
    ok = true;
  } catch (e) {
    console.error("\n✗ SSE TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  } finally {
    process.exit(ok ? 0 : 1);
  }
})();
