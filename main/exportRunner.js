const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { getDataDir } = require('./db');
const products = require('./db/products');
const productImages = require('./db/productImages');
const brands = require('./db/brands');
const { slugify } = require('./util/slug');

/* ── Filename token builder ───────────────────────────────────── */

// Export-filename tokens want empty-string when the source value is missing
// so the surrounding separator collapses naturally — keep that semantics
// by passing fallback '' (the default) through to the shared slugify.
function slugifyFilename(value) {
  return slugify(value, '');
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolveToken(token, ctx) {
  switch (token) {
    case 'SKU':    return slugifyFilename(ctx.product.sku);
    case 'NAME':   return slugifyFilename(ctx.product.name ?? '');
    case 'COLOR':  return slugifyFilename(ctx.product.colorFinish ?? '');
    case 'BRAND':  return slugifyFilename(ctx.brand?.name ?? '');
    case 'INDEX':  return String(ctx.imageIndex + 1).padStart(2, '0');
    case 'DATE':   return ctx.dateStr;
    default:       return '';
  }
}

/**
 * Build a filename from a pattern like "{SKU}-{INDEX}".
 * Empty tokens are dropped from the join so a missing field doesn't leave
 * a dangling separator. Returns the base name (no extension).
 */
function buildFilename(pattern, ctx) {
  // Tokens are everything inside curly braces; everything else is treated as
  // a literal separator hint. We split on tokens, resolve each, drop empties,
  // then join with the dominant separator found in the pattern.
  const tokenRe = /\{([A-Z]+)\}/g;
  const parts = [];
  let match;
  let lastIndex = 0;
  while ((match = tokenRe.exec(pattern)) !== null) {
    if (match.index > lastIndex) {
      // Skip literal chunks for join purposes — they're separators.
    }
    const resolved = resolveToken(match[1], ctx);
    if (resolved) parts.push(resolved);
    lastIndex = match.index + match[0].length;
  }
  // Dominant separator: count - vs _ in the pattern.
  const dashes = (pattern.match(/-/g) || []).length;
  const unders = (pattern.match(/_/g) || []).length;
  const sep = unders > dashes ? '_' : dashes > 0 ? '-' : '';
  let name = parts.join(sep);
  if (!name) name = slugifyFilename(ctx.product.sku);
  return name;
}

function uniqueOutputPath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

/**
 * v0.26.24: collision-aware output path resolver. Returns
 *   { outPath, action }
 * where action is one of:
 *   'write'    — file didn't exist; just write it fresh
 *   'replace'  — file existed AND mode === 'replace'; overwrite
 *   'skip'     — file existed AND mode === 'skip'; do not touch
 *   'keepBoth' — file existed AND mode === 'keepBoth'; outPath has a
 *                `-2`, `-3` … suffix to dodge the collision
 *
 * Callers branch on `action`:
 *   - 'write' / 'replace' / 'keepBoth' → run the sharp pipeline at outPath
 *   - 'skip'                            → bump a skip counter, don't touch
 *
 * Default mode 'keepBoth' preserves the pre-v0.26.24 behaviour so the
 * exporter is backward-compatible if a caller forgets to specify.
 */
function resolveOutputPath(dir, base, ext, mode = 'keepBoth') {
  const direct = path.join(dir, `${base}${ext}`);
  if (!fs.existsSync(direct)) return { outPath: direct, action: 'write' };
  if (mode === 'replace') return { outPath: direct, action: 'replace' };
  if (mode === 'skip')    return { outPath: direct, action: 'skip' };
  // keepBoth: suffix until free
  return { outPath: uniqueOutputPath(dir, base, ext), action: 'keepBoth' };
}

/**
 * v0.26.24: dry-run pass — walks the same product / image / filename
 * pipeline as runExport but DOESN'T touch disk. Used by the renderer
 * to detect collisions BEFORE prompting the user with the "Folder
 * already contains N matching files — replace / skip / keep both?"
 * modal.
 *
 * Returns `{ totalExpected, collisions: [{ name, sku }, …] }`
 * where `collisions` is capped at 10 entries (just enough for the
 * modal's "e.g. …" hint). `totalExpected` is the count of files the
 * export would TRY to write — not the count that would succeed,
 * since sharp errors / source-missing rows still skip.
 */
/**
 * v0.26.50: pure "what filenames would this export produce" computation,
 * with NO filesystem access. Split out of previewCollisions so client
 * mode can fetch the expected names from the server (which has the DB)
 * and then run the existence check against the CLIENT's own disk.
 *
 * Returns relative paths (subfolder/filename) so the caller can join
 * them onto whichever outputRoot is correct for their machine — the
 * server's, or the client's. This is the key to fixing the client-mode
 * collision check: filenames come from the server, fs.existsSync runs
 * locally where the files actually land.
 *
 * @returns {{ totalExpected: number, entries: Array<{rel: string, sku: string}> }}
 */
function expectedOutputs({ profile, productIds }) {
  if (!profile || !Array.isArray(productIds) || productIds.length === 0) {
    return { totalExpected: 0, entries: [] };
  }
  const subfolder = profile.outputSubfolder || '';
  const ext = profile.format === 'png' ? '.png'
            : profile.format === 'webp' ? '.webp'
            : '.jpg';
  const dateStr = todayStr();
  const entries = [];
  for (const productId of productIds) {
    const product = products.get(productId);
    if (!product) continue;
    const brand = product.brandId ? brands.get(product.brandId) : null;
    const images = productImages.listByProduct(productId);
    for (let i = 0; i < images.length; i++) {
      const ctx = { product, brand, imageIndex: i, dateStr };
      const base = buildFilename(profile.namingPattern || '{SKU}-{INDEX}', ctx);
      const filename = `${base}${ext}`;
      const rel = subfolder ? path.join(subfolder, filename) : filename;
      entries.push({ rel, sku: product.sku });
    }
  }
  return { totalExpected: entries.length, entries };
}

/**
 * Build the collision report for the export-time "files already exist"
 * modal. v0.26.50: now a thin wrapper over `expectedOutputs` + a local
 * fs.existsSync pass. The filename computation is the same as before;
 * only the structure changed so the name-computation half can be
 * reused over RPC in client mode.
 */
function previewCollisions({ profile, productIds, outputRoot }) {
  if (!outputRoot) return { totalExpected: 0, collisionCount: 0, sampleCollisions: [] };
  const { totalExpected, entries } = expectedOutputs({ profile, productIds });
  const collisions = [];
  for (const { rel, sku } of entries) {
    const direct = path.join(outputRoot, rel);
    if (fs.existsSync(direct)) collisions.push({ name: path.basename(direct), sku });
  }
  return {
    totalExpected,
    collisionCount: collisions.length,
    sampleCollisions: collisions.slice(0, 5),
  };
}

/* ── Sharp output pipeline ───────────────────────────────────── */

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
function parseHexColor(hex) {
  const fallback = { r: 255, g: 255, b: 255 };
  if (!HEX_RE.test(hex)) return fallback;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

async function processOneImage({ sourceAbs, profile, outPath }) {
  const meta = await sharp(sourceAbs).metadata();
  const bg = parseHexColor(profile.backgroundColor || '#FFFFFF');

  let pipeline = sharp(sourceAbs).rotate();

  // Resize to profile size (no upscaling).
  if (meta.width !== profile.width || meta.height !== profile.height) {
    pipeline = pipeline.resize({
      width:  profile.width,
      height: profile.height,
      fit:    'contain',
      background: { ...bg, alpha: 1 },
      withoutEnlargement: false,
    });
  }

  // Flatten if outputting JPG (no alpha support).
  if (profile.format === 'jpg' || profile.format === 'jpeg') {
    pipeline = pipeline.flatten({ background: bg });
  }

  // Format conversion.
  switch (profile.format) {
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 7 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: profile.quality ?? 88 });
      break;
    case 'jpg':
    case 'jpeg':
    default:
      pipeline = pipeline.jpeg({ quality: profile.quality ?? 88, mozjpeg: true });
      break;
  }

  await pipeline.toFile(outPath);
}

