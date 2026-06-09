/**
 * Role-based permissions.
 *
 * v0.45.0 introduced 4 hardcoded roles (admin/editor/photographer/viewer)
 * with fixed channel lists. v0.49.51 makes roles user-defined: a role is a
 * set of *capabilities* (see ./capabilities.js), and each gated channel
 * maps to one capability. The check resolves the role's capability set
 * from the `roles` table and tests membership.
 *
 * Safety:
 *   - **Admin is a locked superuser** (capabilities include the '*'
 *     sentinel) — always allowed, can't be edited/deleted. No lockout.
 *   - **Baseline reads** (boot + browse + presence) are allowed for every
 *     authenticated user, so any role's app starts without 403s.
 *   - **Unmapped channels fall back to the legacy v0.45.0 logic**, so a
 *     newly-added channel never silently breaks the built-in roles. Custom
 *     roles fail closed on unmapped channels (deny) — fail-safe.
 *   - Local IPC (the host Mac's own renderer) is NOT gated; this runs only
 *     on the RPC layer that remote desktop / iPad clients hit.
 */

const { channelCapability } = require('./capabilities');

// Lazy require — permissions.js is pulled in by the server bootstrap; the
// roles module pulls in the DB. Requiring it lazily avoids any load-order
// cycle and lets the legacy fallback work even before the roles table is
// seeded (very early boot).
function rolesDb() {
  try { return require('../db/roles'); } catch { return null; }
}

/* ─── legacy v0.45.0 sets (now the fallback for unmapped channels) ── */

const ROLES = ['admin', 'editor', 'photographer', 'viewer'];

const READ_CHANNELS = new Set([
  'app:getVersion', 'app:getVersionInfo', 'app:getPlatform', 'app:getCacheInfo',
  'app:openDataFolder', 'app:openLogsFolder', 'app:openExternal', 'app:readCrashLog',
  'companies:list', 'companies:get', 'companies:getActiveId', 'companies:setActive',
  'products:list', 'products:get',
  'brands:list', 'brands:get',
  'categories:list',
  'images:listByProduct', 'images:findDuplicates', 'images:listMergeOps',
  'images:quarantineInfo',
  'dashboard:stats', 'dashboard:completeness', 'dashboard:recentBrands', 'dashboard:recentProducts',
  'users:list', 'users:listForAttribution', 'users:presence',
  'search:global',
  'server:status', 'server:addresses', 'client:diagnoseServer', 'client:testConnection',
  'settings:getAll',
  'audit:listForEntity', 'audit:listRecent', 'audit:countForEntity', 'audit:countRecent', 'audit:historyStats',
  'ai:listTasks', 'ai:listModels', 'ai:listPrompts', 'ai:listGallery', 'ai:listBulkGallery',
  'ai:getCredits', 'ai:estimateCost',
  'templates:list', 'templates:get', 'templates:listRuns',
  'exports:listProfiles', 'exports:getProfile', 'exports:listRuns',
  'suppliers:list', 'suppliers:get',
  'pos:list', 'pos:get', 'pos:getDetail',
  'pos:listForSupplier', 'pos:listForProduct', 'pos:getProductCost',
  'pos:listProductCosts', 'pos:supplierSpendRollup',
  'pos:listPayments',
  'costing:suggestedRetail', 'costing:realizedMargin', 'costing:containerFillPct',
  // v0.49.51: roles reads needed for the management UI + whoami caps.
  'roles:list', 'roles:get', 'roles:capabilities',
  'users:whoami',
]);

const PHOTOGRAPHER_EXTRA = new Set([
  'images:importFromBytes',
  'images:importForProduct',
  'files:pickImageFile',
  'files:pickFolder',
  'files:readImageThumb',
]);

const ADMIN_ONLY_CHANNELS = new Set([
  'users:create', 'users:update', 'users:remove', 'users:regenerateToken', 'users:ensureOwner',
  'roles:create', 'roles:update', 'roles:remove',
  'server:start', 'server:stop',
  'settings:setMode', 'settings:changeDataFolder', 'settings:pickAndSetDataFolder', 'settings:trashFolder',
  'servers:applyImportedDataDir', 'servers:exportBundle', 'servers:importBundle', 'servers:previewBundle',
  'audit:clearHistory',
  'app:relaunch', 'app:clearCache',
]);

/** The pre-v0.49.51 logic, used as a fallback for unmapped channels and
 *  for known role keys when the roles table isn't available yet. */
function legacyIsAllowed(role, channel) {
  if (!ROLES.includes(role)) return false;
  if (role === 'admin') return true;
  if (ADMIN_ONLY_CHANNELS.has(channel)) return false;
  if (role === 'editor') return true;
  if (READ_CHANNELS.has(channel)) return true;
  if (role === 'photographer' && PHOTOGRAPHER_EXTRA.has(channel)) return true;
  return false;
}

/* ─── the capability-driven check ───────────────────────────────── */

/**
 * Pure capability check. `caps` is a Set of capability keys (possibly
 * containing the '*' sentinel), or null when the role is unknown / the
 * roles table isn't loaded yet.
 * Returns:
 *   true  — allowed (admin '*', a baseline read, or the role has the cap)
 *   false — a gated channel the role's caps don't cover
 *   null  — defer to the legacy fallback. Happens when the role is unknown
 *           (caps null) OR the channel maps to no capability.
 * Exported so the capability logic is unit-testable without a DB.
 */
function allowedByCaps(caps, channel) {
  if (!caps) return null;            // unknown role → legacy decides everything
  if (caps.has('*')) return true;    // admin superuser
  const cap = channelCapability(channel);
  if (cap === 'baseline') return true;
  if (cap) return caps.has(cap);     // gated → authoritative for a known role
  return null;                       // unmapped channel → legacy fallback
}

/**
 * Returns true if `role` (a role KEY) may invoke `channel`.
 */
function isAllowed(role, channel) {
  const rdb = rolesDb();
  const caps = rdb ? rdb.getCapabilityKeys(role) : null; // Set | null
  const verdict = allowedByCaps(caps, channel);
  if (verdict !== null) return verdict;
  // Unknown role, or a channel no capability covers → legacy v0.45.0 logic.
  // Built-in roles keep their old behaviour; unknown/custom roles fail
  // closed (legacy denies anything not one of the 4 known keys).
  return legacyIsAllowed(role, channel);
}

/**
 * The capability list for a role key, as a plain array (for whoami /
 * the renderer). Admin returns ['*']. Unknown role → [].
 */
function capsForRole(role) {
  const rdb = rolesDb();
  const set = rdb ? rdb.getCapabilityKeys(role) : null;
  if (!set) return [];
  if (set.has('*')) return ['*'];
  return Array.from(set);
}

module.exports = {
  ROLES,
  READ_CHANNELS,
  PHOTOGRAPHER_EXTRA,
  ADMIN_ONLY_CHANNELS,
  isAllowed,
  allowedByCaps,
  legacyIsAllowed,
  capsForRole,
};
