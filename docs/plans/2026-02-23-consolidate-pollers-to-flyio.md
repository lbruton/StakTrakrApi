# Consolidate Pollers to Fly.io — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move spot price polling from GitHub Actions into the Fly.io container so a single cron-driven process owns all data writes, then publish the full data directory to GitHub Pages every 15 min via one clean, conflict-free GHA push.

**Architecture:** The Fly.io container becomes the single writer for all data (`data/api/`, `data/hourly/`). It writes directly to the persistent volume at `/data/staktrakr-api-export/data/`. A new `run-spot.sh` runs `poller.py --once` on a 15-min cron. A new `run-publish.sh` commits and force-pushes the full data directory from the volume to the `main` branch every 15 min. GitHub Actions `spot-poller.yml` is retired; `merge-poller-branches.yml` is replaced by a minimal `publish-trigger.yml` that simply invokes the Fly.io publish over SSH (or alternatively the publish script runs as a cron inside the container — see T5).

**Key insight:** The persistent volume already contains a full git clone of StakTrakrApi with both `api` and `main` branches tracked. `run-local.sh` currently clones fresh to a temp dir each run — we will change it to write directly to the volume clone and push from there. This eliminates temp clones, reduces clone overhead, and makes both retail and spot data land in the same persistent working tree.

**Tech Stack:** Python 3.11 (already in container), `requests` + `python-dotenv` pip packages, bash cron scripts, supervisord, git, GitHub Actions (minimal).

**File Touch Map:**

| Action | File | Scope |
|--------|------|-------|
| MODIFY | `devops/retail-poller/Dockerfile` | Add `pip3 install` step + copy spot-poller files |
| MODIFY | `devops/retail-poller/docker-entrypoint.sh` | Add `run-spot.sh` to cron schedule |
| MODIFY | `devops/retail-poller/run-local.sh` | Write to volume path instead of temp dir; no git push (publish handles it) |
| CREATE | `devops/retail-poller/run-spot.sh` | Runs `poller.py --once` against volume data dir |
| CREATE | `devops/retail-poller/run-publish.sh` | Commits + force-pushes volume data to `main` branch |
| MODIFY | `.github/workflows/spot-poller.yml` | Retire: replace body with a single `workflow_dispatch` no-op |
| MODIFY | `.github/workflows/merge-poller-branches.yml` | Retire: replace with minimal `publish-to-pages.yml` rename + simplify |
| MODIFY | `devops/retail-poller/supervisord.conf` | No change needed — cron daemon already running |

---

## Volume State Reference

```
/data/staktrakr-api-export/         ← Fly.io persistent volume (staktrakr_data)
  .git/                             ← git clone; remote = github.com/lbruton/StakTrakrApi
                                       branches: api (current), main tracked
  data/
    api/                            ← retail prices (written by run-local.sh)
    hourly/YYYY/MM/DD/HH.json       ← spot prices (currently frozen at clone time)
    retail/                         ← providers.json etc.
```

The volume clone is currently on the `api` branch. For publishing we will switch to push a merged commit to `main` directly (without switching branches — using `git push origin HEAD:main`).

---

## Task Table

| ID | Step | Est (min) | Files | Validation | Risk/Notes | Agent |
|----|------|-----------|-------|------------|------------|-------|
| T1 | Add spot-poller deps to Dockerfile | 5 | `Dockerfile` | `docker build` succeeds | `requests` not yet installed in container | Claude |
| T2 | Create `run-spot.sh` | 5 | `run-spot.sh` | Script runs locally with `--dry-run`-style check | Must set `DATA_DIR` to volume path | Claude |
| T3 | Modify `run-local.sh` — write to volume, remove push | 10 | `run-local.sh` | No temp dir created; data written to `/data/staktrakr-api-export/data/` | Biggest behavioral change; lockfile path unchanged | Claude |
| T4 | Create `run-publish.sh` | 10 | `run-publish.sh` | Dry-run: shows `git diff --stat` output | Force-push to main; must handle "nothing to commit" gracefully | Claude |
| T5 | Wire both scripts into cron via entrypoint | 5 | `docker-entrypoint.sh` | Cron file contains spot + publish entries | Spot 4×/hr; publish every 15 min; stagger vs retail | Claude |
| T6 | Copy spot-poller source files in Dockerfile | 3 | `Dockerfile` | Build copies files to `/app/spot-poller/` | Needs `update-seed-data.py` too (imported by poller.py) | Claude |
| T7 | Retire spot-poller GHA workflow | 3 | `spot-poller.yml` | Workflow no longer runs on schedule | Leave `workflow_dispatch` for manual recovery | Claude |
| T8 | Retire merge-poller-branches GHA workflow | 5 | `merge-poller-branches.yml` | Workflow no longer runs on schedule | Leave `workflow_dispatch` for manual recovery | Claude |
| T9 | Add `METAL_PRICE_API_KEY` secret to Fly.io | 2 | — (Fly.io secrets) | `fly secrets list` shows key | Human action | Human |
| T10 | Deploy to Fly.io | 3 | — | `fly deploy` succeeds | Rebuilds image | Human |
| T11 | Smoke test — watch first publish cycle | 5 | — | `fly logs` shows spot poll + publish; `api.staktrakr.com/data/hourly/` returns fresh data | First spot poll + publish takes ~16 min | Human |
| T12 | Commit design doc + all changes | 2 | all modified files | `git log` shows commit | — | Claude |

