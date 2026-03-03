# Retail View Modal

> **Last updated:** v3.32.26 — 2026-02-23
> **Source files:** `js/retail-view-modal.js`, `js/retail.js`

## Overview

The Retail View Modal is a per-coin detail panel that opens when a user clicks a coin card in the Retail Prices view. It contains two tabs:

- **24h Chart** (default on open) — a Chart.js line chart of vendor prices over the past 24 hours, plus a "Recent windows" table beneath it.
- **Price History** — a daily candlestick-style chart and 30-day history table showing average vendor prices per day.

As of v3.32.25 the modal also forward-fills vendor prices across gap windows and shows out-of-stock (OOS) vendors as clickable links in the vendor legend.

## Key Rules (read before touching this area)

- **Never call `document.getElementById()` directly.** Use `safeGetElement(id)` for all DOM lookups.
- **Do not access `localStorage` directly.** Retail data is read/written through `saveData()`/`loadData()` from `js/utils.js`. Specific retail helpers (`saveRetailPrices`, `saveRetailIntradayData`, etc.) are exported by `retail.js`.
- `_buildIntradayChart` always calls `_buildIntradayTable` at the end. Do not call both independently.
- `_buildVendorLegend` is called both on modal open and after the async background refresh completes. It must be idempotent — it clears the container on every call.
- The Chart.js intraday chart instance is stored in the module-level `_retailViewIntradayChart` variable. Always destroy the old instance before creating a new one or you will leak canvas contexts.
- `_forwardFillVendors` must always return `[]` on empty input. Never mutate the input `bucketed` array; return a new array with decorated window objects.

## Architecture

### Data flow

```
retailIntradayData[slug].windows_24h   (raw 15-min windows from API)
         │
         ▼
  _bucketWindows(windows)              → bucketed[]  (30-min slots, up to 48)
         │
         ▼
  _forwardFillVendors(bucketed)        → filled[]    (gaps filled, _carriedVendors set on each window)
         │
         ├──▶  _buildIntradayChart()   → Chart.js line chart; tooltip prefixes carried values with "~"
         └──▶  _buildIntradayTable()   → Recent windows table; carried cells shown as "~$XX.XX" muted italic
```

The vendor legend is built separately from `retailPrices` (current snapshot), not from intraday windows.

### Module-level state

| Variable | Type | Purpose |
|---|---|---|
| `_retailViewModalChart` | `Chart \| null` | Daily history Chart.js instance |
| `_retailViewIntradayChart` | `Chart \| null` | 24h intraday Chart.js instance |
| `_intradayRowCount` | `number` | Number of rows shown in Recent windows table (default 24) |

### Globals consumed from `retail.js`

| Global | Declared in | Purpose |
|---|---|---|
| `retailPrices` | `retail.js` | Current price snapshot (`{ prices: { [slug]: { vendors, median_price, lowest_price } } }`) |
| `retailAvailability` | `retail.js` | Per-slug per-vendor availability flags (`{ [slug]: { [vendorId]: false } }` when OOS) |
| `retailLastKnownPrices` | `retail.js` | Last-seen price per vendor per slug, used for OOS legend display |
| `retailLastAvailableDates` | `retail.js` | ISO date string of last availability per vendor per slug |
| `retailProviders` | `retail.js` | Per-slug per-vendor deep-link URLs (overrides `RETAIL_VENDOR_URLS` when present) |
| `RETAIL_VENDOR_NAMES` | `retail.js` | `{ [vendorId]: displayName }` — canonical vendor list and display order |
| `RETAIL_VENDOR_COLORS` | `retail.js` | `{ [vendorId]: hexColor }` — brand colors for chart lines and legend swatches |
| `RETAIL_VENDOR_URLS` | `retail.js` | `{ [vendorId]: url }` — fallback homepage URLs when `retailProviders` has no slug-level override |

### Vendor roster (as of v3.32.25)

| ID | Display name | Color |
|---|---|---|
| `apmex` | APMEX | `#3b82f6` blue |
| `monumentmetals` | Monument | `#a78bfa` violet |
| `sdbullion` | SDB | `#10b981` emerald |
| `jmbullion` | JM | `#f59e0b` amber |
| `herobullion` | Hero | `#f87171` red |
| `bullionexchanges` | BullionX | `#ec4899` pink |
| `summitmetals` | Summit | `#06b6d4` cyan |

---

## Function Reference

### `_bucketWindows(windows)`

Groups raw 15-min API windows into 30-min aligned slots (HH:00 and HH:30 boundaries).

**Input:** `windows` — the `windows_24h` array from `retailIntradayData[slug]`.

**Output:** A new sorted array of up to 48 window objects, oldest first. Each object has its `window` field overwritten to the ISO slot key (e.g. `2026-02-23T14:30:00.000Z`) and an extra `_originalWindow` field preserving the raw timestamp.

