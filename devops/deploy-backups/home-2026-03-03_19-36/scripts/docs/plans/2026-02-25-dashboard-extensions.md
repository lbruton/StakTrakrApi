# Dashboard Extensions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Grafana monitoring, a provider URL editor page, and a failure queue page to the StakTrakr home poller dashboard.

**Architecture:** A new `metrics-exporter.js` service exposes Prometheus metrics on port 9100 (system stats + Turso data); Grafana scrapes it. Two new routes in `dashboard.js` (`/providers`, `/failures`) handle provider CRUD and failure display. A new `provider_failures` Turso table is written by the poller on each failure and queried by the failure page.

**Tech Stack:** Node.js (ESM), @libsql/client, supervisord, Grafana OSS (apt), Prometheus text format

---

## Context: Key Files

| File | Role |
|------|------|
| `/opt/poller/dashboard.js` | Main dashboard HTTP server — add new routes here |
| `/opt/poller/db.js` | Turso helper functions — add `logProviderFailure()` here |
| `/opt/poller/turso-client.js` | Schema init — add `provider_failures` table here |
| `/opt/poller/price-extract.js` | Scraper — call `logProviderFailure()` after each failed scrape result |
| `/opt/poller/data/retail/providers.json` | Provider config — the `/providers` editor reads/writes this file |
| `/etc/supervisor/conf.d/staktrakr.conf` | Supervisord — add `[program:metrics-exporter]` entry |
| `/opt/poller/.env` | Secrets — TURSO_DATABASE_URL, TURSO_AUTH_TOKEN already set |

---

## Task 1: Add `provider_failures` table to Turso schema

**Files:**
- Modify: `/opt/poller/turso-client.js`

**Step 1: Add the table creation to `initTursoSchema()`**

Open `/opt/poller/turso-client.js`. At the end of the `initTursoSchema` function, after the existing `poller_runs` index, add:

```js
  // Provider failure log — one row per failure per run, written by each poller
  await client.execute(`
    CREATE TABLE IF NOT EXISTS provider_failures (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      poller_id   TEXT NOT NULL,
      coin_id     TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      url         TEXT NOT NULL,
      error       TEXT,
      failed_at   TEXT NOT NULL
    );
  `);

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_pf_provider_failed ON provider_failures(provider_id, failed_at DESC);"
  );
```

**Step 2: Run schema init manually to create the table**

```bash
cd /opt/poller
node -e "
import('./turso-client.js').then(async ({createTursoClient, initTursoSchema}) => {
  // Load .env
  const {readFileSync} = await import('node:fs');
  for (const line of readFileSync('.env','utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)\$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  const client = createTursoClient();
  await initTursoSchema(client);
  await client.close();
  console.log('Schema init OK');
});
"
```

Expected: `Schema init OK`

**Step 3: Verify table exists**

```bash
cd /opt/poller
node -e "
import('./turso-client.js').then(async ({createTursoClient}) => {
  const {readFileSync} = await import('node:fs');
  for (const line of readFileSync('.env','utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)\$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  const client = createTursoClient();
  const r = await client.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name='provider_failures'\");
  console.log('Table exists:', r.rows.length > 0);
  await client.close();
});
"
```

Expected: `Table exists: true`

**Step 4: Commit**

```bash
cd /opt/poller
sudo git add turso-client.js
sudo git -c user.name=lbruton -c user.email=lbruton@lonniebruton.com commit -m "feat: add provider_failures table to Turso schema"
```

---

## Task 2: Add `logProviderFailure()` to db.js

**Files:**
- Modify: `/opt/poller/db.js`

**Step 1: Add the function after `finishRunLog()`**

Open `/opt/poller/db.js`. After the `finishRunLog` export, add:

```js
/**
 * Log a single provider scrape failure to Turso.
 * Called once per failed provider per run.
 *
 * @param {import("@libsql/client").Client} client
 * @param {object} opts
 * @param {string} opts.pollerId    - e.g. "home", "fly"
 * @param {string} opts.coinId      - e.g. "ase"
 * @param {string} opts.providerId  - e.g. "jmbullion"
 * @param {string} opts.url         - final URL attempted
 * @param {string} [opts.error]     - short error reason
 */
export async function logProviderFailure(client, { pollerId, coinId, providerId, url, error }) {
  if (!client) return;
  try {
    await client.execute({
      sql: `INSERT INTO provider_failures (poller_id, coin_id, provider_id, url, error, failed_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [pollerId, coinId, providerId, url, error ?? null, new Date().toISOString()],
    });
  } catch (err) {
    // Non-fatal — don't interrupt the poller run
    console.warn(`[db] logProviderFailure failed (non-fatal): ${err.message}`);
  }
}
```

**Step 2: Commit**

```bash
cd /opt/poller
sudo git add db.js
sudo git -c user.name=lbruton -c user.email=lbruton@lonniebruton.com commit -m "feat: add logProviderFailure() to db.js"
```

---

## Task 3: Call `logProviderFailure()` from price-extract.js

**Files:**
- Modify: `/opt/poller/price-extract.js`

**Step 1: Import `logProviderFailure`**

Find the existing import line near the top of `price-extract.js` that imports from `./db.js`. Add `logProviderFailure` to it:

```js
// Before:
import { windowFloor, startRunLog, finishRunLog, writeSnapshot, readTodayFailures } from "./db.js";

