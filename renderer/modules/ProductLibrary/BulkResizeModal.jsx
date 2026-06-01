// v0.49.34: BulkResizeModal — change pixel dimensions in batch.
//
// Splits out of the v0.49.28-33 combined modal per the v0.49.34 spec: each
// operation is now independent. This one is the PIXEL RESIZE, no format
// change, fixed near-original re-encode quality.
//
// Two modes the user actually wants:
//   - "Max long edge"  — cap whichever side is longer at N px, preserve
//                        aspect, never upscale. The common "shrink everything
//                        to 2000px for the web" case.
//   - "Exact W × H"    — match a hard spec (e.g. Amazon 2000×2000). Three
//                        fit modes:
//                          cover   = crop excess to fill the target
//                          contain = letterbox to fit inside the target,
//                                    padding with the chosen background
//                          fill    = stretch to match exactly
//                        v0.49.34 adds the BACKGROUND COLOUR picker the
//                        v0.49.29 version was missing — without it,
//                        `contain` fit on JPEG produced black bars (sharp's
//                        default `{r:0,g:0,b:0,alpha:0}`), and on PNG /
//                        WebP it produced transparent bars that looked
//                        invisible against any background — both reading
//                        to users as "nothing changed". Now defaults to
//                        white and is user-pickable.
//
// Quality is fixed at 92 (near-original) — this modal is about pixel
// dimensions, not file-size reduction. Drop to the Compress modal if you
// also want to shrink bytes.

import { useCallback, useEffect, useState } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { BackupReminder } from '../../components/BackupReminder.jsx';
import {
  loadPersistedFormState,
  savePersistedFormState,
  clearPersistedFormState,
} from './persistedFormState.js';

const RESIZE_MODES = [
  { value: 'longEdge', label: 'Max long edge (preserve aspect, never upscale)' },
  { value: 'exact',    label: 'Exact width × height' },
];

const FIT_MODES = [
  { value: 'cover',   label: 'Cover — fill target, crop excess (no padding)' },
  { value: 'contain', label: 'Contain — fit inside target, pad sides with chosen bg' },
  { value: 'fill',    label: 'Fill — stretch to exact target (distorts aspect ratio)' },
];

const SCOPE_OPTIONS = [
  { value: 'main', label: 'Main image of each product' },
  { value: 'all',  label: 'All images of each product' },
];

const BG_SWATCHES = ['#FFFFFF', '#F5F5F5', '#000000', '#808080', '#1A1A1A'];

// v0.49.35: persisted across runs.
const STORAGE_KEY = 'Library.bulkResize';
const SCHEMA_VERSION = 1;
const DEFAULTS = {
  resizeMode: 'longEdge',
  longEdge: 2000,
  width: 2000,
  height: 2000,
  fit: 'cover',
  background: '#FFFFFF',
  stripMetadata: true,
  scope: 'main',
};

