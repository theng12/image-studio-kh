/**
 * v0.49.42: per-profile {INDEX} token formatting for export filenames.
 *
 * Until now {INDEX} was a hardcoded zero-padded number (2-digit, then
 * 3-digit). Export profiles can now choose:
 *   - indexPad     — how many digits to zero-pad to (1–4)
 *   - indexPrefix  — an optional literal prefix (e.g. "A" → A001, "B" → B1)
 *
 * That covers the schemes users asked for: 1/01/001/0001, and A1 / B1 /
 * A001 / B001 (the prefix is a fixed label set per profile — make a
 * separate profile per series).
 *
 * Pulled into a dependency-free helper (only standard JS) so it can be
 * unit-tested without booting Electron / sharp / better-sqlite3 — the
 * same reason main/util/backupSafety.js + slug.js stand alone. The
 * heavy exportRunner.js imports this rather than inlining the logic.
 */

const DEFAULT_PAD = 3;     // matches the asset-storage naming (indexToBasename)
const MIN_PAD = 1;
const MAX_PAD = 4;         // 0001 covers the per-product image cap with room to spare
const MAX_PREFIX_LEN = 8;

/**
 * Coerce a stored/incoming pad width into an integer in [1, 4].
 * Anything missing or junk falls back to the 3-digit default.
 */
function clampIndexPad(value) {
  // Treat null / undefined / '' as "not set" → default. (Guard before
  // Number() because Number(null) and Number('') are 0, which would
  // otherwise clamp to MIN_PAD and silently break legacy profiles that
  // stored NULL for index_pad.)
  if (value == null || value === '') return DEFAULT_PAD;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_PAD;
  return Math.min(MAX_PAD, Math.max(MIN_PAD, n));
}

/**
 * Sanitise a prefix so it can't break filenames or smuggle path
 * separators / spaces in. Keep it to alphanumerics (the realistic case
 * is a letter or two — "A", "B", "REV"), strip everything else, and cap
 * the length. Empty / non-string → '' (no prefix).
 */
function sanitizeIndexPrefix(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, MAX_PREFIX_LEN);
}

/**
 * Render the {INDEX} token for a zero-based image index.
 *
 * @param {number} imageIndex  0-based position of the image in the product.
 * @param {object} [opts]      Usually the export profile.
 * @param {number} [opts.indexPad]     1–4 (default 3).
 * @param {string} [opts.indexPrefix]  optional literal prefix.
 * @returns {string} e.g. "001", "A001", "B1", "0001".
 */
function formatIndexToken(imageIndex, opts = {}) {
  const pad = clampIndexPad(opts.indexPad);
  const prefix = sanitizeIndexPrefix(opts.indexPrefix);
  const n = Math.max(0, Math.round(Number(imageIndex) || 0)) + 1; // 1-based in filenames
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

module.exports = {
  DEFAULT_PAD,
  MIN_PAD,
  MAX_PAD,
  MAX_PREFIX_LEN,
  clampIndexPad,
  sanitizeIndexPrefix,
  formatIndexToken,
};
