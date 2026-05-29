const crypto = require('node:crypto');
const { getDb } = require('./index');

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    productId: row.product_id,
    companyId: row.company_id,
    filepath: row.filepath,
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    isFavorite: !!row.is_favorite,
    promotedToProduct: !!row.promoted_to_product,
    createdAt: row.created_at,
  };
}

/**
 * Insert a new gallery entry. `companyId` is required as of v0.11.0 so
 * bulk-mode rows (product_id IS NULL) can still be scoped per-company.
 * `productId` is optional — null for bulk results until/unless promoted.
 */
function create({ taskId, productId, companyId, filepath, prompt, provider, model }) {
  if (!filepath) throw new Error('filepath is required');
  if (!provider || !model) throw new Error('provider and model are required');
  if (!companyId) throw new Error('companyId is required');
  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO ai_gallery (id, task_id, product_id, company_id, filepath, prompt, provider, model, is_favorite, promoted_to_product, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    )
    .run(id, taskId ?? null, productId ?? null, companyId, filepath, prompt ?? null, provider, model, ts);
  return get(id);
}

function get(id) {
  return rowToEntry(getDb().prepare(`SELECT * FROM ai_gallery WHERE id = ?`).get(id));
}

function listByProduct(productId, { limit = 200 } = {}) {
  if (!productId) return [];
  return getDb()
    .prepare(`SELECT * FROM ai_gallery WHERE product_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(productId, limit)
    .map(rowToEntry);
}

/**
 * Bulk-mode listing: every gallery row in this company that's NOT yet
 * attached to a product. Newest first. Caller can paginate via `limit` /
 * `offset` since these can pile up across many sessions.
 */
function listBulkByCompany(companyId, { limit = 200, offset = 0 } = {}) {
  if (!companyId) return [];
  return getDb()
    .prepare(
      `SELECT * FROM ai_gallery
        WHERE company_id = ? AND product_id IS NULL
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(companyId, limit, offset)
    .map(rowToEntry);
}

function countBulkByCompany(companyId) {
  if (!companyId) return 0;
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM ai_gallery WHERE company_id = ? AND product_id IS NULL`)
    .get(companyId);
  return Number(row?.n ?? 0);
}

function setFavorite(id, isFavorite) {
  getDb()
    .prepare(`UPDATE ai_gallery SET is_favorite = ? WHERE id = ?`)
    .run(isFavorite ? 1 : 0, id);
  return get(id);
}

function markPromoted(id) {
  getDb()
    .prepare(`UPDATE ai_gallery SET promoted_to_product = 1 WHERE id = ?`)
    .run(id);
  return get(id);
}

/**
 * Attach a bulk gallery entry (product_id IS NULL) to a product. Used by
 * the "Promote to product" flow in the bulk gallery — the caller has
 * already imported the image bytes into the product's image list, so this
 * just relinks the gallery row so it shows up in that product's gallery.
 */
function attachToProduct(id, productId) {
  if (!id || !productId) throw new Error('id and productId required');
  getDb()
    .prepare(`UPDATE ai_gallery SET product_id = ?, promoted_to_product = 1 WHERE id = ?`)
    .run(productId, id);
  return get(id);
}

function remove(id) {
  return getDb().prepare(`DELETE FROM ai_gallery WHERE id = ?`).run(id).changes > 0;
}

module.exports = {
  create,
  get,
  listByProduct,
  listBulkByCompany,
  countBulkByCompany,
  setFavorite,
  markPromoted,
  attachToProduct,
  remove,
};
