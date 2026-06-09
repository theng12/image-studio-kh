/**
 * v0.49.51 — capability taxonomy for custom roles.
 *
 * Before this, the 4 roles (admin/editor/photographer/viewer) had their
 * permissions hardcoded in permissions.js. Custom roles need a stable,
 * user-facing set of *capabilities* to tick — not raw IPC channels (there
 * are ~150, and a single user action touches several). So we define ~12
 * plain-English capabilities and map every write channel to one of them.
 *
 * Three tiers of channel:
 *   1. BASELINE  — always allowed for any authenticated user. The app
 *      can't function without these (boot, browse the catalog, see who's
 *      online). Not shown in the role matrix; you can't turn them off.
 *   2. capability — gated. The channel maps to ONE capability key; a role
 *      may invoke it iff the role's permission set contains that key.
 *   3. unmapped   — a channel no rule matches. permissions.js falls back
 *      to the legacy role logic so a newly-added channel never silently
 *      breaks an existing role. (A test asserts the core channels are all
 *      mapped, so this fallback is a safety net, not the happy path.)
 *
 * Adding a feature later: add its write channel(s) to CHANNEL_RULES under
 * the right capability. Adding a whole new capability: add it to
 * CAPABILITIES + give the built-in presets the key in roles seeding.
 */

/**
 * The capabilities a role can be granted, in display order. `group` lets
 * the matrix UI cluster related toggles. Order here = order in the UI.
 */
const CAPABILITIES = [
  { key: 'products.edit',    group: 'Catalog',     label: 'Add / edit products',          description: 'Create and edit products, bulk-edit, import from Excel/CSV.' },
  { key: 'products.delete',  group: 'Catalog',     label: 'Delete products & images',      description: 'Remove products and delete individual images. Destructive.' },
  { key: 'images.add',       group: 'Catalog',     label: 'Add / import images',           description: 'Import and attach photos to products (the photographer’s job).' },
  { key: 'images.manage',    group: 'Catalog',     label: 'Edit images',                   description: 'Set-as-main, reorder, crop, reframe, enhance, background-removal, auto-match.' },
  { key: 'catalog.meta',     group: 'Catalog',     label: 'Manage brands & categories',    description: 'Create, edit and remove brands and categories.' },
  { key: 'ai.run',           group: 'Production',  label: 'Run AI generation',             description: 'Queue AI image jobs in AI Studio, single and bulk.' },
  { key: 'overlay.use',      group: 'Production',  label: 'Use Overlay Studio',            description: 'Apply overlay templates to product images.' },
  { key: 'export.run',       group: 'Production',  label: 'Run exports',                   description: 'Run the Export Center and export catalog feeds.' },
  { key: 'costing.view',     group: 'Operations',  label: 'View costs, suppliers & POs',   description: 'See the OPERATIONS section: suppliers, purchase orders, landed cost.' },
  { key: 'costing.manage',   group: 'Operations',  label: 'Manage suppliers, POs & payments', description: 'Create/edit suppliers and purchase orders, record TT payments.' },
  { key: 'history.view',     group: 'System',      label: 'View edit history',             description: 'See the audit log of who changed what.' },
  { key: 'users.manage',     group: 'System',      label: 'Manage users & roles',          description: 'Add/remove users, assign roles, and edit roles on this screen.' },
  { key: 'system.manage',    group: 'System',      label: 'System & data settings',        description: 'Server mode, data folder, backups, app preferences, relaunch. Powerful.' },
];

const CAPABILITY_KEYS = new Set(CAPABILITIES.map((c) => c.key));

/**
 * Channels every authenticated user may call. Boot + browse + presence.
 * Deliberately NOT including the OPERATIONS reads or the audit reads —
 * those are gated under costing.view / history.view so cost data can be
 * hidden from a photographer.
 */
