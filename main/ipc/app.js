/**
 * v0.21.1: app:* IPC handlers, extracted from ipc.js.
 *
 * Application metadata + window / shell glue. Two channels are
 * exposed (callable by clients via RPC): `app:getVersion` and
 * `app:getPlatform`. Everything else is local-only because they
 * either touch the renderer's own machine (open folder, relaunch)
 * or expose host details that clients don't need.
 *
 * The `app:openExternal` allow-list is defense-in-depth: a malicious
 * IPC caller can't slip a `file://` or `javascript:` URL through to
 * the OS shell. WHATWG URL parse + scheme allow-list + the
 * URL_ALLOW regex all have to agree.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, app, shell } = require('electron');
const { getDataDir } = require('../db');

function register({ expose, URL_ALLOW }) {
  expose('app:getVersion', () => app.getVersion());
  expose('app:getPlatform', () => process.platform);

  ipcMain.handle('app:getVersionInfo', () => ({
    app: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  ipcMain.handle('app:openExternal', async (_e, target) => {
    if (typeof target !== 'string') {
      throw new Error('Disallowed URL scheme');
    }
    // Parse with WHATWG URL first so we reject malformed input
    // (e.g. "http: //" with whitespace, control characters,
    // unencoded payloads). Only then check the protocol against the
    // allow-list. This is defence-in-depth on top of the regex
    // match below — `shell.openExternal` will still handle the
    // string verbatim, but we want a cheap rejection layer for
    // typos and garbage rather than handing it to the OS.
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new Error('Disallowed URL scheme');
    }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      throw new Error('Disallowed URL scheme');
    }
    if (!URL_ALLOW.test(target)) {
      throw new Error('Disallowed URL scheme');
    }
    await shell.openExternal(target);
    return true;
  });

  ipcMain.handle('app:openDataFolder', async () => {
    await shell.openPath(getDataDir());
    return true;
  });

  ipcMain.handle('app:openLogsFolder', async () => {
    await shell.openPath(app.getPath('userData'));
    return true;
  });

  /**
   * v0.19.0: return the last N lines of crash.log so a beta user
   * can copy-paste them to the maintainer when something breaks.
   * Capped at 200 lines (~20KB) — beyond that they should use
   * "Open logs folder" and send the whole file.
   *
   * crash.log is plain text appended by logEvent() in main/index.js
   * (boot, app:ready, render-process-gone, uncaughtException, etc.)
   * so reading the tail is the highest-signal-per-byte thing.
   */
  ipcMain.handle('app:readCrashLog', async (_e, { lines = 100 } = {}) => {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    try {
      const content = await fs.promises.readFile(logPath, 'utf8');
      const all = content.split('\n');
      const tail = all.slice(Math.max(0, all.length - Math.min(lines, 200)));
      return { content: tail.join('\n'), path: logPath, lines: tail.length };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { content: '(no crash.log yet — nothing has been logged)', path: logPath, lines: 0 };
      }
      throw err;
    }
  });

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  /**
   * v0.26.39: surface what Electron's renderer HTTP cache holds
   * (model-cache panel in Settings). v0.26.51: implementation moved
   * to the shared `main/util/appCache.js` helper so client mode can
   * register the identical handler — see the local-handler block in
   * main/client/index.js. These are per-Mac operations and must
   * NEVER be proxied to the server.
   */
  const { readCacheInfo, clearAppCache } = require('../util/appCache');
  ipcMain.handle('app:getCacheInfo', () => readCacheInfo());
  ipcMain.handle('app:clearCache', () => clearAppCache());
}

module.exports = { register };
