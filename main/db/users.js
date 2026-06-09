/**
 * Server-mode users (v0.14.0). Each user has a unique token clients
 * send in `Authorization: Bearer <token>`. Server uses the token to
 * look up the user, attribute writes, and check role-based permissions.
 *
 * Only relevant in `mode='server'`; in standalone mode the table just
 * sits empty.
 */

const crypto = require('node:crypto');
const { getDb } = require('./index');

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    role: row.role,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    // v0.15.2: per-user active company. May be NULL if the user hasn't
    // switched explicitly (in which case the renderer falls back to
    // the server's app_state.activeCompanyId, the shared default).
    activeCompanyId: row.active_company_id ?? null,
  };
}

/**
 * Generate a token that's safe to share over the LAN. 32 bytes of
 * randomness → 64 hex chars. Long enough that brute-forcing isn't
 * realistic; short enough to paste once.
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function list() {
  return getDb()
    .prepare(`SELECT * FROM users ORDER BY created_at ASC`)
    .all()
    .map(rowToUser);
}

function get(id) {
  return rowToUser(getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id));
}

function getByToken(token) {
  if (!token) return null;
  return rowToUser(getDb().prepare(`SELECT * FROM users WHERE token = ?`).get(token));
}

function getByName(name) {
  if (!name) return null;
  return rowToUser(
    getDb()
      .prepare(`SELECT * FROM users WHERE LOWER(name) = LOWER(?)`)
      .get(name.trim()),
  );
}

/**
 * Create a user. Name must be non-empty and unique (case-insensitive).
 * Role defaults to 'editor'. Token is auto-generated.
 * Returns the new user including the freshly-minted token — caller is
 * responsible for showing it to the admin once for copy/paste; it's
 * also stored in the DB for the lifetime of the user record so server
 * lookups by token continue working.
 */
function create({ name, role = 'editor' }) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('User name is required');
  // v0.49.51: role is a key into the `roles` table (built-in OR custom).
  // Validate against existing roles so a typo can't create an orphaned
  // user. The server-side ACL (permissions.js) resolves the role's caps.
  if (!require('./roles').get(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  if (getByName(trimmed)) {
    throw new Error(`User "${trimmed}" already exists`);
  }
  const id = crypto.randomUUID();
  const token = generateToken();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO users (id, name, token, role, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(id, trimmed, token, role, ts);
  return get(id);
}

/**
 * Rename / change role. Token is intentionally NOT mutable here —
 * regenerate via `regenerateToken(id)` if needed (separate explicit
 * action; auto-rotating would silently kick the user offline).
 */
function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('User not found');
  const sets = [];
  const params = { id };
  if ('name' in patch && patch.name?.trim()) {
    const next = patch.name.trim();
    if (next.toLowerCase() !== existing.name.toLowerCase()) {
      const clash = getByName(next);
      if (clash) throw new Error(`User "${next}" already exists`);
    }
    sets.push('name = @name');
    params.name = next;
  }
  // v0.49.51: role is any existing role key (built-in or custom).
  if ('role' in patch && require('./roles').get(patch.role)) {
    sets.push('role = @role');
    params.role = patch.role;
  }
  if (sets.length === 0) return existing;
  getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

/**
 * Generate a fresh token for an existing user. Useful if the old token
 * leaked. Old token stops working immediately on next request because
 * the server consults the DB (not an in-memory cache) on each auth check.
 */
function regenerateToken(id) {
  if (!get(id)) throw new Error('User not found');
  const token = generateToken();
  getDb().prepare(`UPDATE users SET token = ? WHERE id = ?`).run(token, id);
  return get(id);
}

/**
 * v0.15.2: set the user's active company. Pass `null` to clear (which
 * makes the renderer fall back to the server-wide app_state value).
 * Returns the updated user row.
 */
function setActiveCompany(id, companyId) {
  if (!id) throw new Error('user id required');
  getDb()
    .prepare(`UPDATE users SET active_company_id = ? WHERE id = ?`)
    .run(companyId ?? null, id);
  return get(id);
}

function touchLastSeen(id) {
  if (!id) return;
  try {
    getDb()
      .prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  } catch (_) { /* best-effort */ }
}

function remove(id) {
  return getDb().prepare(`DELETE FROM users WHERE id = ?`).run(id).changes > 0;
}

/**
 * Bootstrap: if no users exist, create a default "Owner" with admin
 * role. Returns the owner so the caller can surface the token to the
 * admin one time. Idempotent — if any users exist, returns null.
 */
function ensureOwner() {
  const existing = list();
  if (existing.length > 0) return null;
  return create({ name: 'Owner', role: 'admin' });
}

module.exports = {
  list,
  get,
  getByToken,
  getByName,
  create,
  update,
  regenerateToken,
  touchLastSeen,
  setActiveCompany,
  remove,
  ensureOwner,
};
