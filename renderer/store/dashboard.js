// Dashboard slice — stats + recent lists + donate banner cool-off.

// Per DONATIONS_HANDOFF: 7-day cool-off. Value is the epoch-ms (string) of
// the last dismissal. Absent or older than 7 days → banner shows again.
const DONATE_DISMISS_KEY = 'iskh.donationDismissedAt';
const DONATE_COOLOFF_MS = 7 * 24 * 60 * 60 * 1000;

function donateBannerShouldShow() {
  try {
    const at = localStorage.getItem(DONATE_DISMISS_KEY);
    if (!at) return true;
    const lastMs = parseInt(at, 10);
    if (!Number.isFinite(lastMs)) return true;
    return (Date.now() - lastMs) >= DONATE_COOLOFF_MS;
  } catch { return true; }
}

export function createDashboardSlice(set, get) {
  return {
    // — Dashboard
    dashboardStats: null,
    dashboardRecentBrands: [],
    dashboardRecentProducts: [],
    donateBannerDismissed: !donateBannerShouldShow(),

    async refreshDashboard() {
      if (!window.api) return;
      const companyId = get().activeCompanyId;
      if (!companyId) {
        set({ dashboardStats: null, dashboardRecentBrands: [], dashboardRecentProducts: [] });
        return;
      }
      try {
        const [stats, recentBrands, recentProducts] = await Promise.all([
          window.api.dashboard.stats(companyId),
          window.api.dashboard.recentBrands(companyId, 5),
          window.api.dashboard.recentProducts(companyId, 8),
        ]);
        set({ dashboardStats: stats, dashboardRecentBrands: recentBrands, dashboardRecentProducts: recentProducts });
      } catch (err) {
        get().addToast(err.message, 'error');
      }
    },

    /* ─── Banner ─── */

    dismissDonateBanner() {
      try { localStorage.setItem(DONATE_DISMISS_KEY, String(Date.now())); } catch {}
      set({ donateBannerDismissed: true });
    },

    reevaluateDonateBanner() {
      // Called when the Dashboard mounts so a returning user (past the cool-off)
      // sees the banner again without an app restart.
      set({ donateBannerDismissed: !donateBannerShouldShow() });
    },
  };
}
