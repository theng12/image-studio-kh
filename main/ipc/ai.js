/**
 * v0.21.2: ai:* IPC handlers, extracted from ipc.js.
 *
 * The biggest domain by line count — covers the entire AI Studio
 * surface: model catalog + cost estimates, prompt templates CRUD,
 * task queue lifecycle (create / repair / cancel / remove / fresh),
 * gallery (list / bulk-list / favorite / remove / promote-to-product),
 * bulk source upload (path-based local + bytes-based for clients),
 * provider key tests + credits, and the v0.16.1 bytes-back-to-client
 * gallery export.
 *
 * Provider tests + credits stay local-only — they read API keys
 * from the per-Mac config, which means client mode never proxies
 * them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');

const config = require('../config');
const companies = require('../db/companies');
const products = require('../db/products');
const productImages = require('../db/productImages');
const aiTasks = require('../db/aiTasks');
const aiPrompts = require('../db/aiPrompts');
const aiGallery = require('../db/aiGallery');
const aiModels = require('../ai/models');
const aiCosts = require('../ai/costs');
const aiKie = require('../ai/providers/kie');
const aiFal = require('../ai/providers/fal');
const queueRunner = require('../ai/queueRunner');
const imageManager = require('../imageManager');
const { getDataDir } = require('../db');

function register({ expose, emitCatalogChange, assertEntityInActiveCompany, assertProductInActiveCompany }) {
  // v0.14.4: AI read channels portable to clients. Mutations +
  // queueing stay local until v0.15.0.
  expose('ai:listModels', () => aiModels.MODELS);
  expose('ai:estimateCost', ({ model, count } = {}) => aiCosts.estimateForModel(model, count));

  expose('ai:listPrompts', (companyId) => {
    if (companyId && companyId !== companies.getActiveId()) return [];
    return aiPrompts.list(companyId);
  });
  // v0.15.0: AI prompt CRUD exposed.
  expose('ai:createPrompt', (input) => {
    if (input?.companyId && input.companyId !== companies.getActiveId()) {
      throw new Error('Cross-company create blocked');
    }
    return aiPrompts.create(input);
  });
  expose('ai:updatePrompt', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(aiPrompts.get(id), 'Template');
    return aiPrompts.update(id, patch);
  });
  expose('ai:removePrompt', (id) => {
    assertEntityInActiveCompany(aiPrompts.get(id), 'Template');
    return aiPrompts.remove(id);
  });

  expose('ai:listTasks', ({ companyId, limit, statuses } = {}) => {
    if (companyId && companyId !== companies.getActiveId()) return [];
    return aiTasks.listByCompany(companyId, { limit, statuses });
  });
  // v0.15.0: AI task mutations exposed. The queue runner only
  // runs on the server; clients enqueue a task and the server
  // runs it. The task's `sourceImagePath` is a relative path
  // under `<dataDir>` — already shared via `app-image://` — so
  // the server can resolve it without the client needing to send
  // bytes.
  expose('ai:queueTask', (input) => {
    if (!input?.companyId) throw new Error('companyId required');
    if (input.companyId !== companies.getActiveId()) {
      throw new Error('Cross-company queue blocked');
    }
    if (input.productId) {
      // Ensure the product the renderer is attaching to actually
      // belongs to the same company. Stops a stale renderer
      // state from cross-attaching an AI task + downloaded
      // outputs to another company's product.
      assertProductInActiveCompany(input.productId);
    }
    const created = aiTasks.create({
      companyId: input.companyId,
      productId: input.productId ?? null,
      sourceImagePath: input.sourceImagePath ?? null,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      options: input.options ?? {},
      status: 'queued',
      costEstimate: aiCosts.estimateForModel(input.model, input.options?.nVariants ?? input.options?.numImages ?? 1),
    });
    if (input.promptTemplateId) {
      try { aiPrompts.bumpUseCount(input.promptTemplateId); } catch (_) {}
    }
    queueRunner.nudge();
    return created;
  });
  expose('ai:repairTask', (id) => {
    assertEntityInActiveCompany(aiTasks.get(id), 'Task');
    return queueRunner.repair(id);
  });
  expose('ai:queueFreshTask', (id) => {
    assertEntityInActiveCompany(aiTasks.get(id), 'Task');
    return queueRunner.queueFresh(id);
  });
  expose('ai:cancelTask', (id) => {
    assertEntityInActiveCompany(aiTasks.get(id), 'Task');
    return queueRunner.cancel(id);
  });
  expose('ai:removeTask', (id) => {
    assertEntityInActiveCompany(aiTasks.get(id), 'Task');
    return aiTasks.remove(id);
  });

  expose('ai:listGallery', (productId) => {
    assertProductInActiveCompany(productId);
    return aiGallery.listByProduct(productId);
  });
  /**
   * v0.11.0: bulk gallery listing. Returns every gallery row in
   * the active company that's NOT attached to a product
   * (product_id IS NULL). Used by AI Studio's Bulk tab.
   */
  expose('ai:listBulkGallery', ({ limit, offset } = {}) => {
    const companyId = companies.getActiveId();
    if (!companyId) return { rows: [], total: 0 };
    return {
      rows: aiGallery.listBulkByCompany(companyId, { limit, offset }),
      total: aiGallery.countBulkByCompany(companyId),
    };
  });
  expose('ai:favoriteGallery', ({ id, isFavorite } = {}) => {
    const entry = aiGallery.get(id);
    if (!entry) throw new Error('Gallery entry not found');
    // Bulk entries have no productId — use the row's company_id to gate.
    if (entry.productId) assertProductInActiveCompany(entry.productId);
    else if (entry.companyId !== companies.getActiveId()) throw new Error('Cross-company access denied');
    return aiGallery.setFavorite(id, isFavorite);
  });
  expose('ai:removeGallery', (id) => {
    const entry = aiGallery.get(id);
    if (!entry) throw new Error('Gallery entry not found');
    if (entry.productId) assertProductInActiveCompany(entry.productId);
    else if (entry.companyId !== companies.getActiveId()) throw new Error('Cross-company access denied');
    // Also unlink the file on disk (best-effort) so deleted bulk
    // results don't pile up untouched in ai-gallery/_bulk/.
    try {
      const abs = path.join(getDataDir(), entry.filepath);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (_) { /* swallow — DB row removal is the source of truth */ }
    return aiGallery.remove(id);
  });

  /**
   * Promote a gallery entry's image into a product's image list.
   *
   * Per-product flow (existing): galleryId points at an entry
   * whose product_id is already set; we just import its bytes
   * into that product and mark the entry promoted.
   *
   * Bulk flow (v0.11.0): galleryId points at an entry with
   * product_id = NULL; the caller supplies `targetProductId`
   * (existing product the user picked) or `newProduct` (a minimal
   * product payload to create on the fly). The gallery row then
   * gets attached to the chosen product.
   */
  expose('ai:promoteGalleryToProduct', async ({ galleryId, targetProductId, newProduct, asMain } = {}) => {
    const entry = aiGallery.get(galleryId);
    if (!entry) throw new Error('Gallery entry not found');

    // Resolve the destination product id.
    let productId = entry.productId ?? targetProductId ?? null;
    if (!productId && newProduct) {
      // Create on-the-fly. SKU is required; everything else
      // optional.
      if (!newProduct.sku?.trim()) throw new Error('SKU is required to create a product');
      const companyId = companies.getActiveId();
      if (!companyId) throw new Error('No active company');
      const created = products.create({
        companyId,
        sku: newProduct.sku.trim(),
        name: newProduct.name?.trim() || null,
        brandId: newProduct.brandId || null,
        categoryId: newProduct.categoryId || null,
        status: 'active',
      });
      productId = created.id;
    }
    if (!productId) throw new Error('No target product specified');

    assertProductInActiveCompany(productId);
    const product = products.get(productId);
    if (!product) throw new Error('Product not found');

    const absPath = path.join(getDataDir(), entry.filepath);
    const existingImages = productImages.listByProduct(productId);
    if (existingImages.length >= imageManager.MAX_IMAGES_PER_PRODUCT) {
      throw new Error(`Image cap reached (${imageManager.MAX_IMAGES_PER_PRODUCT})`);
    }
    // v0.12.0: addFromSource places the file under the nested
    // layout and inserts the row in one step. Picks the next
    // NNN slot automatically.
    const { image: addedImage } = await productImages.addFromSource(productId, absPath, {
      originalFilepath: absPath,
    });
    const relativePath = addedImage?.filepath;
    // v0.11.1 + v0.12.0: optional "promote as main" — after the
    // add, setMain reorders to position 0 AND renumbers files on
    // disk so the new image becomes `001.<ext>`.
    if (asMain && relativePath) {
      // v0.12.4: surface setMain errors instead of swallowing.
      // If the import succeeded but the reorder failed, the user
      // should know — they clicked "Set as main", not "Promote
      // and try to set as main." Crash-recovery on next boot
      // will reconcile any tmp files left over.
      try {
        productImages.setMain(productId, relativePath);
      } catch (err) {
        process.stderr.write(`[ai:promote asMain] setMain failed for ${relativePath}: ${err.message}\n`);
        throw new Error(`Image was added, but setting it as main failed: ${err.message}`);
      }
    }
    // Link the gallery row to the product if it wasn't already.
    if (!entry.productId) aiGallery.attachToProduct(galleryId, productId);
    else aiGallery.markPromoted(galleryId);
    products.recomputeProcessStatus(productId);
    // v0.26.21: bump product.updated_at so the Library grid + table
    // thumbnails get a fresh `?v=updatedAt` cache key and the new
    // main image actually shows. Without this, the grid kept the
    // browser-cached pixels from the old main image — the only
    // workaround was to promote a different image then re-promote
    // this one to force a second updated_at bump. Same fix pattern
    // as v0.22.8's images:setMainImage IPC, which had the same bug.
    products.touchUpdated(productId);
    emitCatalogChange('images', 'promote', productId);
    emitCatalogChange('aiGallery', 'promote', galleryId, { productId });
    return { product: products.get(productId), images: productImages.listByProduct(productId) };
  });

  /**
   * v0.22.0: bulk-run AI Studio against a list of EXISTING
   * products, using each product's main (position-0) image as the
   * source. Optional auto-promote: when `autoPromoteAsMain: true`,
   * the queue runner will promote the first successful variant
   * back into the product as the new main image.
   *
   * Per-product flow:
   *   1. Look up the product + its image list.
   *   2. Skip if no images (recorded in `skipped` for the result modal).
   *   3. Create an aiTasks row with productId attached + source =
   *      main image's relative path. The runner already knows how
   *      to read from `<dataDir>/assets/<filepath>`.
   *   4. Pass the auto-promote flag through the task's options so
   *      the runner can act on it when the download completes.
   *
   * Returns `{ queued, tasks, skipped }` so the renderer can show
   * "Queued 47 of 50 — 3 had no main image".
   */
  expose('ai:queueBulkForProducts', (input = {}) => {
    const companyId = companies.getActiveId();
    if (!companyId) throw new Error('No active company');
    if (input.companyId && input.companyId !== companyId) {
      throw new Error('Cross-company queue blocked');
    }
    if (!Array.isArray(input.productIds) || input.productIds.length === 0) {
      throw new Error('No products selected');
    }
    if (!input.provider || !input.model) throw new Error('provider and model required');
    if (!input.prompt?.trim()) throw new Error('prompt required');

    const baseOptions = input.options ?? {};
    const taskOptions = {
      ...baseOptions,
      // The runner reads this flag on the first variant of each
      // completed task and promotes it back to the product as main.
      autoPromoteAsMain: !!input.autoPromoteAsMain,
    };

    const queued = [];
    const skipped = [];

    // v0.26.26: live progress on the queueing loop. With 100+ products
    // even pure DB inserts add up to ~1–3s, and per-product image
    // resolution does an `imageManager.MAX_IMAGES_PER_PRODUCT` index
    // lookup for each. Without this the user gets a frozen modal
    // until the IPC returns. Same `progress:event` channel auto-match
    // / bulk export / Overlay apply use, so the existing global
    // ProgressOverlay surfaces it automatically.
    const events = require('../events');
    const opId = `ai-queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const total = input.productIds.length;
    events.broadcast('progress:event', {
      id: opId, kind: 'bulk-queue', done: 0, total, phase: 'queueing',
    });

    try {
      let done = 0;
      for (const productId of input.productIds) {
        try {
          const product = products.get(productId);
          if (!product) {
            skipped.push({ productId, error: 'Product not found' });
            continue;
          }
          if (product.companyId !== companyId) {
            skipped.push({ productId, sku: product.sku, error: 'Cross-company' });
            continue;
          }
          const images = productImages.listByProduct(productId);
          const main = images[0];
          if (!main || !main.filepath) {
            skipped.push({ productId, sku: product.sku, error: 'No main image' });
            continue;
          }
          const created = aiTasks.create({
            companyId,
            productId,
            sourceImagePath: main.filepath,
            provider: input.provider,
            model: input.model,
            prompt: input.prompt,
            options: taskOptions,
            status: 'queued',
            costEstimate: aiCosts.estimateForModel(
              input.model,
              taskOptions?.nVariants ?? taskOptions?.numImages ?? 1,
            ),
          });
          queued.push(created);
        } catch (err) {
          skipped.push({ productId, error: err.message });
        }
        done += 1;
        // Tick AFTER each product so the bar always reflects the
        // count actually persisted. Label shows the SKU we just
        // touched so the overlay reads like "Queueing AI batch · TB-R3000-SS".
        const lastProduct = products.get(productId);
        events.broadcast('progress:event', {
          id: opId, kind: 'bulk-queue', done, total, phase: 'queueing',
          label: lastProduct?.sku || undefined,
        });
      }
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }

    if (input.promptTemplateId) {
      try { aiPrompts.bumpUseCount(input.promptTemplateId); } catch (_) {}
    }
    if (queued.length > 0) queueRunner.nudge();
    return { queued: queued.length, tasks: queued, skipped };
  });

  /**
   * v0.11.0: Queue a batch of source images as AI tasks without
   * any product association. Each source is content-addressed-
   * imported into `<dataDir>/assets/ai-source/` first so the
   * runner has a stable path, then a queued task is created per
   * source. Returns the count actually queued (skips files that
   * failed to import).
   */
  ipcMain.handle('ai:queueBulkBatch', async (_e, input) => {
    const companyId = companies.getActiveId();
    if (!companyId) throw new Error('No active company');
    if (input.companyId && input.companyId !== companyId) throw new Error('Cross-company queue blocked');
    if (!Array.isArray(input.sourcePaths) || input.sourcePaths.length === 0) {
      throw new Error('No source images supplied');
    }
    if (!input.provider || !input.model) throw new Error('provider and model required');
    if (!input.prompt?.trim()) throw new Error('prompt required');

    const queued = [];
    const skipped = [];
    // v0.26.26: live progress on the bulk-from-folder queue. Each
    // iteration does an `importAsset` (file copy + hashing) so the
    // wall-clock cost scales with file size — 50 large images can
    // easily take 10s+. Client-mode already broadcasts progress from
    // its local bridge; this path is what the standalone-mode Mac
    // hits when the user queues a folder. Same channel either way.
    const events = require('../events');
    const opId = `ai-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const total = input.sourcePaths.length;
    events.broadcast('progress:event', {
      id: opId, kind: 'bulk-queue', done: 0, total, phase: 'importing',
    });
    try {
      let done = 0;
      for (const sourcePath of input.sourcePaths) {
        try {
          const slug = path.basename(sourcePath, path.extname(sourcePath)) || 'source';
          const { relativePath } = await imageManager.importAsset('ai-source', sourcePath, slug);
          const created = aiTasks.create({
            companyId,
            productId: null,
            sourceImagePath: relativePath,
            provider: input.provider,
            model: input.model,
            prompt: input.prompt,
            options: input.options ?? {},
            status: 'queued',
            costEstimate: aiCosts.estimateForModel(
              input.model,
              input.options?.nVariants ?? input.options?.numImages ?? 1,
            ),
          });
          queued.push(created);
        } catch (err) {
          skipped.push({ sourcePath, error: err.message });
        }
        done += 1;
        events.broadcast('progress:event', {
          id: opId, kind: 'bulk-queue', done, total, phase: 'importing',
          label: path.basename(sourcePath),
        });
      }
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }
    if (input.promptTemplateId) {
      try { aiPrompts.bumpUseCount(input.promptTemplateId); } catch (_) {}
    }
    if (queued.length > 0) queueRunner.nudge();
    return { queued: queued.length, tasks: queued, skipped };
  });

  /**
   * v0.16.1: bytes-based bulk-queue for client mode. The client
   * reads each source file locally, sends a list of `{ bytes, ext,
   * name }` to this handler; we write each to a temp file then
   * run the normal `importAsset('ai-source', ...)` pipeline (dedup
   * by hash, etc.). Same return shape as `ai:queueBulkBatch`.
   */
  expose('ai:queueBulkBatchFromBytes', async (input = {}) => {
    const companyId = companies.getActiveId();
    if (!companyId) throw new Error('No active company');
    if (input.companyId && input.companyId !== companyId) throw new Error('Cross-company queue blocked');
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new Error('No source images supplied');
    }
    if (!input.provider || !input.model) throw new Error('provider and model required');
    if (!input.prompt?.trim()) throw new Error('prompt required');

    const os = require('node:os');
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iskh-bulk-'));
    const queued = [];
    const skipped = [];
    try {
      for (const src of input.sources) {
        const name = src?.name || 'source';
        try {
          if (!src?.bytes) throw new Error('Missing bytes');
          let ext = (src.ext || '.jpg').toLowerCase();
          if (!ext.startsWith('.')) ext = '.' + ext;
          const tmpPath = path.join(tmpRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
          await fs.promises.writeFile(tmpPath, Buffer.from(src.bytes));
          const slug = path.basename(name, path.extname(name)) || 'source';
          const { relativePath } = await imageManager.importAsset('ai-source', tmpPath, slug);
          const created = aiTasks.create({
            companyId,
            productId: null,
            sourceImagePath: relativePath,
            provider: input.provider,
            model: input.model,
            prompt: input.prompt,
            options: input.options ?? {},
            status: 'queued',
            costEstimate: aiCosts.estimateForModel(
              input.model,
              input.options?.nVariants ?? input.options?.numImages ?? 1,
            ),
          });
          queued.push(created);
        } catch (err) {
          skipped.push({ sourcePath: name, error: err.message });
        }
      }
    } finally {
      try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
    if (input.promptTemplateId) {
      try { aiPrompts.bumpUseCount(input.promptTemplateId); } catch (_) {}
    }
    if (queued.length > 0) queueRunner.nudge();
    return { queued: queued.length, tasks: queued, skipped };
  });

  /**
   * v0.16.1: bytes-back-to-client variant of ai:exportBulkImage.
   * Server returns the gallery image's bytes plus a suggested
   * filename; the client opens its own Save dialog and writes the
   * file locally. Same security check as the standalone version
   * — the entry must belong to the caller's active company.
   */
  expose('ai:exportBulkImageBytes', async ({ galleryId } = {}) => {
    const entry = aiGallery.get(galleryId);
    if (!entry) throw new Error('Gallery entry not found');
    if (entry.companyId !== companies.getActiveId()) throw new Error('Cross-company access denied');
    const abs = path.join(getDataDir(), entry.filepath);
    const bytes = await fs.promises.readFile(abs);
    const ext = path.extname(entry.filepath) || '.png';
    return { bytes, defaultName: `${entry.id.slice(0, 8)}${ext}` };
  });

  /**
   * v0.11.0: Scan a folder recursively for images. Returns the
   * list as { abs, rel, name, size } per file, capped at 1000 to
   * keep IPC payload sane. The renderer renders them as previews;
   * user confirms before enqueueing.
   */
  ipcMain.handle('ai:scanBulkFolder', (_e, folderPath) => {
    if (!folderPath) throw new Error('folderPath required');
    const paths = imageManager.scanImagesRecursive(folderPath);
    return paths.slice(0, 1000).map((abs) => {
      let size = 0;
      try { size = fs.statSync(abs).size; } catch (_) {}
      return { abs, rel: path.relative(folderPath, abs), name: path.basename(abs), size };
    });
  });

  /**
   * v0.11.0: Export a bulk gallery image to an arbitrary disk
   * location. Returns the destination path or null if the user
   * cancelled.
   */
  ipcMain.handle('ai:exportBulkImage', async (_e, { galleryId }) => {
    const entry = aiGallery.get(galleryId);
    if (!entry) throw new Error('Gallery entry not found');
    if (entry.companyId !== companies.getActiveId()) throw new Error('Cross-company access denied');
    const abs = path.join(getDataDir(), entry.filepath);
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.getFocusedWindow();
    const ext = path.extname(entry.filepath) || '.png';
    const defaultName = `${entry.id.slice(0, 8)}${ext}`;
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save AI result as…',
      defaultPath: defaultName,
    });
    if (canceled || !filePath) return null;
    fs.copyFileSync(abs, filePath);
    return filePath;
  });

  ipcMain.handle('ai:testKie', (_e, key) => aiKie.testConnection(key));
  ipcMain.handle('ai:testFal', (_e, key) => aiFal.testConnection(key));

  ipcMain.handle('ai:getCredits', async () => {
    const cfg = config.loadConfig();
    const [kie, fal] = await Promise.all([
      cfg.kieApiKey ? aiKie.getCredits(cfg.kieApiKey).catch(() => null) : Promise.resolve(null),
      cfg.falApiKey ? aiFal.getCredits(cfg.falApiKey).catch(() => null) : Promise.resolve(null),
    ]);
    return { kie, fal, fetchedAt: Date.now() };
  });
}

module.exports = { register };
