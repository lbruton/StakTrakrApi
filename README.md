# StakTrakrApi

Data repository for [StakTrakr](https://staktrakr.com) — precious metals inventory tracker.
Served via GitHub Pages at **[api.staktrakr.com](https://api.staktrakr.com)**.

---

## Architecture

All data is produced by the **Fly.io container** (`staktrakr` app, `dfw` region) and force-pushed to the `api` branch. GitHub Pages serves from `main`.

```
Fly.io container (staktrakr)
  ├── run-local.sh    (retail scrape)       cron: 15,45 * * * *
  ├── run-spot.sh     (spot prices)         cron: 5,20,35,50 * * * *
  ├── run-publish.sh  (Turso → JSON → git)  cron: 8,23,38,53 * * * *
  ├── run-retry.sh    (T3 proxy retry)      cron: 15 * * * *
  └── run-fbp.sh      (FBP gap-fill)        cron: 0 20 * * *
        │
        ▼
  StakTrakrApi api branch
        │
        │  Merge Poller Branches (GHA)
        ▼
  StakTrakrApi main branch
        │
        │  GitHub Pages deploy
        ▼
  api.staktrakr.com  ◄── StakTrakr UI
```

### Data Feeds

| Feed | Source | Frequency | Freshness field |
|------|--------|-----------|-----------------|
| **Market prices** | Firecrawl + Gemini Vision → Turso → api-export.js | Every 15 min | `manifest.json` → `generated_at` |
| **Spot prices** | MetalPriceAPI → poller.py | Every 15 min (4×/hr) | Hourly file timestamp |
| **Goldback spot** | Turso `goldback-g1` vendor data → api-export.js | Every 15 min | `goldback-spot.json` → `scraped_at` |

### Source of Truth

**Turso** (libSQL cloud) is the single source of truth for all retail/market price data. Spot prices currently write directly to JSON files (see STAK-331).

---

## Branches

| Branch | Purpose |
|--------|---------|
| `api` | Live write target — Fly.io force-pushes here |
| `main` | Merged + served — GitHub Pages reads from here |

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

**Goldback slugs (per-state):** `goldback-{state}-g{denom}` — 8 states × 7 denominations = 56 slugs. States: `utah`, `nevada`, `wyoming`, `new-hampshire`, `south-dakota`, `arizona`, `oklahoma`, `dc`. Denominations: `ghalf`, `g1`, `g2`, `g5`, `g10`, `g25`, `g50`.

**Goldback slugs (deprecated):** `goldback-g1` through `goldback-g50` — kept for backward compat; marked `deprecated: true` in providers.json.

### Spot Prices

| Endpoint | Description |
|----------|-------------|
| `/data/hourly/YYYY/MM/DD/HH.json` | Spot prices for a UTC hour (Gold, Silver, Platinum, Palladium) |
| `/data/15min/YYYY/MM/DD/HHMM.json` | Immutable 15-min spot snapshot |
| `/data/spot-history-YYYY.json` | Yearly seed file — noon UTC daily entries (not live data) |

---

## Scrape Resilience (T1–T5)

| Tier | Method | Trigger |
|------|--------|---------|
| T1 | Firecrawl (self-hosted, port 3002) | Default — Tailscale residential IP |
| T2 | Playwright fallback (local Chromium) | Firecrawl fails |
| T3 | Webshare proxy retry (`run-retry.sh` at :15) | T1+T2 both failed |
| T4 | Turso last-known-good price | T3 also fails — `api-export.js` fills at publish time |
| T5 | FindBullionPrices gap-fill (`run-fbp.sh` daily 20:00 UTC) | Remaining gaps after T4 |

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
| `price-extract.js` | Scrape vendor prices (Firecrawl + Playwright fallback) |
| `capture.js` | Screenshot vendor pages (Playwright) |
| `extract-vision.js` | Gemini Vision price extraction from screenshots |
| `merge-prices.js` | Merge scraped prices into Turso |
| `api-export.js` | Turso → in-memory SQLite → static JSON files |
| `serve.js` | Redundancy HTTP server on port 8080 |
| `turso-client.js` | Turso libSQL client (createTursoClient, initTursoSchema) |
| `goldback-scraper.js` | Legacy goldback scraper (not in cron — superseded by retail pipeline) |
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

Full infrastructure documentation lives in **[StakTrakrWiki](https://github.com/lbruton/StakTrakrWiki)**:

| Page | Contents |
|------|----------|
| [Architecture Overview](https://github.com/lbruton/StakTrakrWiki/blob/main/architecture-overview.md) | System diagram, repo boundaries |
| [REST API Reference](https://github.com/lbruton/StakTrakrWiki/blob/main/rest-api-reference.md) | Complete endpoint map, schemas, confidence tiers |
| [Retail Pipeline](https://github.com/lbruton/StakTrakrWiki/blob/main/retail-pipeline.md) | Dual-poller architecture, Turso, Vision pipeline |
| [Spot Pipeline](https://github.com/lbruton/StakTrakrWiki/blob/main/spot-pipeline.md) | MetalPriceAPI, hourly/15min files |
| [Goldback Pipeline](https://github.com/lbruton/StakTrakrWiki/blob/main/goldback-pipeline.md) | Per-state slugs, denomination generation |
| [Turso Schema](https://github.com/lbruton/StakTrakrWiki/blob/main/turso-schema.md) | Database tables, indexes, key queries |
| [Cron Schedule](https://github.com/lbruton/StakTrakrWiki/blob/main/cron-schedule.md) | Full timeline view |
| [Fly.io Container](https://github.com/lbruton/StakTrakrWiki/blob/main/fly-container.md) | Deploy, SSH, secrets |
| [Health & Diagnostics](https://github.com/lbruton/StakTrakrWiki/blob/main/health.md) | Stale thresholds, diagnosis commands |
