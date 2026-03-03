import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
const envLines = readFileSync("/opt/poller/.env", "utf8").split("\n");
for (const line of envLines) { const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Check spot runs in last 24h
const spot = await client.execute(`
  SELECT poller, COUNT(*) as cnt, MIN(started_at) as earliest, MAX(started_at) as latest
  FROM poller_runs
  WHERE poller IN ('home-spot', 'fly-spot')
  AND started_at > datetime('now', '-24 hours')
  GROUP BY poller
`);
console.log("Spot runs (24h):", JSON.stringify(spot.rows, null, 2));

// Check 15-min interval coverage for spot
const spotIntervals = await client.execute(`
  SELECT strftime('%Y-%m-%dT%H:%M', started_at) as ts, poller, status, captured, failures
  FROM poller_runs
  WHERE poller IN ('home-spot', 'fly-spot')
  AND started_at > datetime('now', '-6 hours')
  ORDER BY started_at DESC
  LIMIT 30
`);
console.log("\nSpot intervals (6h):", JSON.stringify(spotIntervals.rows, null, 2));

// Check what pollers exist
const pollers = await client.execute(`SELECT DISTINCT poller FROM poller_runs ORDER BY poller`);
console.log("\nAll pollers:", JSON.stringify(pollers.rows));

// Check total enabled vendor count
const enabled = await client.execute("SELECT COUNT(*) as cnt FROM provider_vendors WHERE enabled = 1");
console.log("\nEnabled vendors:", enabled.rows[0].cnt);

// Check price_snapshots per hour for last 24h
const hourly = await client.execute(`
  SELECT strftime('%Y-%m-%dT%H:00', scraped_at) AS hour,
         COUNT(DISTINCT coin_slug || ':' || vendor) AS covered
  FROM price_snapshots
  WHERE is_failed = 0
    AND scraped_at > datetime('now', '-24 hours')
  GROUP BY hour
  ORDER BY hour
`);
console.log("\nHourly coverage (24h):", JSON.stringify(hourly.rows));