// After:
import { windowFloor, startRunLog, finishRunLog, writeSnapshot, readTodayFailures, logProviderFailure } from "./db.js";
```

**Step 2: Find the scrape results loop**

Locate the section after the per-coin scrape loop where `scrapeResults` is processed and `writeSnapshot` is called. It looks like:

```js
scrapeResults.push({
  coinSlug, coin, providerId: provider.id, url: finalUrl,
  price, source, ok: price !== null,
  error: price === null ? (inStock ? "price_not_found" : "out_of_stock") : null,
});
```

Immediately after the `scrapeResults.push(...)` block (and after the existing `writeSnapshot` call), add:

```js
    // Log failure to Turso provider_failures table
    if (price === null && inStock && db) {
      await logProviderFailure(db, {
        pollerId: process.env.POLLER_ID || "home",
        coinId: coinSlug,
        providerId: provider.id,
        url: finalUrl,
        error: "price_not_found",
      });
    }
```

Note: Only log when `inStock` is true — out-of-stock is not a scraper failure.

**Step 3: Verify the file still parses cleanly**

```bash
cd /opt/poller
node --input-type=module --eval "import './price-extract.js'" 2>&1 | head -5
```

Expected: no output (clean import, no syntax errors). It will not execute since there's no `RUN` env var set.

**Step 4: Commit**

```bash
cd /opt/poller
sudo git add price-extract.js
sudo git -c user.name=lbruton -c user.email=lbruton@lonniebruton.com commit -m "feat: log provider failures to Turso on each scrape failure"
```

---

## Task 4: Add `/providers` route to dashboard.js

**Files:**
- Modify: `/opt/poller/dashboard.js`

This adds two things: a `GET /providers` HTML page (table editor) and a `POST /providers` handler (saves JSON).

**Step 1: Add providers helper functions**

Near the top of `dashboard.js`, after the existing `import` statements, add:

```js
import { readFileSync, writeFileSync } from "node:fs";

const PROVIDERS_FILE = new URL("data/retail/providers.json", import.meta.url).pathname;

function readProviders() {
  return JSON.parse(readFileSync(PROVIDERS_FILE, "utf8"));
}

function writeProviders(data) {
  writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}
