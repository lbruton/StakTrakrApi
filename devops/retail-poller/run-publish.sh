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

if git diff --cached --quiet; then
  echo "[$(date -u +%H:%M:%S)] Nothing to publish — data unchanged since last push."
  exit 0
fi

# Build a meaningful commit message
RETAIL_TS=$(jq -r '.generated_at // "unknown"' data/api/manifest.json 2>/dev/null || echo "unknown")
DATE=$(date -u +%Y-%m-%dT%H:%MZ)

git commit -m "publish: ${DATE} | retail=${RETAIL_TS}"

# Force-push to api branch — sole writer, no merge conflicts.
# IMPORTANT: push to api, NOT main. main holds devops code.
git push --force "$REMOTE" HEAD:api

echo "[$(date -u +%H:%M:%S)] Published to api. Retail ts: ${RETAIL_TS}"
