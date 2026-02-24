# Tiered Scraper Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a T3 cron-based proxy retry at :15 for failed SKUs and a T4 Turso last-known-good fill so the manifest never silently drops a vendor due to a transient scrape failure.

**Architecture:** `price-extract.js` writes `/tmp/retail-failures.json` after each run listing vendors that failed both direct scrape and FBP backfill. A new `run-retry.sh` cron at :15 reads that file, re-scrapes only those coin slugs with Webshare proxy enabled, then clears the file. `api-export.js` fills any remaining null-price in-stock vendors from Turso historical rows using the existing `getLastKnownPrice()` function instead of silently dropping them.

**Tech Stack:** Node.js ESM, Bash, Fly.io cron via `docker-entrypoint.sh`, Turso libSQL, Webshare proxy (PROXY_DISABLED env toggle)

**Design doc:** `docs/plans/2026-02-24-tiered-scraper-fallback-design.md`

---

## Task 1: Add `inStock` to `scrapeResults` push calls

`price-extract.js` needs to track `inStock` per result so the failures filter can correctly exclude OOS items from the T3 retry queue.

**Files:**
- Modify: `devops/retail-poller/price-extract.js:817` and `:851`

**Step 1: Open the file and find both push calls**

In `price-extract.js`, search for `scrapeResults.push`. There are two — one in the `try` block (~line 817) and one in the `catch` block (~line 851).

**Step 2: Add `inStock` to the try-path push**

Find (line ~817):
```js
scrapeResults.push({ coinSlug, coin, providerId: provider.id, url: provider.url, price, source, ok: price !== null, error: price === null ? "price_not_found" : null });
```

Replace with:
```js
scrapeResults.push({ coinSlug, coin, providerId: provider.id, url: provider.url, price, source, ok: price !== null, inStock, error: price === null ? "price_not_found" : null });
```

**Step 3: Add `inStock` to the catch-path push**

Find (line ~851):
```js
scrapeResults.push({ coinSlug, coin, providerId: provider.id, url: provider.url, price, source, ok: price !== null, error: price === null && inStock ? err.message.slice(0, 200) : null });
```

Replace with:
```js
scrapeResults.push({ coinSlug, coin, providerId: provider.id, url: provider.url, price, source, ok: price !== null, inStock, error: price === null && inStock ? err.message.slice(0, 200) : null });
```

**Step 4: Verify manually**

```bash
cd /Volumes/DATA/GitHub/StakTrakrApi/devops/retail-poller
grep -n "scrapeResults.push" price-extract.js
```
Expected: both lines now contain `inStock,`.

**Step 5: Commit**

```bash
git add devops/retail-poller/price-extract.js
git commit -m "feat(poller): track inStock per scrapeResult for T3 retry filter"
```

---

## Task 2: Write `retail-failures.json` after each run

After both the main scrape loop and the FBP backfill complete, write a JSON file listing vendors that failed both — these are the T3 retry candidates.

**Files:**
- Modify: `devops/retail-poller/price-extract.js` (top import + end of `main()`)

**Step 1: Add `unlinkSync` to the fs import**

Find the existing import at the top of the file:
```js
import { readFileSync, existsSync } from "node:fs";
```

Replace with:
```js
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
```

**Step 2: Add the failures.json write block**

Find this line in `main()` (after FBP backfill, ~line 930):
```js
  log(`Done: ${ok}/${scrapeResults.length} prices captured, ${fail} failures`);
```

Insert immediately after it (before the `if (ok === 0)` check):
```js
  // T3 retry queue: vendors that failed direct scrape AND FBP backfill
  // Only in-stock failures are queued — OOS is expected, not a retry candidate.
  const RETRY_FILE = '/tmp/retail-failures.json';
  const persistentFailures = scrapeResults
    .filter(r => !r.ok && r.inStock !== false)
    .filter(r => {
      const fbp = fbpFillResults[r.coinSlug];
      return !fbp || fbp[r.providerId] === undefined;
    })
    .map(r => ({ coinSlug: r.coinSlug, providerId: r.providerId, url: r.url, error: r.error }));

  if (persistentFailures.length > 0) {
    writeFileSync(RETRY_FILE, JSON.stringify(persistentFailures, null, 2));
    log(`T3 queue: ${persistentFailures.length} SKU(s) written to ${RETRY_FILE}`);
  } else {
    try { unlinkSync(RETRY_FILE); } catch { /* already absent — no-op */ }
    log('T3 queue: no persistent failures — cleared');
  }
```

