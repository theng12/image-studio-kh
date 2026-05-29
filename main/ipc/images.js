/**
 * v0.21.2: images:* + watermarks:* IPC handlers, extracted from
 * ipc.js.
 *
 * Read + reorder + set-main + remove are all exposed (callable
 * by clients). The bytes-based import is too. Path-based imports
 * (importForProduct, autoMatchBySku) stay local-only because they
 * take a path on the caller's disk — see main/client/index.js for
 * the client-mode override that reads bytes locally and forwards.
 *
 * Auto-match emits live progress events through the broadcast bus
 * (v0.17.1) so the renderer's overlay updates as the scan + import
 * progress.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ipcMain } = require('electron');
const sharp = require('sharp');

const products = require('../db/products');
const productImages = require('../db/productImages');
const { getDataDir } = require('../db');
const imageManager = require('../imageManager');
const auditLog = require('../db/auditLog');
const { broadcast } = require('../events');

// v0.22.6: image events go under entity_type='image', entity_id=<productId>
// so a product's History modal naturally interleaves them via the
// auditLog.listForEntity('product', id) query.
function auditImage(productId, action, extra) {
  try {
    auditLog.log({
      entityType: 'image',
      entityId: productId,
      action,
      after: extra ?? null,
    });
  } catch (_) {/* never break the IPC call on a log failure */}
}
function lastSegment(p) { return p ? String(p).split('/').pop() : null; }

