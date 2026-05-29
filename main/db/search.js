/**
 * v0.18.2: global search across products, brands, and categories
 * for the active company.
 *
 * Single ORs-and-LIKEs query against each table; results are
 * normalized into a flat `{ kind, id, label, sublabel, productId? }`
 * shape so the renderer's palette UI doesn't need to know about
 * table structure. Capped at 30 hits per query to keep the IPC
 * payload small and the rendered list fast — beyond that, the user
 * should refine their query.
 *
 * Match strategy: case-insensitive LIKE on every plausibly-searched
 * column. Not full-text search; for the typical catalog size (a few
 * thousand products) the regex-style match is fast enough and the
 * UX matches user mental models ("does the string appear anywhere
 * in the SKU / name / description?"). If catalogs grow huge we can
 * switch to FTS5 later with no API surface change.
 */

const { getDb } = require('./index');

function globalSearch(companyId, query, limit = 30) {
  if (!companyId) return [];
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  const db = getDb();

  const results = [];

  // Products: SKU, name, barcode, secondary_code, description.
  const productRows = db
    .prepare(
      `SELECT id, sku, name, barcode, secondary_code
         FROM products
        WHERE company_id = ?
          AND (
            sku LIKE ? COLLATE NOCASE
            OR name LIKE ? COLLATE NOCASE
            OR barcode LIKE ? COLLATE NOCASE
            OR secondary_code LIKE ? COLLATE NOCASE
            OR description LIKE ? COLLATE NOCASE
            OR color_finish LIKE ? COLLATE NOCASE
          )
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(companyId, like, like, like, like, like, like, limit);
  for (const p of productRows) {
    results.push({
      kind: 'product',
      id: p.id,
      label: p.sku,
      sublabel: p.name || null,
      // Extra disambiguating fields when the match was on barcode etc.
      extra: p.barcode || p.secondary_code || null,
      productId: p.id,
    });
  }

  // Brands.
  const brandRows = db
    .prepare(
      `SELECT id, name FROM brands
        WHERE company_id = ? AND name LIKE ? COLLATE NOCASE
        ORDER BY name COLLATE NOCASE LIMIT ?`,
    )
    .all(companyId, like, limit);
  for (const b of brandRows) {
    results.push({ kind: 'brand', id: b.id, label: b.name });
  }

  // Categories.
  const catRows = db
    .prepare(
      `SELECT id, name FROM categories
        WHERE company_id = ? AND name LIKE ? COLLATE NOCASE
        ORDER BY name COLLATE NOCASE LIMIT ?`,
    )
    .all(companyId, like, limit);
  for (const c of catRows) {
    results.push({ kind: 'category', id: c.id, label: c.name });
  }

  // Cap the merged list. Products are listed first by design — they're
  // the most-common target — so a 30-cap usually means "30 product
  // matches plus brand / category hits". If product hits alone exceed
  // 30, brands and categories don't appear; the user can refine.
  return results.slice(0, limit);
}

module.exports = { globalSearch };