```

Note: `readFileSync` is already imported — just add `writeFileSync` to the existing import.

**Step 2: Add `renderProvidersPage()` function**

Add this function before `renderHtml()`:

```js
function renderProvidersPage(providers) {
  const coins = providers.coins || {};
  let rows = "";

  for (const [coinId, coin] of Object.entries(coins)) {
    rows += `<tr class="coin-header"><td colspan="4"><strong>${escHtml(coin.name)}</strong> <code>${escHtml(coinId)}</code></td></tr>`;
    for (let i = 0; i < (coin.providers || []).length; i++) {
      const p = coin.providers[i];
      rows += `<tr>
        <td><input type="checkbox" name="enabled_${escHtml(coinId)}_${i}" ${p.enabled !== false ? "checked" : ""}></td>
        <td><code>${escHtml(p.id)}</code></td>
        <td><input type="text" name="url_${escHtml(coinId)}_${i}" value="${escHtml(p.url || "")}" style="width:100%"></td>
        <td><button type="button" class="btn-del" data-coin="${escHtml(coinId)}" data-idx="${i}">Remove</button></td>
      </tr>`;
    }
    rows += `<tr><td colspan="4"><button type="button" class="btn-add" data-coin="${escHtml(coinId)}">+ Add provider to ${escHtml(coinId)}</button></td></tr>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Provider Editor — StakTrakr</title>
<style>
  :root { --bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8; }
  * { box-sizing:border-box;margin:0;padding:0; }
  body { background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;padding:20px; }
  h1 { color:var(--accent);margin-bottom:16px; }
  a { color:var(--muted);font-size:12px; }
  table { width:100%;border-collapse:collapse;margin-bottom:24px; }
  th { text-align:left;padding:6px 8px;color:var(--muted);font-size:11px;text-transform:uppercase;border-bottom:2px solid var(--border); }
  td { padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:middle; }
  tr.coin-header td { background:var(--surface);padding:10px 8px;border-top:2px solid var(--border);border-bottom:none; }
  input[type=text] { background:#0f172a;border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:4px;font-size:13px; }
  input[type=text]:focus { outline:none;border-color:var(--accent); }
  button { cursor:pointer;border:none;border-radius:4px;padding:4px 10px;font-size:12px;font-weight:600; }
  .btn-del { background:#7f1d1d;color:#fca5a5; }
  .btn-add { background:#1e3a5f;color:var(--accent); }
  .btn-save { background:#166534;color:#86efac;padding:10px 28px;font-size:14px;margin-top:16px; }
  .msg { padding:10px;border-radius:4px;margin-bottom:16px; }
  .msg-ok { background:#14532d;color:#86efac; }
  .msg-err { background:#7f1d1d;color:#fca5a5; }
</style>
</head>
<body>
<h1>Provider URL Editor</h1>
<a href="/">← Dashboard</a> &nbsp; <a href="/failures">Failure Queue →</a>
<br><br>
<div id="msg"></div>
<form id="pform">
<table>
  <thead><tr><th>Enabled</th><th>Provider ID</th><th>URL</th><th></th></tr></thead>
  <tbody id="ptbody">${rows}</tbody>
</table>
<button type="submit" class="btn-save">Save All Changes</button>
</form>
<script>
// Serialize form to JSON matching providers.json structure, then POST
const form = document.getElementById('pform');
const msg  = document.getElementById('msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = JSON.stringify(buildPayload());
  const r = await fetch('/providers', { method:'POST', headers:{'Content-Type':'application/json'}, body });
  const j = await r.json();
  msg.className = 'msg ' + (r.ok ? 'msg-ok' : 'msg-err');
  msg.textContent = j.message || (r.ok ? 'Saved.' : 'Error saving.');
  window.scrollTo(0,0);
});

function buildPayload() {
  // Re-parse current DOM state into providers structure
  const data = ${JSON.stringify(providers)};
  const tbody = document.getElementById('ptbody');
  for (const [coinId, coin] of Object.entries(data.coins || {})) {
    const enabledInputs = tbody.querySelectorAll('[name^="enabled_' + coinId + '_"]');
    const urlInputs     = tbody.querySelectorAll('[name^="url_'     + coinId + '_"]');
    for (let i = 0; i < (coin.providers || []).length; i++) {
      coin.providers[i].enabled = enabledInputs[i]?.checked ?? true;
      coin.providers[i].url     = urlInputs[i]?.value ?? coin.providers[i].url;
    }
  }
  return data;
}

// Remove provider row
document.getElementById('ptbody').addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-del')) {
    e.target.closest('tr').remove();
  }
});
</script>
</body>
</html>`;
}
```

**Step 3: Add POST body reader helper**

Add this utility function near the top of the server section:

```js
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
```

**Step 4: Update `handleRequest()` to route `/providers`**

In `handleRequest()`, replace the current 404 check with an expanded router:

```js
async function handleRequest(req, res) {
  const url = req.url.split("?")[0];

  // ── GET /providers ──────────────────────────────────────────────────────
  if (req.method === "GET" && url === "/providers") {
    const providers = readProviders();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderProvidersPage(providers));
    return;
  }

  // ── POST /providers ─────────────────────────────────────────────────────
  if (req.method === "POST" && url === "/providers") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      // Basic sanity check
      if (!data.coins || typeof data.coins !== "object") throw new Error("Invalid providers structure");
      writeProviders(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Saved successfully." }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: err.message }));
    }
    return;
  }

  // ── GET / (dashboard home) ───────────────────────────────────────────────
  if (req.method === "GET" && (url === "/" || url === "/dashboard" || url === "")) {
    // ... existing dashboard code ...
  }

  res.writeHead(404);
  res.end("Not found");
}
```

**Step 5: Add nav link to main dashboard**

In `renderHtml()`, find the `<header>` section and add navigation links:

```js
// In the header HTML string, after the h1 tag, add:
<nav style="display:flex;gap:16px;">
  <a href="/providers" style="color:var(--accent);font-size:13px;">Provider Editor</a>
  <a href="/failures" style="color:var(--accent);font-size:13px;">Failure Queue</a>
