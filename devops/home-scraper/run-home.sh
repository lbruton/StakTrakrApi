#!/bin/bash
# StakTrakr Home Poller — LXC run script
# Runs full Firecrawl + Playwright stack, writes to shared Turso DB.
# Reads provider config from Turso DB (STAK-348).
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

# providers.json is now read from Turso at runtime (STAK-348)
# File sync removed — pollers query provider_coins + provider_vendors tables directly
echo "[$(date -u +%H:%M:%S)] Providers loaded from Turso (file sync removed)"

# Run price extraction via local Firecrawl stack
DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data}" \
POLLER_ID="${POLLER_ID:-home}" \
node "$SCRIPT_DIR/price-extract.js"

echo "[$(date -u +%H:%M:%S)] Done."
