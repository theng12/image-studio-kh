/**
 * v0.26.32: server-bundle IPC handlers (export / import / preview).
 *
 * These are LOCAL-ONLY by design — there's no version that runs over
 * the RPC dispatcher. The whole flow involves OS file dialogs (Save
 * panel, Open panel) and disk I/O on the running Mac's local filesystem.
 * A client Mac shouldn't be reaching into the server's disk over HTTP
 * to pick a bundle path. So these handlers go through `ipcMain.handle`
 * directly (NOT through `expose()`) and do not appear in
 * `main/server/validators.js`.
 *
 * Channels:
 *   - servers:exportBundle  → Save dialog → write .iskhbundle from
 *                              the active data folder + portable
 *                              config keys. Returns { bundlePath,
 *                              sizeBytes, includes }.
 *   - servers:previewBundle → Open dialog (or pre-picked path) →
 *                              extract manifest only, return the
 *                              parsed manifest + bundle size. Used
 *                              by the import UI to show "Bundle from
 *                              v0.26.32, 2.4 GB" before commit.
 *   - servers:importBundle  → write the bundle's contents into the
 *                              caller-supplied targetDataDir. Backs
 *                              up any existing data first. Merges the
 *                              portable config keys. Never touches
 *                              mode / dataDir / network settings.
 *
 * Progress: each long-running channel emits `progress:event` over the
 * shared events bus so the renderer's existing ProgressOverlay picks
 * them up automatically (same channel auto-match / bulk AI / template
 * apply use). Stages map to the serverBundle module's onProgress hook.
 */

const { ipcMain, dialog, app } = require('electron');
const serverBundle = require('../serverBundle');
const events = require('../events');
const config = require('../config');

const BUNDLE_EXT = 'iskhbundle';

function register(/* helpers — unused; these are local-only */) {

  /**
   * Export the active data folder into a `.iskhbundle`. Opens a Save
   * dialog so the user picks where to write it (Desktop, external
   * drive, AirDrop staging folder, etc.). Returns immediately if the
   * user cancels.
   */
  ipcMain.handle('servers:exportBundle', async () => {
    const cfg = config.loadConfig();
    // Default filename includes the version so a folder full of
    // bundles is self-documenting. `safe-` filename — Save dialog
    // already restricts the user to writable locations.
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const defaultName = `image-studio-kh-${app.getVersion()}-${stamp}.${BUNDLE_EXT}`;

    const res = await dialog.showSaveDialog({
      title: 'Export server bundle',
      defaultPath: defaultName,
      filters: [{ name: 'Image Studio KH bundle', extensions: [BUNDLE_EXT] }],
    });
    if (res.canceled || !res.filePath) return null;

    const opId = `bundle-export-${Date.now()}`;
    // Total = stages; emitting a discrete step per stage gives the
    // overlay a meaningful bar without us needing byte-level
    // progress (which tar doesn't surface cleanly).
    const stages = ['snapshot', 'manifest', 'archive', 'cleanup', 'done'];
    const labels = {
      snapshot: 'Snapshotting database',
      manifest: 'Writing manifest',
      archive:  'Packing bundle',
      cleanup:  'Cleaning up',
      done:     'Done',
    };
    events.broadcast('progress:event', {
      id: opId, kind: 'bundle-export', done: 0, total: stages.length,
      phase: 'starting', label: 'Preparing bundle…',
    });

    try {
      const result = await serverBundle.exportBundle({
        outputPath: res.filePath,
        onProgress: (stage) => {
          const idx = stages.indexOf(stage);
          events.broadcast('progress:event', {
            id: opId, kind: 'bundle-export',
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
      events.broadcast('progress:event', {
        id: opId, complete: true, error: err.message,
      });
      throw err;
    }
  });

  /**
   * Peek at a bundle's manifest. Two call shapes:
   *   - No args: opens an Open dialog so the renderer can do
   *     "pick + preview" in one IPC.
   *   - `{ bundlePath }`: previews the already-picked file.
   *
   * Returns null if the dialog was canceled.
   */
  ipcMain.handle('servers:previewBundle', async (_e, args) => {
    let bundlePath = args?.bundlePath;
    if (!bundlePath) {
      const res = await dialog.showOpenDialog({
        title: 'Select server bundle to import',
        properties: ['openFile'],
        filters: [{ name: 'Image Studio KH bundle', extensions: [BUNDLE_EXT, 'tgz', 'gz'] }],
      });
      if (res.canceled || !res.filePaths[0]) return null;
      bundlePath = res.filePaths[0];
    }
    return serverBundle.previewBundle(bundlePath);
  });

  /**
   * Import a bundle INTO `targetDataDir`. The renderer is responsible
   * for picking the target folder (via `files:pickFolder`) and getting
   * user consent for the destructive replace — by the time we get the
   * call, both the bundle path and target are set.
   *
   * The handler:
   *   1. Backs up any existing data at the target to `<target>.bak.<ts>`.
   *   2. Extracts the bundle into the target.
   *   3. Merges the portable config keys (AI keys, presets) into config.json.
   *      Never touches mode / dataDir / network keys.
   *   4. Returns. Caller decides whether to relaunch — the new DB
   *      doesn't take effect until the next launch because the live
   *      better-sqlite3 connection still holds the old file's handle.
   */
  ipcMain.handle('servers:importBundle', async (_e, args) => {
    const bundlePath = args?.bundlePath;
    const targetDataDir = args?.targetDataDir;
    if (!bundlePath) throw new Error('bundlePath is required');
    if (!targetDataDir) throw new Error('targetDataDir is required');

    const opId = `bundle-import-${Date.now()}`;
    const stages = ['verify', 'backup', 'extract', 'merge-config', 'done'];
    const labels = {
      verify:        'Verifying bundle',
      backup:        'Backing up existing data',
      extract:       'Extracting bundle',
      'merge-config': 'Merging configuration',
      done:          'Done',
    };
    events.broadcast('progress:event', {
      id: opId, kind: 'bundle-import', done: 0, total: stages.length,
      phase: 'starting', label: 'Preparing import…',
    });

    try {
      const result = await serverBundle.importBundle({
        bundlePath,
        targetDataDir,
        onProgress: (stage) => {
          const idx = stages.indexOf(stage);
          events.broadcast('progress:event', {
            id: opId, kind: 'bundle-import',
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
      events.broadcast('progress:event', {
        id: opId, complete: true, error: err.message,
      });
      throw err;
    }
  });

  /**
   * Apply an imported bundle as the live data folder. Convenience
   * channel that combines `settings:setOne dataDir=<path>` with the
   * existing relaunch flow. Saves the renderer from sequencing two
   * IPCs when the user clicks "Import bundle → use it now".
   *
   * If `relaunch` is true (default), the app exits + relaunches so
   * the new DB connection opens cleanly. Caller can opt out
   * (relaunch=false) if it wants to surface a "Restart later" CTA
   * instead of forcing it.
   */
  ipcMain.handle('servers:applyImportedDataDir', async (_e, args) => {
    const newDataDir = args?.dataDir;
    const relaunch = args?.relaunch !== false;
    if (!newDataDir || typeof newDataDir !== 'string') {
      throw new Error('dataDir is required');
    }
    config.updateConfig({ dataDir: newDataDir, firstLaunchHandled: true });
    if (relaunch) {
      setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
    }
    return { ok: true, dataDir: newDataDir, relaunch };
  });
}

module.exports = { register };
