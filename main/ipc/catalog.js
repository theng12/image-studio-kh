/**
 * v0.21.1: companies / brands / categories handlers, extracted
 * from ipc.js into a single "catalog" domain. These three tables
 * share the company-scoping pattern + the cross-tenancy guards.
 *
 * Every read channel is exposed (callable from clients via RPC).
 * Every write emits a catalog change event so connected clients
 * refetch. The brand icon upload + bytes-based variant live here
 * too because they're per-brand.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');

const companies = require('../db/companies');
const brands = require('../db/brands');
const categories = require('../db/categories');
const imageManager = require('../imageManager');

function register({ expose, emitCatalogChange, assertEntityInActiveCompany, SAFE_BRAND_EXTS }) {
  /* ─── Companies ─── */

  // v0.14.2: company read channels migrated to `expose` so clients
  // can call them.
  expose('companies:list',         () => companies.list());
  expose('companies:get',          (id) => companies.get(id));
  expose('companies:getActiveId',  () => companies.getActiveId());
  // v0.15.2: active company is now per-user. The caller already
  // gets the result back via the RPC response (or IPC return) —
  // no need to broadcast a `catalog:changed activeCompany` event
  // since other users' choices are independent.
  expose('companies:setActive', (id) => companies.setActive(id));

  // v0.15.0: company mutations exposed to clients. The server-side
  // company table is shared, so any client editing companies
  // affects everyone — that's by design.
  expose('companies:create', (input) => {
    const r = companies.create(input);
    emitCatalogChange('company', 'create', r?.id);
    return r;
  });
  expose('companies:update', ({ id, patch } = {}) => {
    const r = companies.update(id, patch);
    emitCatalogChange('company', 'update', id);
    return r;
  });
  expose('companies:remove', (id) => {
    const r = companies.remove(id);
    emitCatalogChange('company', 'remove', id);
    return r;
  });

  /* ─── Brands ─── */

  expose('brands:list', (companyId) => {
    if (companyId && companyId !== companies.getActiveId()) return [];
    return brands.list(companyId);
  });
  expose('brands:get', (id) => {
    return assertEntityInActiveCompany(brands.get(id), 'Brand');
  });
  // v0.15.0: brand mutations exposed. v0.15.1: emit on change.
  expose('brands:create', (input) => {
    if (input?.companyId && input.companyId !== companies.getActiveId()) {
      throw new Error('Cross-company create blocked');
    }
    const r = brands.create(input);
    emitCatalogChange('brand', 'create', r?.id);
    return r;
  });
  expose('brands:update', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(brands.get(id), 'Brand');
    const r = brands.update(id, patch);
    emitCatalogChange('brand', 'update', id);
    return r;
  });
  expose('brands:remove', (id) => {
    assertEntityInActiveCompany(brands.get(id), 'Brand');
    const r = brands.remove(id);
    emitCatalogChange('brand', 'remove', id);
    return r;
  });

  ipcMain.handle('brands:uploadIcon', async (_e, { sourcePath, name }) => {
    if (!sourcePath) throw new Error('Source path required');
    // v0.12.0: brand icons now live at
    //   `assets/<company>/_brand-icons/<brand-slug>.<ext>`
    // We need an active company to choose the dir. The slug for
    // the file itself comes from the brand name (caller passes
    // `name`).
    const companyId = companies.getActiveId();
    if (!companyId) throw new Error('No active company');
    const company = companies.get(companyId);
    if (!company) throw new Error('Active company not found');
    const { brandIconDir } = require('../util/assetPath');
    const baseName = imageManager.slugify(name || path.basename(sourcePath, path.extname(sourcePath)), 'brand');
    const destDirRel = brandIconDir(company);
    const { relativePath } = await imageManager.importBrandIcon(sourcePath, {
      destDirRel,
      baseName,
    });
    return { relativePath };
  });

  /**
   * v0.16.0: bytes-based brand-icon upload for client mode. The
   * client reads the icon file locally, sends bytes, server writes
   * to a temp file then runs the normal importBrandIcon pipeline
   * so the dedup-by-hash logic still applies.
   */
  expose('brands:uploadIconFromBytes', async ({ bytes, ext, name } = {}) => {
    if (!bytes) throw new Error('bytes required');
    const companyId = companies.getActiveId();
    if (!companyId) throw new Error('No active company');
    const company = companies.get(companyId);
    if (!company) throw new Error('Active company not found');
    const { brandIconDir } = require('../util/assetPath');
    const os = require('node:os');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iskh-brand-'));
    let safeExt = (ext || '.png').toLowerCase();
    if (!safeExt.startsWith('.')) safeExt = '.' + safeExt;
    if (!SAFE_BRAND_EXTS.has(safeExt)) safeExt = '.png';
    const tmpPath = path.join(tmpDir, `icon${safeExt}`);
    await fs.promises.writeFile(tmpPath, Buffer.from(bytes));
    try {
      const baseName = imageManager.slugify(name || 'brand', 'brand');
      const destDirRel = brandIconDir(company);
      const { relativePath } = await imageManager.importBrandIcon(tmpPath, { destDirRel, baseName });
      return { relativePath };
    } finally {
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  /* ─── Categories ─── */

  expose('categories:list', (companyId) => {
    if (companyId && companyId !== companies.getActiveId()) return [];
    return categories.list(companyId);
  });
  // v0.15.0: category mutations exposed. v0.15.1: emit on change.
  expose('categories:create', (input) => {
    if (input?.companyId && input.companyId !== companies.getActiveId()) {
      throw new Error('Cross-company create blocked');
    }
    const r = categories.create(input);
    emitCatalogChange('category', 'create', r?.id);
    return r;
  });
  expose('categories:update', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(categories.get(id), 'Category');
    const r = categories.update(id, patch);
    emitCatalogChange('category', 'update', id);
    return r;
  });
  expose('categories:remove', (id) => {
    assertEntityInActiveCompany(categories.get(id), 'Category');
    const r = categories.remove(id);
    emitCatalogChange('category', 'remove', id);
    return r;
  });
}

module.exports = { register };
