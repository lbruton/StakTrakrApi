# Fly.io Pre-Deploy Audit — API-5 (Per-Vendor Scraper Routing)

**Date:** 2026-03-03T18:40Z
**PR:** #33 (fix/api5-vendor-routing → main)
**Machine:** 2865339f5d5718 (v103, dfw, started 2026-03-03T01:25:29Z)

## Running State

| Service | PID | Status | Notes |
|---------|-----|--------|-------|
| supervisord | 730 | Running | Manages all services |
| tailscaled | 758 | Running | Mesh connectivity to home tinyproxy |
| redis | 763 | Running | 127.0.0.1:6379 |
| rabbitmq | 762 | Running | Firecrawl queue backend |
| postgres | 760 | Running | PostgreSQL 17, pg_cron |
| playwright-service | 764 | Running | Port 3003, stealth Chromium via proxy |
| firecrawl-api | 765 | Running | Port 3002 (self-hosted) |
| firecrawl-worker | 1162 | Running | Queue worker |
| firecrawl-extract | 1178 | Running | Extract worker |
| chromium | 1036 | Running | Headless shell for Playwright |
| cron | 770 | Running | 5 cron jobs |
| http-server (serve.js) | 771 | Running | Port 8080 |

## Cron Schedule (active at time of audit)

```
0 * * * *       run-local.sh      → retail-poller.log    (retail prices)
0,30 * * * *    run-spot.sh       → spot-poller.log      (spot prices)
8,23,38,53 * * * *  run-publish.sh → publish.log         (export + push to api branch)
15 * * * *      run-retry.sh      → retail-retry.log     (T3 retry failed SKUs)
1 * * * *       run-goldback.sh   → goldback-poller.log  (goldback daily rate)
```

## Fly.io Config (fly.toml)

- **App:** staktrakr
- **Region:** iad (primary), dfw (running)
- **VM:** 8 shared CPUs, 4096 MB RAM
- **Mount:** staktrakr_data → /data
- **Env vars:** PLAYWRIGHT_LAUNCH=1, FIRECRAWL_BASE_URL=http://localhost:3002, POLLER_ID=api

## File Checksums (pre-deploy)

```
d5a7307c59933f891e881f5378ae874a  /app/price-extract.js     ← THIS CHANGES
21123ac6b0480cb12772fd493bb79aa7  /app/run-local.sh
e30ed9dd0896fe177b4cd61d72f98c04  /app/run-spot.sh
6729cf805618c7a01cbcf5fdf6e4d000  /app/run-publish.sh
8d2311b4a78733bff916af001842c42b  /app/run-retry.sh
49bba88854cb03630d6e5297d67ae521  /app/run-goldback.sh
4fee9bf53aa81357e396b0a5ed0a0e61  /app/serve.js
7f1caadb6dd30778c1a3e066e9e458d2  /app/db.js
79853e5bddb2e90235cccbbe194baa92  /app/provider-db.js
87da3f38cdb308fb90ae8d038688e5b2  /app/spot-extract.js
2e244738cd0d4e61ee2172260d98b3ea  /app/api-export.js
7750fc775068f37dc7dae9676862def2  /app/goldback-scraper.js
8f6c572e2479d99949d294d34d78b402  /app/docker-entrypoint.sh
```

## What Changes in This Deploy

**Only file affected:** `price-extract.js`

1. **New constant:** `FIRECRAWL_PREFERRED_PROVIDERS = new Set(["apmex", "monumentmetals", "jmbullion", "bullionexchanges"])`
2. **Phase 0 guard:** adds `!FIRECRAWL_PREFERRED_PROVIDERS.has(provider.id)` check
3. **extractPrice() return shape:** `number|null` → `{price, matchedBy}|null`
4. **Diagnostic logging:** `extractPrice <vendor>: matched=<fn> price=$XX.XX` at all call sites
5. **Stale comment updates** (2 comments corrected per Copilot review)

## Rollback Plan

If prices regress after deploy:

1. **Quick:** `fly deploy --image staktrakr:deployment-01KJRMN3Y1GKJFDW19PA4TKJR1` (redeploy current v103 image)
2. **Git revert:** revert PR #33 on main, push, redeploy
3. **Nuclear:** empty `FIRECRAWL_PREFERRED_PROVIDERS` Set → all vendors back to Phase 0 first
