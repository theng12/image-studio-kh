/**
 * Role-based permissions (v0.45.0).
 *
 * Before this release the role field on a user was a label — it was stored
 * and shown in the UI, but no IPC channel ever checked it. Adding Viewer and
 * Photographer roles forced building real enforcement: a single ACL the
 * server consults on every /api/rpc call, before invoking the handler.
 *
 * Design notes:
 *   - **Fail-safe for restricted roles.** If I add a new channel and forget
 *     to list it here, photographer and viewer get DENY (correct — better to
 *     surface a "channel not whitelisted" UX bug than to leak write access).
 *     Editor falls through to "allowed for anything not admin-only" because
 *     editor is by definition trusted; one missed entry there is mild.
 *   - **`companies:setActive` is a READ.** It writes per-user state (which
 *     company *I'm* viewing) — it does not modify the catalog. Viewer can
 *     switch companies just like everyone else.
 *   - **Previews go through writers, NOT reads.** `images:reframePreview` /
 *     `images:autoEnhancePreview` produce no disk changes, but they're only
 *     ever invoked by the editor-only modals; gating them as reads would
 *     expand attack surface for no UX benefit.
 *   - Local IPC (the host Mac's renderer talking to its own main process) is
 *     intentionally NOT gated. The host is always the implicit owner — this
 *     check runs only on the RPC layer that remote desktop clients + the
 *     iPad web viewer hit.
 */

const ROLES = ['admin', 'editor', 'photographer', 'viewer'];

// Reads — allowed for every authenticated user. Includes the channels the
// renderer / webclient need on boot (settings:getAll, whoami implicit) so a
// viewer's app can start without 403s, plus everything obviously read-only.
const READ_CHANNELS = new Set([
  // app shell
  'app:getVersion', 'app:getVersionInfo', 'app:getPlatform', 'app:getCacheInfo',
  'app:openDataFolder', 'app:openLogsFolder', 'app:openExternal', 'app:readCrashLog',
  // multi-tenant: companies (setActive is per-user state)
  'companies:list', 'companies:get', 'companies:getActiveId', 'companies:setActive',
  // catalog reads
  'products:list', 'products:get',
  'brands:list', 'brands:get',
  'categories:list',
  'images:listByProduct', 'images:findDuplicates', 'images:listMergeOps',
  'images:quarantineInfo',
  // dashboard reads
  'dashboard:stats', 'dashboard:completeness', 'dashboard:recentBrands', 'dashboard:recentProducts',
  // users — needed for attribution + presence chip
  'users:list', 'users:listForAttribution', 'users:presence',
  // search
  'search:global',
  // server + client diagnostics (read-only)
  'server:status', 'server:addresses', 'client:diagnoseServer', 'client:testConnection',
  // settings READ (store bootstrap calls this)
  'settings:getAll',
  // audit history (read)
  'audit:listForEntity', 'audit:listRecent', 'audit:countForEntity', 'audit:countRecent', 'audit:historyStats',
  // AI / templates / exports — listing only, no actions. Viewer doesn't usually
  // navigate here, but if they do, the views render without erroring.
  'ai:listTasks', 'ai:listModels', 'ai:listPrompts', 'ai:listGallery', 'ai:listBulkGallery',
  'ai:getCredits', 'ai:estimateCost',
  'templates:list', 'templates:get', 'templates:listRuns',
  'exports:listProfiles', 'exports:getProfile', 'exports:listRuns',
  // v0.49.46: OPERATIONS reads. Photographer / viewer don't see the
  // OPERATIONS sidebar entries (the renderer hides them), so these
  // never get called from those roles in practice — but allowing
  // the reads avoids 403s if a stray code path still calls them
  // (e.g. a cost field shown on a product page). Writes stay
  // editor-or-admin via the fall-through below.
  'suppliers:list', 'suppliers:get',
  // v0.49.47: PO + product-cost reads. Same logic — the UI hides the
  // OPERATIONS section for non-editors, but a stray Library Cost column
  // call from a viewer shouldn't 403.
  'pos:list', 'pos:get', 'pos:getDetail',
  'pos:listForSupplier', 'pos:listForProduct', 'pos:getProductCost',
  'pos:listProductCosts', 'pos:supplierSpendRollup',
  // Pure math — no DB access, no side effects, safe for every role.
  'costing:suggestedRetail', 'costing:realizedMargin', 'costing:containerFillPct',
]);

// Photographer can additionally ADD photos and use the basic file pickers
// that import flows depend on. Cannot delete, edit fields, reorder, run AI,
// run bulk ops, or export.
const PHOTOGRAPHER_EXTRA = new Set([
  'images:importFromBytes',
  'images:importForProduct',
  'files:pickImageFile',
  'files:pickFolder',
  'files:readImageThumb',
]);

// Admin-only — user management + system / destructive config.
const ADMIN_ONLY_CHANNELS = new Set([
  // user management
  'users:create', 'users:update', 'users:remove', 'users:regenerateToken', 'users:ensureOwner',
  // server lifecycle + data-folder relocation
  'server:start', 'server:stop',
  'settings:setMode', 'settings:changeDataFolder', 'settings:pickAndSetDataFolder', 'settings:trashFolder',
  'servers:applyImportedDataDir', 'servers:exportBundle', 'servers:importBundle', 'servers:previewBundle',
  // destructive system actions
  'audit:clearHistory',
  'app:relaunch', 'app:clearCache',
]);

/**
 * The single check. Returns true if `role` may invoke `channel`.
 * Unknown roles → deny. Unknown channels → see header rules.
 */
function isAllowed(role, channel) {
  if (!ROLES.includes(role)) return false;
  if (role === 'admin') return true;
  if (ADMIN_ONLY_CHANNELS.has(channel)) return false;
  if (role === 'editor') return true; // editor = anything not admin-only
  if (READ_CHANNELS.has(channel)) return true;
  if (role === 'photographer' && PHOTOGRAPHER_EXTRA.has(channel)) return true;
  return false;
}

module.exports = {
  ROLES,
  READ_CHANNELS,
  PHOTOGRAPHER_EXTRA,
  ADMIN_ONLY_CHANNELS,
  isAllowed,
};
