/**
 * v0.21.0: templates:* IPC handlers (Overlay Studio), extracted
 * from ipc.js.
 *
 * Templates are global (no company scoping); runs are company-
 * scoped so history lists can show "this company recently applied
 * templates X, Y, Z". Phase 1 covers CRUD + a single-image render
 * probe so the bwip-js pipeline is exercised end-to-end before any
 * UI is built. The batch runner ships in Phase 3.
 *
 * The `templates:renderPreview` handler returns `{ bytes: <Buffer> }`,
 * which the server's RPC dispatcher base64-envelopes for the wire;
 * the client unwraps it back to a Buffer before handing to the
 * renderer. Local IPC just passes through unchanged.
 */

const fs = require('node:fs');
const path = require('node:path');

const products = require('../db/products');
const productImages = require('../db/productImages');
const brands = require('../db/brands');
const categories = require('../db/categories');
const companies = require('../db/companies');
const imageTemplates = require('../db/imageTemplates');
const imageTemplateRuns = require('../db/imageTemplateRuns');
const templateRenderer = require('../templateRenderer');
const { getDataDir } = require('../db');

/* ─── v0.49.52: multi-image overlay apply helpers ───────────────────
 * Overlay apply used to hit only the main image. These let a caller
 * target ALL of a product's images (scope: 'all'), and add an in-place
 * 'overwrite' destination that stamps the overlay onto each image file. */

/** Absolute path to an image's base file (processed version wins over raw). */
function imageBaseAbs(image) {
  const rel = (image.isProcessed && image.processedFilepath) ? image.processedFilepath : image.filepath;
  return rel.startsWith('processed/') || rel.startsWith('ai-gallery/') || rel.startsWith('overlays/')
    ? path.join(getDataDir(), rel)
    : path.join(getDataDir(), 'assets', rel);
}

/** The images to apply to. scope 'all' → every image with a file on disk;
 *  otherwise just the main (processed-preferred) image, as before. */
function pickTargetImages(imageList, scope) {
  if (scope === 'all') return imageList.filter((im) => fs.existsSync(imageBaseAbs(im)));
  const main = imageList.find((im) => im.isProcessed && im.processedFilepath) || imageList[0];
  return main ? [main] : [];
}

/** Stamp composed bytes onto an image's RAW file in place (re-encoded to
 *  the source format), atomic-rename, refresh content_hash. Mirrors the
 *  flipSource overwrite pattern. Returns the updated row. */
async function overwriteImageInPlace(productId, image, bytes) {
  const sharp = require('sharp');
  const crypto = require('node:crypto');
  const absSrc = path.join(getDataDir(), 'assets', image.filepath);
  const ext = path.extname(absSrc).toLowerCase();
  const tmpAbs = path.join(path.dirname(absSrc), `__overlay-${crypto.randomUUID()}${ext}`);
  let pipe = sharp(bytes, { failOn: 'none' });
  if (ext === '.png')        pipe = pipe.png({ compressionLevel: 9 });
  else if (ext === '.webp')  pipe = pipe.webp({ quality: 90 });
  else                       pipe = pipe.jpeg({ quality: 92, mozjpeg: true });
  try {
    await pipe.toFile(tmpAbs);
    await fs.promises.rename(tmpAbs, absSrc);
  } catch (err) {
    try { if (fs.existsSync(tmpAbs)) await fs.promises.unlink(tmpAbs); } catch (_) {}
    throw err;
  }
  const buf = await fs.promises.readFile(absSrc);
  const newHash = crypto.createHash('sha1').update(buf).digest('hex');
  return productImages.setContentHash(productId, image.filepath, newHash);
}

/**
 * Apply a template to one product's images and route per destination.
 * Single source of truth for both templates:applyToProduct and the bulk
 * loop. Returns { outputs: [...], skipped?: 'reason' }.
 *
 *   scope: 'main' (default) | 'all'
 *   destination.kind: 'append' | 'appendAsMain' | 'replaceMain'
 *                   | 'overwrite' | 'saveToFolder'
 *
 * promote-to-main only happens when exactly one image is targeted
 * (which image would become "main" is ambiguous for a multi-image run).
 */
