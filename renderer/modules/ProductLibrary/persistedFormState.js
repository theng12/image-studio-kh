// v0.49.35: tiny shared helper for "remember the user's last picks across
// runs" in the bulk modals. The three Convert / Compress / Resize modals
// got built in v0.49.34 with a reset-on-open useEffect — the rationale at
// the time was "destructive ops, force a deliberate re-pick" but in
// practice the user runs the same Resize / Compress spec across many
// product groups in a row, so reset-on-open is just friction. The same is
// true for the older bulk modals (BulkBgRemovalModal's fill colour +
// concurrency, AutoCropRunModal, etc.) — surface them through the same
// helper so persistence behaves identically everywhere.
//
// Schema versioning: each call site picks a `schemaVersion`. When you
// change a stored field's meaning (rename, retype, drop), bump the
// version — that drops older blobs on the floor so a v0.49.34 user with
// `targetFormat: 'keep'` doesn't crash a v0.49.35 modal that only accepts
// jpeg/png/webp. Pure forward-compat — no migration logic, just discard.
//
// Storage shape: `{ v: <schemaVersion>, s: <state object> }`. The wrapper
// stays at the top so we can sniff version without parsing the inner
// payload first.

/**
 * Load a persisted state blob.
 *
 * @param {string} key           localStorage key (use a dotted namespace,
 *                               e.g. "Library.bulkResize").
 * @param {object} defaults      object literal of default values; returned
 *                               as-is when nothing is stored or the schema
 *                               version mismatches.
 * @param {number} schemaVersion bump this when the shape of `defaults`
 *                               changes incompatibly. Mismatched stored
 *                               blobs are silently dropped.
 * @returns {object}             a fresh object — never returns `defaults`
 *                               by reference (so React's useState init can
 *                               mutate freely).
 */
export function loadPersistedFormState(key, defaults, schemaVersion = 1) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...defaults };
    if (parsed.v !== schemaVersion) return { ...defaults };
    // Spread defaults first so a stored blob missing a NEW field
    // (added without a schema bump because it's safe-defaulted) still
    // gets the default — partial forward-compat without a version bump.
    return { ...defaults, ...(parsed.s || {}) };
  } catch {
    return { ...defaults };
  }
}

/**
 * Save a state blob. Wraps `state` in `{ v, s }` so future reads can
 * discriminate by schema version.
 */
export function savePersistedFormState(key, state, schemaVersion = 1) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: schemaVersion, s: state }));
  } catch {
    // Quota exceeded / disabled storage — non-fatal, the modal still works.
  }
}

/**
 * Clear a persisted blob. Used by the "Reset to defaults" button so the
 * NEXT open returns to defaults instead of the previously-stored values.
 */
export function clearPersistedFormState(key) {
  try {
    localStorage.removeItem(key);
  } catch { /* non-fatal */ }
}
