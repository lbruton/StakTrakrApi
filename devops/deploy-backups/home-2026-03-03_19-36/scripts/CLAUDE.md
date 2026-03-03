# CLAUDE.md - Project Configuration & MCP Server Reference

## Project: stakscrapr

Working directory: `/home/lbruton/stakscrapr`

---

## Role

This VM is the **home poller** — the backup/secondary web scraper for the StakTrakr precious metals price tracking app. It mirrors the Fly.io `staktrakr` container but runs natively on Ubuntu (LXC container). Key responsibilities:

- Keep Firecrawl + Playwright scraping stack healthy
- Run retail price scraper on cron (`:00` and `:30` every hour — 2×/hr)
- Write scraped prices to shared Turso (libSQL) database
- Sync `providers.json` from GitHub before each run
- Keep services and poller code up to date

---

## Architecture

### Service Stack

| Service           | How it runs          | Port/Socket    |
|-------------------|----------------------|----------------|
| Redis             | systemd              | localhost:6379 |
| RabbitMQ          | systemd              | localhost:5672 |
| Playwright Service| supervisord          | localhost:3003 |
| Firecrawl API     | supervisord          | localhost:3002 |
| Firecrawl Worker  | supervisord          | —              |
| Dashboard         | supervisord          | 0.0.0.0:3010   |
| Metrics Exporter  | supervisord          | 0.0.0.0:9100   |
| Grafana           | systemd              | 0.0.0.0:3000   |
| Prometheus        | systemd              | 0.0.0.0:9090   |
| Tailscale         | systemd              | tailscale0     |
| tinyproxy         | systemd              | 0.0.0.0:8888   |
| Cron              | systemd              | —              |

### Residential Proxy (tinyproxy)

This VM runs **tinyproxy** as an HTTP proxy for the Fly.io container, routing scraper traffic through the home residential IP.

| Component | Detail |
|-----------|--------|
| Proxy URL | `http://100.112.198.50:8888` |
| Accepts connections from | Tailscale IPs only (100.112.198.50, 100.90.171.110) |
| Residential egress IP | `98.184.142.225` |
| Config | `/etc/tinyproxy/tinyproxy.conf` |
| `DisableViaHeader` | Yes (no proxy fingerprint) |

**Why residential IP matters:** Retail bullion dealers don't block residential IPs. Fly.io datacenter IPs can trigger bot detection on some vendors.

Fly.io sets `PROXY_SERVER=http://100.112.198.50:8888` and routes scraper traffic through it.

### Tailscale mesh

| Node | Tailscale IP |
|------|-------------|
| Home VM (`stacktrckr`) | 100.112.198.50 |
| Fly.io container (`staktrakr-fly`) | 100.90.171.110 |

### Key Paths

| Path | Purpose |
|------|---------|
| `/opt/poller/` | Poller scripts, JS source, package.json |
| `/opt/poller/dashboard.js` | HTTP dashboard server — port 3010, managed by supervisord |
| `/opt/poller/.env` | Secrets (Turso creds, Firecrawl URL) — **never commit** |
| `/opt/poller/data/retail/providers.json` | Dealer URLs/selectors — auto-synced from `api` branch each run |
| `/opt/poller/CLAUDE.md` | Detailed poller-specific instructions |
| `/opt/firecrawl/` | Firecrawl API + worker binaries |
| `/opt/playwright-service/` | Playwright microservice |
| `/usr/local/share/playwright/` | Chromium browsers for Playwright |
| `/etc/supervisor/conf.d/staktrakr.conf` | Supervisord config for Firecrawl stack |
| `/opt/poller/wiki/` | StakTrakrWiki clone — semantic search via claude-context |
| `/opt/poller/metrics-exporter.js` | Prometheus metrics exporter |
| `/etc/tinyproxy/tinyproxy.conf` | tinyproxy config |
| `/etc/grafana/provisioning/` | Grafana datasource + dashboard provisioning |
| `/etc/prometheus/prometheus.yml` | Prometheus scrape config |
| `/etc/cron.d/retail-poller` | Cron schedule (`:00` and `:30` every hour) |
| `/etc/cron.d/flyio-health` | Fly.io health check (every 5 min) |
| `/var/log/retail-poller.log` | Poller output log |
| `/var/log/supervisor/` | Firecrawl/Playwright service logs |
| `/home/lbruton/stakscrapr/` | This repo — Claude config, CLAUDE.md |

### Cron Schedule

```
0,30 * * * * root /opt/poller/run-home.sh >> /var/log/retail-poller.log 2>&1
*/5 * * * * root /opt/poller/check-flyio.sh >> /var/log/retail-poller.log 2>&1
```

---

## StakTrakr Project Overview

