/**
 * v0.37.0: AutoCropRunModal — "tidy up a batch of shots" surface.
 * v0.38.0: added a live before/after preview on a sample image + a
 *          "skip preview" toggle (persisted) for once you trust it.
 *
 * Runs the reframe engine with autoCrop:true over EVERY image of the
 * selected products: it trims the solid background border down to the
 * product's bounding box, then re-frames each product to the same fill %
 * and margin on a fill-coloured canvas. The payoff is a uniform catalog
 * look from a mixed bag of tight/loose/AI shots — without hand-reframing
 * each one.
 *
 * Preview: the modal shows the first selected product's main image
 * before → after, re-rendering as you drag the sliders. It uses the same
 * images:reframePreview channel as the per-image Reframe tab (which now
 * honours autoCrop), so the preview is byte-for-byte what the batch will
 * produce on that image. A "Skip preview" checkbox hides the pane for the
 * current run — it is a pure in-session toggle that always starts OFF
 * (preview shown) each time the modal opens; nothing is remembered.
 *
 * The batch itself is synchronous like BulkOverlayRunModal: the button
 * blocks ("Auto-cropping…") until the backend returns stats. The edit is
 * in place and overwrites the file (no per-image undo), so the modal says
 * so up front and the preview is the safety net.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';
import { useAppStore } from '../../store/index.js';

export function AutoCropRunModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  const [fillPct, setFillPct] = useState(88);      // product fill % → scale
  const [tolerance, setTolerance] = useState(12);  // background match → trimThreshold
  const [fillMode, setFillMode] = useState('color');
  const [fillColor, setFillColor] = useState('#FFFFFF');
  const [submitting, setSubmitting] = useState(false);

  // In-session only: always starts OFF (preview shown) on open, not remembered.
  const [skipPreview, setSkipPreview] = useState(false);

  // Sample image for the preview = first selected product's main image.
  const [sample, setSample] = useState(null); // { productId, filepath, contentHash, sku }
  const [afterUrl, setAfterUrl] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const afterUrlRef = useRef(null);
  const debounceRef = useRef(null);

  const count = productIds?.length ?? 0;

  // Reset to sensible defaults + load the sample image each time we open.
  useEffect(() => {
    if (!open) return;
    setFillPct(88);
    setTolerance(12);
    setFillMode('color');
    setFillColor('#FFFFFF');
    setSubmitting(false);
    setSkipPreview(false);
    setSample(null);
    setAfterUrl(null);

    const firstId = productIds && productIds[0];
    if (!firstId) return;
    let cancelled = false;
    window.api.images.listByProduct(firstId)
      .then((imgs) => {
        if (cancelled) return;
        const main = imgs && imgs[0];
        if (main) {
          setSample({
            productId: firstId,
            filepath: main.filepath,
            contentHash: main.contentHash,
            sku: main.sku,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, productIds]);

  const renderPreview = useCallback(async () => {
    if (!open || skipPreview || !sample) return;
    setPreviewBusy(true);
    try {
      const res = await window.api.images.reframePreview({
        productId: sample.productId,
        filepath: sample.filepath,
        scale: fillPct / 100,
        offsetX: 0,
        offsetY: 0,
        fillMode,
        fillColor,
        autoCrop: true,
        trimThreshold: tolerance,
      });
      const bytes = res?.bytes;
      if (!bytes) return;
      const blob = new Blob([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      if (afterUrlRef.current) URL.revokeObjectURL(afterUrlRef.current);
      afterUrlRef.current = url;
      setAfterUrl(url);
    } catch (err) {
      addToast(`Preview failed: ${err.message}`, 'error');
    } finally {
      setPreviewBusy(false);
    }
  }, [open, skipPreview, sample, fillPct, tolerance, fillMode, fillColor, addToast]);

  // Debounced live preview whenever the controls (or sample) change.
  useEffect(() => {
    if (!open || skipPreview) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(renderPreview, 240);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [open, skipPreview, renderPreview]);

  // Revoke the blob URL on close/unmount.
  useEffect(() => () => { if (afterUrlRef.current) URL.revokeObjectURL(afterUrlRef.current); }, []);

  async function handleSubmit() {
    if (count === 0) { addToast('No products selected', 'info'); return; }
    setSubmitting(true);
    try {
      const res = await window.api.images.autoCropProducts({
        productIds,
        scale: fillPct / 100,
        fillMode,
        fillColor,
        trimThreshold: tolerance,
      });
      const imgs = res?.images ?? 0;
      const prods = res?.products ?? 0;
      const failed = res?.failed ?? 0;
      const missing = res?.missing ?? 0;
      if (failed === 0 && missing === 0) {
        addToast(`Auto-cropped ${imgs} image${imgs === 1 ? '' : 's'} across ${prods} product${prods === 1 ? '' : 's'}`, 'success');
      } else {
        const bits = [`${imgs} image${imgs === 1 ? '' : 's'}`];
        if (failed) bits.push(`${failed} failed`);
        if (missing) bits.push(`${missing} missing on disk`);
        addToast(`Auto-crop done — ${bits.join(', ')}`, failed > 0 ? 'error' : 'info');
      }
      refreshProducts();
      onDone?.(res);
      onClose?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const beforeUrl = sample ? appImageSrc(sample.filepath, sample.contentHash) : null;

  return (
    <Modal open={open} title="Auto-crop to product" onClose={onClose}>
      <div className="autocrop-run">
        <p className="autocrop-run__intro">
          Trims the background border down to the product, then re-frames every
          image of the {count} selected product{count === 1 ? '' : 's'} to the
          same fill and margin — for a uniform catalog look. Works best on
          solid / white backgrounds; busy or full-bleed shots are just
          re-centered. This overwrites the images in place (no per-image undo),
          so check the preview first.
        </p>

        {!skipPreview ? (
          <div className="autocrop-run__preview">
            <figure>
              <div className="autocrop-run__pv-img">
                {beforeUrl ? <img src={beforeUrl} alt="before" /> : <span className="muted">No sample image</span>}
              </div>
              <figcaption>Before{sample?.sku ? ` · ${sample.sku}` : ''}</figcaption>
            </figure>
            <div className="autocrop-run__pv-arrow" aria-hidden="true">→</div>
            <figure>
              <div className="autocrop-run__pv-img">
                {afterUrl ? (
                  <img src={afterUrl} alt="after" style={previewBusy ? { opacity: 0.5 } : undefined} />
                ) : (
                  <span className="muted">{sample ? 'Rendering…' : 'No sample image'}</span>
                )}
              </div>
              <figcaption>After (preview)</figcaption>
            </figure>
          </div>
        ) : null}

        <Field label="Product fill" hint={`Product fills ~${fillPct}% of the frame; the rest is margin.`}>
          {({ id }) => (
            <div className="autocrop-run__slider">
              <input
                id={id}
                type="range"
                min="60"
                max="100"
                step="1"
                value={fillPct}
                onChange={(e) => setFillPct(Number(e.target.value))}
                disabled={submitting}
              />
              <span className="autocrop-run__slider-val">{fillPct}%</span>
            </div>
          )}
        </Field>

        <Field
          label="Background tolerance"
          hint="How aggressively to treat near-corner colours as background. Raise it if off-white / noisy backgrounds aren't trimming; lower it if the product edge gets clipped."
        >
          {({ id }) => (
            <div className="autocrop-run__slider">
              <input
                id={id}
                type="range"
                min="2"
                max="40"
                step="1"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
                disabled={submitting}
              />
              <span className="autocrop-run__slider-val">{tolerance}</span>
            </div>
          )}
        </Field>

        <Field label="Margin fill">
          {({ id }) => (
            <div className="autocrop-run__fill">
              <Select id={id} value={fillMode} onChange={(e) => setFillMode(e.target.value)} disabled={submitting}>
                <option value="color">Solid colour</option>
                <option value="blur">Blurred copy of the image</option>
              </Select>
              {fillMode === 'color' ? (
                <input
                  type="color"
                  className="autocrop-run__swatch"
                  value={fillColor}
                  onChange={(e) => setFillColor(e.target.value.toUpperCase())}
                  disabled={submitting}
                  aria-label="Margin fill colour"
                  title="Margin fill colour"
                />
              ) : null}
            </div>
          )}
        </Field>

        <label className="autocrop-run__skip">
          <input
            type="checkbox"
            checked={skipPreview}
            onChange={(e) => setSkipPreview(e.target.checked)}
            disabled={submitting}
          />
          <span>Skip preview for this run</span>
        </label>

        <footer className="autocrop-run__footer">
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button variant="primary" disabled={submitting || count === 0} onClick={handleSubmit}>
            {submitting ? 'Auto-cropping…' : `Auto-crop ${count} product${count === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
