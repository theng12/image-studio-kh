/**
 * v0.49.31: backups:* IPC handlers — local backup / restore.
 *
 * LOCAL-ONLY by design, exactly like main/ipc/serverBundle.js: every
 * channel touches THIS Mac's disk (the backups folder, the live data
 * folder, OS file dialogs, Finder reveal). A client Mac has no local
 * data folder, so these are stubbed out in client mode (see
 * NOT_YET_PORTABLE in main/client/index.js). They go through
 * `ipcMain.handle` directly — never `expose()` — so they don't appear
 * in the RPC registry / server validators.
 *
 * Channels:
 *   - backups:create     → snapshot DB + assets + config into a new
 *                          .iskhbackup in the backups folder. Emits
 *                          progress:event so the existing
 *                          ProgressOverlay shows a bar.
 *   - backups:list       → { backupsDir, backups:[{fileName, backupPath,
 *                          sizeBytes, createdAt}] }, newest first.
 *   - backups:last       → the single most-recent backup or null.
 *   - backups:preview    → parsed + validated manifest of one backup.
 *   - backups:reveal     → reveal a specific backup in Finder.
 *   - backups:openFolder → open the backups folder in Finder.
 *   - backups:pickFolder → choose a custom backups folder (persists
 *                          config.backupsDir).
 *   - backups:restore    → REPLACE the data folder from a backup. The
 *                          renderer confirms first + relaunches after.
 */

const fsp = require('node:fs/promises');
const { ipcMain, dialog, shell } = require('electron');
const backupManager = require('../backupManager');
const events = require('../events');
const config = require('../config');

function register(/* helpers — unused; local-only */) {
  ipcMain.handle('backups:create', async () => {
    const opId = `backup-create-${Date.now()}`;
    const stages = ['snapshot', 'manifest', 'archive', 'cleanup', 'done'];
    const labels = {
      snapshot: 'Snapshotting database',
      manifest: 'Writing manifest',
      archive:  'Packing backup',
      cleanup:  'Cleaning up',
      done:     'Done',
    };
    events.broadcast('progress:event', {
      id: opId, kind: 'backup-create', done: 0, total: stages.length,
      phase: 'starting', label: 'Preparing backup…',
    });
    try {
      const result = await backupManager.createBackup({
        onProgress: (stage) => {
          const idx = stages.indexOf(stage);
          events.broadcast('progress:event', {
            id: opId, kind: 'backup-create',
            done: idx >= 0 ? idx + 1 : 0,
            total: stages.length,
            phase: stage,
            label: labels[stage] ?? stage,
          });
        },
      });
      events.broadcast('progress:event', { id: opId, complete: true });
      return result;
    } catch (err) {
      events.broadcast('progress:event', { id: opId, complete: true, error: err.message });
      throw err;
    }
  });

  ipcMain.handle('backups:list', () => backupManager.listBackups());
  ipcMain.handle('backups:last', () => backupManager.lastBackup());

  ipcMain.handle('backups:preview', async (_e, args) => {
    const backupPath = args?.backupPath;
    if (!backupPath) throw new Error('backupPath is required');
    return backupManager.previewBackup(backupPath);
  });

  ipcMain.handle('backups:reveal', async (_e, args) => {
    const backupPath = args?.backupPath;
    if (!backupPath) throw new Error('backupPath is required');
    shell.showItemInFolder(backupPath);
    return true;
  });

  ipcMain.handle('backups:openFolder', async () => {
    const cfg = config.loadConfig();
    const dir = backupManager.resolveBackupsDir(cfg);
    // Create it first so "Open" works even before the first backup —
    // shell.openPath on a missing dir just returns an error string.
    await fsp.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('backups:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose backups folder',
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const next = res.filePaths[0];
    config.updateConfig({ backupsDir: next });
    return next;
  });

  ipcMain.handle('backups:restore', async (_e, args) => {
    const backupPath = args?.backupPath;
    if (!backupPath) throw new Error('backupPath is required');

    const opId = `backup-restore-${Date.now()}`;
    const stages = ['verify', 'extract', 'safety-copy', 'merge-config', 'done'];
    const labels = {
      verify:        'Verifying backup',
      extract:       'Extracting backup',
      'safety-copy': 'Moving current data aside',
      'merge-config': 'Restoring preferences',
      done:          'Done',
    };
    events.broadcast('progress:event', {
      id: opId, kind: 'backup-restore', done: 0, total: stages.length,
      phase: 'starting', label: 'Preparing restore…',
    });
    try {
      const result = await backupManager.restoreBackup({
        backupPath,
        onProgress: (stage) => {
          const idx = stages.indexOf(stage);
          events.broadcast('progress:event', {
            id: opId, kind: 'backup-restore',
            done: idx >= 0 ? idx + 1 : 0,
            total: stages.length,
            phase: stage,
            label: labels[stage] ?? stage,
          });
        },
      });
      events.broadcast('progress:event', { id: opId, complete: true });
      return result;
    } catch (err) {
      events.broadcast('progress:event', { id: opId, complete: true, error: err.message });
      throw err;
    }
  });
}

module.exports = { register };
