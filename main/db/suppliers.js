/**
 * v0.49.46: suppliers DB module — Phase 1 of the costing system.
 *
 * Same patterns as the other db/* modules: rowToX mapper for
 * snake_case → camelCase, scoped to the active company, prepared
 * statements for the hot paths, soft-archive via status='archived'
 * instead of DELETE (purchase orders FK-restrict against suppliers,
 * so a destructive delete would block whenever the supplier has
 * any PO history).
 */

const crypto = require('node:crypto');
const { getDb } = require('./index');

function rowToSupplier(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    country: row.country,
    defaultCurrency: row.default_currency,
    defaultIncoterm: row.default_incoterm,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    website: row.website,
    address: row.address,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  };
}

const VALID_INCOTERMS = new Set(['EXW', 'FOB', 'CFR', 'CIF']);
const VALID_STATUS    = new Set(['active', 'archived']);
const CURRENCY_RE     = /^[A-Z]{3}$/; // ISO 4217 — three uppercase letters

function normalizeIncoterm(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase().replace('CNF', 'CFR'); // CNF is informal alias for CFR
  return VALID_INCOTERMS.has(s) ? s : null;
}
function normalizeCurrency(v) {
  if (!v) return 'USD';
  const s = String(v).trim().toUpperCase();
  return CURRENCY_RE.test(s) ? s : 'USD';
}

/**
 * List suppliers for a company, optionally filtered.
 * @param {string} companyId
 * @param {object} [filters]
 * @param {string} [filters.search] — case-insensitive LIKE on name + country
 * @param {'active'|'archived'|'all'} [filters.status='active']
 */
function list(companyId, filters = {}) {
  if (!companyId) return [];
  const search = (filters.search ?? '').trim();
  const status = filters.status || 'active';

  let sql = `SELECT * FROM suppliers WHERE company_id = ?`;
  const params = [companyId];
  if (status !== 'all') {
    sql += ` AND status = ?`;
    params.push(status);
  }
  if (search) {
    // Escape LIKE meta-chars (`%` and `_`) so literal user input doesn't
    // wildcard the query. Same defensive pattern the product search uses.
    const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const term = `%${escaped}%`;
    sql += ` AND (name LIKE ? ESCAPE '\\' COLLATE NOCASE OR country LIKE ? ESCAPE '\\' COLLATE NOCASE)`;
    params.push(term, term);
  }
  sql += ` ORDER BY name COLLATE NOCASE ASC`;
  return getDb().prepare(sql).all(...params).map(rowToSupplier);
}

function get(id) {
  if (!id) return null;
  return rowToSupplier(getDb().prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id));
}

function create(input) {
  if (!input?.companyId) throw new Error('companyId is required');
  if (!input.name || !String(input.name).trim()) throw new Error('Supplier name is required');

  const now = Date.now();
  const id = `sup_${crypto.randomBytes(6).toString('hex')}`;
  const row = {
    id,
    companyId: input.companyId,
    name: String(input.name).trim(),
    country: input.country?.trim() || null,
    defaultCurrency: normalizeCurrency(input.defaultCurrency),
    defaultIncoterm: normalizeIncoterm(input.defaultIncoterm),
    contactName:  input.contactName?.trim()  || null,
    contactEmail: input.contactEmail?.trim() || null,
    contactPhone: input.contactPhone?.trim() || null,
    website:      input.website?.trim()      || null,
    address:      input.address?.trim()      || null,
    notes:        input.notes?.trim()        || null,
    status:       VALID_STATUS.has(input.status) ? input.status : 'active',
    createdAt: now,
    updatedAt: now,
    updatedByUserId: input.updatedByUserId || null,
  };

  getDb().prepare(`
    INSERT INTO suppliers (
      id, company_id, name, country, default_currency, default_incoterm,
      contact_name, contact_email, contact_phone, website, address, notes,
      status, created_at, updated_at, updated_by_user_id
    ) VALUES (
      @id, @companyId, @name, @country, @defaultCurrency, @defaultIncoterm,
      @contactName, @contactEmail, @contactPhone, @website, @address, @notes,
      @status, @createdAt, @updatedAt, @updatedByUserId
    )
  `).run(row);

  return get(id);
}

// Whitelist + map of patchable columns. Keeps a stray field from the
// renderer (e.g. an accidentally-included `createdAt`) from overwriting
// audit columns. Each entry: [camelCase patch key, snake_case column,
// optional normalizer].
const PATCHABLE = [
  ['name',            'name',              (v) => String(v).trim()],
  ['country',         'country',           (v) => v?.trim() || null],
  ['defaultCurrency', 'default_currency',  normalizeCurrency],
  ['defaultIncoterm', 'default_incoterm',  normalizeIncoterm],
  ['contactName',     'contact_name',      (v) => v?.trim() || null],
  ['contactEmail',    'contact_email',     (v) => v?.trim() || null],
  ['contactPhone',    'contact_phone',     (v) => v?.trim() || null],
  ['website',         'website',           (v) => v?.trim() || null],
  ['address',         'address',           (v) => v?.trim() || null],
  ['notes',           'notes',             (v) => v?.trim() || null],
  ['status',          'status',            (v) => (VALID_STATUS.has(v) ? v : 'active')],
];

function update(id, patch, opts = {}) {
  if (!id) throw new Error('id is required');
  const existing = get(id);
  if (!existing) throw new Error('Supplier not found');

  const sets = [];
  const params = { id, updatedAt: Date.now(), updatedByUserId: opts.userId ?? null };

  for (const [key, col, fn] of PATCHABLE) {
    if (key in (patch ?? {})) {
      const v = patch[key];
      // For required-non-empty fields (name) defensively reject empty
      // input here so an over-eager patch can't blank the column.
      if (key === 'name' && (v == null || !String(v).trim())) {
        throw new Error('Supplier name cannot be empty');
      }
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(v) : v;
    }
  }

  if (sets.length === 0) return existing; // no-op patch — return unchanged
  sets.push(`updated_at = @updatedAt`);
  sets.push(`updated_by_user_id = @updatedByUserId`);

  getDb()
    .prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);

  return get(id);
}

/**
 * Soft-archive a supplier (status='archived'). Hard delete is exposed
 * separately and refuses if any PO references the supplier — the FK is
 * RESTRICT precisely so we don't orphan PO history.
 */
function archive(id, opts = {}) {
  return update(id, { status: 'archived' }, opts);
}
function unarchive(id, opts = {}) {
  return update(id, { status: 'active' }, opts);
}

function remove(id) {
  if (!id) throw new Error('id is required');
  // Check FK before attempting — gives a clearer error than SQLite's.
  const poCount = getDb()
    .prepare(`SELECT COUNT(*) as n FROM purchase_orders WHERE supplier_id = ?`)
    .get(id)?.n ?? 0;
  if (poCount > 0) {
    throw new Error(
      `Can't delete supplier — ${poCount} purchase order${poCount === 1 ? '' : 's'} reference it. ` +
      `Archive the supplier instead to hide it from active lists.`,
    );
  }
  const res = getDb().prepare(`DELETE FROM suppliers WHERE id = ?`).run(id);
  return { deleted: res.changes };
}

module.exports = {
  list,
  get,
  create,
  update,
  archive,
  unarchive,
  remove,
  // exported for tests
  _internals: { VALID_INCOTERMS, VALID_STATUS, normalizeIncoterm, normalizeCurrency },
};