---

## Task Details

### T1: Add spot-poller pip deps to Dockerfile ← NEXT

**Files:**
- Modify: `devops/retail-poller/Dockerfile` (after the `npm install` step, ~line 89)

The container has Python 3.11.2 but `requests` and `python-dotenv` are not installed. Add a pip install step.

**Step 1: Edit Dockerfile — add pip install after npm install**

Find the block:
```dockerfile
COPY package.json ./
RUN npm install --omit=dev
```

Add immediately after it:
```dockerfile
# Spot-poller Python deps
RUN pip3 install --no-cache-dir requests>=2.31.0 python-dotenv>=1.0.0
```

**Step 2: Verify the edit looks correct**

```bash
grep -A2 -B2 "pip3 install" devops/retail-poller/Dockerfile
```
Expected: shows the pip3 line sandwiched between npm and the COPY *.js line.

**Step 3: Commit**

```bash
git add devops/retail-poller/Dockerfile
git commit -m "build: add spot-poller python deps to Dockerfile"
```

---

### T2: Create `run-spot.sh`

**Files:**
- Create: `devops/retail-poller/run-spot.sh`

This script runs the spot poller in single-shot mode against the persistent volume data directory.

**Step 1: Create the script**

```bash
cat > devops/retail-poller/run-spot.sh << 'EOF'
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
EOF
chmod +x devops/retail-poller/run-spot.sh
```

**Step 2: Verify**

```bash
head -5 devops/retail-poller/run-spot.sh && ls -la devops/retail-poller/run-spot.sh
```
Expected: first line is `#!/bin/bash`; file is executable.

**Step 3: Commit**

```bash
git add devops/retail-poller/run-spot.sh
git commit -m "feat: add run-spot.sh — spot price poller cron wrapper for Fly.io"
```

---

### T3: Modify `run-local.sh` — write to volume, remove git push

**Files:**
- Modify: `devops/retail-poller/run-local.sh`

**Current behavior:** Clones fresh to a `mktemp` dir each run, writes data there, commits and pushes to the `api` branch, then deletes the temp dir.

**New behavior:** Writes directly to `/data/staktrakr-api-export` (the persistent volume clone). No git push — `run-publish.sh` handles that on its own cadence. Lockfile and extraction logic unchanged.

**Step 1: Read the current file to understand the full structure**

```bash
cat devops/retail-poller/run-local.sh
```

**Step 2: Replace the clone + API_EXPORT_DIR block**

Old block (lines ~32-44):
```bash
# Clone fresh into a temp dir each run — stateless, no persistent git state to corrupt
API_EXPORT_DIR=$(mktemp -d /tmp/staktrakr-push-XXXXXX)
trap 'rm -f "$LOCKFILE"; rm -rf "$API_EXPORT_DIR"' EXIT
echo "[$(date -u +%H:%M:%S)] Cloning StakTrakrApi repo (shallow)..."
git clone --depth=1 --branch "$POLLER_ID" \
  "https://${GITHUB_TOKEN}@github.com/lbruton/StakTrakrApi.git" \
  "$API_EXPORT_DIR" 2>/dev/null \
  || git clone --depth=1 \
    "https://${GITHUB_TOKEN}@github.com/lbruton/StakTrakrApi.git" \
    "$API_EXPORT_DIR"
cd "$API_EXPORT_DIR"
# Ensure we're on the correct branch (handles first-run case)
git checkout -B "$POLLER_ID" 2>/dev/null || true
```

