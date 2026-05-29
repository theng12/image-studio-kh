// Catalog-change event plumbing shared by the bootstrap subscriber and
// the `applyPendingRemoteChanges` action. Kept here (not on the store)
// because it owns module-level debounce timers that must persist across
// hot reloads / re-bootstraps.

/**
 * Coalesce bursts of catalog-changed events so we refetch ONCE per
 * affected slice even if 30 product updates land in 200ms. The map
 * keys are slice names ("products", "brands", ...); values are the
 * timer handle for the pending refetch.
 */
const _catalogRefreshTimers = new Map();
export function scheduleSliceRefresh(slice, fn) {
  if (_catalogRefreshTimers.has(slice)) return; // already queued
  const t = setTimeout(() => {
    _catalogRefreshTimers.delete(slice);
    try { fn(); } catch (_) {}
  }, 250);
  _catalogRefreshTimers.set(slice, t);
}

/**
 * v0.22.2: route a single `catalog:changed` event to the right
 * refresh actions. Called from two places:
 *
 *   (a) the live subscriber, when the originating user is the
 *       *receiver* themselves (self-events) — applies immediately
 *       so my own edits land without delay;
 *   (b) `applyPendingRemoteChanges()`, when the user clicks the
 *       "N updates available" banner — replays a synthetic
 *       "everything" refresh to drain the queue in one batch.
 *
 * `scheduleSliceRefresh` debounces so a burst of 30 catalog events
 * (e.g. a bulk update) collapses to a single refetch per affected
 * slice. Keep this dispatcher branch-light — anything fancier
 * (e.g. per-id surgical patching) belongs in the slice's own
 * refresh method, not here.
 */
export function applyCatalogEvent(get, evt) {
  const kind = evt?.kind;
  if (!kind) return;
  switch (kind) {
    case 'product':
      scheduleSliceRefresh('products', () => get().refreshProducts());
      scheduleSliceRefresh('allProducts', () => get().refreshAllProducts());
      scheduleSliceRefresh('dashboard', () => get().refreshDashboard());
      break;
    case 'images':
      // Image add/remove/setMain changes the products grid (cover thumb
      // + image count chip) and, if we happen to be viewing the same
      // product in the workspace, the workspace strip too.
      scheduleSliceRefresh('products', () => get().refreshProducts());
      scheduleSliceRefresh('allProducts', () => get().refreshAllProducts());
      scheduleSliceRefresh('dashboard', () => get().refreshDashboard());
      if (evt.id && evt.id === get().activeProductId) {
        scheduleSliceRefresh('workspaceImages', () => {
          get().refreshWorkspaceImages(evt.id).catch(() => {});
        });
      }
      break;
    case 'brand':
      scheduleSliceRefresh('brands', () => get().refreshBrands());
      scheduleSliceRefresh('dashboard', () => get().refreshDashboard());
      // Brand rename/delete affects product rows that reference it.
      scheduleSliceRefresh('products', () => get().refreshProducts());
      scheduleSliceRefresh('allProducts', () => get().refreshAllProducts());
      break;
    case 'category':
      scheduleSliceRefresh('categories', () => get().refreshCategories());
      scheduleSliceRefresh('products', () => get().refreshProducts());
      scheduleSliceRefresh('allProducts', () => get().refreshAllProducts());
      break;
    case 'company':
      scheduleSliceRefresh('companies', () => get().refreshCompanies());
      break;
    case 'aiGallery':
      // Refresh the gallery for the specific product the entry belongs
      // to. The extra `productId` field (set by the emitter in ai.js
      // and queueRunner.js) tells us which slice to refetch even when
      // `evt.id` is the gallery-entry id rather than the product id.
      {
        const pid = evt.productId ?? null;
        if (pid) {
          scheduleSliceRefresh(`aiGallery:${pid}`, () => get().refreshAiGalleryFor(pid));
        }
        // Promotion writes a new product image; refresh products too.
        if (evt.op === 'promote') {
          scheduleSliceRefresh('products', () => get().refreshProducts());
          scheduleSliceRefresh('allProducts', () => get().refreshAllProducts());
        }
      }
      break;
    default:
      // Unknown kind: ignore. Forward-compat — newer servers may emit
      // event kinds an older client doesn't know about; better to
      // silently skip than crash the listener.
      break;
  }
}
