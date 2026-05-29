/**
 * One-shot migration from the v0.11.x flat asset layout
 *   product_images.filepath = `products/<file>.jpg`     (relative to assets/)
 *   brands.icon              = `brands/<file>.png`      (relative to assets/)
 *
 * …to the v0.12.x nested layout
 *   product_images.filepath = `<company>/<brand>/<sku>/<sku>-NNN.<ext>`
 *   brands.icon              = `<company>/_brand-icons/<brand>.<ext>`
 *
 * All paths are stored relative to `<dataDir>/assets/`. The protocol
 * handler joins `<dataDir>/assets` + the stored relative path; the
 * migration prepends `assets/` only when doing actual filesystem ops.
 *
 * Idempotent via `app_state.assets_layout_v2 = 'done'`. Also runs a
 * sanity check after that marker — if any rows still hold the legacy
 * `products/` prefix, the marker is treated as stale and the migration
 * runs again. This protects against the v0.12.0/0.12.1 bug where the
 * marker was set but no files actually moved.
 *
 * Resumable on crash: per-row commits inside per-product transactions.
 * Already-migrated rows (filepath doesn't start with `products/`) are
 * skipped.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getAppState, setAppState, getDataDir } = require('./index');
const { productAssetDir, brandIconDir, productImageBasename } = require('../util/assetPath');
const { slugify } = require('../util/slug');

const APP_STATE_MARKER = 'assets_layout_v2';
const SKU_PREFIX_MARKER = 'assets_layout_v2_sku_prefix';

/**
 * The "real" check for whether the v0.12.x layout is complete. The marker
 * alone isn't trusted because v0.12.0/0.12.1 could set it without doing
 * any work. We additionally require that no product_images row still
 * holds a legacy `products/` filepath.
 */