async function applyOverlayToProductImages({ template, product, scope, destination }) {
  const imageManager = require('../imageManager');
  const { slugify } = require('../util/slug');
  const imageList = productImages.listByProduct(product.id);
  const targets = pickTargetImages(imageList, scope);
  if (targets.length === 0) return { outputs: [], skipped: 'no images' };

  const ctx = buildTemplateContext(product);
  const outputs = [];
  const promotesToMain = (destination.kind === 'replaceMain' || destination.kind === 'appendAsMain') && targets.length === 1;
  let appendedCount = 0;

  for (const img of targets) {
    const baseAbs = imageBaseAbs(img);
    if (!fs.existsSync(baseAbs)) continue;
    const bytes = await templateRenderer.compose({ inputImage: baseAbs, template, context: ctx });

    if (destination.kind === 'overwrite') {
      const updated = await overwriteImageInPlace(product.id, img, bytes);
      outputs.push({ outputFilepath: img.filepath, image: updated, overwritten: true });
    } else if (destination.kind === 'saveToFolder') {
      const folder = destination.folder;
      await fs.promises.mkdir(folder, { recursive: true });
      const base = `${slugify(product.sku || 'product', 'product')}-${slugify(template.name || 'overlay', 'overlay')}`;
      let name = `${base}.png`;
      let n = 2;
      while (fs.existsSync(path.join(folder, name)) && n < 9999) { name = `${base}-${n}.png`; n += 1; }
      const absOut = path.join(folder, name);
      await fs.promises.writeFile(absOut, bytes);
      outputs.push({ outputFilepath: absOut, savedTo: absOut });
    } else {
      // append / appendAsMain / replaceMain → add an overlaid copy.
      if (imageList.length + appendedCount >= imageManager.MAX_IMAGES_PER_PRODUCT) {
        return { outputs, skipped: 'image cap reached' };
      }
      const { image, skipped } = await productImages.addFromBytes(product.id, bytes, '.png', {
        originalFilepath: `overlay:${template.id}`,
      });
      if (!skipped) appendedCount += 1;
      if (promotesToMain && image) productImages.setMain(product.id, image.filepath);
      outputs.push({ outputFilepath: image.filepath, image, skipped: !!skipped });
    }
  }

  if (destination.kind !== 'saveToFolder' && outputs.length > 0) {
    products.recomputeProcessStatus(product.id);
    products.touchUpdated(product.id);
  }
  return { outputs };
}

