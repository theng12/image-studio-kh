/**
 * v0.21.0: shared helpers extracted from the old monolithic ipc.js.
 *
 * Every domain module (main/ipc/<name>.js) imports from here. The
 * helpers fall into three buckets:
 *
 *   1. **`expose(channel, handler)`** — registers a handler with both
 *      `ipcMain.handle` (local renderer) AND the RPC server registry
 *      (remote clients). Same contract since v0.14.2. This is the
 *      thing every domain file calls.
 *
 *   2. **`emitCatalogChange(kind, op, id, extra)`** — fires a
 *      `catalog:changed` event so the renderer + remote clients
 *      refetch the affected slice. Used after every successful
 *      write. v0.15.1 introduced; v0.21.0 just moved it here.
 *
 *   3. **`assertEntityInActiveCompany` / `assertProductInActiveCompany`**
 *      — anti-cross-tenancy guards. Called at the top of any handler
 *      that mutates or reads a single entity. Throws if the row
 *      belongs to a different company than the one the caller has
 *      active.
 *
 * Plus a couple of constants (`URL_ALLOW`, `SAFE_WATERMARK_EXTS`,
 * `SAFE_BRAND_EXTS`) that get reused across handlers.
 */

const { ipcMain } = require('electron');
const { broadcast } = require('../events');

/* ─── Constants ───────────────────────────────────────────────── */

// Bare allow-list of URL schemes for `app:openExternal`. The handler
// also parses the URL with WHATWG URL to reject malformed input.
const URL_ALLOW = /^(https?:|mailto:)/i;

const SAFE_WATERMARK_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// Brand icons additionally accept SVG (vector logo art).
const SAFE_BRAND_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

/* ─── expose(channel, handler) ───────────────────────────────── */

/**
 * Register a channel with BOTH `ipcMain.handle` and the server's
 * RPC registry. The handler signature is `(args) => result` — one
 * argument, no IpcMainInvokeEvent. The wiring strips the event for
 * IPC calls and forwards `body.args` for RPC calls.
 */
function expose(channel, handler) {
  try {
    const { registerHandler } = require('../server');
    registerHandler(channel, handler);
  } catch (err) {
    process.stderr.write(`[ipc.expose] server registry not available: ${err.message}\n`);
  }
  ipcMain.handle(channel, (_e, ...args) => handler(args[0]));
}

/* ─── Catalog change event helper ────────────────────────────── */

/**
 * Fire a `catalog:changed` event so every connected client (and our
 * own local renderer) can refetch the affected slice. The payload is
 * deliberately minimal: kind + op + id is enough for the renderer to
 * route to the right refresh action. Clients refetch fresh data via
 * the existing RPC channels — keeping the server as the truth-of-
 * record and dodging stale-data drift.
 *
 * v0.22.2: include `originUserId` so each receiver can tell their
 * own actions apart from somebody else's. Self-events still
 * auto-apply (renderer needs to see its own edits land). Remote
 * events get queued behind a "Refresh" banner so another user's
 * burst of edits doesn't trample the receiver's sort / scroll /
 * side-panel state. The id comes from the RPC dispatcher's
 * per-request slot (see main/server/index.js); it's null for
 * local-renderer-triggered changes (standalone Mac or server
 * admin), which receivers treat as "self" — null === null on the
 * receiver side because neither has a user.
 */
function emitCatalogChange(kind, op, id, extra) {
  let originUserId = null;
  try {
    const { getCurrentUserId } = require('../server');
    originUserId = getCurrentUserId?.() ?? null;
  } catch (_) { /* server module not loaded — standalone */ }
  broadcast('catalog:changed', {
    kind, op, id, originUserId,
    ...(extra ?? {}),
  });
}

/* ─── Cross-tenancy guards ───────────────────────────────────── */

const companies = require('../db/companies');
const products = require('../db/products');

/**
 * Throw if `entity` doesn't exist or doesn't belong to the active
 * company. Used to prevent stale renderer state (e.g. after a
 * company switch) from mutating or reading data scoped to a
 * different company. The thrown error surfaces in the renderer as
 * a toast, which is the right UX — cross-company access shouldn't
 * fail silently.
 *
 * Some entities (e.g. ai_gallery, product_images) don't carry
 * company_id directly. For those, resolve the parent product first
 * and use `assertProductInActiveCompany(entity.productId)`.
 */
function assertEntityInActiveCompany(entity, kind = 'Resource') {
  if (!entity) {
    const err = new Error(`${kind} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const active = companies.getActiveId();
  if (entity.companyId && entity.companyId !== active) {
    const err = new Error(`${kind} belongs to a different company`);
    err.code = 'CROSS_COMPANY';
    throw err;
  }
  return entity;
}

function assertProductInActiveCompany(productId, kind = 'Product') {
  const p = products.get(productId);
  return assertEntityInActiveCompany(p, kind);
}

module.exports = {
  expose,
  emitCatalogChange,
  assertEntityInActiveCompany,
  assertProductInActiveCompany,
  URL_ALLOW,
  SAFE_WATERMARK_EXTS,
  SAFE_BRAND_EXTS,
};
