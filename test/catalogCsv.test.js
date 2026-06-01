/**
 * v0.36.0: tests for the catalog CSV/feed builder (main/util/catalogCsv.js).
 * Pure function, no native deps — always runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCatalogCsv, csvCell } = require('../main/util/catalogCsv');

const brandsById = new Map([['b1', { name: 'ROYAL' }]]);
const categoriesById = new Map([['c1', { name: 'Vases' }]]);
const PRODUCTS = [
  {
    sku: 'MR-R2400-CL', name: 'Mirror, round', brandId: 'b1', categoryId: 'c1',
    colorFinish: 'Clear', barcode: '8850000000017', priceRetail: 12.5, priceWholesale: 8,
    status: 'active', tags: ['mirror', 'round'], description: 'A round mirror',
    imageCount: 3, mainImagePath: 'KT-Ceramic/ROYAL/MR-R2400-CL/MR-R2400-CL-001.jpg',
  },
];

test('csvCell — quotes only when needed; escapes embedded quotes', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
});

test('generic format — header + resolves brand/category names + main image filename', () => {
  const csv = buildCatalogCsv({ products: PRODUCTS, brandsById, categoriesById, format: 'generic' });
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^SKU,Name,Brand,Category,/);
  assert.match(lines[1], /^MR-R2400-CL,/);
  assert.ok(lines[1].includes('ROYAL'), 'brand name resolved');
  assert.ok(lines[1].includes('Vases'), 'category name resolved');
  // Main image = basename only, not the full relative path.
  assert.ok(lines[1].includes('MR-R2400-CL-001.jpg'));
  assert.ok(!lines[1].includes('KT-Ceramic/'), 'should be filename, not full path');
});

test('shopify format — handle is lowercased + hyphenated, status maps', () => {
  const csv = buildCatalogCsv({ products: PRODUCTS, brandsById, categoriesById, format: 'shopify' });
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^Handle,Title,Body \(HTML\),Vendor,/);
  assert.ok(lines[1].startsWith('mr-r2400-cl,'), 'handle lowercased+hyphenated');
  assert.ok(lines[1].includes('active'));
});

test('shopify — inactive product maps to draft status', () => {
  const csv = buildCatalogCsv({
    products: [{ ...PRODUCTS[0], status: 'inactive' }], brandsById, categoriesById, format: 'shopify',
  });
  assert.ok(csv.trim().split('\r\n')[1].endsWith(',draft'));
});

test('google format — price gets currency suffix, condition/availability seeded', () => {
  const csv = buildCatalogCsv({ products: PRODUCTS, brandsById, categoriesById, format: 'google' });
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^id,title,description,brand,gtin,condition,availability,price,image_link,product_type$/);
  assert.ok(lines[1].includes('12.5 USD'));
  assert.ok(lines[1].includes('new'));
  assert.ok(lines[1].includes('in stock'));
});

test('empty product list — header only', () => {
  const csv = buildCatalogCsv({ products: [], format: 'generic' });
  assert.equal(csv.trim().split('\r\n').length, 1);
});
