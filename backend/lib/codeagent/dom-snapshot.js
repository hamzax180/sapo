/* =================================================================
   codeagent/dom-snapshot.js — the screenshot substitute
   -----------------------------------------------------------------
   DeepSeek V3 is text-only (docs/CODE-AGENT-PLAN.md §4) — Replit's
   agent looks at a screenshot; this loop cannot. dom_snapshot proves
   a route rendered real content by executing it in a real browser and
   reading back the text, without needing vision.

   Puppeteer is required lazily so a runtime without a launchable
   Chrome (sandboxed shells, some CI images, missing system deps)
   degrades to `{ok:false, degraded:true}` instead of crashing the
   whole tool surface — every failure here should be something the
   caller can act on, per the §6 failure table.
   ================================================================= */
"use strict";

let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { /* not installed — degrade below */ }

async function domSnapshot(url, timeoutMs) {
  if (!puppeteer) {
    return { ok: false, degraded: true, reason: "puppeteer is not installed", text: "" };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e && e.message || e)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

    await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs || 15000 });
    // This closure runs INSIDE the browser page via Puppeteer, not in this
    // Node process — `document` is real there.
    // eslint-disable-next-line no-undef
    const text = await page.evaluate(() => document.body.innerText || "");

    return { ok: true, degraded: false, text: text.trim(), consoleErrors, empty: text.trim().length === 0 };
  } catch (e) {
    return { ok: false, degraded: true, reason: e.message, text: "" };
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* already gone */ } }
  }
}

module.exports = { domSnapshot };