</nav>
```

**Step 6: Restart dashboard and verify**

```bash
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf restart dashboard
sleep 2
curl -s http://localhost:3010/providers | grep -c "Provider URL Editor"
```

Expected: `1`

**Step 7: Commit**

```bash
cd /opt/poller
sudo git add dashboard.js
sudo git -c user.name=lbruton -c user.email=lbruton@lonniebruton.com commit -m "feat: add /providers URL editor page to dashboard"
```

---

## Task 5: Add `/failures` route to dashboard.js

**Files:**
- Modify: `/opt/poller/dashboard.js`

**Step 1: Add `fetchFailuresFromTurso()` function**

Add this function near `fetchRunsFromTurso()`:

```js
async function fetchFailuresFromTurso() {
  const client = getTursoClient();
  if (!client) return null;
  try {
    const result = await client.execute({
      sql: `
        SELECT coin_id, provider_id, url,
               COUNT(*) as failure_count,
               MAX(failed_at) as last_failed,
               MAX(error) as last_error
        FROM provider_failures
        WHERE failed_at > datetime('now', '-10 days')
        GROUP BY coin_id, provider_id, url
        HAVING COUNT(*) >= 3
        ORDER BY failure_count DESC
      `,
      args: [],
    });
    await client.close();
    return result.rows;
  } catch (err) {
    try { await client.close(); } catch { /* ignore */ }
    return null;
  }
}
```

**Step 2: Add `renderFailuresPage()` function**

```js
function renderFailuresPage(failures) {
  const now = new Date().toUTCString();
  const isEmpty = !failures || failures.length === 0;

  const rows = isEmpty ? "" : failures.map(f => {
    const age = f.last_failed
      ? Math.round((Date.now() - new Date(f.last_failed)) / 1000)
      : null;
    const ageStr = age != null ? (age < 3600 ? `${Math.round(age/60)}m ago` : `${Math.round(age/3600)}h ago`) : "?";

    return `<tr>
      <td><code>${escHtml(f.coin_id)}</code></td>
      <td>${escHtml(f.provider_id)}</td>
      <td class="url-cell">
        <span class="url-text" id="url_${escHtml(f.coin_id)}_${escHtml(f.provider_id)}">${escHtml(f.url)}</span>
        <input type="text" class="url-edit" data-coin="${escHtml(f.coin_id)}" data-provider="${escHtml(f.provider_id)}" value="${escHtml(f.url)}" style="display:none;width:70%">
      </td>
      <td style="color:#f87171;font-weight:700">${escHtml(String(f.failure_count))}</td>
      <td style="color:var(--muted);font-size:12px">${ageStr}</td>
      <td style="color:var(--muted);font-size:11px">${escHtml(f.last_error || "")}</td>
      <td style="white-space:nowrap">
        <button class="btn-edit" data-coin="${escHtml(f.coin_id)}" data-provider="${escHtml(f.provider_id)}">Edit URL</button>
        <button class="btn-copy" data-url="${escHtml(f.url)}">Copy</button>
        <button class="btn-disable" data-coin="${escHtml(f.coin_id)}" data-provider="${escHtml(f.provider_id)}">Disable</button>
      </td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Failure Queue — StakTrakr</title>
<style>
  :root { --bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8; }
  * { box-sizing:border-box;margin:0;padding:0; }
  body { background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;padding:20px; }
  h1 { color:var(--accent);margin-bottom:4px; }
  .subtitle { color:var(--muted);font-size:12px;margin-bottom:16px; }
  a { color:var(--muted);font-size:12px; }
  table { width:100%;border-collapse:collapse; }
  th { text-align:left;padding:6px 8px;color:var(--muted);font-size:11px;text-transform:uppercase;border-bottom:2px solid var(--border); }
  td { padding:8px;border-bottom:1px solid var(--border);vertical-align:middle; }
  .url-cell { max-width:400px;word-break:break-all;font-size:12px;color:var(--muted); }
  input[type=text] { background:#0f172a;border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:4px;font-size:12px; }
  button { cursor:pointer;border:none;border-radius:4px;padding:3px 10px;font-size:12px;font-weight:600;margin-right:4px; }
  .btn-edit { background:#1e3a5f;color:var(--accent); }
  .btn-copy { background:#1c2c1c;color:#86efac; }
  .btn-disable { background:#7f1d1d;color:#fca5a5; }
  .btn-save-url { background:#166534;color:#86efac; }
  .empty { color:var(--muted);font-style:italic;padding:24px 0; }
  .msg { padding:10px;border-radius:4px;margin-bottom:16px; }
  .msg-ok { background:#14532d;color:#86efac; }
  .msg-err { background:#7f1d1d;color:#fca5a5; }
</style>
</head>
<body>
<h1>Failure Queue</h1>
<p class="subtitle">URLs with 3+ failures in the last 10 days &bull; Auto-refreshes every 5 min &bull; ${now}</p>
<a href="/">← Dashboard</a> &nbsp; <a href="/providers">Provider Editor →</a>
<br><br>
<div id="msg"></div>
${isEmpty
  ? '<p class="empty">No failing providers — all URLs passing threshold.</p>'
  : `<table>
  <thead><tr>
    <th>Coin</th><th>Provider</th><th>URL</th><th>Failures (10d)</th><th>Last Failed</th><th>Last Error</th><th>Actions</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`}
<script>
const msg = document.getElementById('msg');

function showMsg(text, ok) {
  msg.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
  msg.textContent = text;
  window.scrollTo(0,0);
}

// Edit URL toggle
document.querySelectorAll('.btn-edit').forEach(btn => {
  btn.addEventListener('click', () => {
    const coin = btn.dataset.coin, provider = btn.dataset.provider;
    const span = document.getElementById('url_' + coin + '_' + provider);
    const input = span.nextElementSibling;
    const isEditing = input.style.display !== 'none';
    if (isEditing) {
      span.style.display = '';
      input.style.display = 'none';
      btn.textContent = 'Edit URL';
    } else {
      span.style.display = 'none';
      input.style.display = '';
      btn.textContent = 'Save';
      // On save
      btn.onclick = async () => {
        const r = await fetch('/providers/update-url', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ coinId: coin, providerId: provider, url: input.value })
        });
        const j = await r.json();
        showMsg(j.message, r.ok);
        if (r.ok) { span.textContent = input.value; span.style.display=''; input.style.display='none'; btn.textContent='Edit URL'; btn.onclick=null; }
      };
    }
  });
});

// Copy URL
document.querySelectorAll('.btn-copy').forEach(btn => {
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(btn.dataset.url).then(() => showMsg('URL copied to clipboard.', true));
  });
});

// Disable provider
document.querySelectorAll('.btn-disable').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!confirm('Disable ' + btn.dataset.provider + ' for ' + btn.dataset.coin + '?')) return;
    const r = await fetch('/providers/disable', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ coinId: btn.dataset.coin, providerId: btn.dataset.provider })
    });
    const j = await r.json();
    showMsg(j.message, r.ok);
    if (r.ok) btn.closest('tr').style.opacity = '0.4';
  });
});
</script>
</body>
</html>`;
}
```

**Step 3: Add `/providers/update-url` and `/providers/disable` POST handlers**

In `handleRequest()`, add these routes before the 404 fallback:

```js
  // ── POST /providers/update-url ───────────────────────────────────────────
  if (req.method === "POST" && url === "/providers/update-url") {
    try {
      const { coinId, providerId, url: newUrl } = JSON.parse(await readBody(req));
      const data = readProviders();
      const provider = data.coins[coinId]?.providers?.find(p => p.id === providerId);
      if (!provider) throw new Error(`Provider ${providerId} not found in ${coinId}`);
      provider.url = newUrl;
      writeProviders(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: `Updated ${providerId}/${coinId} URL.` }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: err.message }));
    }
    return;
  }

  // ── POST /providers/disable ─────────────────────────────────────────────
  if (req.method === "POST" && url === "/providers/disable") {
    try {
      const { coinId, providerId } = JSON.parse(await readBody(req));
      const data = readProviders();
      const provider = data.coins[coinId]?.providers?.find(p => p.id === providerId);
      if (!provider) throw new Error(`Provider ${providerId} not found in ${coinId}`);
      provider.enabled = false;
      writeProviders(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: `Disabled ${providerId}/${coinId}.` }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: err.message }));
    }
    return;
  }

  // ── GET /failures ────────────────────────────────────────────────────────
  if (req.method === "GET" && url === "/failures") {
    const failures = await fetchFailuresFromTurso().catch(() => null);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderFailuresPage(failures));
    return;
  }
