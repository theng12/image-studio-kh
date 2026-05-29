const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDb, getDataDir } = require('./index');
const { parseJson, getCallerUserId } = require('./_util');
const { productAssetDir } = require('../util/assetPath');

// Late-required to break circular dependencies.
let _companies;
function getCompanies() { return _companies ?? (_companies = require('./companies')); }
let _brands;
function getBrands() { return _brands ?? (_brands = require('./brands')); }
let _imageManager;
function getImageManager() { return _imageManager ?? (_imageManager = require('../imageManager')); }
// v0.22.6: audit log. Late-required so it doesn't get pulled in
// during DB init (auditLog.js requires getDb()).
let _audit;
function getAudit() { return _audit ?? (_audit = require('./auditLog')); }

function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    sku: row.sku,
    name: row.name,
    brandId: row.brand_id,
    barcode: row.barcode,
    secondaryCode: row.secondary_code,
    categoryId: row.category_id,
    subcategory: row.subcategory,
    colorFinish: row.color_finish,
    variant: row.variant,
    unit: row.unit,
    status: row.status,
    tags: parseJson(row.tags, []),
    description: row.description,
    priceRetail: row.price_retail,
    priceWholesale: row.price_wholesale,
    processStatus: row.process_status,
    // Coerce to Number to guard against BigInt-shaped counts from
    // better-sqlite3 on certain builds — strict equality `BigInt(0) === 0`
    // is false and was silently breaking the "No images" filter and any
    // other numeric comparisons in the renderer.
    imageCount: Number(row.image_count ?? 0),
    processedImageCount: Number(row.processed_image_count ?? 0),
    mainImagePath: row.main_image_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // v0.15.3: attribution. NULL means "the server admin / standalone";
    // an id means a specific RPC client wrote this row last.
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

function newId() {
  return crypto.randomUUID();
}

/**
 * Build a SQL fragment for an "id IN (...) OR IS NULL" filter.
 * @param {string} col — column name on `p`, e.g. 'brand_id'
 * @param {Array<string|null>|undefined} values — array of ids and/or null sentinel
 * @returns {{ fragment: string, params: string[] }}
 */
