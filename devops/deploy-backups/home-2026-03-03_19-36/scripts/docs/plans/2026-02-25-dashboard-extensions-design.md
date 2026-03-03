# Dashboard Extensions Design
**Date:** 2026-02-25
**Status:** Approved — ready for implementation planning

---

## Overview

Three features to build on top of the existing StakTrakr home poller dashboard (`/opt/poller/dashboard.js`, port 3010):

1. **Grafana monitoring** — system + poller + Turso metrics via Prometheus exporter
2. **Provider URL editor** — `/providers` page for inline CRUD on providers.json
3. **Failure queue** — `/failures` page listing chronically failing scrape URLs

---

## Architecture

```
                ┌─────────────────────────────┐
                │   dashboard.js (port 3010)   │
                │  /           — current home  │
                │  /providers  — URL editor    │
                │  /failures   — failure queue │
                └──────────┬──────────────────┘
                           │ reads/writes
                ┌──────────▼──────────────────┐
                │   providers.json (local)     │
                │   Turso DB (poller_runs,     │
                │            provider_failures)│
                └─────────────────────────────┘

                ┌─────────────────────────────┐
                │  metrics-exporter.js         │
                │  (supervisord, port 9100)    │
                │  /metrics → Prometheus fmt   │
                └──────────┬──────────────────┘
                           │ scrapes every 15s
                ┌──────────▼──────────────────┐
                │   Grafana (systemd, port     │
                │   3000) — Prometheus source  │
                └─────────────────────────────┘
```

No new ports opened to the internet. All services LAN-only (192.168.1.81).

---

## Feature 1: Grafana + Prometheus Exporter

### metrics-exporter.js
- New file at `/opt/poller/metrics-exporter.js`
- Managed by supervisord as `[program:metrics-exporter]`, port 9100
- Exposes `/metrics` in Prometheus text format
- Scrape interval: 15s

**Metrics exposed:**

| Metric | Source |
|--------|--------|
| `poller_cpu_load1/5/15` | `/proc/loadavg` |
| `poller_mem_used_pct` | `/proc/meminfo` |
| `poller_net_rx_bytes`, `poller_net_tx_bytes` | `/proc/net/dev` |
| `poller_uptime_seconds` | `/proc/uptime` |
| `poller_service_up{service}` | supervisorctl + systemctl |
| `poller_run_captured{poller_id}` | Turso `poller_runs` (last run) |
| `poller_run_failures{poller_id}` | Turso `poller_runs` (last run) |
| `poller_run_duration_seconds{poller_id}` | Turso `poller_runs` (last run) |
| `poller_run_capture_rate{poller_id}` | Turso `poller_runs` (last run) |
| `poller_provider_failures_total{coin_id,provider_id}` | Turso `provider_failures` (last 10 days) |
| `poller_failing_providers_count` | Turso `provider_failures` (URLs with ≥3 failures) |
| `poller_turso_up` | Turso ping query |

### Grafana
- Installed via `apt install grafana-oss`
- Runs as systemd service on port 3000
- Prometheus datasource: `http://localhost:9100`
- Three provisioned dashboards (JSON files in `/etc/grafana/provisioning/dashboards/`):
  1. **System** — CPU, memory, network, uptime, service health grid
  2. **Poller Runs** — capture rate over time, failures per run, duration, home vs Fly.io comparison
  3. **Failure Queue** — top failing providers, failure count over time, currently broken count

---

## Feature 2: Turso Schema — `provider_failures` table

```sql
CREATE TABLE IF NOT EXISTS provider_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  poller_id   TEXT NOT NULL,
  coin_id     TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  url         TEXT NOT NULL,
  error       TEXT,
  failed_at   TEXT NOT NULL
);
```

Written by both pollers (home + Fly.io) — one row per failure per run, same pattern as `poller_runs`.

**Changes to poller code:**
- `db.js`: add `logProviderFailure(poller_id, coin_id, provider_id, url, error)` function
- `price-extract.js`: call `logProviderFailure()` wherever a price capture fails
- `turso-client.js`: add `CREATE TABLE IF NOT EXISTS provider_failures` to `initTursoSchema()`

**Failure page query (3+ failures in last 10 days):**
```sql
SELECT coin_id, provider_id, url,
       COUNT(*) as failure_count,
       MAX(failed_at) as last_failed,
       MAX(error) as last_error
FROM provider_failures
WHERE failed_at > datetime('now', '-10 days')
GROUP BY coin_id, provider_id, url
HAVING COUNT(*) >= 3
ORDER BY failure_count DESC
```

---

## Feature 3: `/providers` — Provider URL Editor

**Route:** `GET /providers` renders editor, `POST /providers` saves changes.

**UI:** Full-page table organized by coin. Each provider row has:
- Provider name + ID (read-only)
- URL (editable inline text input)
- Enabled toggle (checkbox)
- Delete button (removes provider from coin)

Per-coin: **Add provider** button appends a blank row with id/name/url fields.

Single **Save All** button POSTs full updated JSON → server writes atomically to `/opt/poller/data/retail/providers.json`.

**No auto-push to GitHub** — user commits and pushes manually when ready.

---

## Feature 4: `/failures` — Failure Queue

**Route:** `GET /failures` — reads Turso, renders failure table.

**Columns:** Coin | Provider | URL | Failures (10d) | Last Failed | Last Error | Actions

**Actions per row:**
- **Edit URL** — inline edit → POST saves to providers.json
- **Disable** — sets `enabled: false` in providers.json
- **Copy URL** — clipboard copy (one click)

**Purpose:** Troubleshooting queue for hands-on sessions with Playwright/Firecrawl. No auto-remediation. Entries naturally fall off once failures stop (sliding 10-day window).

**Future flags** (not in scope now, but schema supports it): `skip`, `use_proxy`, `no_proxy` — would be added as provider-level fields in providers.json and editable from this page.

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `/opt/poller/metrics-exporter.js` | Create |
| `/opt/poller/dashboard.js` | Add `/providers`, `/failures` routes + POST handlers |
| `/opt/poller/db.js` | Add `logProviderFailure()` |
| `/opt/poller/turso-client.js` | Add `provider_failures` table to schema init |
| `/opt/poller/price-extract.js` | Call `logProviderFailure()` on capture failures |
| `/etc/supervisor/conf.d/staktrakr.conf` | Add `[program:metrics-exporter]` |
| `/etc/grafana/provisioning/datasources/prometheus.yml` | Create |
| `/etc/grafana/provisioning/dashboards/*.json` | Create (3 dashboards) |

---

## Out of Scope (this iteration)

- Auto-push providers.json to GitHub
- Auto-remediation of failures
- Provider-level proxy/skip flags (schema allows it, UI deferred)
- Fly.io Grafana agent (can add later once home VM is solid)
