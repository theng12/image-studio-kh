/**
 * v0.49.51 — custom roles.
 *
 * A role is a slug `key` + display `name` + a set of capability keys
 * (see main/util/capabilities.js). The 4 built-ins are seeded on init to
 * reproduce the pre-v0.49.51 hardcoded behaviour exactly, so existing
 * users are unaffected. Admin is a locked superuser (`is_system`, perms
 * `['*']`) — it can't be edited or deleted, which guarantees you can
 * never lock yourself out.
 *
 * permissions.js consults getCapabilityKeys(roleKey) on every gated RPC,
 * so we keep a tiny in-memory cache keyed by role, invalidated whenever a
 * role is written.
 */

const crypto = require('node:crypto');
const { getDb } = require('./index');
const { CAPABILITIES, CAPABILITY_KEYS } = require('../util/capabilities');

// The seeded presets. Caps chosen to match the old isAllowed() logic:
//   admin        → everything (sentinel '*'), locked
//   editor       → everything except user/role + system management
//   photographer → add photos only
//   viewer       → browse only (baseline reads; no caps)
const ALL_NON_ADMIN_CAPS = CAPABILITIES
  .map((c) => c.key)
  .filter((k) => k !== 'users.manage' && k !== 'system.manage');

const BUILTIN_ROLES = [
  { key: 'admin',        name: 'Admin',        description: 'Full access to everything. Cannot be edited or deleted.', permissions: ['*'],              isSystem: true,  sort: 0 },
  { key: 'editor',       name: 'Editor',       description: 'Full catalog, production and operations access. No user/role or system settings.', permissions: ALL_NON_ADMIN_CAPS, isSystem: false, sort: 1 },
  { key: 'photographer', name: 'Photographer', description: 'Can browse the catalog and add/import images. No editing, deleting, or operations.', permissions: ['images.add'], isSystem: false, sort: 2 },
  { key: 'viewer',       name: 'Viewer',       description: 'Read-only. Can browse the catalog but make no changes.', permissions: [], isSystem: false, sort: 3 },
];

/* ─── cache ─────────────────────────────────────────────────────── */

let _capCache = null; // Map<roleKey, Set<capKey>>

function invalidateCache() { _capCache = null; }

function loadCache() {
  if (_capCache) return _capCache;
  const m = new Map();
  try {
    for (const row of getDb().prepare(`SELECT key, permissions FROM roles`).all()) {
      m.set(row.key, expandPermissions(parsePerms(row.permissions)));
    }
  } catch {
    // roles table not ready yet (very early boot) — leave cache empty;
    // permissions.js falls back to legacy logic for known role keys.
  }
  _capCache = m;
  return m;
}

