const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

function readWorkbook(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const sheets = wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    const headers = (rows[0] ?? []).map((h) => String(h ?? '').trim());
    const body = rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
    return { name, headers, rows: body, rowCount: body.length };
  });
  return { fileName: path.basename(filePath), sheets };
}

function writeProductSampleWorkbook(outputPath) {
  const headers = [
    'SKU', 'Brand', 'Barcode', 'Secondary code',
    'Name', 'Category', 'Subcategory', 'Color/Finish',
    'Description', 'Unit', 'Variant', 'Retail price', 'Wholesale price',
    'Tags', 'Status',
    // v0.49.49: logistics & sourcing — the carton + weight data off a
    // supplier's packing list. These prefill Purchase Order lines and
    // feed the landed-cost volume / weight allocation.
    'Supplier SKU', 'HS code', 'Units per carton',
    'Carton width (cm)', 'Carton height (cm)', 'Carton length (cm)',
    'Weight per unit (kg)',
  ];

  const sampleRows = [
    {
      SKU: 'SAMPLE-001 — delete this row',
      Brand: 'Demo brand',
      Barcode: '',
      'Secondary code': '',
      Name: 'Sample tile',
      Category: 'Tiles',
      Subcategory: 'Wall',
      'Color/Finish': 'Matte white',
      Description: 'A short product description.',
      Unit: 'sqm',
      Variant: '60 × 60 cm',
      'Retail price': 12.5,
      'Wholesale price': 9.2,
      Tags: 'matte, ceramic, indoor',
      Status: 'active',
      'Supplier SKU': 'FAC-TILE-6060',
      'HS code': '6907.21',
      'Units per carton': 4,
      'Carton width (cm)': 62,
      'Carton height (cm)': 12,
      'Carton length (cm)': 62,
      'Weight per unit (kg)': 8.5,
    },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(sampleRows, { header: headers }),
    'Products',
  );

  const instructions = [
    ['Column', 'Notes'],
    ['SKU', 'Required. Unique per company.'],
    ['Brand', 'Optional. Matches an existing brand by name (case-insensitive). Unknown brand names are ignored.'],
    ['Barcode', 'Optional. EAN, UPC, or other.'],
    ['Secondary code', 'Optional. Supplier code or alt SKU.'],
    ['Name', 'Product name.'],
    ['Category', 'Top-level grouping. Created automatically if it doesn\'t exist.'],
    ['Subcategory', 'Optional second level. Free text.'],
    ['Color/Finish', 'e.g. Matte White.'],
    ['Description', 'Short product description.'],
    ['Unit', 'e.g. sqm, piece, box.'],
    ['Variant', 'e.g. size, material.'],
    ['Retail price', 'Numeric. Optional.'],
    ['Wholesale price', 'Numeric. Optional.'],
    ['Tags', 'Comma-separated tags.'],
    ['Status', 'active / inactive / draft. Defaults to active.'],
    ['Supplier SKU', 'Optional. The supplier / factory item code. Prefills onto Purchase Order lines.'],
    ['HS code', 'Optional. Customs tariff code (e.g. 6907.21).'],
    ['Units per carton', 'Optional, numeric. How many pieces ship in one carton. Used for container fill % + volume-based cost allocation.'],
    ['Carton width (cm)', 'Optional, numeric. Outer carton width. Width × height × length = carton volume (CBM).'],
    ['Carton height (cm)', 'Optional, numeric. Outer carton height.'],
    ['Carton length (cm)', 'Optional, numeric. Outer carton length / depth. (Order of W/H/L does not change the volume.)'],
    ['Weight per unit (kg)', 'Optional, numeric. Gross weight of ONE piece (not the carton). Used only for weight-based cost allocation.'],
    ['', ''],
    ['How updates work', 'Rows are matched by SKU. New SKUs are inserted; existing SKUs are updated. Blank cells leave the current data alone.'],
    ['Logistics & cost', 'The Supplier SKU / HS / carton / weight columns prefill Purchase Order line items and drive the landed-cost calculator. Default supplier is set per-product in the app (not importable here).'],
    ['Images', 'Not imported via this sheet. Use Auto-match images… in the Library or attach images per product.'],
  ];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(instructions),
    'Instructions',
  );

  XLSX.writeFile(wb, outputPath);
  return outputPath;
}

module.exports = { readWorkbook, writeProductSampleWorkbook };
