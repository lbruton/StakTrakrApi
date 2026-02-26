#!/usr/bin/env node
/**
 * StakTrakr Provider Database Module
 * ===================================
 * Single source of truth for provider configuration (coins + vendors).
 * Reads/writes Turso cloud DB. Falls back to local providers.json if
 * Turso is unreachable.
 *
 * All consumers (price-extract, capture, api-export, dashboard) import
 * from this module instead of reading providers.json directly.
 *
 * @see STAK-348 — Migrate providers.json to Turso DB
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Schema — provider_coins + provider_vendors
// ---------------------------------------------------------------------------

const CREATE_PROVIDER_COINS = `
  CREATE TABLE IF NOT EXISTS provider_coins (
    slug        TEXT PRIMARY KEY,
    metal       TEXT NOT NULL,
    name        TEXT NOT NULL,
    weight_oz   REAL NOT NULL DEFAULT 1.0,
    fbp_url     TEXT,
    notes       TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const CREATE_PROVIDER_VENDORS = `
  CREATE TABLE IF NOT EXISTS provider_vendors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_slug   TEXT NOT NULL REFERENCES provider_coins(slug),
    vendor_id   TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    url         TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    selector    TEXT,
    hints       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(coin_slug, vendor_id)
  );
`;

const CREATE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_pv_coin ON provider_vendors(coin_slug);",
  "CREATE INDEX IF NOT EXISTS idx_pv_vendor ON provider_vendors(vendor_id);",
  "CREATE INDEX IF NOT EXISTS idx_pv_enabled ON provider_vendors(coin_slug, enabled);",
];

/**
 * Initialize provider tables + indexes. Idempotent — safe to call on every
 * startup. Does NOT interfere with existing price_snapshots or poller_runs
 * tables managed by turso-client.js.
 *
 * @param {import("@libsql/client").Client} client
 */
