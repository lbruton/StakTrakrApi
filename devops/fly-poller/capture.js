#!/usr/bin/env node
/**
 * StakTrakr Retail Price Capture
 * ================================
 * Visits dealer product pages via Browserbase (cloud), self-hosted Browserless,
 * or local Chromium, takes a screenshot of each, and writes a manifest for
 * downstream extraction (Gemini vision, etc.).
 *
 * Parallel mode (Browserbase): one session per coin, all running
 * concurrently. ~67 pages (7 providers × 11 coins) completes in ~2 min
 * instead of ~8 minutes sequential.
 *
 * Usage:
 *   node capture.js                          # Browserbase cloud (parallel)
 *   BROWSER_MODE=local node capture.js       # Local Chromium (sequential)
 *   BROWSER_MODE=browserless node capture.js # Self-hosted Browserless (sequential)
 */

import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { config } from "dotenv";
import { loadProviders } from "./provider-db.js";

config(); // load .env

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BROWSER_MODE = process.env.BROWSER_MODE || "browserbase";
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const BROWSERLESS_WS = process.env.BROWSERLESS_URL ||
  "ws://localhost:3000/chromium/playwright?token=local_dev_token";
const DATA_DIR = resolve(process.env.DATA_DIR || "../../data");
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ||
  join(tmpdir(), "retail-poller-screenshots", new Date().toISOString().slice(0, 10));

const COINS = (process.env.COINS || "ase,age,ape,buffalo,maple-silver,maple-gold,britannia-silver,krugerrand-silver,krugerrand-gold,generic-silver-round,generic-silver-bar-10oz").split(",").map(s => s.trim());
const PROVIDERS = (process.env.PROVIDERS || "apmex,sdbullion,jmbullion,monumentmetals,herobullion,bullionexchanges,summitmetals").split(",").map(s => s.trim());

// Per-page delays (ms) — polite pacing within each session
const PAGE_LOAD_WAIT = 4000;    // wait after domcontentloaded for JS rendering
const INTER_PAGE_DELAY = 1000;  // pause between pages within a session

// Per-provider wait overrides (ms) — for JS-heavy SPAs that need more render time.
// JMBullion: Next.js app, pricing table takes ~8s to populate after domcontentloaded.
// monumentmetals: React Native Web SPA, router doesn't mount until ~6s.
// bullionexchanges: React/Magento SPA, pricing grid renders at ~6-8s.
const PROVIDER_PAGE_LOAD_WAIT = {
  jmbullion:       10000,
  monumentmetals:   7000,
  bullionexchanges: 8000,
  herobullion:      6000,
};

