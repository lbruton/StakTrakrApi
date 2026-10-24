<h1 align="center">
  <img src="https://raw.githubusercontent.com/lbruton/StakTrakr/main/images/banner-logo-compact.svg" alt="StakTrakr" height="64">
</h1>

<p align="center">
  Free, keyless precious metals price data. Spot, retail and Goldback feeds as static JSON.
</p>

<p align="center">
  <a href="https://api.staktrakr.com">api.staktrakr.com</a> &bull;
  <a href="https://github.com/lbruton/StakTrakr">StakTrakr app repo</a> &bull;
  <a href="https://www.staktrakr.com">Launch App</a> &bull;
  <a href="https://github.com/sponsors/lbruton">Sponsor</a>
</p>

---

This repository holds the published data behind [StakTrakr](https://github.com/lbruton/StakTrakr). GitHub Pages serves its `api` branch at `https://api.staktrakr.com`. There is no account, no API key and no rate-limit tier. Every endpoint is a static JSON file with `Access-Control-Allow-Origin: *`, so a browser can fetch it directly.

The code that builds these files lives in the StakTrakr repo under `devops/pollers/`. Open issues and pull requests there, not here.

---

## Quick Start

```bash
curl https://api.staktrakr.com/data/v2/spot/latest.json
```

```json
{
  "v": 2,
  "generated_at": "2026-10-24T18:23:04.870Z",
  "stale_after": 1200,
  "data": {
    "xau": { "price": 3995.84, "t": "2026-10-24T18:15:00Z", "ts": 1792865700 },
    "xag": { "price": 53.89, "t": "2026-10-24T18:15:00Z", "ts": 1792865700 }
  }
}
```

Start from `data/v2/manifest.json`. It lists every metal, coin slug and vendor ID, plus the endpoint templates below.

---

## Endpoints

Base URL: `https://api.staktrakr.com/data/v2/`. Every v2 endpoint updates every 15 minutes.

| Endpoint                             | Returns                                            |
| ------------------------------------ | -------------------------------------------------- |
| **Discovery**                        |                                                    |
| `manifest.json`                      | Metals, coin slugs, vendors and endpoint templates |
| `providers.json`                     | Vendor product URLs per coin                       |
| **Spot**                             |                                                    |
| `spot/latest.json`                   | Current spot price for all five metals             |
| `spot/{metal}/latest.json`           | One metal, with `change_24h` and `change_24h_pct`  |
| `spot/{metal}/intraday.json`         | Rolling 24 hours of 15-minute OHLCA                |
| `spot/{metal}/{YYYY}/{MM}/{DD}.json` | Hourly OHLCA for one UTC day                       |
| `spot/{metal}/{YYYY}/{MM}.json`      | Daily OHLCA for one month                          |
| `spot/history/{N}d.json`             | Daily OHLCA per metal; `N` is `7`, `30` or `90`    |
| **Retail**                           |                                                    |
| `retail/latest.json`                 | Median, low and high price for every coin          |
| `retail/{slug}/latest.json`          | Per-vendor prices for one coin                     |
| `retail/{slug}/intraday.json`        | Rolling 24 hours of 15-minute windows, per vendor  |
| `retail/{slug}/{YYYY}/{MM}.json`     | Daily aggregates for one month                     |
| `retail/{slug}/history-{N}d.json`    | Daily aggregates; `N` is `7`, `30` or `90`         |
| `retail/vendors/index.json`          | Vendor list                                        |
| `retail/vendors/{vendor}.json`       | Every coin price from one vendor                   |
| **Goldback**                         |                                                    |
| `goldback/latest.json`               | G1 rate in USD and denomination prices             |
| `goldback/intraday.json`             | Hourly G1 rate for the last 72 hours               |
| `goldback/{YYYY}/{MM}.json`          | Daily G1 rate for one month                        |
| `goldback/history-30d.json`          | Daily G1 rate for 30 days                          |

Path values:

| Value      | Format                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------- |
| `{metal}`  | `xau` Gold, `xag` Silver, `xpt` Platinum, `xpd` Palladium, `xcu` Copper                     |
| `{slug}`   | A coin slug from the manifest, for example `ase`, `age`, `maple-silver`, `goldback-utah-g1` |
| `{vendor}` | A vendor ID from the manifest, for example `apmex`, `jmbullion`, `sdbullion`                |
| Dates      | UTC. `{YYYY}` four digits, `{MM}` and `{DD}` zero-padded                                    |

Prices are USD per troy oz. Retail prices are USD per coin.

### Response format

Every v2 file has the same envelope:

| Field          | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `v`            | Schema version, `2`                                          |
| `generated_at` | Publish time, ISO 8601 UTC                                   |
| `stale_after`  | Seconds after `generated_at` before the data counts as stale |
| `data`         | The payload                                                  |

Time-series points carry both `t` (ISO 8601 UTC) and `ts` (Unix seconds). Aggregates use OHLCA: `open`, `high`, `low`, `close`, `avg`, plus `n` for the sample count.

### Spot history files

These files sit outside `v2/` and use their own formats:

| Path                                      | Returns                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `data/spot-history-{YYYY}.json`           | One daily average per metal per UTC day, 1968 to present |
| `data/spot-history-bundle.js`             | All years in one script for fast app load                |
| `data/hourly/{YYYY}/{MM}/{DD}/{HH}.json`  | Raw spot readings for one UTC hour                       |
| `data/15min/{YYYY}/{MM}/{DD}/{HHMM}.json` | Raw spot snapshot for one 15-minute poll                 |
| `data/goldback-{YYYY}.json`               | Daily G1 rate, newest first                              |

### Legacy v1

`data/api/` holds the v1 files. The publisher still writes them for older clients, but the app reads only v2. Build new clients against v2.

---

## How It Works

```text
Home poller ──► sqld ◄── Fly.io poller (spot + publish)
                           │
                           │ every 15 min: export JSON, commit, push
                           ▼
              StakTrakrApi `api` branch ──► GitHub Pages ──► api.staktrakr.com
```

- Spot prices come from MetalPriceAPI. The Fly.io and home pollers each poll twice an hour, offset so a reading lands every 15 minutes.
- Retail prices come from dealer product pages. The home poller scrapes them once an hour into sqld.
- The Goldback rate comes from goldback.com once an hour.
- The Fly.io publisher exports sqld to JSON, commits to the `api` branch and force-pushes. It is the only writer.
- `api2.staktrakr.com` serves the same files from the Fly.io machine. The app fails over to it when GitHub Pages is stale.

`api` is the only branch. Commits made on GitHub do not survive the next publish, so changes to this repo go through the publisher's checkout.

---

## Related

- [StakTrakr](https://github.com/lbruton/StakTrakr): the app, the pollers and the issue tracker
- [www.staktrakr.com](https://www.staktrakr.com): the hosted app
- [r/staktrakr](https://www.reddit.com/r/staktrakr/): community

## License

The data comes with no warranty of accuracy or availability. The StakTrakr code is MIT licensed; see the [StakTrakr license](https://github.com/lbruton/StakTrakr/blob/main/LICENSE).
