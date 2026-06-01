const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { getDataDir } = require('./db');
const { slugify: baseSlugify } = require('./util/slug');
const { ensureDecodablePath } = require('./util/heic');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// `ai-source` accepts inputs for AI Studio bulk mode and is kept at a
// generous 2048 ceiling so models that can use 2K context (e.g. nano-banana
// pro, GPT-Image-2 high) get full-res inputs. Products stay capped at 1600
// because they're meant for catalog display sizes.
const KIND_MAX_DIMENSION = { products: 1600, brands: 512, watermarks: 1024, 'ai-source': 2048 };
const HASH_PREFIX_LEN = 10;
const SCAN_MAX_DEPTH = 5;
const MAX_IMAGES_PER_PRODUCT = 50;

// Thin wrapper preserving the historical default fallback ('asset') that
// imageManager callers rely on.
const slugify = (str, fallback = 'asset') => baseSlugify(str, fallback);

function sha1Hex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function getAssetsDir(kind) {
  const dir = kind ? path.join(getDataDir(), 'assets', kind) : path.join(getDataDir(), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Pick a clean filename for a new asset import. Returns the relative path
 * to use *and* whether an existing file already had identical content
 * (skipDedup case).
 *
 * Names are now `<slug>.<ext>`. If a different file already occupies that
 * slot, append `-2`, `-3`, etc. — but only after confirming the existing
 * file's content differs (compare hashes). Same content → reuse.
 *
 * `existingHashLookup(hash) → relativePath | null` is an optional callback
 * the caller can supply to dedup across previously-stored DB rows (e.g. for
 * product images we hand in a lookup against product_images.content_hash).
 */
async function planFileName({ destDir, kind, slug, ext, hashFull, existingHashLookup }) {
  // DB-level dedup: if a previous import has the same content hash and the
  // file is still on disk, reuse it.
  if (typeof existingHashLookup === 'function') {
    const hit = existingHashLookup(hashFull);
    if (hit) {
      const hitAbs = path.join(destDir, path.basename(hit));
      // Caller stores the kind/-prefixed path; only reuse if it actually
      // points to a file in our dest dir.
      if (hit.startsWith(`${kind}/`) && fs.existsSync(hitAbs)) {
        return { relativePath: hit, fileName: path.basename(hit), reused: true };
      }
    }
  }

  // Clean filename, no hash suffix.
  let candidate = `${slug}${ext}`;
  let n = 2;
  while (true) {
    const abs = path.join(destDir, candidate);
    if (!fs.existsSync(abs)) {
      return { relativePath: `${kind}/${candidate}`, fileName: candidate, reused: false };
    }
    // Existing file there — check if it has the same content.
    try {
      const existingHash = await sha1Hex(abs);
      if (existingHash === hashFull) {
        return { relativePath: `${kind}/${candidate}`, fileName: candidate, reused: true };
      }
    } catch { /* fall through, treat as collision */ }
    candidate = `${slug}-${n}${ext}`;
    n += 1;
    if (n > 9999) {
      throw new Error(`Couldn't find a free filename slot for ${slug}${ext}`);
    }
  }
}

/**
 * v0.12.0: import a brand icon under the company-scoped path
 *   `assets/<company-slug>/_brand-icons/<brand-slug>.<ext>`
 *
 * Returns { relativePath, hash, skipped } in the same shape as
 * importProductImage so callers can swap between them.
 */
async function importBrandIcon(sourcePath, { destDirRel, baseName } = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Brand icon source not found: ' + sourcePath);
  }
  if (!destDirRel) throw new Error('destDirRel required');
  if (!baseName) throw new Error('baseName required');
  const ext = path.extname(sourcePath).toLowerCase();
  const hashFull = await sha1Hex(sourcePath);
  // destDirRel is relative to `<dataDir>/assets/` — e.g. `KT-Ceramic/_brand-icons`.
  const destDirAbs = path.join(getDataDir(), 'assets', destDirRel);
  fs.mkdirSync(destDirAbs, { recursive: true });

  if (ext === '.svg') {
    const finalAbs = path.join(destDirAbs, `${baseName}.svg`);
    // If a file with same hash is already there, reuse.
    if (fs.existsSync(finalAbs)) {
      try {
        const existing = await sha1Hex(finalAbs);
        if (existing === hashFull) {
          return { relativePath: path.posix.join(destDirRel, `${baseName}.svg`), hash: hashFull, skipped: true };
        }
      } catch (_) {}
    }
    fs.copyFileSync(sourcePath, finalAbs);
    return { relativePath: path.posix.join(destDirRel, `${baseName}.svg`), hash: hashFull, skipped: false };
  }

  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`Unsupported brand icon type: ${ext}`);
  }
  const outExt = ext === '.png' ? '.png' : ext === '.webp' ? '.webp' : '.jpg';
  const finalName = `${baseName}${outExt}`;
  const finalAbs = path.join(destDirAbs, finalName);

  // Dedup: if a same-named file is already there with same content, reuse.
  if (fs.existsSync(finalAbs)) {
    try {
      const existing = await sha1Hex(finalAbs);
      if (existing === hashFull) {
        return { relativePath: path.posix.join(destDirRel, finalName), hash: hashFull, skipped: true };
      }
    } catch (_) {}
  }

  const max = KIND_MAX_DIMENSION.brands;
  const pipeline = sharp(sourcePath).rotate().resize({
    width: max,
    height: max,
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (outExt === '.png') {
    await pipeline.png({ compressionLevel: 9 }).toFile(finalAbs);
  } else if (outExt === '.webp') {
    await pipeline.webp({ quality: 88 }).toFile(finalAbs);
  } else {
    await pipeline.jpeg({ quality: 88, mozjpeg: true }).toFile(finalAbs);
  }
  return { relativePath: path.posix.join(destDirRel, finalName), hash: hashFull, skipped: false };
}

async function importAsset(kind, sourcePath, slugHint, opts = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Asset source not found: ' + sourcePath);
  }
  const destDir = getAssetsDir(kind);
  const ext = path.extname(sourcePath).toLowerCase();
  const hashFull = await sha1Hex(sourcePath);
  const slug = slugify(slugHint, kind);

  if (ext === '.svg') {
    const plan = await planFileName({
      destDir, kind, slug, ext: '.svg', hashFull,
      existingHashLookup: opts.existingHashLookup,
    });
    const destAbs = path.join(destDir, plan.fileName);
    if (!plan.reused) {
      fs.copyFileSync(sourcePath, destAbs);
    }
    return { relativePath: plan.relativePath, skipped: plan.reused, hash: hashFull };
  }

  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`Unsupported image type: ${ext}`);
  }

  const outExt = ext === '.png' ? '.png' : ext === '.webp' ? '.webp' : '.jpg';
  const plan = await planFileName({
    destDir, kind, slug, ext: outExt, hashFull,
    existingHashLookup: opts.existingHashLookup,
  });
  const destAbs = path.join(destDir, plan.fileName);

  if (plan.reused) {
    return { relativePath: plan.relativePath, skipped: true, hash: hashFull };
  }

  const max = KIND_MAX_DIMENSION[kind] ?? 1600;
  const pipeline = sharp(sourcePath).rotate().resize({
    width: max,
    height: max,
    fit: 'inside',
    withoutEnlargement: true,
  });

  if (outExt === '.png') {
    await pipeline.png({ compressionLevel: 9 }).toFile(destAbs);
  } else if (outExt === '.webp') {
    await pipeline.webp({ quality: 88 }).toFile(destAbs);
  } else {
    await pipeline.jpeg({ quality: 88, mozjpeg: true }).toFile(destAbs);
  }

  return { relativePath: plan.relativePath, skipped: false, hash: hashFull };
}

