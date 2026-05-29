import { useEffect, useState } from 'react';
import { appImageSrc } from '../lib/imageUrl.js';

/**
 * Full-screen image preview overlay. Shows one image at a time with
 * prev/next navigation when the caller supplies multiple. Designed for
 * quick "is this the right photo?" checks from the Product Library
 * without having to open the Image Workspace.
 *
 * Keyboard: ← / → to navigate, Esc to close. Backdrop click closes too.
 * The caller controls open/close state — this component is purely
 * presentational.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {Array<{ filepath: string, filename?: string }>} props.images
 *   Images to show. Each must have a `filepath` (resolves under
 *   `app-image://local/<encoded>`).
 * @param {number} [props.startIndex] — initial slide. Defaults to 0.
 * @param {string} [props.title] — header label (e.g. SKU · Name).
 * @param {string} [props.productId] — optional. When supplied (only the
 *   Library passes it; AI gallery doesn't), enables the destructive
 *   Flip H / Flip V buttons that rewrite the source file in place via
 *   `window.api.images.flipSource`. Without this prop, the flip
 *   controls are hidden.
 * @param {(updatedImage) => void} [props.onImageMutated] — callback
 *   the parent uses to refresh its image cache after a flip. The
 *   Lightbox handles its own local cache-bust separately, but the
 *   parent needs to know so it shows fresh pixels when the user
 *   reopens the preview from a different entry point.
 */
