const crypto = require('node:crypto');
const { getDb, getAppState, setAppState } = require('./index');
const { parseJson, getCallerUserId } = require('./_util');

function rowToCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sectors: parseJson(row.sectors, []),
    isActive: !!row.is_active,
    productCount: row.product_count ?? 0,
    brandCount: row.brand_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

// Single-pass aggregation: one scan of products + brands joined back to
// companies, no per-row correlated subqueries.
const LIST_SQL = `
  SELECT c.*,
    COALESCE(pc.cnt, 0) AS product_count,
    COALESCE(bc.cnt, 0) AS brand_count
  FROM companies c
  LEFT JOIN (
    SELECT company_id, COUNT(*) AS cnt FROM products GROUP BY company_id
  ) pc ON pc.company_id = c.id
  LEFT JOIN (
    SELECT company_id, COUNT(*) AS cnt FROM brands GROUP BY company_id
  ) bc ON bc.company_id = c.id
  ORDER BY c.created_at ASC
`;

const GET_SQL = `
  SELECT c.*,
    COALESCE(pc.cnt, 0) AS product_count,
    COALESCE(bc.cnt, 0) AS brand_count
  FROM companies c
  LEFT JOIN (
    SELECT COUNT(*) AS cnt FROM products WHERE company_id = ?
  ) pc
  LEFT JOIN (
    SELECT COUNT(*) AS cnt FROM brands   WHERE company_id = ?
  ) bc
  WHERE c.id = ?
`;

function list() {
  return getDb().prepare(LIST_SQL).all().map(rowToCompany);
}

function get(id) {
  if (!id) return null;
  const row = getDb().prepare(GET_SQL).get(id, id, id);
  return rowToCompany(row);
}

function getByName(name) {
  const row = getDb()
    .prepare(`SELECT * FROM companies WHERE LOWER(name) = LOWER(?)`)
    .get(name);
  return rowToCompany(row);
}

function create({ name, color, sectors, isActive = true }) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('Company name is required');
  if (getByName(trimmed)) throw new Error(`Company "${trimmed}" already exists`);

  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO companies (id, name, color, sectors, is_active, created_at, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      trimmed,
      color ?? null,
      JSON.stringify(sectors ?? []),
      isActive ? 1 : 0,
      ts,
      ts,
      getCallerUserId(),
    );

  // First company auto-selects as active in app_state.
  if (!getAppState('active_company_id')) {
    setAppState('active_company_id', id);
  }
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('Company not found');

  if (patch.name && patch.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
    const clash = getByName(patch.name);
    if (clash) throw new Error(`Company "${patch.name}" already exists`);
  }

  const sets = [];
  const params = { id, updatedAt: Date.now() };
  if ('name' in patch && patch.name?.trim()) {
    sets.push('name = @name'); params.name = patch.name.trim();
  }
  if ('color' in patch)   { sets.push('color = @color');   params.color = patch.color ?? null; }
  if ('sectors' in patch) { sets.push('sectors = @sectors'); params.sectors = JSON.stringify(patch.sectors ?? []); }
  if ('isActive' in patch) { sets.push('is_active = @isActive'); params.isActive = patch.isActive ? 1 : 0; }
  sets.push('updated_at = @updatedAt');
  sets.push('updated_by_user_id = @updatedByUserId');
  params.updatedByUserId = getCallerUserId();

  getDb().prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

function remove(id) {
  const all = list();
  const result = getDb().prepare(`DELETE FROM companies WHERE id = ?`).run(id);
  // If the removed company was active, fall back to another one (or clear).
  if (getAppState('active_company_id') === id) {
    const next = all.find((c) => c.id !== id);
    setAppState('active_company_id', next ? next.id : null);
  }
  return result.changes > 0;
}

/**
 * v0.15.2: caller-scoped active company.
 *
 * - Local renderer (server admin or standalone) → no caller user-id
 *   in flight → falls back to app_state.active_company_id (shared).
 * - RPC caller (a connected client) → server.getCurrentUserId()
 *   returns their user.id → we use users.active_company_id if set,
 *   otherwise fall back to app_state (shared default).
 *
 * The fallback chain keeps brand-new clients (who haven't switched
 * yet) seeing the same company as the server, which matches everyone's
 * expectation of "the catalog I was looking at last".
 *
 * The require() for server + users is deferred to runtime so this
 * module loads cleanly during standalone boot (where server/index.js
 * never gets imported).
 */
function getActiveId() {
  try {
    const { getCurrentUserId } = require('../server');
    const uid = getCurrentUserId?.();
    if (uid) {
      const users = require('./users');
      const u = users.get(uid);
      if (u?.activeCompanyId) return u.activeCompanyId;
    }
  } catch (_) { /* server not loaded → standalone mode */ }
  return getAppState('active_company_id');
}

function setActive(id) {
  // Validate the company exists when given one. NULL = "clear active".
  if (id != null) {
    const existing = get(id);
    if (!existing) throw new Error('Company not found');
  }
  // Caller-aware write: RPC clients flip their own row; the local
  // admin / standalone path still updates the shared default.
  try {
    const { getCurrentUserId } = require('../server');
    const uid = getCurrentUserId?.();
    if (uid) {
      const users = require('./users');
      users.setActiveCompany(uid, id ?? null);
      return id == null ? null : get(id);
    }
  } catch (_) { /* fall through to shared default */ }
  setAppState('active_company_id', id ?? null);
  return id == null ? null : get(id);
}

module.exports = { list, get, getByName, create, update, remove, getActiveId, setActive };