**Step 3: Verify dry run writes/clears the file**

```bash
cd /Volumes/DATA/GitHub/StakTrakrApi/devops/retail-poller
DRY_RUN=1 COINS=herobullion DATA_DIR=/tmp/test-data \
  FIRECRAWL_BASE_URL=http://localhost:3002 \
  node price-extract.js 2>&1 | grep -E 'T3 queue|Done:'
```

Expected output contains `T3 queue:` line (either failures written or cleared).

Note: with `DRY_RUN=1` the Turso writes are skipped but the scrape still runs. Adjust `DATA_DIR` to a path with `retail/providers.json` if needed, or run against the real Fly env via `fly ssh console`.

**Step 4: Commit**

```bash
git add devops/retail-poller/price-extract.js
git commit -m "feat(poller): write /tmp/retail-failures.json for T3 retry queue"
```

---

## Task 3: Add systemic failure warning to `run-local.sh`

After `price-extract.js` exits, log the failure queue size and emit a `[WARN] SYSTEMIC` line if ≥80% of targets failed.

**Files:**
- Modify: `devops/retail-poller/run-local.sh`

**Step 1: Find the insertion point**

Find this line in `run-local.sh` (~line 63):
```bash
node /app/price-extract.js
```

**Step 2: Insert the failure count check immediately after**

```bash
# T3 queue status — warn if failure rate looks systemic
RETRY_FILE=/tmp/retail-failures.json
if [ -f "$RETRY_FILE" ]; then
  FAIL_COUNT=$(node -e "try { console.log(require('$RETRY_FILE').length); } catch { console.log(0); }")
  echo "[$(date -u +%H:%M:%S)] T3 queue: $FAIL_COUNT failed SKU(s) queued for retry"
  TOTAL_TARGETS=$(node -e "
    const p = JSON.parse(require('fs').readFileSync('$API_EXPORT_DIR/data/retail/providers.json','utf8'));
    let n = 0;
    for (const c of Object.values(p.coins)) n += (c.providers||[]).filter(pr=>pr.enabled&&pr.url).length;
    console.log(n);
  " 2>/dev/null || echo 0)
  if [ "$FAIL_COUNT" -gt 0 ] && [ "$TOTAL_TARGETS" -gt 0 ]; then
    PCT=$(( FAIL_COUNT * 100 / TOTAL_TARGETS ))
    if [ "$PCT" -ge 80 ]; then
      echo "[$(date -u +%H:%M:%S)] [WARN] SYSTEMIC failure: ${PCT}% of targets failed — check Tailscale + egress"
    fi
  fi
fi
```

**Step 3: Commit**

```bash
git add devops/retail-poller/run-local.sh
git commit -m "feat(poller): log T3 queue size and warn on systemic failure rate"
```

---

## Task 4: Create `run-retry.sh`

New script — T3 retry run at :15. No-op when no failures queued.

**Files:**
- Create: `devops/retail-poller/run-retry.sh`

**Step 1: Create the file**

