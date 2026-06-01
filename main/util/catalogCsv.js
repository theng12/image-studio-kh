/**
 * v0.36.0: catalog feed / CSV builder.
 *
 * Turns the product list into a downloadable CSV in one of three column
 * layouts: a comprehensive "generic" sheet, a Shopify product-import sheet,
 * and a Google Shopping feed. Pure function (no DB, no fs) so it's trivially
 * testable and works the same in standalone / server / client mode.
 *
 * Image columns carry the MAIN image's FILENAME (not a URL) — the images
 * live locally, not on a public host, so a marketplace import either matches
 * by filename or the user fills in URLs after hosting. This is the safe,
 * connector-free version of e-commerce integration.
 */

/** RFC-4180 cell: quote if it contains a comma, quote, or newline. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  // CRLF line endings — the most broadly compatible for Excel/Sheets.
  return lines.join('\r\n') + '\r\n';
}

/** Shopify "handle": lowercase, alnum-hyphenated. */
function handle(sku) {
  return String(sku || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function mainImageName(p) {
  return p.mainImagePath ? String(p.mainImagePath).split('/').pop() : '';
}

/**
 * @param {object} args
 * @param {object[]} args.products  rows from products.list (camelCase keys)
 * @param {Map} args.brandsById     id → { name }
 * @param {Map} args.categoriesById id → { name }
 * @param {'generic'|'shopify'|'google'} [args.format='generic']
 * @returns {string} CSV text
 */
function buildCatalogCsv({ products = [], brandsById = new Map(), categoriesById = new Map(), format = 'generic' } = {}) {
  const brand = (p) => (p.brandId && brandsById.get(p.brandId)?.name) || '';
  const cat = (p) => (p.categoryId && categoriesById.get(p.categoryId)?.name) || '';
  const tags = (p) => (Array.isArray(p.tags) ? p.tags.join(', ') : '');

  if (format === 'shopify') {
    const headers = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
      'Variant SKU', 'Variant Price', 'Variant Barcode', 'Image Src', 'Status'];
    return toCsv(headers, products.map((p) => [
      handle(p.sku), p.name || '', p.description || '', brand(p), cat(p), tags(p), 'TRUE',
      p.sku || '', p.priceRetail != null ? p.priceRetail : '', p.barcode || '',
      mainImageName(p), p.status === 'inactive' ? 'draft' : 'active',
    ]));
  }

  if (format === 'google') {
    // Google Shopping product feed (CSV). image_link/link want URLs the
    // user supplies after hosting; we seed image_link with the filename.
    const headers = ['id', 'title', 'description', 'brand', 'gtin', 'condition',
      'availability', 'price', 'image_link', 'product_type'];
    return toCsv(headers, products.map((p) => [
      p.sku || '', p.name || '', p.description || '', brand(p), p.barcode || '',
      'new', 'in stock', p.priceRetail != null ? `${p.priceRetail} USD` : '',
      mainImageName(p), cat(p),
    ]));
  }

  // generic — a comprehensive, human-readable catalog sheet.
  const headers = ['SKU', 'Name', 'Brand', 'Category', 'Subcategory', 'Color/Finish', 'Variant',
    'Unit', 'Barcode', 'Secondary code', 'Retail price', 'Wholesale price', 'Status',
    'Tags', 'Description', 'Image count', 'Main image'];
  return toCsv(headers, products.map((p) => [
    p.sku || '', p.name || '', brand(p), cat(p), p.subcategory || '', p.colorFinish || '',
    p.variant || '', p.unit || '', p.barcode || '', p.secondaryCode || '',
    p.priceRetail != null ? p.priceRetail : '', p.priceWholesale != null ? p.priceWholesale : '',
    p.status || '', (Array.isArray(p.tags) ? p.tags.join('; ') : ''), p.description || '',
    p.imageCount ?? 0, mainImageName(p),
  ]));
}

module.exports = { buildCatalogCsv, csvCell };
