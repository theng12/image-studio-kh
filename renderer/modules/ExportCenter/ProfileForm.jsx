import { useEffect, useState } from 'react';
import { Button, Field, Input, Modal, Select } from '../../components/ui.jsx';
import { MARKETPLACE_PRESETS, getAllPresets } from '../../lib/presets.js';

const FORMATS = [
  { value: 'jpg',  label: 'JPG' },
  { value: 'png',  label: 'PNG' },
  { value: 'webp', label: 'WEBP' },
  // v0.35.0: AVIF — ~50% smaller than JPEG at similar quality, keeps alpha.
  { value: 'avif', label: 'AVIF (smallest)' },
];

const TOKENS = [
  { id: 'SKU',   label: '{SKU}' },
  { id: 'NAME',  label: '{NAME}' },
  { id: 'COLOR', label: '{COLOR}' },
  { id: 'BRAND', label: '{BRAND}' },
  { id: 'INDEX', label: '{INDEX}' },
  { id: 'DATE',  label: '{DATE}' },
];

const SEPARATORS = [
  { value: '-', label: 'Dash (-)' },
  { value: '_', label: 'Underscore (_)' },
  { value: '',  label: 'None' },
];

function emptyForm() {
  return {
    name: '',
    marketplace: '',
    width: 2000,
    height: 2000,
    format: 'jpg',
    quality: 88,
    backgroundColor: '#FFFFFF',
    colorProfile: 'sRGB',
    namingTokens: ['SKU', 'INDEX'],
    separator: '-',
    outputSubfolder: '',
    // v0.49.42: per-profile {INDEX} formatting.
    indexPad: 3,
    indexPrefix: '',
  };
}

function patternToTokens(pattern) {
  const tokens = [];
  const re = /\{([A-Z]+)\}/g;
  let m;
  while ((m = re.exec(pattern || '')) !== null) {
    if (TOKENS.find((t) => t.id === m[1])) tokens.push(m[1]);
  }
  return tokens;
}

function tokensToPattern(tokens, sep) {
  return tokens.map((t) => `{${t}}`).join(sep ?? '-');
}

function profileToForm(p) {
  // Derive the separator from the pattern (look at the first non-token char).
  const sepMatch = /\}([^{}\s]*)\{/.exec(p.namingPattern || '');
  const inferredSep = sepMatch ? sepMatch[1] : '-';
  return {
    name: p.name ?? '',
    marketplace: p.marketplace ?? '',
    width: p.width ?? 2000,
    height: p.height ?? 2000,
    format: p.format ?? 'jpg',
    quality: p.quality ?? 88,
    backgroundColor: p.backgroundColor ?? '#FFFFFF',
    colorProfile: p.colorProfile ?? 'sRGB',
    namingTokens: patternToTokens(p.namingPattern || '{SKU}-{INDEX}'),
    separator: SEPARATORS.find((s) => s.value === inferredSep) ? inferredSep : '-',
    outputSubfolder: p.outputSubfolder ?? '',
    indexPad: p.indexPad ?? 3,
    indexPrefix: p.indexPrefix ?? '',
  };
}

