# StakTrakrWiki Changelog

Running log of structural wiki updates. Not a code changelog — tracks when wiki content was added, reorganized, or policy was updated.

---

## 2026-02-25

- Deprecated Notion infrastructure pages; StakTrakrWiki is now the sole source of truth for all infrastructure documentation
- Added `wiki-search` skill to StakTrakr — guides indexing and querying the wiki via `mcp__claude-context__search_code`
- Deprecated `docs/devops/api-infrastructure-runbook.md` in StakTrakr (deprecation banner added; file retained pending wiki parity audit)
- Added Update Policy section to README.md
- Added Documentation Policy section to CLAUDE.md, AGENTS.md, GEMINI.md, and copilot-instructions.md
- Updated `finishing-a-development-branch` skill with mandatory Wiki Update Gate (runs before every PR)
- Updated `wiki-update` skill with infrastructure page mapping table
- Added SSH Remote Management section to `home-poller.md` — Claude Code can now SSH directly via `stakpoller` user
- Updated `home-poller.md` user from `lbruton` to `stakpoller` for SSH access
- Verified home poller from VM console: fixed cron `30 * * * *` → `0,30 * * * *` (runs 2×/hr) across `home-poller.md`, `retail-pipeline.md`, `architecture-overview.md`
- Fixed `retail-pipeline.md` home poller IP from `192.168.1.48` → `192.168.1.81` and POLLER_ID from `api2` → `home`
- Added `FLYIO_TAILSCALE_IP` to `home-poller.md` env table
- Pinned Node.js version to 22.22.0 in `home-poller.md` stack table