```

**Step 4: Restart dashboard and verify routes**

```bash
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf restart dashboard
sleep 2
curl -s http://localhost:3010/failures | grep -c "Failure Queue"
```

Expected: `1`

**Step 5: Commit**

```bash
cd /opt/poller
sudo git add dashboard.js
sudo git -c user.name=lbruton -c user.email=lbruton@lonniebruton.com commit -m "feat: add /failures queue page with edit/disable/copy actions"
```

---

## Task 6: Create metrics-exporter.js

**Files:**
- Create: `/opt/poller/metrics-exporter.js`

**Step 1: Create the exporter**

```js
#!/usr/bin/env node
/**
 * StakTrakr Prometheus Metrics Exporter
 * =======================================
 * Exposes /metrics on port 9100 in Prometheus text format.
 * Scraped by Grafana's Prometheus datasource every 15s.
 *
 * Sources:
 *   - /proc (CPU, memory, network, uptime)
 *   - supervisorctl + systemctl (service health)
 *   - Turso poller_runs (last run stats per poller)
 *   - Turso provider_failures (failure queue stats)
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createClient } from "@libsql/client";

const PORT = parseInt(process.env.METRICS_PORT || "9100", 10);
const IFACE = process.env.NET_IFACE || "ens18";

// Load .env
(function loadEnv() {
  const envFile = new URL(".env", import.meta.url).pathname;
  if (!existsSync(envFile)) return;
  const lines = readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

function getTursoClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) return null;
  return createClient({ url, authToken });
}

// ── System collectors ────────────────────────────────────────────────────────

function collectSystem() {
  const metrics = [];

  // Uptime
  try {
    const secs = parseFloat(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    metrics.push(`poller_uptime_seconds ${secs}`);
  } catch { metrics.push("poller_uptime_seconds 0"); }

  // CPU load
  try {
    const [l1, l5, l15] = readFileSync("/proc/loadavg", "utf8").trim().split(" ");
    metrics.push(`poller_cpu_load1 ${l1}`);
    metrics.push(`poller_cpu_load5 ${l5}`);
    metrics.push(`poller_cpu_load15 ${l15}`);
  } catch {}

  // Memory
  try {
    const mem = readFileSync("/proc/meminfo", "utf8");
    const total = parseInt(mem.match(/MemTotal:\s+(\d+)/)[1], 10);
    const avail = parseInt(mem.match(/MemAvailable:\s+(\d+)/)[1], 10);
    metrics.push(`poller_mem_used_pct ${(((total - avail) / total) * 100).toFixed(2)}`);
    metrics.push(`poller_mem_total_bytes ${total * 1024}`);
    metrics.push(`poller_mem_avail_bytes ${avail * 1024}`);
  } catch {}

  // Network
  try {
    const raw = readFileSync("/proc/net/dev", "utf8");
    const line = raw.split("\n").find(l => l.trim().startsWith(IFACE + ":"));
    if (line) {
      const cols = line.trim().split(/\s+/);
      metrics.push(`poller_net_rx_bytes{iface="${IFACE}"} ${cols[1]}`);
      metrics.push(`poller_net_tx_bytes{iface="${IFACE}"} ${cols[9]}`);
    }
  } catch {}

  return metrics;
}

// ── Service health ───────────────────────────────────────────────────────────

function collectServices() {
  const metrics = [];

  // Supervisord
  try {
    const out = execSync("supervisorctl status 2>/dev/null", { timeout: 3000 }).toString();
    for (const line of out.trim().split("\n")) {
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (m) {
        metrics.push(`poller_service_up{service="${m[1]}",manager="supervisord"} ${m[2] === "RUNNING" ? 1 : 0}`);
      }
    }
  } catch {}

  // Systemd
  for (const svc of ["redis-server", "rabbitmq-server", "cron", "tailscaled", "tinyproxy"]) {
    try {
      execSync(`systemctl is-active --quiet ${svc}`, { timeout: 2000 });
      metrics.push(`poller_service_up{service="${svc}",manager="systemd"} 1`);
    } catch {
      metrics.push(`poller_service_up{service="${svc}",manager="systemd"} 0`);
    }
  }

  return metrics;
}

// ── Turso metrics ────────────────────────────────────────────────────────────

async function collectTurso() {
  const metrics = [];
  const client = getTursoClient();
  if (!client) {
    metrics.push("poller_turso_up 0");
    return metrics;
  }

  try {
    // Ping
    await client.execute("SELECT 1");
    metrics.push("poller_turso_up 1");

    // Last run per poller
    const runs = await client.execute(`
      SELECT poller_id, captured, failures, total, started_at, finished_at
      FROM poller_runs
      WHERE (poller_id, started_at) IN (
        SELECT poller_id, MAX(started_at) FROM poller_runs GROUP BY poller_id
      )
    `);

    for (const r of runs.rows) {
      const pid = r.poller_id;
      const captured = r.captured ?? 0;
      const failures = r.failures ?? 0;
      const total = r.total ?? 0;
      const rate = total > 0 ? (captured / total) : 0;
      let durationSecs = 0;
      if (r.started_at && r.finished_at) {
        durationSecs = (new Date(r.finished_at) - new Date(r.started_at)) / 1000;
      }
      metrics.push(`poller_run_captured{poller_id="${pid}"} ${captured}`);
      metrics.push(`poller_run_failures{poller_id="${pid}"} ${failures}`);
      metrics.push(`poller_run_total{poller_id="${pid}"} ${total}`);
      metrics.push(`poller_run_capture_rate{poller_id="${pid}"} ${rate.toFixed(4)}`);
      metrics.push(`poller_run_duration_seconds{poller_id="${pid}"} ${durationSecs.toFixed(1)}`);
    }

    // Provider failure counts (last 10 days)
    const pfail = await client.execute(`
      SELECT coin_id, provider_id, COUNT(*) as cnt
      FROM provider_failures
      WHERE failed_at > datetime('now', '-10 days')
      GROUP BY coin_id, provider_id
    `);
    for (const r of pfail.rows) {
      metrics.push(`poller_provider_failures_total{coin_id="${r.coin_id}",provider_id="${r.provider_id}"} ${r.cnt}`);
    }

    // Total currently-failing providers (≥3 failures in 10 days)
    const fcount = await client.execute(`
      SELECT COUNT(*) as cnt FROM (
        SELECT provider_id FROM provider_failures
        WHERE failed_at > datetime('now', '-10 days')
        GROUP BY coin_id, provider_id, url
        HAVING COUNT(*) >= 3
      )
    `);
    metrics.push(`poller_failing_providers_count ${fcount.rows[0]?.cnt ?? 0}`);

    await client.close();
  } catch (err) {
    try { await client.close(); } catch {}
    metrics.push("poller_turso_up 0");
    console.error("[metrics] Turso error:", err.message);
  }

  return metrics;
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.url !== "/metrics") {
    res.writeHead(404);
    res.end("Not found — use /metrics");
    return;
  }

  const [system, services, turso] = await Promise.all([
    Promise.resolve(collectSystem()),
    Promise.resolve(collectServices()),
    collectTurso(),
  ]);

  const body = [...system, ...services, ...turso].join("\n") + "\n";
  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
  res.end(body);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[metrics-exporter] Listening on http://0.0.0.0:${PORT}/metrics`);
});
```

**Step 2: Test it runs**

```bash
cd /opt/poller
node metrics-exporter.js &
sleep 2
curl -s http://localhost:9100/metrics | head -20
kill %1
```

Expected: Prometheus metric lines like `poller_uptime_seconds 12345`, `poller_turso_up 1`, etc.

**Step 3: Commit**

```bash
cd /opt/poller
sudo git add metrics-exporter.js
sudo git -c user.name=lbruton -c user.email=lbruton@lonniebruton.com commit -m "feat: add Prometheus metrics exporter (port 9100)"
```

---

## Task 7: Add metrics-exporter to supervisord

**Files:**
- Modify: `/etc/supervisor/conf.d/staktrakr.conf`

**Step 1: Append to the conf file**

Add at the end of `/etc/supervisor/conf.d/staktrakr.conf`:

```ini
; ── Metrics Exporter (Prometheus, port 9100) ──────────────────────────────

[program:metrics-exporter]
command=node /opt/poller/metrics-exporter.js
directory=/opt/poller
autorestart=true
priority=25
environment=METRICS_PORT="9100",NET_IFACE="ens18"
stdout_logfile=/var/log/supervisor/metrics-exporter.log
stdout_logfile_maxbytes=5MB
stderr_logfile=/var/log/supervisor/metrics-exporter.log
stderr_logfile_maxbytes=5MB
```

**Step 2: Reload supervisord and verify**

```bash
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf reread
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf update
sleep 3
sudo /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf status metrics-exporter
```

Expected: `metrics-exporter    RUNNING   pid XXXXX, uptime 0:00:XX`

**Step 3: Smoke test**

```bash
curl -s http://localhost:9100/metrics | grep poller_turso_up
```

Expected: `poller_turso_up 1`

**Step 4: Commit**

```bash
sudo git -C /opt/poller add -f /dev/null 2>/dev/null; true  # git is root-owned, manual commit
```

Note: Supervisord conf is at `/etc/supervisor/` (root-owned). Commit this file manually or note the change in a comment — it's a system config file, not in the poller git repo.

---

## Task 8: Install and configure Grafana

**Step 1: Install Grafana OSS**

```bash
sudo apt-get install -y apt-transport-https software-properties-common wget
sudo mkdir -p /etc/apt/keyrings/
wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor | sudo tee /etc/apt/keyrings/grafana.gpg > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt-get update
sudo apt-get install -y grafana
```

**Step 2: Enable and start Grafana**

```bash
sudo systemctl enable grafana-server
sudo systemctl start grafana-server
sleep 3
sudo systemctl status grafana-server | grep Active
```

Expected: `Active: active (running)`

**Step 3: Verify Grafana is up**

```bash
curl -s http://localhost:3000/api/health | grep -o '"database":"ok"'
```

Expected: `"database":"ok"`

Default login: `admin` / `admin` — change on first login at `http://192.168.1.81:3000`.

---

## Task 9: Provision Grafana datasource and dashboards

**Step 1: Create Prometheus datasource provisioning file**

Create `/etc/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://localhost:9100
    isDefault: true
    editable: false
```

Note: Grafana's Prometheus datasource can query our `/metrics` endpoint directly — no actual Prometheus server needed. Grafana treats it as a simple HTTP datasource in "browser" scrape mode, or we use the built-in `prometheus` type which expects a Prometheus API. Since we're serving raw metrics (not a Prometheus API), use the **Infinity** datasource or configure Grafana with an actual Prometheus scrape.

**Correction — Install Prometheus scraper:**

```bash
sudo apt-get install -y prometheus
```

Edit `/etc/prometheus/prometheus.yml` to add our scrape target:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'staktrakr-poller'
    static_configs:
      - targets: ['localhost:9100']
```

```bash
sudo systemctl enable prometheus
sudo systemctl restart prometheus
sleep 3
curl -s http://localhost:9090/api/v1/query?query=poller_turso_up | grep -o '"value"'
```

Expected: `"value"` (Prometheus has scraped our exporter)

**Step 2: Update Grafana datasource to point at Prometheus**

Update `/etc/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://localhost:9090
    isDefault: true
    editable: false
```

**Step 3: Restart Grafana to pick up datasource**

```bash
sudo systemctl restart grafana-server
sleep 3
curl -s -u admin:admin http://localhost:3000/api/datasources | grep -o '"name":"Prometheus"'
```

Expected: `"name":"Prometheus"`

---

## Task 10: Create Grafana dashboard JSON files

**Files:**
- Create: `/etc/grafana/provisioning/dashboards/staktrakr-system.json`
- Create: `/etc/grafana/provisioning/dashboards/staktrakr-poller-runs.json`
- Create: `/etc/grafana/provisioning/dashboards/staktrakr-failures.json`
- Create: `/etc/grafana/provisioning/dashboards/dashboards.yml`

**Step 1: Create dashboard provisioning config**

Create `/etc/grafana/provisioning/dashboards/dashboards.yml`:

```yaml
apiVersion: 1

providers:
  - name: StakTrakr
    orgId: 1
    folder: StakTrakr
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: /etc/grafana/provisioning/dashboards
```

**Step 2: Create the three dashboard JSON files**

These are best created via the Grafana UI first (drag panels, configure queries), then exported as JSON and saved to the provisioning directory. The recommended workflow:

1. Open `http://192.168.1.81:3000`
2. Log in (admin/admin, change password)
3. Go to Dashboards → New → New Dashboard
4. Add panels using PromQL queries below
5. Export JSON (Share → Export → Save to file)
6. `sudo cp ~/Downloads/dashboard.json /etc/grafana/provisioning/dashboards/staktrakr-system.json`

**Key PromQL queries per dashboard:**

**System Dashboard:**
- CPU: `poller_cpu_load1`, `poller_cpu_load5`, `poller_cpu_load15`
- Memory: `poller_mem_used_pct`
- Network: `rate(poller_net_rx_bytes[5m])`, `rate(poller_net_tx_bytes[5m])`
- Uptime: `poller_uptime_seconds`
- Services: `poller_service_up`

**Poller Runs Dashboard:**
- Capture rate: `poller_run_capture_rate`
- Failures per run: `poller_run_failures`
- Duration: `poller_run_duration_seconds`
- Captured vs total: `poller_run_captured`, `poller_run_total`

**Failure Queue Dashboard:**
- Total failing providers: `poller_failing_providers_count`
- Per-provider failures: `poller_provider_failures_total`
- Turso health: `poller_turso_up`

**Step 3: Restart Grafana**

```bash
sudo systemctl restart grafana-server
```

Verify dashboards appear at `http://192.168.1.81:3000/dashboards`.

---

## Summary: What Gets Built

| Component | Location | Port |
|-----------|----------|------|
| Provider URL editor | `/opt/poller/dashboard.js` route `/providers` | 3010 |
| Failure queue | `/opt/poller/dashboard.js` route `/failures` | 3010 |
| Metrics exporter | `/opt/poller/metrics-exporter.js` | 9100 |
| Prometheus | systemd (`prometheus`) | 9090 |
| Grafana | systemd (`grafana-server`) | 3000 |

| Turso table | Written by | Read by |
|-------------|-----------|---------|
| `poller_runs` | price-extract.js | dashboard.js, metrics-exporter.js |
| `provider_failures` | price-extract.js | dashboard.js `/failures`, metrics-exporter.js |
