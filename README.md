# StakTrakrApi

Data repository for [StakTrakr](https://staktrakr.com) — precious metals inventory tracker.
Served via GitHub Pages at **[api.staktrakr.com](https://api.staktrakr.com)**.

---

## Architecture

All data is produced by the **Fly.io container** (`staktrakr` app, `dfw` region, 8 shared CPUs / 4GB RAM) and force-pushed to the `api` branch. GitHub Pages serves directly from the `api` branch.

A **home poller** (LXC container on a home VM) scrapes independently and writes to the same Turso database. Both pollers' data is merged by `api-export.js` at publish time, providing redundancy and broader vendor coverage.

```
Fly.io container (staktrakr, dfw, 8 shared CPUs / 4GB RAM)
  ├── run-local.sh    (retail scrape)       cron: 0 * * * *
  ├── run-spot.sh     (spot prices)         cron: 0,30 * * * *
  ├── run-publish.sh  (Turso → JSON → git)  cron: 8,23,38,53 * * * *
  ├── run-retry.sh    (T3 proxy retry)      cron: 15 * * * *
  └── run-goldback.sh (goldback exchange)    cron: 1 * * * *
        │
        ▼
  StakTrakrApi api branch
        │
        │  GitHub Pages
        ▼
  api.staktrakr.com  ◄── StakTrakr UI
```

### Data Feeds

| Feed | Source | Frequency | Freshness field |
|------|--------|-----------|-----------------|
| **Market prices** | Firecrawl + Gemini Vision → Turso → api-export.js | Hourly (`:00`) | `manifest.json` → `generated_at` |
| **Spot prices** | MetalPriceAPI → poller.py | Every 30 min (`:00`, `:30`) | Hourly file timestamp |
| **Goldback spot** | goldback-scraper.js → Turso → api-export.js | Hourly (`:01`) | `goldback-spot.json` → `scraped_at` |

### Source of Truth

**Turso** (libSQL cloud) is the single source of truth for all retail/market price data. Spot prices currently write directly to JSON files (see STAK-331).

---

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Source code — Fly.io deploys from here |
| `api` | Data branch — Fly.io force-pushes JSON here, GitHub Pages serves from here |

---

## Directory Structure

```
data/
├── api/
│   ├── manifest.json              ← market prices index (all coins, generated_at)
│   ├── latest.json                ← all coins current window: median, lowest, vendor count
│   ├── providers.json             ← vendor → product URL mapping per coin
│   ├── goldback-spot.json         ← Goldback G1 rate + denomination multipliers
│   └── {coin-slug}/
│       ├── latest.json            ← per-vendor prices, confidence, availability, 24h series
│       ├── history-7d.json        ← daily aggregates, last 7 days
│       └── history-30d.json       ← daily aggregates, last 30 days
├── hourly/
│   └── YYYY/MM/DD/
│       └── HH.json               ← spot prices for that UTC hour (overwritten each poll)
├── 15min/
│   └── YYYY/MM/DD/
│       └── HHMM.json             ← immutable 15-min spot snapshots
├── retail/
│   └── providers.json             ← vendor configuration (URL changes auto-sync next cycle)
├── spot-history-YYYY.json         ← daily noon UTC seed entries (NOT live data)
└── spot-history-bundle.js         ← bundled multi-year history for fast app load
```

---

## API Endpoints

All served from `https://api.staktrakr.com/data/`.

### Global

| Endpoint | Description |
|----------|-------------|
| `/data/api/manifest.json` | Index: coin list, latest window, endpoint templates |
| `/data/api/latest.json` | All coins' current median/lowest prices |
| `/data/api/providers.json` | Vendor → product URL mapping per coin |
| `/data/api/goldback-spot.json` | Goldback G1 exchange rate + denomination multipliers |

### Per-Coin (17 bullion + 62 Goldback slugs)

| Endpoint | Description |
|----------|-------------|
| `/data/api/{slug}/latest.json` | Per-vendor prices, confidence scores, availability, 24h time series |
| `/data/api/{slug}/history-7d.json` | Daily aggregates, last 7 days |
| `/data/api/{slug}/history-30d.json` | Daily aggregates, last 30 days |

**Bullion slugs:** `ase`, `maple-silver`, `britannia-silver`, `krugerrand-silver`, `generic-silver-round`, `generic-silver-bar-10oz`, `age`, `ape`, `buffalo`, `maple-gold`, `krugerrand-gold`

**Goldback slugs (per-state):** `goldback-{state}-g{denom}` — 8 states, 4 active + 4 placeholders = 56 slugs. Active states with vendors: `arizona`, `oklahoma`, `utah`, `wyoming`. Placeholder states (no active vendors): `dc`, `nevada`, `new-hampshire`, `south-dakota`. Denominations: `ghalf`, `g1`, `g2`, `g5`, `g10`, `g25`, `g50`.

**Goldback slugs (deprecated):** `goldback-g1` through `goldback-g50` — kept for backward compat; marked `deprecated: true` in providers.json.

### Spot Prices

| Endpoint | Description |
|----------|-------------|
| `/data/hourly/YYYY/MM/DD/HH.json` | Spot prices for a UTC hour (Gold, Silver, Platinum, Palladium) |
| `/data/15min/YYYY/MM/DD/HHMM.json` | Immutable 15-min spot snapshot |
| `/data/spot-history-YYYY.json` | Yearly seed file — noon UTC daily entries (not live data) |

---

## Scrape Resilience (T1–T4)

| Tier | Method | Trigger |
|------|--------|---------|
| T1 | Firecrawl (self-hosted, port 3002) — uses Fly.io datacenter IP directly | Default scrape method. ~1/3 of targets may 403 due to datacenter IP blocking |
| T2 | Playwright fallback (Chromium via HOME_PROXY_URL) | Firecrawl fails — routes through tinyproxy on home VM (Tailscale mesh) for residential IP. Chromium does not respect Tailscale exit nodes, so an explicit HTTP proxy is required |
| T3 | Webshare proxy retry (`run-retry.sh` at `:15`) | T1+T2 both failed |
| T4 | Turso last-known-good price | T3 also fails — `api-export.js` fills at publish time |

---

## Vision Cross-Validation

Gemini 2.5 Flash analyzes screenshots of each vendor page and cross-checks against Firecrawl prices:

| Agreement | Confidence |
|-----------|-----------|
| Both agree (≤3% diff) | 99 |
| Both present, disagree | ≤70 (use price closest to median) |
| Vision only | ~70 |
| Firecrawl only | 50 ± median deviation |

---

## Container Scripts

All live in the Fly.io container at `/app/`:

| Script | Purpose |
|--------|---------|
| `run-local.sh` | Retail scrape orchestrator — runs hourly at `:00` |
| `run-spot.sh` | Spot price poll — runs every 30 min at `:00`, `:30` |
| `run-publish.sh` | Turso → JSON → git push — runs every 15 min at `:08`, `:23`, `:38`, `:53` |
| `run-retry.sh` | T3 Webshare proxy retry — runs hourly at `:15` |
| `run-goldback.sh` | Goldback exchange scrape — runs hourly at `:01`, calls `goldback-scraper.js` |
| `price-extract.js` | Scrape vendor prices (Firecrawl + Playwright fallback) |
| `capture.js` | Screenshot vendor pages (Playwright) |
| `extract-vision.js` | Gemini Vision price extraction from screenshots |
| `merge-prices.js` | Merge scraped prices into Turso |
| `api-export.js` | Turso → in-memory SQLite → static JSON files |
| `goldback-scraper.js` | Goldback exchange rate scraper (called by `run-goldback.sh`) |
| `serve.js` | Redundancy HTTP server on port 8080 |
| `turso-client.js` | Turso libSQL client (createTursoClient, initTursoSchema) |
| `spot-poller/poller.py` | MetalPriceAPI spot price poller |

---

## Quick Health Check

```bash
python3 << 'HEALTHCHECK'
import urllib.request, json, re
from datetime import datetime, timezone, timedelta

def age_min(ts):
    ts = ts.strip()
    if not re.search(r'[zZ]$|[+-]\d{2}:?\d{2}$', ts):
        ts = ts.replace(' ', 'T') + 'Z'
    return (datetime.now(timezone.utc) - datetime.fromisoformat(ts.replace('Z','+00:00'))).total_seconds()/60

def fetch(url):
    with urllib.request.urlopen(url, timeout=10) as r: return json.load(r)

print(f"API Health — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n")
try:
    d = fetch('https://api.staktrakr.com/data/api/manifest.json')
    age = age_min(d['generated_at'])
    print(f"Market   {'✅' if age<=30 else '⚠️'}  {age:.0f}m ago  ({len(d.get('coins',[]))} coins)")
except Exception as e: print(f"Market   ❌  {e}")
try:
    now = datetime.now(timezone.utc)
    def url(dt): return f"https://api.staktrakr.com/data/hourly/{dt.year}/{dt.month:02d}/{dt.day:02d}/{dt.hour:02d}.json"
    try: d = fetch(url(now))
    except: d = fetch(url(now - timedelta(hours=1)))
    age = age_min(d[-1]['timestamp'])
    print(f"Spot     {'✅' if age<=75 else '⚠️'}  {age:.0f}m ago")
except Exception as e: print(f"Spot     ❌  {e}")
try:
    d = fetch('https://api.staktrakr.com/data/api/goldback-spot.json')
    age = age_min(d['scraped_at'])
    print(f"Goldback {'✅' if age<=1500 else '⚠️'}  {age:.0f}m ago  (${d.get('g1_usd')} G1)")
except Exception as e: print(f"Goldback ❌  {e}")
HEALTHCHECK
```

---

## Documentation

Full infrastructure documentation lives in the [StakTrakr wiki](https://github.com/lbruton/StakTrakr/tree/dev/wiki).
