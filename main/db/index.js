const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCHEMA_VERSION = 2;

/**
 * v0.13.0: detect whether a path lives inside iCloud Drive. macOS stores
 * iCloud Drive at `~/Library/Mobile Documents/com~apple~CloudDocs/`.
 * When the user's dataDir is in there, we switch SQLite to DELETE
 * journal mode so the WAL/SHM sidecars don't get synced out of order
 * with the main DB.
 */
function isIcloudDataDir(dataDir) {
  if (!dataDir) return false;
  const icloudRoot = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  // Use a normalized prefix match so a sibling folder named
  // "com~apple~CloudDocsExtras" doesn't trigger a false positive.
  const norm = path.normalize(dataDir);
  const root = path.normalize(icloudRoot);
  return norm === root || norm.startsWith(root + path.sep);
}

let db = null;
let currentDataDir = null;

function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb(dataDir) first');
  return db;
}

function getDataDir() {
  if (!currentDataDir) throw new Error('Data dir not set — call initDb first');
  return currentDataDir;
}

function addColumnIfMissing(database, table, column, type) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function readSchemaVersion(database) {
  try {
    const row = database
      .prepare(`SELECT value FROM app_state WHERE key = 'schema_version'`)
      .get();
    return row?.value ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'assets', 'products'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'assets', 'brands'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'assets', 'watermarks'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'processed'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'ai-gallery'), { recursive: true });

  // One-time migration: move any existing `assets/processed/*` into the new
  // briefing-spec location at `<dataDir>/processed/*`. Safe to run on every
  // boot — once the source is empty it's a no-op.
  migrateProcessedLocation(dataDir);

  const dbPath = path.join(dataDir, 'database.sqlite');

  /* v0.13.0: stale WAL check. If the WAL/SHM sidecars exist with mtimes
     newer than the main DB file, it usually means another machine wrote
     to the DB and only a partial sync arrived. Log a warning so the
     user has a record; SQLite will still try to recover on open. */
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath) && fs.existsSync(dbPath)) {
    try {
      const dbMtime = fs.statSync(dbPath).mtimeMs;
      const walMtime = fs.statSync(walPath).mtimeMs;
      if (walMtime > dbMtime + 1000) {
        // 1s tolerance — same-tx writes legitimately have wal a touch newer.
        process.stderr.write(
          `[db] stale-WAL detected: wal is ${Math.round((walMtime - dbMtime) / 1000)}s newer than db. ` +
          `Likely cause: cloud sync mid-write from another machine.\n`,
        );
      }
    } catch (_) {/* ignore */}
  }

  db = new Database(dbPath);

  /* v0.13.0: SQLite mode is chosen based on whether dataDir is in iCloud.
     - Local folders → WAL mode (default; fast, supports concurrent reads).
     - iCloud Drive → DELETE mode (slower writes, but no -wal/-shm
       sidecars to confuse cloud sync). The pragma switch checkpoints
       any existing WAL into the main DB before changing modes, so a
       user moving FROM local TO iCloud doesn't lose pending writes. */
  if (isIcloudDataDir(dataDir)) {
    try { db.pragma('journal_mode = WAL'); } catch (_) {/* ignore — best-effort */}
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    try { db.pragma('journal_mode = DELETE'); } catch (err) {
      process.stderr.write(`[db] iCloud journal switch failed: ${err.message}\n`);
    }
    process.stdout.write(`[db] iCloud Drive detected — journal_mode=DELETE\n`);
  } else {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');

  currentDataDir = dataDir;

  // Ensure app_state exists before reading the version.
  db.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT);`);
  const onDisk = readSchemaVersion(db);
  if (onDisk > 0 && onDisk < SCHEMA_VERSION) {
    wipeStructuralTables(db);
  }

  runMigrations(db);

  // Additive column migrations — safe to run on every boot.
  addColumnIfMissing(db, 'product_images', 'content_hash', 'TEXT');
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_product_images_content_hash ON product_images(content_hash);`); }
  catch (_) { /* index race, ignore */ }

  /* v0.11.0: `ai_gallery.company_id` so bulk-mode results (with no
     product_id) can still be scoped to the active company. Backfill
     existing rows from their joined product's company before the bulk
     listing query starts depending on this column being populated. */
  addColumnIfMissing(db, 'ai_gallery', 'company_id', 'TEXT');
  try {
    db.exec(`
      UPDATE ai_gallery
         SET company_id = (SELECT company_id FROM products WHERE products.id = ai_gallery.product_id)
       WHERE company_id IS NULL AND product_id IS NOT NULL;
    `);
  } catch (_) { /* backfill best-effort; new rows always carry it */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_gallery_company_created ON ai_gallery(company_id, created_at DESC);`); }
  catch (_) {}

  /* v0.15.2: per-user active company. Each client Mac picks its own;
     the server admin (no token) still uses app_state.activeCompanyId.
     Additive column, defaults to NULL so existing users get the
     shared default until they explicitly switch. */
  addColumnIfMissing(db, 'users', 'active_company_id', 'TEXT');

  /* v0.15.3: edit attribution. updated_by_user_id is the users.id of
     the caller who last touched the row, or NULL for "the server admin
     / standalone". The renderer joins on this for "Edited 2 min ago by
     <name>" — null means no name shown, just the relative time.
     Categories never had an updated_at; add one here so attribution
     has something to anchor a relative time against. */
  for (const t of ['products', 'brands', 'categories', 'companies']) {
    addColumnIfMissing(db, t, 'updated_by_user_id', 'TEXT');
  }
  addColumnIfMissing(db, 'categories', 'updated_at', 'INTEGER');

  /* v0.27.0: per-template bulk-inset config (JSON). Lets the overlay
     shrink the base image to a safe-margin fill % and pad the gap so
     overlay elements never collide with tightly-framed product shots.
     Additive + nullable → legacy templates default to "no inset". */
  addColumnIfMissing(db, 'image_templates', 'inset', 'TEXT');

  /* v0.28.0: perceptual hash (dHash, 16-hex chars) for near-duplicate
     detection. Byte-level content_hash only catches identical files; this
     catches the same photo re-saved on a different Mac (re-compressed /
     EXIF-stripped). Nullable + backfilled lazily during the first dedup
     scan, so no heavy boot-time migration. */
  addColumnIfMissing(db, 'product_images', 'perceptual_hash', 'TEXT');
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_product_images_perceptual_hash ON product_images(perceptual_hash);`); }
  catch (_) { /* index race, ignore */ }

  /* v0.31.0: file_size (bytes of the on-disk image) so the Library can show
     each image's size; lazily backfilled on first list + refreshed when the
     file changes. dedup_exempt flags images that should NEVER be grouped by
     the near-duplicate scan — set on export-derived copies appended to a
     product, so the user can keep running the duplicate check without it
     flagging a small web export as a near-dup of its hi-res original. */
  addColumnIfMissing(db, 'product_images', 'file_size', 'INTEGER');
  addColumnIfMissing(db, 'product_images', 'dedup_exempt', 'INTEGER');

  /* v0.49.42: per-profile {INDEX} export-filename formatting. index_pad
     is the zero-pad width (1–4); index_prefix is an optional literal
     prefix (e.g. 'A' → A001). Both nullable → legacy profiles read as
     NULL and the clampIndexPad / sanitizeIndexPrefix helpers default
     them to 3-digit / no-prefix, so existing exports are unchanged. */
  addColumnIfMissing(db, 'export_profiles', 'index_pad', 'INTEGER');
  addColumnIfMissing(db, 'export_profiles', 'index_prefix', 'TEXT');

  /* v0.49.47: PO + product carton extensions for container utilization
     and by-volume / by-weight cost allocation.
     - po_lines: carton qty + outer dims (cm) + per-unit weight (kg).
       Defaulted from product master at line creation, overridable per PO.
     - purchase_orders: cached totals (re-summed on save) so the list
       view doesn't have to re-aggregate every render.
     - products: carton master fields. Set once when you import the SKU
       from the supplier; the PO form pre-fills from these. Optional —
       leaving them NULL means by_volume / by_weight allocations on a
       PO that includes the SKU fall back to by_value. */
  addColumnIfMissing(db, 'po_lines', 'carton_qty',         'INTEGER');
  addColumnIfMissing(db, 'po_lines', 'carton_w_cm',        'REAL');
  addColumnIfMissing(db, 'po_lines', 'carton_h_cm',        'REAL');
  addColumnIfMissing(db, 'po_lines', 'carton_d_cm',        'REAL');
  addColumnIfMissing(db, 'po_lines', 'weight_per_unit_kg', 'REAL');

  addColumnIfMissing(db, 'purchase_orders', 'total_value_supplier', 'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'total_value_usd',      'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'total_volume_cbm',     'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'total_weight_kg',      'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'total_components_usd', 'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'lines_count',          'INTEGER');
  // v0.49.50: cached payment rollup so the PO list can show a payment
  // badge + outstanding amount without joining po_payments per row.
  addColumnIfMissing(db, 'purchase_orders', 'total_paid_supplier',  'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'total_paid_usd',       'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'total_tt_fees_usd',    'REAL');
  addColumnIfMissing(db, 'purchase_orders', 'payment_status',       'TEXT');

  addColumnIfMissing(db, 'products', 'carton_qty',         'INTEGER');
  addColumnIfMissing(db, 'products', 'carton_w_cm',        'REAL');
  addColumnIfMissing(db, 'products', 'carton_h_cm',        'REAL');
  addColumnIfMissing(db, 'products', 'carton_d_cm',        'REAL');
  addColumnIfMissing(db, 'products', 'weight_per_unit_kg', 'REAL');
  addColumnIfMissing(db, 'products', 'hs_code',            'TEXT');
  addColumnIfMissing(db, 'products', 'supplier_id',        'TEXT');
  addColumnIfMissing(db, 'products', 'supplier_sku',       'TEXT');

  /* v0.28.0: image_merge_ops — the undo log for near-duplicate merges.
     Each merge batch records full snapshots of the removed image rows
     (in removed_json) plus where their files were quarantined, so a merge
     can be reverted. reverted_at / purged_at flip when the user undoes or
     permanently purges. company_id scopes the "recent merges" list to the
     active company. CREATE IF NOT EXISTS is idempotent → safe every boot. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_merge_ops (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      company_id TEXT,
      threshold_pct INTEGER,
      mode TEXT,
      group_count INTEGER NOT NULL DEFAULT 0,
      removed_count INTEGER NOT NULL DEFAULT 0,
      removed_json TEXT NOT NULL DEFAULT '[]',
      reverted_at INTEGER,
      purged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_image_merge_ops_created ON image_merge_ops(created_at DESC);
  `);

  /* v0.22.6: audit_log — every mutation gets a row. entity_type is the
     conceptual kind ('product' | 'brand' | 'category' | 'image' | …);
     entity_id is whatever id the renderer uses to look the row back up
     (for images, that's the product_id so the History modal on a
     product can show its image events alongside scalar edits).
     action is a short verb ('create' | 'update' | 'delete' | 'image:add' | …).
     before_json + after_json hold compact JSON snapshots — for updates,
     ONLY the changed keys (to keep the log small and the diff obvious);
     for creates the full snapshot lives in `after`; for deletes in `before`.
     user_id is the caller (NULL for server admin / standalone).

     No FKs on (entity_type, entity_id) — we want the log to survive
     entity deletion so "who deleted product X" is answerable after the
     row is gone. We DO index on (entity_type, entity_id, created_at
     DESC) for the per-product History modal, and a separate plain
     created_at index for the global feed (added later if needed). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id   TEXT,
      user_id     TEXT,
      action      TEXT NOT NULL,
      before_json TEXT,
      after_json  TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity
      ON audit_log(entity_type, entity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created
      ON audit_log(created_at DESC);
  `);

  /* v0.12.0: one-shot migration of `assets/products/<file>` and
     `assets/brands/<file>` into the nested layout
     `assets/<company>/<brand>/<sku>/NNN.<ext>` and
     `assets/<company>/_brand-icons/<brand>.<ext>`. Idempotent via
     `app_state.assets_layout_v2 = 'done'`; first run on existing data
     can take 10–30s on large libraries. Followed by a recovery sweep
     that reconciles any `__tmp-*` files left from interrupted
     renumber operations using content_hash matching. */
  // Inline lifecycle-logger surrogate. main/index.js owns the canonical
  // crash.log writer but we don't have a clean import path from here
  // (db/index is required before main/index sets up its logger). We
  // append directly using the same format so the user has a visible
  // record of migration outcomes.
  const logToCrashLog = (event, detail) => {
    const line = `[${new Date().toISOString()}] ${event}${detail ? ' :: ' + detail : ''}\n`;
    process.stdout.write(line);
    try {
      const { app } = require('electron');
      const userDataDir = app?.getPath?.('userData');
      if (userDataDir) {
        fs.mkdirSync(userDataDir, { recursive: true });
        fs.appendFileSync(path.join(userDataDir, 'crash.log'), line);
      }
    } catch (_) {/* best-effort */}
  };

  try {
    const { runAssetLayoutMigration, renameBareNNNFiles } = require('./_assetMigration');
    const result = runAssetLayoutMigration(db);
    if (result) {
      logToCrashLog(
        'asset-migration',
        `done in ${result.durationMs}ms · ` +
        `productsTouched=${result.productsTouched ?? 0} moved=${result.productsMoved} skipped=${result.productsSkipped} missing=${result.productsMissing} · ` +
        `brand icons moved=${result.brandsMoved} skipped=${result.brandsSkipped}`,
      );
    } else {
      logToCrashLog('asset-migration', 'skipped (already complete)');
    }
    // v0.12.1 secondary pass — rename bare-NNN files left over from the
    // brief v0.12.0 window. Idempotent.
    const skuPrefixResult = renameBareNNNFiles(db);
    if (skuPrefixResult && skuPrefixResult.renamed > 0) {
      logToCrashLog(
        'asset-migration:sku-prefix',
        `${skuPrefixResult.renamed} files in ${skuPrefixResult.durationMs}ms`,
      );
    }
  } catch (err) {
    logToCrashLog('asset-migration:failed', `${err.message}`);
    process.stderr.write(`[asset-migration] failed: ${err.message}\n${err.stack ?? ''}\n`);
  }
  try {
    const { runAssetRecovery } = require('./_assetRecovery');
    runAssetRecovery();
  } catch (err) {
    process.stderr.write(`[asset-recovery] failed: ${err.message}\n`);
  }

  return db;
}

