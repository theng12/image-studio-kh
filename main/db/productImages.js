const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDb, getDataDir } = require('./index');
const { parseJson } = require('./_util');
const { productAssetDir, productImageBasename, TMP_PREFIX } = require('../util/assetPath');

// Late-required to avoid module-load circularity (products → productImages → products).
let _products;
function getProducts() { return _products ?? (_products = require('./products')); }
let _brands;
function getBrands() { return _brands ?? (_brands = require('./brands')); }
let _companies;
function getCompanies() { return _companies ?? (_companies = require('./companies')); }
let _imageManager;
function getImageManager() { return _imageManager ?? (_imageManager = require('../imageManager')); }
// v0.22.6: audit log
let _audit;
function getAudit() { return _audit ?? (_audit = require('./auditLog')); }
function basename(p) { return p ? String(p).split('/').pop() : null; }

function rowToImage(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_id,
    filename: row.filename,
    filepath: row.filepath,
    originalFilepath: row.original_filepath,
    orderIndex: row.order_index,
    isProcessed: !!row.is_processed,
    processedFilepath: row.processed_filepath,
    workspaceSettings: parseJson(row.workspace_settings, {}),
    contentHash: row.content_hash ?? null,
    perceptualHash: row.perceptual_hash ?? null,
    fileSize: row.file_size ?? null,
    dedupExempt: !!row.dedup_exempt,
    createdAt: row.created_at,
  };
}

/**
 * Look up an existing image on this product by SHA-1 hash. Returns the
 * relative filepath (e.g. "assets/KT-Ceramic/ROYAL/BF-R5232-GD/001.jpg")
 * if found, else null. imageManager uses this to dedup before deciding
 * on a filename.
 */
function findByHashForProduct(productId, contentHash) {
  if (!productId || !contentHash) return null;
  const row = getDb()
    .prepare(`SELECT filepath FROM product_images WHERE product_id = ? AND content_hash = ?`)
    .get(productId, contentHash);
  return row ? row.filepath : null;
}

function listByProduct(productId) {
  const out = getDb()
    .prepare(
      'SELECT * FROM product_images WHERE product_id = ? ORDER BY order_index ASC',
    )
    .all(productId)
    .map(rowToImage);
  // v0.31.0: lazily backfill file_size for rows that don't have it yet
  // (legacy rows + fresh imports). One stat per row, only when null, then
  // cached — so subsequent lists are free. Best-effort: a missing file
  // just leaves the size null rather than throwing.
  const db = getDb();
  const upd = db.prepare('UPDATE product_images SET file_size = ? WHERE id = ?');
  for (const img of out) {
    if (img.fileSize == null && img.filepath) {
      try {
        const sz = fs.statSync(path.join(getDataDir(), 'assets', img.filepath)).size;
        upd.run(sz, img.id);
        img.fileSize = sz;
      } catch (_) { /* file missing → leave null */ }
    }
  }
  return out;
}

function getByFilepath(productId, filepath) {
  const row = getDb()
    .prepare('SELECT * FROM product_images WHERE product_id = ? AND filepath = ?')
    .get(productId, filepath);
  return rowToImage(row);
}

function nextOrderIndex(productId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM product_images WHERE product_id = ?')
    .get(productId);
  return (row?.m ?? -1) + 1;
}

/**
 * v0.12.0: compute the canonical asset directory for a product (relative
 * to dataDir). Needs the product, its brand (or null), and its company.
 * Looked up here rather than passed in because most callers only have
 * the productId.
 */
function dirForProduct(productId) {
  const product = getProducts().get(productId);
  if (!product) throw new Error('Product not found: ' + productId);
  const company = getCompanies().get(product.companyId);
  if (!company) throw new Error('Company not found for product: ' + product.companyId);
  const brand = product.brandId ? getBrands().get(product.brandId) : null;
  return { product, company, brand, dir: productAssetDir(company, brand, product) };
}

/**
 * Renumber every image in a product folder so the on-disk filename
 * matches its current `order_index`. Two-phase atomic rename: first move
 * each file to a `__tmp-<uuid>` name, then rename each tmp to its
 * canonical NNN slot. Crash-safe in that the next-boot recovery sweep
 * can match leftover __tmp files to DB rows via content_hash.
 *
 * Returns nothing — DB rows' filepath/filename fields are updated in
 * the same transaction as the file moves.
 */
