const crypto = require('node:crypto');
const { getDb } = require('./index');
const { getCallerUserId } = require('./_util');
const { brandDir, companyDir } = require('../util/assetPath');

// Late-required to break circular dependencies.
let _imageManager;
function getImageManager() { return _imageManager ?? (_imageManager = require('../imageManager')); }
let _companies;
function getCompanies() { return _companies ?? (_companies = require('./companies')); }

function rowToBrand(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    productCount: row.product_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

// Single grouped aggregation against products keyed by brand_id, joined back
// to brands — replaces per-row correlated subqueries.
const LIST_SQL = `
  SELECT b.*,
    COALESCE(pc.cnt, 0) AS product_count
  FROM brands b
  LEFT JOIN (
    SELECT brand_id, COUNT(*) AS cnt
    FROM products
    WHERE brand_id IS NOT NULL
    GROUP BY brand_id
  ) pc ON pc.brand_id = b.id
  WHERE b.company_id = ?
  ORDER BY b.name COLLATE NOCASE
`;

function list(companyId) {
  if (!companyId) return [];
  return getDb().prepare(LIST_SQL).all(companyId).map(rowToBrand);
}

function get(id) {
  // Single row: keep the correlated subquery — there's nothing to "scale"
  // since it runs exactly once.
  const row = getDb()
    .prepare(
      `SELECT b.*,
        (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count
       FROM brands b WHERE b.id = ?`,
    )
    .get(id);
  return rowToBrand(row);
}

function getByName(companyId, name) {
  const row = getDb()
    .prepare(`SELECT * FROM brands WHERE company_id = ? AND LOWER(name) = LOWER(?)`)
    .get(companyId, name);
  return rowToBrand(row);
}

function create({ companyId, name, color, icon }) {
  if (!companyId) throw new Error('companyId is required');
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('Brand name is required');
  const existing = getByName(companyId, trimmed);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO brands (id, company_id, name, color, icon, created_at, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyId, trimmed, color ?? null, icon ?? null, ts, ts, getCallerUserId());
  return get(id);
}

/**
 * v0.12.0: a brand rename moves the on-disk dir from
 *   `assets/<company>/<old-brand-slug>/...`
 * to
 *   `assets/<company>/<new-brand-slug>/...`
 *
 * Each company that holds this brand has at most one such dir, but the
 * brand row only stores company_id, so we just look up the owning
 * company's slug. Rewrites every product_images.filepath that lives
 * under the old prefix, then physically moves the dir. Disk move runs
 * after commit; boot recovery handles partial failures.
 */
/**
 * v0.17.2: optimistic concurrency — see products.update for the
 * sentinel-prefix protocol. Same pattern: caller passes
 * `expectedUpdatedAt`; mismatch throws `CONFLICT|<json>`.
 */
function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('Brand not found');

  if (
    patch &&
    patch.expectedUpdatedAt != null &&
    Number(patch.expectedUpdatedAt) !== Number(existing.updatedAt)
  ) {
    const conflict = {
      kind: 'brand',
      id: existing.id,
      name: existing.name,
      updatedAt: existing.updatedAt,
      updatedByUserId: existing.updatedByUserId,
    };
    throw new Error(`CONFLICT|${JSON.stringify(conflict)}`);
  }
  if (patch && 'expectedUpdatedAt' in patch) {
    patch = { ...patch };
    delete patch.expectedUpdatedAt;
  }

  if (patch.name && patch.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
    const clash = getByName(existing.companyId, patch.name);
    if (clash) throw new Error(`Brand "${patch.name}" already exists for this company`);
  }

  const trimmedNewName = patch.name?.trim();
  const nameChanged = trimmedNewName && trimmedNewName !== existing.name;

  let oldBrandSlug = null;
  let newBrandSlug = null;
  let companySlug = null;
  if (nameChanged) {
    oldBrandSlug = brandDir(existing);
    newBrandSlug = brandDir({ ...existing, name: trimmedNewName });
    const company = getCompanies().get(existing.companyId);
    if (company) companySlug = companyDir(company);
  }

  const sets = [];
  const params = { id, updatedAt: Date.now() };
  if ('name' in patch && patch.name?.trim()) { sets.push('name = @name'); params.name = patch.name.trim(); }
  if ('color' in patch) { sets.push('color = @color'); params.color = patch.color ?? null; }
  if ('icon' in patch)  { sets.push('icon = @icon');   params.icon  = patch.icon  ?? null; }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updatedAt');
  sets.push('updated_by_user_id = @updatedByUserId');
  params.updatedByUserId = getCallerUserId();

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE brands SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (nameChanged && companySlug && oldBrandSlug !== newBrandSlug) {
      // Rewrite product_images.filepath for every product owned by this
      // brand. Paths are stored relative to <dataDir>/assets/, so the
      // prefix is `<company>/<old-slug>/` (no leading `assets/`).
      const oldPrefix = `${companySlug}/${oldBrandSlug}/`;
      const newPrefix = `${companySlug}/${newBrandSlug}/`;
      const rows = db
        .prepare(
          `SELECT pi.id, pi.filepath
             FROM product_images pi
             JOIN products p ON p.id = pi.product_id
            WHERE p.brand_id = ?`,
        )
        .all(id);
      const upd = db.prepare('UPDATE product_images SET filepath = ? WHERE id = ?');
      for (const r of rows) {
        if (r.filepath && r.filepath.startsWith(oldPrefix)) {
          upd.run(`${newPrefix}${r.filepath.slice(oldPrefix.length)}`, r.id);
        }
      }
    }
  });
  tx();

  if (nameChanged && companySlug && oldBrandSlug !== newBrandSlug) {
    try {
      getImageManager().moveBrandDirEverywhere([companySlug], oldBrandSlug, newBrandSlug);
    } catch (err) {
      process.stderr.write(`[brands.update] moveBrandDirEverywhere failed (${oldBrandSlug} → ${newBrandSlug}): ${err.message}\n`);
    }
  }

  return get(id);
}

function remove(id) {
  return getDb().prepare(`DELETE FROM brands WHERE id = ?`).run(id).changes > 0;
}

module.exports = { list, get, getByName, create, update, remove };
