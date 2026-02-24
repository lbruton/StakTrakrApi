# Tiered Scraper Fallback — Design Doc

**Date:** 2026-02-24
**Status:** Approved — ready for implementation
**Approach:** B (cron-based retry)

---

## Problem

The retail poller runs a single scrape cycle per hour. When individual SKUs time out or
get blocked, they produce a data gap for that window. The current FBP backfill partially
covers this within the same run, but there is no deferred retry using an alternate egress
path, and Turso last-known-good data is not surfaced for persistently-failed vendors.

---

## 4-Tier Architecture

| Tier | Method | When | Status |
|------|--------|------|--------|
| T1 | Tailscale exit node (residential IP, `100.112.198.50`) | Normal operation | **Live** |
| T2 | Fly.io datacenter IP | Tailscale unreachable | **Live** |
| T3 | Webshare proxy + cron retry at :15 | ≥1 SKU failed after T1/T2 | **To build** |
| T4 | Turso last-known-good price | T3 also failed for a vendor | **To build** |

T1 → T2 failover is automatic within `run-local.sh` (ping-check before each cycle).
T3 activates when `retail-failures.json` is present after the :00 run.
T4 activates in `api-export.js` when a vendor has no rows in the current window.

---

## Cron Rhythm (Approach B)

```
:00  run-local.sh     — main scrape; T1→T2 auto; writes /tmp/retail-failures.json on failure
:08  run-publish.sh   — export Turso → manifest.json; push api branch
:15  run-retry.sh     — NEW: no-op if no failures; else re-scrapes failed SKUs with T3 proxy
:23  run-publish.sh   — second publish picks up T3 recoveries; T4 fills remaining gaps
```

---

## Failure Detection: Systemic vs Isolated

| Condition | Signal | Response |
|-----------|--------|----------|
| ≥1 SKU failed, Tailscale healthy | `retail-failures.json` non-empty | T3 retry at :15 |
| ≥80% SKUs failed | `[WARN] SYSTEMIC` log line | T3 still fires; log for monitoring |
| T3 also fails for a SKU | vendor absent from current window | T4 fills from Turso |

The 80% threshold adds observability only — routing is unchanged. T3 handles both
isolated and systemic cases the same way.

---

## Component Changes

### 1. `price-extract.js` — failure exit signal (~10 lines)

At the end of `main()` in the `finally` block, after the existing summary log:

- If any `scrapeResults` have `ok: false` and the SKU is in-stock → write
  `/tmp/retail-failures.json` as `[{ coinSlug, providerId, url, error }]`
- If zero failures → delete `/tmp/retail-failures.json` (clears stale queue)

### 2. `run-local.sh` — systemic warning (~5 lines)

After `price-extract.js` exits, check if `retail-failures.json` exists.
Count entries; if failures > 80% of total targets, emit `[WARN] SYSTEMIC failure count`.

### 3. `run-retry.sh` — NEW T3 retry script

```bash
#!/bin/bash
# T3 retry — runs at :15 each hour, no-op if no failures from :00 run
set -e

FAILURES=/tmp/retail-failures.json
[ ! -f "$FAILURES" ] && echo "[$(date -u +%H:%M:%S)] No failures — skipping T3 retry" && exit 0

FAIL_COUNT=$(node -e "console.log(require('$FAILURES').length)")
echo "[$(date -u +%H:%M:%S)] T3 retry: $FAIL_COUNT failed SKU(s)"

# Extract unique coin slugs from failures file
COINS=$(node -e "
  const f = require('$FAILURES');
  console.log([...new Set(f.map(x => x.coinSlug))].join(','));
")

# Re-run with proxy enabled (PROXY_DISABLED unset) for failed coins only
PROXY_DISABLED="" \
COINS="$COINS" \
PATCH_GAPS=1 \
DATA_DIR="${API_EXPORT_DIR:-/data/staktrakr-api-export}/data" \
FIRECRAWL_BASE_URL="${FIRECRAWL_BASE_URL:-http://localhost:3002}" \
BROWSER_MODE=local \
node /app/price-extract.js

# Clear the queue regardless of outcome — T4 handles any remaining gaps
rm -f "$FAILURES"
echo "[$(date -u +%H:%M:%S)] T3 retry complete"
```

Webshare proxy is activated by unsetting `PROXY_DISABLED` — no `fly deploy` required.
When Webshare is over quota, the proxy calls fail gracefully and T4 handles gaps.

### 4. `api-export.js` — T4 last-known-good (~20 lines)

In the per-slug vendor loop, after `resolveVendorPrice()`:

- If `resolved.price === null` AND `resolved.inStock !== false` (not a known OOS):
  call the existing `getLastKnownPrice(db, slug, vendorId)`
- If a last-known price exists, include it in the vendor entry with:
  `stale: true`, `stale_since: <scraped_at of that row>`, `source: "turso_last_known"`
- Vendor is kept in the manifest (not deleted) when filled by T4

Frontend ignores unknown fields — `stale` flag is available for future UI use.

### 5. `supervisord.conf` — add :15 cron entry

```
15 * * * * /app/run-retry.sh >> /var/log/retail-retry.log 2>&1
```

Log rotation follows the same pattern as `retail-poller.log`.

---

## Data Flow

```
:00 price-extract.js exits
  ├─ failures = 0  → rm /tmp/retail-failures.json
  │                → :15 run-retry.sh exits immediately (no-op)
  └─ failures > 0  → write /tmp/retail-failures.json
                   → :15 run-retry.sh fires
                        ├─ T3 recovers SKU  → Turso row written → :23 publish picks up
                        └─ T3 fails for SKU → rm failures.json anyway
                                            → :23 api-export.js calls getLastKnownPrice()
                                            → manifest includes stale price with flag
```

### T4 manifest output example

```json
"herobullion": {
  "price": 34.21,
  "confidence": null,
  "source": "turso_last_known",
  "stale": true,
  "stale_since": "2026-02-24T14:00:00Z",
  "inStock": true
}
```

---

## Testing Plan

All testing via `DRY_RUN` and direct Fly SSH — no local Docker test bed required.

| Test | Command | Expected |
|------|---------|----------|
| Failure signal writes correctly | `DRY_RUN=1 COINS=herobullion node price-extract.js` | `/tmp/retail-failures.json` created with herobullion entry |
| Retry no-op when no failures | `rm /tmp/retail-failures.json && ./run-retry.sh` | Exits immediately with "No failures" log |
| Proxy path invoked (quota lapsed) | `PROXY_DISABLED= PATCH_GAPS=1 COINS=herobullion node price-extract.js` | Fails gracefully — confirms wiring before proxy topped up |
| T4 fill in api-export | `DRY_RUN=1 node api-export.js` on coin with stale vendor | manifest includes `stale: true` entry |
| Full cycle end-to-end | `fly ssh console` → inject test `retail-failures.json` → watch `:15` cron | Retry fires, clears file, publish at `:23` reflects recovery |

---

## Out of Scope

- Retry queue in Turso (Approach C) — deferred; revisit if failure rate increases
- Bright Data / proxy provider swap — credentials are env vars; swap is a secret update
- Frontend "stale price" UI indicator — `stale` field is available; UI work is separate
- Home poller retry parity — home LXC runs `run-home.sh` independently; same changes
  can be applied there in a follow-up

---

## Files Affected

All in `lbruton/StakTrakrApi` — `devops/retail-poller/`:

- `price-extract.js` — modified
- `run-local.sh` — modified
- `run-retry.sh` — new
- `api-export.js` — modified
- `supervisord.conf` — modified