```bash
#!/bin/bash
# StakTrakr T3 Retry — cron at :15 each hour
# Re-scrapes failed SKUs from the :00 run with Webshare proxy enabled.
# No-op if /tmp/retail-failures.json is absent.
#
# Proxy note: PROXY_DISABLED="" re-enables Webshare for the Playwright fallback
# path in price-extract.js. Webshare credentials must be present as Fly secrets:
#   WEBSHARE_PROXY_USER, WEBSHARE_PROXY_PASS
# When over quota, proxy calls fail gracefully — T4 covers remaining gaps at :23.

set -e

RETRY_FILE=/tmp/retail-failures.json
API_EXPORT_DIR="${API_EXPORT_DIR:-/data/staktrakr-api-export}"

if [ ! -f "$RETRY_FILE" ]; then
  echo "[$(date -u +%H:%M:%S)] T3 retry: no failures queued — skipping"
  exit 0
fi

FAIL_COUNT=$(node -e "try { console.log(require('$RETRY_FILE').length); } catch { console.log(0); }")
echo "[$(date -u +%H:%M:%S)] T3 retry: $FAIL_COUNT failed SKU(s)"

# Extract unique coin slugs from the retry queue
COINS=$(node -e "
  try {
    const f = JSON.parse(require('fs').readFileSync('$RETRY_FILE', 'utf8'));
    console.log([...new Set(f.map(x => x.coinSlug))].join(','));
  } catch(e) { console.error(e.message); process.exit(1); }
")

echo "[$(date -u +%H:%M:%S)] T3 retry: coins = $COINS"

# Re-scrape with proxy enabled. PROXY_DISABLED="" unsets the flag so Playwright
# fallback routes through Webshare (p.webshare.io:80) when Firecrawl fails.
PROXY_DISABLED="" \
COINS="$COINS" \
DATA_DIR="$API_EXPORT_DIR/data" \
FIRECRAWL_BASE_URL="${FIRECRAWL_BASE_URL:-http://localhost:3002}" \
BROWSER_MODE=local \
node /app/price-extract.js \
  && echo "[$(date -u +%H:%M:%S)] T3 retry: extraction complete" \
  || echo "[$(date -u +%H:%M:%S)] WARN: T3 retry had errors — T4 will fill gaps at :23 publish"

# Always clear the queue — T4 handles any remaining gaps at the :23 publish run
rm -f "$RETRY_FILE"
echo "[$(date -u +%H:%M:%S)] T3 retry: queue cleared"
```

**Step 2: Make executable**

```bash
chmod +x devops/retail-poller/run-retry.sh
```

**Step 3: Test the no-op path locally**

```bash
rm -f /tmp/retail-failures.json
bash devops/retail-poller/run-retry.sh
```

Expected:
```
[HH:MM:SS] T3 retry: no failures queued — skipping
```

**Step 4: Test with a synthetic failures file**

```bash
echo '[{"coinSlug":"silver-1oz","providerId":"herobullion","url":"https://example.com","error":"timeout"}]' \
  > /tmp/retail-failures.json
# inspect what COINS would be extracted:
node -e "
  const f = JSON.parse(require('fs').readFileSync('/tmp/retail-failures.json','utf8'));
  console.log([...new Set(f.map(x=>x.coinSlug))].join(','));
"
```

Expected: `silver-1oz`

**Step 5: Commit**

```bash
git add devops/retail-poller/run-retry.sh
git commit -m "feat(poller): add run-retry.sh — T3 proxy retry cron at :15"
```

---

## Task 5: Wire `run-retry.sh` into Dockerfile + entrypoint

Two places: Dockerfile COPY/chmod and `docker-entrypoint.sh` crontab.

**Files:**
- Modify: `devops/retail-poller/Dockerfile:106-107`
- Modify: `devops/retail-poller/docker-entrypoint.sh:54-59` and `:66-67`

**Step 1: Add `run-retry.sh` to Dockerfile COPY line**

Find (line ~106):
```dockerfile
COPY run-local.sh run-fbp.sh run-goldback.sh run-spot.sh run-publish.sh ./
RUN chmod +x run-local.sh run-fbp.sh run-goldback.sh run-spot.sh run-publish.sh
```

Replace with:
```dockerfile
COPY run-local.sh run-fbp.sh run-goldback.sh run-spot.sh run-publish.sh run-retry.sh ./
RUN chmod +x run-local.sh run-fbp.sh run-goldback.sh run-spot.sh run-publish.sh run-retry.sh
```

**Step 2: Add `:15` cron entry to `docker-entrypoint.sh`**

