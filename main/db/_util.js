/**
 * Shared helpers for DB row-mappers. Hoisted out of per-table modules so
 * we don't keep redefining the same one-liner — and so a future fix lands
 * in one place.
 */

/**
 * Parse a value that was stored as a JSON string. Returns `fallback`
 * (and never throws) when the column is null/empty/malformed.
 */
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * v0.15.3: return the id of the user currently making this call, or
 * null when there isn't one (standalone Mac, or server admin using
 * the local renderer with no token in flight).
 *
 * Lazy-loaded via require() so this module stays usable during db
 * init, before main/server/index.js has run.
 */
function getCallerUserId() {
  try {
    const { getCurrentUserId } = require('../server');
    return getCurrentUserId?.() ?? null;
  } catch (_) {
    return null;
  }
}

module.exports = { parseJson, getCallerUserId };
