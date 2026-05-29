import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

/**
 * v0.29.0: per-image Reframe — the manual touch-up after a bulk overlay
 * inset. Sometimes a single AI shot still fills too much of the frame, so
 * here you shrink just THAT image within its own frame and fill the margin
 * (blurred copy / white / a colour, or the image's own background via the
 * eyedropper), with a live preview. Save commits it in place (same pattern
 * as flip — it overwrites the file and bumps the cache-bust hash).
 *
 * Reuses the exact reframe engine the bulk overlay inset uses, so a
 * hand-reframed image looks identical to a bulk-reframed one.
 */
function expandHex(hex) {
  const s = String(hex || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toUpperCase();
  return '#FFFFFF';
}

export function ReframeModal({ open, productId, image, onClose, onSaved }) {
  const addToast = useAppStore((s) => s.addToast);

  const [scale, setScale] = useState(0.85);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [fillMode, setFillMode] = useState('color');
  const [fillColor, setFillColor] = useState('#FFFFFF');
  const [previewUrl, setPreviewUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const debounceRef = useRef(null);
  const urlRef = useRef(null);

  const filepath = image?.filepath;
  const isWhite = (fillColor || '').toUpperCase() === '#FFFFFF';

  // Reset controls each time a new image opens.
  useEffect(() => {
    if (!open) return;
    setScale(0.85); setOffsetX(0); setOffsetY(0);
    setFillMode('color'); setFillColor('#FFFFFF');
  }, [open, filepath]);

  const renderPreview = useCallback(async () => {
    if (!open || !productId || !filepath) return;
    setBusy(true);
    try {
      const res = await window.api.images.reframePreview({
        productId, filepath, scale, offsetX, offsetY, fillMode, fillColor,
      });
      const bytes = res?.bytes;
      if (!bytes) return;
      const blob = new Blob([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setPreviewUrl(url);
    } catch (err) {
      addToast(`Preview failed: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [open, productId, filepath, scale, offsetX, offsetY, fillMode, fillColor, addToast]);

  // Debounced live preview on any control change.
  useEffect(() => {
    if (!open) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(renderPreview, 220);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [open, renderPreview]);

  // Revoke the blob URL on unmount/close.
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  async function handleEyedrop() {
    try {
      const hex = await window.api.images.sampleImageBgColor(productId, filepath);
      setFillMode('color');
      setFillColor(hex);
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await window.api.images.reframeImage({ productId, filepath, scale, offsetX, offsetY, fillMode, fillColor });
      addToast('Image reframed', 'success');
      onSaved?.();
      onClose();
    } catch (err) {
      addToast(`Reframe failed: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <Button onClick={onClose} disabled={saving}>Cancel</Button>
      <Button variant="primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save reframed image'}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title="Reframe image" footer={footer} size="xl" closeOnBackdrop={!saving}>
      <div className="reframe">
        <div className="reframe__canvas">
          {previewUrl
            ? <img src={previewUrl} alt="Reframe preview" />
            : <div className="reframe__placeholder muted">{busy ? 'Rendering…' : 'Preview'}</div>}
        </div>
        <div className="reframe__controls">
          <p className="ws-hint" style={{ marginTop: 0 }}>
            Shrink this image within its own frame so an overlay has clear margin, then fill the gap.
            Commits in place — the image is overwritten with the reframed version.
          </p>

          <label className="reframe__row">
            <span>Size <span className="muted">{Math.round(scale * 100)}%</span></span>
            <input type="range" min="40" max="100" step="1"
              value={Math.round(scale * 100)}
              onChange={(e) => setScale(Number(e.target.value) / 100)} />
          </label>

          <label className="reframe__row">
            <span>Nudge ↔ <span className="muted">{offsetX}</span></span>
            <input type="range" min="-100" max="100" step="1" value={offsetX}
              onChange={(e) => setOffsetX(Number(e.target.value))} />
          </label>
          <label className="reframe__row">
            <span>Nudge ↕ <span className="muted">{offsetY}</span></span>
            <input type="range" min="-100" max="100" step="1" value={offsetY}
              onChange={(e) => setOffsetY(Number(e.target.value))} />
          </label>

          <div className="reframe__row">
            <span>Margin fill</span>
            <div className="ws-toolbar__group">
              <button type="button" className={`segment${fillMode === 'blur' ? ' is-active' : ''}`}
                onClick={() => setFillMode('blur')} title="Blurred copy of the image">Blur</button>
              <button type="button" className={`segment${fillMode === 'color' && isWhite ? ' is-active' : ''}`}
                onClick={() => { setFillMode('color'); setFillColor('#FFFFFF'); }}>White</button>
              <button type="button" className={`segment${fillMode === 'color' && !isWhite ? ' is-active' : ''}`}
                onClick={() => { setFillMode('color'); if (isWhite) setFillColor('#F2F2F2'); }}>Colour</button>
            </div>
          </div>

          {fillMode === 'color' && (
            <div className="reframe__row">
              <span>Colour</span>
              <div className="ws-toolbar__group" style={{ alignItems: 'center', gap: 10 }}>
                <input type="color" className="ovl-inset-swatch" value={expandHex(fillColor)}
                  onChange={(e) => setFillColor(e.target.value.toUpperCase())} aria-label="Margin fill colour" />
                <button type="button" className="segment" onClick={handleEyedrop}
                  title="Sample this image's own background colour for a seamless fill">⦿ Match bg</button>
              </div>
            </div>
          )}

          <div className="reframe__row">
            <button type="button" className="linklike"
              onClick={() => { setScale(0.85); setOffsetX(0); setOffsetY(0); }}>Reset position</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
