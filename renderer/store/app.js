// App-level slice — process metadata (version, platform), theme, mode,
// the mirrored config subset, and the multi-user awareness state
// (attributionUsers, presence, clientConnection, progressOps).

import { applyTheme } from '../lib/theme.js';

export function createAppSlice(set, _get) {
  return {
    // — App context
    appVersion: '',
    platform: '',
    theme: 'light',
    // v0.13.0: mirror the main-process `dataDirIsCloud` flag so the
    // sidebar's footer can show an ☁ iCloud badge. Set in `refreshAppConfig`.
    dataDirIsCloud: false,
    // v0.14.0: app mode (standalone/server/client). Mirrored from config
    // so the sidebar chip + any mode-conditional UI can react.
    appMode: 'standalone',
    // v0.14.3: client-mode connection state. Pushed by main via the
    // `client:connectionState` IPC event whenever the ping loop or an
    // RPC call updates it. Only meaningful when appMode === 'client'.
    clientConnection: {
      status: 'unknown',         // 'unknown' | 'connecting' | 'connected' | 'disconnected'
      lastOkAt: 0,
      lastError: null,
      serverVersion: null,
    },
    // v0.15.3: attribution lookup. Keyed by users.id → display name.
    // Loaded once at boot (server + client modes only), refreshed when
    // a user is added / renamed via the same IPC. Standalone mode has
    // no users so this stays empty and the Attribution chip falls back
    // to "Edited 2 min ago" without a name.
    attributionUsers: {},
    // v0.15.3: presence (currently-connected WebSocket users). Updated
    // by the `users:presence` push event from main. Empty array in
    // standalone mode. The Settings page renders this.
    presence: [],
    // v0.17.1: in-flight progress for long-running bulk operations.
    // Keyed by operation id; payload `{ id, kind, done, total, phase,
    // label }`. The renderer shows a small persistent overlay; when
    // an event with `complete: true` arrives, the entry is removed.
    progressOps: {},
    // Subset of the user's config.json that the renderer needs to read on hot
    // paths (Workspace processing, etc.). Kept in the store so components can
    // react to changes without each one hitting the settings IPC. Updated by
    // bootstrap and by `refreshAppConfig()` after Settings writes.
    // v0.49.33: dropped `bgRemovalEngine` + `removeBgApiKey` — the paid
    // remove.bg engine was removed in this release. The local @imgly
    // engine is the only path now, and it doesn't need a knob in store
    // state (the renderer just calls `removeBackground(filepath)`).
    // The appConfig object stays so other config mirrors can be added
    // here later without re-introducing the field.
    appConfig: {},

    /* ─── Theme ─── */

    async setTheme(theme) {
      const next = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
      applyTheme(next);
      set({ theme: next });
      try { await window.api.settings.setOne('theme', next); }
      catch (err) { /* persistence is best-effort */ }
    },

    /**
     * Re-read the small subset of config.json we mirror in store state. Call
     * this from any module that writes to settings (e.g. when the user picks
     * a different bg-removal engine in the Workspace panel or Settings page)
     * so other consumers see the new value without a full app restart.
     */
    async refreshAppConfig() {
      if (!window.api) return;
      const cfg = await window.api.settings.getAll();
      set({
        appConfig: {},
        dataDirIsCloud: !!cfg?.dataDirIsCloud,
        appMode: cfg?.mode ?? 'standalone',
      });
    },
  };
}
