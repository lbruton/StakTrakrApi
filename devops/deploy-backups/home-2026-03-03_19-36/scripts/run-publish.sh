#!/bin/bash
# StakTrakr Publisher — commits volume data and force-pushes to api branch
# GitHub Pages serves the api branch. main holds devops code — never overwrite it.
# Single writer. No merge conflicts possible.
# Cron: 8,23,38,53 * * * *  (4x/hr, runs ~3 min after spot poll completes)

set -e

REPO_DIR="/data/staktrakr-api-export"
REMOTE="https://${GITHUB_TOKEN}@github.com/lbruton/StakTrakrApi.git"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[$(date -u +%H:%M:%S)] ERROR: $REPO_DIR is not a git repo."
  exit 1
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "[$(date -u +%H:%M:%S)] ERROR: GITHUB_TOKEN not set"
  exit 1
fi

cd "$REPO_DIR"

# Stage all data changes (retail, spot hourly, goldback)
git add data/

HAS_STAGED=false
HAS_UNPUSHED=false
git diff --cached --quiet || HAS_STAGED=true
git fetch origin api --quiet 2>/dev/null && \
  [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/api)" ] && HAS_UNPUSHED=true || true

if ! $HAS_STAGED && ! $HAS_UNPUSHED; then
  echo "[$(date -u +%H:%M:%S)] Nothing to publish — no staged changes and no unpushed commits."
  exit 0
fi

if $HAS_STAGED; then
  # Build a meaningful commit message
  RETAIL_TS=$(jq -r '.generated_at // "unknown"' data/api/manifest.json 2>/dev/null || echo "unknown")
  DATE=$(date -u +%Y-%m-%dT%H:%MZ)
  git commit -m "publish: ${DATE} | retail=${RETAIL_TS}"
fi

# Force-push to api branch — sole writer, no merge conflicts.
# IMPORTANT: push to api, NOT main. main holds devops code.
git push --force "$REMOTE" HEAD:api

RETAIL_TS=$(jq -r '.generated_at // "unknown"' data/api/manifest.json 2>/dev/null || echo "unknown")
echo "[$(date -u +%H:%M:%S)] Published to api. Retail ts: ${RETAIL_TS}"
