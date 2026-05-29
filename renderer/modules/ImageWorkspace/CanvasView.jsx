import { useEffect, useRef, useState } from 'react';

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
}) {
  const containerRef = useRef(null);
  const cropRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [cropDrag, setCropDrag] = useState(null); // { startX, startY }

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

  // Crop drag: track from mousedown → mousemove → mouseup. Coordinates are
  // converted to fractions of the canvas so they survive zoom/resize.
  useEffect(() => {
    if (!cropDrag) return undefined;
    function onMove(e) {
      const el = cropRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const fy = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
      const x = Math.min(cropDrag.startX, fx);
      const y = Math.min(cropDrag.startY, fy);
      const w = Math.abs(fx - cropDrag.startX);
      const h = Math.abs(fy - cropDrag.startY);
      onCropChange({ x, y, width: Math.max(0.02, w), height: Math.max(0.02, h) });
    }
    function onUp() { setCropDrag(null); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [cropDrag, onCropChange]);

  function handleCropMouseDown(e) {
    if (!cropMode || !cropRef.current) return;
    e.preventDefault();
    const rect = cropRef.current.getBoundingClientRect();
    const startX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const startY = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
    onCropChange({ x: startX, y: startY, width: 0.02, height: 0.02 });
    setCropDrag({ startX, startY });
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
                the file. Normalised to 0/90/180/270 in 90° steps. */}
            {(() => {
              const rotateDeg = ((Math.round(Number(settings?.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
              const rawImgStyle = rotateDeg !== 0
                ? { transform: `rotate(${rotateDeg}deg)`, transformOrigin: 'center center' }
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
                    <span className="ws-crop__hint">
                      {Math.round(settings.cropRect.width * settings.canvasWidth)}
                      ×
                      {Math.round(settings.cropRect.height * settings.canvasHeight)}
                    </span>
                  </div>
                ) : (
                  <div className="ws-crop__instr">Drag on the canvas to set the crop area</div>
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
        <button
          type="button"
          className={`ws-tool ws-tool--text${cropMode ? ' is-active' : ''}`}
          title="Crop tool — drag a rectangle on the canvas, then Apply"
          onClick={onToggleCropMode}
        >Crop</button>
        {settings.cropRect ? (
          <button
            type="button"
            className="ws-tool ws-tool--text"
            title="Reset crop"
            onClick={() => onCropChange(null)}
          >Reset crop</button>
        ) : null}
      </div>
    </div>
  );
}
