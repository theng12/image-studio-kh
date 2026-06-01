/**
 * v0.49.31: pure path-safety + manifest helpers for the local
 * backup/restore feature (main/backupManager.js).
 *
 * Everything here is dependency-free (only node:path) so it can be
 * unit-tested without booting Electron or opening a database — the
 * same reason main/util/slug.js, phash.js, etc. live as standalone
 * helpers. The Electron-coupled orchestration (tar, db.backup(),
 * dialogs) lives in main/backupManager.js and imports these.
 *
 * The whole point of pulling these out: a restore EXTRACTS an archive
 * over the user's data folder. If an attacker (or a corrupted archive)
 * could smuggle a `../../etc/...` entry past us we'd write outside the
 * data folder. These guards are the defense, and they're the thing
 * most worth a regression test.
 */

const path = require('node:path');

// Bump when the on-disk backup layout changes incompatibly. Restore
// refuses a backup whose format it doesn't understand.
const BACKUP_FORMAT_VERSION = 1;

// Marker baked into every manifest so we can tell our backups apart
// from an arbitrary .tar.gz the user renamed.
const BACKUP_KIND = 'image-studio-kh-backup';

// Custom extension (a gzipped tar underneath). Custom so double-click
// in Finder doesn't auto-expand it and it's obviously ours.
const BACKUP_EXT = 'iskhbackup';

// The subfolder under <dataDir> where backups are written by default.
// Excluded from the archive itself so a backup never contains older
// backups (which would compound on disk geometrically).
const BACKUP_DIR_NAME = 'backups';

// Top-level entries of the data folder a backup captures. Anything not
// in this list (notably the backups/ folder and dotfiles) is left out.
// database.sqlite's -wal / -shm sidecars are handled separately by the
// snapshot step (db.backup() produces a single consistent file).
const BACKUP_DATA_ENTRIES = ['database.sqlite', 'assets', 'processed', 'ai-gallery', 'overlays'];

/**
 * Is `child` strictly inside `parent`? Used to reject any archive
 * entry that would extract outside the target folder. Resolves both
 * sides first so `..` segments and symlink-ish trickery normalize
 * away before comparison.
 *
 * Returns false when child === parent (an entry can't BE the root) and
 * when child climbs out via `..`.
 */
function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * Validate a single archive-entry relative path before extraction.
 * Rejects absolute paths, empty strings, and anything containing a
 * `..` traversal segment. Returns the cleaned relative path (leading
 * slashes stripped) or throws.
 */
function safeArchiveEntry(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('Archive entry path is empty');
  }
  const cleaned = relPath.replace(/^[/\\]+/, '');
  // Split on either separator so a Windows-style entry can't sneak a
  // `..` past a posix-only check.
  const segments = cleaned.split(/[/\\]/);
  if (segments.some((s) => s === '..')) {
    throw new Error(`Unsafe archive entry (path traversal): ${relPath}`);
  }
  if (path.isAbsolute(cleaned)) {
    throw new Error(`Unsafe archive entry (absolute path): ${relPath}`);
  }
  return cleaned;
}

/**
 * Resolve an archive entry against a destination root and assert the
 * result stays inside that root. Returns the absolute destination.
 * Throws on any escape. This is the belt-and-braces check run for
 * every extracted file even after safeArchiveEntry().
 */
function resolveSafeDest(rootDir, relPath) {
  const cleaned = safeArchiveEntry(relPath);
  const dest = path.resolve(rootDir, cleaned);
  const rootAbs = path.resolve(rootDir);
  if (dest !== rootAbs && !isPathInside(rootAbs, dest)) {
    throw new Error(`Archive entry escapes target folder: ${relPath}`);
  }
  return dest;
}

/**
 * Build the timestamp slug used in backup filenames. Pure — the caller
 * supplies the Date so this stays testable (no Date.now() inside).
 * Format: YYYY-MM-DD-HHmm (local time), e.g. 2026-05-31-2147.
 */
function backupStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}`
  );
}

/** Default backup filename for a given timestamp slug + app version. */
function backupFilename(stamp, appVersion) {
  const v = appVersion ? `v${appVersion}-` : '';
  return `image-studio-kh-backup-${v}${stamp}.${BACKUP_EXT}`;
}

/**
 * Recognise a filename produced by backupFilename(). Used to filter a
 * backups/ folder listing down to actual backups (so a stray file the
 * user dropped in there doesn't show up as a restorable backup) and to
 * reject restore requests pointed at a non-backup file.
 */
function isBackupFilename(name) {
  if (typeof name !== 'string') return false;
  return new RegExp(`^image-studio-kh-backup-.+\\.${BACKUP_EXT}$`).test(name);
}

/**
 * Decide whether a list of a folder's top-level entry names looks like
 * one of our data folders. Mirrors the fs-based looksLikeOurDataDir in
 * main/ipc/settings.js but takes the names directly so it's pure +
 * testable. A folder qualifies if it has the DB or any asset tree.
 */
function entriesLookLikeDataDir(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => BACKUP_DATA_ENTRIES.includes(e));
}

/**
 * Validate a parsed manifest object. Returns { ok: true, manifest } on
 * success or { ok: false, error } with a user-readable reason. Kept as
 * a return value (not a throw) so callers can format the message into a
 * toast without a try/catch — but restoreBackup throws on { ok:false }.
 */
function validateManifest(obj) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Backup manifest is missing or not an object' };
  }
  if (obj.kind !== BACKUP_KIND) {
    return { ok: false, error: 'Not an Image Studio KH backup (wrong or missing kind marker)' };
  }
  if (!Number.isInteger(obj.backupFormatVersion)) {
    return { ok: false, error: 'Backup manifest has no valid format version' };
  }
  if (obj.backupFormatVersion > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      error: `Backup was made by a newer version of the app (format v${obj.backupFormatVersion}; this app understands up to v${BACKUP_FORMAT_VERSION}). Update the app, then restore.`,
    };
  }
  if (!Array.isArray(obj.includes) || obj.includes.length === 0) {
    return { ok: false, error: 'Backup manifest lists no contents' };
  }
  if (!obj.includes.includes('database.sqlite')) {
    return { ok: false, error: 'Backup is incomplete — it has no database snapshot' };
  }
  return { ok: true, manifest: obj };
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BACKUP_EXT,
  BACKUP_DIR_NAME,
  BACKUP_DATA_ENTRIES,
  isPathInside,
  safeArchiveEntry,
  resolveSafeDest,
  backupStamp,
  backupFilename,
  isBackupFilename,
  entriesLookLikeDataDir,
  validateManifest,
};
