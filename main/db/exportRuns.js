const crypto = require('node:crypto');
const { getDb } = require('./index');

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    runAt: row.run_at,
    productCount: row.product_count,
    imageCount: row.image_count,
    skippedCount: row.skipped_count,
    outputPath: row.output_path,
    notes: row.notes,
  };
}

function record({ profileId, productCount, imageCount, skippedCount, outputPath, notes }) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO export_runs (
         id, profile_id, run_at, product_count, image_count, skipped_count, output_path, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      profileId ?? null,
      ts,
      productCount ?? 0,
      imageCount ?? 0,
      skippedCount ?? 0,
      outputPath ?? null,
      notes ?? null,
    );
  return rowToRun(getDb().prepare(`SELECT * FROM export_runs WHERE id = ?`).get(id));
}

function listRecent(limit = 20) {
  return getDb()
    .prepare(`SELECT * FROM export_runs ORDER BY run_at DESC LIMIT ?`)
    .all(limit)
    .map(rowToRun);
}

/**
 * Scoped variant — joins through export_profiles to filter by company.
 * Orphan runs whose profile was deleted (profile_id IS NULL) are excluded;
 * they're not useful to any single company.
 */
function listRecentByCompany(companyId, limit = 20) {
  if (!companyId) return [];
  return getDb()
    .prepare(
      `SELECT r.* FROM export_runs r
       JOIN export_profiles p ON p.id = r.profile_id
       WHERE p.company_id = ?
       ORDER BY r.run_at DESC LIMIT ?`,
    )
    .all(companyId, limit)
    .map(rowToRun);
}

module.exports = { record, listRecent, listRecentByCompany };
