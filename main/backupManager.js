/**
 * v0.49.31: local backup / restore.
 *
 * A practical, macOS-local safety net for the destructive/bulk
 * operations in the app (bulk product delete, duplicate-merge purge,
 * re-encode overwrite, data-folder change, etc.). NOT a cloud backup —
 * everything stays on this Mac's disk under the user's control.
 *
 * Design mirrors main/serverBundle.js (which already packages the data
 * folder for cross-Mac migration) so the two share their proven moves:
 *   - SQLite snapshot via better-sqlite3 .backup() — consistent even
 *     while the live connection is writing (no torn WAL pages).
 *   - tar.gz via the system `tar` (zero dependencies on macOS).
 *   - staging dir + symlinked asset trees so we don't copy GBs twice.
 *
 * Where it differs from serverBundle:
 *   - Backups capture the FULL config.json (not just the portable
 *     subset) for reference, but restore only re-applies the portable
 *     keys — the live machine keeps its own dataDir / mode / network
 *     settings, exactly like an imported bundle.
 *   - Backups live in a `backups/` folder (default: under the data
 *     dir; the user can point them elsewhere). That folder is EXCLUDED
 *     from the archive so backups never nest inside backups.
 *   - There's a list/restore lifecycle: we enumerate existing backups,
 *     show size + date, and can restore one in place.
 *
 * Restore strategy (same as serverBundle.importBundle, for the same
 * reason): rename the current data folder aside to a timestamped
 * sibling, recreate it empty, extract the backup into it. Renaming the
 * folder is safe even with the DB connection open — on macOS the open
 * file descriptor follows the inode into the renamed folder, so the
 * dying connection can't write over the freshly-extracted database.
 * The caller relaunches afterward; the new connection opens the
 * restored DB cleanly. We best-effort carry the backups/ folder back
 * into the restored data dir so the user's backup history survives a
 * restore.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BACKUP_DIR_NAME,
  BACKUP_DATA_ENTRIES,
  backupStamp,
  backupFilename,
  isBackupFilename,
  entriesLookLikeDataDir,
  validateManifest,
  resolveSafeDest,
} = require('./util/backupSafety');

// Config keys that are safe to re-apply on restore. Reuse the exact
// list serverBundle defined so the two stay in lockstep — anything
// machine-specific (dataDir, mode, ports, client creds) is excluded.
const { PORTABLE_CONFIG_KEYS } = require('./serverBundle');

/* ─── small shared helpers ─────────────────────────────────────── */

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (err) => reject(err));
    p.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function snapshotDatabase(destPath) {
  const { getDb } = require('./db');
  const db = getDb();
  // Online backup — walks pager + WAL frames page-by-page, so it's
  // consistent even mid-write. Falls back to nothing: if there's no DB
  // yet (shouldn't happen on a configured install) the caller's
  // existsSync guard already bailed.
  await db.backup(destPath);
}

/**
 * Resolve the folder where backups are written. Defaults to
 * <dataDir>/backups but honours an explicit config.backupsDir if the
 * user pointed backups at another disk (external drive, etc.).
 */
function resolveBackupsDir(cfg) {
  if (cfg?.backupsDir && typeof cfg.backupsDir === 'string') {
    return cfg.backupsDir;
  }
  return path.join(cfg.dataDir, BACKUP_DIR_NAME);
}

/* ─── create ───────────────────────────────────────────────────── */

/**
 * Create a backup of the active data folder + config.json. Writes a
 * single .iskhbackup (tar.gz) into the backups folder.
 *
 * @param {object} args
 * @param {string} [args.destDir]  Override the backups folder for this
 *   one backup (e.g. a Save dialog pick). Defaults to resolveBackupsDir.
 * @param {(stage: string) => void} [args.onProgress]
 *   Stages: 'snapshot' | 'manifest' | 'archive' | 'cleanup' | 'done'.
 */
