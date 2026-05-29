/**
 * v0.26.51: shared Electron-cache inspection + clearing helpers.
 *
 * Used by BOTH the standalone/server IPC (main/ipc/app.js) AND the
 * client-mode runtime (main/client/index.js). Pre-v0.26.51 the
 * `app:getCacheInfo` / `app:clearCache` handlers lived only in
 * ipc/app.js — which doesn't run in client mode — so a client opening
 * Settings hit "No handler registered for 'app:getCacheInfo'". These
 * are inherently per-Mac operations (each machine has its own Electron
 * HTTP cache, dominated by the ~80 MB @imgly model), so they must be
 * LOCAL handlers in every mode, never proxied to the server.
 *
 * Extracting to a single module keeps the two registration sites in
 * lockstep — change the cache logic once, both modes inherit it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');

/**
 * Walk `<userData>/Cache` and report total bytes + file count + the
 * most-recent mtime. The cache is dominated by the @imgly model (~80
 * MB of WASM + ONNX weights) plus a few small HTTPS responses. We
 * report aggregate stats, not per-file detail — a useful "is the
 * model cached?" proxy without fragile content-sniffing.
 *
 * Bounded: depth-capped at 6 and file-count-capped at 100k so a
 * corrupted / runaway cache can't hang the call. Returns size 0 if
 * the Cache folder doesn't exist yet (fresh install, never ran bg
 * removal).
 */
async function readCacheInfo() {
  const cachePath = path.join(app.getPath('userData'), 'Cache');
  let totalBytes = 0;
  let fileCount = 0;
  let mostRecentMtime = 0;

  async function walk(dir, depth) {
    if (depth > 6) return;
    if (fileCount > 100_000) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(p, depth + 1);
      } else if (ent.isFile()) {
        try {
          const st = await fs.promises.stat(p);
          totalBytes += st.size;
          fileCount += 1;
          const m = Number(st.mtimeMs);
          if (m > mostRecentMtime) mostRecentMtime = m;
        } catch { /* file vanished mid-walk — fine */ }
      }
    }
  }

  try {
    await walk(cachePath, 0);
  } catch (_) { /* partial result still useful */ }

  return {
    cachePath,
    totalBytes,
    fileCount,
    mostRecentMtime: mostRecentMtime || null,
    exists: fileCount > 0,
  };
}

/**
 * Clear Electron's renderer HTTP cache (the @imgly model + any other
 * cached HTTPS responses). Measures the Cache_Data folder size first
 * for a best-effort `bytesFreed` report, then calls Electron's
 * built-in `session.defaultSession.clearCache()`. Doesn't touch
 * IndexedDB / LocalStorage / cookies — only the HTTP cache layer.
 */
async function clearAppCache() {
  const cachePath = path.join(app.getPath('userData'), 'Cache');
  let bytesBefore = 0;
  try {
    const sub = path.join(cachePath, 'Cache_Data');
    const entries = await fs.promises.readdir(sub, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const st = await fs.promises.stat(path.join(sub, e.name));
        bytesBefore += st.size;
      } catch { /* ignore */ }
    }
  } catch (_) {}
  try {
    await session.defaultSession.clearCache();
  } catch (err) {
    throw new Error(`Failed to clear cache: ${err.message}`);
  }
  return { ok: true, bytesFreed: bytesBefore, cachePath };
}

module.exports = { readCacheInfo, clearAppCache };
