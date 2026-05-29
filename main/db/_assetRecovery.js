/**
 * Boot-time sweep for orphan `__tmp-*` files left behind when a
 * renumber operation crashed mid-flight. Strategy:
 *
 *   1. Find any product whose DB row points at a file that isn't on
 *      disk (the canonical NNN.ext path is missing).
 *   2. Look in the product's folder for `__tmp-*` files with the same
 *      extension. Hash each one and match against the missing DB row's
 *      `content_hash`. On a match, rename the tmp to the canonical path.
 *   3. Any leftover `__tmp-*` files with no DB match are orphans —
 *      log and delete.
 *
 * The DB is the source of truth for filepath; this sweep just brings
 * the disk back in line with it. Runs after `runAssetLayoutMigration`
 * so it sees the new nested layout.
 *
 * Hashing happens only when there's an actual mismatch detected, so
 * normal boots (no crash) skip the work entirely.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir, getDb } = require('./index');
const { TMP_PREFIX } = require('../util/assetPath');

function sha1Sync(filePath) {
  const hash = crypto.createHash('sha1');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function runAssetRecovery() {
  const dataDir = getDataDir();
  const assetsRoot = path.join(dataDir, 'assets');
  if (!fs.existsSync(assetsRoot)) return null;

  const db = getDb();
  // Pull every product_image row that's under the new nested layout.
  // Paths are stored relative to `<dataDir>/assets/` — e.g.
  // `KT-Ceramic/ROYAL/BF-R5232-GD/BF-R5232-GD-001.jpg` — so we match
  // any row whose filepath has at least three POSIX separators.
  // Legacy `products/...` rows (single segment + filename) are
  // handled by _assetMigration and skipped here.
  const rows = db.prepare(
    `SELECT id, product_id, filepath, filename, content_hash
       FROM product_images
      WHERE filepath LIKE '%/%/%/%'`
  ).all();

  // Group rows by their containing directory so we can do one folder
  // scan per dir.
  const dirToRows = new Map();
  for (const r of rows) {
    if (!r.filepath) continue;
    const dir = path.posix.dirname(r.filepath);
    if (!dirToRows.has(dir)) dirToRows.set(dir, []);
    dirToRows.get(dir).push(r);
  }

  let renamed = 0;
  let orphanRemoved = 0;
  let dbRewrites = 0;

  for (const [relDir, dirRows] of dirToRows) {
    // Stored relDir is relative to <dataDir>/assets/.
    const absDir = path.join(assetsRoot, relDir);
    if (!fs.existsSync(absDir)) continue;

    // List actual files in the dir, separating canonical files from tmps.
    let entries;
    try { entries = fs.readdirSync(absDir); }
    catch { continue; }
    const tmps = entries.filter((n) => n.startsWith(TMP_PREFIX));
    if (tmps.length === 0) continue;

    // Rows whose target file is missing on disk.
    const missingRows = dirRows.filter((r) => !fs.existsSync(path.join(assetsRoot, r.filepath)));
    if (missingRows.length === 0) {
      // tmp files exist but nothing's missing — pure orphans.
      for (const tmp of tmps) {
        try { fs.unlinkSync(path.join(absDir, tmp)); orphanRemoved += 1; }
        catch (_) {}
      }
      continue;
    }

    // Hash each tmp and try to match by content_hash. If a row doesn't
    // have a stored hash, fall back to the first tmp with the right
    // extension as a last-resort match.
    const tmpHashes = new Map(); // tmpName → hash | null
    for (const tmp of tmps) {
      try { tmpHashes.set(tmp, sha1Sync(path.join(absDir, tmp))); }
      catch { tmpHashes.set(tmp, null); }
    }

    const usedTmps = new Set();
    const upd = db.prepare('UPDATE product_images SET filepath = ?, filename = ?, content_hash = ? WHERE id = ?');

    for (const row of missingRows) {
      let matched = null;
      // First try: match by content_hash.
      if (row.content_hash) {
        for (const [tmp, h] of tmpHashes) {
          if (usedTmps.has(tmp)) continue;
          if (h && h === row.content_hash) { matched = tmp; break; }
        }
      }
      // Fallback: same extension, first unused.
      if (!matched) {
        const wantExt = path.extname(row.filepath).toLowerCase();
        for (const tmp of tmps) {
          if (usedTmps.has(tmp)) continue;
          if (path.extname(tmp).toLowerCase() === wantExt) { matched = tmp; break; }
        }
      }
      if (matched) {
        try {
          const targetAbs = path.join(assetsRoot, row.filepath);
          fs.renameSync(path.join(absDir, matched), targetAbs);
          usedTmps.add(matched);
          renamed += 1;
          // Backfill the content_hash if it was missing.
          if (!row.content_hash) {
            const h = tmpHashes.get(matched);
            if (h) upd.run(row.filepath, row.filename ?? path.basename(row.filepath), h, row.id);
          }
        } catch (err) {
          process.stderr.write(`[asset-recovery] rename failed: ${err.message}\n`);
        }
      }
    }

    // Any tmp files not matched are orphans — best-effort delete.
    for (const tmp of tmps) {
      if (usedTmps.has(tmp)) continue;
      try { fs.unlinkSync(path.join(absDir, tmp)); orphanRemoved += 1; }
      catch (_) {}
    }
  }

  if (renamed + orphanRemoved + dbRewrites > 0) {
    process.stdout.write(`[asset-recovery] renamed=${renamed} orphansRemoved=${orphanRemoved}\n`);
  }
  return { renamed, orphanRemoved, dbRewrites };
}

module.exports = { runAssetRecovery };
