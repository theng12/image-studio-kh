// Bootstrap slice — the `bootstrap()` action that runs on app start,
// plus the module-scope IPC subscription disposers so subsequent
// bootstraps (hot reload, future reconnect flow) don't stack listeners.

import { applyTheme } from '../lib/theme.js';
import { applyCatalogEvent } from './catalogEvents.js';

// Module-scope holders for IPC event-listener disposers. Without these,
// every bootstrap() call (e.g. on hot reload, or if a future reconnect
// flow re-runs it) stacks duplicate listeners and re-triggers store
// actions for every event N times.
let _aiUnsubs = [];
function disposeAiSubscriptions() {
  for (const fn of _aiUnsubs) {
    try { fn(); } catch (_) { /* listener already gone */ }
  }
  _aiUnsubs = [];
}

// Same pattern for client-mode connection-state subscriptions. Kept
// separate because they have a different lifecycle (always subscribe
// in client mode; never subscribe otherwise).
let _clientUnsub = null;
function disposeClientSubscription() {
  if (_clientUnsub) { try { _clientUnsub(); } catch (_) {} _clientUnsub = null; }
}

// v0.15.1: server-pushed catalog-change events. Live in any mode
// (the local server-mode admin renderer hears them too), but the
// payoff is on clients — when another Mac edits the catalog, this
// is how we know to refetch.
let _catalogUnsubs = [];
function disposeCatalogSubscriptions() {
  for (const fn of _catalogUnsubs) { try { fn(); } catch (_) {} }
  _catalogUnsubs = [];
}

