import { Badge } from '../../components/ui.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';

/**
 * v0.26.8: thumbnails got an extra "preview" affordance. Clicking the
 * row body still SELECTS the image as the active workspace target
 * (existing behaviour — primary action for editing flow). A small
 * magnifying-glass icon button overlays the top-right of the thumb
 * on hover and calls `onPreview(idx)` to open the Lightbox. That
 * matches the Library's thumb-click behaviour without disrupting the
 * workspace's switch-then-edit workflow.
 *
 * Double-click as a fallback: anywhere on the thumb opens the
 * lightbox too. The user reported the Library lightbox UX as the
 * natural mental model and asked for the same thing here; double-
 * click is the universal "open" gesture from Finder / Photos so it
 * works without rediscovery.
 */
export function ImageStrip({ images, activeIndex, onSelect, onPreview }) {
  const total = images.length;
  const done = images.filter((i) => i.isProcessed).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <aside className="ws-strip" aria-label="Product images">
      <div className="ws-strip__header">
        <span className="ws-strip__title">Images</span>
        <span className="ws-strip__count">{total}</span>
      </div>
      <div className="ws-strip__list">
        {images.map((img, idx) => {
          const active = idx === activeIndex;
          const src = appImageSrc(img.filepath, img.contentHash || img.id || img.filepath);
          return (
            <div
              key={img.id ?? img.filepath}
              className={`ws-thumb${active ? ' is-active' : ''}`}
            >
              {/* Body is the SELECT click target (switches workspace
                  active image). Wrapped in a button for keyboard +
                  ARIA correctness. Double-click also opens the lightbox
                  so people who try Finder-style "open" gestures still
                  get the right result. */}
              <button
                type="button"
                className="ws-thumb__body"
                onClick={() => onSelect(idx)}
                onDoubleClick={() => onPreview?.(idx)}
                aria-pressed={active}
                title={`Switch to image #${idx + 1} (double-click to preview)`}
              >
                <div className="ws-thumb__img">
                  <img src={src} alt="" loading="lazy" />
                </div>
                <div className="ws-thumb__meta">
                  <span className="ws-thumb__name" title={img.filename}>#{idx + 1}</span>
                  {img.isProcessed
                    ? <Badge tone="emerald">Done</Badge>
                    : <Badge tone="slate">Raw</Badge>}
                </div>
              </button>
              {/* Magnifying-glass preview button overlays the top-right
                  of the thumb. Visible on hover; stopPropagation so
                  it doesn't also fire the select handler. */}
              {onPreview ? (
                <button
                  type="button"
                  className="ws-thumb__preview"
                  onClick={(e) => { e.stopPropagation(); onPreview(idx); }}
                  title="Preview full size"
                  aria-label={`Preview image #${idx + 1} full size`}
                >
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </div>
          );
        })}
        {total === 0 ? (
          <div className="ws-strip__empty">No images on this product yet.</div>
        ) : null}
      </div>
      <div className="ws-strip__footer">
        <div className="ws-progress">
          <div className="ws-progress__bar" style={{ width: `${pct}%` }} />
        </div>
        <div className="ws-progress__label">{done} of {total} processed</div>
      </div>
    </aside>
  );
}
