#!/bin/bash
# StakTrakr Spot Price Poller — single-shot cron wrapper
# Runs poller.py --once against the persistent volume data directory.
# Cron: 5,20,35,50 * * * *  (4x/hr, offset from retail at */15)

set -e

DATA_DIR="/data/staktrakr-api-export/data"
POLLER_DIR="/app/spot-poller"

if [ ! -d "$DATA_DIR" ]; then
  echo "[$(date -u +%H:%M:%S)] ERROR: DATA_DIR $DATA_DIR not found — is volume mounted?"
  exit 1
fi

if [ -z "${METAL_PRICE_API_KEY:-}" ]; then
  echo "[$(date -u +%H:%M:%S)] ERROR: METAL_PRICE_API_KEY not set"
  exit 1
fi

echo "[$(date -u +%H:%M:%S)] Starting spot price poll..."
METAL_PRICE_API_KEY="$METAL_PRICE_API_KEY" \
  DATA_DIR="$DATA_DIR" \
  python3 "$POLLER_DIR/poller.py" --once

echo "[$(date -u +%H:%M:%S)] Spot poll complete."
