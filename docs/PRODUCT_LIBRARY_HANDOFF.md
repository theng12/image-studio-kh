# Product Library — Handoff Spec

A self-contained spec for building a desktop Product Library module. Hand this file to a fresh Claude Code session in a new project and it will have everything needed to reproduce the feature at ~1:1 parity.

The receiving Claude does **not** need access to the original codebase. All schemas, IPC contracts, matching rules, and the genuinely hard code are inlined.

---

## 1. Goal

Build a "Product Library" module inside an Electron + React desktop app. It must support:

1. **Manual CRUD** on products via a form (all canonical fields + dynamic price groups + dynamic custom fields).
2. **Table view + grid view** toggle with sortable / filterable rows.
3. **Sidebar filters**: by brand and by category (independent of search results).
4. **Search bar** that queries SKU, name, color/finish, tags, barcode, secondary code.
5. **Pagination** (default page size 50; options 25/50/100/200; resets on filter change).
6. **Excel/CSV import** with three steps: pick file → map columns → review results. Partial-update upsert by SKU.
7. **Sample workbook download** pre-configured for the active parent entity (price groups + custom fields columns).
8. **Auto-match images** from a folder, with smart filename matching, recursive scan, per-SKU subfolders, content-hash dedup, and a 20-image cap per product.
9. **Manual image upload** (file picker) and **clipboard paste** (⌘V / Ctrl+V).
10. **Multi-image** support: ordered array, position 0 = main. UI to set as main, reorder ←/→, remove.
11. **20-image hard cap** per product, enforced in main-process IPC.
12. **Content-addressed dedup**: same file bytes → same on-disk filename → no duplicates.

Everything is **local-first**: SQLite + on-disk asset folder, no network calls.

---

## 2. Assumed parent context

The Product Library lives **under** a parent entity (e.g. "Company", "Workspace", "Organization"). The parent provides:

- `id: string` — used as foreign key on every product row.
- `priceGroups: string[]` — e.g. `["Retail", "Wholesale", "VIP"]`. Becomes one column per group in the form and import.
- `customFields: { name: string }[]` — up to 10 user-defined product fields. Becomes one column per field.

The Product Library also assumes an **optional Brand entity**:

- `brands` table with `(id, parent_id, name, icon?, color?)`.
- Each product may have a nullable `brand_id`.

If your project doesn't yet have these, define them first or adapt the SQL below to your model. Throughout this spec, the parent FK column is `company_id` and the parent variable name is `company`. Rename freely.

---

## 3. Stack assumptions

Apply these unless the receiving project already has a stack:

| Layer | Choice |
|---|---|
| Desktop shell | Electron + `vite-plugin-electron/simple` |
| UI | React 18 + Vite |
| Styling | Tailwind CSS |
| State | Zustand (single store, action methods) |
| Local DB | `better-sqlite3` |
| Excel/CSV | SheetJS (`xlsx`) |
| Image processing | `sharp` |
| Icons | inline SVG (no icon library) |

Source code is JavaScript (`.jsx` / `.js`).

---

## 4. File layout

Files to create or extend. All paths are relative to repo root.

```
main/                              # Electron main process (CommonJS)
  db.js                            # Adds products table + bulkUpsert + categories query
  imageManager.js                  # Hash, asset import, recursive scan, smart SKU matcher
  ipc.js                           # IPC handlers for products + images + samples + files
  preload.js                       # window.api surface
  fileHandler.js                   # readWorkbook + writeWorkbook (xlsx wrappers)
  sampleGenerator.js               # Smart sample workbook builder

renderer/
  store/index.js                   # Zustand store with product + filter + page state
  components/ui.jsx                # Button, Input, Modal (Esc + backdrop), Field, Toast, Badge, EmptyState
  modules/ProductLibrary/
    index.jsx                      # Main page: sidebar + toolbar + table/grid + pagination
    ProductForm.jsx                # Add/edit modal with image grid + paste + reorder
    ImportModal.jsx                # 3-step import (pick → map → review)
    AutoMatchModal.jsx             # Info-first folder picker + results stats
```

Data folder layout (created at runtime under userData or a user-configured root):

```
data/
  <db-name>.db                     # SQLite file
  assets/
    products/                      # <sku-slug>-<10char-sha1>.<ext>
    brands/                        # (optional, if brand icons supported)
    companies/                     # (optional, if parent logos supported)
```

A custom Electron protocol — call it `app-image://` or similar — serves files under `assets/`. Renderer uses `<img src="app-image://local/<relpath>">`. Don't expose absolute paths to the renderer.

---

## 5. SQL schema