// Per-dealer popup dismissal config.
// Each entry is an array of dismissal attempts tried in order.
//
// Fields per entry:
//   selector  — CSS selector for the close/dismiss element
//   action    — "click" (default) or "evaluate" (run JS)
//   js        — JavaScript string to evaluate (only when action="evaluate")
//   wait      — ms to wait after action (default 500)
//   desc      — human-readable description for logging
const POPUP_CONFIG = {
  summitmetals: [
    {
      selector: 'div[class*="popup"] button[class*="close"], div[class*="modal"] button[class*="close"]',
      desc: "loyalty benefit popup close button",
      wait: 800,
    },
    {
      selector: 'button[class*="dismiss"], button[class*="no-thanks"], a[class*="close-popup"]',
      desc: "loyalty popup dismiss link",
      wait: 800,
    },
    {
      // Fallback: click the overlay backdrop to dismiss
      action: "evaluate",
      js: `document.querySelector('div[class*="overlay"], div[class*="backdrop"]')?.click()`,
      desc: "click overlay backdrop",
      wait: 500,
    },
  ],

  monumentmetals: [
    {
      selector: 'button.close, button[class*="close-modal"], [data-dismiss="modal"]',
      desc: "site modal close button",
      wait: 600,
    },
    {
      action: "evaluate",
      js: `document.querySelector('.modal-backdrop, div[class*="overlay"]')?.click()`,
      desc: "click modal backdrop",
      wait: 500,
    },
  ],

  herobullion: [
    {
      // Click body to collapse any open dropdown menus
      action: "evaluate",
      js: `document.body.click()`,
      desc: "click body to close dropdowns",
      wait: 400,
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function loadProvidersData() {
  let tursoClient = null;
  try { tursoClient = (await import("./turso-client.js")).createTursoClient(); } catch {}
  return loadProviders(tursoClient, DATA_DIR);
}

/**
 * Build target list grouped by coin.
 * Each coin gets its own session (4 providers × ~8s = ~35s, well under 5-min limit).
 * 11 coins fits under the 25-concurrent-browser account limit.
 *
 * Returns: Map<coinSlug, Array<{coin, metal, provider, url}>>
 */
function buildTargetsByCoin(providersJson) {
  const byCoin = new Map();
  for (const coinSlug of COINS) {
    const coin = providersJson.coins[coinSlug];
    if (!coin) {
      log(`WARN: coin "${coinSlug}" not found in providers.json, skipping`);
      continue;
    }
    const targets = [];
    for (const provider of coin.providers) {
      if (!PROVIDERS.includes(provider.id)) continue;
      if (!provider.enabled || !provider.url) continue;
      targets.push({
        coin: coinSlug,
        metal: coin.metal,
        provider: provider.id,
        url: provider.url,
      });
    }
    if (targets.length > 0) byCoin.set(coinSlug, targets);
  }
  return byCoin;
}

// ---------------------------------------------------------------------------
// Browserbase session management
// ---------------------------------------------------------------------------

async function createBrowserbaseSession() {
  const response = await fetch("https://www.browserbase.com/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bb-api-key": BROWSERBASE_API_KEY,
    },
    body: JSON.stringify({ projectId: BROWSERBASE_PROJECT_ID }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Browserbase session creation failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const session = await response.json();
  return session.id;
}

async function connectBrowserbaseSession(sessionId) {
  const wsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0] || await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  return { browser, page };
}

async function connectBrowserlessSession() {
  const { chromium: coreChromium } = await import("playwright-core");
  // Browserless v2 uses Playwright wire protocol, not CDP
  // Use .connect() instead of .connectOverCDP()
  const browser = await coreChromium.connect(BROWSERLESS_WS);
  try {
    // Create a new context with explicit viewport and userAgent
    // Browserless allows full context control via Playwright wire protocol
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    return { browser, context };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Popup dismissal
// ---------------------------------------------------------------------------

/**
 * Dismiss popups/overlays before screenshot.
 * Tries dealer-specific selectors first, then generic fallbacks.
 * All actions are non-fatal — errors are logged but never thrown.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} providerId - dealer identifier (e.g. "summitmetals")
 */
async function dismissPopups(page, providerId) {
  const GENERIC_SELECTORS = [
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    '.modal-close', '.popup-close', '.close-button',
    '[data-dismiss="modal"]', '[data-testid="close"]',
    'button.close', '.klaviyo-close-form',
  ];

  try {
    // Step 1: Universal Escape key press
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Step 2: Dealer-specific selectors
    const dealerConfig = POPUP_CONFIG[providerId];
    if (dealerConfig) {
      for (const entry of dealerConfig) {
        try {
          const action = entry.action || "click";
          const wait = entry.wait || 500;

          if (action === "evaluate" && entry.js) {
            await page.evaluate(entry.js);
            log(`[${providerId}] popup: dismissed "${entry.desc}"`);
            await page.waitForTimeout(wait);
          } else if (entry.selector) {
            const btn = await page.$(entry.selector);
            if (btn) {
              await btn.click({ timeout: 3000 });
              log(`[${providerId}] popup: dismissed "${entry.desc}"`);
              await page.waitForTimeout(wait);
            }
          }
        } catch (e) {
          log(`[${providerId}] popup: "${entry.desc}" failed — ${e.message.slice(0, 60)}`);
        }
      }
    }

    // Step 3: Generic fallback selectors
    for (const sel of GENERIC_SELECTORS) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click({ timeout: 3000 });
          log(`[${providerId}] popup: dismissed generic "${sel}"`);
          await page.waitForTimeout(300);
          break;
        }
      } catch { /* non-fatal */ }
    }
  } catch (e) {
    log(`[${providerId}] popup: dismissal error — ${e.message.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// Capture one coin's targets using a dedicated browser session
// ---------------------------------------------------------------------------

async function captureCoin(coinSlug, targets, outDir) {
  const results = [];

  let browser, page;
  if (BROWSER_MODE === "local") {
    const { chromium: localChromium } = await import("playwright");
    browser = await localChromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = await ctx.newPage();
  } else if (BROWSER_MODE === "browserless") {
    log(`[${coinSlug}] Connecting to Browserless at ${BROWSERLESS_WS}...`);
    const { browser: blBrowser, context: blContext } = await connectBrowserlessSession();
    browser = blBrowser;
    page = await blContext.newPage();
  } else {
    log(`[${coinSlug}] Creating Browserbase session...`);
    const sessionId = await createBrowserbaseSession();
    log(`[${coinSlug}] Session: ${sessionId}`);
    ({ browser, page } = await connectBrowserbaseSession(sessionId));
  }

  for (const target of targets) {
    const filename = `${target.coin}_${target.provider}.png`;
    const filepath = join(outDir, filename);

    log(`[${coinSlug}/${target.provider}] → ${target.url}`);

    try {
      const response = await page.goto(target.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      const status = response ? response.status() : 0;

      const providerWait = PROVIDER_PAGE_LOAD_WAIT[target.provider] ?? PAGE_LOAD_WAIT;
      await page.waitForTimeout(providerWait);

      // Dismiss modals/popups before screenshot so they don't obscure prices
      await dismissPopups(page, target.provider);

      await page.screenshot({ path: filepath, fullPage: false });
      const title = await page.title();

      results.push({
        coin: target.coin,
        provider: target.provider,
        metal: target.metal,
        url: target.url,
        status,
        title,
        screenshot: filename,
        ok: status === 200 && !title.toLowerCase().includes("not found"),
      });

      log(`[${coinSlug}/${target.provider}]   ✓ ${status} "${title.slice(0, 50)}" → ${filename}`);
    } catch (err) {
      results.push({
        coin: target.coin,
        provider: target.provider,
        metal: target.metal,
        url: target.url,
        status: 0,
        title: "",
        screenshot: null,
        ok: false,
        error: err.message.slice(0, 200),
      });
      log(`[${coinSlug}/${target.provider}]   ✗ ${err.message.slice(0, 80)}`);
    }

    if (targets.indexOf(target) < targets.length - 1) {
      await page.waitForTimeout(INTER_PAGE_DELAY);
    }
  }

  await browser.close();
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function captureAll() {
  if (BROWSER_MODE !== "local" && BROWSER_MODE !== "browserless" &&
      (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID)) {
    console.error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID required for cloud mode.");
    process.exit(1);
  }

  const providersJson = await loadProvidersData();
  const byCoin = buildTargetsByCoin(providersJson);

  if (byCoin.size === 0) {
    console.error("No targets to capture. Check COINS/PROVIDERS env vars.");
    process.exit(1);
  }

  const totalTargets = [...byCoin.values()].reduce((n, arr) => n + arr.length, 0);
  log(`Capturing ${totalTargets} pages — ${byCoin.size} parallel sessions (one per coin)`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });

  // Launch one session per coin, all in parallel — each session only ~35s,
  // well within Browserbase's 5-min session limit. 11 sessions < 25 account limit.
  const coinJobs = [...byCoin.entries()].map(([coinSlug, targets]) =>
    captureCoin(coinSlug, targets, ARTIFACT_DIR)
  );

  const allResults = (await Promise.all(coinJobs)).flat();

  // Write manifest
  const manifest = {
    captured_at: new Date().toISOString(),
    date: today(),
    coins: COINS,
    providers: PROVIDERS,
    results: allResults,
  };

  const manifestPath = join(ARTIFACT_DIR, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`Manifest written: ${manifestPath}`);

  const ok = allResults.filter(r => r.ok).length;
  const fail = allResults.filter(r => !r.ok).length;
  log(`Done: ${ok}/${totalTargets} captured, ${fail} failed`);

  return manifest;
}

captureAll().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