function renumberFiles(productId) {
  const { product, dir } = dirForProduct(productId);
  const images = listByProduct(productId); // already sorted by order_index
  if (images.length === 0) return;

  const dataDir = getDataDir();
  // Stored filepaths are relative to `<dataDir>/assets/`. Prepend that
  // segment whenever we touch the actual filesystem.
  const assetsRoot = path.join(dataDir, 'assets');
  const dirAbs = path.join(assetsRoot, dir);

  // Compute desired final state per image. The basename is
  // `<sku-slug>-NNN` so a file dragged out of its folder still reads as
  // belonging to the product (v0.12.1 change — v0.12.0 used bare NNN).
  const plan = images.map((img, idx) => {
    const ext = path.extname(img.filepath).toLowerCase() || '.jpg';
    const newBase = productImageBasename(product, idx);
    const newName = `${newBase}${ext}`;
    const newRel = path.posix.join(dir, newName);
    return { id: img.id, oldRel: img.filepath, newRel, newName };
  });

  // Skip if everything's already in place.
  const realMoves = plan.filter((p) => p.oldRel !== p.newRel);
  if (realMoves.length === 0) return;

  fs.mkdirSync(dirAbs, { recursive: true });

  // Phase 1: move every involved file to a unique tmp name. Done outside
  // the DB tx because rename is synchronous and we want to fail-fast on
  // disk errors before touching the DB. If phase 1 errors mid-loop, we
  // leave behind tmp files for the boot recovery sweep to reconcile via
  // content_hash; the DB remains unchanged so the app is still consistent.
  const tmpMap = new Map(); // id → tmpRel
  for (const m of realMoves) {
    const oldAbs = path.join(assetsRoot, m.oldRel);
    if (!fs.existsSync(oldAbs)) continue;
    const tmpRel = path.posix.join(dir, `${TMP_PREFIX}${crypto.randomUUID()}${path.extname(m.oldRel)}`);
    const tmpAbs = path.join(assetsRoot, tmpRel);
    fs.renameSync(oldAbs, tmpAbs);
    tmpMap.set(m.id, tmpRel);
  }

  // Phase 2: in one DB transaction, rename each tmp to the canonical
  // path and update the row.
  const db = getDb();
  const upd = db.prepare('UPDATE product_images SET filepath = ?, filename = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const m of plan) {
      const tmpRel = tmpMap.get(m.id);
      if (tmpRel) {
        const tmpAbs = path.join(assetsRoot, tmpRel);
        const newAbs = path.join(assetsRoot, m.newRel);
        if (fs.existsSync(tmpAbs)) {
          fs.renameSync(tmpAbs, newAbs);
        }
      }
      upd.run(m.newRel, m.newName, m.id);
    }
  });
  tx();
}

/**
 * Insert a row + write the source file into the product's nested folder
 * at the next available NNN slot. Returns { image, skipped } where
 * skipped=true means dedup-by-content-hash hit an existing row and no
 * new file was written.
 *
 * Used by the IPC handlers for `images:importForProduct`, the auto-match
 * pipeline, the AI promote-to-product flow, and tests.
 */
async function addFromSource(productId, sourcePath, { originalFilepath } = {}) {
  const { product, dir } = dirForProduct(productId);
  const existing = listByProduct(productId);
  const baseName = productImageBasename(product, existing.length);

  const im = getImageManager();
  const hashLookup = (h) => findByHashForProduct(productId, h);
  const { relativePath, hash, skipped } = await im.importProductImage(sourcePath, {
    destDirRel: dir,
    baseName,
    existingHashLookup: hashLookup,
  });

  if (skipped) {
    const reused = getByFilepath(productId, relativePath);
    return { image: reused, skipped: true };
  }

  const id = crypto.randomUUID();
  const ts = Date.now();
  const order = existing.length;
  const filename = path.posix.basename(relativePath);
  getDb()
    .prepare(
      `INSERT INTO product_images
       (id, product_id, filename, filepath, original_filepath, order_index, is_processed, processed_filepath, workspace_settings, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?, ?)`,
    )
    .run(id, productId, filename, relativePath, originalFilepath ?? null, order, hash ?? null, ts);

  return {
    image: rowToImage(getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(id)),
    skipped: false,
  };
}

