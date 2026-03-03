# Cloud Sync

> **Last updated:** v3.32.24 — 2026-02-23
> **Source files:** `js/cloud-sync.js`, `js/cloud-storage.js`

---

## Overview

StakTrakr supports Dropbox-based cloud sync that automatically pushes an encrypted vault snapshot whenever inventory changes, and polls for remote updates on other devices.

Two files live in Dropbox under `/StakTrakr/`:

| File | Purpose |
|---|---|
| `staktrakr-sync.stvault` | Full encrypted inventory snapshot |
| `staktrakr-sync.json` | Lightweight metadata pointer, polled for change detection |

The poller compares the remote `staktrakr-sync.json` revision against the last-seen cursor. When it detects a change it calls `handleRemoteChange()`, which decides between a clean pull or a conflict modal.

---

## Key Rules (read before touching this area)

1. **Never bypass `getSyncPasswordSilent()`** — do not add your own `localStorage.getItem('cloud_vault_password')` reads inline. All key derivation logic (Simple mode migration, Unified mode construction) is encapsulated there.
2. **All `pushSyncVault()` and `pullSyncVault()` call sites must have `.catch()` handlers** — bare calls cause silent unhandled rejections on token failures. This was the root cause of the v3.32.24 regression.
3. **Cancel the debounced push before pulling** — `handleRemoteChange()` calls `scheduleSyncPush.cancel()` before opening any modal. If you add new pull paths, replicate this cancel guard.
4. **Do not duplicate `getSyncPassword()` logic** — the fast-path check at the top of that function delegates to `getSyncPasswordSilent()`, which handles both modes. Adding a second localStorage read before it breaks Simple-mode migration.

---

## Architecture

### Two Sync Modes

#### Simple Mode

The encryption key is derived entirely from the Dropbox account ID (`cloud_dropbox_account_id` in localStorage). No password is ever prompted on any device.

Key construction: `STAKTRAKR_SIMPLE_SALT + ':' + accountId`

- `STAKTRAKR_SIMPLE_SALT` is a fixed hex string baked into `js/cloud-sync.js`.
- `cloud_sync_mode` is set to `'simple'` in localStorage.
- Any device that authenticates with the same Dropbox account can decrypt transparently.
- **Trade-off:** anyone with the Dropbox OAuth token can also derive the key.

#### Secure Mode (Unified Mode)

The encryption key combines a user-chosen vault password **and** the Dropbox account ID:

Key construction: `vaultPassword + ':' + accountId`

- Stored separately: `cloud_vault_password` and `cloud_dropbox_account_id`.
- `getSyncPasswordSilent()` returns `null` on a new device until the user enters the password at least once.
- After first entry, the password is cached in `cloud_vault_password` (localStorage) so subsequent page loads are silent.
- Zero-knowledge: Dropbox access alone is insufficient to decrypt the vault.

### `getSyncPassword()`

```
getSyncPassword()
  └─ getSyncPasswordSilent()   ← always checked first (fast-path)
       ├─ Unified mode: vaultPw + ':' + accountId  (both present)
       ├─ Simple migration: SALT + ':' + accountId  (cloud_sync_mode === 'simple')
       └─ null → fall through to interactive prompt modal
```

- **Never call `localStorage.getItem('cloud_vault_password')` directly** at a call site — `getSyncPasswordSilent()` handles both modes and the migration edge case.
- If the silent path returns a key, `getSyncPassword()` resolves immediately without opening any modal.
- The interactive modal sets the password in localStorage and fires `pushSyncVault()` 100 ms later on confirm.

### `pushSyncVault()`

1. Guards: `syncIsEnabled()`, token present, no push already in-flight, `getSyncPasswordSilent()` returns a key.
2. Encrypts the sync-scoped inventory with `vaultEncryptToBytesScoped()` (falls back to `vaultEncryptToBytes()`).
3. Uploads the encrypted bytes to `/StakTrakr/staktrakr-sync.stvault` (overwrite mode).
4. Writes the metadata pointer to `/StakTrakr/staktrakr-sync.json`.
5. Persists the push meta (timestamp, syncId, itemCount) via `syncSetLastPush()`.
6. Handles 429 rate-limit with exponential backoff (caps at 5 minutes).

**All call sites must have `.catch()` handlers.** Example:

```js
pushSyncVault().catch(function (err) {
  debugLog('[CloudSync] pushSyncVault failed:', err);
});
```

### `pullSyncVault()`

1. Tries `getSyncPasswordSilent()` first; falls back to interactive `getSyncPassword()` if null.
2. Calls `syncSaveOverrideBackup()` (snapshots current localStorage state before overwriting).
3. Downloads `staktrakr-sync.stvault` from Dropbox.
4. Decrypts and restores via `vaultDecryptAndRestore()`.
5. Persists pull meta via `syncSetLastPull()`.

**All call sites must have `.catch()` handlers.**

### `handleRemoteChange()`

Called by the poller when `staktrakr-sync.json` has a new revision.

