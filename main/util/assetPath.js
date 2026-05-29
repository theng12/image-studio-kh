/**
 * Asset-path helpers for the v0.12.0 nested layout:
 *
 *   assets/<company-slug>/<brand-slug>/<sku-slug>/NNN.<ext>
 *
 * Brand icons live next to the products that use them:
 *
 *   assets/<company-slug>/_brand-icons/<brand-slug>.<ext>
 *
 * `_unassigned` is a reserved literal directory name for products with no
 * brand. The slug rule (alphanumeric + `-`) won't produce a string with a
 * leading underscore, so it can't collide with a user-named brand.
 *
 * Filenames are numbered 001, 002, 003… by current `order_index`. The
 * filename is recomputed on add / reorder / setMain / remove to keep
 * disk in lockstep with the DB.
 */

const path = require('node:path');
const { slugify } = require('./slug');

const UNASSIGNED_BRAND_DIR = '_unassigned';
const BRAND_ICONS_DIR = '_brand-icons';
const TMP_PREFIX = '__tmp-';

/** Slug for the company-level folder. Falls back to 'unknown-company'. */
function companyDir(company) {
  if (!company) throw new Error('company required to compute companyDir');
  return slugify(company.name, 'unknown-company');
}

/**
 * Slug for the brand-level folder. Returns `_unassigned` when the product
 * has no brand assigned. The literal underscore prefix is deliberately
 * unreachable by slugify (which strips leading `-`s and never emits `_`),
 * so a user can't accidentally name a brand that lands here.
 */
function brandDir(brand) {
  if (!brand) return UNASSIGNED_BRAND_DIR;
  return slugify(brand.name, UNASSIGNED_BRAND_DIR);
}

/** Slug for the product-level folder. Falls back to 'unknown-sku'. */
function skuDir(product) {
  if (!product) throw new Error('product required to compute skuDir');
  return slugify(product.sku, 'unknown-sku');
}

/**
 * Returns the relative dir for a product's images, RELATIVE TO
 * `<dataDir>/assets/`. So a returned path of `KT-Ceramic/ROYAL/BF-R5232-GD`
 * lives on disk at `<dataDir>/assets/KT-Ceramic/ROYAL/BF-R5232-GD/`.
 *
 * Crucially this does NOT include a leading `assets/` segment — the rest
 * of the codebase (protocol handler, `getAssetsDir`, the renderer's
 * `app-image://` URL builder) treats `product_images.filepath` as
 * already relative to `assets/`. v0.12.0 mistakenly included it, which
 * caused double-prefix when the protocol handler joined paths. v0.12.2
 * brings the convention back in line with v0.11.x and earlier.
 *
 * All three arguments are required (brand may be null). Uses POSIX path
 * separators because relative paths are stored in the DB and shouldn't
 * change shape between OSes.
 */
function productAssetDir(company, brand, product) {
  return path.posix.join(
    companyDir(company),
    brandDir(brand),
    skuDir(product),
  );
}

/**
 * Returns the relative dir for brand icons under a given company,
 * RELATIVE TO `<dataDir>/assets/`. So `KT-Ceramic/_brand-icons` lives
 * on disk at `<dataDir>/assets/KT-Ceramic/_brand-icons/`.
 */
function brandIconDir(company) {
  return path.posix.join(companyDir(company), BRAND_ICONS_DIR);
}

/**
 * Convert an order_index (0-based) to the canonical zero-padded suffix:
 * `0 → 001`, `1 → 002`, `19 → 020`. Used as the position suffix inside
 * the full filename basename.
 */
function indexToBasename(orderIndex) {
  return String(orderIndex + 1).padStart(3, '0');
}

/**
 * Full filename basename for a product image, e.g. `BF-R5232-GD-001`.
 * The SKU portion is embedded so the file is self-describing even when
 * pulled out of its folder (e.g. dragged into an external tool, attached
 * to an email). Position suffix uses three-digit padding for sortability.
 *
 * v0.12.1: was just `001` in v0.12.0; users wanted the SKU prefix back.
 */
function productImageBasename(product, orderIndex) {
  if (!product) throw new Error('product required for productImageBasename');
  return `${skuDir(product)}-${indexToBasename(orderIndex)}`;
}

/**
 * Reverse of productImageBasename: given a filename's stem (no ext),
 * return the position index if it matches the canonical pattern.
 * Returns null otherwise — used by boot recovery / migration to detect
 * already-correct filenames.
 */
function basenameToIndex(basename, product = null) {
  // New v0.12.1 pattern: `<sku-slug>-NNN`. If a product is supplied, we
  // can validate the prefix matches. If not, we just match the trailing
  // `-NNN` segment.
  if (product) {
    const slug = skuDir(product);
    if (basename.startsWith(`${slug}-`)) {
      const tail = basename.slice(slug.length + 1);
      const m = /^(\d{3})$/.exec(tail);
      if (m) return parseInt(m[1], 10) - 1;
    }
  }
  const trailing = /-(\d{3})$/.exec(basename);
  if (trailing) return parseInt(trailing[1], 10) - 1;
  // Pre-v0.12.1 / migration pattern: bare NNN.
  const bare = /^(\d{3})$/.exec(basename);
  if (bare) return parseInt(bare[1], 10) - 1;
  return null;
}

module.exports = {
  UNASSIGNED_BRAND_DIR,
  BRAND_ICONS_DIR,
  TMP_PREFIX,
  companyDir,
  brandDir,
  skuDir,
  productAssetDir,
  brandIconDir,
  indexToBasename,
  productImageBasename,
  basenameToIndex,
};