function register({ expose, emitCatalogChange }) {
  expose('templates:list',      (opts) => imageTemplates.list(opts ?? {}));
  expose('templates:get',       (id) => imageTemplates.get(id));
  // v0.15.0: template mutations exposed. Templates are global (no
  // company scoping), so any client can author them.
  expose('templates:create',    (input) => imageTemplates.create(input ?? {}));
  expose('templates:update',    ({ id, patch } = {}) => imageTemplates.update(id, patch ?? {}));
  expose('templates:remove',    (id) => imageTemplates.remove(id));
  expose('templates:duplicate', (id) => imageTemplates.duplicate(id));

  /**
   * Smoke-test renderer for Phase 1. Given a template id (or inline
   * template definition) and a product id, picks the product's main
   * processed/raw image, composites the template's elements onto
   * it, and returns the PNG bytes. The caller decides whether to
   * display them in a preview window or write them to disk.
   *
   * Used by the dev probe + Phase 2's live editor preview. Phase
   * 3's batch runner reuses the underlying compose() function, not
   * this IPC handler.
   */
  expose('templates:renderPreview', async ({ templateId, template: inline, productId } = {}) => {
    const template = inline || (templateId ? imageTemplates.get(templateId) : null);
    if (!template) throw new Error('Template not found');
    const product = productId ? products.get(productId) : null;
    if (!product && productId) throw new Error('Product not found');

    // Pick the best base image: processed wins over raw. Falls back
    // to a blank canvas if there's nothing to overlay onto (useful
    // for testing a template against a fresh product).
    let inputImage = null;
    if (product) {
      const images = productImages.listByProduct(product.id);
      const first = images.find((i) => i.isProcessed && i.processedFilepath) || images[0];
      if (first) {
        const rel = (first.isProcessed && first.processedFilepath) ? first.processedFilepath : first.filepath;
        const abs = rel.startsWith('processed/') || rel.startsWith('ai-gallery/') || rel.startsWith('overlays/')
          ? path.join(getDataDir(), rel)
          : path.join(getDataDir(), 'assets', rel);
        if (fs.existsSync(abs)) inputImage = abs;
      }
    }
    if (!inputImage) {
      // Build a transparent canvas at the template's design size so
      // the user still sees their elements rendered for
      // editor/preview work.
      const sharp = require('sharp');
      inputImage = await sharp({
        create: {
          width: template.canvasWidth || 2000,
          height: template.canvasHeight || 2000,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      }).png().toBuffer();
    }

    const ctx = product ? buildTemplateContext(product) : {};
    const bytes = await templateRenderer.compose({ inputImage, template, context: ctx });
    return { bytes };
  });

  /**
   * v0.27.0: eyedropper for the inset margin fill. Resolves a product's
   * main image (same precedence as renderPreview) and returns its
   * estimated background colour as #RRGGBB, so the user can match the
   * margin fill to the image's own background for a seamless seam.
   */
  expose('templates:sampleBgColor', async ({ productId } = {}) => {
    const { sampleBackgroundColor } = require('../util/reframe');
    const product = productId ? products.get(productId) : null;
    if (!product) return '#FFFFFF';
    const images = productImages.listByProduct(product.id);
    const first = images.find((i) => i.isProcessed && i.processedFilepath) || images[0];
    if (!first) return '#FFFFFF';
    const rel = (first.isProcessed && first.processedFilepath) ? first.processedFilepath : first.filepath;
    const abs = rel.startsWith('processed/') || rel.startsWith('ai-gallery/') || rel.startsWith('overlays/')
      ? path.join(getDataDir(), rel)
      : path.join(getDataDir(), 'assets', rel);
    if (!fs.existsSync(abs)) return '#FFFFFF';
    return sampleBackgroundColor(abs);
  });

  expose('templates:listRuns', ({ companyId, limit } = {}) => {
    if (!companyId) return [];
    if (companyId !== companies.getActiveId()) return [];
    return imageTemplateRuns.listRecentByCompany(companyId, limit ?? 20);
  });

  /**
   * v0.26.15: Overlay Studio Phase 3 — apply a template to ONE
   * product and route the rendered PNG per `destination`. This is
   * the foundation for both single-run and bulk modes; the bulk
   * handler below just loops this one and aggregates the results.
   *
   * destination shape (one of):
   *   { kind: 'append' }
   *     Insert the render as a new product image at the end of the
   *     product's image list. Original images untouched. Most
   *     common case — "keep the photo, add a branded packshot".
   *
   *   { kind: 'replaceMain' }
   *     Insert + setMain so the new render takes position 0.
   *     Original main demotes to position 1, NOT deleted. Same
   *     non-destructive model the AI auto-promote uses.
   *
   *   { kind: 'saveToFolder', folder: '/abs/path' }
   *     Write the render to a folder on disk. Product's image
   *     list is untouched. Filename = `<sku>-<templateName>.png`
   *     with `-2`, `-3` collision suffixes.
   *
   * Returns `{ outputFilepath, image?, savedTo? }`:
   *   - `image` is the new product_images row for append/replaceMain
   *   - `savedTo` is the absolute disk path for saveToFolder
   *   - `outputFilepath` is the user-friendly path for the toast
   */
  expose('templates:applyToProduct', async ({ templateId, productId, destination, scope } = {}) => {
    if (!templateId) throw new Error('templateId required');
    if (!productId)  throw new Error('productId required');
    if (!destination || typeof destination !== 'object') throw new Error('destination required');
    if (destination.kind === 'saveToFolder' && !destination.folder?.trim()) {
      throw new Error('saveToFolder requires a folder path');
    }

    const template = imageTemplates.get(templateId);
    if (!template) throw new Error('Template not found');
    const product = products.get(productId);
    if (!product) throw new Error('Product not found');
    if (product.companyId !== companies.getActiveId()) {
      throw new Error('Cross-company apply blocked');
    }

    // v0.49.52: scope 'all' overlays every image; default 'main' keeps
    // the original single-image behaviour. The shared helper routes per
    // destination (append / appendAsMain / overwrite / saveToFolder).
    const { outputs, skipped } = await applyOverlayToProductImages({
      template, product, scope: scope === 'all' ? 'all' : 'main', destination,
    });
    if (skipped && outputs.length === 0) {
      throw new Error(skipped === 'no images' ? 'Product has no images to overlay' : skipped);
    }
    if (destination.kind !== 'saveToFolder' && outputs.length > 0) {
      const promoted = outputs.some((o) => o.image && (destination.kind === 'appendAsMain' || destination.kind === 'replaceMain'));
      emitCatalogChange('images', promoted ? 'setMain' : (destination.kind === 'overwrite' ? 'flip' : 'add'), product.id);
    }
    const first = outputs[0] || {};
    return { ...first, count: outputs.length, outputs };
  });

  /**
   * v0.26.15: bulk apply. Loops applyToProduct per id, collecting
   * per-product outcomes. Each product is independent — one failure
   * doesn't abort the rest. Emits progress events on the broadcast
   * bus so the renderer's overlay can show "Applying N of M…".
   *
   * Records one row in image_template_runs per BATCH (not per
   * product) so the History panel doesn't drown in noise.
   */
  /**
   * v0.49.53: apply a template to arbitrary image FILES on disk — no
   * products involved (e.g. watermarking a folder of personal photos).
   * Composes each input, re-encodes to the source format, writes to an
   * output folder. Local-only: file paths are on this machine's disk, so
   * the renderer gates this to standalone / host mode.
   *
   *   { templateId, inputPaths: [abs file paths], outputFolder }
   * Returns { done, failed, total, outputFolder }.
   */
  expose('templates:applyToExternal', async ({ templateId, inputPaths, outputFolder } = {}) => {
    if (!templateId) throw new Error('templateId required');
    if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('Pick at least one image');
    if (inputPaths.length > 2000) throw new Error('Too many files (max 2000 per batch).');
    if (typeof outputFolder !== 'string' || !outputFolder.trim()) throw new Error('Pick an output folder');

    const template = imageTemplates.get(templateId);
    if (!template) throw new Error('Template not found');

    const events = require('../events');
    const { slugify } = require('../util/slug');
    await fs.promises.mkdir(outputFolder, { recursive: true });

    // External images have no product, so token-based text/barcode
    // elements (SKU, barcode, brand) render empty — a watermark template
    // (logo / static text) is the intended use. Neutral context.
    const ctx = {
      sku: '', name: '', brand: '', brandIcon: null, barcode: '',
      colorFinish: '', category: '', description: '', priceRetail: null, priceWholesale: null,
    };

    const done = [];
    const failed = [];
    const total = inputPaths.length;
    const opId = `overlay-external-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const label = template.name || 'Watermark';
    events.broadcast('progress:event', { id: opId, kind: 'overlay-external', done: 0, total, phase: 'applying', label });
    const tmplSlug = slugify(template.name || 'overlay', 'overlay');

    try {
      for (let i = 0; i < inputPaths.length; i++) {
        const src = inputPaths[i];
        try {
          if (!fs.existsSync(src)) { failed.push({ src, error: 'file not found' }); continue; }
          const bytes = await templateRenderer.compose({ inputImage: src, template, context: ctx });
          // Re-encode to the source format so a JPG photo stays a JPG
          // (PNG output would balloon photo file sizes).
          const sharp = require('sharp');
          let ext = path.extname(src).toLowerCase();
          if (ext === '.heic' || ext === '.heif' || ext === '') ext = '.jpg'; // HEIC out isn't well supported
          let pipe = sharp(bytes, { failOn: 'none' });
          if (ext === '.png')        pipe = pipe.png({ compressionLevel: 9 });
          else if (ext === '.webp')  pipe = pipe.webp({ quality: 90 });
          else                       { ext = ext === '.jpeg' ? '.jpeg' : '.jpg'; pipe = pipe.jpeg({ quality: 92, mozjpeg: true }); }
          const outBytes = await pipe.toBuffer();

          const baseName = slugify(path.basename(src, path.extname(src)) || 'photo', 'photo');
          let name = `${baseName}-${tmplSlug}${ext}`;
          let n = 2;
          while (fs.existsSync(path.join(outputFolder, name)) && n < 9999) { name = `${baseName}-${tmplSlug}-${n}${ext}`; n += 1; }
          const absOut = path.join(outputFolder, name);
          await fs.promises.writeFile(absOut, outBytes);
          done.push({ src, outputFilepath: absOut });
        } catch (err) {
          failed.push({ src, error: err.message });
        }
        events.broadcast('progress:event', {
          id: opId, kind: 'overlay-external', done: i + 1, total, phase: 'applying',
          label: `${label} · ${path.basename(src)}`,
        });
      }
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }

    return { done: done.length, failed, total, outputFolder };
  });

  expose('templates:applyBulk', async ({ templateId, productIds, destination, scope } = {}) => {
    if (!templateId) throw new Error('templateId required');
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new Error('productIds required');
    }
    if (productIds.length > 1000) {
      throw new Error('Too many products (max 1000 per batch). Split your selection.');
    }
    if (!destination?.kind) throw new Error('destination required');
    if (destination.kind === 'saveToFolder' && !destination.folder?.trim()) {
      throw new Error('saveToFolder requires a folder path');
    }
    const companyId = companies.getActiveId();
    return await applyBulkInternal({
      templateId, productIds, destination, companyId, emitCatalogChange, scope,
    });
  });

  /**
   * v0.26.15: bulk-by-filter. Resolves the filter against the
   * active company's products, then funnels into applyBulk. With
   * `dryRun: true` it returns just `{ matchedCount, sampleSkus }`
   * so the confirmation modal can show "this will hit 47 products
   * including BR-001, BR-002, BR-003…" before the user commits.
   */
  expose('templates:applyByFilter', async ({ templateId, filters, destination, dryRun, scope } = {}) => {
    if (!templateId) throw new Error('templateId required');
    const companyId = companies.getActiveId();
    if (!companyId) throw new Error('No active company');

    const all = products.list(companyId, filters ?? {});
    if (dryRun) {
      return {
        matchedCount: all.length,
        sampleSkus: all.slice(0, 5).map((p) => p.sku),
      };
    }
    if (all.length === 0) return { done: [], failed: [], skipped: [], total: 0 };

    // Hand off to applyBulk via the same registered handler — but
    // we're inside that handler's closure already, so just inline
    // a recursive call via the dispatcher is overkill. We'll
    // duplicate the call signature here for clarity.
    const productIds = all.map((p) => p.id);
    if (productIds.length > 1000) {
      throw new Error(`Filter matched ${productIds.length} products — too many for one batch (max 1000). Narrow the filter.`);
    }
    // Re-enter the apply handler — call through the registered map
    // would require passing it; simpler to inline via the direct
    // dispatcher pattern. We just call applyBulk inline:
    // (The handler this file registers above is captured in scope
    // by the IPC layer, not as a local fn; so we duplicate the
    // loop in a helper.)
    return await applyBulkInternal({
      templateId, productIds, destination, companyId,
      emitCatalogChange, scope,
    });
  });
}

/**
 * Same body as the `templates:applyBulk` handler, factored out so
 * `templates:applyByFilter` can reuse it without re-entering the
 * IPC dispatcher (which adds validator overhead and an extra
 * audit-style log on every call).
 *
 * Kept inside this file to share the closure over `imageTemplates`,
 * `products`, `productImages`, `templateRenderer`, `imageTemplateRuns`,
 * `getDataDir`, etc.
 */
async function applyBulkInternal({ templateId, productIds, destination, companyId, emitCatalogChange, scope }) {
  const events = require('../events');

  const done = [];
  const failed = [];
  const skipped = [];
  const total = productIds.length;
  // v0.26.18: use the SHARED progress:event channel (same one
  // auto-match / bulk export / bulk AI use) so the existing global
  // ProgressOverlay surfaces this run automatically. Previously we
  // broadcast on a custom `templates:apply:progress` channel that
  // nothing in the renderer subscribed to — the apply ran silently.
  const opId = `overlay-apply-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const template = imageTemplates.get(templateId); // for the label
  const label = template?.name || 'Overlay';
  events.broadcast('progress:event', {
    id: opId, kind: 'overlay-apply', done: 0, total, phase: 'applying', label,
  });

  try {
    for (let i = 0; i < productIds.length; i++) {
      const pid = productIds[i];
      try {
        const product = products.get(pid);
        if (!product) { skipped.push({ productId: pid, reason: 'not found' }); continue; }
        if (product.companyId !== companyId) { skipped.push({ productId: pid, sku: product.sku, reason: 'cross-company' }); continue; }
        if (!template) throw new Error('Template disappeared mid-batch');

        // v0.49.52: shared per-product apply — honours scope ('all' →
        // every image) + the new 'overwrite' destination.
        const { outputs, skipped: reason } = await applyOverlayToProductImages({
          template, product, scope: scope === 'all' ? 'all' : 'main', destination,
        });
        if (reason && outputs.length === 0) {
          skipped.push({ productId: pid, sku: product.sku, reason });
          continue;
        }
        for (const o of outputs) {
          done.push({ productId: pid, sku: product.sku, outputFilepath: o.outputFilepath });
        }
        if (destination.kind !== 'saveToFolder' && outputs.length > 0) {
          const promoted = (destination.kind === 'replaceMain' || destination.kind === 'appendAsMain') && outputs.some((o) => o.image);
          emitCatalogChange('images', promoted ? 'setMain' : (destination.kind === 'overwrite' ? 'flip' : 'add'), pid);
        }
      } catch (err) {
        failed.push({ productId: pid, error: err.message });
      }
      // Tick progress AFTER each product so the bar matches reality
      // (we've finished i+1 of total). Label shows the just-finished
      // SKU so the overlay reads like "Overlay · TB-R3000-SS".
      const justProcessed = products.get(pid);
      events.broadcast('progress:event', {
        id: opId, kind: 'overlay-apply', done: i + 1, total, phase: 'applying',
        label: justProcessed?.sku ? `${label} · ${justProcessed.sku}` : label,
      });
    }
  } finally {
    events.broadcast('progress:event', { id: opId, complete: true });
  }

  try {
    imageTemplateRuns.record({
      templateId,
      companyId,
      outputRoot: destination.kind === 'saveToFolder' ? destination.folder : null,
      productsCount: total,
      imagesCount: done.length,
      skippedCount: skipped.length + failed.length,
    });
  } catch (_) {/* swallow log errors */}

  return { done, failed, skipped, total };
}

/**
 * Build the template render context from a product. Pulls brand icon
 * relative path (so the renderer's 'brand-icon' source resolves) and
 * the scalar fields users can token-reference in text/barcode content.
 */
function buildTemplateContext(product) {
  const brand = product.brandId ? brands.get(product.brandId) : null;
  const category = product.categoryId ? categories.get(product.categoryId) : null;
  return {
    sku: product.sku,
    name: product.name,
    brand: brand?.name ?? '',
    brandIcon: brand?.icon ?? null,
    barcode: product.barcode,
    colorFinish: product.colorFinish,
    category: category?.name ?? '',
    description: product.description,
    priceRetail: product.priceRetail,
    priceWholesale: product.priceWholesale,
    productImages: productImages.listByProduct(product.id),
    date: new Date(),
  };
}

module.exports = { register };