Find the crontab block (line ~54):
```bash
(echo "${CRON_SCHEDULE} * * * * root . /etc/environment; /app/run-local.sh >> /var/log/retail-poller.log 2>&1"; \
 echo "5,20,35,50 * * * * root . /etc/environment; /app/run-spot.sh >> /var/log/spot-poller.log 2>&1"; \
 echo "8,23,38,53 * * * * root . /etc/environment; /app/run-publish.sh >> /var/log/publish.log 2>&1"; \
 echo "0 20 * * * root . /etc/environment; /app/run-fbp.sh >> /var/log/retail-poller.log 2>&1"; \
 echo "1 17 * * * root . /etc/environment; /app/run-goldback.sh >> /var/log/goldback-poller.log 2>&1") \
  > /etc/cron.d/retail-poller
```

Replace with:
```bash
(echo "${CRON_SCHEDULE} * * * * root . /etc/environment; /app/run-local.sh >> /var/log/retail-poller.log 2>&1"; \
 echo "5,20,35,50 * * * * root . /etc/environment; /app/run-spot.sh >> /var/log/spot-poller.log 2>&1"; \
 echo "8,23,38,53 * * * * root . /etc/environment; /app/run-publish.sh >> /var/log/publish.log 2>&1"; \
 echo "15 * * * * root . /etc/environment; /app/run-retry.sh >> /var/log/retail-retry.log 2>&1"; \
 echo "0 20 * * * root . /etc/environment; /app/run-fbp.sh >> /var/log/retail-poller.log 2>&1"; \
 echo "1 17 * * * root . /etc/environment; /app/run-goldback.sh >> /var/log/goldback-poller.log 2>&1") \
  > /etc/cron.d/retail-poller
```

**Step 3: Add `retail-retry.log` to the touch command**

Find (line ~66):
```bash
touch /var/log/retail-poller.log /var/log/goldback-poller.log /var/log/http-server.log \
      /var/log/spot-poller.log /var/log/publish.log
```

Replace with:
```bash
touch /var/log/retail-poller.log /var/log/goldback-poller.log /var/log/http-server.log \
      /var/log/spot-poller.log /var/log/publish.log /var/log/retail-retry.log
```

**Step 4: Commit**

```bash
git add devops/retail-poller/Dockerfile devops/retail-poller/docker-entrypoint.sh
git commit -m "feat(poller): wire run-retry.sh into Dockerfile and entrypoint crontab"
```

---

## Task 6: T4 last-known-good fill in `api-export.js`

When `resolveVendorPrice()` returns `price: null` for an in-stock vendor, call `getLastKnownPrice()` (already defined in this file at line ~229) instead of deleting the vendor from the manifest.

**Files:**
- Modify: `devops/retail-poller/api-export.js:621-633`

**Step 1: Find the vendor deletion block**

Locate this block (~line 621):
```js
  // Remove vendors where resolveVendorPrice found no price from either source
  for (const vendorId of Object.keys(vendors)) {
    if (vendors[vendorId].price === null) {
      delete vendors[vendorId];
    }
  }
```

**Step 2: Replace with T4 fill logic**

```js
  // Remove vendors where no price found; for in-stock failures, fill from Turso last-known (T4)
  for (const vendorId of Object.keys(vendors)) {
    if (vendors[vendorId].price === null) {
      const isOos = availabilityBySite[vendorId] === false;
      if (!isOos) {
        // T4: use most recent in-stock price from Turso history
        const lastKnown = getLastKnownPrice(db, slug, vendorId);
        if (lastKnown) {
          vendors[vendorId] = {
            price:      Math.round(lastKnown.price * 100) / 100,
            confidence: null,
            source:     "turso_last_known",
            inStock:    true,
            stale:      true,
            stale_since: lastKnown.date,
          };
        } else {
          delete vendors[vendorId];
        }
      } else {
        delete vendors[vendorId];
      }
    }
  }
```

**Step 3: Verify with dry run**

```bash
cd /Volumes/DATA/GitHub/StakTrakrApi/devops/retail-poller
DRY_RUN=1 node api-export.js 2>&1 | tail -20
```

Expected: runs without error. If a vendor has stale data, it now logs `Wrote ...` for files it previously would have silently omitted that vendor from.

To force a T4 hit for testing, temporarily pass a coin slug where a vendor had a recent failure. Or inspect Turso directly:

