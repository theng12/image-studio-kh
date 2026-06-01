const { getDb } = require('./index');

function statsFor(companyId) {
  if (!companyId) {
    return { products: 0, brands: 0, categories: 0, images: 0, processed: 0 };
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM products   WHERE company_id = ?)                  AS products,
        (SELECT COUNT(*) FROM brands     WHERE company_id = ?)                  AS brands,
        (SELECT COUNT(*) FROM categories WHERE company_id = ?)                  AS categories,
        (SELECT COUNT(*) FROM product_images pi
           JOIN products p ON p.id = pi.product_id
           WHERE p.company_id = ?)                                              AS images,
        (SELECT COUNT(*) FROM product_images pi
           JOIN products p ON p.id = pi.product_id
           WHERE p.company_id = ? AND pi.is_processed = 1)                      AS processed
      `,
    )
    .get(companyId, companyId, companyId, companyId, companyId);
  return row;
}

function recentBrands(companyId, limit = 5) {
  if (!companyId) return [];
  return getDb()
    .prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count
       FROM brands b
       WHERE b.company_id = ?
       ORDER BY b.created_at DESC
       LIMIT ?`,
    )
    .all(companyId, limit)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      productCount: r.product_count ?? 0,
    }));
}

function recentProducts(companyId, limit = 8) {
  if (!companyId) return [];
  // Use grouped joins instead of per-row correlated subqueries: one pass for
  // image counts and one pass for the first-image path (order_index = 0).
  return getDb()
    .prepare(
      `SELECT p.id, p.sku, p.name, p.updated_at,
         COALESCE(ic.cnt, 0)   AS image_count,
         mi.filepath           AS main_image_path
       FROM products p
       LEFT JOIN (
         SELECT product_id, COUNT(*) AS cnt
         FROM product_images
         GROUP BY product_id
       ) ic ON ic.product_id = p.id
       LEFT JOIN product_images mi
         ON mi.product_id = p.id AND mi.order_index = 0
       WHERE p.company_id = ?
       ORDER BY p.updated_at DESC
       LIMIT ?`,
    )
    .all(companyId, limit)
    .map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      updatedAt: r.updated_at,
      imageCount: r.image_count ?? 0,
      mainImagePath: r.main_image_path ?? null,
    }));
}

/**
 * v0.35.0: catalog-completeness counts for the Dashboard "needs attention"
 * panel. One pass over the company's products with a grouped LEFT JOIN for
 * image counts (no per-row subquery — same perf shape as products.list).
 */
function completenessFor(companyId) {
  const empty = { total: 0, missingImages: 0, missingBarcode: 0, missingPrice: 0, notExported: 0 };
  if (!companyId) return empty;
  const row = getDb()
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(ic.n, 0) = 0 THEN 1 ELSE 0 END) AS missingImages,
        SUM(CASE WHEN p.barcode IS NULL OR TRIM(p.barcode) = '' THEN 1 ELSE 0 END) AS missingBarcode,
        SUM(CASE WHEN p.price_retail IS NULL THEN 1 ELSE 0 END) AS missingPrice,
        SUM(CASE WHEN p.process_status IS NULL OR p.process_status <> 'exported' THEN 1 ELSE 0 END) AS notExported
      FROM products p
      LEFT JOIN (SELECT product_id, COUNT(*) AS n FROM product_images GROUP BY product_id) ic
        ON ic.product_id = p.id
      WHERE p.company_id = ?
    `)
    .get(companyId);
  return {
    total: Number(row?.total ?? 0),
    missingImages: Number(row?.missingImages ?? 0),
    missingBarcode: Number(row?.missingBarcode ?? 0),
    missingPrice: Number(row?.missingPrice ?? 0),
    notExported: Number(row?.notExported ?? 0),
  };
}

module.exports = { statsFor, recentBrands, recentProducts, completenessFor };