**Algorithm:**
1. For each raw window, round its UTC timestamp down to the nearest 30-min boundary.
2. For each slot, keep only the most recent raw window (compared by `_originalWindow`).
3. Return the de-duplicated entries sorted chronologically.

**Edge cases:**
- Returns `[]` on null, undefined, or empty input.
- Windows with a missing or unparseable `window` field are silently skipped.

---

### `_forwardFillVendors(bucketed)` *(added v3.32.25)*

Fills vendor price gaps across consecutive windows so the chart never shows a false "vendor dropped out" dip when a vendor simply had no poll for a slot.

**Input:** `bucketed` — the output of `_bucketWindows`.

**Output:** A new array (never mutates input). Each window object is a shallow copy; windows with carried prices have a `_carriedVendors: Set<vendorId>` property listing which vendor values were forward-filled from an earlier window.

**Algorithm:**
1. Iterate windows in chronological order, maintaining a `lastSeen` map of `vendorId → price`.
2. For each window, for each vendor in `RETAIL_VENDOR_NAMES`:
   - If the window has a real price for that vendor, update `lastSeen[vendorId]`.
   - If the window is missing a price but `lastSeen[vendorId]` exists, copy it in and add the vendor to the window's `_carriedVendors` set.
3. Return the decorated array.

**Edge cases:**
- Returns `[]` on empty input — no iteration attempted.
- Only vendors present in `RETAIL_VENDOR_NAMES` are considered.
- A vendor that has never appeared in any window is never forward-filled (no `lastSeen` entry).

---

### `_buildIntradayChart(slug)`

Renders the Chart.js 24h line chart and delegates to `_buildIntradayTable`.

**Steps:**
1. Reads `retailIntradayData[slug].windows_24h`.
2. Calls `_bucketWindows` then `_forwardFillVendors` to produce the filled window array.
3. Shows "no data" placeholder if fewer than 2 windows are available.
4. Destroys any existing `_retailViewIntradayChart` instance before creating a new one.
5. Builds one dataset per active vendor (vendors with at least one non-null price in the filled windows), using `RETAIL_VENDOR_NAMES` to determine order and `RETAIL_VENDOR_COLORS` for line colors.
6. Falls back to Median + Low datasets when no per-vendor data exists (pre-vendor-format windows).
7. Attaches a `_carriedIndices: Set<number>` to each dataset — the bucket indices whose value was forward-filled.
8. Tooltip `label` callback: if `ctx.raw` is null (guard required — `ctx.raw` can be null on `spanGaps: true` datasets), returns nothing; if the index is in `_carriedIndices`, prefixes with `~` (e.g. `~$32.15`); otherwise formats normally.
9. Calls `_buildIntradayTable(slug, filled)` at the end.

**Chart options:**
- `spanGaps: true` — lines bridge over null entries.
- Legend hidden when vendor-mode is active (each vendor is already color-coded).
- X-axis ticks: HH:00 labels rendered at full opacity/size; HH:30 labels at reduced opacity and smaller font.

---

### `_buildIntradayTable(slug, bucketed)`

Renders the "Recent windows" table beneath the 24h chart.

