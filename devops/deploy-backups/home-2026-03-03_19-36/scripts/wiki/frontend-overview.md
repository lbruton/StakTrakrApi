# Frontend Overview

> **Last updated:** v3.32.27 — 2026-02-23
> **Source files:** `index.html`, `js/constants.js`, `sw.js`, `js/file-protocol-fix.js`

## Overview

StakTrakr is a single-page precious metals inventory tracker built with pure HTML and vanilla JavaScript — zero build step, zero install, zero dependencies. It works on both `file://` and HTTP without any configuration changes. All application state persists in `localStorage`; there is no server, no database, and no backend beyond a static API feed.

## Key Rules (read before touching this area)

- **New JS files must be registered in TWO places:** add a `<script>` tag to `index.html` in strict load order AND add the path to `CORE_ASSETS` in `sw.js`. Missing either means the file never loads or the service worker silently skips it on offline fetch.
- **Never use `document.getElementById()` directly** (except in `about.js` and `init.js` startup code) — always use `safeGetElement(id)`.
- **Never write to `localStorage` directly** — always use `saveData()` / `loadData()` from `js/utils.js`.
- **All localStorage keys must be declared** in `ALLOWED_STORAGE_KEYS` in `js/constants.js`.
- **Always call `sanitizeHtml()`** before assigning user content to `innerHTML`.
- The `sw.js` `CACHE_NAME` is auto-stamped by the `devops/hooks/stamp-sw-cache.sh` pre-commit hook — do not edit it manually.
- Script load order in `index.html` is strict; dependencies must appear before dependents. There are currently **67 `<script>` tags** in `index.html`.

## Architecture

### Runtime model

```
index.html  (single page, all UI panels)
  └── 67 <script> tags (strict load order)
        ├── js/file-protocol-fix.js   — detects file:// vs HTTP, patches fetch
        ├── js/constants.js           — APP_VERSION, all constants, ALLOWED_STORAGE_KEYS
        ├── js/state.js               — shared mutable state
        ├── js/utils.js               — saveData(), loadData(), safeGetElement()
        ├── ... (feature modules)
        └── js/init.js                — bootstraps the app after all scripts load
```

### Versioning

`APP_VERSION` in `js/constants.js` follows `BRANCH.RELEASE.PATCH` format (e.g. `3.32.27`).  
Optional state suffix: `a` = alpha, `b` = beta, `rc` = release candidate.  
Run `/release patch` after every meaningful committed change — one change, one patch tag.

### Key globals exposed on `window`

| Global | Source file | Purpose |
|---|---|---|
| `APP_VERSION` | `js/constants.js` | Current version string |
| `saveData(key, value)` | `js/utils.js` | Write to localStorage (validated key) |
| `loadData(key)` | `js/utils.js` | Read from localStorage |
| `safeGetElement(id)` | `js/utils.js` | Safe `getElementById` wrapper |
| `retailPrices` | `js/retail-pricing.js` | Latest retail price map |
| `retailAvailability` | `js/retail-pricing.js` | Availability flags per item |
| `spotPrice` | `js/spot-price.js` | Current spot price object |
| `STORAGE_PERSIST_GRANTED_KEY` | `js/constants.js` | localStorage key for storage persistence grant flag |
| `IMAGE_ZIP_MANIFEST_VERSION` | `js/constants.js` | Version string for image ZIP export manifest format (currently `'1.0'`) |

### Key subsystems

| Subsystem | Entry point(s) | Notes |
|---|---|---|
| Inventory | `js/inventory.js`, `js/items.js` | CRUD for precious metals holdings |
| Retail pricing | `js/retail-pricing.js`, `js/api.js` | Polls `api.staktrakr.com/data/api/manifest.json` |
| Spot prices | `js/spot-price.js`, `js/spot-history.js` | Polls hourly and 15-min feeds from `api.staktrakr.com` |
| Cloud sync | `js/cloud-sync.js`, `js/cloud-settings.js` | Backup/restore via encrypted cloud vault |
| Catalog | `js/catalog.js`, `js/seed-images.js` | Coin/bar catalog with image cache |
| Image cache | `js/image-cache.js` | Per-item user photo storage; dynamic quota; byte tracking per store |
| Service worker | `sw.js` | Offline support, PWA installability, cache versioning |

### `file://` protocol support

`js/file-protocol-fix.js` detects whether the app is running under `file://` and patches `fetch` calls accordingly so that API polling and local JSON reads work in both environments.

### Portfolio value model

```
meltValue  = weight × qty × spotPrice
```

Three price columns tracked per holding: **Purchase Price**, **Melt Value**, **Retail Price**.

### Storage gauge (v3.32.27)

The Settings storage section now renders a **split storage gauge** with two independently tracked bars:

- **Your Photos** — bytes used by user-uploaded images (tracked via `js/image-cache.js`)
- **Numista Cache** — bytes used by Numista API response cache

A persistence status line (`#gaugePersistLine`) shows whether the browser has granted persistent storage. The persistence request is triggered by `js/settings.js` and the grant is recorded under `storagePersistGranted` in localStorage. Quota is computed dynamically from the `navigator.storage.estimate()` API rather than the previous hardcoded 50 MB cap.

## Common Mistakes

- Adding a new JS file to `index.html` but forgetting `sw.js` CORE_ASSETS (or vice versa) — the app works in dev but breaks for users with a cached service worker.
- Calling `document.getElementById()` outside of `about.js` / `init.js` — the safe wrapper provides error logging and avoids silent null-ref failures.
- Writing directly to `localStorage` instead of `saveData()` — bypasses key validation and breaks the data audit trail.
- Editing `sw.js` `CACHE_NAME` manually — the pre-commit hook will overwrite it; always let the hook stamp the value.
- Placing a new `<script>` tag in the wrong position in `index.html` — scripts that reference globals from later files will throw at load time.
- Assuming `spot-history-YYYY.json` is live data — it is a seed file (noon UTC daily snapshot) and will always appear ~10 h stale in health checks.
- Hardcoding a storage quota (e.g. `50 * 1024 * 1024`) — quota is now derived dynamically from `navigator.storage.estimate()` in `js/image-cache.js`.

## Related Pages

- [Data Model](data-model.md)
- [Storage Patterns](storage-patterns.md)
- [DOM Patterns](dom-patterns.md)
- [Service Worker](service-worker.md)
- [Release Workflow](release-workflow.md)
