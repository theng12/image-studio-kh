/**
 * v0.21.1: settings:* IPC handlers, extracted from ipc.js.
 *
 * Covers the persistent config flat-file at
 * `<userData>/config.json`, the data-folder picker + move flow,
 * the remove.bg API key check + monthly usage counter, plus the
 * multi-Mac mode switch + server / client controls.
 *
 * Multi-Mac glue lives here (not in a separate file) because all
 * the controls are in the Settings page. The server admin sees
 * `server:status / addresses / start / stop` from here; clients
 * see `client:testConnection` from here. Mode switching writes the
 * new mode and relaunches.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, app, dialog, shell } = require('electron');
const config = require('../config');

/**
 * v0.21.4: shared guard for "is this folder actually our data dir
 * that's safe to mutate?" Same check the changeDataFolder copy step
 * uses — so trash + copy use identical reject rules.
 *
 * A path qualifies if it's a real directory AND it has at least one
 * of: database.sqlite, assets/, ai-gallery/, processed/. We accept
 * any one of those because partial / fresh installs may not have
 * all four yet (e.g. an iCloud user with WAL-mode sidecars that
 * haven't synced).
 */
function looksLikeOurDataDir(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return false;
  } catch { return false; }
  return (
    fs.existsSync(path.join(p, 'database.sqlite')) ||
    fs.existsSync(path.join(p, 'assets')) ||
    fs.existsSync(path.join(p, 'ai-gallery')) ||
    fs.existsSync(path.join(p, 'processed'))
  );
}

