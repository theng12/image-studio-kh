// v0.49.34: BulkConvertModal — change image format in batch.
//
// Splits out of the v0.49.28-33 combined "Convert · compress · resize" modal
// per the v0.49.34 spec: each operation is now independent. This one is the
// FORMAT picker, no resize, no compression-only path.
//
// Reuses the same `images:reencodeProducts` IPC — only the args differ. The
// renderer just gates which knobs are exposed; the backend does the same
// sharp pass either way.

import { useCallback, useEffect, useState } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { BackupReminder } from '../../components/BackupReminder.jsx';
import {
  loadPersistedFormState,
  savePersistedFormState,
  clearPersistedFormState,
} from './persistedFormState.js';

const FORMAT_OPTIONS = [
  // No "keep" here — this modal is explicitly for changing the format.
  // If the user picks the same format as the source, the converter still
  // runs (and re-encodes at the chosen quality), which is fine but rare
  // intent. The Compress modal is the better tool for that case.
  { value: 'jpeg', label: 'JPEG (.jpg) — smaller, lossy, no alpha' },
  { value: 'png',  label: 'PNG (.png) — larger, lossless, alpha preserved' },
  { value: 'webp', label: 'WebP (.webp) — smaller than JPEG at same quality' },
];

const SCOPE_OPTIONS = [
  { value: 'main', label: 'Main image of each product' },
  { value: 'all',  label: 'All images of each product' },
];

// v0.49.35: persisted across runs. Bump SCHEMA_VERSION when the shape of
// DEFAULTS changes incompatibly so older stored blobs are dropped instead
// of fed into the new code path.
const STORAGE_KEY = 'Library.bulkConvert';
const SCHEMA_VERSION = 1;
const DEFAULTS = {
  targetFormat: 'jpeg',
  quality: 85,
  stripMetadata: true,
  scope: 'main',
};

export function BulkConvertModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  // v0.49.34 reset every option to defaults on open. v0.49.35: load the
  // user's last-used picks from localStorage and ONLY reset `running`
  // (which is a one-shot per click, not a preference). The user repeats
  // the same Convert spec across many product groups in a batch session;
  // reset-on-open was just friction.
  const initial = loadPersistedFormState(STORAGE_KEY, DEFAULTS, SCHEMA_VERSION);
  const [targetFormat, setTargetFormat] = useState(initial.targetFormat);
  const [quality, setQuality] = useState(initial.quality);
  const [stripMetadata, setStripMetadata] = useState(initial.stripMetadata);
  const [scope, setScope] = useState(initial.scope);
  const [running, setRunning] = useState(false);

  // Per-open: drop the running flag so a previous in-flight indicator
  // from a hard-cancel can't get stuck across reopens.
  useEffect(() => {
    if (!open) return;
    setRunning(false);
  }, [open]);

  // Persist on any option change while the modal is open. The `open` guard
  // means the initial render (before any user click) doesn't write — the
  // first save fires only after the user actually touches a control.
  useEffect(() => {
    if (!open) return;
    savePersistedFormState(
      STORAGE_KEY,
      { targetFormat, quality, stripMetadata, scope },
      SCHEMA_VERSION,
    );
  }, [open, targetFormat, quality, stripMetadata, scope]);

  function handleResetDefaults() {
    setTargetFormat(DEFAULTS.targetFormat);
    setQuality(DEFAULTS.quality);
    setStripMetadata(DEFAULTS.stripMetadata);
    setScope(DEFAULTS.scope);
    clearPersistedFormState(STORAGE_KEY);
  }

  // Quality slider is meaningful for JPEG / WebP (lossy). PNG is lossless,
  // so hide it instead of greying it out — less cognitive load.
  const qualityRelevant = targetFormat === 'jpeg' || targetFormat === 'webp';

  const handleRun = useCallback(async () => {
    if (!productIds?.length) return;
    setRunning(true);
    try {
      const res = await window.api.images.reencodeProducts({
        productIds,
        targetFormat,
        quality,
        stripMetadata,
        scope,
        // Convert modal never resizes — pass mode:'none' explicitly so a
        // future backend change can't default-on a resize behind our back.
        resize: { mode: 'none' },
      });
      const mb = res?.bytesSaved ? (res.bytesSaved / (1024 * 1024)).toFixed(1) : '0.0';
      const failed = res?.failed || 0;
      const images = res?.images || 0;
      if (failed > 0) {
        addToast(
          `Converted ${images}, ${failed} failed · ${mb} MB saved`,
          failed === images ? 'error' : 'info',
        );
      } else {
        addToast(
          `Converted ${images} image${images === 1 ? '' : 's'} to ${targetFormat.toUpperCase()} · ${mb} MB saved`,
          'success',
        );
      }
      refreshProducts();
      onDone?.();
    } catch (err) {
      addToast(`Convert failed: ${err.message}`, 'error');
    } finally {
      setRunning(false);
    }
  }, [productIds, targetFormat, quality, stripMetadata, scope, addToast, refreshProducts, onDone]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={running ? undefined : onClose}
      title={`Convert format · ${productIds?.length ?? 0} product${productIds?.length === 1 ? '' : 's'}`}
      closeOnBackdrop={!running}
      footer={
        <>
          <Button variant="ghost" onClick={handleResetDefaults} disabled={running} title="Discard remembered picks and revert all fields to defaults">
            Reset to defaults
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={running}>Cancel</Button>
          <Button variant="primary" onClick={handleRun} disabled={running}>
            {running ? 'Running…' : `Convert ${productIds?.length ?? 0}`}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Re-encodes each selected image into the target format. The file on
        disk is replaced and renamed when the extension changes (e.g.
        <code> sku-001.png → sku-001.jpg</code>).
        Destructive — the original bytes are overwritten.
      </p>

      <BackupReminder />

      <Field label="Target format" hint="Switching to JPEG drops alpha channels — any transparency lands on the background you'd fill behind it (use the Resize modal if you need an explicit fill).">
        {({ id }) => (
          <Select id={id} value={targetFormat} onChange={(e) => setTargetFormat(e.target.value)} disabled={running}>
            {FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        )}
      </Field>

      {qualityRelevant ? (
        <Field
          label={`Quality: ${quality}`}
          hint="85 is the catalog sweet spot. JPEG / WebP only — PNG is lossless and ignores this."
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
      ) : null}

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
        Recommended ON for catalog images. The pixels are rotated to bake EXIF
        orientation, so the image still displays the right way up afterwards.
      </p>
    </Modal>
  );
}
