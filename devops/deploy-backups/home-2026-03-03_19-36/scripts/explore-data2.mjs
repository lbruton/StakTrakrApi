import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
const envLines = readFileSync("/opt/poller/.env", "utf8").split("\n");
for (const line of envLines) { const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Get schema
const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log("Tables:", tables.rows.map(r => r.name));

const runsSchema = await client.execute("PRAGMA table_info(poller_runs)");
console.log("\npoller_runs columns:", runsSchema.rows.map(r => `${r.name} (${r.type})`));

const snapsSchema = await client.execute("PRAGMA table_info(price_snapshots)");
console.log("\nprice_snapshots columns:", snapsSchema.rows.map(r => `${r.name} (${r.type})`));

// Sample poller_runs
const sample = await client.execute("SELECT * FROM poller_runs ORDER BY started_at DESC LIMIT 5");
console.log("\nSample poller_runs:", JSON.stringify(sample.rows, null, 2));

// Distinct sources
const sources = await client.execute("SELECT DISTINCT source FROM poller_runs ORDER BY source");
console.log("\nDistinct sources:", sources.rows.map(r => r.source));

// Enabled vendors
const enabled = await client.execute("SELECT COUNT(*) as cnt FROM provider_vendors WHERE enabled = 1");
console.log("\nEnabled vendors:", enabled.rows[0].cnt);

// Hourly coverage 24h
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

// Spot-specific: check if there's spot data in price_snapshots
const spotSample = await client.execute(`
  SELECT DISTINCT vendor FROM price_snapshots
  WHERE scraped_at > datetime('now', '-6 hours')
  ORDER BY vendor
`);
console.log("\nDistinct vendors in snapshots (6h):", spotSample.rows.map(r => r.vendor));