function buildIdInFilter(col, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { fragment: '', params: [] };
  }
  const hasNull = values.some((v) => v === null);
  const ids = values.filter((v) => v != null && v !== '');
  const parts = [];
  const params = [];
  if (ids.length > 0) {
    parts.push(`p.${col} IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (hasNull) {
    parts.push(`p.${col} IS NULL`);
  }
  if (parts.length === 0) return { fragment: '', params: [] };
  return { fragment: ` AND (${parts.join(' OR ')})`, params };
}

function list(companyId, filters = {}) {
  if (!companyId) return [];
  const { search, brandIds, categoryIds, status, processStatus } = filters;
  const params = [companyId];
  let sql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
      (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
      (SELECT pi.filepath FROM product_images pi
         WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
    FROM products p
    WHERE p.company_id = ?
  `;

  const brandFilter = buildIdInFilter('brand_id', brandIds);
  sql += brandFilter.fragment;
  params.push(...brandFilter.params);

  const categoryFilter = buildIdInFilter('category_id', categoryIds);
  sql += categoryFilter.fragment;
  params.push(...categoryFilter.params);

  if (status) {
    sql += ' AND p.status = ?';
    params.push(status);
  }
  if (processStatus) {
    sql += ' AND p.process_status = ?';
    params.push(processStatus);
  }
  // v0.26.49: search overhaul. Three changes:
  //
  // 1. SCOPE — narrowed from 6 fields (sku, name, color_finish, tags,
  //    barcode, secondary_code) to the 3 fields actually shown on each
  //    Library card (sku, name, color_finish). Pre-v0.26.49 the search
  //    matched in tags / barcode / secondary_code too, which meant
  //    products could appear in results for reasons the user couldn't
  //    visually verify on the card. For barcode / secondary-code /
  //    tag-based lookups the user can use the Cmd+K global search
  //    palette (v0.18.2), which already searches more broadly.
  //
  // 2. ESCAPE — wildcard meta-chars in user input (`%` and `_`) are
  //    now escaped so they match literally. Pre-v0.26.49 typing `_`
  //    matched any single character; typing `%` matched everything.
  //    `\` is the escape character; we escape `\` itself too to
  //    handle the rare case of a user pasting a path-like string.
  //
  // 3. TRIM — whitespace-only search no longer activates the filter.
  //    A search of "   " used to LIKE %   % which matches every row
  //    with at least 2 spaces somewhere. Now we trim then bail if
  //    the result is empty.
  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  if (trimmedSearch) {
    const escaped = trimmedSearch.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const term = `%${escaped}%`;
    sql +=
      " AND (p.sku LIKE ? ESCAPE '\\'" +
      " OR p.name LIKE ? ESCAPE '\\'" +
      " OR p.color_finish LIKE ? ESCAPE '\\')";
    params.push(term, term, term);
  }
  sql += ' ORDER BY p.updated_at DESC';
  return getDb().prepare(sql).all(...params).map(rowToProduct);
}

function get(id) {
  const row = getDb()
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
        (SELECT pi.filepath FROM product_images pi
           WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
       FROM products p WHERE p.id = ?`,
    )
    .get(id);
  return rowToProduct(row);
}

function getBySku(companyId, sku) {
  const row = getDb()
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
        (SELECT pi.filepath FROM product_images pi
           WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
       FROM products p WHERE p.company_id = ? AND p.sku = ?`,
    )
    .get(companyId, sku);
  return rowToProduct(row);
}

function create(input) {
  if (!input?.companyId) throw new Error('companyId is required');
  if (!input?.sku || !input.sku.trim()) {
    throw new Error('SKU is required');
  }
  const sku = input.sku.trim();
  const existing = getBySku(input.companyId, sku);
  if (existing) {
    throw new Error(`SKU "${sku}" already exists for this company`);
  }
  const id = newId();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO products (
        id, company_id, sku, name, brand_id, barcode, secondary_code,
        category_id, subcategory, color_finish, variant, unit,
        status, tags, description, price_retail, price_wholesale,
        process_status, created_at, updated_at, updated_by_user_id
      ) VALUES (
        @id, @companyId, @sku, @name, @brandId, @barcode, @secondaryCode,
        @categoryId, @subcategory, @colorFinish, @variant, @unit,
        @status, @tags, @description, @priceRetail, @priceWholesale,
        @processStatus, @createdAt, @updatedAt, @updatedByUserId
      )`,
    )
    .run({
      id,
      companyId: input.companyId,
      sku,
      name: input.name ?? null,
      brandId: input.brandId ?? null,
      barcode: input.barcode ?? null,
      secondaryCode: input.secondaryCode ?? null,
      categoryId: input.categoryId ?? null,
      subcategory: input.subcategory ?? null,
      colorFinish: input.colorFinish ?? null,
      variant: input.variant ?? null,
      unit: input.unit ?? null,
      status: input.status ?? 'active',
      tags: JSON.stringify(input.tags ?? []),
      description: input.description ?? null,
      priceRetail: input.priceRetail ?? null,
      priceWholesale: input.priceWholesale ?? null,
      processStatus: input.processStatus ?? 'unprocessed',
      createdAt: ts,
      updatedAt: ts,
      updatedByUserId: getCallerUserId(),
    });
  const created = get(id);
  // v0.22.6: audit. Store the full created row as `after` so the
  // History modal can show the initial values.
  try {
    getAudit().log({
      entityType: 'product',
      entityId: id,
      action: 'create',
      after: {
        sku: created.sku,
        name: created.name,
        brandId: created.brandId,
        categoryId: created.categoryId,
        status: created.status,
      },
    });
  } catch (_) {/* audit failures shouldn't break create */}
  return created;
}

const UPDATABLE = {
  sku: { col: 'sku' },
  name: { col: 'name' },
  brandId: { col: 'brand_id' },
  barcode: { col: 'barcode' },
  secondaryCode: { col: 'secondary_code' },
  categoryId: { col: 'category_id' },
  subcategory: { col: 'subcategory' },
  colorFinish: { col: 'color_finish' },
  variant: { col: 'variant' },
  unit: { col: 'unit' },
  status: { col: 'status' },
  tags: { col: 'tags', transform: (v) => JSON.stringify(v ?? []) },
  description: { col: 'description' },
  priceRetail: { col: 'price_retail' },
  priceWholesale: { col: 'price_wholesale' },
  processStatus: { col: 'process_status' },
};

/**
 * v0.12.0: when sku / brandId / companyId changes, the product's asset
 * folder moves under the nested layout (`assets/<company>/<brand>/<sku>/`).
 * We compute the old/new paths from the pre/post state of the product
 * row, then move the folder + rewrite every product_images.filepath in
 * one DB transaction. Files are moved AFTER the DB tx commits so the DB
 * row is the truth-of-record if anything fails mid-disk; boot recovery
 * reconciles any orphan files via content_hash.
 */
/**
 * v0.17.2: optimistic concurrency.
 *
 * If the caller passes `expectedUpdatedAt`, we compare it against the
 * row's current `updated_at`. A mismatch means someone else has
 * written to this row since the caller loaded it. We throw a tagged
 * error the renderer can detect:
 *
 *   message format: `CONFLICT|<json-stringified current row>`
 *
 * The prefix is the only reliable channel for "code + details" that
 * survives both `ipcMain.handle` (where custom error props don't get
 * cloned) and `/api/rpc` (where only `.message` flows back). The
 * renderer's `parseConflictError(err)` helper recovers the row info
 * and shows the Refresh / Overwrite dialog.
 *
 * Callers that don't care about conflicts (e.g. bulk imports that
 * are intentionally last-write-wins, internal write-then-read
 * sequences) omit `expectedUpdatedAt` and the check is skipped.
 */
function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('Product not found');

  if (
    patch &&
    patch.expectedUpdatedAt != null &&
    Number(patch.expectedUpdatedAt) !== Number(existing.updatedAt)
  ) {
    const conflict = {
      kind: 'product',
      id: existing.id,
      sku: existing.sku,
      name: existing.name,
      updatedAt: existing.updatedAt,
      updatedByUserId: existing.updatedByUserId,
    };
    throw new Error(`CONFLICT|${JSON.stringify(conflict)}`);
  }
  // Strip the version token so it doesn't try to write itself.
  if (patch && 'expectedUpdatedAt' in patch) {
    patch = { ...patch };
    delete patch.expectedUpdatedAt;
  }

  if (patch.sku && patch.sku !== existing.sku) {
    const clash = getBySku(existing.companyId, patch.sku);
    if (clash) throw new Error(`SKU "${patch.sku}" already exists for this company`);
  }

  // Detect a path-affecting change before writing. The product fields we
  // care about: sku, brandId, companyId. Compare the patch to existing.
  const newSku = (patch.sku ?? existing.sku);
  const newBrandId = ('brandId' in patch) ? (patch.brandId ?? null) : existing.brandId;
  const newCompanyId = ('companyId' in patch) ? (patch.companyId ?? null) : existing.companyId;
  const pathChanged =
    newSku !== existing.sku ||
    newBrandId !== existing.brandId ||
    newCompanyId !== existing.companyId;

  // Compute old + new dirs (only if affected).
  let oldDir = null;
  let newDir = null;
  if (pathChanged) {
    const oldCompany = getCompanies().get(existing.companyId);
    const oldBrand = existing.brandId ? getBrands().get(existing.brandId) : null;
    oldDir = productAssetDir(oldCompany, oldBrand, existing);

    const newCompany = getCompanies().get(newCompanyId);
    if (!newCompany) throw new Error('Target company not found');
    const newBrand = newBrandId ? getBrands().get(newBrandId) : null;
    const proposedProduct = { ...existing, sku: newSku, brandId: newBrandId, companyId: newCompanyId };
    newDir = productAssetDir(newCompany, newBrand, proposedProduct);
  }

  const sets = [];
  const params = {};
  // v0.22.6: snapshot only the keys in `patch` (and only the ones
  // that actually changed). diffPatch inside auditLog handles the
  // "no-op patch → no log row" case so an update() that passes an
  // unchanged value doesn't pollute the audit feed.
  const auditPatch = {};
  for (const [key, def] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    sets.push(`${def.col} = @${key}`);
    params[key] = def.transform ? def.transform(patch[key]) : (patch[key] ?? null);
    auditPatch[key] = patch[key] ?? null;
  }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updatedAt');
  sets.push('updated_by_user_id = @updatedByUserId');
  params.updatedAt = Date.now();
  params.updatedByUserId = getCallerUserId();
  params.id = id;

  const db = getDb();
  // Update row + rewrite product_images.filepath in one tx. File moves
  // happen after commit (a partial disk move is recoverable; a partial
  // DB write is not).
  const tx = db.transaction(() => {
    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (pathChanged && oldDir !== newDir) {
      // Rewrite every product_image filepath from oldDir/* → newDir/*.
      const oldPrefix = `${oldDir}/`;
      const rows = db
        .prepare('SELECT id, filepath FROM product_images WHERE product_id = ?')
        .all(id);
      const upd = db.prepare('UPDATE product_images SET filepath = ? WHERE id = ?');
      for (const r of rows) {
        if (r.filepath && r.filepath.startsWith(oldPrefix)) {
          const tail = r.filepath.slice(oldPrefix.length);
          upd.run(`${newDir}/${tail}`, r.id);
        }
      }
    }
  });
  tx();

  if (pathChanged && oldDir !== newDir) {
    try {
      getImageManager().moveProductDir(oldDir, newDir);
    } catch (err) {
      // Disk move failed but DB is already updated. The boot recovery
      // sweep will reconcile via content_hash. Surface to stderr so it
      // shows up in crash.log.
      process.stderr.write(`[products.update] moveProductDir failed (${oldDir} → ${newDir}): ${err.message}\n`);
    }

    // v0.12.1: when the SKU changes, the in-folder filenames must also
    // change because the basename is `<sku-slug>-NNN`. Brand/company
    // changes alone don't affect file basenames so we only renumber on
    // SKU edits.
    const skuChanged = patch.sku && patch.sku !== existing.sku;
    if (skuChanged) {
      try {
        require('./productImages').renumberFiles(id);
      } catch (err) {
        process.stderr.write(`[products.update] renumberFiles after SKU rename failed: ${err.message}\n`);
      }
    }
  }

  // v0.22.6: audit. Log AFTER the disk move so a failed file move
  // doesn't leave a misleading "renamed to X" log entry pointing at
  // nothing on disk (the boot recovery sweep would still reconcile,
  // but logging post-tx keeps the timeline honest).
  try {
    getAudit().logUpdate({
      entityType: 'product',
      entityId: id,
      beforeRow: existing,
      patch: auditPatch,
    });
  } catch (_) {/* audit failures shouldn't break update */}

  return get(id);
}

function remove(id) {
  // Compute the asset dir before deletion so we can clean up after.
  // Safe to skip if the product doesn't exist (nothing to clean).
  let dirToClean = null;
  // v0.22.0: also collect ai-gallery files attached to this
  // product. ON DELETE CASCADE on ai_gallery.product_id removes
  // the DB rows, but the PNG/JPG files on disk under
  // <dataDir>/ai-gallery/<sku>/ stayed orphaned. Now we list them
  // BEFORE the DELETE (so we still have the rows to look at) and
  // unlink them after the DELETE succeeds.
  let aiGalleryAbsPaths = [];
  try {
    const existing = get(id);
    if (existing) {
      const company = getCompanies().get(existing.companyId);
      const brand = existing.brandId ? getBrands().get(existing.brandId) : null;
      if (company) dirToClean = productAssetDir(company, brand, existing);

      // Gather ai_gallery file paths for this product.
      try {
        const galleryRows = getDb()
          .prepare('SELECT filepath FROM ai_gallery WHERE product_id = ?')
          .all(id);
        const dataDir = getDataDir();
        aiGalleryAbsPaths = galleryRows
          .map((r) => r.filepath)
          .filter(Boolean)
          .map((rel) => path.join(dataDir, rel));
      } catch (_) { /* best-effort */ }
    }
  } catch (_) {/* ignore */}

  // Capture the pre-delete row so we can log it (we can't query it
  // afterwards). Grabbing it here is cheap; the earlier `get(id)`
  // call lives in the asset-dir-resolution block above but is in a
  // try/catch and might be null. Re-fetch here unconditionally.
  let preDeleteRow = null;
  try { preDeleteRow = get(id); } catch (_) {}

  const info = getDb().prepare('DELETE FROM products WHERE id = ?').run(id);
  const deleted = info.changes > 0;

  if (deleted) {
    // v0.22.6: audit the delete. The row is gone, so we log the
    // snapshot we captured pre-delete as `before`. NULL `after` =
    // entity no longer exists.
    try {
      getAudit().log({
        entityType: 'product',
        entityId: id,
        action: 'delete',
        before: preDeleteRow
          ? {
              sku: preDeleteRow.sku,
              name: preDeleteRow.name,
              brandId: preDeleteRow.brandId,
              categoryId: preDeleteRow.categoryId,
              status: preDeleteRow.status,
            }
          : null,
      });
    } catch (_) {/* audit failures shouldn't break delete */}
  }

  if (deleted && dirToClean) {
    try {
      // dirToClean is relative to <dataDir>/assets/ (e.g.
      // `KT-Ceramic/ROYAL/BF-R5232-GD`). Prepend the assets segment.
      const abs = path.join(getDataDir(), 'assets', dirToClean);
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    } catch (err) {
      process.stderr.write(`[products.remove] cleanup ${dirToClean}: ${err.message}\n`);
    }
  }
  if (deleted && aiGalleryAbsPaths.length > 0) {
    // v0.22.0: unlink ai-gallery image bytes for this product.
    // Best-effort; a missing file is fine (already cleaned up or
    // never written). We don't try to remove the parent <sku> dir
    // because other product runs may share the directory.
    for (const abs of aiGalleryAbsPaths) {
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (err) {
        process.stderr.write(`[products.remove] ai-gallery cleanup ${abs}: ${err.message}\n`);
      }
    }
  }
  return deleted;
}

/**
 * v0.22.0: bulk-remove. Called from the Library's "Delete N
 * selected" toolbar. Iterates `remove(id)` so each delete still
 * cleans up disk + emits the same cascade behavior — same code
 * path, just looped. Returns `{ deleted, failed }` so the
 * renderer can surface "Deleted 47 of 50 — 3 failed". Cross-
 * company guards live at the IPC layer; this function trusts
 * the caller.
 */
function bulkRemove(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { deleted: 0, failed: [] };
  }
  let deleted = 0;
  const failed = [];
  for (const id of ids) {
    try {
      const ok = remove(id);
      if (ok) deleted += 1;
      else failed.push({ id, error: 'Product not found' });
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }
  return { deleted, failed };
}

function setProcessStatus(id, status) {
  return update(id, { processStatus: status });
}

function recomputeProcessStatus(id) {
  const db = getDb();
  const product = get(id);
  if (!product) return null;
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN is_processed = 1 THEN 1 ELSE 0 END) AS processed
       FROM product_images WHERE product_id = ?`,
    )
    .get(id);
  const total = counts.total ?? 0;
  const processed = counts.processed ?? 0;
  let next;
  if (total === 0) next = 'unprocessed';
  else if (processed === 0) next = 'unprocessed';
  else if (processed < total) next = 'in_progress';
  else next = product.processStatus === 'exported' ? 'exported' : 'done';
  if (next !== product.processStatus) return setProcessStatus(id, next);
  return product;
}

