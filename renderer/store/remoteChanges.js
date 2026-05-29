// Remote change queue slice (v0.22.2 → v0.26.44).
//
// History:
//   v0.22.2: introduced. Catalog-changed events from OTHER users got
//   queued here; user clicked a Refresh banner to apply. Self-events
//   bypassed this and auto-applied.
//
//   v0.26.44: REMOVED in favour of auto-apply. The banner was more
//   intrusive than the auto-apply it was protecting against (every
//   edit by another Mac surfaced a banner the user had to dismiss).
//   The auto-apply path is safe because:
//     1. `applyCatalogEvent` debounces per-slice (250ms), so a burst
//        of 30 events collapses to one refetch.
//     2. Side-panel forms keep values in LOCAL state, not the store
//        — the user's typing is never yanked.
//     3. Optimistic concurrency (v0.17.2) catches "two people edited
//        the same row" at save time.
//     4. Per-edit attribution lives in the History page — users can
//        audit who-did-what without an inline banner.
//
// This slice is kept as an empty stub so the store composition in
// `store/index.js` doesn't need to change, and so any future
// consumer can be wired without touching the store assembly. The
// no-op actions exist for backwards-compat with any caller that
// still references them (none in v0.26.44, but defensive).

export function createRemoteChangesSlice(_set, _get) {
  return {
    // Pre-v0.26.44: queue of unapplied remote events. Always empty in
    // v0.26.44+ because events apply immediately. Kept for compat
    // with the (now-deleted) RemoteChangesBanner consumer; if a
    // future build re-introduces a banner UI it can re-populate
    // this slice without touching the assembly.
    pendingRemoteChanges: { byKind: {}, byUserId: {}, total: 0, events: [] },

    /** No-op since v0.26.44. Was: replay refresh for all queued kinds. */
    applyPendingRemoteChanges() { /* intentionally empty */ },

    /** No-op since v0.26.44. Was: clear the queue without applying. */
    dismissPendingRemoteChanges() { /* intentionally empty */ },
  };
}
