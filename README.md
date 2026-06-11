# StakTrakrApi

Data repository for [StakTrakr](https://staktrakr.com) — precious metals inventory tracker.
Served via GitHub Pages at **[api.staktrakr.com](https://api.staktrakr.com)**.

---

## Architecture

Three independent data feeds write to this repo's `api` branch. A merge workflow publishes them to `main` every 15 minutes, which GitHub Pages serves at `api.staktrakr.com`.

```
Fly.io container (staktrakr)          GitHub Actions
  retail-poller cron (*/15 min)         spot-poller.yml (:05 and :35/hr)
  goldback cron (daily 17:01 UTC)              │
        │                                      │
        ▼                                      ▼
  StakTrakrApi api branch ◄─────────────────────
        │
        │  Merge Poller Branches (*/15 min GHA)
        ▼
  StakTrakrApi main branch
        │
        │  GitHub Pages deploy (~3 min)
        ▼
  api.staktrakr.com  ◄── StakTrakr UI
```

### Data feeds

| Feed | File | Updated by | Frequency |
|------|------|-----------|-----------|
| **Market prices** | `data/api/manifest.json` | Fly.io retail-poller | Every 15 min |
| **Spot prices** | `data/hourly/YYYY/MM/DD/HH.json` | `spot-poller.yml` GHA (MetalPriceAPI) | Twice per hour |
| **Goldback** | `data/api/goldback-spot.json` | Fly.io goldback cron | Daily |

---

## Branches

| Branch | Purpose |
|--------|---------|
| `api` | Live write target — pollers push here |
| `main` | Merged + served — GitHub Pages reads from here |

---

## Directory Structure

```
data/
├── api/
│   ├── manifest.json          ← market prices (all coins, generated_at timestamp)
│   ├── goldback-spot.json     ← Goldback G1 exchange rate (scraped_at timestamp)
│   └── {coin-slug}/
│       └── latest.json        ← per-coin retail price data
├── hourly/
│   └── YYYY/
│       └── MM/
│           └── DD/
│               └── HH.json    ← spot prices for that UTC hour (array of entries)
├── retail/
│   └── providers.json         ← vendor configuration
├── spot-history-YYYY.json     ← daily noon UTC seed entries (not live data)
└── spot-history-bundle.js     ← bundled multi-year history for fast app load
```

---

## API Endpoints

All endpoints are served from `https://api.staktrakr.com/data/`.

| Endpoint | Description |
|----------|-------------|
| `/data/api/manifest.json` | Market prices — all tracked coins, `generated_at` freshness field |
| `/data/hourly/YYYY/MM/DD/HH.json` | Spot prices for a UTC hour — array of `{timestamp, gold, silver, ...}` entries |
| `/data/api/goldback-spot.json` | Goldback G1 exchange rate — `scraped_at` freshness field |
| `/data/api/{coin-slug}/latest.json` | Latest retail price for a specific coin |
| `/data/spot-history-YYYY.json` | Yearly spot price seed file (noon UTC daily entries) |

---

## Pollers

The pollers that write to this repo live in the main [StakTrakr](https://github.com/lbruton/StakTrakr) repo:

| Poller | Location | Runtime |
|--------|---------|---------|
| Retail + Goldback | `devops/retail-poller/` | Fly.io (`fly deploy` from that directory) |
| Spot prices | `devops/spot-poller/` + `.github/workflows/spot-poller.yml` | GitHub Actions |
| Merge Poller Branches | `.github/workflows/` (in this repo) | GitHub Actions |

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

print(f"API Health — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
")
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