async function createBackup({ destDir, onProgress } = {}) {
  const config = require('./config');
  const cfg = config.loadConfig();
  const dataDir = cfg.dataDir;
  if (!dataDir || !fs.existsSync(dataDir)) {
    throw new Error('No data folder configured or it does not exist on disk');
  }

  const backupsDir = destDir || resolveBackupsDir(cfg);
  await fsp.mkdir(backupsDir, { recursive: true });

  const createdAt = Date.now();
  const stamp = backupStamp(new Date(createdAt));
  const fileName = backupFilename(stamp, app.getVersion());
  const outputPath = path.join(backupsDir, fileName);

  // Stage into a temp dir (mkdtemp) so a crash/cancel leaves nothing
  // half-written in the user's backups folder.
  const stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-backup-'));

  try {
    // 1. Consistent DB snapshot first — cheapest thing to fail on.
    onProgress?.('snapshot');
    const dbSrc = path.join(dataDir, 'database.sqlite');
    const includes = [];
    if (fs.existsSync(dbSrc)) {
      await snapshotDatabase(path.join(stagingRoot, 'database.sqlite'));
      includes.push('database.sqlite');
    } else {
      // No DB yet — refuse, because a "backup" with no database isn't
      // worth restoring and would fail validation on the way back in.
      throw new Error('No database found in the data folder — nothing to back up yet');
    }

    // 2. Full config.json copy (informational + portable-key restore).
    onProgress?.('manifest');
    const cfgPath = config.configPath();
    if (fs.existsSync(cfgPath)) {
      await fsp.copyFile(cfgPath, path.join(stagingRoot, 'config.json'));
      includes.push('config.json');
    }

    // 3. Symlink the big asset trees so tar packs them by dereference
    //    (-h) without a second disk-to-disk copy. The backups/ folder
    //    is deliberately NOT in this list — a backup never contains
    //    older backups.
    const trees = BACKUP_DATA_ENTRIES.filter((n) => n !== 'database.sqlite');
    for (const name of trees) {
      const src = path.join(dataDir, name);
      if (fs.existsSync(src)) {
        await fsp.symlink(src, path.join(stagingRoot, name));
        includes.push(name + '/');
      }
    }

    const manifest = {
      kind: BACKUP_KIND,
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      appVersion: app.getVersion(),
      createdAt,
      sourceDataDir: dataDir,   // informational; restore uses the live dataDir
      includes,
    };
    await fsp.writeFile(
      path.join(stagingRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // 4. Pack. -h dereferences the asset symlinks; -z gzips.
    onProgress?.('archive');
    const stagingParent = path.dirname(stagingRoot);
    const stagingName = path.basename(stagingRoot);
    await runCommand('tar', ['-czhf', outputPath, '-C', stagingParent, stagingName]);

    onProgress?.('done');
    const stat = await fsp.stat(outputPath);
    return {
      backupPath: outputPath,
      fileName,
      sizeBytes: stat.size,
      createdAt,
      includes,
      backupsDir,
    };
  } finally {
    onProgress?.('cleanup');
    try { await fsp.rm(stagingRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ─── list ─────────────────────────────────────────────────────── */

/**
 * Enumerate backups in the backups folder, newest first. Pure listing
 * — reads the file's mtime + size and (cheaply, via the filename)
 * recognises ours. We do NOT crack open each archive's manifest here
 * (that's a tar spawn per file); the renderer asks for a manifest
 * preview only when the user is about to restore a specific one.
 */
async function listBackups() {
  const config = require('./config');
  const cfg = config.loadConfig();
  const backupsDir = resolveBackupsDir(cfg);
  let names = [];
  try {
    names = await fsp.readdir(backupsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return { backupsDir, backups: [] };
    throw err;
  }
  const backups = [];
  for (const name of names) {
    if (!isBackupFilename(name)) continue;
    const full = path.join(backupsDir, name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) continue;
      backups.push({
        fileName: name,
        backupPath: full,
        sizeBytes: stat.size,
        // Birth time when available (macOS reports it), else mtime.
        createdAt: Math.round((stat.birthtimeMs || stat.mtimeMs) || 0),
      });
    } catch (_) { /* skip unreadable */ }
  }
  backups.sort((a, b) => b.createdAt - a.createdAt);
  return { backupsDir, backups };
}

/** The single most-recent backup (or null). Cheap call for the "last backup was…" affordance. */
async function lastBackup() {
  const { backups } = await listBackups();
  return backups[0] ?? null;
}

/* ─── preview ──────────────────────────────────────────────────── */

/**
 * Extract just the manifest from a backup and validate it. Returns the
 * parsed manifest (+ bundlePath/size) or throws a user-readable error.
 */
async function previewBackup(backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error('Backup file not found');
  }
  const { stdout } = await runCommand('tar', ['-tzf', backupPath]);
  const entries = stdout.split('\n').filter(Boolean);
  const hasManifest = entries.some((e) => e.endsWith('/manifest.json') || e === 'manifest.json');
  if (!hasManifest) {
    throw new Error('Not a valid Image Studio KH backup (no manifest)');
  }
  const prefix = entries[0].split('/')[0];
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-backup-peek-'));
  try {
    await runCommand('tar', ['-xzf', backupPath, '-C', tmpDir, `${prefix}/manifest.json`]);
    const manifestText = await fsp.readFile(path.join(tmpDir, prefix, 'manifest.json'), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(manifestText);
    } catch (err) {
      throw new Error(`Backup manifest is malformed JSON: ${err.message}`);
    }
    const check = validateManifest(parsed);
    if (!check.ok) throw new Error(check.error);
    const stat = await fsp.stat(backupPath);
    return { ...parsed, backupPath, backupSizeBytes: stat.size };
  } finally {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ─── restore ──────────────────────────────────────────────────── */

/**
 * Restore a backup over the live data folder. The caller is
 * responsible for getting explicit user consent (this REPLACES the
 * data folder) and for relaunching the app afterward — the running
 * SQLite connection still holds the old DB's handle, so the restored
 * DB only takes effect on next launch.
 *
 * Safety:
 *   - Validates the manifest before touching anything.
 *   - Every extracted entry is path-checked (resolveSafeDest) so a
 *     corrupt archive can't escape the data folder.
 *   - The existing data folder is RENAMED aside (not deleted) to a
 *     timestamped sibling, so the user can recover from Finder if the
 *     restore turns out wrong. Nothing of theirs is destroyed.
 *
 * @param {object} args
 * @param {string} args.backupPath
 * @param {(stage: string) => void} [args.onProgress]
 *   Stages: 'verify' | 'safety-copy' | 'extract' | 'merge-config' | 'done'.
 */
async function restoreBackup({ backupPath, onProgress } = {}) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error('Backup file not found');
  }
  const config = require('./config');
  const cfg = config.loadConfig();
  const dataDir = cfg.dataDir;
  if (!dataDir) throw new Error('No data folder configured');

  onProgress?.('verify');
  const manifest = await previewBackup(backupPath); // throws on invalid

  // Extract into a temp staging dir FIRST, validate every entry, then
  // swap it in. This means a corrupt archive fails before we've
  // touched the live data folder at all.
  onProgress?.('extract');
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-restore-'));
  let safetyDir = null;
  try {
    await runCommand('tar', ['-xzf', backupPath, '-C', tmpRoot]);
    const tmpEntries = await fsp.readdir(tmpRoot);
    if (tmpEntries.length !== 1) {
      throw new Error('Backup structure unexpected (expected a single top-level folder)');
    }
    const backupRoot = path.join(tmpRoot, tmpEntries[0]);

    // Path-check every entry we're about to bring in. resolveSafeDest
    // throws on any traversal/escape — belt-and-braces over the fact
    // that we control archive creation.
    const restoredEntries = await fsp.readdir(backupRoot);
    for (const ent of restoredEntries) {
      resolveSafeDest(dataDir, ent); // validates; we move dirs wholesale below
    }

    // Rename the live data folder aside. Open DB fd follows the inode
    // into the renamed folder, so the dying connection writes there,
    // not over the restored DB. We DON'T delete it — recoverable.
    onProgress?.('safety-copy');
    const existedBefore = fs.existsSync(dataDir);
    if (existedBefore) {
      safetyDir = `${dataDir}.pre-restore.${Date.now()}`;
      await fsp.rename(dataDir, safetyDir);
    }
    await fsp.mkdir(dataDir, { recursive: true });

    // Move each restored entry into the (now empty) data folder.
    for (const ent of restoredEntries) {
      const src = path.join(backupRoot, ent);
      const dst = resolveSafeDest(dataDir, ent);
      await fsp.rename(src, dst);
    }

    // Carry the user's backup history back into the restored folder so
    // a restore doesn't hide their other backups. Best-effort; the
    // safety copy still holds them if this fails.
    if (safetyDir) {
      const oldBackups = path.join(safetyDir, BACKUP_DIR_NAME);
      const newBackups = path.join(dataDir, BACKUP_DIR_NAME);
      try {
        if (fs.existsSync(oldBackups) && !fs.existsSync(newBackups)) {
          await fsp.cp(oldBackups, newBackups, { recursive: true });
        }
      } catch (_) { /* leave history in the safety copy */ }
    }

    // Re-apply ONLY the portable config keys from the backup's
    // config.json (AI keys, presets, export prefs). Never touches
    // dataDir / mode / network — the live machine keeps those.
    onProgress?.('merge-config');
    const restoredCfgPath = path.join(dataDir, 'config.json');
    if (fs.existsSync(restoredCfgPath)) {
      let restoredCfg = null;
      try {
        restoredCfg = JSON.parse(await fsp.readFile(restoredCfgPath, 'utf8'));
      } catch (err) {
        process.stderr.write(`[backup restore] backed-up config.json malformed (${err.message}) — skipping config merge\n`);
      }
      if (restoredCfg && typeof restoredCfg === 'object') {
        const merged = {};
        for (const k of PORTABLE_CONFIG_KEYS) {
          if (restoredCfg[k] !== undefined) merged[k] = restoredCfg[k];
        }
        if (Object.keys(merged).length > 0) config.updateConfig(merged);
      }
      // The restored config.json sits inside the data folder, which
      // is NOT where the app reads config from (that's userData). It's
      // harmless to leave as a record of what was restored.
    }

    onProgress?.('done');
    return {
      success: true,
      restoredManifest: manifest,
      dataDir,
      safetyDir,   // where the prior data was moved (null if data dir was empty)
    };
  } catch (err) {
    // If we already renamed the live folder aside but failed before
    // finishing, try to put it back so we don't leave the user with no
    // data folder at all.
    if (safetyDir && fs.existsSync(safetyDir) && !fs.existsSync(path.join(dataDir, 'database.sqlite'))) {
      try {
        await fsp.rm(dataDir, { recursive: true, force: true });
        await fsp.rename(safetyDir, dataDir);
      } catch (_) { /* best-effort rollback */ }
    }
    throw err;
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  createBackup,
  listBackups,
  lastBackup,
  previewBackup,
  restoreBackup,
  resolveBackupsDir,
};
