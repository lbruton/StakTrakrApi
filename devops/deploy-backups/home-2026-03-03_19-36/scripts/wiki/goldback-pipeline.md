# Goldback Pipeline

> **Last verified:** 2026-02-25
> ⚠️ **STATUS: NOT YET IMPLEMENTED** — See STAK-331

---

## Current State (as of 2026-02-25)

Goldback pricing is **not yet operational**. The following are known gaps tracked in **STAK-331 (Urgent)**:

1. **No goldback entries in `providers.json`** — neither `goldback-g1` nor any denomination (g1–g50) exists in the `api` branch or `main` branch of StakTrakrApi.
2. **No `goldback-spot.json` endpoint** — this file does not exist and is not being generated.
3. **`goldback-scraper.js` and `run-goldback.sh` are deprecated** legacy files — they are not cron'd on any poller and should not be re-enabled.

---

## Planned Architecture (pending STAK-331)

All 5 Goldback denominations will be added to `providers.json` as standard retail coin entries:

| Coin slug | Name | Gold content |
|-----------|------|-------------|
| `goldback-1` | Goldback 1 | 1/1000 troy oz |
| `goldback-5` | Goldback 5 | 5/1000 troy oz |
| `goldback-10` | Goldback 10 | 10/1000 troy oz |
| `goldback-25` | Goldback 25 | 25/1000 troy oz |
| `goldback-50` | Goldback 50 | 50/1000 troy oz |

- **Metal:** `gold`, **Type:** `aurum`
- **Primary provider:** `goldback.com` — all denominations are on the same table/page, scraped once
- All 5 denominations can be derived programmatically from the G1 price (×5, ×10, ×25, ×50)
- Additional retail providers (JM Bullion, APMEX, etc.) to be added where they carry Goldbacks

Once implemented, scraping will follow the standard retail pipeline — no separate cron, no special handling. `api-export.js` will generate denomination-specific endpoints from Turso rows.

---

## Legacy Files (do not use)

`run-goldback.sh` and `goldback-scraper.js` exist in the repo and on both pollers at `/opt/poller/`. They are **not wired into any cron** and must not be re-enabled. They scraped `goldback.com/goldback-value/` (old rate page, now defunct).

The daily goldback cron (`1 17 * * *`) was removed from `docker-entrypoint.sh` in Feb 2026.

---

## Blockers

- **STAK-331 (Urgent):** Add goldback to providers.json, implement scraper support for goldback.com table format, deprecate legacy files, backfill Turso.