function parsePerms(json) {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Expand ['*'] to the full capability set; otherwise filter to known caps.
function expandPermissions(perms) {
  if (perms.includes('*')) return new Set(['*', ...CAPABILITY_KEYS]);
  return new Set(perms.filter((p) => CAPABILITY_KEYS.has(p)));
}

/**
 * The capability set for a role key. Returns a Set (possibly empty).
 * Unknown role → null (caller decides; permissions.js denies).
 */
function getCapabilityKeys(roleKey) {
  const cache = loadCache();
  return cache.has(roleKey) ? cache.get(roleKey) : null;
}

function isSystemRole(roleKey) {
  const r = get(roleKey);
  return !!(r && r.isSystem);
}

/* ─── seeding ───────────────────────────────────────────────────── */

/**
 * Insert any missing built-in roles. Idempotent + non-destructive: if the
 * user has edited a preset's permissions we keep their version (INSERT
 * OR IGNORE on the primary key). Always (re)asserts admin's locked, all-
 * access state so it can't be weakened by a stale row.
 */
function ensureBuiltinRoles() {
  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO roles (key, name, description, permissions, is_system, is_builtin, sort, created_at, updated_at)
    VALUES (@key, @name, @description, @permissions, @isSystem, 1, @sort, @now, @now)
  `);
  const tx = db.transaction(() => {
    for (const r of BUILTIN_ROLES) {
      insert.run({
        key: r.key, name: r.name, description: r.description,
        permissions: JSON.stringify(r.permissions),
        isSystem: r.isSystem ? 1 : 0, sort: r.sort, now,
      });
    }
    // Belt-and-braces: admin must always be locked + all-access.
    db.prepare(`UPDATE roles SET permissions = '["*"]', is_system = 1, is_builtin = 1 WHERE key = 'admin'`).run();
  });
  tx();
  invalidateCache();
}

/* ─── mappers + CRUD ────────────────────────────────────────────── */

function rowToRole(row) {
  if (!row) return null;
  return {
    key:         row.key,
    name:        row.name,
    description: row.description,
    permissions: parsePerms(row.permissions),
    isSystem:    !!row.is_system,
    isBuiltin:   !!row.is_builtin,
    sort:        row.sort,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

function list() {
  return getDb().prepare(`SELECT * FROM roles ORDER BY sort ASC, name ASC`).all().map(rowToRole);
}

function get(key) {
  if (!key) return null;
  return rowToRole(getDb().prepare(`SELECT * FROM roles WHERE key = ?`).get(key));
}

function slugify(name) {
  const base = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || `role-${crypto.randomBytes(3).toString('hex')}`;
}

function sanitizePermissions(perms) {
  if (!Array.isArray(perms)) return [];
  // Custom roles can never grant '*' (only the seeded admin has it).
  return perms.filter((p) => CAPABILITY_KEYS.has(p));
}

function create(input) {
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('Role name is required');
  const db = getDb();
  // Unique key from the name.
  let key = slugify(name);
  if (get(key)) {
    let i = 2;
    while (get(`${key}-${i}`)) i += 1;
    key = `${key}-${i}`;
  }
  const now = Date.now();
  const maxSort = db.prepare(`SELECT COALESCE(MAX(sort), 0) AS m FROM roles`).get().m;
  db.prepare(`
    INSERT INTO roles (key, name, description, permissions, is_system, is_builtin, sort, created_at, updated_at)
    VALUES (@key, @name, @description, @permissions, 0, 0, @sort, @now, @now)
  `).run({
    key, name,
    description: input.description?.trim() || null,
    permissions: JSON.stringify(sanitizePermissions(input.permissions)),
    sort: maxSort + 1, now,
  });
  invalidateCache();
  return get(key);
}

function update(key, patch) {
  const existing = get(key);
  if (!existing) throw new Error('Role not found');
  if (existing.isSystem) throw new Error('The Admin role cannot be edited — it always has full access.');

  const sets = [];
  const params = { key, updatedAt: Date.now() };
  if ('name' in (patch ?? {})) {
    const n = String(patch.name || '').trim();
    if (!n) throw new Error('Role name cannot be empty');
    sets.push(`name = @name`); params.name = n;
  }
  if ('description' in (patch ?? {})) {
    sets.push(`description = @description`); params.description = patch.description?.trim() || null;
  }
  if ('permissions' in (patch ?? {})) {
    sets.push(`permissions = @permissions`);
    params.permissions = JSON.stringify(sanitizePermissions(patch.permissions));
  }
  if (sets.length === 0) return existing;
  sets.push(`updated_at = @updatedAt`);
  getDb().prepare(`UPDATE roles SET ${sets.join(', ')} WHERE key = @key`).run(params);
  invalidateCache();
  return get(key);
}

function remove(key) {
  const existing = get(key);
  if (!existing) return { deleted: 0 };
  if (existing.isSystem) throw new Error('The Admin role cannot be deleted.');
  if (existing.isBuiltin) throw new Error('Built-in roles (Editor / Photographer / Viewer) can be edited but not deleted.');
  const inUse = getDb().prepare(`SELECT COUNT(*) AS c FROM users WHERE role = ?`).get(key).c;
  if (inUse > 0) throw new Error(`This role is assigned to ${inUse} user${inUse === 1 ? '' : 's'}. Reassign them before deleting it.`);
  getDb().prepare(`DELETE FROM roles WHERE key = ?`).run(key);
  invalidateCache();
  return { deleted: 1 };
}

module.exports = {
  ensureBuiltinRoles,
  list, get, create, update, remove,
  getCapabilityKeys, isSystemRole, invalidateCache,
  BUILTIN_ROLES,
};