function migrateProcessedLocation(dataDir) {
  try {
    const oldDir = path.join(dataDir, 'assets', 'processed');
    const newDir = path.join(dataDir, 'processed');
    if (!fs.existsSync(oldDir)) return;
    const entries = fs.readdirSync(oldDir, { withFileTypes: true });
    if (entries.length === 0) {
      fs.rmdirSync(oldDir);
      return;
    }
    for (const entry of entries) {
      const src = path.join(oldDir, entry.name);
      const dst = path.join(newDir, entry.name);
      if (fs.existsSync(dst)) continue; // don't clobber
      fs.cpSync(src, dst, { recursive: true, errorOnExist: false, force: false });
      fs.rmSync(src, { recursive: true, force: true });
    }
    try { fs.rmdirSync(oldDir); } catch (_) {}
    process.stdout.write(`[migrate] moved processed images: ${oldDir} → ${newDir}\n`);
  } catch (err) {
    process.stderr.write(`[migrate] processed move failed: ${err.message}\n`);
  }
}

// Tables we drop when bumping the schema. app_state and settings persist
// across versions (they're free-form kv stores).
const STRUCTURAL_TABLES = [
  'product_images',
  'export_runs',
  'export_profiles',
  'products',
  'brands',
  'categories',
  'companies',
];