/**
 * v0.12.0: write a product image into an arbitrary `destDirRel` (a path
 * relative to dataDir, e.g. `assets/KT-Ceramic/ROYAL/BF-R5232-GD`) using
 * a caller-supplied `baseName` (e.g. `001`). The caller — db/productImages
 * — computes the dir from the product/brand/company context, and the
 * baseName from `order_index`.
 *
 * Dedup: if `existingHashLookup(hash)` returns a relative path whose file
 * still exists, we reuse it without writing again. The check is content-
 * addressed (SHA-1 of the bytes), so case / filename differences don't
 * matter.
 *
 * Returns { relativePath, hash, skipped } where `skipped: true` means the
 * caller should NOT insert a new product_images row (the dedup hit
 * already has one).
 */
async function importProductImage(sourcePath, { destDirRel, baseName, existingHashLookup } = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Asset source not found: ' + sourcePath);
  }
  if (!destDirRel) throw new Error('destDirRel required');
  if (!baseName) throw new Error('baseName required');

  // v0.41.0: HEIC/HEIF (iPhone photos) can't be decoded by our sharp build,
  // so transcode to a temp JPEG up front and import THAT. Non-HEIC inputs pass
  // straight through (cleanup is null). The temp file is removed in `finally`.
  const heicConv = await ensureDecodablePath(sourcePath);
  const src = heicConv.path;
  try {
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`Unsupported image type: ${ext}`);
  }
  const hashFull = await sha1Hex(src);

  // DB-level dedup: if a previous product_image with the same content
  // hash already exists for this product, reuse it. The caller's lookup
  // is scoped to the product so reuse is per-product, not global. Paths
  // are stored relative to `<dataDir>/assets/` (the convention since
  // v0.5.x), so the disk lookup needs the `assets/` segment prepended.
  if (typeof existingHashLookup === 'function') {
    const hit = existingHashLookup(hashFull);
    if (hit) {
      const hitAbs = path.join(getDataDir(), 'assets', hit);
      if (fs.existsSync(hitAbs)) {
        return { relativePath: hit, hash: hashFull, skipped: true };
      }
    }
  }

  const outExt = ext === '.png' ? '.png' : ext === '.webp' ? '.webp' : '.jpg';
  // destDirRel is relative to <dataDir>/assets/ (e.g. `KT-Ceramic/ROYAL/BF-R5232-GD`).
  // Prepend `assets` for the actual filesystem path.
  const destDirAbs = path.join(getDataDir(), 'assets', destDirRel);
  fs.mkdirSync(destDirAbs, { recursive: true });
  const fileName = `${baseName}${outExt}`;
  const destAbs = path.join(destDirAbs, fileName);

  // If a different file already occupies the slot (shouldn't happen since
  // the caller picks an unused index — but defensive), pick the next
  // numeric slot. This is rare enough that we don't bother with hashing
  // the existing file; the caller is the authority on slot allocation.
  let finalAbs = destAbs;
  let finalName = fileName;
  if (fs.existsSync(finalAbs)) {
    // The slot is taken — caller should have given us a free one. Bump
    // by appending `-2`, `-3` rather than overwriting. Same collision
    // rule as the pre-v0.12 importAsset path.
    let n = 2;
    while (fs.existsSync(finalAbs) && n < 1000) {
      finalName = `${baseName}-${n}${outExt}`;
      finalAbs = path.join(destDirAbs, finalName);
      n += 1;
    }
    if (fs.existsSync(finalAbs)) {
      throw new Error(`Couldn't find a free filename slot in ${destDirRel}`);
    }
  }

  const max = KIND_MAX_DIMENSION.products;
  const pipeline = sharp(src).rotate().resize({
    width: max,
    height: max,
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (outExt === '.png') {
    await pipeline.png({ compressionLevel: 9 }).toFile(finalAbs);
  } else if (outExt === '.webp') {
    await pipeline.webp({ quality: 88 }).toFile(finalAbs);
  } else {
    await pipeline.jpeg({ quality: 88, mozjpeg: true }).toFile(finalAbs);
  }

  return {
    relativePath: path.posix.join(destDirRel, finalName),
    hash: hashFull,
    skipped: false,
  };
  } finally {
    heicConv.cleanup?.();
  }
}

