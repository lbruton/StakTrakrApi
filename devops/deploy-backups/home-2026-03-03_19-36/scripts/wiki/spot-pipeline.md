# Spot Price Pipeline

> **Last verified:** 2026-02-25
> ⚠️ **ARCHITECTURE GAP:** Spot poller still writes to files, not Turso — See STAK-331

---

## Overview

Spot prices (gold, silver, platinum, palladium in USD/oz) are polled 4× per hour and written as hourly JSON files to the `api` branch.

**Writer:** `run-spot.sh` cron inside the Fly.io container
**Cadence:** `5,20,35,50 * * * *` (4×/hr, offset from retail at `*/15`)
**Output:** `data/hourly/YYYY/MM/DD/HH.json`
**Stale threshold:** 75 minutes

---

## ⚠️ Known Architecture Gap (STAK-331)

The spot price poller (`poller.py`) is **not yet writing to Turso**. It writes directly to JSON files on the Fly.io persistent volume (`/data/staktrakr-api-export/data/hourly/...`).

**Expected architecture:** `poller.py` → Turso `spot_prices` table → `api-export.js` reads Turso → JSON files

**Actual state:** `poller.py` → JSON files directly (Turso bypassed entirely for spot data)

This means:
- Turso is **not** the single source of truth for spot prices
- `api-export.js` does not include spot prices from Turso
- Weeks of historical spot data may be missing from Turso (backfill required per STAK-331)

---

## Architecture

```
Fly.io container (staktrakr)
  run-spot.sh (5,20,35,50 * * * *)
      │
      ▼
  spot-poller/poller.py --once
      │
      ▼
  MetalPriceAPI  →  data/hourly/YYYY/MM/DD/HH.json  (direct file write — NOT via Turso)
      │
      ▼ (via run-publish.sh at 8,23,38,53)
  api branch  →  GitHub Pages  →  api.staktrakr.com
```

---

## Data Source

**MetalPriceAPI** (`metalpriceapi.com`) — requires `METAL_PRICE_API_KEY` Fly secret.

`poller.py` queries the API and writes a JSON array to the current hour file. Each entry has a `timestamp` field.

---

## Output Files

```
data/hourly/
  YYYY/
    MM/
      DD/
        HH.json    ← array of spot readings for that hour
```

Example path: `data/hourly/2026/02/24/15.json`

**Note:** `data/spot-history-YYYY.json` is a **seed file** containing one noon-UTC entry per day from a historical local Docker poller. It is NOT live spot data. Do not use it for freshness checks.

---

## run-spot.sh

Thin wrapper that calls `poller.py --once`:

```bash
DATA_DIR="/data/staktrakr-api-export/data" \
  METAL_PRICE_API_KEY="$METAL_PRICE_API_KEY" \
  python3 /app/spot-poller/poller.py --once
```

Requires:
- Volume mounted at `/data/staktrakr-api-export`
- `METAL_PRICE_API_KEY` env var set

---

## GHA Workflow (Retired)

`.github/workflows/spot-poller.yml` is **retired** as of 2026-02-23. Spot polling moved to the Fly.io container cron to reduce complexity and avoid GHA minute usage.

The workflow file is kept for emergency manual triggering only — it runs a no-op job that prints a message directing you to the container.

---

## Diagnosing Issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Hourly file > 75 min stale | `METAL_PRICE_API_KEY` expired or quota exceeded | Check MetalPriceAPI dashboard; rotate key in Fly secrets |
| Hourly file missing entirely | run-spot.sh not running | `fly logs --app staktrakr \| grep spot` |
| Stale data after deploy | New deploy wiped cron schedule? | `fly ssh console -C "crontab -l"` to verify |

```bash
# Check recent spot poll logs
fly logs --app staktrakr | grep spot

# Manual trigger
fly ssh console --app staktrakr -C "/app/run-spot.sh"

# Verify output
curl https://api.staktrakr.com/data/hourly/$(date -u +%Y/%m/%d/%H).json | jq .[-1]
```

---

## Health Check

```python
import urllib.request, json
from datetime import datetime, timezone, timedelta

def fetch(url):
    with urllib.request.urlopen(url, timeout=10) as r: return json.load(r)

now = datetime.now(timezone.utc)
def url(dt): return f"https://api.staktrakr.com/data/hourly/{dt.year}/{dt.month:02d}/{dt.day:02d}/{dt.hour:02d}.json"
try:
    d = fetch(url(now))
except:
    d = fetch(url(now - timedelta(hours=1)))
ts = d[-1]['timestamp']
age_min = (datetime.now(timezone.utc) - datetime.fromisoformat(ts.replace('Z','+00:00'))).total_seconds()/60
print(f"Spot: {'✅' if age_min <= 75 else '⚠️'} {age_min:.0f}m ago")
```
