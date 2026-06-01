import { useEffect, useRef, useState } from 'react';

// v0.49.15: aspect-ratio presets exposed on the crop toolbar. The chip ids
// are also the value persisted in `settings.cropAspectRatio`. "free" is
// the no-constraint case (default behaviour, drag any rect).
const ASPECT_PRESETS = [
  { id: 'free',  label: 'Free' },
  { id: '1:1',   label: '1:1' },
  { id: '4:3',   label: '4:3' },
  { id: '3:4',   label: '3:4' },
  { id: '16:9',  label: '16:9' },
  { id: '9:16',  label: '9:16' },
];

// Parse a "w:h" string into a numeric ratio (w/h). Accepts ':' / 'x' / '/'
// separators. Returns null on bad input or 'free'.
function parseAspectRatio(str) {
  if (!str || str === 'free') return null;
  const m = String(str).match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (!w || !h) return null;
  return w / h;
}

// The crop rect is normalised against the CANVAS dimensions. A 1:1 OUTPUT
// crop on a non-square canvas needs a non-square normalised rect to
// compensate. This helper converts "user wants output to be ratio R" into
// "rect.width / rect.height should be N" in normalised-canvas terms.
function rectAspectFromOutput(outputAspect, canvasW, canvasH) {
  if (!outputAspect || !canvasW || !canvasH) return null;
  return outputAspect * (canvasH / canvasW);
}

// Centered default rect — used when the user picks a ratio with no existing
// rect, or when they pick Free and want a "reset to default" feel. 80% of
// the shorter normalised dimension, kept inside [0,1].
function centeredRect(rectAspectVal) {
  let w, h;
  if (!rectAspectVal) { w = 0.8; h = 0.8; }
  else if (rectAspectVal >= 1) { w = 0.8; h = w / rectAspectVal; if (h > 0.9) { h = 0.9; w = h * rectAspectVal; } }
  else                          { h = 0.8; w = h * rectAspectVal; if (w > 0.9) { w = 0.9; h = w / rectAspectVal; } }
  return { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h };
}

// Re-shape an existing rect to match a new aspect, preserving the rect\'s
// center. Used when the user changes the ratio chip with a rect already on
// screen — so they don\'t lose their position, just see it re-proportioned.
function reshapeToAspect(rect, rectAspectVal) {
  if (!rect) return centeredRect(rectAspectVal);
  if (!rectAspectVal) return rect; // Free: leave alone
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  // Pick the larger of the two possible reshapes so the rect doesn\'t shrink
  // dramatically (e.g. going from 4:3 to 1:1 should use the shared dimension).
  let w = rect.width, h = w / rectAspectVal;
  const altH = rect.height, altW = altH * rectAspectVal;
  if (altW * altH > w * h) { w = altW; h = altH; }
  if (h > 1) { h = 1; w = h * rectAspectVal; }
  if (w > 1) { w = 1; h = w / rectAspectVal; }
  let x = cx - w / 2, y = cy - h / 2;
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, width: w, height: h };
}

// Given anchor + current pointer (both in normalised canvas coords) and
// an optional aspect lock, build a rect. For free mode this is just the
// drag bounding box. For ratio mode the larger axis of the drag wins and
// the other dimension is derived from ratio; the rect stays anchored at
// the original mousedown point so the drag still feels direct.
function buildDragRect(anchor, current, rectAspectVal) {
  let w = Math.abs(current.x - anchor.x);
  let h = Math.abs(current.y - anchor.y);
  if (rectAspectVal) {
    // Pick the dimension the user dragged "more" of (normalised by the
    // ratio) and derive the other.
    if (w / rectAspectVal > h) h = w / rectAspectVal;
    else                       w = h * rectAspectVal;
  }
  // Anchor on whichever corner of the mousedown point the drag direction
  // implies.
  const x = current.x < anchor.x ? anchor.x - w : anchor.x;
  const y = current.y < anchor.y ? anchor.y - h : anchor.y;
  return clampRect({ x, y, width: Math.max(0.02, w), height: Math.max(0.02, h) });
}