```sql
-- Products. Brand is optional. Customize the parent FK to your model.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
  sku TEXT NOT NULL,
  barcode TEXT,
  secondary_code TEXT,
  name TEXT,
  category TEXT,
  subcategory TEXT,
  color_finish TEXT,
  description TEXT,
  unit TEXT,
  images TEXT NOT NULL DEFAULT '[]',        -- JSON array of relative paths
  prices TEXT NOT NULL DEFAULT '{}',        -- JSON map: { "Retail": 25, "Wholesale": 18 }
  variants TEXT NOT NULL DEFAULT '[]',      -- JSON array (reserved; not actively used here)
  tags TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings
  custom_fields TEXT NOT NULL DEFAULT '{}', -- JSON map keyed by custom field name
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'inactive' | 'draft'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, sku)                  -- SKU is unique per parent
);

CREATE INDEX IF NOT EXISTS idx_products_company  ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_brand    ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(company_id, category);

-- App state for misc kv (active selection ids, schema_version, etc.)
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

**Migration convention:** add new product columns with the additive helper. Idempotent, safe to run every boot.

```js
function addColumnIfMissing(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// Example usage at boot:
addColumnIfMissing(db, 'products', 'barcode', 'TEXT');
addColumnIfMissing(db, 'products', 'secondary_code', 'TEXT');
```

Bump `schema_version` in `app_state` only when you need *structural* changes that require a wipe.

---

## 6. Row mapper + JSON helpers

JS object keys are camelCase; DB columns are snake_case. Always go through a mapper:

```js
function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    brandId: row.brand_id,
    sku: row.sku,
    barcode: row.barcode,
    secondaryCode: row.secondary_code,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    colorFinish: row.color_finish,
    description: row.description,
    unit: row.unit,
    images: parseJson(row.images, []),
    prices: parseJson(row.prices, {}),
    variants: parseJson(row.variants, []),
    tags: parseJson(row.tags, []),
    customFields: parseJson(row.custom_fields, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

---

## 7. Products CRUD (main process)

```js
const products = {
  list(companyId, { category, brandId, search, status } = {}) {
    let sql = 'SELECT * FROM products WHERE company_id = ?';
    const params = [companyId];
    if (category) { sql += ' AND category = ?'; params.push(category); }
    if (brandId === null) { sql += ' AND brand_id IS NULL'; }
    else if (brandId)     { sql += ' AND brand_id = ?'; params.push(brandId); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (search) {
      sql += ' AND (sku LIKE ? OR name LIKE ? OR color_finish LIKE ? OR tags LIKE ? OR barcode LIKE ? OR secondary_code LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term);
    }
    sql += ' ORDER BY category, name';
    return getDb().prepare(sql).all(...params).map(rowToProduct);
  },
  get(id) { /* SELECT * FROM products WHERE id = ?  → rowToProduct */ },
  getBySku(companyId, sku) { /* same WHERE company_id = ? AND sku = ? */ },
  create(input) { /* INSERT with all columns; returns products.get(id) */ },
  update(id, patch) {
    // Merge with existing record, JSON.stringify the array/object fields,
    // run UPDATE … SET … WHERE id = ?
  },
  remove(id) { /* DELETE FROM products WHERE id = ? */ },
  categories(companyId) {
    return getDb().prepare(
      `SELECT DISTINCT category FROM products
       WHERE company_id = ? AND category IS NOT NULL AND category != ''
       ORDER BY category COLLATE NOCASE`
    ).all(companyId).map(r => r.category);
  },

  // ⭐ Critical: partial-update upsert.
  bulkUpsert(companyId, rows, defaultBrandId = null) {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO products (
        id, company_id, brand_id, sku, barcode, secondary_code, name, category, subcategory,
        color_finish, description, unit, images, prices, variants, tags, custom_fields,
        status, created_at, updated_at
      ) VALUES (
        @id, @companyId, @brandId, @sku, @barcode, @secondaryCode, @name, @category, @subcategory,
        @colorFinish, @description, @unit, @images, @prices, @variants, @tags, @customFields,
        @status, @createdAt, @updatedAt
      )
      ON CONFLICT(company_id, sku) DO UPDATE SET
        brand_id = excluded.brand_id,
        barcode = excluded.barcode,
        secondary_code = excluded.secondary_code,
        name = excluded.name,
        category = excluded.category,
        subcategory = excluded.subcategory,
        color_finish = excluded.color_finish,
        description = excluded.description,
        unit = excluded.unit,
        prices = excluded.prices,
        tags = excluded.tags,
        custom_fields = excluded.custom_fields,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);

    const tx = db.transaction((items) => {
      let inserted = 0, updated = 0;
      for (const row of items) {
        const existing = products.getBySku(companyId, row.sku);
        const ts = Date.now();

        // ⭐ Partial-update merge: every field falls back to the existing
        // value when the import row doesn't supply one. Empty cells in the
        // spreadsheet were already stripped upstream, so an absent field
        // here means "the user didn't touch this column for this row".
        const mergedPrices = { ...(existing?.prices ?? {}), ...(row.prices ?? {}) };
        const mergedCustom = { ...(existing?.customFields ?? {}), ...(row.customFields ?? {}) };
        const nextTags = row.tags && row.tags.length ? row.tags : (existing?.tags ?? []);

        insert.run({
          id: existing?.id ?? crypto.randomUUID(),
          companyId,
          brandId:       row.brandId       ?? defaultBrandId ?? existing?.brandId       ?? null,
          sku:           row.sku,
          barcode:       row.barcode       ?? existing?.barcode       ?? null,
          secondaryCode: row.secondaryCode ?? existing?.secondaryCode ?? null,
          name:          row.name          ?? existing?.name          ?? null,
          category:      row.category      ?? existing?.category      ?? null,
          subcategory:   row.subcategory   ?? existing?.subcategory   ?? null,
          colorFinish:   row.colorFinish   ?? existing?.colorFinish   ?? null,
          description:   row.description   ?? existing?.description   ?? null,
          unit:          row.unit          ?? existing?.unit          ?? null,
          images:        JSON.stringify(existing?.images ?? []),   // images never touched by import
          prices:        JSON.stringify(mergedPrices),
          variants:      JSON.stringify(existing?.variants ?? []),
          tags:          JSON.stringify(nextTags),
          customFields:  JSON.stringify(mergedCustom),
          status:        row.status        ?? existing?.status        ?? 'active',
          createdAt:     existing?.createdAt ?? ts,
          updatedAt:     ts,
        });

        if (existing) updated++; else inserted++;
      }
      return { inserted, updated };
    });

    return tx(rows);
  },
};
```

**Why this matters:** if a user re-imports a CSV that only has SKU + Barcode columns, the naive `row.name ?? null` would blank the name. The merge above preserves it.

---

## 8. Asset storage + content-hash dedup

### Folder layout

```
<dataDir>/assets/products/<sku-slug>-<10-char-sha1>.<ext>
```

- `<sku-slug>` = lowercased, hyphen-separated, max 60 chars: `slugify(sku)`.
- `<10-char-sha1>` = first 10 hex chars of SHA-1 of the **source file's bytes**.
- `<ext>` = `.jpg`, `.png`, `.webp`, or `.svg` (svg is copied verbatim; others go through sharp).

**Dedup invariant:** same file bytes → same hash → same filename → same on-disk file. Re-importing an identical image is a no-op. The product's image array is also dedup'd (skip insert if relative path already present).

### Image manager (main process)

```js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const KIND_MAX_DIMENSION = { products: 1600, brands: 512, companies: 1024 };
const HASH_PREFIX_LEN = 10;
const SCAN_MAX_DEPTH = 5;
const MAX_IMAGES_PER_PRODUCT = 20;

function slugify(str, fallback = 'asset') {
  return (String(str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)) || fallback;
}

function sha1Hex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function importAsset(kind, sourcePath, slugHint) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Asset source not found');
  }
  const destDir = getAssetsDir(kind);   // <dataDir>/assets/<kind>/, mkdir -p
  const ext = path.extname(sourcePath).toLowerCase();
  const hashFull = await sha1Hex(sourcePath);
  const hash = hashFull.slice(0, HASH_PREFIX_LEN);

  if (ext === '.svg') {
    const fileName = `${slugify(slugHint, kind)}-${hash}.svg`;
    const destAbs = path.join(destDir, fileName);
    if (fs.existsSync(destAbs)) {
      return { relativePath: `${kind}/${fileName}`, skipped: true, hash: hashFull };
    }
    fs.copyFileSync(sourcePath, destAbs);
    return { relativePath: `${kind}/${fileName}`, skipped: false, hash: hashFull };
  }

  const outExt = ext === '.png' ? '.png' : ext === '.webp' ? '.webp' : '.jpg';
  const fileName = `${slugify(slugHint, kind)}-${hash}${outExt}`;
  const destAbs = path.join(destDir, fileName);
  if (fs.existsSync(destAbs)) {
    return { relativePath: `${kind}/${fileName}`, skipped: true, hash: hashFull };
  }

  const max = KIND_MAX_DIMENSION[kind] ?? 1600;
  const pipeline = sharp(sourcePath).rotate().resize({
    width: max, height: max, fit: 'inside', withoutEnlargement: true,
  });
  if (outExt === '.png')   await pipeline.png({ compressionLevel: 9 }).toFile(destAbs);
  else if (outExt === '.webp') await pipeline.webp({ quality: 85 }).toFile(destAbs);
  else                     await pipeline.jpeg({ quality: 85, mozjpeg: true }).toFile(destAbs);

  return { relativePath: `${kind}/${fileName}`, skipped: false, hash: hashFull };
}

const importProductImage = (src, sku) => importAsset('products', src, sku);

// Used by the clipboard paste path. Writes bytes to a temp file, then funnels
// through the normal pipeline so dedup + resize still apply.
async function importProductImageFromBytes(buffer, ext, sku) {
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-'));
  const safeExt = (ext || '.png').toLowerCase().replace(/^[^.]/, m => '.' + m);
  const tmpPath = path.join(tmpDir, `paste${safeExt}`);
  fs.writeFileSync(tmpPath, Buffer.from(buffer));
  try {
    return await importProductImage(tmpPath, sku);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  MAX_IMAGES_PER_PRODUCT,
  importAsset, importProductImage, importProductImageFromBytes,
  sha1Hex, /* scanImagesRecursive + matchers below */
};
```

### Custom protocol (Electron main)

Register **before** `app.whenReady()`:

```js
const { protocol } = require('electron');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-image', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
```

Then, after ready:

```js
const { net } = require('electron');
const url = require('node:url');

protocol.handle('app-image', (request) => {
  try {
    const stripped = request.url.replace(/^app-image:\/\/local\//, '');
    const decoded = decodeURIComponent(stripped); // ⭐ component, not URI — slashes are encoded
    const abs = path.isAbsolute(decoded)
      ? decoded
      : path.join(getAssetsDir(), decoded);       // <dataDir>/assets/<rel>
    if (!fs.existsSync(abs)) return new Response(null, { status: 404 });
    return net.fetch(url.pathToFileURL(abs).toString());
  } catch (err) {
    console.error('[app-image] handler error', err);
    return new Response(null, { status: 500 });
  }
});
```

Renderer references images via `app-image://local/<encodeURIComponent(relpath)>`.

**Important:** use `decodeURIComponent` on the server side. `decodeURI` won't decode `%2F` (the encoded `/` in subdir paths like `products/abc.jpg`) and lookups will fail silently.

---

## 9. Smart filename matching (auto-match images)

The matcher takes a folder, recursively scans for images, and figures out which SKU each file belongs to plus its position hint within that SKU's image array.

### Supported patterns (case-insensitive, all separators interchangeable)

For a SKU `abc-123`:

| Filename / Path | Result |
|---|---|
| `abc-123.jpg` | SKU `abc-123`, position 1 (main) |
| `abc-123-1.jpg`, `abc-123_1.jpg`, `abc-123 1.jpg` | SKU `abc-123`, position 1 |
| `abc-123-2.jpg`, `abc-123-3.jpg`, … | SKU `abc-123`, position 2, 3, … |
| `ABC-123.JPG` | matches `abc-123`, case-insensitive |
| `abc-123/main.jpg`, `abc-123/primary.jpg`, `abc-123/cover.jpg` | SKU `abc-123`, position 1 |
| `abc-123/2.jpg`, `abc-123/3.jpg` | SKU `abc-123`, positions 2, 3 |
| `abc-123/photo-2.jpg` | SKU `abc-123`, position 2 (suffix wins inside subfolder) |
| `abc-123/anything.jpg` | SKU `abc-123`, fallback position 999 (alphabetical) |

Files that don't match any SKU end up in an `unmatched` list reported back to the UI.

### Code

```js
function scanImagesRecursive(rootPath, maxDepth = 5) {
  const results = [];
  if (!rootPath || !fs.existsSync(rootPath)) return results;
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;           // skip dotfiles/hidden dirs
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTS.has(ext)) results.push(full);
      }
    }
  }
  walk(rootPath, 0);
  return results;
}

function findCandidateSku(filePath, importRoot, skuSet) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const lowerBase = baseName.toLowerCase().trim();
  const parentDirAbs = path.dirname(filePath);
  const parentName = path.basename(parentDirAbs).toLowerCase().trim();

  // 1. Direct full-name match
  if (skuSet.has(lowerBase)) {
    return { sku: lowerBase, indexHint: 1, sortKey: lowerBase };
  }

  // 2. Trailing numeric suffix: abc-123-2 / abc-123_2 / "abc-123 2"
  const suffixMatch = lowerBase.match(/^(.*?)[-_\s](\d+)$/);
  if (suffixMatch) {
    const [, prefix, num] = suffixMatch;
    if (skuSet.has(prefix)) {
      return { sku: prefix, indexHint: parseInt(num, 10), sortKey: lowerBase };
    }
  }

  // 3. Parent folder named after the SKU (must not be the import root itself)
  if (path.resolve(parentDirAbs) !== path.resolve(importRoot) && skuSet.has(parentName)) {
    if (/^\d+$/.test(lowerBase)) {
      return { sku: parentName, indexHint: parseInt(lowerBase, 10), sortKey: lowerBase };
    }
    if (lowerBase === 'main' || lowerBase === 'primary' || lowerBase === 'cover') {
      return { sku: parentName, indexHint: 1, sortKey: lowerBase };
    }
    if (suffixMatch) {
      return { sku: parentName, indexHint: parseInt(suffixMatch[2], 10), sortKey: lowerBase };
    }
    return { sku: parentName, indexHint: 999, sortKey: lowerBase };
  }

  return null;
}

function groupAndSortMatches(filePaths, importRoot, skuSet) {
  const groups = new Map();   // sku → [{ sourcePath, indexHint, sortKey }]
  const unmatched = [];
  for (const file of filePaths) {
    const c = findCandidateSku(file, importRoot, skuSet);
    if (!c) { unmatched.push(file); continue; }
    if (!groups.has(c.sku)) groups.set(c.sku, []);
    groups.get(c.sku).push({
      sourcePath: file,
      indexHint: c.indexHint ?? 999,
      sortKey:   c.sortKey  ?? path.basename(file).toLowerCase(),
    });
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      if (a.indexHint !== b.indexHint) return a.indexHint - b.indexHint;
      return a.sortKey.localeCompare(b.sortKey);
    });
  }
  return { groups, unmatched };
}
```

---

## 10. IPC contracts

All channels follow `domain:action`. Main throws `new Error('…')` on failure; renderer catches and surfaces via toast.

### Products

| Channel | Payload | Returns |
|---|---|---|
| `products:list` | `{ companyId, filters: { search, category, brandId, status } }` | `Product[]` |
| `products:get` | `productId` | `Product \| null` |
| `products:create` | `Partial<Product> & { companyId, sku }` | new `Product` |
| `products:update` | `{ id, patch: Partial<Product> }` | updated `Product` |
| `products:remove` | `productId` | `true` |
| `products:bulkUpsert` | `{ companyId, rows: ImportRow[], defaultBrandId? }` | `{ inserted, updated }` |
| `products:categories` | `companyId` | `string[]` |

### Images

| Channel | Payload | Returns |
|---|---|---|
| `images:importForProduct` | `{ productId, sourcePath }` | updated `Product` |
| `images:importFromBytes` | `{ productId, bytes: ArrayBuffer, ext: '.png' \| … }` | updated `Product` |
| `images:autoMatchBySku` | `{ companyId, folderPath }` | match-stats (see §11) |
| `images:setMainImage` | `{ productId, imagePath }` | updated `Product` |
| `images:reorderImages` | `{ productId, newOrder: string[] }` | updated `Product` |
| `images:removeFromProduct` | `{ productId, imagePath }` | updated `Product` |

All image handlers must enforce `MAX_IMAGES_PER_PRODUCT`. `images:reorderImages` must validate `newOrder` is a permutation of the existing array (same length, same set).

### Files

| Channel | Payload | Returns |
|---|---|---|
| `files:pickWorkbook` | — | `string \| null` (absolute path) |
| `files:parseWorkbook` | `path` | `{ fileName, sheets: [{ name, headers, rows, rowCount }] }` |
| `files:pickFolder` | — | `string \| null` |

### Samples

| Channel | Payload | Returns |
|---|---|---|
| `samples:generateProductSheet` | `{ companyId }` | `string \| null` (saved-to path) |

The sample handler runs `dialog.showSaveDialog` internally, then writes the workbook (see §13).

---

## 11. `images:autoMatchBySku` — return shape

```ts
{
  productsTouched: number,    // products that received at least one new image
  imagesImported: number,
  imagesSkippedDup: number,   // already on disk (hash match) OR already on this product's array
  imagesSkippedCap: number,   // dropped because they would push the product past 20
  unmatchedFiles: number,     // files in folder that didn't match any SKU
  scannedFiles: number,       // total images found in the folder tree
  totalProducts: number,
  matchedSkus: number,
  maxImagesPerProduct: 20,
}
```

### Handler logic (essential parts)

```js
ipcMain.handle('images:autoMatchBySku', async (_e, { companyId, folderPath }) => {
  const list = db.products.list(companyId);
  const skuToProduct = new Map(list.map(p => [p.sku.toLowerCase(), p]));
  const skuSet = new Set(skuToProduct.keys());

  const allImages = imageManager.scanImagesRecursive(folderPath);
  const { groups, unmatched } = imageManager.groupAndSortMatches(allImages, folderPath, skuSet);

  let productsTouched = 0, imagesImported = 0, imagesSkippedDup = 0, imagesSkippedCap = 0;
  const MAX = imageManager.MAX_IMAGES_PER_PRODUCT;

  for (const [sku, candidates] of groups) {
    const product = skuToProduct.get(sku);
    if (!product) continue;

    // Cap each SKU's incoming list before importing.
    const capped = candidates.slice(0, MAX);
    imagesSkippedCap += candidates.length - capped.length;

    const matchedRelPaths = [];
    let touched = false;
    for (const c of capped) {
      const { relativePath, skipped } = await imageManager.importProductImage(c.sourcePath, product.sku);
      if (matchedRelPaths.includes(relativePath)) { imagesSkippedDup++; continue; }
      matchedRelPaths.push(relativePath);
      const wasOnProduct = (product.images ?? []).includes(relativePath);
      if (skipped || wasOnProduct) imagesSkippedDup++;
      else { imagesImported++; touched = true; }
    }

    // Matched files first (lowest indexHint becomes main), then keep
    // existing images that weren't part of this match. Truncate to cap.
    const existing = product.images ?? [];
    const keep = existing.filter(p => !matchedRelPaths.includes(p));
    const combined = [...matchedRelPaths, ...keep];
    const truncated = combined.slice(0, MAX);
    imagesSkippedCap += combined.length - truncated.length;

    if (JSON.stringify(truncated) !== JSON.stringify(existing)) {
      db.products.update(product.id, { images: truncated });
      if (touched) productsTouched++;
    }
  }

  return {
    productsTouched, imagesImported, imagesSkippedDup, imagesSkippedCap,
    unmatchedFiles: unmatched.length, scannedFiles: allImages.length,
    totalProducts: list.length, matchedSkus: groups.size,
    maxImagesPerProduct: MAX,
  };
});
```

---

## 12. Workbook reader / writer

Use SheetJS. Read returns one normalized shape per sheet:

```js
const XLSX = require('xlsx');
const fs = require('node:fs');
const path = require('node:path');

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
```

---

## 13. Sample workbook generator

Sample is **per-parent-entity** — its columns reflect the parent's price groups + custom fields. Emits two sheets: `Products` (placeholder row) and `Instructions` (column descriptions).

```js
const XLSX = require('xlsx');

function generateSample(company, outputPath) {
  if (!company) throw new Error('Company required');
  const priceCols  = (company.priceGroups ?? ['Retail']).map((g) => `Price_${g}`);
  const customCols = (company.customFields ?? []).map((c) => c.name ?? c);

  const headers = [
    'SKU', 'Brand', 'Barcode', 'Secondary code',
    'Name', 'Category', 'Subcategory', 'Color/Finish', 'Description', 'Unit',
    ...priceCols, ...customCols, 'Tags',
  ];

  const placeholder = (h) => h === 'SKU' ? 'SAMPLE-001 — delete this row before importing' : '';
  const sampleRow = Object.fromEntries(headers.map(h => [h, placeholder(h)]));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([sampleRow], { header: headers }), 'Products');

  const instructions = [
    ['Column', 'Notes'],
    ['SKU', 'Required. Unique per company.'],
    ['Brand', 'Optional. Matches an existing brand by name; unmatched values become unassigned.'],
    ['Barcode', 'Optional. EAN/UPC or other.'],
    ['Secondary code', 'Optional. Supplier code or alt SKU.'],
    ['Name', 'Product name'],
    ['Category', 'Top-level grouping'],
    ['Subcategory', 'Optional second level'],
    ['Color/Finish', 'e.g. Matte White'],
    ['Description', 'Short product description'],
    ['Unit', 'e.g. sqm, piece, box'],
    ...priceCols.map(c => [c, 'Numeric. Optional.']),
    ...customCols.map(c => [c, 'Custom company field']),
    ['Tags', 'Comma-separated tags'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');

  XLSX.writeFile(wb, outputPath);
  return outputPath;
}
```

---

## 14. Preload surface

```js
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch, p) => ipcRenderer.invoke(ch, p);

contextBridge.exposeInMainWorld('api', {
  products: {
    list:        (companyId, filters)    => invoke('products:list', { companyId, filters }),
    get:         (id)                    => invoke('products:get', id),
    create:      (input)                 => invoke('products:create', input),
    update:      (id, patch)             => invoke('products:update', { id, patch }),
    remove:      (id)                    => invoke('products:remove', id),
    bulkUpsert:  (companyId, rows, defaultBrandId) =>
                   invoke('products:bulkUpsert', { companyId, rows, defaultBrandId }),
    categories:  (companyId)             => invoke('products:categories', companyId),
  },
  images: {
    importForProduct:    (productId, sourcePath)         => invoke('images:importForProduct', { productId, sourcePath }),
    importFromBytes:     (productId, bytes, ext)         => invoke('images:importFromBytes', { productId, bytes, ext }),
    autoMatchBySku:      (companyId, folderPath)         => invoke('images:autoMatchBySku', { companyId, folderPath }),
    setMainImage:        (productId, imagePath)          => invoke('images:setMainImage', { productId, imagePath }),
    reorderImages:       (productId, newOrder)           => invoke('images:reorderImages', { productId, newOrder }),
    removeFromProduct:   (productId, imagePath)          => invoke('images:removeFromProduct', { productId, imagePath }),
  },
  files: {
    pickWorkbook:   () => invoke('files:pickWorkbook'),
    parseWorkbook:  (p) => invoke('files:parseWorkbook', p),
    pickFolder:     () => invoke('files:pickFolder'),
  },
  samples: {
    generateProductSheet: (companyId) => invoke('samples:generateProductSheet', { companyId }),
  },
});
```

Keep `contextIsolation: true`, `nodeIntegration: false`. Renderer never imports Node modules directly.

---

## 15. Zustand store

```js
import { create } from 'zustand';
const api = () => window.api;

export const useAppStore = create((set, get) => ({
  // — Active context (provided by your parent module)
  activeCompanyId: null,
  brands: [],

  // — Products
  products: [],
  productFilters: { search: '', category: null, brandId: undefined, status: null },
  selectedCategory: null,
  selectedBrandId: undefined,         // undefined = no brand filter, null = unassigned only
  categoriesAll: [],                  // independent of filters, for sidebar

  setProductSearch(search) {
    set((s) => ({ productFilters: { ...s.productFilters, search } }));
    get().refreshProducts();
  },
  setSelectedCategory(category) {
    set((s) => ({
      selectedCategory: category,
      productFilters: { ...s.productFilters, category: category || null },
    }));
    get().refreshProducts();
  },
  setSelectedBrand(brandId) {
    set((s) => ({
      selectedBrandId: brandId,
      productFilters: { ...s.productFilters, brandId },
    }));
    get().refreshProducts();
  },

  async refreshAllCategories() {
    const id = get().activeCompanyId;
    if (!id) return set({ categoriesAll: [] });
    set({ categoriesAll: await api().products.categories(id) });
  },
  async refreshProducts() {
    const { activeCompanyId, productFilters } = get();
    if (!activeCompanyId) return set({ products: [] });
    set({ products: await api().products.list(activeCompanyId, productFilters) });
  },

  async createProduct(input) {
    const created = await api().products.create({ ...input, companyId: get().activeCompanyId });
    await get().refreshAllCategories();
    await get().refreshProducts();
    return created;
  },
  async updateProduct(id, patch) {
    const updated = await api().products.update(id, patch);
    await get().refreshAllCategories();
    await get().refreshProducts();
    return updated;
  },
  async removeProduct(id) {
    await api().products.remove(id);
    await get().refreshAllCategories();
    await get().refreshProducts();
  },
  async bulkUpsertProducts(rows, defaultBrandId = null) {
    const id = get().activeCompanyId;
    const result = await api().products.bulkUpsert(id, rows, defaultBrandId);
    await get().refreshAllCategories();
    await get().refreshProducts();
    return result;
  },
}));
```

Plug in brand-related state from your existing module if you have a Brand entity; if not, drop the brand filter UI.

---

## 16. UI — ProductLibrary/index.jsx

Layout:

```
┌──────────┬─────────────────────────────────────────────────┐
│ Sidebar  │ Toolbar: search · view toggle · auto-match ·    │
│  Brand   │   download sample · import · + new product      │
│  filter  ├─────────────────────────────────────────────────┤
│          │                                                  │
│  Cat-    │ Table or grid (paginated)                        │
│  egory   │                                                  │
│  filter  │                                                  │
│          ├─────────────────────────────────────────────────┤
│  Missing │ Pagination footer: X–Y of Z · page size · ←/→  │
│  images  │                                                  │
└──────────┴─────────────────────────────────────────────────┘
```

### Behaviors

- **Sidebar brand list** comes from a shared `brands` store slice. Three pseudo-buckets at the top: "All brands" (`undefined`), each brand, and "Unassigned" (`null`).
- **Sidebar category list** uses `categoriesAll` — fetched independently via `products.categories(companyId)` so it does not shrink when a filter is applied.
- **Search input** is debounced/uncontrolled but updates filter on every change (`setProductSearch`).
- **View toggle** flips between table and grid; persisted only in component state.
- **Pagination**:
  - `page` (0-indexed) and `pageSize` (default 50; options 25/50/100/200).
  - `useEffect` to reset `page = 0` whenever any of `search`, `selectedCategory`, `selectedBrandId`, `pageSize` change.
  - `useEffect` to clamp `page` when `products.length` shrinks below the current page boundary.
  - Footer shows `Showing X–Y of Z` + page size dropdown + prev/next + current/total.
- **Table columns**: thumbnail · SKU · brand (with icon if present) · name · category · color/finish · prices (e.g. `Retail: 25 • Wholesale: 18`) · status badge · edit/delete.
- **Grid view**: square thumbnail per product with SKU bold, name, color/finish underneath; brand icon overlay top-right if present.
- **"+ New product"** opens `<ProductForm product={null} />`.
- **Clicking a row / card** opens `<ProductForm product={p} />` for edit.
- **Auto-match images…** opens `<AutoMatchModal />`.
- **Download sample** calls `window.api.samples.generateProductSheet(companyId)`; success toast shows the saved path; error toast shows the message.
- **Import Excel/CSV** opens `<ImportModal />`.
- **Delete** uses `window.confirm` before calling `removeProduct`.
- **Missing-images badge** in sidebar shows count of products with empty `images` arrays.

---

## 17. UI — ProductForm.jsx (add/edit modal)

Form fields (grid of two columns on desktop):

1. SKU * (required, disabled save when empty)
2. Brand (select; "— Unassigned —" first)
3. Barcode (optional)
4. Secondary code (optional)
5. Name
6. Category
7. Subcategory
8. Color / Finish
9. Unit (placeholder: `e.g. sqm, piece, box`)
10. Status (select: active / inactive / draft)
11. Tags (comma-separated input)
12. Description (textarea, 2 rows, full-width)

Then a **Prices** section: one numeric input per `company.priceGroups`. Empty value = unset.

Then a **Custom fields** section: one text input per `company.customFields[i].name`.

Then an **Images** section (full-width):

- Header reads `Images  3 / 20` (current count / cap).
- `+ Add image` button (disabled at cap), and a tip line:
  > Tip: with the product open, you can paste an image directly from the clipboard (⌘V). Re-importing the same image is detected and skipped automatically.
- Empty state if no images.
- Otherwise a grid of square thumbnails. For each:
  - `Main` green badge on position 0; on hover for non-position-0, a `Set as main` button appears in the same spot.
  - `✕` (top-right) to remove. `aria-label="Remove image"`.
  - On hover: bottom-row controls `← #N →` for reorder.

### Paste handler

Attach `onPaste` to the form's outer `<div>` (the grid wrapper):

```jsx
const handlePaste = async (e) => {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imageItem = items.find((it) => it.type.startsWith('image/'));
  if (!imageItem) return;          // not an image — let default text behavior happen
  e.preventDefault();
  if (!product) {
    window.alert('Save the product first, then paste images.');
    return;
  }
  if (form.images.length >= MAX_IMAGES_PER_PRODUCT) {
    window.alert(`This product already has the maximum of ${MAX_IMAGES_PER_PRODUCT} images.`);
    return;
  }
  const blob = imageItem.getAsFile();
  if (!blob) return;
  try {
    const buf = await blob.arrayBuffer();
    const subtype = (blob.type.split('/')[1] || 'png').toLowerCase();
    const ext = subtype === 'jpeg' ? '.jpg' : `.${subtype}`;
    const updated = await window.api.images.importFromBytes(product.id, buf, ext);
    setForm((f) => ({ ...f, images: updated.images }));
    useAppStore.getState().refreshProducts();
  } catch (err) {
    window.alert(`Couldn't paste image: ${err.message}`);
  }
};
```

### Reorder + set-as-main + remove

```jsx
const handleMoveImage = async (imagePath, direction) => {
  if (!product) return;
  const idx = form.images.indexOf(imagePath);
  const target = idx + direction;
  if (idx < 0 || target < 0 || target >= form.images.length) return;
  const next = [...form.images];
  [next[idx], next[target]] = [next[target], next[idx]];
  const updated = await window.api.images.reorderImages(product.id, next);
  setForm((f) => ({ ...f, images: updated.images }));
  useAppStore.getState().refreshProducts();
};

