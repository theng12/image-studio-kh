/**
 * v0.21.2: workspace:* IPC handlers, extracted from ipc.js.
 *
 * Sharp pipeline runs on the server. `foregroundBytes` (when
 * present) arrives as a Buffer in client mode (deserialized from
 * the base64 envelope) or as an ArrayBuffer in local mode
 * (structured clone). `Buffer.from(...)` accepts either.
 *
 * If the renderer doesn't send foreground bytes, the server reads
 * the source image from disk and processes it directly — the
 * "fast path" used by the Workspace's "Process" button after
 * auto-save has persisted the user's settings.
 */

const fs = require('node:fs');
const path = require('node:path');

const products = require('../db/products');
const productImages = require('../db/productImages');
const processingPipeline = require('../processingPipeline');
const { getDataDir } = require('../db');

function register({ expose, emitCatalogChange }) {
  // v0.15.0: exposed. `foregroundBytes` (when present) arrives as
  // a Buffer via the RPC dispatcher's deserialize step. In
  // standalone / local mode it's an ArrayBuffer through
  // structured-clone IPC. The downstream `Buffer.from(...)`
  // handles both — and the pipeline already streams to / from disk.
  expose('workspace:processImage', async ({ productId, filepath, settings, foregroundBytes } = {}) => {
    const product = products.get(productId);
    if (!product) throw new Error('Product not found');
    const images = productImages.listByProduct(productId);
    const target = images.find((i) => i.filepath === filepath);
    if (!target) throw new Error('Image not found on product');

    let fgBuffer;
    if (foregroundBytes) {
      fgBuffer = Buffer.from(foregroundBytes);
    } else {
      const srcAbs = path.join(getDataDir(), 'assets', target.filepath);
      // Use the async fs API so we don't block the main process
      // on disk I/O — the renderer's image-processing pipeline
      // can be a few MB per file.
      try {
        fgBuffer = await fs.promises.readFile(srcAbs);
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error('Source image missing on disk');
        throw err;
      }
    }

    const { relativePath } = await processingPipeline.processImage({
      sku: product.sku,
      originalFilename: target.filename,
      foregroundBuffer: fgBuffer,
      settings,
    });

    productImages.setProcessed(productId, filepath, {
      isProcessed: true,
      processedFilepath: relativePath,
      workspaceSettings: settings,
    });
    products.recomputeProcessStatus(productId);
    emitCatalogChange('images', 'processed', productId);

    return {
      images: productImages.listByProduct(productId),
      processedRelativePath: relativePath,
    };
  });

  expose('workspace:saveSettings', ({ productId, filepath, settings } = {}) => {
    const imgs = productImages.listByProduct(productId);
    const target = imgs.find((i) => i.filepath === filepath);
    if (!target) throw new Error('Image not found on product');
    productImages.setProcessed(productId, filepath, {
      isProcessed: target.isProcessed,
      processedFilepath: target.processedFilepath,
      workspaceSettings: settings,
    });
    return productImages.listByProduct(productId);
  });
}

module.exports = { register };
