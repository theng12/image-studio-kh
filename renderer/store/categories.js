// Categories slice — per-company category list + CRUD.

export function createCategoriesSlice(set, get) {
  return {
    categories: [],

    async refreshCategories() {
      if (!window.api) return;
      const companyId = get().activeCompanyId;
      if (!companyId) { set({ categories: [] }); return; }
      try { set({ categories: await window.api.categories.list(companyId) }); }
      catch (err) { get().addToast(err.message, 'error'); }
    },

    async createCategory(input) {
      const companyId = get().activeCompanyId;
      if (!companyId) throw new Error('Select a company first');
      const created = await window.api.categories.create({ ...input, companyId });
      await get().refreshCategories();
      return created;
    },
    // v0.22.13: update + remove. Previously Settings could only create
    // (and remove via the inline list); pulling Categories into its own
    // sidebar page made it natural to expose all three as store actions
    // so the page stays consistent with Brands' shape.
    async updateCategory(id, patch) {
      const updated = await window.api.categories.update(id, patch);
      await get().refreshCategories();
      // Category renames affect product rows (category name shown in
      // the Library table). Refetch products so the new name lands.
      await get().refreshProducts?.();
      return updated;
    },
    async removeCategory(id) {
      await window.api.categories.remove(id);
      await get().refreshCategories();
      // Same reason — products that referenced this category now have
      // a stale categoryId that the renderer will display as "—".
      await get().refreshProducts?.();
    },
  };
}