const handleSetMain = async (imagePath) => {
  const updated = await window.api.images.setMainImage(product.id, imagePath);
  setForm((f) => ({ ...f, images: updated.images }));
};

const handleRemoveImage = async (imagePath) => {
  const updated = await window.api.images.removeFromProduct(product.id, imagePath);
  setForm((f) => ({ ...f, images: updated.images }));
};
```

**Save** sends a single `update` (or `create`) with all fields. `companyId` is set from store on create.

```js
const payload = {
  sku: form.sku.trim(),
  barcode: form.barcode.trim() || null,
  secondaryCode: form.secondaryCode.trim() || null,
  brandId: form.brandId || null,
  name: form.name.trim(),
  category: form.category.trim() || null,
  subcategory: form.subcategory.trim() || null,
  colorFinish: form.colorFinish.trim() || null,
  description: form.description.trim() || null,
  unit: form.unit.trim() || null,
  tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
  status: form.status,
  prices: form.prices,
  customFields: form.customFields,
};
```

---

## 18. UI — ImportModal.jsx (3-step import)

Steps tracked as a local `step` state: `'pick' | 'map' | 'review'`.

### Step 'pick'

- Brief explainer of the flow.
- Big "Choose file…" button → calls `files.pickWorkbook()` then `files.parseWorkbook(path)`. Sets `workbook` state, auto-runs auto-guess on each header, sets `sheetIdx = 0`, advances to `'map'`.
- Below: a dashed-border "First time?" card with a `Download sample` button (calls `samples.generateProductSheet(companyId)`).

### Step 'map'

- If `workbook.sheets.length > 1`, a sheet selector.
- If brands exist, a **Default brand** dropdown (applied to any row that doesn't supply one).
- A muted explainer card titled "How updates work":
  > Rows are matched to existing products by SKU. New SKUs are inserted. For existing SKUs, only the fields you provide a value for are overwritten — blank cells and skipped columns leave the current data alone. Prices and custom fields are merged (e.g. updating Price_Wholesale doesn't touch Price_Retail). Product images and variants are never touched by import.
- A scrollable table with one row per spreadsheet header: column name · first sample value · target-field dropdown.
- Footer button **Import N rows** disabled until SKU is mapped.

### Auto-guess

```js
const PRODUCT_FIELDS = [
  { key: '__skip__', label: '— Skip —' },
  { key: 'sku',           label: 'SKU *', required: true },
  { key: 'barcode',       label: 'Barcode' },
  { key: 'secondaryCode', label: 'Secondary code' },
  { key: 'name',          label: 'Name' },
  { key: 'category',      label: 'Category' },
  { key: 'subcategory',   label: 'Subcategory' },
  { key: 'colorFinish',   label: 'Color / Finish' },
  { key: 'description',   label: 'Description' },
  { key: 'unit',          label: 'Unit' },
  { key: 'tags',          label: 'Tags (comma-separated)' },
  { key: 'status',        label: 'Status' },
  { key: 'brand',         label: 'Brand (by name)' },
];

