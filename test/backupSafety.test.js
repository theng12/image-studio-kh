/**
 * v0.49.31: tests for the backup/restore path-safety + manifest
 * helpers. A restore extracts an archive over the user's data folder,
 * so any path-traversal escape here would let a corrupt/hostile backup
 * write outside the data dir. These guards are the defense; this is
 * their regression test. The Electron-coupled orchestration in
 * main/backupManager.js can't be unit-tested without booting the app,
 * so the pure helpers carry the safety contract and the coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BACKUP_EXT,
  isPathInside,
  safeArchiveEntry,
  resolveSafeDest,
  backupStamp,
  backupFilename,
  isBackupFilename,
  entriesLookLikeDataDir,
  validateManifest,
} = require('../main/util/backupSafety');

/* ── isPathInside ──────────────────────────────────────────────── */

test('isPathInside — true for a nested child', () => {
  assert.equal(isPathInside('/data', '/data/assets/a.jpg'), true);
  assert.equal(isPathInside('/data', '/data/database.sqlite'), true);
});

test('isPathInside — false for the root itself', () => {
  assert.equal(isPathInside('/data', '/data'), false);
});

test('isPathInside — false for a sibling or parent escape', () => {
  assert.equal(isPathInside('/data', '/data/../etc/passwd'), false);
  assert.equal(isPathInside('/data', '/other/x'), false);
  assert.equal(isPathInside('/data', '/datax/y'), false); // prefix-but-not-child
});

/* ── safeArchiveEntry ──────────────────────────────────────────── */

test('safeArchiveEntry — passes normal relative paths and strips leading slash', () => {
  assert.equal(safeArchiveEntry('assets/products/a.jpg'), 'assets/products/a.jpg');
  assert.equal(safeArchiveEntry('/database.sqlite'), 'database.sqlite');
  assert.equal(safeArchiveEntry('manifest.json'), 'manifest.json');
});

test('safeArchiveEntry — rejects posix traversal', () => {
  assert.throws(() => safeArchiveEntry('../escape'), /traversal/);
  assert.throws(() => safeArchiveEntry('assets/../../escape'), /traversal/);
  assert.throws(() => safeArchiveEntry('a/b/../../../c'), /traversal/);
});

test('safeArchiveEntry — rejects windows-style traversal', () => {
  assert.throws(() => safeArchiveEntry('..\\escape'), /traversal/);
  assert.throws(() => safeArchiveEntry('assets\\..\\..\\escape'), /traversal/);
});

test('safeArchiveEntry — rejects empty / non-string input', () => {
  assert.throws(() => safeArchiveEntry(''));
  assert.throws(() => safeArchiveEntry('   '));
  assert.throws(() => safeArchiveEntry(null));
  assert.throws(() => safeArchiveEntry(undefined));
});

test('safeArchiveEntry — a leading-slash absolute is normalized to a safe relative', () => {
  // We strip leading slashes rather than reject — so an entry like
  // "/database.sqlite" lands at <root>/database.sqlite, never at the
  // filesystem root. The traversal check still guards the dangerous case.
  assert.equal(safeArchiveEntry('/database.sqlite'), 'database.sqlite');
  assert.throws(() => safeArchiveEntry('/../../etc/passwd'), /traversal/);
});

/* ── resolveSafeDest ───────────────────────────────────────────── */

test('resolveSafeDest — resolves inside the root', () => {
  const root = '/tmp/restore-target';
  assert.equal(resolveSafeDest(root, 'assets/a.jpg'), path.resolve(root, 'assets/a.jpg'));
  assert.equal(resolveSafeDest(root, 'database.sqlite'), path.resolve(root, 'database.sqlite'));
});

test('resolveSafeDest — throws when an entry would escape the root', () => {
  const root = '/tmp/restore-target';
  assert.throws(() => resolveSafeDest(root, '../../etc/passwd'), /traversal|escapes/);
  assert.throws(() => resolveSafeDest(root, 'assets/../../../escape'), /traversal|escapes/);
});