const BASELINE_READS = new Set([
  // app shell
  'app:getVersion', 'app:getVersionInfo', 'app:getPlatform', 'app:getCacheInfo',
  'app:openDataFolder', 'app:openLogsFolder', 'app:openExternal', 'app:readCrashLog',
  // companies (setActive is per-user view state, not a catalog write)
  'companies:list', 'companies:get', 'companies:getActiveId', 'companies:setActive',
  // catalog reads — the minimum "browse" surface
  'products:list', 'products:get',
  'brands:list', 'brands:get',
  'categories:list',
  'images:listByProduct',
  // dashboard
  'dashboard:stats', 'dashboard:completeness', 'dashboard:recentBrands', 'dashboard:recentProducts',
  // identity / presence / attribution
  'users:list', 'users:listForAttribution', 'users:presence', 'users:whoami',
  // roles — needed so the renderer can resolve role names + the current
  // user's capabilities; listing roles leaks no data.
  'roles:list', 'roles:get', 'roles:capabilities',
  // search
  'search:global',
  // diagnostics (read-only)
  'server:status', 'server:addresses', 'client:diagnoseServer', 'client:testConnection',
  // settings bootstrap
  'settings:getAll',
]);

/**
 * Ordered channel → capability rules. First match wins. Each rule is a
 * RegExp tested against the full channel name. Putting the destructive /
 * narrower rules first lets broad domain rules act as a catch-all.
 *
 * Using regex rules (not a flat per-channel map) means future channels in
 * a domain are covered automatically — e.g. a new `images:whatever` write
 * still resolves to images.manage without me touching this file.
 */
const CHANNEL_RULES = [
  // — Products
  [/^products:(remove|bulkRemove)$/,                    'products.delete'],
  [/^products:(create|update|bulkUpdate|bulkUpsert|duplicate)$/, 'products.edit'],
  // CSV import + sample sheet feed product create/update.
  [/^files:(pickWorkbook|parseWorkbook)$/,             'products.edit'],
  [/^samples:/,                                         'products.edit'],

  // — Images. Deleting image content is a "delete" capability; importing
  //   new photos is images.add (the photographer's job); everything else
  //   (set-main, reorder, crop, enhance, auto-match) is images.manage.
  [/^images:removeFromProduct$/,                        'products.delete'],
  [/^images:(importFromBytes|importForProduct)$/,       'images.add'],
  [/^files:(pickImageFile|pickFolder|readImageThumb)$/, 'images.add'],
  [/^images:/,                                          'images.manage'],
  [/^workspace:/,                                       'images.manage'],
  [/^watermarks:/,                                      'images.manage'],

  // — Catalog metadata
  [/^brands:(create|update|remove|uploadIcon)$/,        'catalog.meta'],
  [/^categories:(create|update|remove)$/,               'catalog.meta'],

  // — AI
  [/^ai:/,                                              'ai.run'],

  // — Overlay Studio
  [/^templates:/,                                       'overlay.use'],

  // — Exports
  [/^exports:/,                                         'export.run'],

  // — Operations: reads vs writes
  [/^suppliers:(list|get)$/,                            'costing.view'],
  [/^pos:(list|get|getDetail|listForSupplier|listForProduct|getProductCost|listProductCosts|supplierSpendRollup|listPayments)$/, 'costing.view'],
  [/^costing:/,                                         'costing.view'],
  [/^suppliers:/,                                       'costing.manage'],
  [/^pos:/,                                             'costing.manage'],

  // — History (audit). clearHistory is destructive → system.
  [/^audit:clearHistory$/,                              'system.manage'],
  [/^audit:/,                                           'history.view'],

  // — Users & roles
  [/^users:(create|update|remove|regenerateToken|ensureOwner)$/, 'users.manage'],
  [/^roles:(create|update|remove)$/,                    'users.manage'],

  // — System / data / structural
  [/^server:(start|stop)$/,                             'system.manage'],
  [/^settings:(setMode|changeDataFolder|pickAndSetDataFolder|trashFolder)$/, 'system.manage'],
  [/^settings:(setOne|setMany)$/,                       'system.manage'],
  [/^servers:/,                                         'system.manage'],
  [/^backups:/,                                         'system.manage'],
  [/^companies:(create|update|remove)$/,                'system.manage'],
  [/^app:(relaunch|clearCache)$/,                       'system.manage'],
];

/**
 * Resolve a channel to one of:
 *   'baseline'      — always allowed
 *   <capability>    — requires that capability
 *   null            — unmapped (caller falls back to legacy logic)
 */
function channelCapability(channel) {
  if (BASELINE_READS.has(channel)) return 'baseline';
  for (const [re, cap] of CHANNEL_RULES) {
    if (re.test(channel)) return cap;
  }
  return null;
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_KEYS,
  BASELINE_READS,
  CHANNEL_RULES,
  channelCapability,
};