function isFullyMigrated(db) {
  if (getAppState(APP_STATE_MARKER) !== 'done') return false;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM product_images WHERE filepath LIKE 'products/%'`)
    .get();
  return Number(row?.n ?? 0) === 0;
}

function markMigrated() {
  setAppState(APP_STATE_MARKER, 'done');
}

/**
 * Migrate product images. For each product with legacy-prefix rows,
 * build the new nested dir, move every image file from
 * `<dataDir>/assets/products/<old>.<ext>` into
 * `<dataDir>/assets/<company>/<brand>/<sku>/<sku>-NNN.<ext>`, and
 * rewrite the DB row's filepath (relative to assets/).
 *
 * Per-product transaction so a crash partway through resumes cleanly
 * on next boot — only products whose rows still match the legacy
 * prefix get re-attempted.
 */
function migrateProductImages(db) {
  const companiesById = new Map();
  for (const c of db.prepare('SELECT * FROM companies').all()) {
    companiesById.set(c.id, { id: c.id, name: c.name });
  }
  const brandsById = new Map();
  for (const b of db.prepare('SELECT * FROM brands').all()) {
    brandsById.set(b.id, { id: b.id, name: b.name, companyId: b.company_id });
  }

  const products = db.prepare('SELECT id, company_id, sku, brand_id FROM products').all();
  const dataDir = getDataDir();
  const assetsRoot = path.join(dataDir, 'assets');

  let moved = 0;
  let skipped = 0;
  let missing = 0;
  let productsTouched = 0;

  for (const p of products) {
    const company = companiesById.get(p.company_id);
    if (!company) { skipped += 1; continue; }
    const brand = p.brand_id ? brandsById.get(p.brand_id) : null;
    const product = { id: p.id, sku: p.sku, brandId: p.brand_id, companyId: p.company_id };
    const newDirRel = productAssetDir(company, brand, product);
    const newDirAbs = path.join(assetsRoot, newDirRel);

    const images = db
      .prepare('SELECT id, filepath, filename, order_index FROM product_images WHERE product_id = ? ORDER BY order_index ASC')
      .all(p.id);

    if (images.length === 0) continue;

    // Skip products that are fully migrated already (no legacy rows).
    const hasLegacy = images.some((img) => img.filepath && img.filepath.startsWith('products/'));
    if (!hasLegacy) continue;

    fs.mkdirSync(newDirAbs, { recursive: true });

    const upd = db.prepare('UPDATE product_images SET filepath = ?, filename = ? WHERE id = ?');
    const tx = db.transaction(() => {
      images.forEach((img, idx) => {
        if (!img.filepath || !img.filepath.startsWith('products/')) {
          // Row already in the new layout — leave alone.
          skipped += 1;
          return;
        }
        const oldAbs = path.join(assetsRoot, img.filepath);
        const ext = path.extname(img.filepath).toLowerCase() || '.jpg';
        const newName = `${productImageBasename(product, idx)}${ext}`;
        const newRel = `${newDirRel}/${newName}`;
        const newAbsFinal = path.join(newDirAbs, newName);

        if (fs.existsSync(oldAbs)) {
          if (!fs.existsSync(newAbsFinal)) {
            try {
              fs.renameSync(oldAbs, newAbsFinal);
              moved += 1;
            } catch (err) {
              process.stderr.write(`[asset-migration] rename ${oldAbs} → ${newAbsFinal} failed: ${err.message}\n`);
              return; // don't update DB row if file move failed
            }
          } else {
            // Target already exists from a partial prior run; treat as moved.
            moved += 1;
          }
        } else if (fs.existsSync(newAbsFinal)) {
          moved += 1;
        } else {
          missing += 1;
        }
        upd.run(newRel, newName, img.id);
      });
    });
    try {
      tx();
      productsTouched += 1;
    } catch (err) {
      process.stderr.write(`[asset-migration] product ${p.sku} tx failed: ${err.message}\n`);
    }
  }

  return { moved, skipped, missing, productsTouched };
}

/**
 * Migrate brand icons from `brands/<file>.<ext>` (relative to assets/)
 * to `<company>/_brand-icons/<brand-slug>.<ext>`.
 */
function migrateBrandIcons(db) {
  const dataDir = getDataDir();
  const assetsRoot = path.join(dataDir, 'assets');
  const companiesById = new Map();
  for (const c of db.prepare('SELECT * FROM companies').all()) {
    companiesById.set(c.id, { id: c.id, name: c.name });
  }

  const brands = db.prepare('SELECT id, company_id, name, icon FROM brands WHERE icon IS NOT NULL').all();

  let moved = 0;
  let skipped = 0;

  const upd = db.prepare('UPDATE brands SET icon = ? WHERE id = ?');
  for (const b of brands) {
    if (!b.icon || !b.icon.startsWith('brands/')) { skipped += 1; continue; }
    const company = companiesById.get(b.company_id);
    if (!company) { skipped += 1; continue; }
    const oldAbs = path.join(assetsRoot, b.icon);
    const ext = path.extname(b.icon).toLowerCase();
    const slug = slugify(b.name, 'brand');
    const newDirRel = brandIconDir(company);
    const newRel = `${newDirRel}/${slug}${ext}`;
    const newAbs = path.join(assetsRoot, newRel);
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    if (fs.existsSync(oldAbs)) {
      try {
        if (!fs.existsSync(newAbs)) fs.renameSync(oldAbs, newAbs);
        upd.run(newRel, b.id);
        moved += 1;
      } catch (err) {
        process.stderr.write(`[asset-migration] brand icon ${oldAbs}: ${err.message}\n`);
      }
    } else {
      // Source missing — still rewrite the DB pointer to the new path.
      upd.run(newRel, b.id);
    }
  }
  return { moved, skipped };
}

/**
 * Best-effort: remove any empty stub directories left behind by the
 * v0.12.0 migration attempt. Walks the assets tree at depth 1–3 (company
 * / brand / sku) and rmdir's anything that's empty. Stops at the
 * `assets/` boundary so the root isn't touched.
 */
function cleanupEmptyDirs() {
  const dataDir = getDataDir();
  const assetsRoot = path.join(dataDir, 'assets');
  if (!fs.existsSync(assetsRoot)) return;

  function walk(absDir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(absDir, entry.name);
      walk(full, depth + 1);
      try {
        const remaining = fs.readdirSync(full);
        if (remaining.length === 0) fs.rmdirSync(full);
      } catch (_) {}
    }
  }
  walk(assetsRoot, 0);
}

/**
 * Clean up the now-empty `assets/products/` and `assets/brands/` flat
 * dirs after a successful migration. Best-effort — leftover files
 * (e.g. orphans not referenced by any DB row) keep the dir, which is
 * fine; the user can clean manually.
 */
function cleanupFlatDirs() {
  const dataDir = getDataDir();
  for (const sub of ['assets/products', 'assets/brands']) {
    const abs = path.join(dataDir, sub);
    if (!fs.existsSync(abs)) continue;
    try {
      const remaining = fs.readdirSync(abs);
      if (remaining.length === 0) fs.rmdirSync(abs);
    } catch (_) {/* ignore */}
  }
}

function runAssetLayoutMigration(db) {
  if (isFullyMigrated(db)) return null;
  const t0 = Date.now();
  const prodStats = migrateProductImages(db);
  const brandStats = migrateBrandIcons(db);
  cleanupFlatDirs();
  cleanupEmptyDirs();
  markMigrated();
  return {
    durationMs: Date.now() - t0,
    productsMoved: prodStats.moved,
    productsSkipped: prodStats.skipped,
    productsMissing: prodStats.missing,
    productsTouched: prodStats.productsTouched,
    brandsMoved: brandStats.moved,
    brandsSkipped: brandStats.skipped,
  };
}

/**
 * Secondary pass kept for compatibility with users who managed to land
 * in the bare-NNN state from v0.12.0. Looks for rows whose filename is
 * exactly `NNN.<ext>` (no SKU prefix). Idempotent.
 */
function renameBareNNNFiles(db) {
  if (getAppState(SKU_PREFIX_MARKER) === 'done') return null;
  const t0 = Date.now();
  const dataDir = getDataDir();
  const assetsRoot = path.join(dataDir, 'assets');

  const rows = db.prepare(
    `SELECT id, product_id, filepath, filename, order_index
       FROM product_images
      WHERE filepath LIKE '%/%/%/%'
        AND filename GLOB '[0-9][0-9][0-9].*'`,
  ).all();

  if (rows.length === 0) {
    setAppState(SKU_PREFIX_MARKER, 'done');
    return { durationMs: Date.now() - t0, renamed: 0 };
  }

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }

  const productSql = db.prepare('SELECT id, sku FROM products WHERE id = ?');
  const upd = db.prepare('UPDATE product_images SET filepath = ?, filename = ? WHERE id = ?');

  let renamed = 0;
  for (const [productId, prodRows] of byProduct) {
    const product = productSql.get(productId);
    if (!product) continue;
    const tx = db.transaction(() => {
      for (const r of prodRows) {
        const dir = path.posix.dirname(r.filepath);
        const ext = path.extname(r.filepath).toLowerCase() || '.jpg';
        const newName = `${productImageBasename(product, r.order_index)}${ext}`;
        const newRel = `${dir}/${newName}`;
        const oldAbs = path.join(assetsRoot, r.filepath);
        const newAbs = path.join(assetsRoot, newRel);
        if (fs.existsSync(oldAbs) && !fs.existsSync(newAbs)) {
          try {
            fs.renameSync(oldAbs, newAbs);
            renamed += 1;
          } catch (err) {
            process.stderr.write(`[asset-migration v0.12.1] rename ${oldAbs} → ${newAbs}: ${err.message}\n`);
            continue;
          }
        }
        upd.run(newRel, newName, r.id);
      }
    });
    try { tx(); }
    catch (err) {
      process.stderr.write(`[asset-migration v0.12.1] product ${product.sku} tx: ${err.message}\n`);
    }
  }

  setAppState(SKU_PREFIX_MARKER, 'done');
  return { durationMs: Date.now() - t0, renamed };
}

module.exports = { runAssetLayoutMigration, renameBareNNNFiles, APP_STATE_MARKER, SKU_PREFIX_MARKER };