async function addFromBytes(productId, buffer, ext, { originalFilepath } = {}) {
  const { product, dir } = dirForProduct(productId);
  const existing = listByProduct(productId);
  const baseName = productImageBasename(product, existing.length);

  const im = getImageManager();
  const hashLookup = (h) => findByHashForProduct(productId, h);
  const { relativePath, hash, skipped } = await im.importProductImageFromBytes(buffer, ext, {
    destDirRel: dir,
    baseName,
    existingHashLookup: hashLookup,
  });

  if (skipped) {
    const reused = getByFilepath(productId, relativePath);
    return { image: reused, skipped: true };
  }

  const id = crypto.randomUUID();
  const ts = Date.now();
  const order = existing.length;
  const filename = path.posix.basename(relativePath);
  getDb()
    .prepare(
      `INSERT INTO product_images
       (id, product_id, filename, filepath, original_filepath, order_index, is_processed, processed_filepath, workspace_settings, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?, ?)`,
    )
    .run(id, productId, filename, relativePath, originalFilepath ?? null, order, hash ?? null, ts);

  return {
    image: rowToImage(getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(id)),
    skipped: false,
  };
}

/**
 * Remove an image. Deletes the file from disk (best-effort) and the DB
 * row, then renumbers remaining images so order_index + filename slots
 * stay contiguous (001, 002, 003 with no gaps).
 */
function remove(productId, filepath) {
  const db = getDb();
  const dataDir = getDataDir();
  // filepath is relative to <dataDir>/assets/ — prepend that segment.
  const abs = path.join(dataDir, 'assets', filepath);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM product_images WHERE product_id = ? AND filepath = ?').run(productId, filepath);
    // Reindex order_index to keep it contiguous.
    const remaining = db
      .prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY order_index ASC')
      .all(productId);
    const update = db.prepare('UPDATE product_images SET order_index = ? WHERE id = ?');
    remaining.forEach((r, i) => update.run(i, r.id));
  });
  tx();

  // Delete the actual file outside the tx so DB stays the truth-of-record
  // (file deletion is irreversible; we want the row gone first).
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {/* best-effort */}

  // Renumber surviving files to close the gap. If the deleted file was
  // 002, then 003 → 002, 004 → 003, etc.
  renumberFiles(productId);
}

/**
 * Reorder the image list to match `newOrderFilepaths` (a permutation of
 * the current set). Updates order_index then renumbers files so disk
 * matches DB.
 */
function reorder(productId, newOrderFilepaths) {
  const db = getDb();
  const current = listByProduct(productId).map((i) => i.filepath);
  if (newOrderFilepaths.length !== current.length) {
    throw new Error('Reorder must include every image');
  }
  const setA = new Set(current);
  const setB = new Set(newOrderFilepaths);
  if (setA.size !== setB.size || [...setA].some((x) => !setB.has(x))) {
    throw new Error('Reorder must be a permutation of existing images');
  }
  const tx = db.transaction(() => {
    const upd = db.prepare('UPDATE product_images SET order_index = ? WHERE product_id = ? AND filepath = ?');
    newOrderFilepaths.forEach((fp, idx) => upd.run(idx, productId, fp));
  });
  tx();

  // Rewrite on-disk filenames to match the new order.
  renumberFiles(productId);
}

function setMain(productId, filepath) {
  const current = listByProduct(productId).map((i) => i.filepath);
  if (!current.includes(filepath)) throw new Error('Image not on product');
  const next = [filepath, ...current.filter((p) => p !== filepath)];
  reorder(productId, next);
}

function setProcessed(productId, filepath, { isProcessed, processedFilepath, workspaceSettings }) {
  const params = {
    productId,
    filepath,
    isProcessed: isProcessed ? 1 : 0,
    processedFilepath: processedFilepath ?? null,
    workspaceSettings: JSON.stringify(workspaceSettings ?? {}),
  };
  getDb()
    .prepare(
      `UPDATE product_images
       SET is_processed = @isProcessed,
           processed_filepath = @processedFilepath,
           workspace_settings = @workspaceSettings
       WHERE product_id = @productId AND filepath = @filepath`,
    )
    .run(params);
}