**Signature:** `_buildIntradayTable(slug, bucketed?)` — `bucketed` is optional. If omitted the function re-buckets from `retailIntradayData[slug]` (used by the row-count dropdown's `onchange` handler).

**Column logic:**
- When per-vendor data is present: one column per active vendor using `RETAIL_VENDOR_NAMES` display names.
- Fallback: "Median" and "Low" columns.

**Cell rendering — three branches:**

| Condition | Output |
|---|---|
| Value is `null` (vendor had no data in this slot and nothing to carry) | `—` (em dash, no styling) |
| Value was forward-filled (`_carriedVendors` contains this vendor) | `~$XX.XX` muted italic, no trend glyph |
| Value is fresh | `$XX.XX ▲` / `$XX.XX ▼` / `$XX.XX —` with `text-success` / `text-danger` class |

Trend glyphs compare each row to the row immediately below it (the next older window, since the table is displayed newest-first). Carried values never show a trend glyph because the price movement is artificially flat.

**Row count:** Slices to the `_intradayRowCount` most recent windows (default 24, controlled by a dropdown in the modal).

---

### `_buildVendorLegend(slug)`

Renders the colored vendor legend above the price-history chart showing current prices.

**Behavior:**
- Clears the `#retailViewVendorLegend` container on every call.
- `hasAny` check: at least one vendor in `RETAIL_VENDOR_NAMES` must have a non-null `price` in `retailPrices.prices[slug].vendors`. If no vendors pass this check, the function returns early (no legend rendered).
- Iterates all `RETAIL_VENDOR_NAMES` keys in declaration order.

**Per-vendor item:**
- Skips vendors with `price == null` in the current snapshot **unless** they appear in `retailAvailability[slug][v] === false` (OOS) — OOS vendors are always shown.
- OOS item treatment: `opacity: 0.5`, price wrapped in `<del>`, "OOS" badge appended, item is still a clickable `<a>` element.
- In-stock with price: rendered as an `<a>` if a URL is available (checking `retailProviders[slug][vendorId]` first, then `RETAIL_VENDOR_URLS[vendorId]`); otherwise a plain `<span>`.
- Click handler opens vendor URL in a named popup window (`retail_vendor_{vendorId}`) with fixed dimensions; falls back to `_blank` if the popup is blocked.

**Structure per item:**
```
<a class="retail-legend-item">
  <span class="retail-legend-swatch" style="background: {color}"></span>
  <span class="retail-legend-name"   style="color: {color}">{displayName}</span>
  <span class="retail-legend-price">${price}</span>
</a>
```

---

### `openRetailViewModal(slug)`

Entry point — called from retail card click handlers.

**Sequence:**
1. Reads `RETAIL_COIN_META[slug]` for coin name, weight, and metal type.
2. Populates modal title and subtitle.
3. Removes any stale staleness banner from a previous open.
4. Calls `_buildVendorLegend(slug)`.
5. Populates the 30-day history table from `getRetailHistoryForSlug(slug)`.
6. Builds the daily history Chart.js chart (per-vendor lines; gaps for OOS entries via `spanGaps: false`).
7. Calls `_buildIntradayChart(slug)` (which internally calls `_buildIntradayTable`).
8. Wires the row-count `<select>` dropdown.
9. Defaults to the "intraday" (24h) tab.
10. Opens the modal via `openModalById("retailViewModal")`.
11. Fires an async `Promise.all` to fetch fresh `latest.json` and `history-30d.json` from the API; on success, updates `retailIntradayData`, `retailPrices`, and `retailPriceHistory`, then rebuilds the chart and legend. On total failure, inserts a staleness warning banner.

### `closeRetailViewModal()`

Destroys both Chart.js instances and calls `closeModalById("retailViewModal")`.

### `_switchRetailViewTab(tab)`

Toggles between `"history"` and `"intraday"` tabs by toggling `display` and the Bootstrap `active` class on the tab buttons.

---

## Window Exports

Only a subset of functions are exported to `window` for use by inline HTML handlers:

```js
window.openRetailViewModal   // called from retail card buttons
window.closeRetailViewModal  // called from modal close button
window._switchRetailViewTab  // called from tab button onclick
window._bucketWindows        // exported for console/smoke-test inspection
window._buildIntradayTable   // exported for row-count dropdown onchange
```

`_forwardFillVendors`, `_buildIntradayChart`, and `_buildVendorLegend` are module-private.

---

## Common Mistakes

### Calling `_buildIntradayChart` and `_buildIntradayTable` separately

`_buildIntradayChart` always calls `_buildIntradayTable` at the end with the same `bucketed` array. If you call both independently you will build the table twice and the second call will re-bucket from scratch, potentially producing stale data.

### Forgetting the null guard on `ctx.raw` in tooltip callbacks

Chart.js passes `ctx.raw = null` for gap points when `spanGaps: true`. Calling `Number(null).toFixed(2)` produces `"0.00"`, not an error — but it silently shows wrong data. Always guard: `if (ctx.raw == null) return;`.

### Mutating the `bucketed` input in `_forwardFillVendors`

`_bucketWindows` returns window objects that are re-used across chart and table builds. Mutating them in `_forwardFillVendors` would corrupt the source data for subsequent calls. Always shallow-copy each window before adding `_carriedVendors`.

### Adding a new vendor without updating all three vendor maps

`RETAIL_VENDOR_NAMES`, `RETAIL_VENDOR_COLORS`, and `RETAIL_VENDOR_URLS` must all be updated together in `retail.js`. A vendor missing from `RETAIL_VENDOR_NAMES` will never appear in the chart, table, or legend — the other two maps are irrelevant without the name entry.

### OOS legend items disappearing after a `retailPrices` refresh

`_buildVendorLegend` currently reads current prices from `retailPrices.prices[slug].vendors`. OOS vendors have `price == null` in that snapshot. The `hasAny` guard checks `RETAIL_VENDOR_NAMES` keys against live prices — if all vendors are OOS, `hasAny` is false and the legend is suppressed entirely. If OOS vendors must always be shown, check `retailAvailability` in the `hasAny` guard as well.

### Not destroying the old Chart.js instance before creating a new one

Both `_retailViewModalChart` and `_retailViewIntradayChart` must be explicitly destroyed before reassignment. Skipping this leaks canvas rendering contexts and causes "Canvas is already in use" console warnings on subsequent modal opens.

---

## Related Pages

- [api-consumption.md](api-consumption.md) — how `retail.js` fetches `latest.json` and `history-30d.json` from `api.staktrakr.com`
- [frontend-overview.md](frontend-overview.md) — script load order, `window` global conventions, and `safeGetElement` usage
