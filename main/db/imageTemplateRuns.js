/**
 * Overlay Studio — batch run history. Mirrors `export_runs` but scoped to
 * the overlay batch runner. Lets the dashboard / Overlay Studio show
 * "you last ran <template> on <date>, N products". Run rows survive
 * template deletion (template_id is SET NULL on cascade) so historical
 * counts stay readable; the template name is not denormalized for now —
 * we'll show "(deleted template)" when joining returns null.
 */
const crypto = require('node:crypto');
const { getDb } = require('./index');

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    templateId: row.template_id,
    templateName: row.template_name ?? null,
    companyId: row.company_id,
    outputRoot: row.output_root,
    productsCount: Number(row.products_count ?? 0),
    imagesCount: Number(row.images_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    createdAt: row.created_at,
  };
}

function record({ templateId, companyId, outputRoot, productsCount, imagesCount, skippedCount }) {
  if (!companyId) throw new Error('companyId is required');
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO image_template_runs
        (id, template_id, company_id, output_root, products_count, images_count, skipped_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      templateId ?? null,
      companyId,
      outputRoot ?? null,
      Number(productsCount) || 0,
      Number(imagesCount)   || 0,
      Number(skippedCount)  || 0,
      Date.now(),
    );
  return id;
}

function listRecentByCompany(companyId, limit = 20) {
  if (!companyId) return [];
  return getDb()
    .prepare(
      `SELECT r.*, t.name AS template_name
         FROM image_template_runs r
         LEFT JOIN image_templates t ON t.id = r.template_id
        WHERE r.company_id = ?
        ORDER BY r.created_at DESC
        LIMIT ?`,
    )
    .all(companyId, limit)
    .map(rowToRun);
}

module.exports = { record, listRecentByCompany };