function wipeStructuralTables(database) {
  database.pragma('foreign_keys = OFF');
  for (const t of STRUCTURAL_TABLES) {
    database.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  database.pragma('foreign_keys = ON');
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT,
      sectors TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (company_id, name COLLATE NOCASE)
    );
    CREATE INDEX IF NOT EXISTS idx_brands_company ON brands(company_id);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (company_id, name COLLATE NOCASE)
    );
    CREATE INDEX IF NOT EXISTS idx_categories_company ON categories(company_id);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT,
      brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
      barcode TEXT,
      secondary_code TEXT,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      subcategory TEXT,
      color_finish TEXT,
      variant TEXT,
      unit TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      tags TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      price_retail REAL,
      price_wholesale REAL,
      process_status TEXT NOT NULL DEFAULT 'unprocessed',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (company_id, sku)
    );
    CREATE INDEX IF NOT EXISTS idx_products_company  ON products(company_id);
    CREATE INDEX IF NOT EXISTS idx_products_brand    ON products(brand_id);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_status   ON products(status);
    CREATE INDEX IF NOT EXISTS idx_products_process  ON products(process_status);

    CREATE TABLE IF NOT EXISTS product_images (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      original_filepath TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      is_processed INTEGER NOT NULL DEFAULT 0,
      processed_filepath TEXT,
      workspace_settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);
    CREATE INDEX IF NOT EXISTS idx_product_images_order   ON product_images(product_id, order_index);

    CREATE TABLE IF NOT EXISTS export_profiles (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      marketplace TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      format TEXT NOT NULL,
      quality INTEGER,
      background_color TEXT,
      color_profile TEXT NOT NULL DEFAULT 'sRGB',
      naming_pattern TEXT NOT NULL DEFAULT '{SKU}-{INDEX}',
      output_subfolder TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_export_profiles_company ON export_profiles(company_id);

    CREATE TABLE IF NOT EXISTS export_runs (
      id TEXT PRIMARY KEY,
      profile_id TEXT REFERENCES export_profiles(id) ON DELETE SET NULL,
      run_at INTEGER NOT NULL,
      product_count INTEGER NOT NULL,
      image_count INTEGER NOT NULL,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      output_path TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_export_runs_profile ON export_runs(profile_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    /* ── AI Studio ─── additive, no schema_version bump ───────── */

    CREATE TABLE IF NOT EXISTS ai_prompt_templates (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (company_id, name COLLATE NOCASE)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_prompts_company ON ai_prompt_templates(company_id);

    CREATE TABLE IF NOT EXISTS ai_tasks (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
      source_image_path TEXT,             -- relative app-image:// path of the source
      provider TEXT NOT NULL,             -- 'kie' | 'fal'
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      raw_options TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,               -- queued|running|done|failed|cancelled
      progress REAL NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      provider_task_id TEXT,
      provider_source_url TEXT,
      error_message TEXT,
      cost_estimate REAL,                 -- USD (not cents)
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_status   ON ai_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_product  ON ai_tasks(product_id);
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_company  ON ai_tasks(company_id);
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_created  ON ai_tasks(created_at);

    CREATE TABLE IF NOT EXISTS ai_gallery (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES ai_tasks(id) ON DELETE SET NULL,
      product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
      filepath TEXT NOT NULL,             -- relative path under ai-gallery/<sku>/
      prompt TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      promoted_to_product INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_gallery_product ON ai_gallery(product_id);
    CREATE INDEX IF NOT EXISTS idx_ai_gallery_task    ON ai_gallery(task_id);

    /* ── Perf indexes added in v0.6.0 (Tier 2 audit) ─────────────────
     * - product_images.is_processed: dashboard.statsFor + per-product
     *   counts filter by this column.
     * - products.updated_at: every list() ORDERs by it.
     * - ai_gallery(product_id, created_at): gallery is listed per
     *   product, newest first.
     * - ai_tasks(company_id, created_at): queue is listed per
     *   company, newest first.
     */
    CREATE INDEX IF NOT EXISTS idx_product_images_is_processed ON product_images(is_processed);
    CREATE INDEX IF NOT EXISTS idx_products_updated_at         ON products(updated_at);
    CREATE INDEX IF NOT EXISTS idx_ai_gallery_product_created  ON ai_gallery(product_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_company_created    ON ai_tasks(company_id, created_at DESC);

    /* ── Overlay Studio (v0.10) ────────────────────────────────────────
     * Image templates are GLOBAL — no company_id — so users can reuse the
     * same SKU/barcode/logo layout across companies and brands. Element
     * geometry is stored as JSON; the renderer interprets it at apply time.
     *
     * Template runs ARE company-scoped so the per-company history view in
     * the dashboard can show "recent overlays applied to KT Ceramic". The
     * template_id FK is SET NULL so deleting a template doesn't blow away
     * historical run records.
     */
    CREATE TABLE IF NOT EXISTS image_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      canvas_width INTEGER NOT NULL,
      canvas_height INTEGER NOT NULL,
      elements TEXT NOT NULL,         -- JSON array of element definitions
      thumbnail_path TEXT,            -- optional cached preview image (relative)
      tags TEXT NOT NULL DEFAULT '[]',-- JSON array for categorisation/search
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_image_templates_updated_at
      ON image_templates(updated_at DESC);

    CREATE TABLE IF NOT EXISTS image_template_runs (
      id TEXT PRIMARY KEY,
      template_id TEXT REFERENCES image_templates(id) ON DELETE SET NULL,
      company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      output_root TEXT,
      products_count  INTEGER NOT NULL DEFAULT 0,
      images_count    INTEGER NOT NULL DEFAULT 0,
      skipped_count   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_image_template_runs_company_created
      ON image_template_runs(company_id, created_at DESC);

    /* --- v0.49.46: OPERATIONS - supplier + PO + cost tables ------
     *
     * Phase 1 of the costing system. Tables exist on every install but
     * stay empty until the user actually uses the OPERATIONS section.
     * Additive - no schema_version bump. The role gate in
     * util/permissions.js hides the sidebar entries from
     * photographer / viewer users so the new columns are not even
     * surfaced for catalog-only Macs.
     *
     * (Long-form rationale lives in the design doc; intentionally short
     * here because this comment sits inside a JS template literal and
     * backticks would close the literal early. See WhatsNew v0.49.46
     * for the currency model + Incoterm semantics writeup.)
     */

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      country     TEXT,
      default_currency TEXT NOT NULL DEFAULT 'USD',
      default_incoterm TEXT,  -- 'EXW' | 'FOB' | 'CFR' | 'CIF' | NULL
      -- Contact + reference fields. All optional; kept in flat columns
      -- (not JSON) so they're searchable from SQL without a JSON1
      -- extension dance.
      contact_name  TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      website       TEXT,
      address       TEXT,
      notes         TEXT,
      status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'archived'
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      updated_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suppliers_company_name
      ON suppliers(company_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_suppliers_company_status
      ON suppliers(company_id, status);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id          TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      po_number   TEXT,                -- user-facing identifier, NOT unique (can repeat across suppliers)
      incoterm    TEXT NOT NULL,       -- 'EXW' | 'FOB' | 'CFR' | 'CIF'
      currency    TEXT NOT NULL,       -- 'USD' | 'CNY' | 'THB' | …
      exchange_rate_to_usd REAL NOT NULL DEFAULT 1.0,  -- 1 unit currency = N USD
      exchange_rate_date   INTEGER,    -- when the rate was captured
      status      TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'ordered' | 'in_transit' | 'received' | 'closed'
      container_type TEXT,             -- '20' | '40' | '40HQ' | 'LCL' | NULL
      ordered_at  INTEGER,
      eta         INTEGER,
      received_at INTEGER,             -- when status flipped to 'received'; locks landed cost cache
      notes       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      updated_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_company_status_created
      ON purchase_orders(company_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier
      ON purchase_orders(supplier_id);

    CREATE TABLE IF NOT EXISTS po_lines (
      id          TEXT PRIMARY KEY,
      po_id       TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      -- v0.49.46: supplier_sku is the supplier's code for this SKU,
      -- which often differs from our own SKU. Free text, optional.
      supplier_sku TEXT,
      qty                          REAL NOT NULL,
      unit_price_supplier_currency REAL NOT NULL,
      -- USD snapshot at PO time; never recomputed when the exchange
      -- rate moves later. Updated when the line's supplier_currency
      -- price changes (then we re-snapshot).
      unit_price_usd_at_po         REAL NOT NULL,
      -- Allocated container cost — see po_cost_components — divided
      -- across lines by allocation_basis. Filled when status hits
      -- 'received' (or via the Recalculate button). NULL = not yet
      -- computed for this revision of the PO.
      allocated_cost_usd_per_unit  REAL,
      landed_unit_cost_usd         REAL,
      notes       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_po_lines_po ON po_lines(po_id);
    CREATE INDEX IF NOT EXISTS idx_po_lines_product ON po_lines(product_id);

    CREATE TABLE IF NOT EXISTS po_cost_components (
      id    TEXT PRIMARY KEY,
      po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      kind  TEXT NOT NULL, -- 'freight' | 'insurance' | 'duty' | 'clearance' | 'inland' | 'storage' | 'other'
      label TEXT,          -- user free text, e.g. 'OOCL freight invoice #...' (optional)
      amount_supplier_currency REAL NOT NULL,
      amount_usd               REAL NOT NULL,
      -- How this component should be spread across po_lines:
      allocation_basis TEXT NOT NULL DEFAULT 'by_value', -- 'by_value' | 'by_volume' | 'by_weight' | 'flat_per_line'
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_po_cost_components_po ON po_cost_components(po_id);

    /* v0.49.50: po_payments — the TT / wire-transfer ledger for a PO.
       Each row is one payment to the supplier (deposit, balance, partial,
       etc). Reconciled against the PO's GOODS value in the supplier's
       currency (what you actually wire the factory — freight/duty/local
       costs are paid to other parties, not the supplier). Each payment
       carries its OWN exchange rate (deposit + balance often settle weeks
       apart at different rates) and its own TT/bank fee, with a per-payment
       flag for whether that fee rolls into landed cost. */
    CREATE TABLE IF NOT EXISTS po_payments (
      id    TEXT PRIMARY KEY,
      po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      kind  TEXT NOT NULL DEFAULT 'deposit', -- 'deposit' | 'balance' | 'partial' | 'final' | 'other'
      -- Amount wired, in the PO's supplier currency (matches the invoice).
      amount_supplier_currency REAL NOT NULL DEFAULT 0,
      -- Per-payment FX rate (1 supplier-ccy unit = N USD), captured at pay time.
      fx_rate_to_usd           REAL NOT NULL DEFAULT 1.0,
      -- The actual USD that left the account = amount × fx_rate (or entered
      -- directly when the supplier invoices in USD).
      amount_usd               REAL NOT NULL DEFAULT 0,
      -- Bank / TT wire fee for this transfer, in USD.
      tt_fee_usd               REAL NOT NULL DEFAULT 0,
      -- 0/1: does this TT fee roll into the goods' landed cost (per-payment choice)?
      tt_fee_in_landed         INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'paid', -- 'planned' | 'paid' | 'confirmed'
      reference  TEXT,                          -- TT / wire reference number
      paid_at    INTEGER,                       -- when the wire was sent
      notes      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_po_payments_po ON po_payments(po_id);

    /* product_landed_costs: derived/cache. Rebuilt when a PO
       transitions to 'received' (or via Recalculate). Keeping
       latest + 3-month and 12-month averages here means the Product
       Library can show cost without joining + aggregating on every
       query. Refreshed in a transaction with the PO state change so
       it can't drift. */
    CREATE TABLE IF NOT EXISTS product_landed_costs (
      product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      latest_landed_cost_usd        REAL,
      latest_po_id                  TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
      latest_received_at            INTEGER,
      avg_landed_cost_usd_3mo       REAL,  -- weighted by qty
      avg_landed_cost_usd_12mo      REAL,
      updated_at                    INTEGER NOT NULL
    );

    /* v0.14.0: server-mode users. Per-user tokens for the multi-Mac
     * client/server feature. Only relevant when mode is 'server'; in
     * standalone mode this table exists but stays empty. The token
     * is what clients send in the Authorization header as a Bearer
     * value -- a secret per-user string generated at create-time. */
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'editor',  -- v0.45.0: 'admin' | 'editor' | 'photographer' | 'viewer'
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  `);

  database
    .prepare(
      `INSERT INTO app_state (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(SCHEMA_VERSION));
}

/* ── app_state helpers (used for active_company_id and similar) ── */

function getAppState(key) {
  const row = getDb().prepare(`SELECT value FROM app_state WHERE key = ?`).get(key);
  return row?.value ?? null;
}

function setAppState(key, value) {
  getDb()
    .prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value == null ? null : String(value));
}

module.exports = {
  initDb,
  getDb,
  getDataDir,
  addColumnIfMissing,
  getAppState,
  setAppState,
  isIcloudDataDir,
  SCHEMA_VERSION,
};
