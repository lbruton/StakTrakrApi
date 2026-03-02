# Retail Scraping Pipeline — Architecture Reference

**Date:** 2026-03-02
**Status:** Active — documents the pipeline as deployed

---

## Overview

The StakTrakr retail pipeline scrapes precious metals prices from 7 online dealers
across 88 active targets (66 precious metals + 22 goldback retail). It runs inside a
single Fly.io container (`staktrakr`) managed by supervisord, producing three
independent data feeds: market prices, spot prices, and goldback rates.

All scraper code lives in `devops/fly-poller/`. The home VM (`stakscrapr`) runs
identical code but writes to Turso only — it never pushes to git or produces API files.

---

## Container Architecture

```
Fly.io container (staktrakr)
├── fly.toml: shared-cpu-8x / 4GB RAM
├── supervisord.conf: 11 managed processes
│
├── Infrastructure Services
│   ├── tailscaled           — VPN daemon (Tailscale mesh)
│   ├── tailscale-up         — one-shot auth on boot
│   ├── redis-server         — Firecrawl queue + rate limiting (port 6379)
│   ├── rabbitmq-server      — Firecrawl job queue (port 5672)
│   └── postgres 17          — Firecrawl internal DB (port 5432)
│
├── Firecrawl Stack
│   ├── playwright-service   — headless Chromium for Firecrawl (port 3003)
│   ├── firecrawl-api        — scraping endpoint (port 3002)
│   ├── firecrawl-worker     — job processor
│   └── firecrawl-extract-worker — extraction processor
│
├── Application
│   ├── cron                 — 5 cron jobs (retail, spot, publish, retry, goldback)
│   └── http-server          — serve.js public API (port 8080)
│
└── Persistent Volume (/data)
    └── staktrakr-api-export/  — git clone of StakTrakrApi (api branch)
```

---

## Network Egress & Proxy Architecture

This is the most important architectural detail. Three different egress paths exist,
and Chromium's behavior differs from Node.js `fetch()`.

### The Problem

