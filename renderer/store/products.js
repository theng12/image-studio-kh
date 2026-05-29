// Products slice — Library list + the filter-agnostic `allProducts`
// list used by pickers, plus filters/sort/pagination and CRUD.

import { DEFAULT_FILTERS, DEFAULT_SORT, loadProductSort, saveProductSort } from './productsDefaults.js';

export function createProductsSlice(set, get) {
  return {
    // — Product data
    products: [],
    // v0.17.0: start true so the Library shows the loading spinner on
    // first paint, not a flash of "No products yet" before the first
    // refresh resolves (especially noticeable in client mode where the
    // RPC takes a beat).
    productsLoading: true,
    productFilters: { ...DEFAULT_FILTERS },
    // v0.26.48: seed sort from localStorage so the user's choice
    // survives reloads, navigation, and app restarts. Falls back to
    // DEFAULT_SORT (recently-updated descending) on first run or if
    // the stored key is no longer in the catalog.
    productSort: loadProductSort(),
    page: 0,
    pageSize: 50,

    /**
     * v0.11.3: filter-agnostic list of every product in the active company.
     * Separate from `products` (which mirrors the Library's filters) so
     * global pickers — AI Studio's source combobox, the Promote-to-product
     * dialog, etc. — can show every product regardless of what's filtered
     * in the Library. Refreshed on company switch and after every product
     * mutation (create / update / delete) alongside `products`.
     */
    allProducts: [],

    /* ─── Filters ─── */

    setProductSearch(search) {
      set((s) => ({ productFilters: { ...s.productFilters, search }, page: 0 }));
      get().refreshProducts();
    },
    toggleBrandFilter(value) {
      // value can be a brand id or null (for unassigned).
      set((s) => {
        const cur = s.productFilters.brandIds ?? [];
        const has = cur.some((v) => v === value);
        const next = has ? cur.filter((v) => v !== value) : [...cur, value];
        return { productFilters: { ...s.productFilters, brandIds: next }, page: 0 };
      });
      get().refreshProducts();
    },
    clearBrandFilter() {
      set((s) => ({ productFilters: { ...s.productFilters, brandIds: [] }, page: 0 }));
      get().refreshProducts();
    },
    toggleCategoryFilter(value) {
      set((s) => {
        const cur = s.productFilters.categoryIds ?? [];
        const has = cur.some((v) => v === value);
        const next = has ? cur.filter((v) => v !== value) : [...cur, value];
        return { productFilters: { ...s.productFilters, categoryIds: next }, page: 0 };
      });
      get().refreshProducts();
    },
    clearCategoryFilter() {
      set((s) => ({ productFilters: { ...s.productFilters, categoryIds: [] }, page: 0 }));
      get().refreshProducts();
    },
    setStatusFilter(status) {
      set((s) => ({ productFilters: { ...s.productFilters, status }, page: 0 }));
      get().refreshProducts();
    },
    setProcessStatusFilter(processStatus) {
      set((s) => ({ productFilters: { ...s.productFilters, processStatus }, page: 0 }));
      get().refreshProducts();
    },
    setHasImagesFilter(hasImages) {
      // Tri-state: null | 'with' | 'without'. Client-side filter (cheap on the
      // already-fetched list); we just refetch + slice in the renderer.
      set((s) => ({ productFilters: { ...s.productFilters, hasImages }, page: 0 }));
    },
    resetFilters() {
      // v0.26.48: when the user explicitly clicks "Reset filters" we
      // DO reset sort to default — that matches the intent of the
      // button. Also persist the reset to localStorage so a reload
      // after reset doesn't resurface the old saved sort.
      saveProductSort(DEFAULT_SORT);
      set({ productFilters: { ...DEFAULT_FILTERS }, productSort: { ...DEFAULT_SORT }, page: 0 });
      get().refreshProducts();
    },

    /* ─── Sort ─── */

    setProductSort(key) {
      // Clicking the same column toggles direction. Clicking a different
      // column starts in 'asc' for text columns, 'desc' for numeric/date
      // columns so the most-useful values surface first.
      const NUMERIC_DEFAULTS_DESC = new Set(['images', 'updated']);
      set((s) => {
        const prev = s.productSort;
        const nextSort = prev.key === key
          ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: NUMERIC_DEFAULTS_DESC.has(key) ? 'desc' : 'asc' };
        // v0.26.48: persist to localStorage. Same pattern as the
        // other UI prefs (grid card size, view toggle, column
        // visibility, hover preview). Synchronous write inside set()
        // is fine — localStorage.setItem is microseconds.
        saveProductSort(nextSort);
        return { productSort: nextSort, page: 0 };
      });
    },

    /* ─── Pagination ─── */

    setPage(page) { set({ page }); },
    setPageSize(pageSize) { set({ pageSize, page: 0 }); },

    /* ─── Data ─── */

    async refreshProducts() {
      if (!window.api) return;
      const companyId = get().activeCompanyId;
      if (!companyId) {
        // v0.17.0: flip productsLoading off in the early-return path so
        // a session that never picks a company doesn't get stuck on the
        // "Loading…" indicator. (The Library page renders its own
        // "No company selected" state in this case.)
        set({ products: [], allProducts: [], productsLoading: false });
        return;
      }
      set({ productsLoading: true });
      try {
        const filters = get().productFilters;
        const filtersAreDefault =
          filters.search === '' &&
          (filters.brandIds == null || filters.brandIds.length === 0) &&
          (filters.categoryIds == null || filters.categoryIds.length === 0) &&
          filters.status == null &&
          filters.processStatus == null &&
          filters.hasImages == null;

        const list = await window.api.products.list(companyId, filters);
        // v0.11.3: keep `allProducts` in sync from the same call when no
        // filters are active (saves a redundant IPC roundtrip on every
        // keystroke in the Library search). When filters ARE active, the
        // two lists differ — fire a parallel query to keep AI Studio's
        // combobox / Promote dialog showing every product anyway.
        if (filtersAreDefault) {
          set({ products: list, allProducts: list, productsLoading: false });
        } else {
          set({ products: list, productsLoading: false });
          get().refreshAllProducts();
        }
        const { page, pageSize } = get();
        const maxPage = Math.max(0, Math.ceil(list.length / pageSize) - 1);
        if (page > maxPage) set({ page: maxPage });
      } catch (err) {
        set({ productsLoading: false });
        get().addToast(err.message, 'error');
      }
    },

    /**
     * v0.11.3: refresh the full, filter-agnostic product list used by
     * AI Studio's source combobox and the Promote-to-product dialog. Calls
     * `products.list(companyId, {})` so the result never depends on whatever
     * the Library currently has filtered. Safe to call alongside
     * `refreshProducts()` — they hit the same IPC but with different
     * arguments.
     */
    async refreshAllProducts() {
      if (!window.api) return;
      const companyId = get().activeCompanyId;
      if (!companyId) { set({ allProducts: [] }); return; }
      try {
        const list = await window.api.products.list(companyId, {});
        set({ allProducts: list });
      } catch (err) {
        get().addToast(err.message, 'error');
      }
    },

    async createProduct(input) {
      const companyId = get().activeCompanyId;
      if (!companyId) throw new Error('Select a company first');
      const created = await window.api.products.create({ ...input, companyId });
      await Promise.all([
        get().refreshProducts(),
        get().refreshAllProducts(),
        get().refreshDashboard(),
      ]);
      return created;
    },
    async updateProduct(id, patch) {
      const updated = await window.api.products.update(id, patch);
      await Promise.all([get().refreshProducts(), get().refreshAllProducts()]);
      return updated;
    },
    async removeProduct(id) {
      await window.api.products.remove(id);
      await Promise.all([
        get().refreshProducts(),
        get().refreshAllProducts(),
        get().refreshDashboard(),
      ]);
    },
  };
}