// Clamp a rect into [0,1] × [0,1], shrinking from the overflowing side(s)
// rather than translating, so a near-edge rect doesn\'t suddenly jump.
function clampRect(r) {
  let { x, y, width, height } = r;
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  if (x + width > 1)  width  = 1 - x;
  if (y + height > 1) height = 1 - y;
  width  = Math.max(0.02, width);
  height = Math.max(0.02, height);
  return { x, y, width, height };
}

// v0.49.16: unified resize for both corner (nw/ne/sw/se, 2 chars) and edge
// (n/s/e/w, 1 char) handles. Corner: opposite corner stays anchored.
// Edge: opposite edge stays anchored, perpendicular dim recenters around
// the rect\'s old center. Ratio lock applies in both modes.
function resize(origin, handle, current, rectAspectVal) {
  const isCorner = handle.length === 2;
  if (isCorner) {
    const ox1 = origin.x, oy1 = origin.y;
    const ox2 = origin.x + origin.width, oy2 = origin.y + origin.height;
    const anchorX = handle.includes('w') ? ox2 : ox1;
    const anchorY = handle.includes('n') ? oy2 : oy1;
    let w = Math.max(0.02, Math.abs(current.x - anchorX));
    let h = Math.max(0.02, Math.abs(current.y - anchorY));
    if (rectAspectVal) {
      if (w / rectAspectVal > h) h = w / rectAspectVal;
      else                       w = h * rectAspectVal;
    }
    const x = handle.includes('w') ? anchorX - w : anchorX;
    const y = handle.includes('n') ? anchorY - h : anchorY;
    return clampRect({ x, y, width: w, height: h });
  }
  // Edge handle. cx/cy = rect center; used to recenter the perpendicular
  // axis when ratio is locked.
  const cx = origin.x + origin.width / 2;
  const cy = origin.y + origin.height / 2;
  let x1 = origin.x, y1 = origin.y;
  let x2 = origin.x + origin.width, y2 = origin.y + origin.height;
  if (handle === 'n') y1 = Math.max(0, Math.min(y2 - 0.02, current.y));
  if (handle === 's') y2 = Math.min(1, Math.max(y1 + 0.02, current.y));
  if (handle === 'w') x1 = Math.max(0, Math.min(x2 - 0.02, current.x));
  if (handle === 'e') x2 = Math.min(1, Math.max(x1 + 0.02, current.x));
  let rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  if (rectAspectVal) {
    if (handle === 'n' || handle === 's') {
      const w = Math.min(1, rect.height * rectAspectVal);
      rect.x = Math.max(0, Math.min(1 - w, cx - w / 2));
      rect.width = w;
    } else {
      const h = Math.min(1, rect.width / rectAspectVal);
      rect.y = Math.max(0, Math.min(1 - h, cy - h / 2));
      rect.height = h;
    }
  }
  return clampRect(rect);
}

// Shift a rect by a normalised delta, keeping it inside [0,1].
function moveRect(rect, dx, dy) {
  const x = Math.max(0, Math.min(1 - rect.width,  rect.x + dx));
  const y = Math.max(0, Math.min(1 - rect.height, rect.y + dy));
  return { ...rect, x, y };
}