Dealer websites block datacenter IPs (~90% of targets return 403 from Fly.io's IP).
A residential IP is required for successful scraping.

### Tailscale Exit Node

`run-local.sh` dynamically sets a Tailscale exit node before each scrape cycle:

```bash
tailscale set --exit-node=100.112.198.50   # home VM Tailscale IP
```

This routes **all outgoing TCP** from the container through the home residential IP
(Cox: 98.184.142.225). Node.js `fetch()` calls respect this routing.

**Critical limitation:** Chromium does NOT respect Tailscale exit node routing.
Chromium spawns its own network stack and exits via the Fly.io datacenter IP regardless
of the exit node setting. This was discovered on 2026-02-24 after persistent 403 errors
from Playwright-based scraping despite the exit node being active.

### TinyProxy (Explicit HTTP Proxy)

To solve the Chromium problem, a tinyproxy instance runs on the home VM
(`http://100.112.198.50:8888`) accessible via Tailscale. This proxy exits via the Cox
residential IP and is the **only reliable way** to route Chromium traffic through a
residential IP.

TinyProxy is configured as a Fly.io secret:

```bash
fly secrets set HOME_PROXY_URL=http://100.112.198.50:8888
```

### Three Consumers of HOME_PROXY_URL

| Consumer | Config Location | How It's Set |
|----------|----------------|--------------|
| Firecrawl playwright-service | `supervisord.conf` `PROXY_SERVER` env var | `%(ENV_HOME_PROXY_URL)s` |
| price-extract.js Phase 2 | `process.env.HOME_PROXY_URL` | Playwright `launch({ proxy: { server } })` |
| capture.js vision screenshots | `process.env.HOME_PROXY_URL` | Playwright `launch({ proxy: { server } })` |

All three MUST use the explicit proxy. The Tailscale exit node handles Node.js
`fetch()` (used by Firecrawl's HTTP client), but any Chromium instance needs the proxy.

### Egress Summary

| Traffic Type | Egress Path | IP Seen by Dealer |
|-------------|-------------|-------------------|
| Node.js `fetch()` (Firecrawl API calls) | Tailscale exit node → home VM → Cox | 98.184.142.225 (residential) |
| Chromium (Firecrawl playwright-service) | `PROXY_SERVER` → tinyproxy → Cox | 98.184.142.225 (residential) |
| Chromium (price-extract.js Phase 2) | `HOME_PROXY_URL` → tinyproxy → Cox | 98.184.142.225 (residential) |
| Chromium (capture.js vision) | `HOME_PROXY_URL` → tinyproxy → Cox | 98.184.142.225 (residential) |
| When home VM is offline | Fly.io datacenter IP | Blocked by ~90% of dealers |

---

## Cron Schedule

Configured dynamically in `docker-entrypoint.sh` via `CRON_SCHEDULE` env var
(default: `15,45`).

| Minute | Script | Purpose | Duration |
|--------|--------|---------|----------|
| `CRON_SCHEDULE` (default :15,:45) | `run-local.sh` | Full retail pipeline (scrape + vision) | ~25-45 min |
| `:00, :30` | `run-spot.sh` | Spot metal prices via MetalPriceAPI | ~5s |
| `:08, :23, :38, :53` | `run-publish.sh` | Export Turso → JSON files, git push to `api` branch | ~30s |
| `:15` | `run-retry.sh` | **Dead code** — reads file never written | N/A |
| `:01` (hourly) | `run-goldback.sh` | Goldback G1 spot rate (skips if today's already captured) | ~10s |

---

## Retail Pipeline Detail (`run-local.sh`)

The retail pipeline runs 4 steps sequentially. Steps 1-3 run inside `run-local.sh`;
step 4 (publish) runs on a separate cron.

### Step 0: Tailscale Exit Node Setup

```
if tailscale ping exit-node succeeds:
  tailscale set --exit-node=100.112.198.50   → route via residential IP
else:
  tailscale set --exit-node=                 → fall back to datacenter IP
```

### Step 1: Price Extraction (`price-extract.js`)

**Input:** Provider config from Turso (`provider_coins` + `provider_vendors` tables)
**Output:** Price snapshots written to Turso (`price_snapshots` table)

88 targets scraped sequentially with 2-8s random jitter between requests.
Targets are Fisher-Yates shuffled so the same vendor is never hit consecutively.

#### Phase 1: Firecrawl (all targets)

```
For each target (shuffled):
  1. POST to self-hosted Firecrawl (localhost:3002)
     - Firecrawl fetches page HTML via its internal HTTP client (Node.js fetch → exit node)
     - For JS-heavy SPAs: Firecrawl uses playwright-service (port 3003, PROXY_SERVER set)
     - Returns markdown text of page content
  2. Parse markdown → extract price, detect stock status
  3. On success → write to Turso, move to next target
  4. On failure:
     - HTTP 403 → skip retries (bot detection, same IP won't help)
     - Other errors → retry up to 2x with exponential backoff
     - All retries exhausted → fall through to Phase 2
```

**Firecrawl internals:** Self-hosted Firecrawl (port 3002) uses Redis for rate limiting,
RabbitMQ for job queuing, and PostgreSQL for internal state. Its playwright-service
(port 3003) provides headless Chromium with stealth patches that bypass more bot
detection than raw `chromium.launch()`.

#### Phase 2: Playwright Fallback (failed targets only)

```
For each target where Phase 1 failed AND (BROWSERLESS_URL or PLAYWRIGHT_LAUNCH):
  1. Launch local Chromium with proxy-first strategy:
     a. Try with HOME_PROXY_URL (residential IP via tinyproxy)
     b. If geo-blocked or proxy fails → retry direct (no proxy, datacenter IP)
  2. Navigate to URL, wait for page load (extra 8s for SLOW_PROVIDERS)
  3. Extract page innerText
  4. Parse text → extract price, detect stock status
  5. Write to Turso with source="playwright"
```

**Proxy-first rationale:** Datacenter IPs are blocked by ~90% of dealers. Direct (no
proxy) is a last resort, not a first attempt. The `useProxy` parameter defaults to
proxy-first. Set `false` to force direct.

**SLOW_PROVIDERS** requiring extra wait: jmbullion, herobullion, monumentmetals,
summitmetals, bullionexchanges. All are React/Next.js SPAs needing 5-8s to render
price tables.

### Step 2: Vision Capture (`capture.js`)

**Input:** Provider config from Turso
**Output:** PNG screenshots + manifest.json in `/tmp/retail-screenshots/YYYY-MM-DD/`

Runs on **all targets** (not just failures). Vision provides independent price
verification regardless of whether Firecrawl or Playwright succeeded.

```
Mode: BROWSER_MODE=local (sequential, single browser instance)

1. Launch single Chromium with HOME_PROXY_URL proxy
2. For each coin:
   For each provider target:
     a. Navigate to dealer URL
     b. Wait PAGE_LOAD_WAIT (3s default, vendor-specific overrides)
     c. Screenshot full page → save as PNG
     d. Wait INTER_PAGE_DELAY (500ms) between pages
3. Write manifest.json listing all captured screenshots
4. Close browser
```

**Memory constraint:** Single browser instance is mandatory. Each Chromium process
uses ~200MB; parallel launches on a 4GB container cause OOM. Cloud mode (Browserbase)
uses parallel sessions but is not used on Fly.io.

**Vendor-specific page load waits:**

| Vendor | Wait (ms) | Reason |
|--------|-----------|--------|
| jmbullion | 7000 | Next.js SPA, pricing table loads late |
| bullionexchanges | 6000 | React/Magento SPA |
| monumentmetals | 5000 | Full SPA, router mount delay |
| herobullion | 4000 | React, moderate delay |
| All others | 3000 | Default |

### Step 3: Vision Extraction (`extract-vision.js`)

**Input:** Screenshot manifest from Step 2, Firecrawl prices from Turso
**Output:** Per-coin vision JSON files at `data/retail/{slug}/{YYYY-MM-DD}-vision.json`

```
1. Load manifest.json → list of screenshots
2. For each screenshot (CONCURRENCY=4 parallel):
   a. Load Firecrawl price from Turso for this coin/vendor
   b. Send screenshot to Gemini 2.5 Flash with:
      - Vendor-specific extraction hints (VENDOR_PRICE_HINTS)
      - Metal-specific price range bounds (PRICE_RANGE_HINTS)
      - The Firecrawl-extracted price for cross-reference
   c. Gemini returns: extracted price, agrees_with_firecrawl flag, confidence
3. Write per-coin vision JSON with all vendor results
```

**Three-source confidence model:**

| Source | Method | Purpose |
|--------|--------|---------|
| Firecrawl (Phase 1) | HTTP markdown extraction | Primary price source |
| Playwright (Phase 2) | Browser DOM extraction | Fallback for Firecrawl failures |
| Gemini Vision (Step 3) | Screenshot OCR | Independent cross-reference |

When Firecrawl and Vision agree on a price, confidence is high. Disagreement flags
the price for review.

### Step 4: Publish (`run-publish.sh`, separate cron)

**Input:** Turso database + vision JSON files
**Output:** Static JSON files pushed to `api` branch

```
1. api-export.js:
   - Reads all price snapshots from Turso
   - Merges with vision JSON confidence data
   - Writes to data/api/:
     manifest.json, latest.json, {slug}/latest.json,
     {slug}/history-7d.json, {slug}/history-30d.json

2. export-providers-json.js:
   - Reads provider config from Turso
   - Writes data/retail/providers.json

3. git add data/ → commit → force-push to api branch
```

Runs 4x/hour at :08, :23, :38, :53 — offset from retail scrape to pick up latest data.
Single writer (Fly.io only), no merge conflicts. Force-push is safe because `api` branch
is data-only.

---

## Spot Pipeline (`run-spot.sh`)

Simple single-step pipeline, no scraping complexity.

```
Cron: 0,30 * * * *
1. spot-extract.js calls MetalPriceAPI (REST API, no browser needed)
2. Writes to data/hourly/YYYY/MM/DD/HH.json
3. Writes to Turso (spot_prices table)
4. run-publish.sh picks up hourly files on next cycle
```

**No proxy needed** — MetalPriceAPI is an authenticated REST API that doesn't block
datacenter IPs.

---

## Goldback Pipeline (`run-goldback.sh`)

```
Cron: 1 * * * * (hourly, skips if today's price already captured)
1. Check goldback-spot.json → if today's date already captured, exit
2. goldback-scraper.js scrapes Goldback.com via Firecrawl
3. Writes data/api/goldback-spot.json + data/goldback-YYYY.json
4. Commits directly to api branch and pushes (separate from run-publish.sh)
```

**Completely independent** from the retail pipeline. Does not share the retail cron,
does not go through the vision pipeline, and commits/pushes directly rather than
waiting for run-publish.sh.

---

## Data Flow Summary

```
                     Fly.io Container
                     ────────────────

:15/:45 run-local.sh
  │
  ├─ price-extract.js ──┐
  │   Phase 1: Firecrawl │──→ Turso (price_snapshots)
  │   Phase 2: Playwright│
  │                      │
  ├─ capture.js ─────────┤──→ /tmp/screenshots/*.png
  │                      │
  └─ extract-vision.js ──┘──→ data/retail/{slug}/*-vision.json
                                      │
:08/:23/:38/:53 run-publish.sh        │
  │                                   │
  ├─ api-export.js ◄──────────────────┘
  │   Turso + vision JSON
  │   → data/api/manifest.json
  │   → data/api/latest.json
  │   → data/api/{slug}/*.json
  │
  └─ git push → api branch → GitHub Pages → api.staktrakr.com


:00/:30 run-spot.sh
  └─ spot-extract.js → data/hourly/ + Turso
       → picked up by next run-publish.sh


:01 run-goldback.sh
  └─ goldback-scraper.js → data/api/goldback-spot.json
       → commits + pushes directly to api branch


Every 15 min: GHA "Merge Poller Branches"
  └─ api branch + api1 branch → main branch (newest-wins)
       → GitHub Pages serves main
```

---

## VM Sizing Rationale

```toml
[[vm]]
  memory = '4096'    # 4GB — max observed footprint is ~3GB
  cpu_kind = 'shared'
  cpus = 8           # 8 shared CPUs — CPU is the bottleneck, not RAM
```

**Why 8 CPUs / 4GB RAM** (changed 2026-03-02):

The container runs 11 supervisord processes including Chromium, Firecrawl, Redis,
RabbitMQ, and PostgreSQL. Under sustained 30+ minute scrape load, 4 shared CPUs
were saturating at 100%. RAM never exceeded ~3GB even under peak load.

The tradeoff: 8 shared CPUs with 4GB RAM provides better throughput than 4 CPUs
with 8GB. Shared CPUs are burstable, so the extra cores help during parallel
Firecrawl+Chromium+Redis activity.

---

## Target Inventory (88 active)

| Category | Count | Vendors |
|----------|-------|---------|
| Precious metals (11 coins) | 66 | apmex, sdbullion, jmbullion, monumentmetals, herobullion, bullionexchanges, summitmetals |
| Goldback retail (14 denoms) | 22 | Various (Arizona 7×2, Oklahoma 5×1-2, Utah G50, Wyoming G50) |
| Goldback placeholders | 0 | DC, NV, NH, SD, generic — no vendors configured |
| **Total active** | **88** | All have vendor + URL in Turso |

---

## Key Secrets (Fly.io)

| Secret | Used By | Purpose |
|--------|---------|---------|
| `HOME_PROXY_URL` | supervisord, price-extract.js, capture.js | Residential proxy for Chromium |
| `GITHUB_TOKEN` | run-publish.sh, run-goldback.sh | Git push to api branch |
| `TS_AUTHKEY` | tailscale-up | Tailscale authentication |
| `GEMINI_API_KEY` | extract-vision.js | Gemini Vision API |
| `TURSO_DATABASE_URL` | price-extract.js, api-export.js, spot-extract.js | Turso cloud DB |
| `TURSO_AUTH_TOKEN` | (same) | Turso auth |
| `METAL_PRICE_API_KEY` | spot-extract.js | MetalPriceAPI spot prices |

---

## Known Issues

1. **run-retry.sh is dead code** — reads `/tmp/retail-failures.json` which is never
   written by `price-extract.js` (failures go to Turso instead). Safe to remove.

2. **capture.js must stay sequential** — parallel `chromium.launch()` spawns ~200MB
   per instance. On a 4GB container, 15+ parallel browsers cause OOM.

3. **Chromium ignores Tailscale exit node** — this is a fundamental limitation.
   Chromium's network stack bypasses the OS-level exit node routing. All Chromium
   instances MUST use an explicit HTTP proxy (`HOME_PROXY_URL`). Do not remove
   `PROXY_SERVER` from supervisord.conf or proxy config from capture.js/price-extract.js.

4. **Home VM offline = degraded scraping** — when the home VM is unreachable, both the
   Tailscale exit node and tinyproxy are unavailable. The container falls back to the
   Fly.io datacenter IP, which is blocked by ~90% of dealers. Spot and goldback
   continue working (API-based, no proxy needed).

---

## File Reference

| File | Lines | Role |
|------|-------|------|
| `fly.toml` | ~53 | VM sizing, env vars, HTTP service config |
| `Dockerfile` | ~150 | Multi-stage build: Firecrawl + Playwright + app |
| `docker-entrypoint.sh` | ~80 | Container init, cron setup, PG init |
| `supervisord.conf` | ~137 | 11 process definitions |
| `run-local.sh` | ~105 | Retail pipeline orchestrator |
| `price-extract.js` | ~865 | Phase 1 (Firecrawl) + Phase 2 (Playwright) scraping |
| `capture.js` | ~517 | Vision screenshot pipeline |
| `extract-vision.js` | ~300 | Gemini Vision extraction |
| `api-export.js` | ~400 | Turso → static JSON export |
| `run-publish.sh` | ~66 | Export + git push to api branch |
| `run-spot.sh` | ~30 | Spot price cron wrapper |
| `run-goldback.sh` | ~61 | Goldback daily rate cron wrapper |
| `serve.js` | ~100 | Public HTTP API server (port 8080) |
