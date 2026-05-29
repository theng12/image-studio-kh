import { useEffect, useState } from 'react';
import { Button, Field, Input, Modal } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

const COLOR_PRESETS = ['#2563eb', '#047857', '#b45309', '#b91c1c', '#7c3aed', '#0891b2', '#1c1c1f'];

function emptyForm() {
  return { name: '', color: COLOR_PRESETS[0], icon: null };
}

function brandToForm(b) {
  return {
    name: b.name ?? '',
    color: b.color ?? COLOR_PRESETS[0],
    icon: b.icon ?? null,
  };
}

export function BrandForm({ open, brand, onClose, onSubmit, onDelete }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const isEdit = !!brand;

  useEffect(() => {
    if (!open) return;
    setForm(brand ? brandToForm(brand) : emptyForm());
    setError(null);
  }, [open, brand]);

  async function handlePickIcon() {
    try {
      const filePath = await window.api.files.pickImageFile();
      if (!filePath) return;
      const { relativePath } = await window.api.brands.uploadIcon(filePath, form.name || 'brand');
      setForm((f) => ({ ...f, icon: relativePath }));
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError('Brand name is required');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ name: form.name.trim(), color: form.color, icon: form.icon });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const iconSrc = form.icon ? `app-image://local/${encodeURIComponent(form.icon)}` : null;

  const footer = (
    <>
      {isEdit ? <Button variant="danger" onClick={onDelete}>Delete</Button> : null}
      <div style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={saving || !form.name.trim()} onClick={handleSave}>
        {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${brand?.name}` : 'New brand'} footer={footer}>
      <div className="form-grid">
        <Field label="Name" required error={error} span="full">
          {({ id }) => (
            <Input
              id={id}
              autoFocus
              value={form.name}
              invalid={!!error}
              onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); if (error) setError(null); }}
              placeholder="e.g. BBC"
            />
          )}
        </Field>

        <Field label="Color" span="full">
          {() => (
            <div className="color-presets">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-preset${form.color === c ? ' is-active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setForm((f) => ({ ...f, color: c }))}
                  aria-label={`Color ${c}`}
                />
              ))}
              <label className="color-preset color-preset--custom" title="Custom">
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                />
              </label>
            </div>
          )}
        </Field>

        <Field label="Icon" hint="Optional. A small logo that appears on cards and lists." span="full">
          {() => (
            <div className="brand-icon-row">
              <div
                className={`brand-icon-preview${iconSrc ? ' has-icon' : ''}`}
                style={iconSrc ? undefined : { background: form.color }}
              >
                {iconSrc ? <img src={iconSrc} alt="" /> : <span>{form.name.slice(0, 2).toUpperCase() || 'BR'}</span>}
              </div>
              <div className="brand-icon-actions">
                <Button onClick={handlePickIcon}>{form.icon ? 'Replace icon…' : 'Upload icon…'}</Button>
                {form.icon ? (
                  <Button variant="ghost" onClick={() => setForm((f) => ({ ...f, icon: null }))}>Remove</Button>
                ) : null}
              </div>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}