function filenameFromRelative(relativePath) {
  return path.basename(relativePath);
}

/**
 * v0.12.0: legacy entry retained for callers that pre-compute the file
 * write themselves (e.g. the boot migration). Inserts a row pointing at
 * an already-written file without touching disk. Skips the renumber
 * sweep because the migration handles ordering in bulk at the end.
 */
function addRow(productId, { filepath, originalFilepath, filename, contentHash, orderIndex }) {
  const existing = getByFilepath(productId, filepath);
  if (existing) return { image: existing, skipped: true };

  const id = crypto.randomUUID();
  const ts = Date.now();
  const order = orderIndex ?? nextOrderIndex(productId);
  getDb()
    .prepare(
      `INSERT INTO product_images
       (id, product_id, filename, filepath, original_filepath, order_index, is_processed, processed_filepath, workspace_settings, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?, ?)`,
    )
    .run(id, productId, filename, filepath, originalFilepath ?? null, order, contentHash ?? null, ts);

  return { image: rowToImage(getDb().prepare('SELECT * FROM product_images WHERE id = ?').get(id)), skipped: false };
}

/**
 * v0.26.14: callers that mutate the on-disk source file in place
 * (flip-source, future in-place crop, etc.) need to bump the row's
 * content_hash so the renderer's `?v=<hash>` cache-bust changes and
 * the browser actually fetches the new pixels. Also returns the
 * refreshed row so the caller doesn't need a separate read.
 */
function setContentHash(productId, filepath, hash) {
  // v0.31.0: the bytes just changed (flip / reframe / in-place edit), so
  // refresh the cached file_size too — otherwise the Library would show a
  // stale size after an edit.
  let size = null;
  try { size = fs.statSync(path.join(getDataDir(), 'assets', filepath)).size; } catch (_) {}
  getDb()
    .prepare(
      `UPDATE product_images
       SET content_hash = ?, file_size = ?
       WHERE product_id = ? AND filepath = ?`,
    )
    .run(hash ?? null, size, productId, filepath);
  return getByFilepath(productId, filepath);
}

/**
 * v0.49.28: update a row's stored filepath. Used by the re-encode flow when
 * the format conversion changes the file extension (e.g. PNG → JPEG); the
 * file on disk gets a new name and the row needs to follow it. Returns the
 * refreshed row.
 */
function setFilepath(productId, oldFilepath, newFilepath) {
  let size = null;
  try { size = fs.statSync(path.join(getDataDir(), 'assets', newFilepath)).size; } catch (_) {}
  getDb()
    .prepare(
      `UPDATE product_images
       SET filepath = ?, file_size = ?
       WHERE product_id = ? AND filepath = ?`,
    )
    .run(newFilepath, size, productId, oldFilepath);
  return getByFilepath(productId, newFilepath);
}

/** v0.31.0: mark a row exempt from the near-duplicate scan (set on
 *  export-derived copies so they're never flagged against their original). */
function setDedupExempt(id, exempt) {
  getDb()
    .prepare('UPDATE product_images SET dedup_exempt = ? WHERE id = ?')
    .run(exempt ? 1 : 0, id);
}

/** v0.28.0: store a row's perceptual hash by id (used by the dedup scan's
 *  lazy backfill — it computes the dHash from the file then caches it). */
function setPerceptualHashById(id, hash) {
  getDb()
    .prepare('UPDATE product_images SET perceptual_hash = ? WHERE id = ?')
    .run(hash ?? null, id);
}

/** v0.28.0: count product_image rows that still reference a given relative
 *  filepath — so the merge knows whether a file is safe to move to
 *  quarantine (only when no OTHER row points at it). */
function countByFilepath(filepath) {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM product_images WHERE filepath = ?')
    .get(filepath);
  return row?.n ?? 0;
}

module.exports = {
  listByProduct,
  addFromSource,
  addFromBytes,
  addRow,
  remove,
  reorder,
  setMain,
  setProcessed,
  setContentHash,
  setFilepath,
  setPerceptualHashById,
  setDedupExempt,
  countByFilepath,
  getByFilepath,
  findByHashForProduct,
  filenameFromRelative,
  renumberFiles,
  dirForProduct,
};
