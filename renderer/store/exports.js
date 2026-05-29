// Export Center slice — profiles, queue, run + collision check.

export function createExportsSlice(set, get) {
  return {
    // — Export center
    exportProfiles: [],
    selectedExportProfileId: null,
    exportQueueIds: [],
    exportOutputRoot: null,
    exportRunning: false,
    exportLastResult: null,
    // v0.31.0: also append exported images back onto their products (as the
    // new main image), flagged dedup-exempt. Session-local default off.
    exportSaveToLibrary: false,

    async refreshExportProfiles() {
      if (!window.api) return;
      const companyId = get().activeCompanyId;
      if (!companyId) { set({ exportProfiles: [] }); return; }
      try {
        const profiles = await window.api.exports.listProfiles(companyId);
        set({ exportProfiles: profiles });
        if (!profiles.find((p) => p.id === get().selectedExportProfileId)) {
          set({ selectedExportProfileId: profiles[0]?.id ?? null });
        }
      } catch (err) {
        get().addToast(err.message, 'error');
      }
    },

    setSelectedExportProfile(id) { set({ selectedExportProfileId: id }); },

    async createExportProfile(input) {
      const companyId = get().activeCompanyId;
      if (!companyId) throw new Error('Select a company first');
      const created = await window.api.exports.createProfile({ ...input, companyId });
      await get().refreshExportProfiles();
      set({ selectedExportProfileId: created.id });
      return created;
    },

    async updateExportProfile(id, patch) {
      const updated = await window.api.exports.updateProfile(id, patch);
      await get().refreshExportProfiles();
      return updated;
    },

    async removeExportProfile(id) {
      await window.api.exports.removeProfile(id);
      await get().refreshExportProfiles();
    },

    async duplicateExportProfile(id) {
      const created = await window.api.exports.duplicateProfile(id);
      await get().refreshExportProfiles();
      set({ selectedExportProfileId: created.id });
      return created;
    },

    setExportQueue(ids) { set({ exportQueueIds: Array.isArray(ids) ? ids : [] }); },
    toggleQueueProduct(id) {
      set((s) => {
        const has = s.exportQueueIds.includes(id);
        return { exportQueueIds: has ? s.exportQueueIds.filter((x) => x !== id) : [...s.exportQueueIds, id] };
      });
    },
    clearExportQueue() { set({ exportQueueIds: [] }); },
    setExportOutputRoot(p) { set({ exportOutputRoot: p }); },
    setExportSaveToLibrary(v) { set({ exportSaveToLibrary: !!v }); },

    async runExport(onExisting = 'keepBoth') {
      const { selectedExportProfileId, exportQueueIds, exportOutputRoot, exportSaveToLibrary } = get();
      if (!selectedExportProfileId) throw new Error('Pick a profile first');
      if (!exportQueueIds.length) throw new Error('Add at least one product to the queue');
      if (!exportOutputRoot) throw new Error('Pick an output folder');
      set({ exportRunning: true, exportLastResult: null });
      try {
        // v0.26.24: thread onExisting through. Caller (Export Center)
        // has already shown the collision modal if needed.
        const result = await window.api.exports.run(
          selectedExportProfileId,
          exportQueueIds,
          exportOutputRoot,
          onExisting,
          exportSaveToLibrary,
        );
        set({ exportLastResult: result, exportRunning: false });
        get().refreshProducts();
        return result;
      } catch (err) {
        set({ exportRunning: false });
        get().addToast(err.message, 'error');
        throw err;
      }
    },

    /**
     * v0.26.24: dry-run collision check. Returns
     *   { totalExpected, collisionCount, sampleCollisions: [{name, sku}] }
     * Called by Export Center BEFORE runExport so it can pop the
     * "Folder already contains N matching files — replace / skip /
     * keep both?" modal. Pure read; doesn't touch any state.
     */
    async checkExportCollisions() {
      const { selectedExportProfileId, exportQueueIds, exportOutputRoot } = get();
      if (!selectedExportProfileId || !exportQueueIds.length || !exportOutputRoot) {
        return { totalExpected: 0, collisionCount: 0, sampleCollisions: [] };
      }
      try {
        return await window.api.exports.checkCollisions(
          selectedExportProfileId,
          exportQueueIds,
          exportOutputRoot,
        );
      } catch (err) {
        // Don't block the run on a failed pre-check — surface the error,
        // let the user proceed (the keepBoth fallback handles collisions
        // gracefully even without the heads-up).
        get().addToast(`Collision check failed: ${err.message}`, 'error');
        return { totalExpected: 0, collisionCount: 0, sampleCollisions: [] };
      }
    },
  };
}
