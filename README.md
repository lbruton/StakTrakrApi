# StakTrakrApi

Dedicated data repository for StakTrakr retail price API exports.

## Architecture

- **Turso Database** - Cloud-hosted libSQL database (source of truth)
- **3 Independent Pollers** - Each writes to Turso, exports to dedicated branch
  - `api1` - Fly.io (primary)
  - `api2` - Ubuntu homelab
  - `api3` - Future
- **Branches**
  - `main` - Merged data from all pollers (consumers read this)
  - `api1`, `api2`, `api3` - Per-poller branches (force-pushed every 15 min)

## Directory Structure

```
data/
├── api/
│   ├── ase/
│   │   └── latest.json
│   ├── age/
│   │   └── latest.json
│   └── ... (67 coin slugs)
├── retail/
│   └── providers.json
└── prices.db (read-only SQLite snapshot from Turso)
```

## API Endpoints

- `/api/{coin-slug}/latest.json` - Latest retail prices for coin
- `/api/providers.json` - Vendor configuration
- `/prices.db` - SQLite snapshot for offline use