export function createBootstrapSlice(set, get) {
  return {
    async bootstrap() {
      if (!window.api) return;
      // v0.26.36: settle individually so a single slow / failing call
      // doesn't take down the rest of the bootstrap. Pre-v0.26.36 we
      // used Promise.all here, which meant a network blip on the
      // settings RPC nuked the version + platform values too — the
      // sidebar would then show "v0.0.0" until a successful relaunch.
      // Promise.allSettled gives each slice an independent fate.
      const [versionR, platformR, activeIdR, settingsR] = await Promise.allSettled([
        window.api.app.getVersion(),
        window.api.app.getPlatform(),
        window.api.companies.getActiveId(),
        window.api.settings.getAll(),
      ]);
      const version  = versionR.status  === 'fulfilled' ? versionR.value  : null;
      const platform = platformR.status === 'fulfilled' ? platformR.value : null;
      const activeId = activeIdR.status === 'fulfilled' ? activeIdR.value : null;
      const settings = settingsR.status === 'fulfilled' ? settingsR.value : null;
      const theme = settings?.theme ?? 'light';
      applyTheme(theme);
      // Restore the last-used AI model so the user isn't reselecting on every
      // launch. The state default ('kie:nano-banana-pro') stays as fallback
      // for a fresh config or a stale saved key whose model no longer exists
      // in the catalog — the model dropdown in AIStudio will auto-clamp.
      const savedModel = settings?.aiDefaultModel;
      set({
        appVersion: version,
        platform,
        activeCompanyId: activeId,
        theme,
        appConfig: {
          bgRemovalEngine: settings?.bgRemovalEngine ?? 'local',
          removeBgApiKey: settings?.removeBgApiKey ?? null,
        },
        dataDirIsCloud: !!settings?.dataDirIsCloud,
        appMode: settings?.mode ?? 'standalone',
        ...(savedModel ? { aiSelectedModelKey: savedModel } : {}),
      });
      await get().refreshCompanies();
      if (activeId) {
        // v0.14.4: all the read paths the renderer needs at bootstrap
        // are portable to clients now. The only ones that throw in
        // client mode are mutations + ai:getCredits (provider-key
        // dependent + setup-time only); none of those run on boot.
        await Promise.all([
          get().refreshBrands(),
          get().refreshCategories(),
          get().refreshProducts(),
          get().refreshDashboard(),
          get().refreshExportProfiles(),
          get().refreshAiPrompts(),
          get().refreshAiTasks(),
        ]);
      }
      await get().refreshAiModels();

      // v0.15.3: load the attribution user map. Works in all three
      // modes — standalone returns [] (no users table populated),
      // server returns the local list, client RPCs to the server.
      try {
        const attrUsers = await window.api?.users?.listForAttribution?.();
        if (Array.isArray(attrUsers)) {
          const map = {};
          for (const u of attrUsers) if (u?.id && u?.name) map[u.id] = u.name;
          set({ attributionUsers: map });
        }
      } catch (_) { /* non-fatal; chip falls back to time-only */ }
      // Initial presence snapshot. Subsequent updates come via the
      // `onPresenceChanged` push subscription below.
      try {
        const initialPresence = await window.api?.users?.presence?.();
        if (Array.isArray(initialPresence)) set({ presence: initialPresence });
      } catch (_) { /* non-fatal */ }

      // Subscribe to live AI events from main.
      // Re-subscribe cleanly: dispose anything from a previous bootstrap so
      // listeners never stack.
      disposeAiSubscriptions();
      if (window.api?.ai?.onTaskUpdate) {
        const off = window.api.ai.onTaskUpdate((task) => get().applyTaskUpdate(task));
        if (typeof off === 'function') _aiUnsubs.push(off);
      }
      if (window.api?.ai?.onGalleryAdded) {
        const off = window.api.ai.onGalleryAdded((entry) => get().applyGalleryAdded(entry));
        if (typeof off === 'function') _aiUnsubs.push(off);
      }

      // v0.14.3: client-mode connection-state listener. Only wires up
      // when this Mac is actually a client — in standalone/server mode
      // the IPC channels don't exist (the main process registered them
      // conditionally), so we'd be subscribing to nothing.
      disposeClientSubscription();
      if ((settings?.mode === 'client') && window.api?.client?.onConnectionState) {
        // Seed initial state from a one-shot fetch before subscribing —
        // the push-based event only fires on state changes, so the chip
        // would otherwise stay 'unknown' until the next change.
        try {
          const initial = await window.api.client.connectionState();
          if (initial) set({ clientConnection: initial });
        } catch (_) { /* main hasn't wired the channel yet — keep 'unknown' */ }
        _clientUnsub = window.api.client.onConnectionState((state) => {
          set({ clientConnection: state });
        });
      }

      // v0.15.1: catalog-change subscription. Fires on every mode —
      // the local server-mode admin renderer benefits too because
      // queueRunner + write handlers all broadcast through the same
      // bus. The renderer routes by `kind` to the right refresh action.
      //
      // v0.26.44: auto-apply ALL events, including remote ones.
      // Pre-v0.26.44 we queued remote events behind a "Refresh"
      // banner (v0.22.2) so the catalog wouldn't yank out from under
      // a user mid-edit. The banner turned out to be MORE intrusive
      // than the auto-apply it was protecting against — every edit
      // by another Mac surfaced as a banner the user had to dismiss.
      // The auto-apply path is safe because:
      //   1. `applyCatalogEvent` already debounces per-slice (250ms),
      //      so a burst of 30 remote events collapses to one refetch.
      //   2. Side-panel forms keep their values in local state,
      //      not the store — typing isn't yanked.
      //   3. Optimistic concurrency (v0.17.2) catches the rare
      //      "two people edited the same row" case at save time.
      //   4. Per-edit attribution lives in the History page, so
      //      users can audit who-did-what without an inline banner.
      disposeCatalogSubscriptions();
      if (window.api?.events?.onCatalogChanged) {
        const off = window.api.events.onCatalogChanged((evt) => {
          const kind = evt?.kind;
          if (!kind) return;
          // No origin gating — apply unconditionally. The
          // originUserId field is still on `evt` for any future
          // consumer that wants to filter (and the audit log
          // records it for the History page).
          applyCatalogEvent(get, evt);
        });
        if (typeof off === 'function') _catalogUnsubs.push(off);
      }

      // v0.15.3: presence updates pushed from main. The same broadcast
      // event fires on local IPC (so the server admin's own renderer
      // sees the list update) AND on every connected WebSocket client.
      if (window.api?.events?.onPresenceChanged) {
        const off = window.api.events.onPresenceChanged((list) => {
          if (Array.isArray(list)) set({ presence: list });
        });
        if (typeof off === 'function') _catalogUnsubs.push(off);
      }

      // v0.17.1: progress events for long-running bulk operations.
      // Each event carries an id; we upsert into the map until the
      // `complete: true` event arrives, then drop the entry. Errors
      // also drop the entry but flash a toast.
      if (window.api?.events?.onProgress) {
        const off = window.api.events.onProgress((evt) => {
          if (!evt?.id) return;
          if (evt.complete) {
            set((s) => {
              const next = { ...s.progressOps };
              delete next[evt.id];
              return { progressOps: next };
            });
            if (evt.error) {
              get().addToast(evt.error, 'error');
            }
            return;
          }
          set((s) => ({ progressOps: { ...s.progressOps, [evt.id]: evt } }));
        });
        if (typeof off === 'function') _catalogUnsubs.push(off);
      }
    },
  };
}