StakTrakr is a precious metals inventory tracker hosted on Cloudflare Pages. It tracks 11 coins from 7 retail vendors.

### API Infrastructure

| Endpoint | Source | Poller |
|----------|--------|--------|
| `api.staktrakr.com` | GitHub Pages → `lbruton/StakTrakrApi` `api` branch | Fly.io `staktrakr` app |
| `api1.staktrakr.com` | GitHub Pages → `lbruton/StakTrakrApi1` `data` branch | Mac Docker poller (`POLLER_ID=api2`) |
| `api2.staktrakr.com` | Fly.io persistent volume → `/data/staktrakr-api-export/` | Fly.io app (serve.js, port 8080) |

- GHA `sync-api-repos.yml` runs at 5:00 AM UTC daily — bidirectional additive sync between StakTrakrApi and StakTrakrApi1
- **This VM (home poller)** writes to the shared Turso DB; it does NOT push to GitHub directly

### Repositories

| Repo | Purpose |
|------|---------|
| `lbruton/StakTrakr` | Frontend app (Cloudflare Pages) |
| `lbruton/StakTrakrApi` | Primary API data + poller code (`devops/fly-poller/`, `devops/spot-poller/`) — **source of truth** |
| `lbruton/StakTrakrApi1` | Secondary/fallback API data |
| `lbruton/StakTrakrWiki` | Shared wiki — sole source of truth for all infrastructure docs |
| `lbruton/stakscrapr` | This repo — home poller VM config |

---

## Common Tasks

### Dashboard

Live at `http://192.168.1.81:3010` — shows system stats, network bandwidth, service health,
and all poller run history from Turso (home + Fly.io pollers combined).

Managed by supervisord as `[program:dashboard]`. Restart with:
```bash
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf restart dashboard
```

**Turso run logging**: `price-extract.js` writes one row to `poller_runs` table per run
(start + finish). Fields: `poller_id`, `started_at`, `finished_at`, `status`, `total`,
`captured`, `failures`, `fbp_filled`, `error`. Both home and Fly.io pollers write here.

### Check service health

```bash
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf status
systemctl status redis-server rabbitmq-server cron tailscaled tinyproxy grafana-server prometheus
```

### Check recent poller logs

```bash
tail -100 /var/log/retail-poller.log
tail -50 /var/log/supervisor/firecrawl-api.log
tail -50 /var/log/supervisor/firecrawl-worker.log
```

### Test a single coin

```bash
COINS=ase bash /opt/poller/run-home.sh
```

### Full test run

```bash
bash /opt/poller/run-home.sh
```

### Manual run (after missed cron tick or reboot)

The lockfile `/tmp/retail-poller.lock` is owned by `root` (cron runs as root) — must use `sudo` to remove it:

```bash
sudo rm -f /tmp/retail-poller.lock
bash /opt/poller/run-home.sh
```

### Fix log file permissions (first run or after log rotation)

`/var/log/retail-poller.log` is written by root (cron) but may not exist or may be unreadable:

```bash
sudo touch /var/log/retail-poller.log
sudo chmod 666 /var/log/retail-poller.log
```

### Restart Firecrawl stack

```bash
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf restart all
```

### Sync poller files from upstream (StakTrakrApi → /opt/poller)

Upstream source of truth: `lbruton/StakTrakrApi` → `main` branch → `devops/fly-poller/`

Poller JS/shell files live at `/opt/poller/`. To pull any individual file:

```bash
curl -sf https://raw.githubusercontent.com/lbruton/StakTrakrApi/main/devops/fly-poller/<filename> \
  -o /opt/poller/<filename>
```

**Full sync — all tracked poller files:**

```bash
BASE=https://raw.githubusercontent.com/lbruton/StakTrakrApi/main/devops/fly-poller
for f in \
  price-extract.js \
  capture.js \
  db.js \
  turso-client.js \
  merge-prices.js \
  api-export.js \
  serve.js \
  vision-patch.js \
  extract-vision.js \
  import-from-log.js \
  goldback-scraper.js \
  run-home.sh \
  run-fbp.sh \
  run-spot.sh \
  run-publish.sh \
  run-goldback.sh \
  monitor-oos.sh \
  package.json \
; do
  echo "Syncing $f..."
  curl -sf "$BASE/$f" -o "/opt/poller/$f" || echo "WARN: $f not found upstream"
done
```

After syncing `package.json`, run `npm install` if dependencies changed:

```bash
cd /opt/poller && npm install
```

**providers.json** is NOT synced this way — it auto-syncs from the `api` branch at the start of each cron run (see `run-home.sh`). To force a manual sync:

```bash
curl -sf https://raw.githubusercontent.com/lbruton/StakTrakrApi/api/data/retail/providers.json \
  -o /opt/poller/data/retail/providers.json
```