New block:
```bash
# Use the persistent volume clone — no temp dir, no clone overhead
API_EXPORT_DIR="${API_EXPORT_DIR:-/data/staktrakr-api-export}"
trap 'rm -f "$LOCKFILE"' EXIT

if [ ! -d "$API_EXPORT_DIR/.git" ]; then
  echo "[$(date -u +%H:%M:%S)] ERROR: $API_EXPORT_DIR is not a git repo. Is volume mounted?"
  exit 1
fi
cd "$API_EXPORT_DIR"
```

**Step 3: Remove the commit + push block at the bottom**

Old block (lines ~79-92):
```bash
# Commit and push to poller branch
cd "$API_EXPORT_DIR"
git add data/api/ data/retail/ 2>/dev/null || git add data/api/

if git diff --cached --quiet; then
  echo "[$(date -u +%H:%M:%S)] No new data to commit."
else
  git commit -m "${POLLER_ID}: ${DATE} $(date -u +%H:%M) export"
  # Rebase onto any commits pushed by concurrent runs since we cloned
  git fetch --depth=1 origin "$POLLER_ID" 2>/dev/null || true
  git rebase "origin/$POLLER_ID" 2>/dev/null || true
  git push "https://${GITHUB_TOKEN}@github.com/lbruton/StakTrakrApi.git" "$POLLER_ID"
  echo "[$(date -u +%H:%M:%S)] Pushed to ${POLLER_ID} branch"
fi
```

New block (data staged for publish, no push):
```bash
# Stage updated data — run-publish.sh will commit and push on its own cadence
cd "$API_EXPORT_DIR"
git add data/api/ data/retail/ 2>/dev/null || git add data/api/
echo "[$(date -u +%H:%M:%S)] Data staged. run-publish.sh will push on next cycle."
```