function autoGuess(header, priceGroups, customFields) {
  const h = header.toLowerCase().trim();
  if (!h) return '__skip__';
  if (h === 'sku' || h === 'code' || h === 'item code') return 'sku';
  if (h === 'barcode' || h === 'bar code' || h === 'ean' || h === 'upc') return 'barcode';
  if (['secondary code', 'secondary_code', 'alt sku', 'alt code',
       'supplier code', 'supplier_code'].includes(h)) return 'secondaryCode';
  if (h === 'name' || h === 'product' || h === 'product name') return 'name';
  if (h === 'category') return 'category';
  if (h === 'subcategory' || h === 'sub-category') return 'subcategory';
  if (h.includes('color') || h.includes('finish')) return 'colorFinish';
  if (h === 'description' || h === 'desc') return 'description';
  if (h === 'unit') return 'unit';
  if (h === 'tags') return 'tags';
  if (h === 'status') return 'status';
  if (h === 'brand') return 'brand';
  for (const g of priceGroups) {
    const gl = g.toLowerCase();
    if (h === `price_${gl}` || h === gl || h === `price ${gl}`) return `price:${g}`;
  }
  for (const c of customFields) {
    const cl = c.toLowerCase();
    if (h === cl || h === cl.replace(/\s+/g, '_')) return `custom:${c}`;
  }
  return '__skip__';
}
```

### Import row builder (renderer side)

```js
const brandsByName = new Map(brands.map((b) => [b.name.toLowerCase(), b.id]));
const rows = sheet.rows.map((row) => {
  const out = { prices: {}, customFields: {} };
  for (const header of sheet.headers) {
    const field = mapping[header];
    const value = row[header];
    if (!field || field === '__skip__') continue;
    if (value === '' || value == null) continue;
    if (field.startsWith('price:')) {
      const group = field.slice(6);
      const num = Number(value);
      out.prices[group] = Number.isFinite(num) ? num : value;
    } else if (field.startsWith('custom:')) {
      out.customFields[field.slice(7)] = value;
    } else if (field === 'tags') {
      out.tags = String(value).split(',').map(s => s.trim()).filter(Boolean);
    } else if (field === 'brand') {
      out.brandId = brandsByName.get(String(value).trim().toLowerCase()) ?? null;
    } else {
      out[field] = String(value).trim();
    }
  }
  return out;
}).filter((r) => r.sku && r.sku.trim());

