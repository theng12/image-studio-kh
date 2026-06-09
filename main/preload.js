const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  app: {
    getVersion:      ()       => invoke('app:getVersion'),
    getPlatform:     ()       => invoke('app:getPlatform'),
    getVersionInfo:  ()       => invoke('app:getVersionInfo'),
    openExternal:    (url)    => invoke('app:openExternal', url),
    openDataFolder:  ()       => invoke('app:openDataFolder'),
    openLogsFolder:  ()       => invoke('app:openLogsFolder'),
    /** v0.19.0: read the tail of crash.log for beta users to share. */
    readCrashLog:    (lines)  => invoke('app:readCrashLog', { lines }),
    relaunch:        ()       => invoke('app:relaunch'),
    /** v0.26.39: cache visibility + management for Settings → AI Generation.
     *  getCacheInfo returns `{ cachePath, totalBytes, fileCount,
     *  mostRecentMtime, exists }`. clearCache wipes Electron's HTTP cache
     *  (the @imgly model is the biggest thing in there). */
    getCacheInfo:    ()       => invoke('app:getCacheInfo'),
    clearCache:      ()       => invoke('app:clearCache'),
  },
  settings: {
    getAll:                 ()                 => invoke('settings:getAll'),
    setOne:                 (key, value)       => invoke('settings:setOne', { key, value }),
    setMany:                (patch)            => invoke('settings:setMany', patch),
    pickAndSetDataFolder:   ()                 => invoke('settings:pickAndSetDataFolder'),
    changeDataFolder:       (newPath, move)    => invoke('settings:changeDataFolder', { newPath, move }),
    /** v0.21.4: move a former data folder to the OS Trash after a
     *  successful Change-folder + move. Refuses to trash the
     *  current data dir or any folder that doesn\'t look like ours. */
    trashFolder:            (path)             => invoke('settings:trashFolder', { path }),
    // v0.49.33: removed `testRemoveBg` + `bumpRemoveBgUsage`. The paid
    // bg-removal engine was dropped; only the local @imgly engine remains
    // and it doesn't need an API-key test or a per-call counter.
    /** v0.14.0: switch app mode (standalone/server/client). Triggers a relaunch. */
    setMode:                (mode)             => invoke('settings:setMode', mode),
  },
  /** v0.14.2: server status + client connection test. */
  server: {
    status:    () => invoke('server:status'),
    addresses: () => invoke('server:addresses'),
    start:     () => invoke('server:start'),
    stop:      () => invoke('server:stop'),
  },
  /** v0.26.32: server bundle export/import (data migration between Macs).
   *  Local-only — no client-mode equivalent. Bundle ops touch the running
   *  Mac's filesystem + OS file dialogs. */
  servers: {
    exportBundle:         ()                                   => invoke('servers:exportBundle'),
    previewBundle:        (bundlePath)                         => invoke('servers:previewBundle', bundlePath ? { bundlePath } : null),
    importBundle:         (bundlePath, targetDataDir)          => invoke('servers:importBundle', { bundlePath, targetDataDir }),
    applyImportedDataDir: (dataDir, relaunch = true)           => invoke('servers:applyImportedDataDir', { dataDir, relaunch }),
  },
  /** v0.49.31: local backup / restore. Local-only — no client-mode
   *  equivalent (a client has no local data folder). Restore replaces
   *  the data folder; the renderer confirms first + relaunches after. */
  backups: {
    create:     ()              => invoke('backups:create'),
    list:       ()              => invoke('backups:list'),
    last:       ()              => invoke('backups:last'),
    preview:    (backupPath)    => invoke('backups:preview', { backupPath }),
    reveal:     (backupPath)    => invoke('backups:reveal', { backupPath }),
    openFolder: ()              => invoke('backups:openFolder'),
    pickFolder: ()              => invoke('backups:pickFolder'),
    restore:    (backupPath)    => invoke('backups:restore', { backupPath }),
  },
  client: {
    testConnection:    (url, token) => invoke('client:testConnection', { url, token }),
    /** v0.26.34: step-by-step network diagnostic. Returns
     *  `{ overall: 'ok' | 'fail', steps: [{ name, label, ok, message, code? }],
     *  serverVersion?, user? }`. The renderer renders each step so the
     *  user can see exactly which layer failed (URL syntax vs server
     *  unreachable vs token rejected). */
    diagnoseServer:    (url, token) => invoke('client:diagnoseServer', { url, token }),
    /** v0.14.3: live connection-state polling + push from main. */
    connectionState:   ()            => invoke('client:connectionState'),
    onConnectionState: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('client:connectionState', fn);
      return () => ipcRenderer.removeListener('client:connectionState', fn);
    },
    /** v0.26.33: per-launch RPC activity stats. Used by the SyncOverlay
     *  (boot) + sidebar chip (steady-state) to show users that the app
     *  is alive even when the server response is slow. `syncStats()`
     *  returns a one-shot snapshot; `onRpcActivity` subscribes to a
     *  push channel that fires `{ phase: 'start' | 'end', channel,
     *  requestBytes, responseBytes, durationMs, stats }` on every RPC
     *  call. Both only meaningful in client mode — in standalone /
     *  server mode the channel isn't registered, so the IPC just
     *  resolves to undefined / never fires. */
    syncStats:    () => invoke('client:syncStats'),
    onRpcActivity: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('client:rpcActivity', fn);
      return () => ipcRenderer.removeListener('client:rpcActivity', fn);
    },
  },

  /** v0.15.1: catalog change events pushed from the server. Lets
   *  every connected client refetch when another Mac edits the
   *  shared catalog. The payload is `{ kind, op, id, ... }`; the
   *  store routes by kind. */
  events: {
    onCatalogChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('catalog:changed', fn);
      return () => ipcRenderer.removeListener('catalog:changed', fn);
    },
    /** Server says "hello, you connected" — fires once per ws session. */
    onServerHello: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('server:hello', fn);
      return () => ipcRenderer.removeListener('server:hello', fn);
    },
    /** v0.15.3: presence change — fires when any user connects or
     *  disconnects. Payload is the current `[{id,name,role,connectedAt}]`. */
    onPresenceChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('users:presence', fn);
      return () => ipcRenderer.removeListener('users:presence', fn);
    },
    /** v0.17.1: progress event for long-running bulk operations.
     *  Payload: `{ id, kind, done, total, phase, label, complete, error }`.
     *  Fired by auto-match, bulk export, bulk AI queue. Renderer
     *  shows a small overlay; when `complete: true` arrives, drops
     *  the entry from the in-flight list. */
    onProgress: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('progress:event', fn);
      return () => ipcRenderer.removeListener('progress:event', fn);
    },
  },

  /** v0.14.0: server-mode user management. Tokens are returned in plain text
   *  (single-use display in the UI). Only call from the server Mac’s settings;
   *  client Macs don’t need these. */
  users: {
    list:               ()                     => invoke('users:list'),
    create:             (name, role)           => invoke('users:create', { name, role }),
    update:             (id, patch)            => invoke('users:update', { id, patch }),
    remove:             (id)                   => invoke('users:remove', id),
    regenerateToken:    (id)                   => invoke('users:regenerateToken', id),
    ensureOwner:        ()                     => invoke('users:ensureOwner'),
    /** v0.15.3: safe subset (id + name + role only — no tokens).
     *  Available in every mode so the renderer can render "Edited 2
     *  min ago by Theng" attribution chips without leaking auth. */
    listForAttribution: ()                     => invoke('users:listForAttribution'),
    /** v0.15.3: currently-connected WebSocket clients (server only). */
    presence:           ()                     => invoke('users:presence'),
  },
  /** v0.49.51: custom roles + permission matrix. Reads are open; writes
   *  are gated to the 'Manage users & roles' capability (admin by default). */
  roles: {
    list:         ()              => invoke('roles:list'),
    get:          (key)           => invoke('roles:get', key),
    capabilities: ()              => invoke('roles:capabilities'),
    create:       (input)         => invoke('roles:create', input),
    update:       (key, patch)    => invoke('roles:update', { key, patch }),
    remove:       (key)           => invoke('roles:remove', key),
  },
  files: {
    pickFolder:    ()                          => invoke('files:pickFolder'),
    pickImageFile: (opts)                      => invoke('files:pickImageFile', opts ?? {}),
    pickWorkbook:  ()                          => invoke('files:pickWorkbook'),
    parseWorkbook: (filePath)                  => invoke('files:parseWorkbook', filePath),
    /** Returns a data: URL with a 160×160 cover thumbnail for the given
     *  absolute path. Used by AI Studio Bulk source picker (v0.11.0). */
    readImageThumb:(absPath)                   => invoke('files:readImageThumb', absPath),
  },
  samples: {
    generateProductSheet: () => invoke('samples:generateProductSheet'),
  },
  companies: {
    list:        ()              => invoke('companies:list'),
    get:         (id)            => invoke('companies:get', id),
    create:      (input)         => invoke('companies:create', input),
    update:      (id, patch)     => invoke('companies:update', { id, patch }),
    remove:      (id)            => invoke('companies:remove', id),
    getActiveId: ()              => invoke('companies:getActiveId'),
    setActive:   (id)            => invoke('companies:setActive', id),
  },
  products: {
    list:   (companyId, filters) => invoke('products:list', { companyId, filters }),
    get:    (id)                 => invoke('products:get', id),
    create: (input)              => invoke('products:create', input),
    update: (id, patch)          => invoke('products:update', { id, patch }),
    remove: (id)                 => invoke('products:remove', id),
    bulkUpsert: (companyId, rows, opts) => invoke('products:bulkUpsert', { companyId, rows, opts }),
    /** v0.18.0: duplicate a product. `includeImages` defaults true. */
    duplicate:  (id, includeImages = true)  => invoke('products:duplicate', { id, includeImages }),
    /** v0.18.1: bulk-update many products with the same patch. */
    bulkUpdate: (ids, patch)                => invoke('products:bulkUpdate', { ids, patch }),
    /** v0.22.0: bulk-remove many products at once. */
    bulkRemove: (ids)                       => invoke('products:bulkRemove', { ids }),
  },
  images: {
    listByProduct:     (productId)                          => invoke('images:listByProduct', productId),
    importForProduct:  (productId, sourcePath)              => invoke('images:importForProduct', { productId, sourcePath }),
    autoMatchBySku:    (companyId, folderPath)              => invoke('images:autoMatchBySku', { companyId, folderPath }),
    importFromBytes:   (productId, bytes, ext)              => invoke('images:importFromBytes', { productId, bytes, ext }),
    setMainImage:      (productId, filepath)                => invoke('images:setMainImage', { productId, filepath }),
    reorderImages:     (productId, newOrder)                => invoke('images:reorderImages', { productId, newOrder }),
    removeFromProduct: (productId, filepath)                => invoke('images:removeFromProduct', { productId, filepath }),
    // v0.26.14: destructive flip of the source file (rewrites
    // bytes on disk + updates content_hash so the cache-bust kicks
    // in). axis: 'h' = mirror left/right, 'v' = mirror top/bottom.
    flipSource:        (productId, filepath, axis)          => invoke('images:flipSource', { productId, filepath, axis }),
    // v0.28.0: near-duplicate detection + revertable merge.
    findDuplicates:    (companyId, thresholdPct)            => invoke('images:findDuplicates', { companyId, thresholdPct }),
    mergeDuplicates:   ({ decisions, thresholdPct, mode, companyId } = {}) => invoke('images:mergeDuplicates', { decisions, thresholdPct, mode, companyId }),
    autoMergeDuplicates: (companyId, thresholdPct)          => invoke('images:autoMergeDuplicates', { companyId, thresholdPct }),
    listMergeOps:      (companyId, limit)                   => invoke('images:listMergeOps', { companyId, limit }),
    revertMerge:       (opId)                               => invoke('images:revertMerge', { opId }),
    purgeMerge:        (opId)                               => invoke('images:purgeMerge', { opId }),
    quarantineInfo:    ()                                   => invoke('images:quarantineInfo'),
    purgeAllMerges:    ()                                   => invoke('images:purgeAllMerges'),
    // v0.29.0: per-image reframe (shrink within frame + fill margin).
    reframePreview:    (opts)                               => invoke('images:reframePreview', opts),
    reframeImage:      (opts)                               => invoke('images:reframeImage', opts),
    // v0.49.15: aspect-ratio crop. `cropImage` accepts destination:
    // 'newImage' (default — non-destructive, adds a cropped copy) or
    // 'overwrite' (destructive, writes back to the source path).
    cropPreview:       (opts)                               => invoke('images:cropPreview', opts),
    cropImage:         (opts)                               => invoke('images:cropImage', opts),
    // v0.37.0: batch auto-crop (trim + reframe every image of N products).
    autoCropProducts:  (opts)                               => invoke('images:autoCropProducts', opts),
    // v0.40.0: auto-enhance (white-balance + levels + saturation).
    autoEnhancePreview:(opts)                               => invoke('images:autoEnhancePreview', opts),
    autoEnhanceProducts:(opts)                              => invoke('images:autoEnhanceProducts', opts),
    // v0.49.28: bulk format-convert + compression. One IPC because the
    // underlying op is the same — sharp.toFormat() with knobs.
    reencodeProducts:  (opts)                               => invoke('images:reencodeProducts', opts),
    // v0.49.34: header-only metadata read (pixel dims, file size, format,
    // hash). Used by the Lightbox to show the user what they're looking
    // at without bouncing to Finder.
    getMetadata:       (productId, filepath)                => invoke('images:getMetadata', { productId, filepath }),
    // v0.49.39: multi-image copy + drag-out. v0.49.40 split the drag
    // into prepareDrag + startDragOut so client-mode drag-out works
    // (prepareDrag downloads files from the server into a temp dir;
    // startDragOut kicks off the OS-level drag from those temp paths).
    // In standalone/server mode prepareDrag is instant — it just
    // resolves relative filepaths to absolute paths under assets/.
    copyImagesToFolder:(opts)                               => invoke('images:copyImagesToFolder', opts),
    prepareDrag:       (productId, filepaths) => invoke('images:prepareDrag', { productId, filepaths }),
    startDragOut:      (preparedPaths) => {
      // ipcRenderer.send because the main side uses ipcMain.on (no
      // reply expected — startDrag synchronously blocks the OS until
      // the drag completes).
      ipcRenderer.send('images:startDragOut', { preparedPaths });
    },
    sampleImageBgColor:(productId, filepath)                => invoke('images:sampleImageBgColor', { productId, filepath }),
  },
  brands: {
    list:       (companyId)            => invoke('brands:list', companyId),
    get:        (id)                   => invoke('brands:get', id),
    create:     (input)                => invoke('brands:create', input),
    update:     (id, patch)            => invoke('brands:update', { id, patch }),
    remove:     (id)                   => invoke('brands:remove', id),
    uploadIcon: (sourcePath, name)     => invoke('brands:uploadIcon', { sourcePath, name }),
  },
  categories: {
    list:   (companyId)         => invoke('categories:list', companyId),
    create: (input)             => invoke('categories:create', input),
    update: (id, patch)         => invoke('categories:update', { id, patch }),
    remove: (id)                => invoke('categories:remove', id),
  },
  /** v0.49.46: OPERATIONS — suppliers (Phase 1). POs follow in v0.49.47. */
  suppliers: {
    list:      (companyId, filters) => invoke('suppliers:list', { companyId, filters }),
    get:       (id)                 => invoke('suppliers:get', id),
    create:    (input)              => invoke('suppliers:create', input),
    update:    (id, patch)          => invoke('suppliers:update', { id, patch }),
    archive:   (id)                 => invoke('suppliers:archive', id),
    unarchive: (id)                 => invoke('suppliers:unarchive', id),
    remove:    (id)                 => invoke('suppliers:remove', id),
  },
  /** v0.49.47: OPERATIONS — Purchase Orders + landed cost + costing helpers.
   *  PO header + lines + cost components live in a single domain. Reads,
   *  CRUD, and pure math helpers all use the `pos:` / `costing:` channels. */
  purchaseOrders: {
    // Reads
    list:             (companyId, filters)        => invoke('pos:list', { companyId, filters }),
    get:              (id)                        => invoke('pos:get', id),
    getDetail:        (id)                        => invoke('pos:getDetail', id),
    listForSupplier:  (supplierId)                => invoke('pos:listForSupplier', supplierId),
    listForProduct:   (productId)                 => invoke('pos:listForProduct', productId),
    getProductCost:   (productId)                 => invoke('pos:getProductCost', productId),
    // v0.49.48: bulk — one call for the whole Library Cost column / Suppliers spend chips.
    listProductCosts: (companyId)                 => invoke('pos:listProductCosts', companyId),
    supplierSpendRollup: (companyId)              => invoke('pos:supplierSpendRollup', companyId),
    // Header CRUD
    create:           (input)                     => invoke('pos:create', input),
    update:           (id, patch)                 => invoke('pos:update', { id, patch }),
    setStatus:        (id, status)                => invoke('pos:setStatus', { id, status }),
    remove:           (id)                        => invoke('pos:remove', id),
    // Lines
    addLine:          (poId, input)               => invoke('pos:addLine', { poId, input }),
    updateLine:       (lineId, patch)             => invoke('pos:updateLine', { lineId, patch }),
    removeLine:       (lineId)                    => invoke('pos:removeLine', lineId),
    // Cost components
    addComponent:     (poId, input)               => invoke('pos:addComponent', { poId, input }),
    updateComponent:  (componentId, patch)        => invoke('pos:updateComponent', { componentId, patch }),
    removeComponent:  (componentId)               => invoke('pos:removeComponent', componentId),
    // v0.49.50: TT / payment ledger
    listPayments:     (poId)                      => invoke('pos:listPayments', poId),
    addPayment:       (poId, input)               => invoke('pos:addPayment', { poId, input }),
    updatePayment:    (paymentId, patch)          => invoke('pos:updatePayment', { paymentId, patch }),
    removePayment:    (paymentId)                 => invoke('pos:removePayment', paymentId),
  },
  /** v0.49.47: pure-math costing helpers — suggested retail from a target
   *  margin, realized margin from a retail price, container fill %. Used
   *  by the Cost Calculator + Library Cost column. */
  costing: {
    suggestedRetail:  (landedCostUsd, targetMarginPct) => invoke('costing:suggestedRetail', { landedCostUsd, targetMarginPct }),
    realizedMargin:   (landedCostUsd, retailUsd)       => invoke('costing:realizedMargin',  { landedCostUsd, retailUsd }),
    containerFillPct: (containerType, totalVolumeCbm)  => invoke('costing:containerFillPct',{ containerType, totalVolumeCbm }),
  },
  watermarks: {
    upload:          (sourcePath)              => invoke('watermarks:upload', { sourcePath }),
    uploadFromBytes: (bytes, ext, name)        => invoke('watermarks:uploadFromBytes', { bytes, ext, name }),
  },
  workspace: {
    processImage: (productId, filepath, settings, foregroundBytes) =>
      invoke('workspace:processImage', { productId, filepath, settings, foregroundBytes }),
    saveSettings: (productId, filepath, settings) =>
      invoke('workspace:saveSettings', { productId, filepath, settings }),
  },
  exports: {
    listProfiles:    (companyId)         => invoke('exports:listProfiles', companyId),
    getProfile:      (id)                => invoke('exports:getProfile', id),
    createProfile:   (input)             => invoke('exports:createProfile', input),
    updateProfile:   (id, patch)         => invoke('exports:updateProfile', { id, patch }),
    removeProfile:   (id)                => invoke('exports:removeProfile', id),
    duplicateProfile:(id)                => invoke('exports:duplicateProfile', id),
    filenamePreview: (profileId, productId, imageIndex) =>
      invoke('exports:filenamePreview', { profileId, productId, imageIndex }),
    run: (profileId, productIds, outputRoot, onExisting, saveToLibrary) =>
      invoke('exports:run', { profileId, productIds, outputRoot, onExisting, saveToLibrary }),
    // v0.26.24: dry-run collision check. Returns
    // { totalExpected, collisionCount, sampleCollisions: [{name, sku}] }
    // The renderer calls this BEFORE run so it can pop a modal
    // asking the user how to handle the collisions.
    checkCollisions: (profileId, productIds, outputRoot) =>
      invoke('exports:checkCollisions', { profileId, productIds, outputRoot }),
    listRuns: (limit) => invoke('exports:listRuns', limit),
    // v0.36.0: catalog CSV/feed export. Returns { csv, count, filename }.
    catalogCsv: (companyId, format) => invoke('exports:catalogCsv', { companyId, format }),
  },
  /** v0.18.2: global search across products / brands / categories
   *  for the active company. Used by the Cmd+K palette. */
  search: {
    global: (query, limit = 30) => invoke('search:global', { query, limit }),
  },
  dashboard: {
    stats:          (companyId)          => invoke('dashboard:stats', companyId),
    recentBrands:   (companyId, limit)   => invoke('dashboard:recentBrands',   { companyId, limit }),
    recentProducts: (companyId, limit)   => invoke('dashboard:recentProducts', { companyId, limit }),
    completeness:   (companyId)          => invoke('dashboard:completeness', companyId),
  },
  /** v0.22.6: per-entity edit history feed. The side-panel History
   *  modal calls listForEntity(); listForEntity for entityType='product'
   *  also interleaves image events from this product. */
  audit: {
    listForEntity:  (entityType, entityId, limit) =>
      invoke('audit:listForEntity', { entityType, entityId, limit }),
    countForEntity: (entityType, entityId) =>
      invoke('audit:countForEntity', { entityType, entityId }),
    // v0.26.31: global feed across all entities + all users for the
    // History sidebar page. opts: { limit, offset, entityType?, userId? }
    // — all optional; empty call returns the most recent 100.
    listRecent:  (opts) => invoke('audit:listRecent',  opts ?? {}),
    countRecent: (opts) => invoke('audit:countRecent', opts ?? {}),
    // v0.33.0: history retention. stats() → { total, oldest, newest };
    // clearHistory(days) deletes rows older than `days` (0/undefined = all).
    historyStats: () => invoke('audit:historyStats'),
    clearHistory: (days) => invoke('audit:clearHistory', { days }),
  },
  templates: {
    /* Overlay Studio — global templates that composite text/barcode/image
       elements onto product photos. Phase 1: CRUD + single-image render
       probe. The batch runner ships in Phase 3. */
    list:      (opts)             => invoke('templates:list', opts ?? {}),
    get:       (id)               => invoke('templates:get', id),
    create:    (input)            => invoke('templates:create', input),
    update:    (id, patch)        => invoke('templates:update', { id, patch }),
    remove:    (id)               => invoke('templates:remove', id),
    duplicate: (id)               => invoke('templates:duplicate', id),
    renderPreview: ({ templateId, template, productId } = {}) =>
      invoke('templates:renderPreview', { templateId, template, productId }),
    // v0.27.0: eyedropper — sample a product image's background colour
    // so the inset margin fill can match it for a seamless seam.
    sampleBgColor: (productId) => invoke('templates:sampleBgColor', { productId }),
    listRuns:  (companyId, limit) => invoke('templates:listRuns', { companyId, limit }),
    // v0.26.15: Overlay Studio Phase 3 — apply templates to
    // products and route the rendered PNG per destination.
    applyToProduct: ({ templateId, productId, destination } = {}) =>
      invoke('templates:applyToProduct', { templateId, productId, destination }),
    applyBulk: ({ templateId, productIds, destination } = {}) =>
      invoke('templates:applyBulk', { templateId, productIds, destination }),
    applyByFilter: ({ templateId, filters, destination, dryRun } = {}) =>
      invoke('templates:applyByFilter', { templateId, filters, destination, dryRun }),
  },
  ai: {
    listModels:    ()                                 => invoke('ai:listModels'),
    estimateCost:  (model, count)                     => invoke('ai:estimateCost', { model, count }),

    listPrompts:   (companyId)                        => invoke('ai:listPrompts', companyId),
    createPrompt:  (input)                            => invoke('ai:createPrompt', input),
    updatePrompt:  (id, patch)                        => invoke('ai:updatePrompt', { id, patch }),
    removePrompt:  (id)                               => invoke('ai:removePrompt', id),

    listTasks:     (companyId, opts)                  => invoke('ai:listTasks', { companyId, ...(opts ?? {}) }),
    queueTask:     (input)                            => invoke('ai:queueTask', input),
    repairTask:    (id)                               => invoke('ai:repairTask', id),
    queueFreshTask:(id)                               => invoke('ai:queueFreshTask', id),
    cancelTask:    (id)                               => invoke('ai:cancelTask', id),
    removeTask:    (id)                               => invoke('ai:removeTask', id),

    listGallery:        (productId)                   => invoke('ai:listGallery', productId),
    listBulkGallery:    (opts)                        => invoke('ai:listBulkGallery', opts ?? {}),
    favoriteGallery:    (id, isFavorite)              => invoke('ai:favoriteGallery', { id, isFavorite }),
    removeGallery:      (id)                          => invoke('ai:removeGallery', id),
    /** Promote: either pass just galleryId (per-product case), or include
     *  targetProductId, or newProduct={sku,name,brandId,categoryId} to
     *  create-and-attach in one shot (bulk-mode flow). */
    promoteGallery:     (args)                        => invoke('ai:promoteGalleryToProduct', typeof args === 'string' ? { galleryId: args } : args),

    /* Bulk-mode helpers (v0.11.0). */
    scanBulkFolder: (folderPath)                      => invoke('ai:scanBulkFolder', folderPath),
    queueBulkBatch: (input)                           => invoke('ai:queueBulkBatch', input),
    /** v0.22.0: bulk-run AI against existing products' main images.
     *  Input: { productIds, provider, model, prompt, options,
     *  promptTemplateId?, autoPromoteAsMain }. */
    queueBulkForProducts: (input)                     => invoke('ai:queueBulkForProducts', input),
    exportBulkImage:(galleryId)                       => invoke('ai:exportBulkImage', { galleryId }),

    testKie: (key) => invoke('ai:testKie', key),
    testFal: (key) => invoke('ai:testFal', key),
    getCredits: ()  => invoke('ai:getCredits'),

    /* Event subscriptions — main → renderer */
    onTaskUpdate:    (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('ai:taskUpdate', fn);
      return () => ipcRenderer.removeListener('ai:taskUpdate', fn);
    },
    onGalleryAdded:  (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('ai:galleryAdded', fn);
      return () => ipcRenderer.removeListener('ai:galleryAdded', fn);
    },
  },
});