export async function initProviderSchema(client) {
  await client.execute(CREATE_PROVIDER_COINS);
  await client.execute(CREATE_PROVIDER_VENDORS);
  for (const sql of CREATE_INDEXES) {
    await client.execute(sql);
  }
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Load all provider data from Turso, shaped to match providers.json:
 *
 *   { coins: { [slug]: { metal, name, weight_oz, fbp_url, notes, providers: [...] } } }
 *
 * @param {import("@libsql/client").Client} client
 * @returns {Promise<object>}
 */
export async function getProviders(client) {
  const coinsResult = await client.execute(
    "SELECT slug, metal, name, weight_oz, fbp_url, notes, enabled FROM provider_coins ORDER BY slug"
  );
  const vendorsResult = await client.execute(
    "SELECT coin_slug, vendor_id, vendor_name, url, enabled, selector, hints FROM provider_vendors ORDER BY coin_slug, vendor_id"
  );

  // Index vendors by coin_slug for fast lookup
  const vendorsByCoin = new Map();
  for (const row of vendorsResult.rows) {
    const slug = row.coin_slug;
    if (!vendorsByCoin.has(slug)) vendorsByCoin.set(slug, []);
    vendorsByCoin.get(slug).push({
      id: row.vendor_id,
      name: row.vendor_name,
      enabled: row.enabled === 1,
      url: row.url || undefined,
      ...(row.selector ? { selector: row.selector } : {}),
      ...(row.hints ? { hints: row.hints } : {}),
    });
  }

  const coins = {};
  for (const row of coinsResult.rows) {
    coins[row.slug] = {
      name: row.name,
      metal: row.metal,
      weight_oz: row.weight_oz,
      ...(row.fbp_url ? { fbp_url: row.fbp_url } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      providers: vendorsByCoin.get(row.slug) || [],
    };
  }

  return { coins };
}

/**
 * Get vendors for a specific coin.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} coinSlug
 * @returns {Promise<Array<object>>}
 */
export async function getProvidersByCoin(client, coinSlug) {
  const result = await client.execute({
    sql: "SELECT vendor_id, vendor_name, url, enabled, selector, hints FROM provider_vendors WHERE coin_slug = ? ORDER BY vendor_id",
    args: [coinSlug],
  });
  return result.rows.map((row) => ({
    id: row.vendor_id,
    name: row.vendor_name,
    url: row.url,
    enabled: row.enabled === 1,
    ...(row.selector ? { selector: row.selector } : {}),
    ...(row.hints ? { hints: row.hints } : {}),
  }));
}

/**
 * Get all coins (without vendors).
 *
 * @param {import("@libsql/client").Client} client
 * @returns {Promise<Array<object>>}
 */
export async function getAllCoins(client) {
  const result = await client.execute(
    "SELECT slug, metal, name, weight_oz, fbp_url, notes, enabled FROM provider_coins ORDER BY slug"
  );
  return result.rows.map((row) => ({
    slug: row.slug,
    metal: row.metal,
    name: row.name,
    weight_oz: row.weight_oz,
    fbp_url: row.fbp_url,
    notes: row.notes,
    enabled: row.enabled === 1,
  }));
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Insert or update a coin.
 *
 * @param {import("@libsql/client").Client} client
 * @param {object} coin
 * @param {string} coin.slug
 * @param {string} coin.metal
 * @param {string} coin.name
 * @param {number} [coin.weight_oz=1.0]
 * @param {string} [coin.fbp_url]
 * @param {string} [coin.notes]
 * @param {boolean} [coin.enabled=true]
 */
export async function upsertCoin(client, coin) {
  await client.execute({
    sql: `
      INSERT INTO provider_coins (slug, metal, name, weight_oz, fbp_url, notes, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        metal = excluded.metal,
        name = excluded.name,
        weight_oz = excluded.weight_oz,
        fbp_url = excluded.fbp_url,
        notes = excluded.notes,
        enabled = excluded.enabled,
        updated_at = datetime('now')
    `,
    args: [
      coin.slug,
      coin.metal,
      coin.name,
      coin.weight_oz ?? 1.0,
      coin.fbp_url ?? null,
      coin.notes ?? null,
      coin.enabled !== false ? 1 : 0,
    ],
  });
}

/**
 * Insert or update a vendor for a coin.
 *
 * @param {import("@libsql/client").Client} client
 * @param {object} vendor
 * @param {string} vendor.coin_slug
 * @param {string} vendor.vendor_id
 * @param {string} vendor.vendor_name
 * @param {string} [vendor.url]
 * @param {boolean} [vendor.enabled=true]
 * @param {string} [vendor.selector]
 * @param {string} [vendor.hints]
 */
export async function upsertVendor(client, vendor) {
  await client.execute({
    sql: `
      INSERT INTO provider_vendors (coin_slug, vendor_id, vendor_name, url, enabled, selector, hints, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(coin_slug, vendor_id) DO UPDATE SET
        vendor_name = excluded.vendor_name,
        url = excluded.url,
        enabled = excluded.enabled,
        selector = excluded.selector,
        hints = excluded.hints,
        updated_at = datetime('now')
    `,
    args: [
      vendor.coin_slug,
      vendor.vendor_id,
      vendor.vendor_name,
      vendor.url ?? null,
      vendor.enabled !== false ? 1 : 0,
      vendor.selector ?? null,
      vendor.hints ?? null,
    ],
  });
}

/**
 * Toggle a vendor's enabled flag.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} coinSlug
 * @param {string} vendorId
 * @param {boolean} enabled
 */
export async function toggleVendor(client, coinSlug, vendorId, enabled) {
  await client.execute({
    sql: "UPDATE provider_vendors SET enabled = ?, updated_at = datetime('now') WHERE coin_slug = ? AND vendor_id = ?",
    args: [enabled ? 1 : 0, coinSlug, vendorId],
  });
}

/**
 * Update a vendor's URL.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} coinSlug
 * @param {string} vendorId
 * @param {string} url
 */
export async function updateVendorUrl(client, coinSlug, vendorId, url) {
  await client.execute({
    sql: "UPDATE provider_vendors SET url = ?, updated_at = datetime('now') WHERE coin_slug = ? AND vendor_id = ?",
    args: [url, coinSlug, vendorId],
  });
}

// ---------------------------------------------------------------------------
// Export — generates providers.json content from Turso
// ---------------------------------------------------------------------------

/**
 * Generate a JSON string matching the current providers.json format.
 * Used by run-publish.sh to write the file before pushing to the api branch.
 *
 * @param {import("@libsql/client").Client} client
 * @returns {Promise<string>}  JSON string (pretty-printed, 2-space indent)
 */
export async function exportProvidersJson(client) {
  const data = await getProviders(client);
  return JSON.stringify(data, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Fallback — read from local providers.json when Turso is unreachable
// ---------------------------------------------------------------------------

/**
 * Read providers.json from the local filesystem.
 * Used as fallback when Turso is down.
 *
 * @param {string} dataDir  Path to the data/ folder
 * @returns {object}  Parsed providers.json
 */
export function loadProvidersFromFile(dataDir) {
  const filePath = join(dataDir, "retail", "providers.json");
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * Load providers with Turso-first, file-fallback strategy.
 * Logs which path was taken.
 *
 * @param {import("@libsql/client").Client|null} client  Turso client (null to skip)
 * @param {string} dataDir  Path to the data/ folder (for fallback)
 * @returns {Promise<object>}  Provider data in providers.json shape
 */
export async function loadProviders(client, dataDir) {
  if (client) {
    try {
      const data = await getProviders(client);
      const coinCount = Object.keys(data.coins).length;
      console.log(`[provider-db] Loaded ${coinCount} coins from Turso`);
      return data;
    } catch (err) {
      console.warn(`[provider-db] Turso failed, falling back to file: ${err.message}`);
    }
  }
  const data = loadProvidersFromFile(dataDir);
  const coinCount = Object.keys(data.coins).length;
  console.log(`[provider-db] Loaded ${coinCount} coins from local file (fallback)`);
  return data;
}
