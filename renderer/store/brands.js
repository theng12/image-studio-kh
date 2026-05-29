// Brands slice — per-company brand list + CRUD.

export function createBrandsSlice(set, get) {
  return {
    // — Lookups (per active company)
    brands: [],
    // v0.17.0: same loading-true-by-default pattern as productsLoading
    // so the Brands page doesn't flash "No brands yet" on first paint.
    brandsLoading: true,

    async refreshBrands() {
      if (!window.api) return;
      const companyId = get().activeCompanyId;
      if (!companyId) { set({ brands: [], brandsLoading: false }); return; }
      set({ brandsLoading: true });
      try { set({ brands: await window.api.brands.list(companyId), brandsLoading: false }); }
      catch (err) { set({ brandsLoading: false }); get().addToast(err.message, 'error'); }
    },

    async createBrand(input) {
      const companyId = get().activeCompanyId;
      if (!companyId) throw new Error('Select a company first');
      const created = await window.api.brands.create({ ...input, companyId });
      await Promise.all([get().refreshBrands(), get().refreshDashboard()]);
      return created;
    },
    async updateBrand(id, patch) {
      const updated = await window.api.brands.update(id, patch);
      await Promise.all([get().refreshBrands(), get().refreshDashboard()]);
      return updated;
    },
    async removeBrand(id) {
      await window.api.brands.remove(id);
      await Promise.all([get().refreshBrands(), get().refreshProducts(), get().refreshDashboard()]);
    },
  };
}