/* ── backupStamp / backupFilename / isBackupFilename ───────────── */

test('backupStamp — formats a fixed date deterministically', () => {
  // Construct in local time so the assertion matches the local-time formatter.
  const d = new Date(2026, 4, 31, 21, 7); // 2026-05-31 21:07 local
  assert.equal(backupStamp(d), '2026-05-31-2107');
});

test('backupFilename — includes version + stamp + extension', () => {
  const name = backupFilename('2026-05-31-2107', '0.49.31');
  assert.equal(name, 'image-studio-kh-backup-v0.49.31-2026-05-31-2107.iskhbackup');
  assert.ok(name.endsWith(`.${BACKUP_EXT}`));
});

test('backupFilename — tolerates a missing version', () => {
  assert.equal(backupFilename('2026-05-31-2107'), 'image-studio-kh-backup-2026-05-31-2107.iskhbackup');
});

test('isBackupFilename — accepts our names, rejects others', () => {
  assert.equal(isBackupFilename('image-studio-kh-backup-v0.49.31-2026-05-31-2107.iskhbackup'), true);
  assert.equal(isBackupFilename('image-studio-kh-backup-2026-05-31-2107.iskhbackup'), true);
  assert.equal(isBackupFilename('random.tar.gz'), false);
  assert.equal(isBackupFilename('image-studio-kh-backup.txt'), false);
  assert.equal(isBackupFilename('.DS_Store'), false);
  assert.equal(isBackupFilename(null), false);
});

/* ── entriesLookLikeDataDir ────────────────────────────────────── */

test('entriesLookLikeDataDir — true when DB or an asset tree is present', () => {
  assert.equal(entriesLookLikeDataDir(['database.sqlite', 'config.json']), true);
  assert.equal(entriesLookLikeDataDir(['assets']), true);
  assert.equal(entriesLookLikeDataDir(['processed', 'ai-gallery']), true);
});

test('entriesLookLikeDataDir — false for empty / unrelated folders', () => {
  assert.equal(entriesLookLikeDataDir([]), false);
  assert.equal(entriesLookLikeDataDir(['Documents', 'notes.txt']), false);
  assert.equal(entriesLookLikeDataDir('not-an-array'), false);
});

/* ── validateManifest ──────────────────────────────────────────── */

function goodManifest() {
  return {
    kind: BACKUP_KIND,
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    appVersion: '0.49.31',
    createdAt: 1748725620000,
    includes: ['database.sqlite', 'config.json', 'assets/'],
  };
}

test('validateManifest — accepts a well-formed manifest', () => {
  const res = validateManifest(goodManifest());
  assert.equal(res.ok, true);
  assert.equal(res.manifest.kind, BACKUP_KIND);
});

test('validateManifest — rejects a wrong/missing kind marker', () => {
  const m = goodManifest(); delete m.kind;
  assert.equal(validateManifest(m).ok, false);
  const m2 = goodManifest(); m2.kind = 'something-else';
  assert.equal(validateManifest(m2).ok, false);
});

test('validateManifest — rejects a newer format version', () => {
  const m = goodManifest(); m.backupFormatVersion = BACKUP_FORMAT_VERSION + 1;
  const res = validateManifest(m);
  assert.equal(res.ok, false);
  assert.match(res.error, /newer version/);
});

test('validateManifest — rejects a non-integer format version', () => {
  const m = goodManifest(); m.backupFormatVersion = 'one';
  assert.equal(validateManifest(m).ok, false);
});

test('validateManifest — rejects a manifest with no DB snapshot', () => {
  const m = goodManifest(); m.includes = ['assets/', 'config.json'];
  const res = validateManifest(m);
  assert.equal(res.ok, false);
  assert.match(res.error, /no database snapshot/);
});

test('validateManifest — rejects empty / non-object input', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest(undefined).ok, false);
  assert.equal(validateManifest('x').ok, false);
  const m = goodManifest(); m.includes = [];
  assert.equal(validateManifest(m).ok, false);
});