function register({ expose }) {
  ipcMain.handle('settings:getAll', () => {
    // v0.13.0: enrich the config response with a computed
    // `dataDirIsCloud` flag so the renderer can show an iCloud
    // badge + best-practices banner without re-implementing the
    // detection.
    const cfg = config.loadConfig();
    const { isIcloudDataDir } = require('../db');
    return { ...cfg, dataDirIsCloud: isIcloudDataDir(cfg.dataDir) };
  });

  /* v0.14.2: server-mode status + control. The renderer polls
     server:status to keep the Settings page in sync. */
  ipcMain.handle('server:status', () => {
    const { getStatus } = require('../server');
    return getStatus();
  });
  ipcMain.handle('server:addresses', () => {
    const { collectLocalAddresses } = require('../server');
    return collectLocalAddresses();
  });
  ipcMain.handle('server:stop', async () => {
    const { stopServer } = require('../server');
    await stopServer();
    return { ok: true };
  });
  ipcMain.handle('server:start', async () => {
    const { bootServer } = require('../server');
    const cfg = config.loadConfig();
    return bootServer({ port: cfg.serverPort || 13180, dataDir: cfg.dataDir });
  });

  /* v0.14.2: client connection test. Lets the client UI verify
     the server URL + token before saving them. Hits the server's
     /api/whoami endpoint.
     v0.26.34: pre-validates URL shape + surfaces err.cause so the
     user can see the real reason ("Server refused the connection on
     port 13180" instead of the opaque "fetch failed"). */
  ipcMain.handle('client:testConnection', async (_e, { url, token }) => {
    const { validateServerUrl, analyzeFetchError } = require('../util/fetchErrors');
    const urlCheck = validateServerUrl(url);
    if (!urlCheck.ok) throw new Error(urlCheck.error);
    if (!token || !String(token).trim()) {
      throw new Error('User token is empty. Ask the server admin to give you the long random string from their Settings → Multi-Mac → Users page.');
    }
    const base = url.replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        // 8s ceiling so a black-holed connection doesn't make the
        // user stare at a spinning button forever. Tailscale + LAN
        // round-trips are usually <100 ms; anything past 8s means
        // the network is wrong, not slow.
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const analyzed = analyzeFetchError(err, base);
      throw new Error(analyzed.message);
    }
    if (res.status === 401) throw new Error('Token rejected by server. Ask the admin to regenerate it (their Settings → Multi-Mac → Users → ↻ button), then paste the new one here.');
    if (!res.ok) throw new Error(`Server returned ${res.status}. The address is reachable but isn't speaking the Image Studio KH protocol — is this URL pointing at a different app?`);
    const data = await res.json();
    return { ok: true, user: data.user, registeredChannels: data.registeredChannels };
  });

  /* v0.26.34: step-by-step network diagnostic. Walks URL → ping →
     whoami and returns each layer's result so the user can see
     exactly where the chain breaks (vs. the single "Test connection"
     which just throws on the first failure). */
  ipcMain.handle('client:diagnoseServer', async (_e, { url, token } = {}) => {
    const { diagnoseServer } = require('../util/fetchErrors');
    return diagnoseServer({ url, token });
  });

  /* v0.14.0: switching `mode` (standalone / server / client) is
     restart-required because the boot path differs (client mode
     skips local DB init, server mode boots HTTP). Persist the new
     mode then relaunch. */
  ipcMain.handle('settings:setMode', async (_e, nextMode) => {
    if (!['standalone', 'server', 'client'].includes(nextMode)) {
      throw new Error(`Invalid mode: ${nextMode}`);
    }
    config.updateConfig({ mode: nextMode });
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
    return { ok: true, mode: nextMode };
  });

  ipcMain.handle('settings:setOne',  (_e, { key, value }) => config.updateConfig({ [key]: value }));
  ipcMain.handle('settings:setMany', (_e, patch) => config.updateConfig(patch ?? {}));

  ipcMain.handle('settings:pickAndSetDataFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose data folder',
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const next = res.filePaths[0];
    config.updateConfig({ dataDir: next });
    return next;
  });

  /**
   * Pick a new data folder AND optionally move the existing
   * contents. If `move` is true we copy database.sqlite + the
   * asset trees into the new folder, then update the config. The
   * caller relaunches the app.
   *
   * We use a copy-then-delete approach (not fs.rename) so a
   * partial move doesn't leave data orphaned. The original stays
   * until the copy succeeds.
   */
  ipcMain.handle('settings:changeDataFolder', async (_e, { newPath, move }) => {
    if (!newPath || typeof newPath !== 'string') throw new Error('newPath required');
    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }
    const cfg = config.loadConfig();
    const oldPath = cfg.dataDir;
    const oldExists = !!oldPath && fs.existsSync(oldPath);

    // Defensive: the only place we should ever copy *from* is a
    // folder we actually wrote to. The `looksLikeOurDataDir`
    // check above guards both this copy step AND the v0.21.4
    // trashFolder channel below — same rules for both.

    if (move && oldExists && looksLikeOurDataDir(oldPath)
        && path.resolve(oldPath) !== path.resolve(newPath)) {
      // Copy each known top-level entry: database, assets,
      // ai-gallery, processed, anything else we don't recognise
      // (defensive).
      const entries = fs.readdirSync(oldPath, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;          // skip dotfiles
        const src = path.join(oldPath, ent.name);
        const dst = path.join(newPath, ent.name);
        if (fs.existsSync(dst)) {
          // Skip files already present in the new folder so we
          // don't clobber anything the user may have stashed there.
          continue;
        }
        fs.cpSync(src, dst, { recursive: true });
      }
      // Best-effort cleanup: remove the old folder if it's now
      // empty-ish. cpSync doesn't delete from source, so this
      // branch almost never fires — by design. v0.21.4 adds a
      // follow-up prompt in the renderer that calls
      // `settings:trashFolder` after a successful move, which
      // covers the common case cleanly via the OS Trash (so the
      // user can recover if anything turns out to be missing).
      try {
        const remaining = fs.readdirSync(oldPath).filter((n) => !n.startsWith('.'));
        if (remaining.length === 0) fs.rmSync(oldPath, { recursive: true, force: true });
      } catch { /* leave it */ }
    }

    config.updateConfig({ dataDir: newPath, firstLaunchHandled: true });

    // v0.21.4: report whether the old folder still has user data
    // after the copy, so the renderer can ask "delete it?". This
    // is purely informational — the renderer makes the call.
    let oldStillHasData = false;
    try {
      if (move && oldExists && path.resolve(oldPath) !== path.resolve(newPath)) {
        oldStillHasData = looksLikeOurDataDir(oldPath);
      }
    } catch (_) { /* leave default */ }

    return { oldPath, newPath, moved: !!move, oldStillHasData };
  });

  /**
   * v0.21.4: move a former data folder to the OS Trash. Used after
   * a successful `settings:changeDataFolder` move so the user
   * isn't left with two copies on disk. Refuses to trash:
   *   - the CURRENT data folder (would brick the next launch)
   *   - any path that doesn't look like one of our data folders
   *     (guards a tampered config or a buggy renderer call)
   *   - any path that doesn't actually exist
   *
   * Uses `shell.trashItem` rather than `fs.rmSync` so the user
   * can recover from Finder if anything turns out to be missing.
   */
  ipcMain.handle('settings:trashFolder', async (_e, { path: targetPath } = {}) => {
    if (!targetPath || typeof targetPath !== 'string') {
      throw new Error('path required');
    }
    const cfg = config.loadConfig();
    if (path.resolve(targetPath) === path.resolve(cfg.dataDir)) {
      throw new Error('Refusing to trash the current data folder');
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error('Folder no longer exists');
    }
    if (!looksLikeOurDataDir(targetPath)) {
      throw new Error('That folder doesn\'t look like an Image Studio KH data folder — refusing to trash it for safety.');
    }
    await shell.trashItem(targetPath);
    return { ok: true, path: targetPath };
  });

  ipcMain.handle('settings:testRemoveBg', async (_e, { apiKey }) => {
    if (!apiKey) throw new Error('API key is empty');
    // Lightweight check: hit the /v1/account endpoint.
    try {
      const res = await fetch('https://api.remove.bg/v1.0/account', {
        method: 'GET',
        headers: { 'X-Api-Key': apiKey },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`remove.bg returned ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
      }
      const data = await res.json().catch(() => ({}));
      return {
        ok: true,
        credits: data?.data?.attributes?.credits?.total ?? null,
        free: data?.data?.attributes?.api?.free_calls ?? null,
      };
    } catch (err) {
      throw new Error(`Connection failed: ${err.message}`);
    }
  });

  // Increment the per-month remove.bg call counter shown in
  // Settings. The renderer calls this each time it makes a
  // successful bg-removal request so the user can track usage
  // against their plan. Auto-resets to 0 when the month rolls over.
  ipcMain.handle('settings:bumpRemoveBgUsage', () => {
    const cfg = config.loadConfig();
    const monthNow = new Date().toISOString().slice(0, 7); // YYYY-MM
    const prev = cfg.removeBgUsage ?? { month: monthNow, calls: 0 };
    const next = prev.month === monthNow
      ? { month: monthNow, calls: (prev.calls ?? 0) + 1 }
      : { month: monthNow, calls: 1 };
    return config.updateConfig({ removeBgUsage: next });
  });
}

module.exports = { register };
