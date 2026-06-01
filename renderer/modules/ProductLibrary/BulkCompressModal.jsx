// v0.49.34: BulkCompressModal — re-encode at a chosen quality, same format.
//
// Splits out of the v0.49.28-33 combined modal per the v0.49.34 spec: each
// operation is now independent. This one is the QUALITY slider, no format
// change, no resize.
//
// Reuses `images:reencodeProducts` with targetFormat: 'keep' so the
// extension stays put. The backend infers the encoder (jpeg/webp/png) from
// the existing file extension. PNG inputs are still touched (re-encoded
// with compressionLevel 9) but the quality slider is hidden in that case
// since PNG ignores it.

import { useCallback, useEffect, useState } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { BackupReminder } from '../../components/BackupReminder.jsx';
import {
  loadPersistedFormState,
  savePersistedFormState,
  clearPersistedFormState,
} from './persistedFormState.js';

const SCOPE_OPTIONS = [
  { value: 'main', label: 'Main image of each product' },
  { value: 'all',  label: 'All images of each product' },
];

const QUALITY_PRESETS = [
  { value: 60, label: 'Aggressive (60)' },
  { value: 75, label: 'Balanced (75)' },
  { value: 85, label: 'Catalog default (85)' },
  { value: 92, label: 'Near-original (92)' },
];

// v0.49.35: persisted across runs.
const STORAGE_KEY = 'Library.bulkCompress';
const SCHEMA_VERSION = 1;
const DEFAULTS = {
  quality: 85,
  stripMetadata: true,
  scope: 'main',
};

export function BulkCompressModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  // v0.49.35: load last-used picks instead of resetting on every open.
  const initial = loadPersistedFormState(STORAGE_KEY, DEFAULTS, SCHEMA_VERSION);
  const [quality, setQuality] = useState(initial.quality);
  const [stripMetadata, setStripMetadata] = useState(initial.stripMetadata);
  const [scope, setScope] = useState(initial.scope);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRunning(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    savePersistedFormState(
      STORAGE_KEY,
      { quality, stripMetadata, scope },
      SCHEMA_VERSION,
    );
  }, [open, quality, stripMetadata, scope]);

  function handleResetDefaults() {
    setQuality(DEFAULTS.quality);
    setStripMetadata(DEFAULTS.stripMetadata);
    setScope(DEFAULTS.scope);
    clearPersistedFormState(STORAGE_KEY);
  }

  const handleRun = useCallback(async () => {
    if (!productIds?.length) return;
    setRunning(true);
    try {
      const res = await window.api.images.reencodeProducts({
        productIds,
        targetFormat: 'keep',
        quality,
        stripMetadata,
        scope,
        // Compress modal never resizes.
        resize: { mode: 'none' },
      });
      const mb = res?.bytesSaved ? (res.bytesSaved / (1024 * 1024)).toFixed(1) : '0.0';
      const failed = res?.failed || 0;
      const images = res?.images || 0;
      if (failed > 0) {
        addToast(
          `Compressed ${images}, ${failed} failed · ${mb} MB saved`,
          failed === images ? 'error' : 'info',
        );
      } else {
        addToast(
          `Compressed ${images} image${images === 1 ? '' : 's'} · ${mb} MB saved`,
          'success',
        );
      }
      refreshProducts();
      onDone?.();
    } catch (err) {
      addToast(`Compress failed: ${err.message}`, 'error');
    } finally {
      setRunning(false);
    }
  }, [productIds, quality, stripMetadata, scope, addToast, refreshProducts, onDone]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={running ? undefined : onClose}
      title={`Compress · ${productIds?.length ?? 0} product${productIds?.length === 1 ? '' : 's'}`}
      closeOnBackdrop={!running}
      footer={
        <>
          <Button variant="ghost" onClick={handleResetDefaults} disabled={running} title="Discard remembered picks and revert all fields to defaults">
            Reset to defaults
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={running}>Cancel</Button>
          <Button variant="primary" onClick={handleRun} disabled={running}>
            {running ? 'Running…' : `Compress ${productIds?.length ?? 0}`}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Re-encodes each selected image at the chosen quality, keeping its
        existing format. Use to shrink file size without changing the file
        extension. Destructive — overwrites the source bytes. PNG inputs
        are re-encoded losslessly (the slider has no effect on them; consider
        the Convert modal → WebP if you want PNG sizes down).
      </p>

      <BackupReminder />

      <Field
        label={`Quality: ${quality}`}
        hint="Lower = smaller file, more visible compression artefacts. 85 is the catalog default — visible artefacts begin to show below ~75 on flat backgrounds."
      >
        {({ id }) => (
          <input
            id={id}
            type="range"
            min="1"
            max="100"
            step="1"
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            disabled={running}
            style={{ width: '100%' }}
          />
        )}
      </Field>

      <div className="quality-presets" style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        {QUALITY_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`preset-chip${quality === p.value ? ' is-active' : ''}`}
            onClick={() => setQuality(p.value)}
            disabled={running}
            title={`Set quality to ${p.value}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <Field label="Scope">
        {({ id }) => (
          <Select id={id} value={scope} onChange={(e) => setScope(e.target.value)} disabled={running}>
            {SCOPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        )}
      </Field>

      <label className="toggle" style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={stripMetadata}
          onChange={(e) => setStripMetadata(e.target.checked)}
          disabled={running}
        />
        <span>Strip metadata (EXIF, GPS, colour profile)</span>
      </label>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Recommended ON. The pixels are rotated to bake EXIF orientation, so
        the image still reads the right way up.
      </p>
    </Modal>
  );
}