const res = await bulkUpsertProducts(rows, defaultBrandId || null);
// res = { inserted, updated }
```

### Step 'review'

Shows `{inserted} new added, {updated} existing updated out of {total} rows.`

---

## 19. UI — AutoMatchModal.jsx (folder picker with rules)

Three internal steps: `'intro' | 'running' | 'results'`.

### 'intro'

A bulleted **Matching rules** card. Display these exactly (or close to it):

1. **Filename = SKU.** `abc-123.jpg` → main image of product with SKU `abc-123`. Case-insensitive: `ABC-123.JPG` works too.
2. **Numeric suffix → gallery position.** `abc-123-1.jpg`, `abc-123-2.jpg`, `abc-123-3.jpg` attach to the same SKU in that order. `-1` / `_1` / "abc-123 1" all work as separators.
3. **Per-SKU subfolder.** A folder named `abc-123/` with images inside attaches all of them to SKU `abc-123`. `main.jpg` (or `primary`/`cover`) becomes the main; numeric filenames (`1.jpg`, `2.jpg`) set the order.
4. **Duplicates are skipped.** Every image is hashed by content. The same file imported twice is detected and only stored once.
5. **Subfolders scanned up to 5 levels deep.** Hidden folders (starting with `.`) are skipped.
6. **Existing images stay.** Matched images go to the start of the product's image list (so `-1` becomes the new main). Manually-added images that didn't match anything in this run stay at the end.
7. **Max 20 images per product.** Any extras for a single SKU are skipped and reported in the results.

Bottom buttons: `Cancel` and `Choose folder…` (calls `files.pickFolder()`, then `images.autoMatchBySku(companyId, folderPath)`).

### 'running'

Just a "Scanning …" placeholder. The IPC call is synchronous from the renderer's POV (awaits the Promise).

### 'results'

A grid of stat tiles:

- Image files scanned
- SKUs matched (`X / totalProducts`)
- Images imported (emerald color)
- Duplicates skipped
- Unmatched files
- Products touched
- Over the 20-image cap (amber, only when > 0)

If `unmatchedFiles > 0`, a small amber explainer:
> N file(s) didn't match any SKU. Common reasons: filename doesn't include the SKU, the file lives in a subfolder whose name isn't a SKU, or the SKU doesn't exist in this company yet.

Bottom: `Done` button.

---

## 20. Invariants — keep these true

1. **SKU is the unique identifier per parent.** Enforced by `UNIQUE (company_id, sku)`. Trim whitespace on input. Case-sensitive intentionally — `abc` and `ABC` are different SKUs.
2. **Imports never overwrite a populated field with null.** Verified by the bulk-upsert merge in §7.
3. **Prices and customFields merge.** Updating one key never blanks the others.
4. **Tags replace if supplied, preserve otherwise.** Setting an empty tags array via import does *not* clear existing tags (only an explicit non-empty array does).
5. **Images and variants are never touched by import.** Manual flows only.
6. **`MAX_IMAGES_PER_PRODUCT = 20` enforced in all three image add paths:** `importForProduct`, `importFromBytes`, `autoMatchBySku`.
7. **Content hash is the source-file SHA-1**, not the post-sharp output. Re-importing the same source bytes always returns the same `relativePath`.
8. **Reorder validates a permutation.** `images:reorderImages` rejects payloads that aren't the same set as the existing array.
9. **Asset paths in the DB are always relative** (e.g. `products/abc-001-a1b2c3d4ef.jpg`). Never absolute paths.
10. **Custom protocol uses `decodeURIComponent`**, not `decodeURI`, because subdir paths contain `%2F`-encoded slashes.
11. **Pagination resets to page 1** whenever filters / search / page size change. Page index clamps when total shrinks.

---

## 21. Acceptance checklist

A reviewer should be able to walk through this end-to-end:

- [ ] Create a parent entity with at least one price group and one custom field.
- [ ] Click **+ New product** → fill SKU, save → see it in the table.
- [ ] Edit it → set a price, add a tag, save → toast confirms, row reflects.
- [ ] Click **Download sample** → open the resulting `.xlsx` → confirm `Products` sheet has SKU/Brand/Barcode/Secondary code/etc. + one `Price_<Group>` column per price group + one column per custom field. `Instructions` sheet present.
- [ ] Fill the sample with 60 rows, save, **Import Excel/CSV** → mapping step auto-guesses everything correctly → import → see counts (e.g. "60 new, 0 updated").
- [ ] Re-import the same file with one SKU's `Price_Wholesale` changed and Barcode emptied → see "0 new, 1 updated"; verify Wholesale changed, Retail unchanged, Barcode unchanged (blank was ignored).
- [ ] Re-import a small file with only `SKU` and `Name` columns → other fields untouched.
- [ ] Type in the search bar → list filters across SKU + barcode + secondary code + name + color/finish + tags.
- [ ] Click a category in the sidebar → list filters; **other categories remain visible** in the sidebar.
- [ ] Change page size to 25, navigate via Next; change a filter → page resets to 1.
- [ ] Open a product → click **+ Add image**, pick a file → it appears with green "Main" badge.
- [ ] Open the same product → ⌘V with a screenshot in clipboard → second image appears.
- [ ] Hover a non-main image → click `Set as main` → it becomes position 0.
- [ ] Hover an image → use the `→` arrow → it moves one slot later.
- [ ] Remove an image → it disappears; count drops.
- [ ] Add the same file twice → second add is a no-op (no duplicate in the array, no duplicate on disk).
- [ ] Try to add a 21st image → blocked with an error toast / alert.
- [ ] Set up a test folder on disk:
  ```
  test-images/
    SAMPLE-001.jpg
    SAMPLE-001-2.jpg
    SAMPLE-002/
      main.jpg
      2.jpg
    random.jpg
  ```
- [ ] **Auto-match images…** → opens info modal showing 7 rules → Choose folder → results show 2 SKUs matched, 4 images imported, 0 dup, 1 unmatched.
- [ ] Re-run auto-match on the same folder → 0 imported, 4 dup skipped.
- [ ] Delete a product → confirmation → list updates; categories list updates if that was the last product in that category.
- [ ] Press `Esc` inside any modal → it closes. Click the dim backdrop → it closes.

---

## 22. Things this spec deliberately does **not** cover

- **Catalog generation / PDF export.** Out of scope for the Library; the Library only produces the data those features consume.
- **Variants UI.** The `variants` column exists in schema but the UI here doesn't expose it.
- **Sorting in the table.** Default order is `category, name`. Add column sort later if needed.
- **Drag-to-reorder images.** Today: `Set as main` + `←/→` arrows. Drag is a future improvement.
- **Bulk-edit / bulk-status changes** from selection.
- **Soft delete / trash.** `remove` hard-deletes; bring back via re-import.
- **Brand-icon UI.** The Library reads the brand's `icon` relative path if present; managing brands lives in a separate module.

---

## 23. Common pitfalls (saved you a debugging session)

- **`registerFileProtocol` is deprecated** in modern Electron. Use `protocol.handle('app-image', ...)` and `net.fetch(url.pathToFileURL(abs).toString())`.
- **`decodeURI` vs `decodeURIComponent`**: `decodeURI` won't decode `%2F`. If your relative paths contain subdirectories (they do: `products/abc.jpg`), the renderer encodes `/` to `%2F` and the server must use `decodeURIComponent` to put it back.
- **Sharp resize order:** call `.rotate()` *before* `.resize(...)` so the auto-rotation from EXIF orientation doesn't fight the resize bounds.
- **`better-sqlite3` is native.** Add `"postinstall": "electron-builder install-app-deps"` so the prebuilt is rebuilt against the Electron Node ABI.
- **`vite-plugin-electron/simple`** with `root: 'renderer'` requires **absolute paths** for the main/preload `entry` keys, because relative paths get resolved against `renderer/`.
- **Local module imports in main:** when `external: ['electron', 'better-sqlite3', …]` is set in the Rollup config, sibling local files (`./db`, `./ipc`, …) are *not* automatically bundled. List each as a separate Rollup input or they'll be missing at runtime.
- **Clipboard paste payload:** pass `ArrayBuffer` over IPC. Electron's structured-clone serialization handles it; on the main side, wrap with `Buffer.from(buffer)` before writing to disk.
- **Image count display:** keep a single `MAX_IMAGES_PER_PRODUCT` constant in main and mirror it in the renderer (the form needs the number for the count badge and disabled state). Both should agree.

---

## 24. Suggested build order

If implementing from scratch, this order minimizes thrash:

1. SQL schema + `rowToProduct` + basic CRUD (`list`, `get`, `create`, `update`, `remove`).
2. IPC handlers for products + preload surface.
3. ProductLibrary table view (no filters, no pagination) wired to `list`.
4. ProductForm with all scalar fields (no images yet). Verify create/update round-trips.
5. Custom protocol + `assets/products/` folder + `importAsset` + `importForProduct` IPC.
6. Add image grid to ProductForm (add, remove). Verify renderer can display the imported file via the custom protocol.
7. `setMainImage` + `reorderImages` IPC + UI hover controls.
8. SHA-1 hash → deterministic filenames. Verify re-import of same file is a no-op.
9. `MAX_IMAGES_PER_PRODUCT` cap in all three add paths.
10. Clipboard paste handler.
11. `scanImagesRecursive` + `findCandidateSku` + `groupAndSortMatches`.
12. `autoMatchBySku` IPC + `AutoMatchModal` with rules + results.
13. Workbook reader + sample generator + `Download sample` button.
14. `ImportModal` with auto-guess + partial-update merge in `bulkUpsert`.
15. Sidebar (brand + category filters), search, view toggle, pagination.
16. Acceptance checklist pass.

Each step is independently verifiable. If anything misbehaves, the most recent commit is the culprit.

---

**End of spec.** Hand this single file to a fresh Claude Code session, point it at a project that already has Electron + React + Tailwind + Zustand + SQLite set up, and ask it to build the Product Library following this document. Expect ~1:1 parity with the reference implementation.
