// Navigation slice — active module + workspace product id, plus the
// MODULES allowlist + ALWAYS_AVAILABLE gating used by `isModuleAvailable`.

// Whitelist of routable module names. Must stay in sync with PAGES in
// App.jsx — `setActiveModule` rejects anything not in this set.
//
// HISTORICAL FOOTGUN: when v0.10.0 added Overlay Studio I forgot to add
// 'overlay' here, so every click on the sidebar entry was *silently*
// swallowed by the guard in setActiveModule. The page never even
// attempted to render — so the page error boundary added in v0.10.2
// couldn't help. Fixed in v0.10.3, plus a console.warn on unknown
// module names so future regressions are at least visible in devtools.
// v0.26.31: 'history' added — global audit-log feed page.
// v0.49.46: 'suppliers' added — OPERATIONS section Phase 1.
// v0.49.47: 'purchaseorders' + 'costcalc' added — OPERATIONS Phase 2-4.
const MODULES = ['dashboard', 'company', 'brands', 'library', 'workspace', 'export', 'aistudio', 'overlay', 'suppliers', 'purchaseorders', 'costcalc', 'history', 'settings', 'support'];
// Overlay Studio templates are global (not company-scoped), so the module
// stays clickable even when no company has been picked yet — matches the
// header copy inside the module itself.
// v0.26.31: 'history' is also always-available — it reads from the
// global audit_log which doesn't require an active company. Useful
// even before any company has been created (just shows an empty list).
const ALWAYS_AVAILABLE = new Set(['dashboard', 'company', 'settings', 'support', 'overlay', 'history']);

export function createNavigationSlice(set, get) {
  return {
    // — Navigation
    activeModule: 'dashboard',

    // — Workspace context
    activeProductId: null,

    // — v0.49.48: cross-module PO navigation. The Library Cost column +
    // the Suppliers "Orders" button jump into the Purchase Orders module
    // with context. These transient fields carry that context across the
    // module switch; the PO module consumes + clears them on mount.
    //   pendingPoId           → open this PO's detail page directly
    //   pendingPoSupplierId   → open the PO list pre-filtered to this supplier
    pendingPoId: null,
    pendingPoSupplierId: null,

    setActiveModule(name) {
      if (!MODULES.includes(name)) {
        // Loud-fail in dev/devtools instead of silently dropping the request
        // — the v0.10.0 "Overlay Studio doesn't open" bug was a missing
        // entry here, and the silent return made it invisible. The console
        // line costs nothing in prod and saves hours when a route is
        // mistyped or forgotten.
        // eslint-disable-next-line no-console
        console.warn(`[store] setActiveModule("${name}") ignored — module not in allowlist. Update MODULES in store/index.js.`);
        return;
      }
      set({ activeModule: name });
    },

    setActiveProductId(id) {
      set({ activeProductId: id });
    },

    openProductInWorkspace(productId) {
      set({ activeProductId: productId, activeModule: 'workspace' });
    },

    // v0.49.48: jump to a specific PO detail (from the Library Cost column).
    openPurchaseOrder(poId) {
      set({ pendingPoId: poId, pendingPoSupplierId: null, activeModule: 'purchaseorders' });
    },
    // v0.49.48: jump to the PO list filtered by a supplier (from Suppliers).
    openPurchaseOrdersForSupplier(supplierId) {
      set({ pendingPoSupplierId: supplierId, pendingPoId: null, activeModule: 'purchaseorders' });
    },
    // Consumed by the PO module once it's read the pending intent.
    clearPendingPoNav() {
      set({ pendingPoId: null, pendingPoSupplierId: null });
    },

    isModuleAvailable(name) {
      if (ALWAYS_AVAILABLE.has(name)) return true;
      return !!get().activeCompanyId;
    },
  };
}
