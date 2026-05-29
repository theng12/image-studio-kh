import { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

const PRODUCT_FIELDS = [
  { key: '__skip__',      label: '— Skip —' },
  { key: 'sku',           label: 'SKU *',          required: true },
  { key: 'name',          label: 'Name' },
  { key: 'brand',         label: 'Brand (by name)' },
  { key: 'barcode',       label: 'Barcode' },
  { key: 'secondaryCode', label: 'Secondary code' },
  { key: 'category',      label: 'Category (by name)' },
  { key: 'subcategory',   label: 'Subcategory' },
  { key: 'colorFinish',   label: 'Color / Finish' },
  { key: 'description',   label: 'Description' },
  { key: 'unit',          label: 'Unit' },
  { key: 'variant',       label: 'Variant' },
  { key: 'priceRetail',   label: 'Retail price' },
  { key: 'priceWholesale',label: 'Wholesale price' },
  { key: 'tags',          label: 'Tags (comma-separated)' },
  { key: 'status',        label: 'Status' },
];

function autoGuess(header) {
  const h = String(header || '').toLowerCase().trim();
  if (!h) return '__skip__';
  if (h === 'sku' || h === 'code' || h === 'item code') return 'sku';
  if (h === 'name' || h === 'product' || h === 'product name') return 'name';
  if (h === 'brand') return 'brand';
  if (h === 'barcode' || h === 'bar code' || h === 'ean' || h === 'upc') return 'barcode';
  if (h.startsWith('secondary') || h === 'alt sku' || h === 'alt code' || h.startsWith('supplier')) return 'secondaryCode';
  if (h === 'category') return 'category';
  if (h === 'subcategory' || h === 'sub-category') return 'subcategory';
  if (h.includes('color') || h.includes('colour') || h.includes('finish')) return 'colorFinish';
  if (h === 'description' || h === 'desc') return 'description';
  if (h === 'unit') return 'unit';
  if (h === 'variant') return 'variant';
  if (h === 'tags') return 'tags';
  if (h === 'status') return 'status';
  if (h.includes('retail') && h.includes('price')) return 'priceRetail';
  if (h.includes('wholesale') && h.includes('price')) return 'priceWholesale';
  if (h === 'price') return 'priceRetail';
  return '__skip__';
}

export function ImportModal({ open, onClose }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const refreshBrands = useAppStore((s) => s.refreshBrands);
  const refreshCategories = useAppStore((s) => s.refreshCategories);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const createBrand = useAppStore((s) => s.createBrand);
  const createCategory = useAppStore((s) => s.createCategory);
  const addToast = useAppStore((s) => s.addToast);

  const [step, setStep] = useState('pick'); // 'pick' | 'map' | 'preview' | 'review'
  const [workbook, setWorkbook] = useState(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // Preview state. `preview` holds the dry-run result; `conflictPolicy`
  // is editable on the preview screen and the rerun-on-change updates
  // the preview without committing.
  const [preview, setPreview] = useState(null);
  const [conflictPolicy, setConflictPolicy] = useState('merge'); // 'merge' | 'overwrite' | 'skip'
  // Cached row payload so we don't rebuild it when re-previewing under a
  // different conflict policy.
  const [cachedRows, setCachedRows] = useState(null);

  function reset() {
    setStep('pick');
    setWorkbook(null);
    setSheetIdx(0);
    setMapping({});
    setResult(null);
    setPreview(null);
    setConflictPolicy('merge');
    setCachedRows(null);
    setStep('pick');
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handlePick() {
    try {
      const filePath = await window.api.files.pickWorkbook();
      if (!filePath) return;
      const wb = await window.api.files.parseWorkbook(filePath);
      if (!wb || wb.sheets.length === 0) {
        addToast('Workbook is empty', 'error');
        return;
      }
      setWorkbook(wb);
      const headers = wb.sheets[0].headers;
      const guessed = {};
      headers.forEach((h) => { guessed[h] = autoGuess(h); });
      setMapping(guessed);
      setSheetIdx(0);
      setStep('map');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDownloadSample() {
    try {
      const saved = await window.api.samples.generateProductSheet();
      if (saved) addToast(`Saved to ${saved}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  const sheet = workbook?.sheets[sheetIdx] ?? null;

  const skuMapped = useMemo(
    () => sheet ? sheet.headers.some((h) => mapping[h] === 'sku') : false,
    [sheet, mapping],
  );

  async function ensureBrandId(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const hit = brands.find((b) => b.name.toLowerCase() === trimmed.toLowerCase());
    if (hit) return hit.id;
    const created = await createBrand({ name: trimmed });
    return created.id;
  }

  async function ensureCategoryId(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const hit = categories.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (hit) return hit.id;
    const created = await createCategory({ name: trimmed });
    return created.id;
  }

  function toNumber(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function buildRows() {
    const rows = [];
    for (const row of sheet.rows) {
      const out = {};
      for (const header of sheet.headers) {
        const field = mapping[header];
        if (!field || field === '__skip__') continue;
        const raw = row[header];
        if (raw === '' || raw == null) continue;

        if (field === 'brand') {
          out.brandId = await ensureBrandId(raw);
        } else if (field === 'category') {
          out.categoryId = await ensureCategoryId(raw);
        } else if (field === 'tags') {
          out.tags = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
        } else if (field === 'priceRetail' || field === 'priceWholesale') {
          out[field] = toNumber(raw);
        } else if (field === 'status') {
          const v = String(raw).trim().toLowerCase();
          out.status = ['active', 'inactive', 'draft'].includes(v) ? v : null;
        } else {
          out[field] = String(raw).trim();
        }
      }
      if (out.sku) rows.push(out);
    }
    return rows;
  }

  /**
   * Build rows + run a dry-run to compute the preview. Brand/category name→id
   * creation happens during buildRows, so even the preview reflects what'll
   * be on disk. The preview itself is a no-op (no writes), so re-running it
   * under a different conflict policy is cheap.
   */
  async function handleGoToPreview() {
    if (!skuMapped) {
      addToast('Map the SKU column before importing.', 'error');
      return;
    }
    setBusy(true);
    try {
      const rows = cachedRows ?? await buildRows();
      if (!cachedRows) setCachedRows(rows);
      const res = await window.api.products.bulkUpsert(activeCompanyId, rows, {
        dryRun: true,
        conflictPolicy,
      });
      setPreview({ ...res, rowsConsidered: rows.length });
      // The dry-run may have auto-created brands/categories during buildRows
      // — refresh those lookups so the diff shows resolved names.
      await Promise.all([refreshBrands(), refreshCategories()]);
      setStep('preview');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Re-run the dry-run with the newly-picked conflict policy. */
  async function handleChangePolicy(nextPolicy) {
    if (nextPolicy === conflictPolicy) return;
    setConflictPolicy(nextPolicy);
    setBusy(true);
    try {
      const rows = cachedRows ?? await buildRows();
      const res = await window.api.products.bulkUpsert(activeCompanyId, rows, {
        dryRun: true,
        conflictPolicy: nextPolicy,
      });
      setPreview({ ...res, rowsConsidered: rows.length });
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Commit the changes shown in the preview. */
  async function handleApplyChanges() {
    if (!cachedRows) {
      addToast('Preview missing — go back and try again', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await window.api.products.bulkUpsert(activeCompanyId, cachedRows, {
        dryRun: false,
        conflictPolicy,
      });
      setResult({ ...res, rowsConsidered: cachedRows.length });
      await Promise.all([refreshBrands(), refreshCategories(), refreshProducts(), refreshDashboard()]);
      setStep('review');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const footer =
    step === 'pick' ? (
      <Button onClick={handleClose}>Cancel</Button>
    ) : step === 'map' ? (
      <>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="primary" disabled={!skuMapped || busy} onClick={handleGoToPreview}>
          {busy ? 'Building preview…' : `Preview ${sheet?.rowCount ?? 0} row${sheet?.rowCount === 1 ? '' : 's'}`}
        </Button>
      </>
    ) : step === 'preview' ? (
      <>
        <Button onClick={() => setStep('map')} disabled={busy}>← Back</Button>
        <Button
          variant="primary"
          disabled={busy || !preview}
          onClick={handleApplyChanges}
        >
          {busy ? 'Applying…' : `Apply ${(preview?.changes ?? []).filter((c) => c.action === 'insert' || c.action === 'update').length} change${(preview?.changes ?? []).filter((c) => c.action === 'insert' || c.action === 'update').length === 1 ? '' : 's'}`}
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={handleClose}>Done</Button>
    );

  return (
    <Modal open={open} onClose={handleClose} title="Import Excel / CSV" footer={footer} size="xl">
      {step === 'pick' ? (
        <>
          <p>Imports run as three steps: pick file → map columns → review.</p>
          <p className="ws-hint">Rows are matched to existing products by SKU. Blank cells leave existing data alone.</p>
          <div className="import-pick">
            <Button variant="primary" onClick={handlePick}>Choose file…</Button>
            <span className="muted">or</span>
            <Button variant="ghost" onClick={handleDownloadSample}>Download sample</Button>
          </div>
        </>
      ) : step === 'map' && sheet ? (
        <>
          {workbook.sheets.length > 1 ? (
            <div className="field" style={{ marginBottom: 'var(--s-3)' }}>
              <span className="field__label">Sheet</span>
              <Select
                value={String(sheetIdx)}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setSheetIdx(next);
                  const headers = workbook.sheets[next].headers;
                  const guessed = {};
                  headers.forEach((h) => { guessed[h] = autoGuess(h); });
                  setMapping(guessed);
                }}
              >
                {workbook.sheets.map((s, i) => (
                  <option key={s.name} value={i}>{s.name} ({s.rowCount} row{s.rowCount === 1 ? '' : 's'})</option>
                ))}
              </Select>
            </div>
          ) : null}

          <p className="ws-hint">
            <strong>How updates work.</strong> New SKUs are inserted; existing SKUs are updated.
            Only the fields you supply a value for are overwritten. Blank cells leave existing data alone.
            Images and variants are never touched by import.
          </p>

          <div className="import-table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Sample</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {sheet.headers.map((h) => {
                  const sample = sheet.rows[0]?.[h] ?? '';
                  return (
                    <tr key={h}>
                      <td className="import-table__col">{h}</td>
                      <td className="import-table__sample">{String(sample).slice(0, 60)}</td>
                      <td>
                        <Select
                          value={mapping[h] ?? '__skip__'}
                          onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                        >
                          {PRODUCT_FIELDS.map((f) => (
                            <option key={f.key} value={f.key}>{f.label}</option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!skuMapped ? (
            <p className="field__error">Map at least one column to <strong>SKU</strong> before importing.</p>
          ) : null}
        </>
      ) : step === 'preview' && preview ? (
        <ImportPreview
          preview={preview}
          conflictPolicy={conflictPolicy}
          onChangePolicy={handleChangePolicy}
          busy={busy}
        />
      ) : step === 'review' && result ? (
        <ImportReview result={result} />
      ) : null}
    </Modal>
  );
}

/**
 * Preview screen — shown after dry-running the bulk-upsert. Lets the user
 * see exactly what'll change before committing, and pick how to handle
 * conflicts.
 *
 * Three policies, surfaced as a segmented control:
 *   - Merge     — only fill empty fields on existing rows (safest, default)
 *   - Overwrite — apply every mapped field, including blanks (use when the
 *                 import IS the source of truth)
 *   - Skip      — leave existing rows alone; only inserts new SKUs
 *
 * Each row's diff is collapsible. The list is virtual-ish (capped to 200
 * visible) so a 10K-row import doesn't choke the modal.
 */
function ImportPreview({ preview, conflictPolicy, onChangePolicy, busy }) {
  const changes = preview.changes ?? [];
  const counts = changes.reduce((acc, c) => {
    acc[c.action] = (acc[c.action] ?? 0) + 1;
    return acc;
  }, {});
  const inserts = changes.filter((c) => c.action === 'insert');
  const updates = changes.filter((c) => c.action === 'update');
  const noChanges = changes.filter((c) => c.action === 'no_change');
  const skips = changes.filter((c) => c.action === 'skip');

  return (
    <div className="import-preview">
      <div className="import-preview__head">
        <div className="import-preview__counts">
          <strong>{counts.insert ?? 0} new</strong>,{' '}
          <strong>{counts.update ?? 0} updated</strong>
          {(counts.no_change ?? 0) > 0 ? <>, <span className="muted">{counts.no_change} unchanged</span></> : null}
          {(counts.skip ?? 0) > 0 ? <>, <span className="muted">{counts.skip} skipped</span></> : null}
          {' '}out of {preview.rowsConsidered} row{preview.rowsConsidered === 1 ? '' : 's'}.
        </div>

        <div className="import-preview__policy">
          <span className="import-preview__policy-label">On conflict</span>
          <div className="ws-toolbar__group">
            <button
              type="button"
              className={`segment${conflictPolicy === 'merge' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => onChangePolicy('merge')}
              title="Only fill empty fields on existing rows. Safest — won't blank out values you didn't include in the import."
            >Merge</button>
            <button
              type="button"
              className={`segment${conflictPolicy === 'overwrite' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => onChangePolicy('overwrite')}
              title="Apply every mapped field. Blank cells in the import overwrite existing values."
            >Overwrite</button>
            <button
              type="button"
              className={`segment${conflictPolicy === 'skip' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => onChangePolicy('skip')}
              title="Leave existing rows alone. Only insert new SKUs."
            >Skip existing</button>
          </div>
        </div>
      </div>

      <p className="muted import-preview__hint">
        Click <strong>Apply</strong> below to commit. Nothing has been written yet.
      </p>

      {inserts.length > 0 ? (
        <DiffGroup
          title={`New products to add (${inserts.length})`}
          tone="emerald"
          rows={inserts}
        />
      ) : null}
      {updates.length > 0 ? (
        <DiffGroup
          title={`Existing products to update (${updates.length})`}
          tone="amber"
          rows={updates}
        />
      ) : null}
      {noChanges.length > 0 ? (
        <DiffGroup
          title={`Already up to date (${noChanges.length}) — no changes needed`}
          tone="slate"
          rows={noChanges}
          collapsed
        />
      ) : null}
      {skips.length > 0 ? (
        <DiffGroup
          title={`Skipped (${skips.length}) — see reasons`}
          tone="rose"
          rows={skips}
        />
      ) : null}
    </div>
  );
}

function DiffGroup({ title, tone, rows, collapsed = false }) {
  const visible = rows.slice(0, 200);
  return (
    <details className={`import-preview__group import-preview__group--${tone}`} open={!collapsed}>
      <summary><strong>{title}</strong></summary>
      <ul className="import-preview__list">
        {visible.map((r, i) => (
          <li key={i} className="import-preview__row">
            <div className="import-preview__row-head">
              <code>{r.sku || `(row ${(r.rowIndex ?? 0) + 1})`}</code>
              {r.reason ? <span className="muted"> — {r.reason}</span> : null}
            </div>
            {Array.isArray(r.diffs) && r.diffs.length > 0 ? (
              <table className="import-preview__diffs">
                <tbody>
                  {r.diffs.map((d, j) => (
                    <tr key={j}>
                      <td className="import-preview__field">{d.field}</td>
                      <td className="import-preview__old">{fmtValue(d.oldValue)}</td>
                      <td className="import-preview__arrow">→</td>
                      <td className="import-preview__new">{fmtValue(d.newValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </li>
        ))}
        {rows.length > visible.length ? (
          <li className="muted">…and {rows.length - visible.length} more</li>
        ) : null}
      </ul>
    </details>
  );
}

function fmtValue(v) {
  if (v === null || v === undefined || v === '') return <span className="muted">(empty)</span>;
  if (Array.isArray(v)) return v.length === 0 ? <span className="muted">(empty)</span> : v.join(', ');
  return String(v);
}

/**
 * Review screen shown after a bulk-upsert finishes. Surfaces:
 *   - top-line totals (added / updated / rows considered)
 *   - any per-row skips grouped by reason category, so the user can
 *     act on them (re-import after fixing, or accept them)
 *
 * Skip categories come from the main process — see bulkUpsert in
 * main/db/products.js. We map them to friendly labels + actionable hints.
 */
const SKIP_CATEGORY_INFO = {
  duplicate: {
    label: 'Duplicate SKU within the file',
    hint:  'These rows share a SKU with another row already imported in this run. The earlier row\'s fields win; later rows that supply different values were skipped to avoid silent overwrites.',
  },
  bad_reference: {
    label: 'Bad brand / category reference',
    hint:  'These rows reference a brand or category that doesn\'t exist and couldn\'t be auto-created. Check the column mapping or pre-create the missing brand / category.',
  },
  missing_field: {
    label: 'Required field empty',
    hint:  'A column the database requires (e.g. SKU) was blank on these rows.',
  },
  missing_sku: {
    label: 'Missing SKU',
    hint:  'These rows had no SKU value, so they couldn\'t be matched or inserted.',
  },
  error: {
    label: 'Other errors',
    hint:  'Unexpected errors. Check the message for each row.',
  },
};

function ImportReview({ result }) {
  const skips = Array.isArray(result.skips) ? result.skips : [];
  const grouped = skips.reduce((acc, s) => {
    const key = s.category ?? 'error';
    (acc[key] = acc[key] ?? []).push(s);
    return acc;
  }, {});
  const orderedKeys = ['duplicate', 'bad_reference', 'missing_field', 'missing_sku', 'error']
    .filter((k) => grouped[k]?.length);

  return (
    <>
      <p>
        <strong>{result.inserted} new added</strong>,{' '}
        <strong>{result.updated} existing updated</strong>
        {skips.length > 0 ? <>, <strong>{skips.length} skipped</strong></> : null}
        {' '}out of {result.rowsConsidered} row{result.rowsConsidered === 1 ? '' : 's'}.
      </p>
      <p className="muted">Brands and categories referenced by name were created if they didn't exist.</p>

      {orderedKeys.length > 0 ? (
        <div className="import-review__skips">
          {orderedKeys.map((k) => {
            const info = SKIP_CATEGORY_INFO[k] ?? SKIP_CATEGORY_INFO.error;
            const rows = grouped[k];
            return (
              <details key={k} className="import-review__group">
                <summary>
                  <strong>{info.label}</strong>
                  <span className="muted"> · {rows.length} row{rows.length === 1 ? '' : 's'}</span>
                </summary>
                <p className="import-review__hint">{info.hint}</p>
                <ul className="import-review__list">
                  {rows.slice(0, 100).map((r, i) => (
                    <li key={i}>
                      <code>{r.sku || `(row ${r.rowIndex + 1})`}</code>
                      {r.reason ? <span className="muted"> — {r.reason}</span> : null}
                    </li>
                  ))}
                  {rows.length > 100 ? <li className="muted">…and {rows.length - 100} more</li> : null}
                </ul>
              </details>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