```
handleRemoteChange(remoteMeta)
  ├─ If password prompt is active → defer (return, retry next poll)
  ├─ scheduleSyncPush.cancel()           ← CRITICAL: cancels any queued push
  ├─ syncHasLocalChanges()?
  │    No  → showSyncUpdateModal() → pullSyncVault()
  │    Yes → showSyncConflictModal()
  │             ├─ Keep Mine  → pushSyncVault()
  │             └─ Keep Theirs → pullSyncVault().catch(...)
```

**The `scheduleSyncPush.cancel()` call is mandatory.** Without it:
1. User triggers local change → debounced push is queued (2 s delay).
2. Poller detects remote change → conflict modal opens.
3. Debounced push fires while modal is open → overwrites remote vault with stale local data.
4. User clicks "Keep Theirs" → pulls back their own just-pushed stale data.
5. Remote device's changes are silently discarded.

---

## Vault Overwrite Race (fixed v3.32.24)

**Symptom:** On two-device setups, choosing "Keep Remote" in the conflict modal silently discarded the remote device's changes.

**Root cause:** On page load, `initSyncModule()` builds `scheduleSyncPush` as a debounced wrapper around `pushSyncVault` with a `SYNC_PUSH_DEBOUNCE` delay (2000 ms). If the poller detected a remote change within that 2-second window, the debounced push fired during or after the conflict modal, overwriting the remote vault before the pull could complete.

**Fix (v3.32.24):** `handleRemoteChange()` now calls `scheduleSyncPush.cancel()` as its first substantive action — before any modal is shown.

**Both devices must be on v3.32.24+** for the race to be fully closed. A v3.32.23 device will still exhibit the bug on its own debounced push, even if the other device has been updated.

---

## Conflict Resolution

**Default: remote wins** (when the user accepts the update modal with no local changes).

When both sides have unsaved changes, the conflict modal shows:

| Side | Info displayed |
|---|---|
| Local | Item count, last-push timestamp, app version |
| Remote | Item count, timestamp, app version, device ID |

Choices:
- **Keep Mine** → `pushSyncVault()` (overwrites remote with local)
- **Keep Theirs** → `pullSyncVault(remoteMeta).catch(...)` (overwrites local with remote)

The override backup (`syncSaveOverrideBackup`) is always written before any pull, enabling the "Restore Override Backup" button in the sync history section.

---

## Debounced Push

`scheduleSyncPush` is a debounced wrapper built in `initSyncModule()`:

```
SYNC_PUSH_DEBOUNCE = 2000 ms
```

Any inventory change fires `scheduleSyncPush()`. If another change arrives within 2 seconds, the timer resets. The actual `pushSyncVault()` only fires after 2 seconds of quiet.

If the `debounce` utility is not available at init time, a plain `setTimeout` fallback is used (no deduplication in that case).

---

## `changeLog` IIFE Parse Failures

`changeLog` is initialized as an IIFE in `js/state.js` that reads from localStorage on page load. Prior to v3.32.24, a JSON parse failure (malformed stored value) would silently return `[]` with no indication of data loss.

**Since v3.32.24:** parse failures emit `console.warn('[state] changeLog parse failed — resetting to []. Error:', e)` so they are visible in DevTools.

---

## localStorage Keys

| Key | Purpose |
|---|---|
| `cloud_vault_password` | User vault password (Secure mode) |
| `cloud_dropbox_account_id` | Dropbox account ID (used in key derivation for both modes) |
| `cloud_sync_mode` | `'simple'` — deprecated, kept for migration only, will be removed after v3.33 |
| `cloud_sync_enabled` | `'true'` when sync is active |
| `cloud_sync_device_id` | Stable per-device UUID |
| `cloud_sync_last_push` | JSON: last push metadata (syncId, timestamp, itemCount) |
| `cloud_sync_last_pull` | JSON: last pull metadata |
| `cloud_sync_cursor` | Last-seen remote revision (change detection) |
| `cloud_sync_override_backup` | Snapshot of localStorage taken before a pull overwrites data |

---

## Common Mistakes

### Adding a raw localStorage read for the vault password

```js
// WRONG — breaks Simple-mode migration
var pw = localStorage.getItem('cloud_vault_password');

// CORRECT — handles all modes and migration
var pw = getSyncPasswordSilent();
```

### Bare push/pull calls without `.catch()`

```js
// WRONG — silent unhandled rejection if token is missing
pullSyncVault(remoteMeta);

// CORRECT
pullSyncVault(remoteMeta).catch(function (err) {
  debugLog('[CloudSync] pull failed:', err);
});
```

### Adding a new pull path without cancelling the debounced push

```js
// WRONG — vault overwrite race
async function myNewPullPath(remoteMeta) {
  await pullSyncVault(remoteMeta);
}

// CORRECT
async function myNewPullPath(remoteMeta) {
  if (typeof scheduleSyncPush === 'function' && typeof scheduleSyncPush.cancel === 'function') {
    scheduleSyncPush.cancel();
  }
  await pullSyncVault(remoteMeta);
}
```

---

## Related Pages

- `data-model.md` — inventory structure and field definitions
- `storage-patterns.md` — `saveData()` / `loadData()` patterns, `ALLOWED_STORAGE_KEYS`
