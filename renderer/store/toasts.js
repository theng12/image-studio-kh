// Toasts slice — single-line auto-dismissing notifications.

const TOAST_DURATION_MS = 3000;
// Tracks the auto-dismiss timer per toast id. We need this so manual
// `dismissToast(id)` clears the pending timer rather than letting it fire
// later and try to remove an already-gone toast. (Tier 2 perf fix.)
const toastTimers = new Map();

let toastSeq = 0;

export function createToastsSlice(set, _get) {
  return {
    // — Toasts
    toasts: [],

    addToast(message, variant = 'info') {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { id, message, variant }] }));
      const timer = setTimeout(() => {
        toastTimers.delete(id);
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, TOAST_DURATION_MS);
      toastTimers.set(id, timer);
      return id;
    },

    dismissToast(id) {
      // Clear the pending auto-dismiss so it doesn't fire after manual close.
      const timer = toastTimers.get(id);
      if (timer != null) {
        clearTimeout(timer);
        toastTimers.delete(id);
      }
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
}