async function importProductImageFromBytes(buffer, ext, { destDirRel, baseName, existingHashLookup } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskh-paste-'));
  const safeExt = (ext || '.png').toLowerCase().replace(/^([^.])/, '.$1');
  const tmpPath = path.join(tmpDir, `paste${safeExt}`);
  fs.writeFileSync(tmpPath, Buffer.from(buffer));
  try {
    return await importProductImage(tmpPath, { destDirRel, baseName, existingHashLookup });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * v0.12.0: Move a product's entire image folder from one nested location to
 * another (e.g. when the user changes brand or renames the SKU). Returns
 * the list of (oldRel, newRel) pairs the caller should apply to DB rows.
 *
 * Strategy:
 *   - mkdir new dir
 *   - For each file in old dir, rename to new dir (same filename)
 *   - Best-effort rmdir old dir if it's now empty
 *
 * Returns null when source dir doesn't exist (e.g. first-time edit on a
 * product that never had images). Throws on actual filesystem error so
 * the caller can roll back DB changes.
 */
function moveProductDir(oldRel, newRel) {
  if (oldRel === newRel) return [];
  const dataDir = getDataDir();
  // oldRel / newRel are relative to `<dataDir>/assets/` — e.g.
  // `KT-Ceramic/ROYAL/BF-R5232-GD`. Disk lookups prepend `assets/`.
  const oldAbs = path.join(dataDir, 'assets', oldRel);
  const newAbs = path.join(dataDir, 'assets', newRel);

  if (!fs.existsSync(oldAbs)) {
    return [];
  }

  fs.mkdirSync(newAbs, { recursive: true });

  const entries = fs.readdirSync(oldAbs, { withFileTypes: true });
  const moves = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fromAbs = path.join(oldAbs, entry.name);
    const toAbs = path.join(newAbs, entry.name);
    fs.renameSync(fromAbs, toAbs);
    moves.push({
      oldRel: path.posix.join(oldRel, entry.name),
      newRel: path.posix.join(newRel, entry.name),
    });
  }

  // Best-effort cleanup of empty parent dirs. Stop at the `assets/`
  // directory itself so we don't try to remove it.
  try {
    let cur = oldAbs;
    const assetsAbs = path.join(dataDir, 'assets');
    while (cur !== assetsAbs) {
      try { fs.rmdirSync(cur); } catch { break; }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch (_) {}

  return moves;
}

/**
 * v0.12.0: rename a brand-slug subdirectory in place (used when a brand
 * is renamed). Walks every company that owns this brand and moves
 *   <company>/<old-brand-slug>/  →  <company>/<new-brand-slug>/
 *
 * Returns an array of (oldRel, newRel) pairs covering every file inside.
 * The caller updates the corresponding product_images rows in one tx.
 */
function moveBrandDirEverywhere(companySlugs, oldBrandSlug, newBrandSlug) {
  if (oldBrandSlug === newBrandSlug) return [];
  const dataDir = getDataDir();
  const allMoves = [];
  for (const companySlug of companySlugs) {
    // Stored paths are relative to <dataDir>/assets/ — no leading `assets/`.
    const oldRel = path.posix.join(companySlug, oldBrandSlug);
    const newRel = path.posix.join(companySlug, newBrandSlug);
    const oldAbs = path.join(dataDir, 'assets', oldRel);
    if (!fs.existsSync(oldAbs)) continue;
    const newAbs = path.join(dataDir, 'assets', newRel);
    fs.mkdirSync(newAbs, { recursive: true });
    const skuEntries = fs.readdirSync(oldAbs, { withFileTypes: true });
    for (const skuEntry of skuEntries) {
      if (!skuEntry.isDirectory()) continue;
      const skuOldAbs = path.join(oldAbs, skuEntry.name);
      const skuNewAbs = path.join(newAbs, skuEntry.name);
      fs.mkdirSync(skuNewAbs, { recursive: true });
      const fileEntries = fs.readdirSync(skuOldAbs, { withFileTypes: true });
      for (const f of fileEntries) {
        if (!f.isFile()) continue;
        fs.renameSync(path.join(skuOldAbs, f.name), path.join(skuNewAbs, f.name));
        allMoves.push({
          oldRel: path.posix.join(oldRel, skuEntry.name, f.name),
          newRel: path.posix.join(newRel, skuEntry.name, f.name),
        });
      }
      try { fs.rmdirSync(skuOldAbs); } catch (_) {}
    }
    try { fs.rmdirSync(oldAbs); } catch (_) {}
  }
  return allMoves;
}

/* ── Auto-match folder scan ─────────────────────────────────── */

function scanImagesRecursive(rootPath, maxDepth = SCAN_MAX_DEPTH) {
  const results = [];
  if (!rootPath || !fs.existsSync(rootPath)) return results;
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip dotfiles/hidden dirs
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // v0.41.0: also pick up HEIC/HEIF (iPhone photos) — they're transcoded
        // to JPEG when imported, so a folder dragged off a phone matches too.
        if (IMAGE_EXTS.has(ext) || ext === '.heic' || ext === '.heif') results.push(full);
      }
    }
  }
  walk(rootPath, 0);
  return results;
}

