import { useEffect, useRef, useState } from 'react';
import { appImageSrc } from '../lib/imageUrl.js';
import { exportSpinVideo } from '../lib/spinExport.js';

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
  // v0.42.0: 360° spin mode. When on, the stage becomes drag-to-rotate
  // (horizontal drag scrubs through the product's ordered images as frames)
  // and a play/pause auto-rotates. Reuses `idx` as the current frame, so the
  // existing prev/next + arrow keys still work. Needs ≥2 images to be useful.
  const [spin, setSpin] = useState(false);
  const [playing, setPlaying] = useState(false);
  const dragRef = useRef(null); // { startX, startIdx } while a drag is active
  // v0.43.0: spin video export. `exportState` is null / { stage, ratio }
  // where stage ∈ {'load','render'} mirrors the encoder's onProgress.
  const [exportState, setExportState] = useState(null);
  // v0.26.27: pending-flip preview state. Two booleans because the
  // user can toggle both axes independently (H, V, or both). When
  // EITHER is true, the displayed <img> gets a CSS transform but
  // the file on disk is untouched. Click Apply to commit; Reset (or
  // navigate / close) to discard. This replaces the destructive
  // on-click behaviour from v0.26.14 — you can now flip-preview to
  // see which orientation reads better before re-encoding the JPEG.
  const [pendingFlipH, setPendingFlipH] = useState(false);
  const [pendingFlipV, setPendingFlipV] = useState(false);
  // v0.49.34: per-image metadata for the caption row at the bottom
  // of the stage. Keyed by `${filepath}::${effectiveHash}` so that a
  // post-edit cache-bust also re-fetches metadata (otherwise the
  // user would see "2000×3000 · 1.4 MB" still showing for an image
  // they just resized to 1000×1500). null while loading or unsupported
  // (older preload without `images.getMetadata` → caption silently hidden).
  const [metaCache, setMetaCache] = useState({});
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

  // v0.42.0: reset spin state whenever the modal closes (or the image set
  // changes to something with <2 frames, where spin is meaningless).
  useEffect(() => {
    if (!open || (images?.length ?? 0) < 2) { setSpin(false); setPlaying(false); }
  }, [open, images?.length]);

  // v0.42.0: auto-rotate while playing. Advances one frame ~9fps; loops.
  useEffect(() => {
    if (!open || !spin || !playing || (images?.length ?? 0) < 2) return undefined;
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % images.length);
    }, 110);
    return () => clearInterval(id);
  }, [open, spin, playing, images?.length]);

  // v0.42.0: preload every frame when spin turns on so dragging/rotating is
  // smooth instead of flickering as each frame fetches on first reveal.
  useEffect(() => {
    if (!open || !spin || !images) return undefined;
    const imgs = images.map((im) => {
      const el = new Image();
      el.src = appImageSrc(im.filepath, im.contentHash || im.id || im.filepath);
      return el;
    });
    return () => { imgs.forEach((el) => { el.src = ''; }); };
  }, [open, spin, images]);

  // v0.49.36 HOTFIX — derive `current` / `effectiveHash` BEFORE the
  // metadata-fetch effect that references them. In v0.49.34/35 these
  // `const`s lived AFTER the hooks (and after the `if (!open) return null`
  // early-return), so when React evaluated the effect's deps array on
  // every render, it tried to read `current` from the TDZ — crashing the
  // Library page on mount (which mounts the Lightbox with `open={false}`,
  // so the hook still runs even when the user can't see the lightbox).
  // The crash surfaced as `"Cannot access 'w' before initialization"`
  // (minified name). Order: state hooks → derive `current` / `effectiveHash`
  // → all effect hooks (including the one that needs them in deps) →
  // early-return → JSX. `images?.[idx]` is safe when images is empty.
  const current = images?.[idx];
  // v0.22.9: cache-bust by contentHash → id → filepath. Filepath
  // alone is broken because renumberFiles recycles paths across
  // rows after a delete/reorder. See ImageTile in ProductForm.jsx
  // for the long-form explanation. v0.26.14 adds the per-session
  // hashOverrides lookup so a freshly-flipped image cache-busts
  // immediately, ahead of any parent re-fetch.
  const effectiveHash = hashOverrides[current?.filepath] || current?.contentHash || current?.id || current?.filepath;

  // v0.49.34: fetch image metadata for the caption row whenever the
  // current slide changes (or its content hash changes — that's how a
  // flip / resize / re-encode invalidates the row). Three guards:
  //   - productId is required by the IPC. AI gallery's lightbox doesn't
  //     pass productId, so metadata silently stays hidden — fine.
  //   - The cache check skips re-fetching for the same (filepath, hash)
  //     pair. Important so navigating away and back to the same slide
  //     doesn't re-hit IPC unnecessarily.
  //   - Older preloads without `images.getMetadata` get a soft skip
  //     (typeof check) so the lightbox doesn't blow up on a stale build.
  useEffect(() => {
    if (!open || !current?.filepath || !productId) return undefined;
    if (typeof window?.api?.images?.getMetadata !== 'function') return undefined;
    const fp = current.filepath;
    const key = `${fp}::${effectiveHash}`;
    if (metaCache[key]) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const m = await window.api.images.getMetadata(productId, fp);
        if (!cancelled) setMetaCache((prev) => ({ ...prev, [key]: m }));
      } catch (_) {
        // Non-fatal — the caption is a nice-to-have. Leaving the key
        // unset lets a future open retry without sticky-bad state.
      }
    })();
    return () => { cancelled = true; };
    // metaCache intentionally omitted from deps — we only want the
    // effect to re-fire when slide / hash changes, not when the cache
    // grows. The `metaCache[key]` check above guards the same key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.filepath, effectiveHash, productId]);

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

  // v0.49.36: `current` + `effectiveHash` are derived above (so the
  // metadata useEffect's deps array can read them without a TDZ). The
  // rest of the render-only derivations stay here — they're consumed
  // only inside the JSX below, not by any hook.
  const src = appImageSrc(current?.filepath, effectiveHash);
  // v0.49.34: metadata cache key includes the hash so a flip / resize /
  // re-encode invalidates the cached row automatically (same filepath,
  // different bytes → new key → re-fetch).
  const metaKey = current?.filepath ? `${current.filepath}::${effectiveHash}` : null;
  const meta = metaKey ? metaCache[metaKey] : null;

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

  // v0.42.0: drag-to-rotate. ~26px of horizontal drag = one frame. Dragging
  // LEFT advances (object spins toward you), matching every 360° viewer.
  const SPIN_PX_PER_FRAME = 26;
  function onSpinPointerDown(e) {
    if (!spin || !images || images.length < 2) return;
    setPlaying(false); // grabbing it pauses auto-rotate
    dragRef.current = { startX: e.clientX, startIdx: idx };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function onSpinPointerMove(e) {
    const d = dragRef.current;
    if (!d || !images || images.length < 2) return;
    const deltaFrames = Math.round(-(e.clientX - d.startX) / SPIN_PX_PER_FRAME);
    const n = images.length;
    setIdx(((d.startIdx + deltaFrames) % n + n) % n);
  }
  function onSpinPointerUp(e) {
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
  }

  // v0.43.0: encode the spin to MP4 (or WebM fallback) and trigger a download.
  // Frame URLs come from the same appImageSrc() the spin viewer uses, so the
  // encoded file is byte-aligned with what the user sees on screen.
  async function handleExportSpin() {
    if (!images || images.length < 2 || exportState) return;
    setPlaying(false);
    const urls = images.map((im) => appImageSrc(im.filepath, im.contentHash || im.id || im.filepath));
    // Filename from the lightbox title (usually "SKU · Name"); fall back to "spin".
    const skuRaw = (title || '').split('·')[0].trim() || 'spin';
    const safeSku = skuRaw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'spin';
    setExportState({ stage: 'load', ratio: 0 });
    try {
      const out = await exportSpinVideo(urls, {
        fps: 12,
        loops: 2,
        maxSide: 1024,
        format: 'mp4',
        onProgress: (stage, ratio) => setExportState({ stage, ratio }),
      });
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeSku}-spin.${out.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke a tick so Chromium can pick the blob up before we drop it.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      window.alert(`Spin export failed: ${err.message}`);
    } finally {
      setExportState(null);
    }
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
          {spin ? <span className="lightbox__filename"> · 360° spin</span>
            : (current?.filename ? <span className="lightbox__filename"> · {current.filename}</span> : null)}
        </div>
        {/* v0.49.41: moved the image-metadata caption (added v0.49.34)
            up here into the header. Pre-v0.49.41 it floated at the
            bottom of the stage at `bottom: 28px`, which sat right on
            top of the Flip H / Flip V toolbar — the words physically
            overlapped on every product that had a flip-eligible main
            image. The header is dead space below the counter, has no
            other UI competing for it, and groups identity info
            together (counter / filename / dims / size / format) which
            reads better than splitting them across opposite ends of
            the lightbox anyway. Only renders when productId is set
            (Library is the caller); the AI gallery's lightbox stays
            uncluttered. */}
        {productId ? (
          <div className="lightbox__meta">
            {renderMetaCaption(meta)}
          </div>
        ) : null}
        {images.length > 1 ? (
          <div className="lightbox__spin-controls">
            <button
              type="button"
              className={`lightbox__spinbtn${spin ? ' is-active' : ''}`}
              onClick={() => { setSpin((s) => !s); setPlaying(false); }}
              title="Spin 360° — drag left/right over the image to rotate through its angle shots"
              aria-pressed={spin}
            >
              <SpinIcon />
              <span>360° Spin</span>
            </button>
            {spin ? (
              <button
                type="button"
                className="lightbox__spinbtn"
                onClick={() => setPlaying((p) => !p)}
                title={playing ? 'Pause auto-rotate' : 'Auto-rotate'}
                aria-pressed={playing}
              >
                {playing ? 'Pause' : 'Play'}
              </button>
            ) : null}
            {spin ? (
              <button
                type="button"
                className="lightbox__spinbtn"
                onClick={handleExportSpin}
                disabled={!!exportState}
                title="Encode the spin as a video file (MP4, or WebM fallback) and download it. Two loops at 12fps."
              >
                {exportState
                  ? `${exportState.stage === 'load' ? 'Loading' : 'Encoding'} ${Math.round(exportState.ratio * 100)}%`
                  : 'Export'}
              </button>
            ) : null}
          </div>
        ) : null}
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

      <div
        className={`lightbox__stage${spin ? ' lightbox__stage--spin' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={spin ? onSpinPointerDown : undefined}
        onPointerMove={spin ? onSpinPointerMove : undefined}
        onPointerUp={spin ? onSpinPointerUp : undefined}
        onPointerCancel={spin ? onSpinPointerUp : undefined}
      >
        {src ? (
          <img
            className="lightbox__image"
            src={src}
            alt={current.filename ?? ''}
            draggable={false}
            // v0.26.27: in-memory preview of the pending flip. The
            // file on disk is unchanged until Apply is clicked; this
            // is purely visual so the user can compare orientations
            // without paying the re-encode cost on every click.
            style={previewTransform ? { transform: previewTransform } : undefined}
          />
        ) : (
          <div className="lightbox__placeholder">No image</div>
        )}
        {spin ? (
          <div className="lightbox__spin-hint">↤ drag to rotate ↦</div>
        ) : null}
      </div>

      {/* v0.49.34 had the metadata caption here, absolutely positioned at
          `bottom: 28px`. v0.49.41 moved it up into the lightbox__header
          (below the counter line) because the bottom position physically
          overlapped the Flip H / Flip V toolbar at the same vertical band.
          See the new <div className="lightbox__meta"> inside lightbox__header
          above. */}

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

// v0.49.34: caption pieces. Kept module-level so they don't allocate on
// every render. `null` meta (still loading) renders a thin placeholder
// instead of jumping the layout when the data arrives.
function renderMetaCaption(meta) {
  if (!meta) {
    return <span className="lightbox__caption-loading">…</span>;
  }
  if (!meta.exists) {
    return <span className="lightbox__caption-missing">File missing on disk</span>;
  }
  const dims = (meta.width && meta.height) ? `${meta.width} × ${meta.height}` : null;
  const size = Number.isFinite(meta.fileSize) ? formatBytes(meta.fileSize) : null;
  const fmt = meta.format ? meta.format.toUpperCase() : null;
  const mp = (meta.width && meta.height)
    ? `${((meta.width * meta.height) / 1_000_000).toFixed(1)} MP`
    : null;
  const alpha = meta.hasAlpha ? 'alpha' : null;
  const hash = meta.contentHash ? `sha:${String(meta.contentHash).slice(0, 8)}` : null;
  const parts = [dims, mp, size, fmt, alpha, hash].filter(Boolean);
  return parts.map((p, i) => (
    <span key={i} className="lightbox__caption-part">
      {i > 0 ? <span className="lightbox__caption-sep" aria-hidden> · </span> : null}
      {p}
    </span>
  ));
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
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
function SpinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <ellipse cx="8" cy="8" rx="6.5" ry="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.2 6.6A6.6 3 0 0 0 8 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3.4 4.3l-1.2 2.3 2.4.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