/**
 * Bulk insert/update from import. Each row must have a `sku`.
 *
 * @param {string}  companyId
 * @param {Array}   rows
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]  Compute the changes but don't write
 *   them. Used by the import preview screen to show the user a diff of
 *   what would happen before they commit. The returned `changes` array
 *   contains one entry per import row: { rowIndex, sku, action, diffs?, reason? }.
 * @param {'merge'|'overwrite'|'skip'} [opts.conflictPolicy='merge']
 *   What to do when an existing SKU is touched:
 *     - 'merge'     — only set fields that are non-empty in the new row;
 *                     leave existing values for fields the user didn't fill.
 *                     (Same as the pre-v0.9.6 behaviour.)
 *     - 'overwrite' — set every mapped field on the existing row, even
 *                     when the new value is blank (writes null/empty).
 *                     Useful when the import IS the source of truth.
 *     - 'skip'      — leave the existing row completely alone; new rows
 *                     still insert as usual.
 *
 * Image data is never touched by import regardless of policy.
 */
function bulkUpsert(companyId, rows, opts = {}) {
  const dryRun = !!opts.dryRun;
  const policy = opts.conflictPolicy === 'overwrite' ? 'overwrite'
              : opts.conflictPolicy === 'skip'       ? 'skip'
                                                     : 'merge';
  if (!companyId) throw new Error('companyId is required');
  const db = getDb();

  // Pre-fetch existing SKUs in ONE query (instead of getBySku per row).
  // For a 1000-row import this drops 1000 SELECTs to 1 — the per-row check
  // becomes an O(1) Map lookup. The full row from the DB is still needed
  // because update() uses the existing id to build the WHERE clause.
  const trimmedRows = rows
    .map((r) => ({ raw: r, sku: r && r.sku ? String(r.sku).trim() : '' }))
    .filter((x) => x.sku);
  const existingMap = new Map();
  if (trimmedRows.length > 0) {
    const skus = trimmedRows.map((x) => x.sku);
    // SQLite parameter limit is 32K; chunk to 500 to stay well under and
    // keep the prepared statement small.
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = db.prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
          (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
          (SELECT pi.filepath FROM product_images pi
             WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
         FROM products p WHERE p.company_id = ? AND p.sku IN (${placeholders})`,
      );
      for (const row of stmt.all(companyId, ...chunk)) {
        const mapped = rowToProduct(row);
        existingMap.set(mapped.sku, mapped);
      }
    }
  }

  // The full set of scalar fields the import can touch. Listed here once so
  // it's the same set used for the merge/overwrite patch computation, for
  // the dry-run diff, and (implicitly) for the create call below.
  const UPSERT_FIELDS = [
    'name', 'brandId', 'barcode', 'secondaryCode', 'categoryId',
    'subcategory', 'colorFinish', 'variant', 'unit', 'status',
    'description', 'priceRetail', 'priceWholesale',
  ];
  // Field is considered "supplied" by the import row when the key is
  // present at all (even if the value is empty string). Empty string vs
  // undefined is the signal: '' means "user explicitly cleared", undefined
  // means "user didn't include this column at all".
  const isSupplied = (row, key) => key in row && row[key] !== undefined;

  // Computes the new value of a single field given the row + policy. Used
  // in both the live run and dry-run paths so behaviour is guaranteed
  // identical.
  function nextValueFor(existing, row, key) {
    if (policy === 'overwrite') {
      // Apply whatever the row says, even when empty. Missing key = leave alone.
      if (!isSupplied(row, key)) return { changed: false };
      const next = row[key] === '' ? null : row[key];
      return { changed: next !== existing[key], value: next };
    }
    if (policy === 'skip') {
      return { changed: false };  // never patch existing rows
    }
    // 'merge' — only set when the new value is non-empty.
    if (!isSupplied(row, key) || row[key] === '' || row[key] === null) return { changed: false };
    return { changed: row[key] !== existing[key], value: row[key] };
  }

  // Per-row error handling. A single bad row (UNIQUE clash, missing FK,
  // type mismatch, etc.) used to abort the entire transaction because
  // better-sqlite3 throws straight up the stack. We now run each row in
  // its own SAVEPOINT so one failure rolls back only that row and lets
  // the rest of the import complete. The renderer surfaces the skips
  // with reasons so the user can fix or accept them.
  const inserted = [];
  const updatedIds = [];
  const skips = [];   // [{ rowIndex, sku, reason, category }]
  const changes = []; // [{ rowIndex, sku, action, diffs?, reason? }] — preview payload

  const work = (items) => {
    items.forEach((row, idx) => {
      if (!row.sku || !String(row.sku).trim()) {
        skips.push({ rowIndex: idx, sku: '', reason: 'missing SKU', category: 'missing_sku' });
        changes.push({ rowIndex: idx, sku: '', action: 'skip', reason: 'missing SKU', category: 'missing_sku' });
        return;
      }
      const sku = String(row.sku).trim();
      const existing = existingMap.get(sku);
      try {
        if (existing) {
          // Build patch + diff at the same time so the dry-run preview
          // shows exactly the same effective change set the real run
          // would apply.
          const patch = {};
          const diffs = [];
          for (const key of UPSERT_FIELDS) {
            const { changed, value } = nextValueFor(existing, row, key);
            if (changed) {
              patch[key] = value;
              diffs.push({ field: key, oldValue: existing[key] ?? null, newValue: value ?? null });
            }
          }
          // Tags merge is array-aware: overwrite always replaces, merge
          // replaces only when the new list is non-empty.
          if (Array.isArray(row.tags)) {
            const replace = policy === 'overwrite' || row.tags.length > 0;
            if (replace) {
              const oldTags = Array.isArray(existing.tags) ? existing.tags : [];
              const sameTags = oldTags.length === row.tags.length && oldTags.every((t, i) => t === row.tags[i]);
              if (!sameTags) {
                patch.tags = row.tags;
                diffs.push({ field: 'tags', oldValue: oldTags, newValue: row.tags });
              }
            }
          }

          if (diffs.length === 0) {
            // Existing row already matches — nothing to do. Counts as a
            // "no-op" change so the user can see we considered it.
            changes.push({ rowIndex: idx, sku, action: 'no_change', existingId: existing.id });
            if (!dryRun) updatedIds.push(existing.id);
          } else {
            if (!dryRun) {
              update(existing.id, patch);
              updatedIds.push(existing.id);
            }
            changes.push({ rowIndex: idx, sku, action: 'update', existingId: existing.id, diffs });
          }
        } else {
          // Build the would-be inserted record for both the create call
          // and the preview diff list.
          const newRecord = {
            companyId,
            sku,
            name:          row.name          ?? null,
            brandId:       row.brandId       ?? null,
            barcode:       row.barcode       ?? null,
            secondaryCode: row.secondaryCode ?? null,
            categoryId:    row.categoryId    ?? null,
            subcategory:   row.subcategory   ?? null,
            colorFinish:   row.colorFinish   ?? null,
            variant:       row.variant       ?? null,
            unit:          row.unit          ?? null,
            status:        row.status        ?? 'active',
            tags:          row.tags          ?? [],
            description:   row.description   ?? null,
            priceRetail:   row.priceRetail   ?? null,
            priceWholesale: row.priceWholesale ?? null,
          };
          if (dryRun) {
            // For previews, surface the non-default fields so the user
            // sees what we'll actually fill in.
            const diffs = [];
            for (const key of UPSERT_FIELDS) {
              const v = newRecord[key];
              if (v !== null && v !== undefined && v !== '') {
                diffs.push({ field: key, oldValue: null, newValue: v });
              }
            }
            if (newRecord.tags?.length > 0) {
              diffs.push({ field: 'tags', oldValue: [], newValue: newRecord.tags });
            }
            changes.push({ rowIndex: idx, sku, action: 'insert', diffs });
            // Pretend it now exists so a duplicate further in the file
            // becomes an update (same as live behaviour).
            existingMap.set(sku, { id: '__pending__', sku, ...newRecord });
          } else {
            const created = create(newRecord);
            if (created) existingMap.set(sku, created);
            inserted.push(created?.id ?? sku);
            changes.push({ rowIndex: idx, sku, action: 'insert', existingId: created?.id });
          }
        }
      } catch (err) {
        const msg = err?.message ?? String(err);
        const category = /UNIQUE|already exists/i.test(msg) ? 'duplicate'
                       : /FOREIGN KEY/i.test(msg)            ? 'bad_reference'
                       : /NOT NULL/i.test(msg)               ? 'missing_field'
                                                             : 'error';
        skips.push({ rowIndex: idx, sku, reason: msg, category });
        changes.push({ rowIndex: idx, sku, action: 'skip', reason: msg, category });
      }
    });
    return {
      inserted: inserted.length,
      updated: updatedIds.length,
      skips,
      changes,
      conflictPolicy: policy,
      dryRun,
    };
  };

  // Dry-run skips the transaction entirely — no writes means no rollback
  // needed. The work() function is otherwise identical to the live run so
  // the user is guaranteed to see exactly what would happen.
  if (dryRun) return work(rows);
  const tx = db.transaction(work);
  return tx(rows);
}

/**
 * v0.18.0: duplicate a product. Copies every scalar field; SKU and
 * name get " (copy)" appended (or " (copy 2)" / " (copy 3)" on
 * collision so back-to-back duplicates don't fight). If
 * `includeImages` is true, every product_images row is copied — same
 * file on disk (content-addressed, so this is a same-hash dedup with
 * no extra bytes) but a fresh DB row pointing to it.
 *
 * Resets processStatus to 'unprocessed' so the duplicate doesn't
 * inherit the original's exported flag.
 */
async function duplicate(id, { includeImages = true } = {}) {
  const original = get(id);
  if (!original) throw new Error('Product not found');

  // Find an unused SKU based on the original's. Try " (copy)", " (copy 2)",
  // " (copy 3)", … so multi-clicks don't fail with a uniqueness error.
  function nextSlot(base) {
    let candidate = `${base} (copy)`;
    if (!getBySku(original.companyId, candidate)) return candidate;
    for (let i = 2; i < 100; i++) {
      candidate = `${base} (copy ${i})`;
      if (!getBySku(original.companyId, candidate)) return candidate;
    }
    throw new Error('Too many duplicates already exist');
  }
  const newSku = nextSlot(original.sku);
  const newName = original.name ? `${original.name} (copy)` : null;

  const created = create({
    companyId: original.companyId,
    sku: newSku,
    name: newName,
    brandId: original.brandId,
    barcode: null,            // barcodes are unique per-product by convention; don't clone
    secondaryCode: null,
    categoryId: original.categoryId,
    subcategory: original.subcategory,
    colorFinish: original.colorFinish,
    variant: original.variant,
    unit: original.unit,
    status: original.status,
    tags: original.tags,
    description: original.description,
    priceRetail: original.priceRetail,
    priceWholesale: original.priceWholesale,
    processStatus: 'unprocessed',
  });

  if (includeImages) {
    // Copy each product_images row from the original to the new
    // product. addFromSource handles the nested-dir layout +
    // dedup-by-hash. Since the source file is already in the assets
    // tree, dedup will short-circuit and we'll get a fresh row that
    // points at the same file under the new product's directory.
    const productImages = require('./productImages');
    const path = require('node:path');
    const dataDir = getDataDir();
    const rows = productImages.listByProduct(original.id);
    for (const row of rows) {
      try {
        const absPath = path.join(dataDir, 'assets', row.filepath);
        await productImages.addFromSource(created.id, absPath, {
          originalFilepath: row.filepath,
        });
      } catch (_err) {
        // Best-effort: a missing source file shouldn't fail the
        // whole duplicate. The user will see N images instead of
        // N+1 in the new product.
      }
    }
    recomputeProcessStatus(created.id);
  }
  return get(created.id);
}

/**
 * v0.22.8: bump the product row's updated_at + updated_by_user_id
 * WITHOUT going through update() (which would diff-and-log the audit
 * trail; we don't want a no-op "Edited 5 min ago" entry every time
 * the user just reorders images). Used by the image IPC handlers so
 * the Library list/grid thumbnails get a fresh `?v=updatedAt` cache
 * key after every image add/remove/reorder/set-main.
 *
 * Side benefit: the "Edited 5 min ago by Alice" attribution chip in
 * the side panel + Library row will reflect image edits too, not just
 * scalar field edits. That's a more honest answer to "when did this
 * product last change?".
 */
function touchUpdated(id) {
  if (!id) return null;
  const db = getDb();
  db.prepare(`
    UPDATE products
       SET updated_at = @updatedAt,
           updated_by_user_id = @updatedByUserId
     WHERE id = @id
  `).run({
    id,
    updatedAt: Date.now(),
    updatedByUserId: getCallerUserId(),
  });
  return get(id);
}

module.exports = {
  list,
  get,
  getBySku,
  create,
  update,
  remove,
  bulkRemove,
  duplicate,
  setProcessStatus,
  recomputeProcessStatus,
  bulkUpsert,
  touchUpdated,
};
