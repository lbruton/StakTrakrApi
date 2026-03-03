# providers.json

> **Last verified:** 2026-02-24 — 15 URL corrections applied 2026-02-23, year-start SKU patterns documented

---

## Overview

`providers.json` lives on the **`api` branch** at `data/retail/providers.json`. It defines:
- Which vendors to scrape for each coin
- The URL for each vendor/coin combination
- Coin weights (for price-per-oz normalization)

Both pollers **curl this file from the `api` branch before each run**, so URL corrections take effect immediately on the next cycle with no code deploy.

---

## Location

```
StakTrakrApi repo, api branch:
  data/retail/providers.json
```

Raw URL:
```
https://raw.githubusercontent.com/lbruton/StakTrakrApi/api/data/retail/providers.json
```

---

## Structure

```json
{
  "last_updated": "2026-02-24",
  "notes": "...",
  "coins": {
    "ase": {
      "name": "American Silver Eagle",
      "weight_oz": 1,
      "providers": [
        {
          "id": "jmbullion",
          "name": "JM Bullion",
          "urls": [
            "https://www.jmbullion.com/2026-1-oz-american-silver-eagle-coin/",
            "https://www.jmbullion.com/american-silver-eagle-varied-year/"
          ]
        },
        {
          "id": "apmex",
          "name": "APMEX",
          "url": "https://www.apmex.com/..."
        }
      ]
    }
  }
}
```

### `urls` vs `url`

Providers support two forms:

| Field | Type | Behavior |
|-------|------|----------|
| `url` | string | Single URL — backward compatible, treated as a 1-element list |
| `urls` | array | Multi-URL fallback list — scraper tries each in order |

**Never set both on the same entry.** Use `urls` when a provider has year-specific SKUs that may go OOS; use `url` for stable random-year SKUs.

The scraper (since 2026-02-23) tries all `urls` via Firecrawl first, then falls back to Playwright on the last URL only if the entire Firecrawl chain fails. On OOS or parse failure at URL[i], it jitters and tries URL[i+1]. A price found at any URL stops the loop immediately.

---

## URL Strategy

### Prefer random-year / dates-our-choice SKUs

When a vendor offers a "dates our choice" or "random year" SKU, prefer it over a specific year. These SKUs stay stable year-over-year and typically represent the best price.

### Year-start exception: Monument Metals

Monument Metals maintains **parallel SKUs** for each coin:
- `random-date-*.html` — random year, best price when bulk stock available
- `2026-*.html` — current year, in stock from January

**At year-start (Jan–Mar):**
- Random-year SKUs go to pre-order while year-specific is the only in-stock option
- Switch to year-specific SKUs until bulk random-year stock arrives (typically March–April)

**Known year-start pattern (verified 2026-02-23):**

| Coin | Year-start URL | Status |
|------|---------------|--------|
| `ase` | `2026-american-silver-eagle.html` | Year-specific (random was pre-order) |
| `age` | `2026-american-1-oz-gold-eagle-bu.html` | Year-specific (random was pre-order) |
| `maple-gold` | `2026-1oz-gold-maple.html` | Year-specific (random was pre-order) |
| `krugerrand-silver` | `south-africa-1-oz-silver-krugerrand-bu-random-date.html` | Random-date (2026 was pre-order — opposite) |

> Check Monument Metals in late March/April to see if random-year SKUs are back in stock.

---

## JMBullion Pre-Order / Presale

JMBullion marks some coins as "Presale" or "Pre-Order" at year-start but still shows live purchasable prices. These coins should NOT be treated as out of stock.

`price-extract.js` has `PREORDER_TOLERANT_PROVIDERS = Set(["jmbullion"])` which skips the `pre-?order` OOS pattern for JMBullion only.

Affected coins at year-start:
- `buffalo`
- `maple-silver`
- `maple-gold`
- `krugerrand-silver`

---

## Out-of-Stock vs. Genuinely Unavailable

Not all vendors carry all coins. Some vendor/coin pairs may have correct URLs but genuinely no stock:
- `ape/bullionexchanges` — correct URL, OOS at some periods
- `ape/herobullion` — correct URL, OOS at some periods
- `britannia-silver/bullionexchanges` — correct URL, OOS at some periods

These return `null` price with `in_stock: false`. Leave the URL as-is; prices will return when vendors restock.

---

## Updating providers.json

1. Edit `data/retail/providers.json` on the `api` branch directly (or via a branch that tracks `api`)
2. Push to `api` branch
3. Both pollers pick it up on the next run — **no redeploy needed**

```bash
# Quick URL fix via git
git checkout api  # or branch tracking origin/api
# Edit providers.json
git add data/retail/providers.json
git commit -m "providers: fix monument metals year-specific SKUs"
git push origin api  # or HEAD:api
```

---

## URL Corrections History

| Date | Changes |
|------|---------|
| 2026-02-23 | 15 URL corrections: JMBullion ASE dead redirect fixed; Monument Metals 6 coins switched to year-specific; Hero Bullion 10oz bar switched to Engelhard SKU |
| 2026-02-23 | JMBullion ASE and Silver Maple Leaf converted from single `url` to `urls` fallback array (2026 → 2025 → 2024 → varied-year) |
