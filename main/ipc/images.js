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
const { ipcMain, dialog, shell, net, nativeImage } = require('electron');
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
      autoCrop: !!opts.autoCrop,
      trimThreshold: Math.max(1, Math.min(100, Number(opts.trimThreshold) || 12)),
    };
  }

  // Shared in-place writer for reframe/auto-crop. Takes the reframed PNG
  // bytes, re-encodes to the source's own format (so the extension stays
  // truthful), atomically replaces the file, then refreshes content_hash
  // (cache-bust) + perceptual_hash (keeps dedup accurate). Returns the
  // updated image row. Used by both images:reframeImage and the batch
  // auto-crop pass so the disk-write contract can never drift.
  async function writeReframedInPlace(absSrc, outPng, productId, filepath, rowId) {
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
      if (ph && rowId) productImages.setPerceptualHashById(rowId, ph);
    } catch (_) {}
    return updated;
  }

  // Live preview — returns reframed PNG bytes without touching disk.
  expose('images:reframePreview', async (opts = {}) => {
    const { reframeImage } = require('../util/reframe');
    const { absSrc, W, H } = await resolveImageForReframe(opts.productId, opts.filepath);
    const bytes = await reframeImage({ inputImage: absSrc, ...reframeArgs(opts, W, H) });
    return { bytes };
  });

  /* ─── Aspect-ratio crop (v0.49.15) ───
   *
   * A real crop — output dimensions match the cropped region (no resize-
   * back-to-canvas like the legacy `processingPipeline.cropRect` path did).
   * Two destinations:
   *   - 'newImage'  → add as a new product image (non-destructive, default)
   *   - 'overwrite' → write back to the source path (destructive)
   *
   * `rect` is normalized 0..1 against the source image's pixel dimensions
   * — the renderer sends the rect against the canvas / display, the
   * server resolves to actual source pixels here. That way the wire
   * format is resolution-independent and survives a future shift to
   * a different canvas-size convention.
   */
  function resolveCropRect(rect, W, H) {
    if (!rect || typeof rect !== 'object') throw new Error('rect required');
    const fx = Math.max(0, Math.min(1, Number(rect.x)      || 0));
    const fy = Math.max(0, Math.min(1, Number(rect.y)      || 0));
    const fw = Math.max(0, Math.min(1, Number(rect.width)  || 0));
    const fh = Math.max(0, Math.min(1, Number(rect.height) || 0));
    if (fw <= 0 || fh <= 0) throw new Error('rect width/height must be > 0');
    const left   = Math.round(fx * W);
    const top    = Math.round(fy * H);
    // Clamp so left+width never overflows the source dims (sharp throws).
    const width  = Math.max(1, Math.min(W - left, Math.round(fw * W)));
    const height = Math.max(1, Math.min(H - top,  Math.round(fh * H)));
    return { left, top, width, height };
  }

  // v0.49.16: optional straighten — sharp.rotate(angle, {background: white})
  // applied BEFORE the rect is resolved + extracted. Returns the rotated
  // buffer + its new dims so callers can resolve the (normalised) rect
  // against the post-rotation bbox. When angle is 0 returns the source path
  // and (W, H) — no extra sharp pass.
  async function applyStraighten(absSrc, W, H, angleRaw) {
    const angle = Math.max(-45, Math.min(45, Number(angleRaw) || 0));
    if (!angle) return { source: absSrc, W, H };
    const rotated = await sharp(absSrc, { failOn: 'none' })
      .rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png()
      .toBuffer();
    const meta = await sharp(rotated).metadata();
    return { source: rotated, W: meta.width || W, H: meta.height || H };
  }

  expose('images:cropPreview', async (opts = {}) => {
    const { absSrc, W, H } = await resolveImageForReframe(opts.productId, opts.filepath);
    const stt = await applyStraighten(absSrc, W, H, opts.straighten);
    const r = resolveCropRect(opts.rect, stt.W, stt.H);
    const bytes = await sharp(stt.source, { failOn: 'none' })
      .extract(r)
      .png()
      .toBuffer();
    return { bytes };
  });

  expose('images:cropImage', async (opts = {}) => {
    const { row, absSrc, W, H } = await resolveImageForReframe(opts.productId, opts.filepath);
    const { productId, filepath } = opts;
    const dest = opts.destination === 'overwrite' ? 'overwrite' : 'newImage';
    const stt = await applyStraighten(absSrc, W, H, opts.straighten);
    const r = resolveCropRect(opts.rect, stt.W, stt.H);

    // Render once; both destinations consume the same bytes.
    const outPng = await sharp(stt.source, { failOn: 'none' })
      .extract(r)
      .png({ compressionLevel: 9 })
      .toBuffer();

    if (dest === 'overwrite') {
      // Atomic in-place write — same contract as reframe / autoCrop. The
      // source\'s extension is preserved (re-encoded if needed) so a .jpg
      // stays a .jpg instead of bloating to .png on every crop.
      const updated = await writeReframedInPlace(absSrc, outPng, productId, filepath, row.id);
      products.touchUpdated(productId);
      emitCatalogChange('images', 'crop', productId);
      auditImage(productId, 'image:crop', {
        filename: lastSegment(filepath),
        destination: 'overwrite',
        outW: r.width, outH: r.height,
      });
      return { destination: 'overwrite', image: updated, outW: r.width, outH: r.height };
    }

    // newImage: append a cropped copy as a fresh product image. Cap check
    // mirrors the overlay / AI promote paths.
    const imageManager = require('../imageManager');
    const allImgs = productImages.listByProduct(productId);
    if (allImgs.length >= imageManager.MAX_IMAGES_PER_PRODUCT) {
      throw new Error(`Image cap reached (${imageManager.MAX_IMAGES_PER_PRODUCT})`);
    }
    const { image, skipped } = await productImages.addFromBytes(productId, outPng, '.png', {
      originalFilepath: `crop:${lastSegment(filepath)}`,
    });
    if (!skipped) {
      products.touchUpdated(productId);
      emitCatalogChange('images', 'add', productId);
      auditImage(productId, 'image:crop', {
        filename: lastSegment(filepath),
        destination: 'newImage',
        outW: r.width, outH: r.height,
      });
    }
    return { destination: 'newImage', image, skipped: !!skipped, outW: r.width, outH: r.height };
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
    const updated = await writeReframedInPlace(absSrc, outPng, productId, filepath, row.id);

    products.touchUpdated(productId);
    emitCatalogChange('images', 'reframe', productId);
    auditImage(productId, 'image:reframe', {
      filename: lastSegment(filepath),
      scale: reframeArgs(opts, W, H).scale,
      fillMode: opts.fillMode === 'blur' ? 'blur' : 'color',
    });
    return updated;
  });

  // ─── Batch auto-crop (v0.37.0) ───
  // Trim + reframe EVERY image of each selected product in place, so a mixed
  // batch of AI/loose/tight shots ends up with a uniform fill % and margin —
  // the "uniform catalog look" pass. Reuses the reframe engine with
  // autoCrop:true. Synchronous (blocks the caller) like the bulk-overlay run;
  // sharp trim+compose is ~150-300ms/image. Best on solid/white backgrounds —
  // the UI says so. Returns per-run stats; never throws on a single bad image.
  expose('images:autoCropProducts', async (opts = {}) => {
    const { reframeImage } = require('../util/reframe');
    const productIds = Array.isArray(opts.productIds) ? opts.productIds : [];
    // v0.49.8 (mobile-driven): optional per-image filter. When supplied, only
    // images whose `filepath` is in this Set get processed. Backwards-compat:
    // omit it (or pass empty) → existing "every image in the product" behavior.
    // Lets the mobile scope picker say "This image" without spinning up a new IPC.
    const filepathFilter = Array.isArray(opts.filepaths) && opts.filepaths.length
      ? new Set(opts.filepaths)
      : null;
    const args = {
      scale: Math.max(0.3, Math.min(1, Number(opts.scale) || 0.85)),
      fillMode: opts.fillMode === 'blur' ? 'blur' : 'color',
      fillColor: opts.fillColor || '#FFFFFF',
      trimThreshold: Math.max(1, Math.min(100, Number(opts.trimThreshold) || 12)),
    };

    let images = 0;        // images successfully re-cropped
    let productsTouched = 0;
    let failed = 0;        // images that errored
    let missing = 0;       // rows whose file was gone on disk
    const failures = [];   // first few {sku?, filename, error} for the toast

    for (const productId of productIds) {
      try { assertProductInActiveCompany(productId); } catch (_) { continue; }
      const imgs = productImages.listByProduct(productId);
      let any = false;
      for (const img of imgs) {
        // Skip images the caller didn\'t ask for. The filter is per-filepath
        // so it survives a position reorder between scope-pick and run.
        if (filepathFilter && !filepathFilter.has(img.filepath)) continue;
        const absSrc = path.join(getDataDir(), 'assets', img.filepath);
        if (!fs.existsSync(absSrc)) { missing += 1; continue; }
        try {
          const meta = await sharp(absSrc, { failOn: 'none' }).metadata();
          const W = meta.width || 2000;
          const H = meta.height || 2000;
          const outPng = await reframeImage({
            inputImage: absSrc,
            canvasW: W,
            canvasH: H,
            offsetX: 0,
            offsetY: 0,
            autoCrop: true,
            ...args,
          });
          await writeReframedInPlace(absSrc, outPng, productId, img.filepath, img.id);
          images += 1;
          any = true;
        } catch (err) {
          failed += 1;
          if (failures.length < 5) failures.push({ filename: lastSegment(img.filepath), error: err.message });
        }
      }
      if (any) {
        products.touchUpdated(productId);
        emitCatalogChange('images', 'autocrop', productId);
        auditImage(productId, 'image:autocrop', { scale: args.scale, fillMode: args.fillMode });
        productsTouched += 1;
      }
    }

    return { images, products: productsTouched, failed, missing, failures };
  });

  // ─── Auto-enhance (v0.40.0) ───
  function enhanceArgs(opts = {}) {
    return {
      whiteBalance: opts.whiteBalance !== false,
      autoLevels: opts.autoLevels !== false,
      saturation: Math.max(0.1, Math.min(3, Number(opts.saturation) || 1.08)),
      brightness: Math.max(0.1, Math.min(3, Number(opts.brightness) || 1.0)),
    };
  }

  // Live preview — enhanced PNG bytes, no disk write. Same shape as reframePreview.
  expose('images:autoEnhancePreview', async (opts = {}) => {
    const { autoEnhance } = require('../util/autoEnhance');
    const { absSrc } = await resolveImageForReframe(opts.productId, opts.filepath);
    const bytes = await autoEnhance(absSrc, enhanceArgs(opts));
    return { bytes };
  });

  // Batch auto-enhance: white-balance + auto-levels + gentle saturation on each
  // selected product's image(s), written in place. Local sharp pass — the free
  // fix for hand-taken phone shots. scope 'main' (default) does only the main
  // image; 'all' does every image. No per-image undo (overwrites in place).
  expose('images:autoEnhanceProducts', async (opts = {}) => {
    const { autoEnhance } = require('../util/autoEnhance');
    const productIds = Array.isArray(opts.productIds) ? opts.productIds : [];
    const scope = opts.scope === 'all' ? 'all' : 'main';
    // v0.49.13 (mobile-driven): optional per-image filter. When supplied,
    // ONLY those filepaths get enhanced — overrides `scope` because the
    // mobile flow always knows the exact filepaths it wants. Backwards-
    // compatible: omit it and the old `scope: 'main' | 'all'` semantics
    // are unchanged for desktop callers.
    const filepathFilter = Array.isArray(opts.filepaths) && opts.filepaths.length
      ? new Set(opts.filepaths)
      : null;
    const args = enhanceArgs(opts);

    let images = 0;
    let productsTouched = 0;
    let failed = 0;
    let missing = 0;
    const failures = [];

    for (const productId of productIds) {
      try { assertProductInActiveCompany(productId); } catch (_) { continue; }
      const all = productImages.listByProduct(productId);
      // When the per-filepath filter is supplied, use it as the candidate set
      // (ignoring `scope`). Otherwise honour the original scope semantics.
      const imgs = filepathFilter
        ? all.filter(img => filepathFilter.has(img.filepath))
        : (scope === 'all' ? all : all.slice(0, 1));
      let any = false;
      for (const img of imgs) {
        const absSrc = path.join(getDataDir(), 'assets', img.filepath);
        if (!fs.existsSync(absSrc)) { missing += 1; continue; }
        try {
          const outPng = await autoEnhance(absSrc, args);
          await writeReframedInPlace(absSrc, outPng, productId, img.filepath, img.id);
          images += 1;
          any = true;
        } catch (err) {
          failed += 1;
          if (failures.length < 5) failures.push({ filename: lastSegment(img.filepath), error: err.message });
        }
      }
      if (any) {
        products.touchUpdated(productId);
        emitCatalogChange('images', 'enhance', productId);
        auditImage(productId, 'image:autoenhance', { scope, saturation: args.saturation });
        productsTouched += 1;
      }
    }

    return { images, products: productsTouched, failed, missing, failures };
  });

  /* ─── Re-encode + format convert (v0.49.28) ───
   *
   * One sharp pass per image that either changes the format, compresses the
   * existing format, strips metadata, or any combination. Single IPC because
   * the underlying op is the same — sharp.toFormat() with knobs.
   *
   * Args:
   *   productIds: string[]
   *   filepaths?: string[]                  — optional per-image filter
   *   scope: 'main' | 'all'                 — used when filepaths is empty
   *   targetFormat?: 'keep' | 'jpeg' | 'png' | 'webp'
   *   quality?: number                      — 1..100 for JPEG/WebP; ignored for PNG
   *   stripMetadata?: boolean               — default true (drops EXIF, ICC, etc.)
   *
   * Destructive: yes (overwrites the source bytes). When `targetFormat`
   * differs from the source extension, the file is renamed (new extension)
   * and the DB row\'s filepath is updated.
   */
  expose('images:reencodeProducts', async (opts = {}) => {
    const productIds = Array.isArray(opts.productIds) ? opts.productIds : [];
    const scope = opts.scope === 'all' ? 'all' : 'main';
    const filepathFilter = Array.isArray(opts.filepaths) && opts.filepaths.length
      ? new Set(opts.filepaths)
      : null;
    const targetFormat = ['jpeg', 'png', 'webp'].includes(opts.targetFormat)
      ? opts.targetFormat
      : 'keep';
    const quality = Math.max(1, Math.min(100, Math.round(Number(opts.quality) || 85)));
    const stripMetadata = opts.stripMetadata !== false; // default true

    // v0.49.29: pixel resize. Three modes:
    //   'none'     → skip resize entirely
    //   'longEdge' → scale to fit within `longEdge × longEdge` bbox using
    //                fit: 'inside' (preserves aspect, doesn\'t enlarge)
    //   'exact'    → resize to width × height with the chosen fit mode
    // Clamped to a sane upper bound (8000 px) so a stray zero doesn\'t blow
    // up sharp\'s allocator on a 50MP source.
    const resizeMode = ['none', 'longEdge', 'exact'].includes(opts.resize?.mode)
      ? opts.resize.mode
      : 'none';
    const resizeLongEdge = Math.max(16, Math.min(8000, Math.round(Number(opts.resize?.longEdge) || 2000)));
    const resizeWidth    = Math.max(16, Math.min(8000, Math.round(Number(opts.resize?.width)    || 0)));
    const resizeHeight   = Math.max(16, Math.min(8000, Math.round(Number(opts.resize?.height)   || 0)));
    const resizeFit      = ['cover', 'contain', 'fill'].includes(opts.resize?.fit)
      ? opts.resize.fit
      : 'cover';
    // v0.49.34: background colour for `contain` fit. Without this,
    // sharp defaults to `{r:0,g:0,b:0,alpha:0}` (transparent black).
    // On a JPEG (no alpha) that lands as ugly black bars; on a PNG /
    // WebP the bars are transparent which the user reasonably reads
    // as "nothing changed" because most viewers blend transparency
    // onto their own background. White matches catalog convention.
    // Accept `#rrggbb` (8-char `#rrggbbaa` tolerated, alpha ignored).
    const bgHex = String(opts.resize?.background || '#FFFFFF').trim();
    const resizeBackground = (() => {
      const m = /^#?([0-9a-f]{6})/i.exec(bgHex);
      if (!m) return { r: 255, g: 255, b: 255, alpha: 1 };
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, alpha: 1 };
    })();

    // Map sharp\'s "format" name to the file extension we want on disk.
    const extForFormat = { jpeg: '.jpg', png: '.png', webp: '.webp' };

    let images = 0;
    let productsTouched = 0;
    let failed = 0;
    let missing = 0;
    let bytesSavedTotal = 0;
    const failures = [];

    for (const productId of productIds) {
      try { assertProductInActiveCompany(productId); } catch (_) { continue; }
      const all = productImages.listByProduct(productId);
      const imgs = filepathFilter
        ? all.filter(img => filepathFilter.has(img.filepath))
        : (scope === 'all' ? all : all.slice(0, 1));
      let any = false;
      for (const img of imgs) {
        const oldRel = img.filepath;
        const oldAbs = path.join(getDataDir(), 'assets', oldRel);
        if (!fs.existsSync(oldAbs)) { missing += 1; continue; }
        try {
          const oldSize = fs.statSync(oldAbs).size;
          // Decide target format: 'keep' means infer from source extension.
          const oldExt = path.extname(oldAbs).toLowerCase();
          let outFormat = targetFormat;
          if (outFormat === 'keep') {
            if (oldExt === '.jpg' || oldExt === '.jpeg') outFormat = 'jpeg';
            else if (oldExt === '.png') outFormat = 'png';
            else if (oldExt === '.webp') outFormat = 'webp';
            else outFormat = 'jpeg'; // safe default for anything else (heic etc)
          }
          let enc = sharp(oldAbs, { failOn: 'none' });
          // v0.49.34: rotate based on EXIF orientation before resize so
          // the W/H the user asked for matches what they see. Without
          // this, a portrait phone photo with `Orientation:6` gets
          // resized in its un-rotated landscape pixel grid and then
          // appears rotated 90° in viewers — confusing.
          enc = enc.rotate();
          if (!stripMetadata) enc = enc.withMetadata();
          // v0.49.29: resize stage. Runs BEFORE the encoder so the format
          // pass sees the smaller pixel dims (better compression in fewer
          // bytes). Long-edge mode uses fit:\'inside\' with withoutEnlargement
          // so an already-small image isn\'t upscaled — common gotcha that
          // makes thumbnails look blurry.
          if (resizeMode === 'longEdge') {
            enc = enc.resize({
              width: resizeLongEdge,
              height: resizeLongEdge,
              fit: 'inside',
              withoutEnlargement: true,
            });
          } else if (resizeMode === 'exact' && resizeWidth && resizeHeight) {
            // v0.49.34: pass the chosen background for `contain`. Sharp
            // ignores `background` for fit:'cover' and fit:'fill', so
            // passing it unconditionally is fine.
            enc = enc.resize({
              width: resizeWidth,
              height: resizeHeight,
              fit: resizeFit,
              background: resizeBackground,
              withoutEnlargement: false, // exact dims are user intent; allow upscaling
            });
          }
          // v0.49.34: when the output format has no alpha channel (JPEG)
          // and we ran a `contain` fit, the resize leaves transparent
          // pixels in the padding. JPEG can't carry those — flatten
          // against the same background so the bars land on the chosen
          // colour instead of black (sharp's default flatten bg).
          if (outFormat === 'jpeg' && resizeMode === 'exact' && resizeFit === 'contain') {
            enc = enc.flatten({ background: resizeBackground });
          }
          if (outFormat === 'jpeg') enc = enc.jpeg({ quality, mozjpeg: true });
          else if (outFormat === 'png') enc = enc.png({ compressionLevel: 9 });
          else if (outFormat === 'webp') enc = enc.webp({ quality });
          const outBuf = await enc.toBuffer();

          // New filepath: same dir + base, new extension. If format unchanged,
          // newRel === oldRel and we use the existing in-place writer.
          const newExt = extForFormat[outFormat];
          const newRel = oldRel.replace(/\.[^./]+$/, newExt);
          const newAbs = path.join(getDataDir(), 'assets', newRel);

          if (newRel === oldRel) {
            // v0.49.34: write `outBuf` DIRECTLY (atomic tmp+rename) +
            // bump content_hash + perceptual_hash. Previously this
            // routed through `writeReframedInPlace`, which RE-ENCODED
            // the buffer through sharp at a hard-coded quality of 92.
            // For a Compress operation that meant: the user picks
            // JPEG quality 60, sharp produces a quality-60 JPEG into
            // outBuf, writeReframedInPlace re-decodes that buffer and
            // re-encodes it at quality 92 — so the file on disk had
            // the visual quality of 60 (lossy step already happened)
            // at the FILE SIZE of 92 (no compression win). Direct
            // write fixes the size + preserves the user's chosen
            // quality without a second lossy pass.
            const tmpAbs = path.join(path.dirname(oldAbs), `__reencode-${crypto.randomUUID()}${path.extname(oldAbs)}`);
            await fs.promises.writeFile(tmpAbs, outBuf);
            await fs.promises.rename(tmpAbs, oldAbs);
            const newHash = crypto.createHash('sha1').update(outBuf).digest('hex');
            productImages.setContentHash(productId, oldRel, newHash);
            try {
              const { perceptualHash } = require('../util/phash');
              const ph = await perceptualHash(oldAbs);
              if (ph && img.id) productImages.setPerceptualHashById(img.id, ph);
            } catch (_) {}
          } else {
            // Extension change → write to new path, update DB filepath, delete old.
            // tmp+rename so a crash mid-write doesn\'t leave a partial file at the new path.
            const tmpAbs = path.join(path.dirname(newAbs), `__reencode-${crypto.randomUUID()}${newExt}`);
            await fs.promises.writeFile(tmpAbs, outBuf);
            await fs.promises.rename(tmpAbs, newAbs);
            const newHash = crypto.createHash('sha1').update(outBuf).digest('hex');
            productImages.setFilepath(productId, oldRel, newRel);
            productImages.setContentHash(productId, newRel, newHash);
            try {
              const { perceptualHash } = require('../util/phash');
              const ph = await perceptualHash(newAbs);
              if (ph && img.id) productImages.setPerceptualHashById(img.id, ph);
            } catch (_) {}
            // Only delete the old file AFTER the DB row points elsewhere; if
            // the delete fails we just leak the old file (no data loss).
            try { await fs.promises.unlink(oldAbs); } catch (_) {}
          }

          // Track size delta for the toast — gives the user a clear sense of
          // how much compression bought them.
          const newSize = fs.statSync(newAbs).size;
          bytesSavedTotal += Math.max(0, oldSize - newSize);
          images += 1;
          any = true;
        } catch (err) {
          failed += 1;
          if (failures.length < 5) failures.push({ filename: lastSegment(oldRel), error: err.message });
        }
      }
      if (any) {
        products.touchUpdated(productId);
        emitCatalogChange('images', 'reencode', productId);
        auditImage(productId, 'image:reencode', {
          targetFormat, quality, stripMetadata, resizeMode,
          ...(resizeMode === 'longEdge' ? { resizeLongEdge } : null),
          ...(resizeMode === 'exact'    ? { resizeWidth, resizeHeight, resizeFit, bgHex } : null),
        });
        productsTouched += 1;
      }
    }

    return { images, products: productsTouched, failed, missing, failures, bytesSaved: bytesSavedTotal };
  });

  /* ─── v0.49.34: image metadata read ───────────────────────────────
   *
   * Returns the pixel dimensions, on-disk file size, format, channels,
   * etc. for a single product image. Backs the caption row in the
   * Lightbox preview ("2000 × 2000 · 1.4 MB · JPEG · q≈85") so the
   * user can finally see how big an image is without dropping into a
   * Finder Get Info or a CLI `sips`. Cheap — sharp.metadata() reads
   * only the image header, not the full pixel array, so it's safe to
   * call on every slide change.
   *
   * Args: { productId, filepath }
   * Returns: { width, height, format, channels, hasAlpha, density,
   *           fileSize, mtimeMs, contentHash, exists }
   *   - `width` / `height` are pixel dims AFTER EXIF rotation
   *     (`autoOrient: true`) so they match what the user sees in
   *     the lightbox.
   *   - `exists: false` (with other fields null) when the row exists
   *     but the file is missing on disk — surfaces the staleness
   *     instead of throwing.
   */
  expose('images:getMetadata', async ({ productId, filepath } = {}) => {
    if (!productId || !filepath) {
      throw new Error('productId + filepath are required');
    }
    assertProductInActiveCompany(productId);
    const absSrc = path.join(getDataDir(), 'assets', filepath);
    if (!fs.existsSync(absSrc)) {
      return {
        exists: false,
        width: null, height: null, format: null,
        channels: null, hasAlpha: null, density: null,
        fileSize: null, mtimeMs: null, contentHash: null,
      };
    }
    // Stat + sharp().metadata() in parallel — both are I/O bound; the
    // header read is fast (typically <10 ms) but no reason to serialize.
    const [stat, meta] = await Promise.all([
      fs.promises.stat(absSrc),
      sharp(absSrc, { failOn: 'none' })
        .rotate() // honour EXIF orientation so width/height match the rendered pixels
        .metadata(),
    ]);
    // Pull the stored content hash from the existing row; cheaper than
    // re-hashing the file just for the caption. May be null on rows
    // imported before the content_hash column existed; the caller can
    // treat null as "unknown".
    const all = productImages.listByProduct(productId);
    const row = all.find((r) => r.filepath === filepath);
    return {
      exists: true,
      width: meta.width ?? null,
      height: meta.height ?? null,
      format: meta.format ?? null,
      channels: meta.channels ?? null,
      hasAlpha: meta.hasAlpha ?? null,
      density: meta.density ?? null,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash: row?.contentHash ?? null,
    };
  });

  /* ─── v0.49.39: multi-image copy + drag-out ───────────────────────
   *
   * Two complementary channels for getting many images out of the app
   * at once (single-image copy stays on the right-click context menu
   * in main/index.js):
   *
   *   images:copyImagesToFolder — writes N image files into a chosen
   *     folder with clean filenames (SKU-001.ext, SKU-002.ext, …).
   *     If targetFolder is null/missing, pops the OS folder picker.
   *     Works in standalone, server, AND client mode because the
   *     bytes are fetched via the app-image:// protocol (which the
   *     client-mode boot replaces with an HTTPS proxy to the remote
   *     server — same one-code-path trick the existing "Copy Image"
   *     context menu uses).
   *
   *   images:startDragOut — initiates a native multi-file drag from
   *     the renderer. Renderer's onDragStart fires `preventDefault()`
   *     to suppress the browser's default drag and posts to this
   *     channel; main calls `webContents.startDrag({files, icon})`
   *     immediately so the OS picks up the user's still-held mouse
   *     button and starts a native drag. Drag targets (Finder, Mail,
   *     Slack, web inputs) get the files exactly as if the user had
   *     dragged from Finder. ipcMain.on (not handle) because the
   *     reply isn't useful — startDrag is fire-and-forget; the
   *     return value is the drag operation itself, handled by the OS.
   *
   * Client-mode drag-out: deliberately a no-op for v0.49.39. Client
   * Macs have no local asset disk, so we'd need to pre-download the
   * files into a temp dir before calling startDrag — that's a bigger
   * change (progress UX, cleanup, etc.). The renderer hides the drag
   * affordance in client mode so the user sees "Save to folder…"
   * instead. The folder path already works in client mode.
   */

  expose('images:copyImagesToFolder', async ({ productId, filepaths, targetFolder, sku: providedSku } = {}) => {
    if (!productId) throw new Error('productId is required');
    if (!Array.isArray(filepaths) || filepaths.length === 0) {
      throw new Error('filepaths must be a non-empty array');
    }
    assertProductInActiveCompany(productId);

    // Pop folder picker if no target supplied. We use the OS dialog
    // directly (not the existing files.pickFolder IPC) so the title
    // can describe the intent specifically.
    let folder = targetFolder;
    if (!folder) {
      const res = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: filepaths.length === 1 ? 'Save image copy to…' : `Save ${filepaths.length} image copies to…`,
      });
      if (res.canceled || !res.filePaths[0]) {
        return { copied: 0, folder: null, canceled: true, failures: [] };
      }
      folder = res.filePaths[0];
    }

    // Filename pattern: <sku>-NNN.<ext>. Matches the convention the
    // rest of the app uses (asset paths, default export pattern) so
    // copied files slot back into a known workflow without renaming.
    // Renderer passes `sku` directly so this handler doesn't need a DB
    // lookup — that lets the client-mode mirror in main/client/index.js
    // reuse the exact same logic without a local products table.
    let sku = (providedSku || '').toString().trim();
    if (!sku) {
      const product = products.get(productId);
      sku = product?.sku || 'product';
    }
    sku = sku.replace(/[^A-Za-z0-9._-]+/g, '-');

    let copied = 0;
    const failures = [];
    for (let i = 0; i < filepaths.length; i++) {
      const rel = filepaths[i];
      const ext = path.extname(rel) || '.jpg';
      const idx = String(i + 1).padStart(3, '0');
      const baseName = `${sku}-${idx}${ext}`;

      // Collision avoidance: bump to <name> (1).<ext>, (2), … until a
      // free name is found. Cheaper than blowing up the user's existing
      // files in the target folder, even if they re-run the copy.
      let final = path.join(folder, baseName);
      let collisionN = 1;
      while (fs.existsSync(final)) {
        final = path.join(folder, `${sku}-${idx} (${collisionN})${ext}`);
        collisionN += 1;
        if (collisionN > 999) break; // pathological — bail with the last name
      }

      try {
        // One code path for all modes: fetch through the app-image
        // protocol. Standalone/server reads from local disk; client
        // HTTPs to the remote server with the bearer token attached
        // (the protocol handler does both). Net.fetch routes through
        // the registered handler so we don't duplicate auth logic here.
        const url = `app-image://local/${encodeURIComponent(rel)}`;
        const res = await net.fetch(url);
        if (!res.ok) throw new Error(`fetch returned ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.promises.writeFile(final, buf);
        copied += 1;
      } catch (err) {
        failures.push({ filename: path.basename(rel), error: err.message });
      }
    }

    // Reveal in Finder when at least one copied — gives the user a
    // visible confirmation that files landed where they expected and
    // saves the "wait, where did it save?" round-trip. Skipped if
    // everything failed (nothing to show).
    if (copied > 0) {
      try { shell.openPath(folder); } catch (_) { /* non-fatal */ }
    }

    return { copied, folder, canceled: false, failures };
  });

  /* v0.49.40: split the prep + drag into two channels so the same
   * renderer code path works in both standalone/server and client
   * mode. In standalone, prepareDrag resolves filepaths to absolute
   * paths under the assets/ root and returns immediately — no
   * downloads. In client mode (handler in main/client/index.js),
   * prepareDrag fetches each file over HTTPS into a per-drag temp
   * dir and returns its temp paths. Either way the renderer hands
   * the resolved paths to startDragOut, which calls startDrag.
   *
   * Why split: a single-channel "do everything" dragstart handler
   * would have to be async, which races the user's mouse-release on
   * a slow link. Prep returns paths the renderer can hold onto so
   * the dragstart handler's awaited work is BOUNDED — fast on
   * standalone, predictable on client. */
  expose('images:prepareDrag', async ({ productId, filepaths } = {}) => {
    if (!productId) throw new Error('productId is required');
    if (!Array.isArray(filepaths) || filepaths.length === 0) {
      throw new Error('filepaths must be a non-empty array');
    }
    assertProductInActiveCompany(productId);
    // Standalone / server: every filepath is already on local disk
    // under <dataDir>/assets/. Resolve and existence-filter.
    const failed = [];
    const files = [];
    for (const rel of filepaths) {
      const abs = path.join(getDataDir(), 'assets', rel);
      try {
        if (fs.existsSync(abs)) files.push(abs);
        else failed.push({ filepath: rel, error: 'missing on disk' });
      } catch (err) {
        failed.push({ filepath: rel, error: err.message });
      }
    }
    return { tmpDir: null, files, failed };
  });

  // startDrag must be initiated from main (where webContents lives).
  // Use ipcMain.on directly — there's no useful return value and
  // routing through expose() would force a promise envelope for
  // nothing.
  ipcMain.on('images:startDragOut', async (event, args = {}) => {
    const { preparedPaths } = args;
    if (!Array.isArray(preparedPaths) || preparedPaths.length === 0) return;

    // Defensive existence filter — temp paths from client-mode
    // prepareDrag may have been cleaned up if the user prepped a drag
    // and then sat on the pill past the 5 min cleanup timer.
    const livePaths = preparedPaths.filter((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (livePaths.length === 0) return;

    // Build a small drag icon from the first image. macOS shows this
    // as the "ghost" under the cursor during the drag. 64×64 is plenty;
    // any bigger and the drag ghost feels obtrusive.
    let icon;
    try {
      const iconBuf = await sharp(livePaths[0], { failOn: 'none' })
        .rotate()
        .resize(64, 64, { fit: 'inside' })
        .png()
        .toBuffer();
      icon = nativeImage.createFromBuffer(iconBuf);
      if (icon.isEmpty()) icon = nativeImage.createEmpty();
    } catch (_) {
      icon = nativeImage.createEmpty();
    }

    try {
      // startDrag with `files` (plural) — Electron forwards as
      // multi-file drag. `file` (singular) is the legacy single-file
      // form; we always use `files` even for length=1 so the receiver
      // gets the same drop semantics either way.
      event.sender.startDrag({ files: livePaths, icon });
    } catch (err) {
      // Logging only — the drag failed but we can't surface this to
      // the user mid-gesture. They'll just notice nothing was dropped.
      // eslint-disable-next-line no-console
      console.error('[startDragOut] startDrag threw:', err.message);
    }
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