```bash
# Check what getLastKnownPrice would return for a vendor:
node -e "
  import('./db.js').then(async ({openTursoDb}) => {
    const db = await openTursoDb();
    const r = await db.execute({
      sql: 'SELECT price, date(scraped_at) as date FROM price_snapshots WHERE coin_slug=? AND vendor=? AND in_stock=1 AND price IS NOT NULL ORDER BY scraped_at DESC LIMIT 1',
      args: ['silver-1oz','herobullion']
    });
    console.log(r.rows);
    db.close();
  });
"
```

**Step 4: Commit**

```bash
git add devops/retail-poller/api-export.js
git commit -m "feat(poller): T4 fill — use Turso last-known-good for failed in-stock vendors"
```

---

## Task 7: Deploy and verify first cycle

**Step 1: Deploy to Fly.io**

```bash
cd /Volumes/DATA/GitHub/StakTrakrApi/devops/retail-poller
fly deploy
```

Expected: build completes, machine restarts, supervisord starts all services.

**Step 2: Verify crontab has the :15 entry**

```bash
fly ssh console --app staktrakr -C "cat /etc/cron.d/retail-poller"
```

Expected: output includes `15 * * * * root . /etc/environment; /app/run-retry.sh ...`

**Step 3: Verify log file created**

```bash
fly ssh console --app staktrakr -C "ls -la /var/log/retail-retry.log"
```

Expected: file exists (may be empty before first :15 fires).

**Step 4: Manually inject a test failure and trigger retry**

```bash
fly ssh console --app staktrakr -C "bash -c \"
  echo '[{\\\"coinSlug\\\":\\\"silver-1oz\\\",\\\"providerId\\\":\\\"herobullion\\\",\\\"url\\\":\\\"https://www.herobullion.com/1-oz-silver-round-any-mint-any-condition/\\\",\\\"error\\\":\\\"test\\\"}]' > /tmp/retail-failures.json
  /app/run-retry.sh
\""
```

Expected log output:
```
[HH:MM:SS] T3 retry: 1 failed SKU(s)
[HH:MM:SS] T3 retry: coins = silver-1oz
[HH:MM:SS] T3 retry: extraction complete   ← or WARN if proxy quota lapsed
[HH:MM:SS] T3 retry: queue cleared
```

**Step 5: Watch first real :00 → :15 cycle**

```bash
fly logs --app staktrakr | grep -E 'T3 queue|T3 retry|SYSTEMIC|retail-poller'
```

At :00 — look for `T3 queue: N failed SKU(s)` or `T3 queue: no persistent failures`.
At :15 — look for `T3 retry: ...` or `T3 retry: no failures queued — skipping`.

**Step 6: Commit wiki update**

Update `StakTrakrWiki/fly-container.md` — the Cron Schedule table now has a `:15` entry:

| Schedule | Script | Log |
|---|---|---|
| `15 * * * *` | `/app/run-retry.sh` | `/var/log/retail-retry.log` |

```bash
cd /Volumes/DATA/GitHub/StakTrakrWiki
# edit fly-container.md to add the :15 row to the Cron Schedule table
git add fly-container.md
git commit -m "docs: add :15 T3 retry cron entry to fly-container.md"
git push origin main
```

---

## Summary of files changed

| File | Change |
|------|--------|
| `devops/retail-poller/price-extract.js` | Add `inStock` to `scrapeResults.push`; add `unlinkSync` import; write `retail-failures.json` after run |
| `devops/retail-poller/run-local.sh` | Log T3 queue size + systemic warning |
| `devops/retail-poller/run-retry.sh` | **New** — T3 proxy retry script |
| `devops/retail-poller/Dockerfile` | Add `run-retry.sh` to COPY + chmod |
| `devops/retail-poller/docker-entrypoint.sh` | Add `:15` cron + `retail-retry.log` touch |
| `devops/retail-poller/api-export.js` | T4 fill with `getLastKnownPrice()` for in-stock failures |
| `StakTrakrWiki/fly-container.md` | Add `:15` row to cron schedule table |
