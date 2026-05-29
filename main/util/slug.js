/**
 * Single source of truth for the slugify rule used across the main process:
 * imageManager (asset filenames), exportRunner (filename tokens),
 * processingPipeline (processed/<sku>/ folders), queueRunner (ai-gallery/<sku>/),
 * templateRenderer (overlay output filenames).
 *
 * Preserves the input's case — collapse non-[A-Za-z0-9] runs to '-', trim
 * leading/trailing '-', cap to 60 chars. Returns `fallback` (default '')
 * when the result would be empty — callers that don't want an empty string
 * (e.g. directory names) supply their own fallback ('unassigned',
 * 'unknown', 'asset', …).
 *
 * v0.11.6: case is now preserved. Earlier versions force-lowercased every
 * slug; user SKUs like `BF-R5232-GD` ended up as `products/bf-r5232-gd.jpg`
 * which made it harder to match files against the SKU when browsing in
 * Finder or in export filenames. Safe on macOS (case-insensitive FS — old
 * lowercase files are still found by case-insensitive existsSync). For
 * case-sensitive filesystems, the worst case is a stale lowercase
 * directory sitting next to a new mixed-case one; content-hash dedup
 * still prevents duplicate bytes from being written.
 */
function slugify(str, fallback = '') {
  const s = String(str ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

module.exports = { slugify };