### Update Firecrawl/Playwright binaries from Docker images

```bash
sudo docker run --rm ghcr.io/firecrawl/firecrawl:latest tar -cf - -C / app | sudo tar -xf - -C /opt/ && sudo mv /opt/app /opt/firecrawl
sudo docker run --rm ghcr.io/firecrawl/playwright-service:latest tar -cf - -C /usr/src app | sudo tar -xf - -C /opt/ && sudo mv /opt/app /opt/playwright-service
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf restart all
```

---

## Known Issues

- **jmbullion** frequently returns fractional weights instead of 1 oz products — provider URL/selector issue, not a scraper bug
- **monumentmetals** often shows PRE-ORDER/out-of-stock — FBP backfill usually covers it
- **age/sdbullion** occasionally returns no price found — worth monitoring
- **Docker** is installed via snap but the user doesn't have group access — needed for Firecrawl/Playwright binary updates (use `sudo docker`)
- **Lockfile is root-owned** — `/tmp/retail-poller.lock` is created by cron (runs as root); use `sudo rm -f` to clear a stale lock after a reboot or interrupted run
- **/var/log/retail-poller.log** is written by root — use `sudo touch` + `sudo chmod 666` if it's missing or unreadable

---

## MCP Servers

### mem0 (Working)
- **Purpose**: Persistent memory storage across sessions.
- **Key tools**: `add_memory`, `search_memories`, `get_memories`, `delete_memory`, `list_entities`
- **Default user**: `lbruton`
- **Usage**: Use `search_memories` to recall past context. Use `add_memory` to persist important decisions.

### sequential-thinking (Working)
- **Purpose**: Structured multi-step reasoning and problem decomposition.
- **Key tools**: `sequentialthinking`

### brave-search (API Key Invalid)
- **Status**: API key (`BRAVE_API_KEY`) is invalid/expired. Needs renewal at https://brave.com/search/api/

### infisical (Working)
- **Host**: `http://192.168.1.47:8080` (self-hosted)
- **Project**: `StakTrakr` (id: `319a1db5-207d-49d0-a61d-3f3e6b440ded`)
- **Environments**: `dev`, `staging`, `prod`
- **Quirk**: `list-projects` requires `type: "secret-manager"` — using `"all"` returns 422
- **Key tools**: `list-projects`, `list-secrets`, `create-secret`, `update-secret`, `delete-secret`, `get-secret`

### code-graph-context (Requires Docker)
- **Status**: Docker permission issue — use `sudo docker` for container operations.

### chrome-devtools (Not Connected)
### claude-context (Working)
- **Purpose**: Semantic code/doc search via chunked vector index.
- **Wiki repo**: Cloned to `/opt/poller/wiki/` from `lbruton/StakTrakrWiki`
- **Usage**: Use `mcp__claude-context__search_code` with `path: "/opt/poller/wiki"` to search wiki content by natural language query. Index once with `index_codebase`, then search freely.
- **Keep wiki current**: `cd /opt/poller/wiki && git pull` before searching if docs may have changed.
- **StakTrakrWiki is the sole source of truth** for all infrastructure documentation.
### codacy (Not Connected)
### context7 (Not Connected)
### playwright (Not Connected)

### firecrawl-local
- **Host**: `http://localhost:3002`
- **Status**: Firecrawl API is running via supervisord on port 3002. Connect MCP to use it.

### Linear (Working)
- **Purpose**: Issue tracking, synced to GitHub issues for `lbruton/StakTrakr`.
- **Team**: `StakTrakr` (id: `f876864d-ff80-4231-ae6c-a8e5cb69aca4`)
- **Key tools**: `list_teams`, `list_issues`, `get_issue`, `create_issue`, `update_issue`, `create_comment`
- **Workflow**:
  - After poller/backend changes that require frontend work → open a Linear issue for the frontend team
  - Frontend team creates issues for Claude tasks → user provides issue ID → use `get_issue` to pull it up and work it
- **Note**: Tools are lazy-loaded — call `ToolSearch` for `mcp__claude_ai_Linear__*` before first use

---

## Notes

- `.mcp.json` contains API keys — in `.gitignore`, must never be committed
- **StakTrakrWiki** is the sole source of truth for infrastructure docs — cloned at `/opt/poller/wiki/`, searchable via `claude-context`
- Always `git pull` the wiki before searching; PR changes back to the wiki repo
- Upstream source of truth for poller code: `lbruton/StakTrakrApi` → `main` → `devops/fly-poller/`
- Upstream source of truth for providers.json: `lbruton/StakTrakrApi` → `api` → `data/retail/providers.json`
- Home poller runs 2×/hr (`:00` and `:30`); Fly.io runs every 15 min
- Most MCP servers are lazy-loaded; try `/mcp` to reconnect if not connected
