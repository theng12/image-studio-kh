/**
 * v0.20.0: lightweight RPC argument validators.
 *
 * Each entry is `channel → (args) => true | string`. The dispatcher
 * in main/server/index.js looks up the validator before invoking
 * the handler; truthy non-true return means the args failed
 * validation and the handler is skipped (HTTP 400). Channels
 * without a validator entry pass through unvalidated — that's the
 * pre-v0.20.0 behavior, kept as the default so we can add coverage
 * incrementally without breaking anything.
 *
 * Goals — in order of importance:
 *   1. Reject obviously malformed shapes (missing required field,
 *      wrong type for a required field) before they reach the DB.
 *   2. Give a clear error string the renderer can surface.
 *   3. Stay dependency-free. No Zod, no Joi. The schemas are tiny
 *      arrow functions; adding one is a one-line entry.
 *
 * Non-goals: deep field-level type validation, regex constraints,
 * uniqueness checks. Those still happen in the DB layer where the
 * context lives.
 *
 * Convention: validators receive the SAME argument shape the
 * handler receives. For `expose('products:update', ({ id, patch })
 * => ...)` the validator gets `{ id, patch }`.
 */

function isString(v)  { return typeof v === 'string'; }
function isObject(v)  { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isArray(v)   { return Array.isArray(v); }
function isNumber(v)  { return typeof v === 'number' && Number.isFinite(v); }
function isBool(v)    { return typeof v === 'boolean'; }
function isNullableString(v) { return v == null || isString(v); }
function isNullableNumber(v) { return v == null || isNumber(v); }

/** Combinator: every named field must be present (any type). */
function requireFields(...names) {
  return (args) => {
    if (!isObject(args)) return 'expected an object argument';
    for (const n of names) {
      if (!(n in args)) return `missing required field: ${n}`;
    }
    return true;
  };
}

/** Combinator: args must be a string id. Many handlers take just a string. */
function requireStringArg(label = 'id') {
  return (args) => isString(args) ? true : `${label} must be a string`;
}

/** Combinator: args must be a string id OR an object with the field. */
function requireScalarOrField(name) {
  return (args) => {
    if (isString(args)) return true;
    if (isObject(args) && isString(args[name])) return true;
    return `expected string or object with .${name}`;
  };
}

/* ─── Per-channel validators ────────────────────────────────────
 *
 * Listed in the same domain order as the IPC handlers in
 * main/ipc.js for easy cross-reference. Add new entries as new
 * channels are migrated to `expose()`.
 */
const VALIDATORS = {
  // App ------------------------------------------------------------
  // app:getVersion / app:getPlatform take no args; nothing to check.

  // Companies ------------------------------------------------------
  'companies:get':         requireStringArg('company id'),
  'companies:setActive':   (a) => (a == null || isString(a)) ? true : 'company id must be a string or null',
  'companies:create':      (a) => isObject(a) ? true : 'create payload must be an object',
  'companies:update':      requireFields('id', 'patch'),
  'companies:remove':      requireStringArg('company id'),

  // Products -------------------------------------------------------
  'products:list':         (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'products:get':          requireStringArg('product id'),
  'products:create':       (a) => {
    if (!isObject(a)) return 'create payload must be an object';
    if (!isString(a.companyId) || !a.companyId.trim()) return 'companyId is required';
    if (!isString(a.sku) || !a.sku.trim()) return 'sku is required';
    return true;
  },
  'products:update':       (a) => {
    const base = requireFields('id', 'patch')(a);
    if (base !== true) return base;
    if (!isString(a.id) || !a.id.trim()) return 'id must be a non-empty string';
    if (!isObject(a.patch)) return 'patch must be an object';
    return true;
  },
  'products:remove':       requireStringArg('product id'),
  'products:duplicate':    (a) => {
    if (!isObject(a)) return 'expected object with id';
    if (!isString(a.id)) return 'id must be a string';
    return true;
  },
  'products:bulkUpdate':   (a) => {
    if (!isObject(a)) return 'expected object with ids + patch';
    if (!isArray(a.ids)) return 'ids must be an array';
    if (a.ids.length > 5000) return 'ids too large (max 5000 per batch)';
    if (!isObject(a.patch)) return 'patch must be an object';
    return true;
  },
  'products:bulkRemove':   (a) => {
    if (!isObject(a)) return 'expected object with ids';
    if (!isArray(a.ids)) return 'ids must be an array';
    if (a.ids.length > 5000) return 'ids too large (max 5000 per batch)';
    return true;
  },
  'products:bulkUpsert':   (a) => {
    if (!isObject(a)) return 'expected object with companyId + rows';
    if (!isString(a.companyId)) return 'companyId required';
    if (!isArray(a.rows)) return 'rows must be an array';
    if (a.rows.length > 50000) return 'rows too large (max 50000 per upsert)';
    return true;
  },

  // Brands ---------------------------------------------------------
  'brands:get':            requireStringArg('brand id'),
  'brands:create':         (a) => isObject(a) ? true : 'create payload must be an object',
  'brands:update':         requireFields('id', 'patch'),
  'brands:remove':         requireStringArg('brand id'),
  'brands:uploadIconFromBytes': (a) => {
    if (!isObject(a)) return 'expected object with bytes';
    // Validation runs BEFORE deserialization, so bytes here is
    // either a Buffer-like (local IPC) or a `{ __bin, b64 }`
    // envelope (RPC). Either way it should just be non-null.
    if (a.bytes == null) return 'bytes required';
    return true;
  },

  // Categories -----------------------------------------------------
  'categories:create':     (a) => isObject(a) ? true : 'create payload must be an object',
  'categories:update':     requireFields('id', 'patch'),
  'categories:remove':     requireStringArg('category id'),

  // Images ---------------------------------------------------------
  'images:listByProduct':  requireStringArg('product id'),
  'images:setMainImage':   requireFields('productId', 'filepath'),
  'images:reorderImages':  requireFields('productId', 'newOrder'),
  'images:removeFromProduct': requireFields('productId', 'filepath'),
  'images:flipSource': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.productId)) return 'productId required';
    if (!isString(a.filepath)) return 'filepath required';
    // v0.26.27: 'both' added for the Lightbox preview-then-Apply
    // flow (combined H+V flip in a single re-encode).
    if (a.axis !== 'h' && a.axis !== 'v' && a.axis !== 'both') return "axis must be 'h', 'v', or 'both'";
    return true;
  },
  'images:importFromBytes': (a) => {
    if (!isObject(a)) return 'expected object with productId + bytes';
    if (!isString(a.productId)) return 'productId required';
    if (a.bytes == null) return 'bytes required';
    return true;
  },

  // Watermarks -----------------------------------------------------
  'watermarks:uploadFromBytes': (a) => {
    if (!isObject(a)) return 'expected object with bytes';
    if (a.bytes == null) return 'bytes required';
    return true;
  },

  // Workspace ------------------------------------------------------
  'workspace:processImage': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.productId)) return 'productId required';
    if (!isString(a.filepath)) return 'filepath required';
    return true;
  },
  'workspace:saveSettings': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.productId)) return 'productId required';
    if (!isString(a.filepath)) return 'filepath required';
    return true;
  },

  // Exports --------------------------------------------------------
  'exports:getProfile':     requireStringArg('profile id'),
  'exports:createProfile':  (a) => isObject(a) ? true : 'create payload must be an object',
  'exports:updateProfile':  requireFields('id', 'patch'),
  'exports:removeProfile':  requireStringArg('profile id'),
  'exports:duplicateProfile': requireStringArg('profile id'),
  'exports:runForClient':   (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    return true;
  },
  // v0.26.40: added during the audit. Collisions check takes a
  // user-controlled outputRoot string — validating shape so a
  // malformed RPC call gets rejected with a clear message instead
  // of crashing the handler later.
  'exports:checkCollisions': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    if (a.productIds.length > 50_000) return 'productIds too large (max 50000)';
    if (a.outputRoot != null && !isString(a.outputRoot)) return 'outputRoot must be a string';
    return true;
  },
  // v0.26.50: pure expected-filename compute for the client-mode
  // collision-check bridge. No outputRoot — the client supplies that
  // and runs the fs check locally.
  'exports:expectedOutputs': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    if (a.productIds.length > 50_000) return 'productIds too large (max 50000)';
    return true;
  },

  // AI -------------------------------------------------------------
  'ai:createPrompt':       (a) => isObject(a) ? true : 'expected object',
  'ai:updatePrompt':       requireFields('id', 'patch'),
  'ai:removePrompt':       requireStringArg('prompt id'),
  'ai:listTasks':          (a) => (a == null || isObject(a)) ? true : 'expected object or null',
  'ai:queueTask':          (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.companyId)) return 'companyId required';
    if (!isString(a.provider)) return 'provider required';
    if (!isString(a.model)) return 'model required';
    if (!isString(a.prompt) || !a.prompt.trim()) return 'prompt required';
    return true;
  },
  'ai:repairTask':         requireStringArg('task id'),
  'ai:queueFreshTask':     requireStringArg('task id'),
  'ai:cancelTask':         requireStringArg('task id'),
  'ai:removeTask':         requireStringArg('task id'),
  'ai:listGallery':        requireStringArg('product id'),
  'ai:favoriteGallery':    requireFields('id', 'isFavorite'),
  'ai:removeGallery':      requireStringArg('gallery id'),
  'ai:promoteGalleryToProduct': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.galleryId)) return 'galleryId required';
    return true;
  },
  'ai:queueBulkForProducts': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isArray(a.productIds) || a.productIds.length === 0) return 'productIds must be a non-empty array';
    if (a.productIds.length > 1000) return 'productIds too large (max 1000 per batch)';
    if (!isString(a.provider)) return 'provider required';
    if (!isString(a.model)) return 'model required';
    if (!isString(a.prompt) || !a.prompt.trim()) return 'prompt required';
    return true;
  },
  'ai:queueBulkBatchFromBytes': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isArray(a.sources)) return 'sources must be an array';
    if (a.sources.length > 500) return 'sources too large (max 500 per batch)';
    if (!isString(a.provider)) return 'provider required';
    if (!isString(a.model)) return 'model required';
    if (!isString(a.prompt) || !a.prompt.trim()) return 'prompt required';
    return true;
  },
  'ai:exportBulkImageBytes': requireFields('galleryId'),

  // Overlay Studio -------------------------------------------------
  'templates:get':         requireStringArg('template id'),
  'templates:create':      (a) => isObject(a) ? true : 'expected object',
  'templates:update':      requireFields('id', 'patch'),
  'templates:remove':      requireStringArg('template id'),
  'templates:duplicate':   requireStringArg('template id'),
  // v0.26.40: added during the audit. renderPreview takes either an
  // existing templateId OR a literal template object — both shapes
  // are accepted by the handler; we just want the wrapper to be a
  // proper object with one of those fields.
  'templates:renderPreview': (a) => {
    if (!isObject(a)) return 'expected object';
    if (a.templateId != null && !isString(a.templateId)) return 'templateId must be a string';
    if (a.template != null && !isObject(a.template)) return 'template must be an object';
    if (!a.templateId && !a.template) return 'either templateId or template required';
    if (a.productId != null && !isString(a.productId)) return 'productId must be a string';
    return true;
  },
  // v0.26.15: apply-template handlers. destination shape:
  //   { kind: 'append' } | { kind: 'replaceMain' } |
  //   { kind: 'saveToFolder', folder: '/abs/path' }
  'templates:applyToProduct': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isString(a.productId))  return 'productId required';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    return true;
  },
  'templates:applyBulk': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isArray(a.productIds) || a.productIds.length === 0) return 'productIds must be a non-empty array';
    if (a.productIds.length > 1000) return 'productIds too large (max 1000 per batch)';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    return true;
  },
  'templates:applyByFilter': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    return true;
  },

  // Global search --------------------------------------------------
  'search:global':         (a) => {
    if (!isObject(a)) return 'expected object with query';
    if (!isString(a.query)) return 'query must be a string';
    if (a.limit != null && !isNumber(a.limit)) return 'limit must be a number';
    return true;
  },

  // Audit log feed (v0.22.6) ---------------------------------------
  // Both channels take the same {entityType, entityId, [limit]} shape.
  // entityType is short, finite, opaque to the validator beyond "string".
  'audit:listForEntity': (a) => {
    if (!isObject(a)) return 'expected object with entityType + entityId';
    if (!isString(a.entityType)) return 'entityType must be a string';
    if (!isString(a.entityId)) return 'entityId must be a string';
    if (a.limit != null && !isNumber(a.limit)) return 'limit must be a number';
    return true;
  },
  'audit:countForEntity': (a) => {
    if (!isObject(a)) return 'expected object with entityType + entityId';
    if (!isString(a.entityType)) return 'entityType must be a string';
    if (!isString(a.entityId)) return 'entityId must be a string';
    return true;
  },
  // v0.26.31: global history feed. All four filter fields optional;
  // empty payload returns the most recent 100 events across the whole
  // audit log.
  'audit:listRecent': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected object';
    if (a.limit  != null && !isNumber(a.limit))  return 'limit must be a number';
    if (a.offset != null && !isNumber(a.offset)) return 'offset must be a number';
    if (a.entityType != null && !isString(a.entityType)) return 'entityType must be a string';
    if (a.userId     != null && !isString(a.userId))     return 'userId must be a string';
    return true;
  },
  'audit:countRecent': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected object';
    if (a.entityType != null && !isString(a.entityType)) return 'entityType must be a string';
    if (a.userId     != null && !isString(a.userId))     return 'userId must be a string';
    return true;
  },
};

function getValidator(channel) {
  return VALIDATORS[channel] ?? null;
}

module.exports = {
  getValidator,
  // Exported for tests / future internal use.
  isString,
  isObject,
  isArray,
  isNumber,
  isBool,
  isNullableString,
  isNullableNumber,
  requireFields,
  requireStringArg,
};
