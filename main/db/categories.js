const crypto = require('node:crypto');
const { getDb } = require('./index');
const { getCallerUserId } = require('./_util');

function rowToCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    parentId: row.parent_id,
    productCount: row.product_count ?? 0,
    createdAt: row.created_at,
    // v0.15.3: backfilled NULL → created_at when undefined.
    updatedAt: row.updated_at ?? row.created_at,
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

function list(companyId) {
  if (!companyId) return [];
  // Single grouped aggregation against products keyed by category_id, joined
  // back to categories — replaces per-row correlated subqueries.
  return getDb()
    .prepare(
      `SELECT c.*,
        COALESCE(pc.cnt, 0) AS product_count
       FROM categories c
       LEFT JOIN (
         SELECT category_id, COUNT(*) AS cnt
         FROM products
         WHERE category_id IS NOT NULL
         GROUP BY category_id
       ) pc ON pc.category_id = c.id
       WHERE c.company_id = ?
       ORDER BY c.name COLLATE NOCASE`,
    )
    .all(companyId)
    .map(rowToCategory);
}

function get(id) {
  const row = getDb()
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
       FROM categories c WHERE c.id = ?`,
    )
    .get(id);
  return rowToCategory(row);
}

function getByName(companyId, name) {
  const row = getDb()
    .prepare(`SELECT * FROM categories WHERE company_id = ? AND LOWER(name) = LOWER(?)`)
    .get(companyId, name);
  return rowToCategory(row);
}

function create({ companyId, name, parentId }) {
  if (!companyId) throw new Error('companyId is required');
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('Category name is required');
  const existing = getByName(companyId, trimmed);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO categories (id, company_id, name, parent_id, created_at, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyId, trimmed, parentId ?? null, ts, ts, getCallerUserId());
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('Category not found');
  if (patch.name && patch.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
    const clash = getByName(existing.companyId, patch.name);
    if (clash) throw new Error(`Category "${patch.name}" already exists`);
  }
  const sets = [];
  const params = { id };
  if ('name' in patch && patch.name?.trim()) { sets.push('name = @name'); params.name = patch.name.trim(); }
  if ('parentId' in patch) { sets.push('parent_id = @parentId'); params.parentId = patch.parentId ?? null; }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updatedAt');
  sets.push('updated_by_user_id = @updatedByUserId');
  params.updatedAt = Date.now();
  params.updatedByUserId = getCallerUserId();
  getDb().prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

function remove(id) {
  return getDb().prepare(`DELETE FROM categories WHERE id = ?`).run(id).changes > 0;
}

module.exports = { list, get, getByName, create, update, remove };