**Step 4: Remove GITHUB_TOKEN requirement check** (it's no longer needed for git push in this script)

Find and remove or soften:
```bash
if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN not set (required for pushing to StakTrakrApi)"
  exit 1
fi
```

Replace with:
```bash
# GITHUB_TOKEN used by run-publish.sh for pushing; not required here
```

**Step 5: Verify the diff makes sense**

```bash
git diff devops/retail-poller/run-local.sh
```

**Step 6: Commit**

```bash
git add devops/retail-poller/run-local.sh
git commit -m "refactor(run-local): write to volume path, remove git push (run-publish handles it)"
```

---

### T4: Create `run-publish.sh`

**Files:**
- Create: `devops/retail-poller/run-publish.sh`

This script is the single git writer. It commits whatever changed in the volume clone and force-pushes to `main`. Runs every 15 min (staggered to run after both spot and retail have had a chance to write).

Design decisions:
- **Force-push to `main`**: eliminates all merge conflicts. `main` is a derivative of what Fly.io writes; it is always correct by definition.
- **Single commit per publish cycle**: squashes any staged changes from retail + spot into one clean commit.
- **No lockfile**: publish is read-mostly and idempotent; a second concurrent publish just pushes the same state.
- **Commit message includes timestamps** of the most recent `manifest.json` and latest hourly file so the git log is meaningful.

```bash
cat > devops/retail-poller/run-publish.sh << 'EOF'
#!/bin/bash
# StakTrakr Publisher — commits volume data and force-pushes to main (GitHub Pages)
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

# Force-push to main — we are the sole writer; no merge needed
git push --force-with-lease "$REMOTE" HEAD:main

echo "[$(date -u +%H:%M:%S)] Published to main. Retail ts: ${RETAIL_TS}"
EOF
chmod +x devops/retail-poller/run-publish.sh
```

**Step 1: Verify**

```bash
head -10 devops/retail-poller/run-publish.sh && ls -la devops/retail-poller/run-publish.sh
```

**Step 2: Commit**

```bash
git add devops/retail-poller/run-publish.sh
git commit -m "feat: add run-publish.sh — single-writer force-push to main every 15 min"
```

---

### T5: Wire both scripts into cron via `docker-entrypoint.sh`

**Files:**
- Modify: `devops/retail-poller/docker-entrypoint.sh` (section `5.5 Dynamic cron schedule`, lines ~47-58)

**Current cron schedule written by entrypoint:**
```
${CRON_SCHEDULE} * * * * root . /etc/environment; /app/run-local.sh >> /var/log/retail-poller.log 2>&1
0 20 * * * root . /etc/environment; /app/run-fbp.sh >> /var/log/retail-poller.log 2>&1
1 17 * * * root . /etc/environment; /app/run-goldback.sh >> /var/log/goldback-poller.log 2>&1
```

**New cron schedule:**
```
${CRON_SCHEDULE} * * * * root . /etc/environment; /app/run-local.sh >> /var/log/retail-poller.log 2>&1
5,20,35,50 * * * * root . /etc/environment; /app/run-spot.sh >> /var/log/spot-poller.log 2>&1
8,23,38,53 * * * * root . /etc/environment; /app/run-publish.sh >> /var/log/publish.log 2>&1
0 20 * * * root . /etc/environment; /app/run-fbp.sh >> /var/log/retail-poller.log 2>&1
1 17 * * * root . /etc/environment; /app/run-goldback.sh >> /var/log/goldback-poller.log 2>&1
```

**Timing rationale:**
- Retail (`CRON_SCHEDULE=*/15`): `:00, :15, :30, :45` — takes ~5-8 min
- Spot: `:05, :20, :35, :50` — runs ~5 min after retail starts; completes in ~30s
- Publish: `:08, :23, :38, :53` — runs 3 min after spot, 8 min after retail starts; both have completed

**Step 1: Edit the cron-writing block in `docker-entrypoint.sh`**

Find the block at line ~54 that starts with `(echo "${CRON_SCHEDULE}...`. Replace the entire `(echo ... ) > /etc/cron.d/retail-poller` with:

```bash
(echo "${CRON_SCHEDULE} * * * * root . /etc/environment; /app/run-local.sh >> /var/log/retail-poller.log 2>&1"; \
 echo "5,20,35,50 * * * * root . /etc/environment; /app/run-spot.sh >> /var/log/spot-poller.log 2>&1"; \
 echo "8,23,38,53 * * * * root . /etc/environment; /app/run-publish.sh >> /var/log/publish.log 2>&1"; \
 echo "0 20 * * * root . /etc/environment; /app/run-fbp.sh >> /var/log/retail-poller.log 2>&1"; \
 echo "1 17 * * * root . /etc/environment; /app/run-goldback.sh >> /var/log/goldback-poller.log 2>&1") \
  > /etc/cron.d/retail-poller
```

**Step 2: Also add the new log files to the touch command at line ~61**

Find:
```bash
touch /var/log/retail-poller.log /var/log/goldback-poller.log /var/log/http-server.log
```

Replace with:
```bash
touch /var/log/retail-poller.log /var/log/goldback-poller.log /var/log/http-server.log \
      /var/log/spot-poller.log /var/log/publish.log
```

**Step 3: Verify**

```bash
grep -n "run-spot\|run-publish\|spot-poller.log\|publish.log" devops/retail-poller/docker-entrypoint.sh
```
Expected: 4 lines hit.

**Step 4: Commit**

```bash
git add devops/retail-poller/docker-entrypoint.sh
git commit -m "feat(entrypoint): add spot + publish cron entries (5,20,35,50 and 8,23,38,53)"
```

---

### T6: Copy spot-poller source into Dockerfile

**Files:**
- Modify: `devops/retail-poller/Dockerfile` (after the `COPY *.js ./` block, ~line 92)

The spot-poller directory lives at `devops/spot-poller/` — it needs to be copied into the image at `/app/spot-poller/`.

**Step 1: Edit Dockerfile**

Find the block:
```dockerfile
COPY *.js ./
COPY run-local.sh run-fbp.sh run-goldback.sh ./
RUN chmod +x run-local.sh run-fbp.sh run-goldback.sh
```

Replace with:
```dockerfile
COPY *.js ./
COPY run-local.sh run-fbp.sh run-goldback.sh run-spot.sh run-publish.sh ./
RUN chmod +x run-local.sh run-fbp.sh run-goldback.sh run-spot.sh run-publish.sh

# Spot-poller Python source
COPY ../spot-poller/ /app/spot-poller/
```

> **Note:** Docker COPY from a parent directory context (`../spot-poller/`) requires the build context to include `devops/`. Check `fly.toml`'s `[build]` section — currently `dockerfile = "Dockerfile"` with no explicit context path. The `fly deploy` command runs from `devops/retail-poller/`. We need to either: (a) set `build.context = ".."` in `fly.toml` and update the Dockerfile's COPY paths, or (b) copy the spot-poller files into `devops/retail-poller/spot-poller/` before building.
>
> **Chosen approach:** Add `build.context = ".."` to `fly.toml` and adjust all existing `COPY` paths to be relative to `devops/` root. This is cleaner and avoids duplicating files.

**Step 1 (revised): Update `fly.toml` build context**

Add to the `[build]` section:
```toml
[build]
  dockerfile = "retail-poller/Dockerfile"
  context = ".."
```

**Step 2: Update all COPY paths in Dockerfile to be relative to `devops/`**

All existing `COPY` commands in the Dockerfile currently assume the build context is `devops/retail-poller/`. After the context change to `devops/`, prefix paths with `retail-poller/`:

| Old | New |
|-----|-----|
| `COPY nuq-postgres-init.sql /opt/postgres/nuq.sql` | `COPY retail-poller/nuq-postgres-init.sql /opt/postgres/nuq.sql` |
| `COPY package.json ./` | `COPY retail-poller/package.json ./` |
| `COPY *.js ./` | `COPY retail-poller/*.js ./` |
| `COPY run-local.sh ...` | `COPY retail-poller/run-local.sh retail-poller/run-fbp.sh retail-poller/run-goldback.sh retail-poller/run-spot.sh retail-poller/run-publish.sh ./` |
| `COPY supervisord.conf ...` | `COPY retail-poller/supervisord.conf /etc/supervisor/conf.d/staktrakr.conf` |
| `COPY docker-entrypoint.sh ...` | `COPY retail-poller/docker-entrypoint.sh /app/docker-entrypoint.sh` |

Add new:
```dockerfile
COPY spot-poller/ /app/spot-poller/
```

**Step 3: Verify build context change in fly.toml**

```bash
grep -A3 "\[build\]" devops/retail-poller/fly.toml
```

**Step 4: Test build locally (if Docker available)**

```bash
cd devops && docker build -f retail-poller/Dockerfile . --no-cache 2>&1 | tail -20
```

**Step 5: Commit**

```bash
git add devops/retail-poller/Dockerfile devops/retail-poller/fly.toml
git commit -m "build: expand Docker context to devops/, copy spot-poller into image"
```

---

### T7: Retire `spot-poller.yml` GHA workflow

**Files:**
- Modify: `.github/workflows/spot-poller.yml`

Replace the scheduled trigger with `workflow_dispatch` only, and replace the job body with an echo. This preserves the workflow for manual emergency use without it running automatically.

**Step 1: Replace the file content**

```yaml
# Spot Price Poller — RETIRED 2026-02-23
# Spot polling is now handled by run-spot.sh cron inside the Fly.io container.
# This workflow is kept for emergency manual triggering only.
name: Spot Price Poller (retired)

on:
  workflow_dispatch:
    inputs:
      reason:
        description: 'Why are you running this manually?'
        required: false

jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - name: Retired
        run: echo "Spot polling is now handled by Fly.io container cron. See run-spot.sh."
```

**Step 2: Verify no schedule trigger remains**

```bash
grep "schedule\|cron" .github/workflows/spot-poller.yml
```
Expected: no output.

**Step 3: Commit**

```bash
git add .github/workflows/spot-poller.yml
git commit -m "chore: retire spot-poller.yml GHA workflow (moved to Fly.io cron)"
```

---

### T8: Retire `merge-poller-branches.yml` GHA workflow

**Files:**
- Modify: `.github/workflows/merge-poller-branches.yml`

Same pattern — keep for emergency manual use, remove the schedule.

**Step 1: Replace the file content**

```yaml
# Merge Poller Branches — RETIRED 2026-02-23
# Data publishing is now handled by run-publish.sh cron inside the Fly.io container.
# run-publish.sh force-pushes the full data directory from the volume to main every 15 min.
# This workflow is kept for emergency manual triggering only.
name: Merge Poller Branches (retired)

on:
  workflow_dispatch:
    inputs:
      reason:
        description: 'Why are you running this manually?'
        required: false

jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - name: Retired
        run: |
          echo "Data publishing is now handled by Fly.io container."
          echo "See run-publish.sh. Fly.io force-pushes to main every 15 min."
```

**Step 2: Verify no schedule trigger remains**

```bash
grep "schedule\|cron" .github/workflows/merge-poller-branches.yml
```
Expected: no output.

**Step 3: Commit**

```bash
git add .github/workflows/merge-poller-branches.yml
git commit -m "chore: retire merge-poller-branches.yml GHA workflow (run-publish.sh replaces it)"
```

---

### T9: Add `METAL_PRICE_API_KEY` secret to Fly.io (Human)

**Step 1:** Run:
```bash
fly secrets set METAL_PRICE_API_KEY=<your-key> --app staktrakr
```

**Step 2:** Verify:
```bash
fly secrets list --app staktrakr | grep METAL_PRICE_API_KEY
```
Expected: `METAL_PRICE_API_KEY` appears in the list.

---

### T10: Deploy to Fly.io (Human)

**Step 1:** From `devops/retail-poller/` (or `devops/` if build context changed):
```bash
cd devops && fly deploy --app staktrakr
```

**Step 2:** Watch the deploy:
```bash
fly logs --app staktrakr
```
Expected: supervisord starts all services; no crash loops.

---

### T11: Smoke test — watch first publish cycle (Human)

**Step 1:** Check cron loaded correctly:
```bash
fly ssh console --app staktrakr -C "cat /etc/cron.d/retail-poller"
```
Expected: 5 cron lines including run-spot and run-publish.

**Step 2:** Manually trigger spot poll:
```bash
fly ssh console --app staktrakr -C ". /etc/environment && /app/run-spot.sh"
```
Expected: `Spot poll complete.` with hourly file written.

**Step 3:** Manually trigger publish:
```bash
fly ssh console --app staktrakr -C ". /etc/environment && /app/run-publish.sh"
```
Expected: `Published to main.` with a git push line.

**Step 4:** Run health check:
```python
python3 << 'EOF'
import urllib.request, json
from datetime import datetime, timezone, timedelta

def age_min(ts):
    from datetime import datetime, timezone
    import re
    ts = ts.strip()
    if not re.search(r'[zZ]$|[+-]\d{2}:?\d{2}$', ts):
        ts = ts.replace(' ', 'T') + 'Z'
    return (datetime.now(timezone.utc) - datetime.fromisoformat(ts.replace('Z','+00:00'))).total_seconds()/60

def fetch(url):
    with urllib.request.urlopen(url, timeout=10) as r: return json.load(r)

now = datetime.now(timezone.utc)
try:
    d = fetch(f'https://api.staktrakr.com/data/hourly/{now.year}/{now.month:02d}/{now.day:02d}/{now.hour:02d}.json')
    age = age_min(d[-1]['timestamp'])
    print(f"Spot: {'OK' if age <= 75 else 'STALE'} — {age:.0f}m ago")
except Exception as e:
    print(f"Spot: ERROR — {e}")
EOF
```

---

### T12: Commit design doc

**Step 1:**
```bash
git add docs/plans/2026-02-23-consolidate-pollers-to-flyio.md
git commit -m "docs: add poller consolidation design doc and implementation plan"
```

---

## Auto-Quiz

1. **Which task is marked NEXT?** T1 — Add spot-poller pip deps to Dockerfile.
2. **Validation for T1:** `grep -A2 -B2 "pip3 install" devops/retail-poller/Dockerfile` shows the pip3 line; `docker build` succeeds (if Docker available locally — otherwise validated at T10 deploy time).
3. **Commit message for T1:** `"build: add spot-poller python deps to Dockerfile"`
4. **Breakpoint:** Pause after T6 (all code changes committed) and before T9/T10 (human Fly.io steps). The implementer should not deploy until the user confirms they are ready.

---

## Post-Deploy State

```
Fly.io container (staktrakr)
  ├── run-local.sh  (:00,:15,:30,:45)  writes data/api/ to /data/staktrakr-api-export/
  ├── run-spot.sh   (:05,:20,:35,:50)  writes data/hourly/ to /data/staktrakr-api-export/
  └── run-publish.sh (:08,:23,:38,:53) commits + force-pushes /data/ → GitHub main branch
                                            ↓
                                   api.staktrakr.com (GitHub Pages, main branch)
                                   Fresh every 15 min. Zero conflicts. Single writer.

GHA workflows: spot-poller.yml, merge-poller-branches.yml → retired (manual-only)
```
