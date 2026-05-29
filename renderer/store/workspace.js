// Workspace slice — product currently open in the Image Workspace:
// images, view-mode + zoom + guides + divider state, plus processing
// progress.

export function createWorkspaceSlice(set, get) {
  return {
    // — Workspace
    workspaceImages: [],
    workspaceImageIndex: 0,
    workspaceProductSku: '',
    workspaceProductName: '',
    workspaceLoading: false,
    workspaceProcessing: false,
    workspaceProgress: null,
    workspaceFillPreview: false,
    workspaceViewMode: 'single',
    workspaceDivider: 50,
    workspaceProcessedTick: 0,
    workspaceZoom: 1,           // 1 = fit, >1 = zoomed in (max 4)
    workspaceGuides: false,     // alignment crosshair overlay toggle

    async loadWorkspaceForProduct(productId) {
      if (!window.api || !productId) {
        set({ workspaceImages: [], workspaceImageIndex: 0, workspaceProductSku: '', workspaceProductName: '' });
        return;
      }
      set({ workspaceLoading: true });
      try {
        const [product, images] = await Promise.all([
          window.api.products.get(productId),
          window.api.images.listByProduct(productId),
        ]);
        set({
          workspaceImages: images,
          workspaceImageIndex: 0,
          workspaceProductSku: product?.sku ?? '',
          workspaceProductName: product?.name ?? '',
          workspaceLoading: false,
        });
      } catch (err) {
        set({ workspaceLoading: false });
        get().addToast(err.message, 'error');
      }
    },
    setWorkspaceImageIndex(idx) { set({ workspaceImageIndex: idx }); },
    setWorkspaceFillPreview(on) { set({ workspaceFillPreview: !!on }); },
    setWorkspaceViewMode(mode) { set({ workspaceViewMode: mode }); },
    setWorkspaceDivider(pct) {
      const clamped = Math.max(0, Math.min(100, pct));
      set({ workspaceDivider: clamped });
    },
    setWorkspaceZoom(z) {
      const clamped = Math.max(0.25, Math.min(4, z));
      set({ workspaceZoom: clamped });
    },
    toggleWorkspaceGuides() {
      set((s) => ({ workspaceGuides: !s.workspaceGuides }));
    },
    setWorkspaceProcessing(on, progress = null) {
      set({ workspaceProcessing: !!on, workspaceProgress: progress });
    },
    bumpProcessedTick() {
      set((s) => ({ workspaceProcessedTick: s.workspaceProcessedTick + 1 }));
    },
    async refreshWorkspaceImages(productId) {
      const images = await window.api.images.listByProduct(productId);
      set({ workspaceImages: images });
      return images;
    },
  };
}