/* ── Run ─────────────────────────────────────────────────────── */

/**
 * Run an export.
 *
 * @param {object} args
 * @param {Profile} args.profile
 * @param {string[]} args.productIds
 * @param {string} args.outputRoot — user-chosen folder
 * @param {(stage, payload) => void} [args.onProgress] — called for each image
 * @param {'replace'|'skip'|'keepBoth'} [args.onExisting] — v0.26.24
 *   collision policy when the output folder already contains a file with
 *   the same name. Defaults to 'keepBoth' (suffix with -2, -3) for
 *   backward compatibility with callers that haven't been updated.
 * @returns {Promise<{exported: number, skipped: number, replaced: number, products: number, outputPath: string, skips: Array<{sku, reason}>}>}
 */
async function runExport({ profile, productIds, outputRoot, onProgress, onExisting = 'keepBoth', saveToLibrary = false }) {
  if (!profile) throw new Error('Profile is required');
  if (!outputRoot) throw new Error('Output folder is required');
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return { exported: 0, skipped: 0, products: 0, outputPath: outputRoot, skips: [] };
  }

  const outputPath = profile.outputSubfolder
    ? path.join(outputRoot, profile.outputSubfolder)
    : outputRoot;
  fs.mkdirSync(outputPath, { recursive: true });

  const ext = profile.format === 'png' ? '.png'
            : profile.format === 'webp' ? '.webp'
            : '.jpg';
  const dateStr = todayStr();

  let exported = 0;
  let exportedFromRaw = 0;   // tally of how many used raw source vs processed
  let skipped = 0;
  // v0.26.24: split counters so the result toast can tell the user
  // "exported 47, replaced 12, skipped 3" rather than collapsing
  // replacements into the overall write count.
  let replaced = 0;
  let skippedExisting = 0;
  const skips = [];
  // v0.30.0: tally output file sizes so the result can tell the user how
  // much they're about to copy (and the per-file range — they care that
  // exports land around 50–150 KB for fast mobile loading).
  let totalBytes = 0;
  let minBytes = Infinity;
  let maxBytes = 0;
  // v0.31.0: when saveToLibrary is on, collect each product's exported
  // output paths here and import them back AFTER the main loop (importing
  // mid-loop would renumber on-disk files and invalidate the source paths
  // we still need to read). Map: productId → [outFile, …] in export order.
  const toLibrary = saveToLibrary ? new Map() : null;

  for (let p = 0; p < productIds.length; p++) {
    const productId = productIds[p];
    const product = products.get(productId);
    if (!product) {
      skipped++;
      // `category` lets the UI group similar skips and show a fix-it tip
      // rather than dumping a wall of identical-looking strings on the user.
      skips.push({ sku: `(missing ${productId})`, reason: 'product not found', category: 'not_found' });
      continue;
    }
    const brand = product.brandId ? brands.get(product.brandId) : null;
    const images = productImages.listByProduct(productId);

    if (images.length === 0) {
      skipped++;
      skips.push({ sku: product.sku, reason: 'no images on this product', category: 'no_images' });
      continue;
    }

    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      // Export is now pass-through: use the processed file when one exists,
      // otherwise fall back to the raw source. The Sharp pipeline in
      // processOneImage() is just resize + format-convert — it doesn't
      // require the Workspace's background-removal step.
      //
      // The two paths resolve under different roots:
      //   processed:  <dataDir>/processed/<sku>/<file>.png   (Workspace output)
      //   raw:        <dataDir>/assets/<filepath>            (auto-match / import)
      //   ai-gallery: <dataDir>/ai-gallery/<sku>/...         (AI Studio output)
      let sourceAbs = null;
      let usedRaw = false;
      const processedRel = img.isProcessed && img.processedFilepath ? img.processedFilepath : null;
      if (processedRel) {
        const candidate = processedRel.startsWith('processed/') || processedRel.startsWith('ai-gallery/')
          ? path.join(getDataDir(), processedRel)
          : path.join(getDataDir(), 'assets', processedRel);
        if (fs.existsSync(candidate)) sourceAbs = candidate;
      }
      if (!sourceAbs && img.filepath) {
        // Raw source fallback — same resolution rules as app-image://.
        const candidate = img.filepath.startsWith('processed/') || img.filepath.startsWith('ai-gallery/')
          ? path.join(getDataDir(), img.filepath)
          : path.join(getDataDir(), 'assets', img.filepath);
        if (fs.existsSync(candidate)) {
          sourceAbs = candidate;
          usedRaw = true;
        }
      }
      if (!sourceAbs) {
        skipped++;
        skips.push({
          sku: product.sku,
          reason: `image ${i + 1} file missing on disk (neither processed nor raw source found)`,
          category: 'missing',
        });
        continue;
      }

      const ctx = { product, brand, imageIndex: i, dateStr };
      const base = buildFilename(profile.namingPattern || '{SKU}-{INDEX}', ctx);
      // v0.26.24: collision-aware resolver. Returns { outPath, action }
      // where action drives the per-iteration branch below.
      const { outPath: outFile, action } = resolveOutputPath(outputPath, base, ext, onExisting);

      if (action === 'skip') {
        // File already exists at the canonical path and user chose
        // to keep existing. Don't run the sharp pipeline — just
        // count it. Still surfaces in the result so the toast can
        // say "12 skipped because they already existed".
        skipped++;
        skippedExisting++;
        skips.push({
          sku: product.sku,
          reason: `image ${i + 1}: already exists at "${path.basename(outFile)}" (skipped per collision policy)`,
          category: 'already_exists',
        });
        continue;
      }

      try {
        await processOneImage({ sourceAbs, profile, outPath: outFile });
        exported++;
        if (action === 'replace') replaced++;
        if (usedRaw) exportedFromRaw++;
        // Record the encoded output size for the run's size summary.
        let bytes = 0;
        try { bytes = fs.statSync(outFile).size; } catch (_) {}
        if (bytes > 0) {
          totalBytes += bytes;
          if (bytes < minBytes) minBytes = bytes;
          if (bytes > maxBytes) maxBytes = bytes;
        }
        if (toLibrary) {
          if (!toLibrary.has(productId)) toLibrary.set(productId, []);
          toLibrary.get(productId).push(outFile);
        }
        // Mark as exported on product if all processed images now exported in this run.
        onProgress?.('image', { product, imageIndex: i, totalProducts: productIds.length, productIndex: p, outFile, usedRaw, action, bytes });
      } catch (err) {
        skipped++;
        skips.push({
          sku: product.sku,
          reason: `image ${i + 1}: ${err.message}`,
          category: 'error',
        });
      }
    }

    // Flip the product to "exported" if it had processed images.
    if (images.some((im) => im.isProcessed)) {
      try { products.setProcessStatus(product.id, 'exported'); } catch (_) {}
    }
  }

  // v0.31.0: import-back pass. Append each exported file onto its product
  // as a new image, set the first one as the product's main, and flag every
  // appended copy dedup_exempt so the near-duplicate scan never groups a
  // small web export against its hi-res original. Done after the export
  // loop so renumbering here can't disturb source paths we read above.
  let savedToLibrary = 0;
  if (toLibrary) {
    const MAX = require('./imageManager').MAX_IMAGES_PER_PRODUCT;
    for (const [pid, files] of toLibrary) {
      let mainSet = false;
      for (const f of files) {
        try {
          if (productImages.listByProduct(pid).length >= MAX) break; // respect cap
          const { image: added, skipped: addSkipped } = await productImages.addFromSource(pid, f, { originalFilepath: f });
          if (added && !addSkipped) {
            try { productImages.setDedupExempt(added.id, true); } catch (_) {}
            savedToLibrary++;
            if (!mainSet) { try { productImages.setMain(pid, added.filepath); } catch (_) {} mainSet = true; }
          }
        } catch (_) { /* per-image best-effort; don't fail the whole export */ }
      }
    }
  }

  return {
    exported,
    exportedFromRaw,   // subset of `exported` that came from raw source
    savedToLibrary,    // v0.31.0: count appended back into the library
    // v0.26.24: replacement + already-existed counts so the result
    // toast can be precise. `replaced` ⊆ `exported`; both count
    // toward the user's "this file got written" total.
    replaced,
    skippedExisting,
    skipped,
    products: productIds.length,
    outputPath,
    skips,
    // v0.30.0: output size summary (bytes). avg = totalBytes / exported.
    totalBytes,
    minBytes: Number.isFinite(minBytes) ? minBytes : 0,
    maxBytes,
  };
}

module.exports = { runExport, buildFilename, slugifyFilename, previewCollisions, expectedOutputs };