// v0.49.17: rotate-arrow glyph used by the 90° buttons in the canvas tools
// row. Same shape used to live in SettingsPanel; moved here when the rotate
// controls relocated next to Crop. Drawn as a small curved arrow; the left
// variant just mirrors via CSS transform.
function RotateGlyph({ direction = 'right' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      style={{ transform: direction === 'left' ? 'scaleX(-1)' : 'none' }}
    >
      <path d="M3 7a4 4 0 1 1 1.2 2.85" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 4.5V7h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CanvasView({
  image,
  settings,
  fillPreview,
  viewMode,
  divider,
  onDividerChange,
  processing,
  processingLabel,
  cacheBust = 0,
  zoom = 1,
  onZoomChange,
  guides = false,
  onToggleGuides,
  cropMode = false,
  onToggleCropMode,
  onCropChange,
  // v0.49.15: aspect-ratio crop additions.
  onCropAspectChange,         // (id: string) — picks a chip
  onApplyCrop,                // (destination: 'newImage' | 'overwrite') — commits
  onCancelCrop,               // () — clears rect + exits crop mode
  cropApplying = false,       // disables Apply while IPC is in flight
  // v0.49.17: 90° rotate buttons relocated from SettingsPanel into the
  // canvas tools row. onRotationChange(deg) — parent updates settings.rotation.
  onRotationChange,
}) {
  const containerRef = useRef(null);
  const cropRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  // v0.49.15: cropDrag now tracks one of three modes:
  //   { mode: 'create', anchor: {x,y} }
  //   { mode: 'move',   anchor: {x,y}, origin: rect }       // dragging the rect interior
  //   { mode: 'resize', anchor: {x,y}, origin: rect, handle: 'nw'|'ne'|'sw'|'se' }
  // anchor = pointer at mousedown (normalised), origin = rect at mousedown.
  const [cropDrag, setCropDrag] = useState(null);
  // Local custom-ratio editor — only consumed when the ratio chip == 'custom'.
  // Persisted as the cropAspectRatio settings string ("3:2" etc) once valid.
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  // Destination chosen for the eventual Apply click. Persists locally to
  // the canvas so the user\'s choice survives them adjusting the rect.
  const [cropDestination, setCropDestination] = useState('newImage');

  const rawSrc = image
    ? `app-image://local/${encodeURIComponent(image.filepath)}`
    : null;
  const processedSrc = image?.processedFilepath
    ? `app-image://local/${encodeURIComponent(image.processedFilepath)}?v=${cacheBust}`
    : null;

  useEffect(() => {
    if (!dragging) return undefined;
    function onMove(e) {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      onDividerChange(pct);
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onDividerChange]);

  // v0.49.15: rect-aspect lock derived from the current ratio chip + canvas dims.
  // Recomputed on every render; cheap.
  const outputAspect = parseAspectRatio(settings.cropAspectRatio);
  const rectAspectLock = rectAspectFromOutput(
    outputAspect,
    settings.canvasWidth,
    settings.canvasHeight,
  );

  // v0.49.15: crop drag handles three modes — create / move / resize.
  // Mode is chosen at mousedown time based on the event target (see
  // handleCropMouseDown). Pointer coords are converted to normalised
  // 0..1 fractions of the visible canvas frame so the rect survives zoom.
  useEffect(() => {
    if (!cropDrag) return undefined;
    function pointFromEvent(e) {
      const el = cropRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
      };
    }
    function onMove(e) {
      const p = pointFromEvent(e); if (!p) return;
      if (cropDrag.mode === 'create') {
        onCropChange(buildDragRect(cropDrag.anchor, p, rectAspectLock));
      } else if (cropDrag.mode === 'move') {
        const dx = p.x - cropDrag.anchor.x;
        const dy = p.y - cropDrag.anchor.y;
        onCropChange(moveRect(cropDrag.origin, dx, dy));
      } else if (cropDrag.mode === 'resize') {
        onCropChange(resize(cropDrag.origin, cropDrag.handle, p, rectAspectLock));
      }
    }
    function onUp() { setCropDrag(null); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [cropDrag, onCropChange, rectAspectLock]);

  // Mousedown on the .ws-crop overlay. Routing:
  //   - if target has data-crop-handle → resize that corner
  //   - else if target is inside .ws-crop__rect (and we have a rect) → move
  //   - else → create new rect from this point
  function handleCropMouseDown(e) {
    if (!cropMode || !cropRef.current || cropApplying) return;
    e.preventDefault();
    const r = cropRef.current.getBoundingClientRect();
    const p = {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
    };
    const handle = e.target?.getAttribute?.('data-crop-handle');
    if (handle && settings.cropRect) {
      setCropDrag({ mode: 'resize', anchor: p, origin: settings.cropRect, handle });
      return;
    }
    const isMove = e.target?.classList?.contains('ws-crop__move-zone');
    if (isMove && settings.cropRect) {
      setCropDrag({ mode: 'move', anchor: p, origin: settings.cropRect });
      return;
    }
    // Create — snap to ratio if one is locked.
    const initial = buildDragRect(p, p, rectAspectLock);
    onCropChange(initial);
    setCropDrag({ mode: 'create', anchor: p });
  }

  const canvasStyle = fillPreview
    ? { background: settings.backgroundColor }
    : undefined;

  const aspect = `${settings.canvasWidth} / ${settings.canvasHeight}`;
  const isBeforeAfter = viewMode === 'beforeAfter' && processedSrc;

  const zoomPct = Math.round(zoom * 100);
  const canZoomOut = zoom > 0.25;
  const canZoomIn = zoom < 4;

  return (
    <div className="ws-canvas">
      <div className="ws-canvas__top">
        <div className="ws-canvas__size">
          {settings.canvasWidth} × {settings.canvasHeight}px · {settings.colorProfile}
        </div>
        <div className="ws-canvas__top-info">
          {image?.isProcessed
            ? <span className="ws-canvas__badge ws-canvas__badge--done">Processed</span>
            : <span className="ws-canvas__badge">Raw</span>}
        </div>
      </div>

      <div className="ws-canvas__frame">
        <div className="ws-canvas__zoom-wrap" style={{ transform: `scale(${zoom})` }}>
          <div
            ref={containerRef}
            className={`ws-canvas__board${fillPreview ? '' : ' is-checker'}`}
            style={{ aspectRatio: aspect, ...canvasStyle }}
          >
            {/* Rotation preview: applied via CSS transform to the raw image
                only — the processed thumbnail already bakes rotation into
                the file. Normalised to 0/90/180/270 in 90° steps.
                v0.49.16: when crop mode is active, also tilts by the
                straighten angle so the user sees what they\'re levelling. */}
            {(() => {
              const rotateDeg = ((Math.round(Number(settings?.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
              const straighten = cropMode ? Number(settings.cropStraighten || 0) : 0;
              const totalRotate = rotateDeg + straighten;
              const rawImgStyle = totalRotate !== 0
                ? { transform: `rotate(${totalRotate}deg)`, transformOrigin: 'center center' }
                : undefined;
              if (!image) {
                return <div className="ws-canvas__placeholder">No image selected.</div>;
              }
              if (isBeforeAfter) {
                return (
                  <>
                    <img className="ws-canvas__img" src={rawSrc} alt="raw" style={rawImgStyle} />
                    <div
                      className="ws-canvas__clip"
                      style={{ clipPath: `inset(0 0 0 ${divider}%)` }}
                    >
                      <img className="ws-canvas__img" src={processedSrc} alt="processed" />
                    </div>
                    <div
                      className="ws-canvas__divider"
                      style={{ left: `${divider}%` }}
                      onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
                    >
                      <span className="ws-canvas__divider-handle" aria-label="Drag divider">⇆</span>
                    </div>
                    <div className="ws-canvas__compare-labels">
                      <span>Raw</span>
                      <span>Processed</span>
                    </div>
                  </>
                );
              }
              if (processedSrc) {
                return <img className="ws-canvas__img" src={processedSrc} alt="processed" />;
              }
              return <img className="ws-canvas__img ws-canvas__img--raw" src={rawSrc} alt="raw" style={rawImgStyle} />;
            })()}

            {guides && image ? (
              <div className="ws-canvas__guides" aria-hidden>
                <div className="ws-canvas__guide ws-canvas__guide--v" />
                <div className="ws-canvas__guide ws-canvas__guide--h" />
              </div>
            ) : null}

            {/* v0.49.16: horizontal level reference line — only shown while
                crop mode is on AND the straighten slider is non-zero. Helps
                the user align a horizon / product baseline as they tilt. */}
            {cropMode && Number(settings.cropStraighten || 0) !== 0 ? (
              <div className="ws-crop__level" aria-hidden />
            ) : null}
            {cropMode && image ? (
              <div
                ref={cropRef}
                className="ws-crop"
                onMouseDown={handleCropMouseDown}
              >
                {settings.cropRect ? (
                  <div
                    className="ws-crop__rect"
                    style={{
                      left:   `${settings.cropRect.x * 100}%`,
                      top:    `${settings.cropRect.y * 100}%`,
                      width:  `${settings.cropRect.width  * 100}%`,
                      height: `${settings.cropRect.height * 100}%`,
                    }}
                  >
                    {/* v0.49.15: drag-anywhere-inside-the-rect-to-move zone.
                        Has to be pointer-events:auto (overriding the parent),
                        and sits beneath the corner handles in stacking order
                        so handles win when they overlap the corners. */}
                    <div className="ws-crop__move-zone" />
                    {/* v0.49.15: 4 corner handles + v0.49.16: 4 edge handles.
                        `data-crop-handle` is sniffed by handleCropMouseDown to
                        start a resize. Corners constrain to ratio; edges change
                        one dimension and recenter the other when ratio is locked. */}
                    <span className="ws-crop__handle ws-crop__handle--nw" data-crop-handle="nw" />
                    <span className="ws-crop__handle ws-crop__handle--ne" data-crop-handle="ne" />
                    <span className="ws-crop__handle ws-crop__handle--sw" data-crop-handle="sw" />
                    <span className="ws-crop__handle ws-crop__handle--se" data-crop-handle="se" />
                    <span className="ws-crop__handle ws-crop__handle--n"  data-crop-handle="n" />
                    <span className="ws-crop__handle ws-crop__handle--s"  data-crop-handle="s" />
                    <span className="ws-crop__handle ws-crop__handle--e"  data-crop-handle="e" />
                    <span className="ws-crop__handle ws-crop__handle--w"  data-crop-handle="w" />
                    <span className="ws-crop__hint">
                      {Math.round(settings.cropRect.width * settings.canvasWidth)}
                      ×
                      {Math.round(settings.cropRect.height * settings.canvasHeight)}
                    </span>
                  </div>
                ) : (
                  <div className="ws-crop__instr">
                    {settings.cropAspectRatio && settings.cropAspectRatio !== 'free'
                      ? `Drag on the canvas to set a ${settings.cropAspectRatio} crop`
                      : 'Drag on the canvas to set the crop area'}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {processing ? (
          <div className="ws-canvas__overlay">
            <div className="ws-canvas__spinner" />
            <div className="ws-canvas__overlay-text">{processingLabel ?? 'Processing…'}</div>
          </div>
        ) : null}
      </div>

      <div className="ws-canvas__tools">
        <button
          type="button"
          className="ws-tool"
          disabled={!canZoomOut}
          title="Zoom out"
          onClick={() => onZoomChange(Math.max(0.25, zoom - 0.25))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5 7h4M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <span className="ws-tool__label" title="Zoom level">{zoomPct}%</span>
        <button
          type="button"
          className="ws-tool"
          disabled={!canZoomIn}
          title="Zoom in"
          onClick={() => onZoomChange(Math.min(4, zoom + 0.25))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5 7h4M7 5v4M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ws-tool__sep" />
        <button
          type="button"
          className="ws-tool ws-tool--text"
          title="Reset view (fit canvas to frame)"
          onClick={() => onZoomChange(1)}
        >Reset view</button>
        <div className="ws-tool__sep" />
        <button
          type="button"
          className={`ws-tool ws-tool--text${guides ? ' is-active' : ''}`}
          title="Toggle alignment guides"
          onClick={onToggleGuides}
        >Guides</button>
        <div className="ws-tool__sep" />
        {/* v0.49.17: 90° rotate buttons (left / right / reset) — relocated
            from the SettingsPanel "Orient" block. Always visible because
            rotation is a workspace-wide setting, not a crop-mode toggle.
            Step is exactly 90° so the bake stays lossless in sharp. */}
        <button
          type="button"
          className="ws-tool"
          title="Rotate 90° left"
          aria-label="Rotate 90° left"
          onClick={() => onRotationChange?.(((Number(settings?.rotation ?? 0) - 90) + 360) % 360)}
        >
          <RotateGlyph direction="left" />
        </button>
        <button
          type="button"
          className="ws-tool"
          title="Rotate 90° right"
          aria-label="Rotate 90° right"
          onClick={() => onRotationChange?.((Number(settings?.rotation ?? 0) + 90) % 360)}
        >
          <RotateGlyph direction="right" />
        </button>
        {Number(settings?.rotation ?? 0) !== 0 ? (
          <button
            type="button"
            className="ws-tool ws-tool--text"
            title="Reset rotation to 0°"
            onClick={() => onRotationChange?.(0)}
          >Reset {(((Number(settings?.rotation ?? 0)) % 360) + 360) % 360}°</button>
        ) : null}
        <div className="ws-tool__sep" />
        <button
          type="button"
          className={`ws-tool ws-tool--text${cropMode ? ' is-active' : ''}`}
          title="Crop tool — pick a ratio, drag a rectangle, then Apply"
          onClick={onToggleCropMode}
        >Crop</button>
        {settings.cropRect && !cropMode ? (
          <button
            type="button"
            className="ws-tool ws-tool--text"
            title="Reset crop"
            onClick={() => onCropChange(null)}
          >Reset crop</button>
        ) : null}
      </div>

      {/* v0.49.15: aspect-ratio chip bar + Apply/Cancel. Only visible when
          cropMode is on so the rest of the workspace stays clean. */}
      {cropMode ? (
        <div className="ws-crop-bar">
          <div className="ws-crop-bar__chips" role="radiogroup" aria-label="Crop aspect ratio">
            {ASPECT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={(settings.cropAspectRatio || 'free') === p.id}
                className={`segment${(settings.cropAspectRatio || 'free') === p.id ? ' is-active' : ''}`}
                onClick={() => onCropAspectChange?.(p.id)}
                title={p.id === 'free' ? 'Free — no aspect lock' : `Lock to ${p.id}`}
              >{p.label}</button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={settings.cropAspectRatio === 'custom'}
              className={`segment${settings.cropAspectRatio === 'custom' ? ' is-active' : ''}`}
              onClick={() => onCropAspectChange?.('custom')}
              title="Custom — set a numeric W:H ratio below"
            >Custom</button>
          </div>
          {/* v0.49.16: straighten slider. Range -45..+45°. The image inside
              the canvas tilts with the slider so you can see what you\'re
              levelling against; the crop rect stays axis-aligned. On Apply,
              the server rotates the source by this angle before extracting
              the crop region. */}
          <div className="ws-crop-bar__straighten">
            <span className="ws-crop-bar__label">Straighten</span>
            <input
              type="range"
              min="-45"
              max="45"
              step="0.1"
              value={Number(settings.cropStraighten || 0)}
              onChange={(e) => onCropAspectChange?.(`__straighten:${e.target.value}`)}
              aria-label="Straighten angle"
            />
            <span className="ws-crop-bar__angle">
              {Number(settings.cropStraighten || 0).toFixed(1)}°
            </span>
            {Number(settings.cropStraighten || 0) !== 0 ? (
              <button
                type="button"
                className="ws-tool ws-tool--text"
                onClick={() => onCropAspectChange?.('__straighten:0')}
                title="Reset to 0°"
              >Reset</button>
            ) : null}
          </div>

          {settings.cropAspectRatio === 'custom' || /^custom-/.test(settings.cropAspectRatio || '') ? (
            <div className="ws-crop-bar__custom">
              <input
                type="number"
                min="0.1"
                step="0.1"
                placeholder="W"
                value={customW}
                onChange={(e) => setCustomW(e.target.value)}
                aria-label="Custom ratio width"
              />
              <span>:</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                placeholder="H"
                value={customH}
                onChange={(e) => setCustomH(e.target.value)}
                aria-label="Custom ratio height"
              />
              <button
                type="button"
                className="ws-tool ws-tool--text"
                onClick={() => {
                  const w = Number(customW), h = Number(customH);
                  if (w > 0 && h > 0) onCropAspectChange?.(`custom-${w}:${h}`);
                }}
              >Apply ratio</button>
            </div>
          ) : null}

          <div className="ws-crop-bar__actions">
            <div className="ws-crop-bar__dest" role="radiogroup" aria-label="Crop output destination">
              <button
                type="button"
                role="radio"
                aria-checked={cropDestination === 'newImage'}
                className={`segment${cropDestination === 'newImage' ? ' is-active' : ''}`}
                onClick={() => setCropDestination('newImage')}
                title="Adds a cropped copy as a new product image — original raw is preserved."
              >Save as new</button>
              <button
                type="button"
                role="radio"
                aria-checked={cropDestination === 'overwrite'}
                className={`segment${cropDestination === 'overwrite' ? ' is-active' : ''}`}
                onClick={() => setCropDestination('overwrite')}
                title="Overwrites the source file on disk — no undo."
              >Overwrite source</button>
            </div>
            <button
              type="button"
              className="ws-tool ws-tool--text"
              onClick={onCancelCrop}
              disabled={cropApplying}
            >Cancel</button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onApplyCrop?.(cropDestination)}
              disabled={!settings.cropRect || cropApplying}
            >{cropApplying ? 'Cropping…' : 'Apply crop'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