/**
 * Given an image file path and the set of known SKUs (lowercased),
 * decide which SKU it belongs to and what its position hint should be.
 */
function findCandidateSku(filePath, importRoot, skuSet) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const lowerBase = baseName.toLowerCase().trim();
  const parentDirAbs = path.dirname(filePath);
  const parentName = path.basename(parentDirAbs).toLowerCase().trim();

  // 1. Direct full-name match
  if (skuSet.has(lowerBase)) {
    return { sku: lowerBase, indexHint: 1, sortKey: lowerBase };
  }

  // 2. Trailing numeric suffix: abc-123-2 / abc-123_2 / "abc-123 2"
  const suffixMatch = lowerBase.match(/^(.*?)[-_\s](\d+)$/);
  if (suffixMatch) {
    const [, prefix, num] = suffixMatch;
    if (skuSet.has(prefix)) {
      return { sku: prefix, indexHint: parseInt(num, 10), sortKey: lowerBase };
    }
  }

  // 3. Parent folder named after the SKU (must not be the import root itself)
  if (path.resolve(parentDirAbs) !== path.resolve(importRoot) && skuSet.has(parentName)) {
    if (/^\d+$/.test(lowerBase)) {
      return { sku: parentName, indexHint: parseInt(lowerBase, 10), sortKey: lowerBase };
    }
    if (lowerBase === 'main' || lowerBase === 'primary' || lowerBase === 'cover') {
      return { sku: parentName, indexHint: 1, sortKey: lowerBase };
    }
    if (suffixMatch) {
      return { sku: parentName, indexHint: parseInt(suffixMatch[2], 10), sortKey: lowerBase };
    }
    return { sku: parentName, indexHint: 999, sortKey: lowerBase };
  }

  return null;
}

function groupAndSortMatches(filePaths, importRoot, skuSet) {
  const groups = new Map();
  const unmatched = [];
  for (const file of filePaths) {
    const c = findCandidateSku(file, importRoot, skuSet);
    if (!c) { unmatched.push(file); continue; }
    if (!groups.has(c.sku)) groups.set(c.sku, []);
    groups.get(c.sku).push({
      sourcePath: file,
      indexHint: c.indexHint ?? 999,
      sortKey:   c.sortKey  ?? path.basename(file).toLowerCase(),
    });
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      if (a.indexHint !== b.indexHint) return a.indexHint - b.indexHint;
      return a.sortKey.localeCompare(b.sortKey);
    });
  }
  return { groups, unmatched };
}

module.exports = {
  IMAGE_EXTS,
  MAX_IMAGES_PER_PRODUCT,
  SCAN_MAX_DEPTH,
  slugify,
  sha1Hex,
  importAsset,
  importBrandIcon,
  importProductImage,
  importProductImageFromBytes,
  moveProductDir,
  moveBrandDirEverywhere,
  scanImagesRecursive,
  findCandidateSku,
  groupAndSortMatches,
};