export function Lightbox({ open, onClose, images, startIndex = 0, title, productId, onImageMutated }) {
  const [idx, setIdx] = useState(startIndex);
  // v0.26.14: per-image local cache-bust override. Keyed by filepath →
  // a SHA-1 hash returned by the flipSource IPC. Used to bump the
  // `?v=…` URL the moment the flip succeeds so the browser actually
  // fetches the new pixels (the parent's `images` prop may still hold
  // the OLD content hash for one or two render cycles before the
  // parent re-fetches via the live-update bus).
  const [hashOverrides, setHashOverrides] = useState({});
  // 'idle' | 'flipping' — disables the buttons while the IPC is in
  // flight so the user can't fire a second flip that races against
  // the file rename.
  const [flipState, setFlipState] = useState('idle');
  // v0.26.27: pending-flip preview state. Two booleans because the
  // user can toggle both axes independently (H, V, or both). When
  // EITHER is true, the displayed <img> gets a CSS transform but
  // the file on disk is untouched. Click Apply to commit; Reset (or
  // navigate / close) to discard. This replaces the destructive
  // on-click behaviour from v0.26.14 — you can now flip-preview to
  // see which orientation reads better before re-encoding the JPEG.
  const [pendingFlipH, setPendingFlipH] = useState(false);
  const [pendingFlipV, setPendingFlipV] = useState(false);
  // Reset pending state whenever the displayed image changes
  // (navigate via arrow keys / nav buttons, or open the lightbox at
  // a new startIndex). Without this, you'd flip image #1, hit →,
  // and image #2 would inherit the flip — surprising.
  useEffect(() => {
    setPendingFlipH(false);
    setPendingFlipV(false);
  }, [idx, open]);

  // Re-sync the slide index whenever the modal (re)opens. The parent passes
  // a fresh startIndex when the user clicks a specific thumbnail.
  useEffect(() => {
    if (open) setIdx(Math.max(0, Math.min(startIndex, (images?.length ?? 1) - 1)));
  }, [open, startIndex, images?.length]);

  // Reset the hash-override cache when the lightbox closes — next open
  // gets a fresh parent fetch and we don't want stale overrides shadowing it.
  useEffect(() => {
    if (!open) setHashOverrides({});
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // v0.26.13: capture-phase + stopImmediatePropagation so the
    // Lightbox CLAIMS the Esc key while it's open, ahead of any
    // other window-level Esc listeners further down the page
    // (notably ProductForm.jsx, whose own Esc handler clears the
    // selected product in the Library side panel). Without this,
    // pressing Esc with the Lightbox open over a selected product
    // fired both handlers — the panel cleared at the same instant
    // the Lightbox closed, so the user saw the selection vanish
    // alongside the preview. Now: 1st Esc closes the Lightbox
    // only; a 2nd Esc (after the Lightbox is gone) reaches the
    // panel handler normally. Matches the Mac-native "Esc closes
    // the topmost overlay" model.
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (!images || images.length <= 1) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); e.stopImmediatePropagation(); setIdx((i) => (i - 1 + images.length) % images.length); }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); setIdx((i) => (i + 1) % images.length); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, images, onClose]);

  if (!open || !images || images.length === 0) return null;

  const current = images[idx];
  // v0.22.9: cache-bust by contentHash → id → filepath. Filepath
  // alone is broken because renumberFiles recycles paths across
  // rows after a delete/reorder. See ImageTile in ProductForm.jsx
  // for the long-form explanation. v0.26.14 adds the per-session
  // hashOverrides lookup so a freshly-flipped image cache-busts
  // immediately, ahead of any parent re-fetch.
  const effectiveHash = hashOverrides[current?.filepath] || current?.contentHash || current?.id || current?.filepath;
  const src = appImageSrc(current?.filepath, effectiveHash);

  // Flip is only available when (a) the parent supplied productId
  // and (b) the IPC is exposed (preload wires it in v0.26.14+). The
  // optional chain on flipSource guards against an older preload.
  const canFlip = !!productId && typeof window?.api?.images?.flipSource === 'function';

  // v0.26.27: toggle the pending flip in-memory. No IPC call here —
  // file stays untouched until the user clicks Apply. Toggling the
  // same axis twice cancels it out (so you can preview-then-undo
  // without committing).
  function toggleFlip(axis) {
    if (!canFlip) return;
    if (axis === 'h') setPendingFlipH((v) => !v);
    if (axis === 'v') setPendingFlipV((v) => !v);
  }

  // Commit the pending flip(s) to disk via the same IPC the v0.26.14
  // destructive flip used. Combined H+V sends axis: 'both' so the
  // backend does one re-encode instead of two — less lossy on JPEG,
  // half the disk work.
  async function applyFlip() {
    if (!canFlip || flipState === 'flipping' || !current?.filepath) return;
    if (!pendingFlipH && !pendingFlipV) return;
    const axis = pendingFlipH && pendingFlipV ? 'both' : pendingFlipH ? 'h' : 'v';
    setFlipState('flipping');
    try {
      const updated = await window.api.images.flipSource(productId, current.filepath, axis);
      if (updated?.contentHash) {
        setHashOverrides((prev) => ({ ...prev, [current.filepath]: updated.contentHash }));
      }
      onImageMutated?.(updated);
      // The persisted bytes now reflect the flipped orientation, so
      // the CSS transform should go away — otherwise the user would
      // see "flipped-on-disk + flipped-by-CSS = original orientation
      // back on screen", which is confusing.
      setPendingFlipH(false);
      setPendingFlipV(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[lightbox] flip failed:', err);
      window.alert(`Flip failed: ${err.message}`);
    } finally {
      setFlipState('idle');
    }
  }

  // Drop pending flips without committing. Cheaper version of
  // toggling both axes off — single click, clear intent.
  function resetFlip() {
    setPendingFlipH(false);
    setPendingFlipV(false);
  }

  const hasPendingFlip = pendingFlipH || pendingFlipV;
  // CSS transform composed from the two booleans. scaleX(-1) =
  // mirror left↔right; scaleY(-1) = mirror top↕bottom. Both =
  // equivalent to rotate(180deg) — same visual either way.
  const previewTransform = hasPendingFlip
    ? `scaleX(${pendingFlipH ? -1 : 1}) scaleY(${pendingFlipV ? -1 : 1})`
    : undefined;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button
        type="button"
        className="lightbox__close"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close (Esc)"
        title="Close (Esc)"
      >×</button>

      <div className="lightbox__header" onClick={(e) => e.stopPropagation()}>
        {title ? <div className="lightbox__title">{title}</div> : null}
        <div className="lightbox__counter">
          {idx + 1} / {images.length}
          {current?.filename ? <span className="lightbox__filename"> · {current.filename}</span> : null}
        </div>
      </div>

      {/* v0.26.27: preview-then-apply flip toolbar. Replaces the
          v0.26.14 destructive-on-click design with a two-step flow:
          click Flip H / Flip V to PREVIEW (CSS transform on the
          displayed image, file on disk untouched), then click Apply
          to actually re-encode. Lets you check which orientation
          reads better without paying the JPEG re-encode cost on
          every click.

          The two flip buttons are toggles — clicking the same axis
          twice cancels the preview. Apply + Reset only appear when
          there's a pending flip. Switching to another image
          discards the preview automatically (see effect above). */}
      {canFlip ? (
        <div className="lightbox__tools" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`lightbox__tool${pendingFlipH ? ' is-active' : ''}`}
            onClick={() => toggleFlip('h')}
            disabled={flipState === 'flipping'}
            title="Preview a horizontal flip (mirror left ↔ right). Click Apply to save."
            aria-label="Flip horizontally"
            aria-pressed={pendingFlipH}
          >
            <FlipHIcon />
            <span>Flip H</span>
          </button>
          <button
            type="button"
            className={`lightbox__tool${pendingFlipV ? ' is-active' : ''}`}
            onClick={() => toggleFlip('v')}
            disabled={flipState === 'flipping'}
            title="Preview a vertical flip (mirror top ↕ bottom). Click Apply to save."
            aria-label="Flip vertically"
            aria-pressed={pendingFlipV}
          >
            <FlipVIcon />
            <span>Flip V</span>
          </button>
          {hasPendingFlip ? (
            <>
              <div className="lightbox__tool-sep" aria-hidden />
              <button
                type="button"
                className="lightbox__tool lightbox__tool--reset"
                onClick={resetFlip}
                disabled={flipState === 'flipping'}
                title="Discard the preview without saving"
              >
                Reset
              </button>
              <button
                type="button"
                className="lightbox__tool lightbox__tool--apply"
                onClick={applyFlip}
                disabled={flipState === 'flipping'}
                title="Save the flipped orientation to disk. Re-encodes the file (small JPEG quality loss)."
              >
                {flipState === 'flipping' ? 'Applying…' : 'Apply'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {images.length > 1 ? (
        <button
          type="button"
          className="lightbox__nav lightbox__nav--prev"
          onClick={(e) => { e.stopPropagation(); setIdx((i) => (i - 1 + images.length) % images.length); }}
          aria-label="Previous image"
        >‹</button>
      ) : null}

      <div className="lightbox__stage" onClick={(e) => e.stopPropagation()}>
        {src ? (
          <img
            className="lightbox__image"
            src={src}
            alt={current.filename ?? ''}
            // v0.26.27: in-memory preview of the pending flip. The
            // file on disk is unchanged until Apply is clicked; this
            // is purely visual so the user can compare orientations
            // without paying the re-encode cost on every click.
            style={previewTransform ? { transform: previewTransform } : undefined}
          />
        ) : (
          <div className="lightbox__placeholder">No image</div>
        )}
      </div>

      {images.length > 1 ? (
        <button
          type="button"
          className="lightbox__nav lightbox__nav--next"
          onClick={(e) => { e.stopPropagation(); setIdx((i) => (i + 1) % images.length); }}
          aria-label="Next image"
        >›</button>
      ) : null}
    </div>
  );
}

// Inline SVG icons (per CLAUDE.md §16 — no icon library). 16px,
// stroke-based, currentColor so they pick up the button text colour.
function FlipHIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2v12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 5l-2 3 2 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 5l2 3-2 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FlipVIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 8h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 3l3-2 3 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 13l3 2 3-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
