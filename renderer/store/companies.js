// Companies slice — multi-tenant: company list + active company id +
// CRUD. Switching company triggers refetches in dependent slices.

// v0.26.48: DEFAULT_SORT no longer imported here — sort is now
// persisted globally and survives company switches, so the slice
// doesn't need to reset it. See store/products.js + productsDefaults.js.
import { DEFAULT_FILTERS } from './productsDefaults.js';

export function createCompaniesSlice(set, get) {
  return {
    // — Multi-tenant
    companies: [],
    activeCompanyId: null,

    async refreshCompanies() {
      if (!window.api) return;
      try { set({ companies: await window.api.companies.list() }); }
      catch (err) { get().addToast(err.message, 'error'); }
    },

    async setActiveCompany(id) {
      await window.api.companies.setActive(id);
      // v0.26.48: preserve the user's persisted sort choice across
      // company switches. Pre-fix this reset productSort to
      // DEFAULT_SORT every time, defeating the localStorage persistence.
      // Filters DO reset (search/brand/category are intrinsically
      // per-company), but sort preference is global UI ergonomics.
      set({
        activeCompanyId: id,
        productFilters: { ...DEFAULT_FILTERS },
        page: 0,
        exportQueueIds: [],
        selectedExportProfileId: null,
      });
      await Promise.all([
        get().refreshBrands(),
        get().refreshCategories(),
        get().refreshProducts(),
        get().refreshAllProducts(),
        get().refreshDashboard(),
        get().refreshExportProfiles(),
      ]);
    },

    async createCompany(input) {
      const created = await window.api.companies.create(input);
      await get().refreshCompanies();
      // If this is the first company, the main process auto-set it active.
      if (!get().activeCompanyId) {
        const activeId = await window.api.companies.getActiveId();
        if (activeId) await get().setActiveCompany(activeId);
      }
      return created;
    },

    async updateCompany(id, patch) {
      const updated = await window.api.companies.update(id, patch);
      await get().refreshCompanies();
      return updated;
    },

    async removeCompany(id) {
      await window.api.companies.remove(id);
      await get().refreshCompanies();
      const activeId = await window.api.companies.getActiveId();
      set({ activeCompanyId: activeId });
      if (activeId) {
        await Promise.all([
          get().refreshBrands(),
          get().refreshCategories(),
          get().refreshProducts(),
          get().refreshAllProducts(),
          get().refreshDashboard(),
        ]);
      } else {
        set({ brands: [], categories: [], products: [], allProducts: [], dashboardStats: null });
      }
    },
  };
}
