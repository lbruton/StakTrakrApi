#!/bin/bash
# StakTrakr Home Poller — LXC run script
# Runs full Firecrawl + Playwright stack, writes to shared Turso DB.
# Auto-syncs providers.json from api branch before each run.
# Cron: 30 * * * * (runs at :30 past every hour, offset from Fly.io :00 run)

set -e

# Lockfile guard — skip if previous run is still active
LOCKFILE=/tmp/retail-poller.lock
if [ -f "$LOCKFILE" ]; then
  echo "[$(date -u +%H:%M:%S)] Previous run still active, skipping"
  exit 0
fi
touch $LOCKFILE
trap 'rm -f "$LOCKFILE"' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

DATE=$(date -u +%Y-%m-%d)
echo "[$(date -u +%H:%M:%S)] Starting home retail price run for $DATE"

# Sync providers.json from api branch — picks up URL corrections automatically
PROVIDERS_PATH="${DATA_DIR:-$SCRIPT_DIR/data}/retail/providers.json"
echo "[$(date -u +%H:%M:%S)] Syncing providers.json from api branch..."
curl -sf "https://raw.githubusercontent.com/lbruton/StakTrakrApi/api/data/retail/providers.json" \
  -o "$PROVIDERS_PATH" \
  || echo "[$(date -u +%H:%M:%S)] WARN: providers.json sync failed — using cached copy"

# Run price extraction via local Firecrawl stack
DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data}" \
POLLER_ID="${POLLER_ID:-home}" \
node "$SCRIPT_DIR/price-extract.js"

echo "[$(date -u +%H:%M:%S)] Done."