function register({ expose, emitCatalogChange, assertProductInActiveCompany, SAFE_WATERMARK_EXTS }) {
  /* ─── Product images ─── */

  expose('images:listByProduct', (productId) => {
    assertProductInActiveCompany(productId);
    return productImages.listByProduct(productId);
  });

  ipcMain.handle('images:importForProduct', async (_e, { productId, sourcePath }) => {
    assertProductInActiveCompany(productId);
    const current = productImages.listByProduct(productId);
    if (current.length >= imageManager.MAX_IMAGES_PER_PRODUCT) {
      throw new Error(`Image cap reached (${imageManager.MAX_IMAGES_PER_PRODUCT})`);
    }
    // v0.12.0: productImages.addFromSource handles the nested-dir
    // layout, next-NNN naming, dedup, and DB insert in one call.
    const { image, skipped } = await productImages.addFromSource(productId, sourcePath, {
      originalFilepath: sourcePath,
    });
    products.recomputeProcessStatus(productId);
    if (!skipped) {
      products.touchUpdated(productId); // v0.22.8: cache-bust the table thumb
      emitCatalogChange('images', 'add', productId);
      auditImage(productId, 'image:add', { filename: lastSegment(image?.filepath) });
    }
    return { images: productImages.listByProduct(productId), added: image, skipped };
  });

  // v0.15.0: exposed. `bytes` arrives as a Buffer in client mode
  // (the RPC dispatcher deserializes the base64 envelope before
  // calling us); as an ArrayBuffer in local mode (structured
  // clone). addFromBytes accepts either.
  expose('images:importFromBytes', async ({ productId, bytes, ext } = {}) => {
    assertProductInActiveCompany(productId);
    const current = productImages.listByProduct(productId);
    if (current.length >= imageManager.MAX_IMAGES_PER_PRODUCT) {
      throw new Error(`Image cap reached (${imageManager.MAX_IMAGES_PER_PRODUCT})`);
    }
    const { image, skipped } = await productImages.addFromBytes(productId, bytes, ext);
    products.recomputeProcessStatus(productId);
    if (!skipped) {
      products.touchUpdated(productId); // v0.22.8: cache-bust the table thumb
      emitCatalogChange('images', 'add', productId);
      auditImage(productId, 'image:add', { filename: lastSegment(image?.filepath), source: 'bytes' });
    }
    return { images: productImages.listByProduct(productId), added: image, skipped };
  });

  // v0.15.0: image reorder / set-main / remove are exposed.
  // These operate on existing DB rows + their on-disk files; no
  // path-on-disk arg crosses the wire, so the RPC envelope
  // handles them cleanly.
  expose('images:setMainImage', ({ productId, filepath } = {}) => {
    assertProductInActiveCompany(productId);
    productImages.setMain(productId, filepath);
    // v0.22.8: bump product.updated_at so the Library list/grid
    // thumbnails get a fresh `?v=updatedAt` cache key. Without this
    // the table thumb keeps showing the OLD main image's pixels even
    // though the file at <sku>-001.jpg now has different bytes.
    products.touchUpdated(productId);
    emitCatalogChange('images', 'setMain', productId);
    auditImage(productId, 'image:set-main', { filename: lastSegment(filepath) });
    return productImages.listByProduct(productId);
  });

  expose('images:reorderImages', ({ productId, newOrder } = {}) => {
    assertProductInActiveCompany(productId);
    productImages.reorder(productId, newOrder);
    products.touchUpdated(productId);
    emitCatalogChange('images', 'reorder', productId);
    auditImage(productId, 'image:reorder', { count: Array.isArray(newOrder) ? newOrder.length : 0 });
    return productImages.listByProduct(productId);
  });

  /**
   * v0.26.14: destructive flip of a product image's source file in
   * place. `axis: 'h'` = mirror left/right (sharp's .flop()); `axis:
   * 'v'` = mirror top/bottom (sharp's .flip()). Same-file rewrite:
   *
   *   1. Read source via sharp.
   *   2. Apply flip + re-encode in the original format. We honour
   *      the existing extension so we don't accidentally re-compress
   *      a PNG as JPEG.
   *   3. Write to a sibling `__flip-<uuid>` tmp file, then rename
   *      over the original. Atomic on the same filesystem so we
   *      never leave a half-written file at the canonical path.
   *   4. Recompute SHA-1, update content_hash in the row, touch
   *      product.updated_at. The renderer's `?v=<hash>` cache-bust
   *      changes so the browser actually fetches the new pixels.
   *   5. Emit catalog:changed + audit-log entry.
   *
   * Why destructive (rather than a workspace setting): the user
   * picked this option explicitly — they want the flip to reflect
   * EVERYWHERE the image is used (Workspace source, exports, all
   * clients, AI prompts), not just in the processing pipeline.
   */
  expose('images:flipSource', async ({ productId, filepath, axis } = {}) => {
    if (!productId || !filepath) throw new Error('productId + filepath required');
    // v0.26.27: added 'both' for the Lightbox preview-then-Apply
    // flow. When the user toggles both Flip H and Flip V before
    // clicking Apply, the renderer sends 'both' so we do one
    // re-encode instead of two sequential ones (less lossy on JPEG
    // and half the disk work). Equivalent to 180° rotation.
    if (axis !== 'h' && axis !== 'v' && axis !== 'both') {
      throw new Error("axis must be 'h', 'v', or 'both'");
    }
    assertProductInActiveCompany(productId);

    const row = productImages.getByFilepath(productId, filepath);
    if (!row) throw new Error('Image not found on product');

    // filepath is relative to `<dataDir>/assets/` — prepend that
    // segment for the actual filesystem path. Same convention every
    // other image module in this file uses.
    const absSrc = path.join(getDataDir(), 'assets', filepath);
    if (!fs.existsSync(absSrc)) throw new Error('Source file missing on disk: ' + filepath);

    const ext = path.extname(absSrc).toLowerCase();
    const tmpAbs = path.join(
      path.dirname(absSrc),
      `__flip-${crypto.randomUUID()}${ext}`,
    );

    let pipeline = sharp(absSrc, { failOn: 'none' });
    // .rotate() with no arg honours EXIF orientation FIRST so the
    // flip operates on what the user actually sees, not the raw
    // sensor orientation. Important for photos straight out of a
    // phone where the EXIF rotation is the only thing making the
    // image look "right".
    pipeline = pipeline.rotate();
    // v0.26.27: 'both' = H + V = 180° rotation. Two .flop()/.flip()
    // calls chained are equivalent but sharp may not collapse them
    // internally; using rotate(180) is one fewer pass through the
    // pixel buffer for the same result.
    if (axis === 'h')      pipeline = pipeline.flop();    // mirror left/right
    else if (axis === 'v') pipeline = pipeline.flip();    // mirror top/bottom
    else                   pipeline = pipeline.rotate(180); // both = 180° rotate

    // Re-encode in the same format so we don't accidentally swap
    // codecs and break consumers that key on extension.
    if (ext === '.png')        pipeline = pipeline.png({ compressionLevel: 9 });
    else if (ext === '.webp')  pipeline = pipeline.webp({ quality: 90 });
    else                       pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });

    try {
      await pipeline.toFile(tmpAbs);
      // Same-filesystem rename → atomic. If this throws, the original
      // file is still intact and the tmp file is the only orphan.
      await fs.promises.rename(tmpAbs, absSrc);
    } catch (err) {
      // Best-effort tmp cleanup if rename failed mid-flow.
      try { if (fs.existsSync(tmpAbs)) await fs.promises.unlink(tmpAbs); } catch (_) {}
      throw err;
    }

    // Recompute hash so the renderer's cache-bust URL changes.
    const buf = await fs.promises.readFile(absSrc);
    const newHash = crypto.createHash('sha1').update(buf).digest('hex');
    const updated = productImages.setContentHash(productId, filepath, newHash);

    products.touchUpdated(productId);
    emitCatalogChange('images', 'flip', productId);
    auditImage(productId, 'image:flip', {
      filename: lastSegment(filepath),
      axis,
      newHash,
    });

    return updated;
  });

  expose('images:removeFromProduct', ({ productId, filepath } = {}) => {
    assertProductInActiveCompany(productId);
    productImages.remove(productId, filepath);
    products.recomputeProcessStatus(productId);
    // v0.22.8: touch updated_at even when recomputeProcessStatus
    // would no-op (e.g. removing the 2nd image from a still-Done
    // product). The renumber-on-disk means main thumb bytes can
    // change; we want the cache-bust signal regardless.
    products.touchUpdated(productId);
    emitCatalogChange('images', 'remove', productId);
    auditImage(productId, 'image:remove', { filename: lastSegment(filepath) });
    return productImages.listByProduct(productId);
  });

  ipcMain.handle('images:autoMatchBySku', async (_e, { companyId, folderPath }) => {
    if (!companyId) throw new Error('companyId is required');
    const companies = require('../db/companies');
    if (companyId !== companies.getActiveId()) {
      throw new Error('Cross-company auto-match blocked');
    }
    if (!folderPath) throw new Error('Folder path is required');

    // v0.17.1: live progress so the user sees something other
    // than a frozen modal while the matcher chews through a folder.
    const opId = `auto-match-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const list = products.list(companyId);
    const skuToProduct = new Map(list.map((p) => [p.sku.toLowerCase(), p]));
    const skuSet = new Set(skuToProduct.keys());

    broadcast('progress:event', {
      id: opId, kind: 'auto-match', done: 0, total: null, phase: 'scanning',
    });

    const allImages = imageManager.scanImagesRecursive(folderPath);
    const { groups, unmatched } = imageManager.groupAndSortMatches(allImages, folderPath, skuSet);

    // Compute total before the work starts so the bar is determinate.
    let total = 0;
    for (const [, candidates] of groups) total += candidates.length;

    const MAX = imageManager.MAX_IMAGES_PER_PRODUCT;
    let productsTouched = 0;
    let imagesImported = 0;
    let imagesSkippedDup = 0;
    let imagesSkippedCap = 0;
    let done = 0;

    try {
      for (const [sku, candidates] of groups) {
        const product = skuToProduct.get(sku);
        if (!product) continue;
        const existing = productImages.listByProduct(product.id).map((i) => i.filepath);
        const remainingCap = MAX - existing.length;
        const capped = candidates.slice(0, Math.max(0, remainingCap));
        imagesSkippedCap += candidates.length - capped.length;
        done += candidates.length - capped.length; // count cap-skips toward done

        let touched = false;
        for (const c of capped) {
          try {
            const { skipped } = await productImages.addFromSource(product.id, c.sourcePath, {
              originalFilepath: c.sourcePath,
            });
            if (skipped) imagesSkippedDup += 1;
            else { imagesImported += 1; touched = true; }
          } catch (_err) {
            imagesSkippedDup += 1;
          }
          done += 1;
          broadcast('progress:event', {
            id: opId, kind: 'auto-match', done, total, phase: 'importing', label: product.sku,
          });
        }
        if (touched) {
          productsTouched += 1;
          products.recomputeProcessStatus(product.id);
        }
      }
    } finally {
      broadcast('progress:event', { id: opId, complete: true });
    }

    // Build two diagnostic lists for the result modal:
    //   - unmatchedSamples: paths of files that didn't match any
    //     SKU, shown relative to the import root so the user can
    //     spot patterns ("ah, everything under /barcodes is
    //     unmatched") at a glance. Alphabetically sorted, cap at
    //     500 (covers typical messy folders while keeping the IPC
    //     payload small).
    //   - productsStillEmpty: SKUs in this company that have zero
    //     images *after* the run.
    const unmatchedRelative = unmatched
      .map((abs) => {
        try {
          const rel = path.relative(folderPath, abs);
          return rel && !rel.startsWith('..') ? rel : abs;
        } catch (_) {
          return abs;
        }
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const UNMATCHED_CAP = 500;
    const unmatchedSamples = unmatchedRelative.slice(0, UNMATCHED_CAP);

    // Tally extensions so the user can see if a single file type
    // is dominating the unmatched bucket (commonly: all barcode
    // .jpgs sitting in a separate folder named for some other key
    // the user uses internally).
    const extCounts = {};
    for (const rel of unmatchedRelative) {
      const ext = (path.extname(rel) || '(no ext)').toLowerCase();
      extCounts[ext] = (extCounts[ext] ?? 0) + 1;
    }
    const refreshedList = products.list(companyId);
    const productsStillEmpty = refreshedList
      .filter((p) => (p.imageCount ?? 0) === 0)
      .map((p) => ({ id: p.id, sku: p.sku, name: p.name }))
      .slice(0, 500);

    return {
      productsTouched,
      imagesImported,
      imagesSkippedDup,
      imagesSkippedCap,
      unmatchedFiles: unmatched.length,
      unmatchedSamples,
      unmatchedSamplesCapped: unmatched.length > unmatchedSamples.length,
      unmatchedExtCounts: extCounts,
      productsStillEmpty,
      productsStillEmptyCapped: refreshedList.filter((p) => (p.imageCount ?? 0) === 0).length > productsStillEmpty.length,
      scannedFiles: allImages.length,
      totalProducts: list.length,
      matchedSkus: groups.size,
      maxImagesPerProduct: MAX,
    };
  });

  /* ─── Near-duplicate detection + merge (v0.28.0) ─── */

  // Scan the active company's (or whole library's) product images for
  // visually near-identical groups. Runs server-side where the image
  // files live; client mode proxies. Emits progress while it backfills
  // perceptual hashes (first scan only — they're cached after).
  expose('images:findDuplicates', async ({ companyId, thresholdPct } = {}) => {
    const imageDedup = require('../imageDedup');
    const opId = `dedup-scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    broadcast('progress:event', { id: opId, kind: 'dedup-scan', done: 0, total: null, phase: 'scanning' });
    try {
      const result = await imageDedup.scanDuplicates({
        companyId: companyId ?? null,
        thresholdPct: Number(thresholdPct) || 95,
        onProgress: ({ done, total }) => {
          broadcast('progress:event', { id: opId, kind: 'dedup-scan', done, total, phase: 'hashing' });
        },
      });
      return result;
    } finally {
      broadcast('progress:event', { id: opId, complete: true });
    }
  });

  // Post-merge bookkeeping shared by the manual + automatic paths:
  // recompute each touched product's process status, write an audit row,
  // and tell every client the catalog moved so they refresh.
  function applyMergeBookkeeping(decisions /*, result */) {
    for (const dec of (decisions || [])) {
      if (dec && dec.productId) {
        try { products.recomputeProcessStatus(dec.productId); } catch (_) {}
        try { products.touchUpdated(dec.productId); } catch (_) {}
        auditImage(dec.productId, 'image:merge-dupes', { removed: (dec.removeIds || []).length });
        emitCatalogChange('images', 'merge', dec.productId);
      }
    }
  }

  // Merge chosen groups. decisions = [{ productId, keepId, removeIds }].
  // Removed images are quarantined (revertable), not destroyed.
  expose('images:mergeDuplicates', ({ decisions, thresholdPct, mode, companyId } = {}) => {
    const imageDedup = require('../imageDedup');
    const result = imageDedup.mergeGroups({
      decisions: Array.isArray(decisions) ? decisions : [],
      thresholdPct: Number(thresholdPct) || 95,
      mode: mode === 'auto' ? 'auto' : 'review',
      companyId: companyId ?? null,
    });
    applyMergeBookkeeping(decisions, result);
    return result;
  });

  // v0.28.1: automatic mode — scan AND merge every group in one shot, no
  // review screen, using the keep-rule's suggested survivor. Emits progress
  // so it runs off the global progress UI; the renderer fires it and the
  // user keeps working. Still quarantine-backed + logged → fully revertable.
  expose('images:autoMergeDuplicates', async ({ companyId, thresholdPct } = {}) => {
    const imageDedup = require('../imageDedup');
    const pct = Number(thresholdPct) || 95;
    const opId = `dedup-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    broadcast('progress:event', { id: opId, kind: 'dedup-auto', done: 0, total: null, phase: 'scanning' });
    try {
      const { groups } = await imageDedup.scanDuplicates({
        companyId: companyId ?? null,
        thresholdPct: pct,
        onProgress: ({ done, total }) => {
          broadcast('progress:event', { id: opId, kind: 'dedup-auto', done, total, phase: 'hashing' });
        },
      });
      if (groups.length === 0) {
        return { opId: null, merged: 0, removed: 0, groups: 0, groupsFound: 0 };
      }
      broadcast('progress:event', { id: opId, kind: 'dedup-auto', done: 0, total: groups.length, phase: 'merging' });
      const decisions = groups.map((g) => ({
        productId: g.productId,
        keepId: g.keepId,
        removeIds: g.images.filter((im) => im.id !== g.keepId).map((im) => im.id),
      }));
      const result = imageDedup.mergeGroups({ decisions, thresholdPct: pct, mode: 'auto', companyId: companyId ?? null });
      applyMergeBookkeeping(decisions, result);
      return { ...result, groupsFound: groups.length };
    } finally {
      broadcast('progress:event', { id: opId, complete: true });
    }
  });

  expose('images:listMergeOps', ({ companyId, limit } = {}) => {
    const imageDedup = require('../imageDedup');
    return imageDedup.listMergeOps({ companyId: companyId ?? null, limit: Number(limit) || 20 });
  });

  expose('images:revertMerge', ({ opId } = {}) => {
    const imageDedup = require('../imageDedup');
    if (!opId) throw new Error('opId is required');
    const result = imageDedup.revertMergeOp(opId);
    for (const pid of (result.productIds || [])) {
      try { products.recomputeProcessStatus(pid); } catch (_) {}
      try { products.touchUpdated(pid); } catch (_) {}
      emitCatalogChange('images', 'mergeRevert', pid);
    }
    return result;
  });

  expose('images:purgeMerge', ({ opId } = {}) => {
    const imageDedup = require('../imageDedup');
    if (!opId) throw new Error('opId is required');
    return imageDedup.purgeMergeOp(opId);
  });

  // How much disk the quarantined (still-undoable) merges are holding.
  expose('images:quarantineInfo', () => {
    const imageDedup = require('../imageDedup');
    return imageDedup.quarantineInfo();
  });

  // Permanently purge every still-revertable merge (frees all quarantine
  // disk; those merges can no longer be undone afterwards).
  expose('images:purgeAllMerges', () => {
    const imageDedup = require('../imageDedup');
    return imageDedup.purgeAll();
  });

  /* ─── Per-image reframe (v0.29.0) ─── */

  // Resolve a product image's absolute asset path + its pixel dimensions.
  async function resolveImageForReframe(productId, filepath) {
    if (!productId || !filepath) throw new Error('productId + filepath required');
    assertProductInActiveCompany(productId);
    const row = productImages.getByFilepath(productId, filepath);
    if (!row) throw new Error('Image not found on product');
    const absSrc = path.join(getDataDir(), 'assets', filepath);
    if (!fs.existsSync(absSrc)) throw new Error('Source file missing on disk: ' + filepath);
    const meta = await sharp(absSrc, { failOn: 'none' }).metadata();
    return { row, absSrc, W: meta.width || 2000, H: meta.height || 2000 };
  }

  function reframeArgs(opts, W, H) {
    return {
      canvasW: W,
      canvasH: H,
      scale: Math.max(0.3, Math.min(1, Number(opts.scale) || 0.85)),
      offsetX: Number(opts.offsetX) || 0,
      offsetY: Number(opts.offsetY) || 0,
      fillMode: opts.fillMode === 'blur' ? 'blur' : 'color',
      fillColor: opts.fillColor || '#FFFFFF',
    };
  }

  // Live preview — returns reframed PNG bytes without touching disk.
  expose('images:reframePreview', async (opts = {}) => {
    const { reframeImage } = require('../util/reframe');
    const { absSrc, W, H } = await resolveImageForReframe(opts.productId, opts.filepath);
    const bytes = await reframeImage({ inputImage: absSrc, ...reframeArgs(opts, W, H) });
    return { bytes };
  });

  // Sample the image's own background colour for the eyedropper.
  expose('images:sampleImageBgColor', async ({ productId, filepath } = {}) => {
    const { sampleBackgroundColor } = require('../util/reframe');
    try {
      const { absSrc } = await resolveImageForReframe(productId, filepath);
      return sampleBackgroundColor(absSrc);
    } catch (_) { return '#FFFFFF'; }
  });

  // Commit the reframe in place (same pattern as flipSource): write to a
  // tmp file, atomic-rename over the original, bump content_hash so the
  // cache-bust URL changes, and refresh the perceptual hash so dedup stays
  // accurate. Output keeps the source's pixel dimensions + format.
  expose('images:reframeImage', async (opts = {}) => {
    const { reframeImage } = require('../util/reframe');
    const { row, absSrc, W, H } = await resolveImageForReframe(opts.productId, opts.filepath);
    const { productId, filepath } = opts;

    const outPng = await reframeImage({ inputImage: absSrc, ...reframeArgs(opts, W, H) });

    // Re-encode to the source's format so the extension stays truthful.
    const ext = path.extname(absSrc).toLowerCase();
    let enc = sharp(outPng, { failOn: 'none' });
    if (ext === '.png')       enc = enc.png({ compressionLevel: 9 });
    else if (ext === '.webp') enc = enc.webp({ quality: 92 });
    else                      enc = enc.jpeg({ quality: 92, mozjpeg: true });
    const finalBuf = await enc.toBuffer();

    const tmpAbs = path.join(path.dirname(absSrc), `__reframe-${crypto.randomUUID()}${ext}`);
    try {
      await fs.promises.writeFile(tmpAbs, finalBuf);
      await fs.promises.rename(tmpAbs, absSrc);
    } catch (err) {
      try { if (fs.existsSync(tmpAbs)) await fs.promises.unlink(tmpAbs); } catch (_) {}
      throw err;
    }

    const newHash = crypto.createHash('sha1').update(finalBuf).digest('hex');
    const updated = productImages.setContentHash(productId, filepath, newHash);
    try {
      const { perceptualHash } = require('../util/phash');
      const ph = await perceptualHash(absSrc);
      if (ph) productImages.setPerceptualHashById(row.id, ph);
    } catch (_) {}

    products.touchUpdated(productId);
    emitCatalogChange('images', 'reframe', productId);
    auditImage(productId, 'image:reframe', {
      filename: lastSegment(filepath),
      scale: reframeArgs(opts, W, H).scale,
      fillMode: opts.fillMode === 'blur' ? 'blur' : 'color',
    });
    return updated;
  });

  /* ─── Watermarks ─── */

  ipcMain.handle('watermarks:upload', async (_e, { sourcePath }) => {
    if (!sourcePath) throw new Error('Source path required');
    const slug = path.basename(sourcePath, path.extname(sourcePath));
    const { relativePath } = await imageManager.importAsset('watermarks', sourcePath, slug);
    return { relativePath };
  });

  // v0.15.0: clients can upload watermarks from a clipboard paste
  // or drag-drop without the file living on the server's disk first.
  expose('watermarks:uploadFromBytes', async ({ bytes, ext, name } = {}) => {
    const os = require('node:os');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iskh-wm-'));
    // Allow-list the extension. The old regex
    // (`replace(/^([^.])/, '.$1')`) only normalised a missing
    // leading dot — it didn't reject path traversal like `../foo`
    // or arbitrary other extensions.
    let safeExt = (ext || '.png').toLowerCase();
    if (!safeExt.startsWith('.')) safeExt = '.' + safeExt;
    if (!SAFE_WATERMARK_EXTS.has(safeExt)) safeExt = '.png';
    const tmpPath = path.join(tmpDir, `watermark${safeExt}`);
    await fs.promises.writeFile(tmpPath, Buffer.from(bytes));
    try {
      const slug = (name || 'watermark').replace(/\.[^.]+$/, '');
      const { relativePath } = await imageManager.importAsset('watermarks', tmpPath, slug);
      return { relativePath };
    } finally {
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

module.exports = { register };
