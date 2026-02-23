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

# Run Firecrawl extraction (with Playwright fallback) — writes results to SQLite
echo "[$(date -u +%H:%M:%S)] Running price extraction..."
DATA_DIR="$API_EXPORT_DIR/data" \
FIRECRAWL_BASE_URL="${FIRECRAWL_BASE_URL:-http://firecrawl:3002}" \
BROWSERLESS_URL="${BROWSERLESS_URL:-}" \
BROWSER_MODE=local \
node /app/price-extract.js

# Vision pipeline — non-fatal, requires GEMINI_API_KEY + BROWSERLESS_URL
if [ -n "${GEMINI_API_KEY:-}" ] && [ -n "${BROWSERLESS_URL:-}" ]; then
  _ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/retail-screenshots/$(date -u +%Y-%m-%d)}"
  echo "[$(date -u +%H:%M:%S)] Running vision capture..."
  BROWSER_MODE=browserless \
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
  echo "[$(date -u +%H:%M:%S)] Skipping vision pipeline (GEMINI_API_KEY or BROWSERLESS_URL not set)"
fi

# Export REST API JSON endpoints from SQLite
echo "[$(date -u +%H:%M:%S)] Exporting REST API JSON..."
DATA_DIR="$API_EXPORT_DIR/data" \
node /app/api-export.js

# Stage updated data — run-publish.sh will commit and push on its own cadence
cd "$API_EXPORT_DIR"
git add data/api/ data/retail/ 2>/dev/null || git add data/api/
echo "[$(date -u +%H:%M:%S)] Data staged. run-publish.sh will push on next cycle."

echo "[$(date -u +%H:%M:%S)] Done."