export function BulkResizeModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  // v0.49.35: load last-used picks instead of resetting on every open. The
  // common workflow is "Resize 2000×2000 cover white on group A, then on
  // group B, then on group C" — re-picking 8 fields every group was the
  // friction the user flagged.
  const initial = loadPersistedFormState(STORAGE_KEY, DEFAULTS, SCHEMA_VERSION);
  const [resizeMode, setResizeMode] = useState(initial.resizeMode);
  const [longEdge, setLongEdge] = useState(initial.longEdge);
  const [width, setWidth] = useState(initial.width);
  const [height, setHeight] = useState(initial.height);
  const [fit, setFit] = useState(initial.fit);
  // v0.49.34: background colour for `contain` fit. Defaults to white —
  // catalog convention + matches what the user is most likely to want.
  const [background, setBackground] = useState(initial.background);
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
      { resizeMode, longEdge, width, height, fit, background, stripMetadata, scope },
      SCHEMA_VERSION,
    );
  }, [open, resizeMode, longEdge, width, height, fit, background, stripMetadata, scope]);

  function handleResetDefaults() {
    setResizeMode(DEFAULTS.resizeMode);
    setLongEdge(DEFAULTS.longEdge);
    setWidth(DEFAULTS.width);
    setHeight(DEFAULTS.height);
    setFit(DEFAULTS.fit);
    setBackground(DEFAULTS.background);
    setStripMetadata(DEFAULTS.stripMetadata);
    setScope(DEFAULTS.scope);
    clearPersistedFormState(STORAGE_KEY);
  }

  const handleRun = useCallback(async () => {
    if (!productIds?.length) return;
    setRunning(true);
    try {
      const resize = resizeMode === 'longEdge'
        ? { mode: 'longEdge', longEdge }
        : { mode: 'exact', width, height, fit, background };
      const res = await window.api.images.reencodeProducts({
        productIds,
        // Resize never changes format — pass 'keep' so the extension stays.
        targetFormat: 'keep',
        // Near-original quality so resize doesn't double as a compress.
        quality: 92,
        stripMetadata,
        scope,
        resize,
      });
      const mb = res?.bytesSaved ? (res.bytesSaved / (1024 * 1024)).toFixed(1) : '0.0';
      const failed = res?.failed || 0;
      const images = res?.images || 0;
      const label = resizeMode === 'longEdge'
        ? `≤ ${longEdge}px long edge`
        : `${width}×${height} (${fit})`;
      if (failed > 0) {
        addToast(
          `Resized ${images}, ${failed} failed · ${label}`,
          failed === images ? 'error' : 'info',
        );
      } else {
        addToast(
          `Resized ${images} image${images === 1 ? '' : 's'} to ${label} · ${mb} MB saved`,
          'success',
        );
      }
      refreshProducts();
      onDone?.();
    } catch (err) {
      addToast(`Resize failed: ${err.message}`, 'error');
    } finally {
      setRunning(false);
    }
  }, [productIds, resizeMode, longEdge, width, height, fit, background, stripMetadata, scope, addToast, refreshProducts, onDone]);

  if (!open) return null;

  const showBackground = resizeMode === 'exact' && fit === 'contain';

  return (
    <Modal
      open={open}
      onClose={running ? undefined : onClose}
      title={`Resize · ${productIds?.length ?? 0} product${productIds?.length === 1 ? '' : 's'}`}
      closeOnBackdrop={!running}
      footer={
        <>
          <Button variant="ghost" onClick={handleResetDefaults} disabled={running} title="Discard remembered picks and revert all fields to defaults">
            Reset to defaults
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={running}>Cancel</Button>
          <Button variant="primary" onClick={handleRun} disabled={running}>
            {running ? 'Running…' : `Resize ${productIds?.length ?? 0}`}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Resamples each selected image to the chosen pixel dimensions. Re-encodes
        at near-original quality (92) — to also shrink file size, use the
        Compress modal afterwards. Destructive — overwrites the source bytes.
      </p>

      <BackupReminder />

      <Field label="Mode">
        {({ id }) => (
          <Select id={id} value={resizeMode} onChange={(e) => setResizeMode(e.target.value)} disabled={running}>
            {RESIZE_MODES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        )}
      </Field>

      {resizeMode === 'longEdge' ? (
        <Field label="Max long edge (px)" hint="Whichever side is longer gets capped at this; the other side scales to preserve aspect ratio. Images already smaller are left alone (no upscaling).">
          {({ id }) => (
            <input
              id={id}
              type="number"
              min="16"
              max="8000"
              step="100"
              value={longEdge}
              onChange={(e) => setLongEdge(Number(e.target.value) || 0)}
              disabled={running}
              style={{ width: 140, padding: '6px 8px' }}
            />
          )}
        </Field>
      ) : null}

      {resizeMode === 'exact' ? (
        <>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <Field label="Width (px)">
              {({ id }) => (
                <input
                  id={id}
                  type="number"
                  min="16"
                  max="8000"
                  step="100"
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value) || 0)}
                  disabled={running}
                  style={{ width: 120, padding: '6px 8px' }}
                />
              )}
            </Field>
            <Field label="Height (px)">
              {({ id }) => (
                <input
                  id={id}
                  type="number"
                  min="16"
                  max="8000"
                  step="100"
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value) || 0)}
                  disabled={running}
                  style={{ width: 120, padding: '6px 8px' }}
                />
              )}
            </Field>
          </div>

          <Field label="Fit mode" hint="How to handle aspect-ratio mismatch between source and target. If the source aspect already matches the target, all three modes produce the same pixels (no visible difference).">
            {({ id }) => (
              <Select id={id} value={fit} onChange={(e) => setFit(e.target.value)} disabled={running}>
                {FIT_MODES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>

          {/* v0.49.34: background colour picker for `contain` fit. Only
              visible when fit:'contain' is selected because the colour is
              irrelevant for cover (no padding produced) and fill (no
              padding produced). Hiding instead of greying drops one
              control off the form when it doesn't matter. */}
          {showBackground ? (
            <Field
              label="Background colour"
              hint="The colour painted into the padding when the source aspect doesn’t match the target. Only used by Contain. JPEG outputs flatten transparency onto this colour too."
            >
              {() => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <input
                    type="color"
                    value={background}
                    onChange={(e) => setBackground(e.target.value.toUpperCase())}
                    disabled={running}
                    style={{ width: 44, height: 32, padding: 0, border: '1px solid var(--border, #ccc)', borderRadius: 4 }}
                    aria-label="Pick background colour"
                  />
                  <span className="muted" style={{ fontFamily: 'monospace', minWidth: 70 }}>{background}</span>
                  <div className="swatch-row" style={{ display: 'flex', gap: 6 }}>
                    {BG_SWATCHES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setBackground(c)}
                        disabled={running}
                        title={c}
                        aria-label={`Set background to ${c}`}
                        style={{
                          width: 22, height: 22, border: '1px solid var(--border, #ccc)',
                          borderRadius: 4, background: c, cursor: running ? 'default' : 'pointer',
                          outline: background.toUpperCase() === c.toUpperCase() ? '2px solid var(--accent, #3b82f6)' : 'none',
                          outlineOffset: 1,
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </Field>
          ) : null}
        </>
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
        Pixels are rotated to bake EXIF orientation first, so the width/height
        you set above are the dimensions you’ll see in viewers — no "my 2000×3000
        portrait came out 3000×2000 landscape" surprises.
      </p>
    </Modal>
  );
}
