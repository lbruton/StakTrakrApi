# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What This Repo Is

`lbruton/StakTrakrApi` is the **API backend** for StakTrakr. It holds:
- Static JSON files served via GitHub Pages at `api.staktrakr.com`
- All poller devops code (`devops/`) — the source of truth for the entire data pipeline

There is no build step for the data files. The poller code in `devops/` is what writes them.

**GitHub Pages is configured to serve the `api` branch directly** — not `main`. The `main` branch is kept in sync by the `Merge Poller Branches` workflow but is not the live-served branch. All poller commits must target `api`.

### Repo Boundaries

| Repo | Owns |
|------|------|
| `lbruton/StakTrakr` | Frontend app code, Cloudflare Pages deployment, local dev tools (`devops/hooks/`, `devops/browserless/`, `devops/cgc/`) |
| `lbruton/StakTrakrApi` (this repo) | All API backend: poller code, GHA workflows, devops configs, data files |

---

## Architecture

```
Fly.io container (staktrakr)          Home VM (192.168.1.48)
  retail cron :15/:45                   retail cron :30 (offset)
  spot cron :05/:20/:35/:50             NO spot — reads only
  goldback cron daily 17:01 UTC         NO goldback
        │                                      │
        ▼                                      ▼
  git push → api branch               Turso only (no git push)
        │
        │  Merge Poller Branches (*/15 min GHA — this repo)
        ▼
  StakTrakrApi  main  branch  →  GitHub Pages  →  api.staktrakr.com
```

> **Home VM writes to Turso only** — it does NOT push to the api branch or write data files to git. Only the Fly.io container runs `run-publish.sh`.

### Three Data Feeds

| Feed | File | Writer | Stale threshold |
|------|------|--------|-----------------|
| Market prices | `data/api/manifest.json` | Fly.io `run-local.sh` (*/15 min) | 30 min |
| Spot prices | `data/hourly/YYYY/MM/DD/HH.json` | Fly.io `run-spot.sh` cron (5,20,35,50 * * * *) | 75 min |
| Goldback | `data/api/goldback-spot.json` | Fly.io `run-goldback.sh` (daily 17:01 UTC) | 25h |

`spot-history-YYYY.json` is a **seed file** (one noon-UTC entry per day). It is NOT live spot data — do not use it for freshness checks.

### Fly.io Container (retail + goldback)

Single `staktrakr` app managed by supervisord. Runs: Redis, RabbitMQ, PostgreSQL 17, Playwright service (port 3003), self-hosted Firecrawl (port 3002), three cron scripts, and `serve.js` (port 8080).

**Retail pipeline** (`run-local.sh`):
1. `price-extract.js` — scrapes dealers via Firecrawl + Playwright fallback → writes to Turso (`price_snapshots` table)
2. `capture.js` — screenshots via Browserless CDP
3. `extract-vision.js` — Gemini Vision cross-reference → per-coin vision JSON
4. `api-export.js` — merges Turso + vision JSON → `data/api/` → git push to `api` branch

**Turso** is the internal write-through store (free-tier libSQL cloud). The `prices.db` file in the repo is a read-only SQLite snapshot exported each cycle — not used in production reads.

`providers.json` lives on the **`api` branch** at `data/retail/providers.json`. Fetch from `api` branch before running locally.

### Merge Workflow (`.github/workflows/merge-poller-branches.yml`)

Runs every 15 min. Merges `api` and `api1` poller branches into `main` using newest-wins logic:
- Per-coin files: compare `window_start` (latest.json) or last entry `.date` (history files)
- `manifest.json`: compare `generated_at`
- `providers.json`: always from `api` branch (canonical config)
- `prices.db`: from branch with newer `manifest.json`
- Spot hourly data: synced from `lbruton/StakTrakr` `data` branch (idempotent — only new files copied, last 48h window)

---

## Quick Health Check

```bash
python3 << 'EOF'
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
    print(f"Goldback {'✅' if age<=1500 else '⚠️'}  {age/60:.1f}h ago  (${d.get('g1_usd')} G1)")
except Exception as e: print(f"Goldback ❌  {e}")
EOF
```

```bash
# GHA workflow status (spot-poller.yml is RETIRED — check Fly logs instead)
gh run list --repo lbruton/StakTrakrApi --workflow "Merge Poller Branches" --limit 5

# Fly.io container
fly logs --app staktrakr
fly status --app staktrakr
fly ssh console --app staktrakr -C "supervisorctl status"

# Manually trigger a goldback scrape
fly ssh console --app staktrakr -C "/app/run-goldback.sh"
```

---

## Diagnosing Feed Failures

| Symptom | Likely cause | Check |
|---------|-------------|-------|
| `manifest.json` > 30 min stale | Fly.io cron missed | `fly logs --app staktrakr \| grep retail` |
| `manifest.json` > 4h stale | Fly.io container down | `fly status --app staktrakr` |
| Spot hourly > 75 min stale | Fly.io run-spot.sh cron missed | `fly logs --app staktrakr \| grep spot`; check `METAL_PRICE_API_KEY` |
| `goldback-spot.json` > 25h stale | Fly.io goldback cron | `fly logs --app staktrakr \| grep goldback` |
| Merge workflow failing | Branch missing or jq parse error | GHA run logs in this repo |

---

## Key Files

| File | Purpose |
|------|---------|
| `.github/workflows/merge-poller-branches.yml` | Merges `api` + `api1` poller branches → `main` every 15 min |
| `.github/workflows/spot-poller.yml` | **RETIRED** — spot polling moved to Fly.io `run-spot.sh` |
| `data/api/manifest.json` | Market prices root; `generated_at` is the freshness timestamp |
| `data/api/providers.json` | Vendor config on `api` branch (not in `main`) |
| `data/hourly/YYYY/MM/DD/HH.json` | Live spot price arrays |
| `data/api/goldback-spot.json` | Goldback G1 rate; `scraped_at` is freshness timestamp |
| `data/spot-history-YYYY.json` | Seed file — noon UTC daily entries, NOT live data |
| `prices.db` | Read-only SQLite snapshot; not used in production reads |

---

## Related Repos

| Repo | Role |
|------|------|
| `lbruton/StakTrakr` | Frontend app code, Cloudflare Pages deployment, local dev tools only |
| `lbruton/StakTrakrApi` (this repo) | All API backend: poller code (`devops/`), GHA workflows, data files served via GH Pages |
| `lbruton/stakscrapr` | Home VM poller — runs same scraper code, writes Turso only (no git push) |

To deploy the Fly.io container: `cd devops/fly-poller && fly deploy`.

## devops/ Folder Structure

| Folder | Contains |
|--------|---------|
| `devops/fly-poller/` | Fly.io container: fly.toml, Dockerfile, all run-*.sh, AND shared scraper code (price-extract.js, api-export.js, etc.) |
| `devops/home-scraper/` | Home VM additions: run-home.sh, setup-lxc.sh, sync-from-fly.sh |
| `devops/home-vm/` | Infrastructure: tinyproxy-cox, cox-auth, sysctl |

**fly-poller/ is the single source of truth** for all scraper code. The home VM runs identical copies. Use `devops/home-scraper/sync-from-fly.sh` to keep them in sync.

## Keeping Home VM in Sync

```bash
cd devops/home-scraper
./sync-from-fly.sh              # dry-run — see what changed
./sync-from-fly.sh --apply      # copy files to stakscrapr
./sync-from-fly.sh --apply --push  # copy + commit + push
```
