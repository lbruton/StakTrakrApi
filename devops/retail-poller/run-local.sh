#!/bin/bash
# StakTrakr Retail Poller — local Docker run script
# Runs Firecrawl extraction (+ Playwright fallback), writes to SQLite,
# exports REST API JSON, and pushes to data branch.

set -e

# Lockfile guard — skip if previous run is still active
LOCKFILE=/tmp/retail-poller.lock
if [ -f "$LOCKFILE" ]; then
  echo "[$(date -u +%H:%M:%S)] Previous run still active, skipping"
  exit 0
fi
touch $LOCKFILE

DATE=$(date -u +%Y-%m-%d)
echo "[$(date -u +%H:%M:%S)] Starting retail price run for $DATE"

# Prune price log files older than 30 days (non-fatal)
if [ -n "${PRICE_LOG_DIR:-}" ]; then
  find "$PRICE_LOG_DIR" -name "prices-*.jsonl" -mtime +30 -delete 2>/dev/null || true
fi

# StakTrakrApi repo configuration
POLLER_ID="${POLLER_ID:-api}"

# GITHUB_TOKEN used by run-publish.sh for pushing; not required here

# Use the persistent volume clone — no temp dir, no clone overhead
API_EXPORT_DIR="${API_EXPORT_DIR:-/data/staktrakr-api-export}"
trap 'rm -f "$LOCKFILE"' EXIT

if [ ! -d "$API_EXPORT_DIR/.git" ]; then
  echo "[$(date -u +%H:%M:%S)] ERROR: $API_EXPORT_DIR is not a git repo. Is volume mounted?"
  exit 1
fi
cd "$API_EXPORT_DIR"

# Sync providers.json from api branch — picks up URL corrections without a redeploy
echo "[$(date -u +%H:%M:%S)] Syncing providers.json from api branch..."
curl -sf "https://raw.githubusercontent.com/lbruton/StakTrakrApi/api/data/retail/providers.json" \
  -o "$API_EXPORT_DIR/data/retail/providers.json" \
  || echo "[$(date -u +%H:%M:%S)] WARN: providers.json sync failed — using cached copy"

# Tailscale exit node — dynamically route through home residential IP if reachable,
# fall back to Fly datacenter IP so scraping continues when home is offline.
TS_SOCKET=/var/run/tailscale/tailscale.sock
TS_EXIT_NODE="${TS_EXIT_NODE:-100.112.198.50}"
if [ -S "$TS_SOCKET" ] && tailscale --socket="$TS_SOCKET" ping -c 1 --timeout=3s "$TS_EXIT_NODE" &>/dev/null; then
  echo "[$(date -u +%H:%M:%S)] Exit node reachable — routing via home IP ($TS_EXIT_NODE)"
  tailscale --socket="$TS_SOCKET" set --exit-node="$TS_EXIT_NODE" 2>/dev/null || true
else
  echo "[$(date -u +%H:%M:%S)] Exit node unreachable or Tailscale not running — using Fly datacenter IP"
  tailscale --socket="$TS_SOCKET" set --exit-node= 2>/dev/null || true
fi

# Run Firecrawl extraction (with Playwright fallback) — writes results to SQLite
echo "[$(date -u +%H:%M:%S)] Running price extraction..."
DATA_DIR="$API_EXPORT_DIR/data" \
FIRECRAWL_BASE_URL="${FIRECRAWL_BASE_URL:-http://firecrawl:3002}" \
BROWSERLESS_URL="${BROWSERLESS_URL:-}" \
BROWSER_MODE=local \
node /app/price-extract.js
# T3 queue status — log failure count, warn if rate looks systemic
RETRY_FILE=/tmp/retail-failures.json
if [ -f "$RETRY_FILE" ]; then
  FAIL_COUNT=$(node -e "try { console.log(require('$RETRY_FILE').length); } catch { console.log(0); }")
  echo "[$(date -u +%H:%M:%S)] T3 queue: $FAIL_COUNT failed SKU(s) queued for retry"
  TOTAL_TARGETS=$(node -e "
    try {
      const p = JSON.parse(require('fs').readFileSync('$API_EXPORT_DIR/data/retail/providers.json','utf8'));
      let n = 0;
      for (const c of Object.values(p.coins)) n += (c.providers||[]).filter(pr=>pr.enabled&&pr.url).length;
      console.log(n);
    } catch { console.log(0); }
  ")
  if [ "$FAIL_COUNT" -gt 0 ] && [ "$TOTAL_TARGETS" -gt 0 ]; then
    PCT=$(( FAIL_COUNT * 100 / TOTAL_TARGETS ))
    if [ "$PCT" -ge 80 ]; then
      echo "[$(date -u +%H:%M:%S)] [WARN] SYSTEMIC failure: ${PCT}% of targets failed — check Tailscale + egress"
    fi
  fi
fi

# Vision pipeline — non-fatal, requires GEMINI_API_KEY (uses local Chromium)
if [ -n "${GEMINI_API_KEY:-}" ]; then
  _ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/retail-screenshots/$(date -u +%Y-%m-%d)}"
  echo "[$(date -u +%H:%M:%S)] Running vision capture..."
  BROWSER_MODE=local \
    ARTIFACT_DIR="$_ARTIFACT_DIR" \
    DATA_DIR="$API_EXPORT_DIR/data" \
    node /app/capture.js \
    || echo "[$(date -u +%H:%M:%S)] WARN: vision capture failed (non-fatal)"

  echo "[$(date -u +%H:%M:%S)] Running vision extraction..."
  MANIFEST_PATH="$_ARTIFACT_DIR/manifest.json" \
    ARTIFACT_DIR="$_ARTIFACT_DIR" \
    DATA_DIR="$API_EXPORT_DIR/data" \
    node /app/extract-vision.js \
    || echo "[$(date -u +%H:%M:%S)] WARN: vision extraction failed (non-fatal)"
else
  echo "[$(date -u +%H:%M:%S)] Skipping vision pipeline (GEMINI_API_KEY not set)"
fi

# Scrape complete — run-publish.sh handles export + push on its own cadence
echo "[$(date -u +%H:%M:%S)] Scrape done. run-publish.sh will export and push on next cycle."
