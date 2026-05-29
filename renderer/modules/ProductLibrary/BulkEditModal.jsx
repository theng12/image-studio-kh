/**
 * v0.18.1: BulkEditModal — set the same fields on many products at
 * once. Used by the Library's "Edit selected (N)" toolbar action.
 *
 * Each field has a leading checkbox: only checked fields are
 * included in the patch sent to the server. This lets the user
 * change ONLY the brand without accidentally blanking the category
 * by leaving the dropdown at its default. Clear semantics:
 *   - field unchecked → that field is left untouched on every row
 *   - field checked + value set → that value applied to every row
 *   - field checked + value cleared (empty option) → set to NULL
 *     on every row (intentional "clear this field" workflow)
 */

import { useState } from 'react';
import { Modal, Button, Field, Select, Input, Textarea } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'draft',    label: 'Draft' },
];

export function BulkEditModal({ open, count, productIds, onClose, onDone }) {
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const addToast = useAppStore((s) => s.addToast);

  // Per-field "include in patch" toggles + current values.
  const [enabled, setEnabled] = useState({
    brandId: false, categoryId: false, status: false,
    subcategory: false, colorFinish: false, variant: false, unit: false,
    priceRetail: false, priceWholesale: false, description: false,
  });
  const [values, setValues] = useState({
    brandId: '', categoryId: '', status: 'active',
    subcategory: '', colorFinish: '', variant: '', unit: '',
    priceRetail: '', priceWholesale: '', description: '',
  });
  const [saving, setSaving] = useState(false);

  function setField(key, val) {
    setValues((v) => ({ ...v, [key]: val }));
  }
  function toggleField(key) {
    setEnabled((e) => ({ ...e, [key]: !e[key] }));
  }

  function buildPatch() {
    const patch = {};
    if (enabled.brandId)     patch.brandId      = values.brandId || null;
    if (enabled.categoryId)  patch.categoryId   = values.categoryId || null;
    if (enabled.status)      patch.status       = values.status;
    if (enabled.subcategory) patch.subcategory  = values.subcategory.trim() || null;
    if (enabled.colorFinish) patch.colorFinish  = values.colorFinish.trim() || null;
    if (enabled.variant)     patch.variant      = values.variant.trim() || null;
    if (enabled.unit)        patch.unit         = values.unit.trim() || null;
    if (enabled.priceRetail) {
      const n = Number(values.priceRetail);
      patch.priceRetail = Number.isFinite(n) ? n : null;
    }
    if (enabled.priceWholesale) {
      const n = Number(values.priceWholesale);
      patch.priceWholesale = Number.isFinite(n) ? n : null;
    }
    if (enabled.description) patch.description  = values.description.trim() || null;
    return patch;
  }

  async function handleApply() {
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      addToast('Tick at least one field to apply.', 'info');
      return;
    }
    setSaving(true);
    try {
      const result = await window.api.products.bulkUpdate(productIds, patch);
      const failedCount = result?.failed?.length ?? 0;
      if (failedCount === 0) {
        addToast(`Updated ${result.updated} product${result.updated === 1 ? '' : 's'}.`, 'success');
      } else {
        addToast(
          `Updated ${result.updated} of ${productIds.length} — ${failedCount} failed.`,
          'info',
        );
      }
      // Refresh the Library list so the changes show up.
      useAppStore.getState().refreshProducts();
      useAppStore.getState().refreshAllProducts?.();
      onDone?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const anyEnabled = Object.values(enabled).some(Boolean);

  return (
    <Modal
      open={open}
      title={`Bulk edit · ${count} product${count === 1 ? '' : 's'}`}
      onClose={onClose}
    >
      <div className="bulk-edit">
        <p className="bulk-edit__intro">
          Tick the fields you want to apply to all {count} selected products. Unchecked fields are
          left untouched. Setting a value to <em>(blank)</em> clears that field on every selected row.
        </p>

        <BulkRow label="Brand" enabled={enabled.brandId} onToggle={() => toggleField('brandId')}>
          <Select value={values.brandId} onChange={(e) => setField('brandId', e.target.value)} disabled={!enabled.brandId}>
            <option value="">— Unassigned —</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </BulkRow>

        <BulkRow label="Category" enabled={enabled.categoryId} onToggle={() => toggleField('categoryId')}>
          <Select value={values.categoryId} onChange={(e) => setField('categoryId', e.target.value)} disabled={!enabled.categoryId}>
            <option value="">— Unassigned —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </BulkRow>

        <BulkRow label="Status" enabled={enabled.status} onToggle={() => toggleField('status')}>
          <Select value={values.status} onChange={(e) => setField('status', e.target.value)} disabled={!enabled.status}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </BulkRow>

        <BulkRow label="Color / Finish" enabled={enabled.colorFinish} onToggle={() => toggleField('colorFinish')}>
          <Input value={values.colorFinish} onChange={(e) => setField('colorFinish', e.target.value)} disabled={!enabled.colorFinish} />
        </BulkRow>

        <BulkRow label="Variant" enabled={enabled.variant} onToggle={() => toggleField('variant')}>
          <Input value={values.variant} onChange={(e) => setField('variant', e.target.value)} disabled={!enabled.variant} />
        </BulkRow>

        <BulkRow label="Unit" enabled={enabled.unit} onToggle={() => toggleField('unit')}>
          <Input value={values.unit} onChange={(e) => setField('unit', e.target.value)} disabled={!enabled.unit} />
        </BulkRow>

        <BulkRow label="Subcategory" enabled={enabled.subcategory} onToggle={() => toggleField('subcategory')}>
          <Input value={values.subcategory} onChange={(e) => setField('subcategory', e.target.value)} disabled={!enabled.subcategory} />
        </BulkRow>

        <BulkRow label="Retail price" enabled={enabled.priceRetail} onToggle={() => toggleField('priceRetail')}>
          <Input type="number" value={values.priceRetail} onChange={(e) => setField('priceRetail', e.target.value)} disabled={!enabled.priceRetail} />
        </BulkRow>

        <BulkRow label="Wholesale price" enabled={enabled.priceWholesale} onToggle={() => toggleField('priceWholesale')}>
          <Input type="number" value={values.priceWholesale} onChange={(e) => setField('priceWholesale', e.target.value)} disabled={!enabled.priceWholesale} />
        </BulkRow>

        <BulkRow label="Description" enabled={enabled.description} onToggle={() => toggleField('description')}>
          <Textarea rows={3} value={values.description} onChange={(e) => setField('description', e.target.value)} disabled={!enabled.description} />
        </BulkRow>

        <footer className="bulk-edit__footer">
          <Button onClick={onClose}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            disabled={!anyEnabled || saving}
            onClick={handleApply}
          >
            {saving ? 'Applying…' : `Apply to ${count}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

function BulkRow({ label, enabled, onToggle, children }) {
  return (
    <div className={`bulk-edit__row${enabled ? ' is-enabled' : ''}`}>
      <label className="bulk-edit__toggle">
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        <span>{label}</span>
      </label>
      <div className="bulk-edit__value">{children}</div>
    </div>
  );
}