export function ProfileForm({ open, profile, onClose, onSubmit, onDelete }) {
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [customPresets, setCustomPresets] = useState([]);
  const isEdit = !!profile;

  useEffect(() => {
    if (!open) return;
    setForm(profile ? profileToForm(profile) : emptyForm());
    setError(null);
    window.api?.settings.getAll().then((c) => setCustomPresets(c?.customPresets ?? [])).catch(() => {});
  }, [open, profile]);

  const allPresets = getAllPresets(customPresets);

  function applyPreset(preset) {
    setForm((f) => ({
      ...f,
      name: f.name || preset.name,
      marketplace: preset.id,
      width: preset.width,
      height: preset.height,
      format: preset.format,
      colorProfile: preset.colorProfile,
    }));
  }

  function addToken(token) {
    setForm((f) =>
      f.namingTokens.includes(token) ? f : { ...f, namingTokens: [...f.namingTokens, token] },
    );
  }

  function removeToken(idx) {
    setForm((f) => ({ ...f, namingTokens: f.namingTokens.filter((_, i) => i !== idx) }));
  }

  function moveToken(idx, dir) {
    setForm((f) => {
      const next = [...f.namingTokens];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return f;
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...f, namingTokens: next };
    });
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError('Profile name is required');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        name: form.name.trim(),
        marketplace: form.marketplace || null,
        width: form.width,
        height: form.height,
        format: form.format,
        quality: form.quality,
        backgroundColor: form.backgroundColor,
        colorProfile: form.colorProfile,
        namingPattern: tokensToPattern(form.namingTokens.length ? form.namingTokens : ['SKU', 'INDEX'], form.separator),
        outputSubfolder: form.outputSubfolder.trim() || null,
        indexPad: form.indexPad,
        indexPrefix: form.indexPrefix,
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const previewPattern = tokensToPattern(form.namingTokens, form.separator);
  const previewExample = form.namingTokens.map((t) => {
    switch (t) {
      case 'SKU':   return 'bbc-tile-001';
      case 'NAME':  return 'matte-tile';
      case 'COLOR': return 'matte-white';
      case 'BRAND': return 'bbc';
      case 'INDEX': return (form.indexPrefix || '') + String(1).padStart(Number(form.indexPad) || 3, '0');
      case 'DATE':  return new Date().toISOString().slice(0, 10);
      default:      return '';
    }
  }).filter(Boolean).join(form.separator) + (form.format === 'png' ? '.png' : form.format === 'webp' ? '.webp' : form.format === 'avif' ? '.avif' : '.jpg');

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
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${profile?.name}` : 'New export profile'} footer={footer} size="xl">
      <div className="form-grid">
        <Field label="Profile name" required error={error} span="full">
          {({ id }) => (
            <Input
              id={id}
              autoFocus
              value={form.name}
              invalid={!!error}
              onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); if (error) setError(null); }}
              placeholder="e.g. Amazon listings"
            />
          )}
        </Field>

        <Field label="Marketplace preset" hint="Quick-fill size, format, and color profile. Custom presets are managed in Settings." span="full">
          {() => (
            <div className="preset-row">
              {allPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset-chip${form.marketplace === p.id ? ' is-active' : ''}${p.custom ? ' is-custom' : ''}`}
                  onClick={() => applyPreset(p)}
                  title={p.custom ? 'Custom preset' : undefined}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </Field>

        <Field label="Width (px)">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min="64" max="8192"
              value={form.width}
              onChange={(e) => setForm((f) => ({ ...f, width: Number(e.target.value) || 0, marketplace: '' }))}
            />
          )}
        </Field>
        <Field label="Height (px)">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min="64" max="8192"
              value={form.height}
              onChange={(e) => setForm((f) => ({ ...f, height: Number(e.target.value) || 0, marketplace: '' }))}
            />
          )}
        </Field>

        <Field label="Format">
          {({ id }) => (
            <Select id={id} value={form.format} onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))}>
              {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          )}
        </Field>

        <Field label="Quality" hint={form.format === 'png' ? 'Not used for PNG' : '1–100'}>
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min="1" max="100"
              disabled={form.format === 'png'}
              value={form.quality}
              onChange={(e) => setForm((f) => ({ ...f, quality: Math.max(1, Math.min(100, Number(e.target.value) || 0)) }))}
            />
          )}
        </Field>

        <Field label="Background fill" hint="Used when output has no transparency (JPG, or PNG/WEBP with opaque fill).">
          {({ id }) => (
            <div className="field__row">
              <Input
                id={id}
                value={form.backgroundColor}
                onChange={(e) => setForm((f) => ({ ...f, backgroundColor: e.target.value }))}
              />
              <label className="swatch swatch--inline" style={{ background: form.backgroundColor }} title="Pick color">
                <input
                  type="color"
                  value={form.backgroundColor}
                  onChange={(e) => setForm((f) => ({ ...f, backgroundColor: e.target.value }))}
                />
              </label>
            </div>
          )}
        </Field>

        <Field label="Color profile" hint="sRGB is the safe choice for marketplaces.">
          {({ id }) => (
            <Select id={id} value={form.colorProfile} onChange={(e) => setForm((f) => ({ ...f, colorProfile: e.target.value }))}>
              <option value="sRGB">sRGB</option>
              <option value="Display P3">Display P3 (label only — output is sRGB)</option>
            </Select>
          )}
        </Field>

        <Field label="Output subfolder" hint="Optional folder name created under the export root." span="full">
          {({ id }) => (
            <Input
              id={id}
              value={form.outputSubfolder}
              onChange={(e) => setForm((f) => ({ ...f, outputSubfolder: e.target.value }))}
              placeholder="e.g. Amazon-2026-Q2"
            />
          )}
        </Field>

        <Field label="File naming pattern" hint="Click a token to add it. Use the arrows to reorder, × to remove." span="full">
          {() => (
            <div className="naming-builder">
              <div className="naming-builder__tokens">
                {TOKENS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="token-chip"
                    onClick={() => addToken(t.id)}
                    disabled={form.namingTokens.includes(t.id)}
                  >
                    + {t.label}
                  </button>
                ))}
              </div>
              <div className="naming-builder__sequence">
                {form.namingTokens.length === 0 ? (
                  <span className="muted">Add at least one token above.</span>
                ) : (
                  form.namingTokens.map((tok, idx) => (
                    <span key={`${tok}-${idx}`} className="token-block">
                      <button
                        type="button"
                        className="token-block__arrow"
                        onClick={() => moveToken(idx, -1)}
                        disabled={idx === 0}
                        aria-label="Move earlier"
                      >←</button>
                      <span className="token-block__label">{tok}</span>
                      <button
                        type="button"
                        className="token-block__arrow"
                        onClick={() => moveToken(idx, 1)}
                        disabled={idx === form.namingTokens.length - 1}
                        aria-label="Move later"
                      >→</button>
                      <button
                        type="button"
                        className="token-block__remove"
                        onClick={() => removeToken(idx)}
                        aria-label="Remove token"
                      >×</button>
                    </span>
                  ))
                )}
              </div>
              <div className="naming-builder__sep">
                <span>Separator</span>
                <Select value={form.separator} onChange={(e) => setForm((f) => ({ ...f, separator: e.target.value }))}>
                  {SEPARATORS.map((s) => <option key={s.label} value={s.value}>{s.label}</option>)}
                </Select>
              </div>

              {/* v0.49.42: per-profile {INDEX} format — digit width + optional
                  prefix. Only shown when the {INDEX} token is actually used. */}
              {form.namingTokens.includes('INDEX') ? (
                <div className="naming-builder__index">
                  <div className="naming-builder__index-field">
                    <span>Index digits</span>
                    <Select
                      value={String(form.indexPad)}
                      onChange={(e) => setForm((f) => ({ ...f, indexPad: Number(e.target.value) }))}
                    >
                      <option value="1">1 — 1, 2, 3</option>
                      <option value="2">2 — 01, 02</option>
                      <option value="3">3 — 001, 002</option>
                      <option value="4">4 — 0001, 0002</option>
                    </Select>
                  </div>
                  <div className="naming-builder__index-field">
                    <span>Index prefix</span>
                    <Input
                      value={form.indexPrefix}
                      placeholder="none (e.g. A → A001)"
                      maxLength={8}
                      onChange={(e) => setForm((f) => ({
                        // Letters/digits only — mirrors the server-side sanitiser.
                        ...f, indexPrefix: e.target.value.replace(/[^A-Za-z0-9]/g, ''),
                      }))}
                    />
                  </div>
                </div>
              ) : null}
              <div className="naming-builder__preview">
                <span className="naming-builder__preview-label">Preview</span>
                <code>{previewExample}</code>
                <span className="naming-builder__preview-pattern">{previewPattern || '(empty)'}</span>
              </div>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}
