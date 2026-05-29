import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Select } from '../../components/ui.jsx';
import { CompactAttribution } from '../../components/Attribution.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';
import { PROCESS_STATUS_OPTIONS, findOption } from './libraryConstants.js';

// Card-size presets for Grid view. The value is the `min` track size handed
// to the grid via the `--lib-card-min` CSS custom property; with the side
// panel open and a ~1920px window this maps to roughly:
//   Compact     160 → 5–6 cards/row
//   Comfortable 200 → 4–5 cards/row    (default — sane on most screens)
//   Roomy       260 → 3 cards/row
//   Large       340 → 2 cards/row
// The choice is persisted in localStorage so it survives reloads.
export const GRID_SIZE_OPTIONS = [
  { value: 'compact',     label: 'Compact',     px: 160 },
  { value: 'comfortable', label: 'Comfortable', px: 200 },
  { value: 'roomy',       label: 'Roomy',       px: 260 },
  { value: 'large',       label: 'Large',       px: 340 },
];
export const GRID_SIZE_DEFAULT = 'comfortable';
export const GRID_SIZE_STORAGE_KEY = 'ProductLibrary.gridSize';

export function loadGridSize() {
  try {
    const stored = localStorage.getItem(GRID_SIZE_STORAGE_KEY);
    if (stored && GRID_SIZE_OPTIONS.some((o) => o.value === stored)) return stored;
  } catch {}
  return GRID_SIZE_DEFAULT;
}

/**
 * Sort control for the grid view (which has no column headers to click).
 * Mirrors the same sort state used by the table — switching views keeps
 * the sort intact. Direction toggle button works like clicking an already-
 * active column header in the table.
 *
 * Kept in sync with SORT_GETTERS keys so the two views always offer the
 * same sortable columns.
 */
const GRID_SORT_OPTIONS = [
  { key: 'updated',  label: 'Recently updated' },
  { key: 'sku',      label: 'SKU' },
  { key: 'name',     label: 'Name' },
  { key: 'brand',    label: 'Brand' },
  { key: 'category', label: 'Category' },
  { key: 'color',    label: 'Color / Finish' },
  { key: 'images',   label: 'Image count' },
];

export function GridSortControl({ sort, onSort }) {
  const current = sort?.key ?? 'updated';
  const dir = sort?.dir === 'asc' ? 'asc' : 'desc';
  return (
    <div className="ws-toolbar__group lib-sort">
      <span className="lib-sort__label">Sort</span>
      <Select
        value={current}
        onChange={(e) => {
          // Picking a new column always uses the column's natural default
          // direction (handled by setProductSort). Picking the same column
          // again is a no-op here — direction is toggled via the ↑↓ button
          // below.
          if (e.target.value !== current) onSort(e.target.value);
        }}
      >
        {GRID_SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </Select>
      <button
        type="button"
        className="lib-sort__dir"
        onClick={() => onSort(current)}    /* same key → toggles dir in the store */
        title={dir === 'asc' ? 'Ascending — click to flip' : 'Descending — click to flip'}
        aria-label="Toggle sort direction"
      >
        {dir === 'asc' ? '↑' : '↓'}
      </button>
    </div>
  );
}

/**
 * Compact toolbar control for picking the grid card size. Looks/feels like
 * the existing `GridSortControl` next to it; only shown in Grid view.
 */
export function GridSizeControl({ value, onChange }) {
  return (
    <div className="ws-toolbar__group lib-sort">
      <span className="lib-sort__label">Card size</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {GRID_SIZE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>
    </div>
  );
}

export function GridView({
  rows,
  brandsById,
  onOpen,
  onPreview,
  selectedProductId,
  cardMinPx = 220,
  hoverPreview = true,
  // v0.26.48: bulk-select props mirror the table view contract.
  // `selectedIds` is a Set of product ids that are currently checked
  // for bulk operations (Edit selected / Process selected / Delete).
  // Distinct from `selectedProductId` (the singular "side panel is
  // open on this one"). Both can be active at once; visually the
  // multi-select state uses a small corner checkbox + a green ring,
  // while the side-panel-open state uses the existing accent ring.
  selectedIds,
  onToggleSelected,
}) {
  // The grid's column min track is driven by `--lib-card-min`; setting it
  // inline keeps the CSS file dumb and lets the user's selection take
  // effect immediately without a reflow of the stylesheet.
  return (
    <div className="lib-grid" style={{ '--lib-card-min': `${cardMinPx}px` }}>
      {rows.map((p) => (
        <GridCard
          key={p.id}
          product={p}
          brand={p.brandId ? brandsById.get(p.brandId) : null}
          onOpen={onOpen}
          onPreview={onPreview}
          selected={p.id === selectedProductId}
          hoverPreview={hoverPreview}
          bulkSelected={selectedIds?.has(p.id) ?? false}
          onToggleSelected={onToggleSelected}
        />
      ))}
    </div>
  );
}

const CYCLE_INTERVAL_MS = 1200;

const GridCard = memo(function GridCard({
  product: p, brand, onOpen, onPreview, selected, hoverPreview = true,
  // v0.26.48: bulk-select props. `bulkSelected` is whether THIS card
  // is in the multi-select set; `onToggleSelected` is the parent's
  // toggle callback. Both optional — if `onToggleSelected` is
  // undefined the checkbox doesn't render (e.g. if a future caller
  // wants a read-only grid).
  bulkSelected = false, onToggleSelected,
}) {
  const proc = findOption(PROCESS_STATUS_OPTIONS, p.processStatus);
  const hasMulti = (p.imageCount || 0) > 1;

  // Lazy-fetch the full image list only when the user hovers a multi-image
  // card. We cache it inside this card so a re-hover doesn't re-query.
  const [extraPaths, setExtraPaths] = useState(null); // null = not fetched yet
  const [cycleIdx, setCycleIdx] = useState(0);
  const timerRef = useRef(null);
  const fetchingRef = useRef(false);

  // Cleanup on unmount or when this product instance changes.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [p.id]);

  // If the product's main image / count changes (e.g. user reorders, removes,
  // or imports new images), invalidate the cached cycle list so the next
  // hover refetches.
  useEffect(() => {
    setExtraPaths(null);
    setCycleIdx(0);
  }, [p.id, p.mainImagePath, p.imageCount]);

  const startCycling = useCallback((paths) => {
    if (!paths || paths.length <= 1) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCycleIdx((i) => (i + 1) % paths.length);
    }, CYCLE_INTERVAL_MS);
  }, []);

  const handlePointerEnter = useCallback(() => {
    if (!hoverPreview) return; // v0.12.3: respect user preference
    if (!hasMulti) return;
    if (extraPaths && extraPaths.length > 1) {
      // Already cached — just resume cycling from the next image.
      setCycleIdx((i) => (extraPaths.length ? (i + 1) % extraPaths.length : 0));
      startCycling(extraPaths);
      return;
    }
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    window.api.images
      .listByProduct(p.id)
      .then((imgs) => {
        const paths = (imgs || [])
          .map((img) => img.filepath)
          .filter(Boolean);
        if (paths.length === 0) {
          // Fall back to main image only.
          setExtraPaths([]);
          return;
        }
        setExtraPaths(paths);
        if (paths.length > 1) {
          setCycleIdx(1); // Show the second image first as feedback.
          startCycling(paths);
        }
      })
      .catch(() => {
        // Silently fall back; thumb just stays on main image.
        setExtraPaths([]);
      })
      .finally(() => {
        fetchingRef.current = false;
      });
  }, [hoverPreview, hasMulti, extraPaths, p.id, startCycling]);

  const handlePointerLeave = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setCycleIdx(0);
  }, []);

  // Decide which image to render. Prefer the cycle list when we have it;
  // otherwise show the precomputed main image path from the list query.
  let activePath = p.mainImagePath || null;
  if (extraPaths && extraPaths.length > 0) {
    activePath = extraPaths[cycleIdx % extraPaths.length] || activePath;
  }
  // v0.22.8: cache-bust by product.updatedAt so the grid thumbnail
  // refreshes after image deletes/reorders/set-main. The Library
  // bumps `updated_at` on the product whenever its image set changes
  // (see touch in main/ipc/images.js).
  const thumbSrc = activePath ? appImageSrc(activePath, p.updatedAt) : null;

  // v0.26.48: the card became a <div> with role="button" instead of a
  // <button>. Reason: the new bulk-select checkbox is interactive, and
  // nesting interactive elements inside a real <button> is invalid
  // HTML and breaks keyboard semantics. The div+role pattern lets the
  // outer "click anywhere to open" gesture coexist with the checkbox
  // + thumb preview as separately-clickable elements.
  function handleCardClick(e) {
    // Modifier-click toggles multi-select instead of opening. Works
    // even if the checkbox itself is hidden (e.g. compact mode in
    // the future). Cmd on Mac, Ctrl on others.
    if ((e.metaKey || e.ctrlKey) && onToggleSelected) {
      e.preventDefault();
      onToggleSelected(p.id);
      return;
    }
    onOpen(p);
  }
  function handleCardKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(p);
    }
  }
  function handleCheckboxChange(e) {
    e.stopPropagation();
    if (onToggleSelected) onToggleSelected(p.id);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`lib-card${selected ? ' is-selected' : ''}${bulkSelected ? ' is-bulk-selected' : ''}`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      aria-pressed={selected || undefined}
    >
      {onToggleSelected ? (
        <label
          className="lib-card__select"
          // Stop the outer-card click handler firing when the user
          // taps the checkbox area itself. Without this the click
          // both toggles AND opens the side panel.
          onClick={(e) => e.stopPropagation()}
          title={bulkSelected ? 'Deselect for bulk operations' : 'Select for bulk operations (Process, Edit, Delete)'}
        >
          <input
            type="checkbox"
            checked={bulkSelected}
            onChange={handleCheckboxChange}
            aria-label={`Select ${p.sku} for bulk operations`}
          />
        </label>
      ) : null}
      <div
        className={`lib-card__thumb${thumbSrc ? ' lib-card__thumb--clickable' : ''}`}
        onClick={thumbSrc ? (e) => { e.stopPropagation(); e.preventDefault(); onPreview(p); } : undefined}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        title={thumbSrc ? (hasMulti ? `Preview images (${p.imageCount})` : 'Preview images') : undefined}
      >
        {thumbSrc ? (
          <img src={thumbSrc} alt="" loading="lazy" />
        ) : (
          // Visually clear placeholder for products without images. Icon
          // comes from the ::before pseudo-element in CSS; the label gives
          // additional context so the user can tell why the slot is empty.
          <div className="lib-card__thumb-empty" aria-hidden>No image</div>
        )}
        {hasMulti ? (
          <span
            className="lib-card__thumb-multi-badge"
            aria-label={`${p.imageCount} images`}
            title={`${p.imageCount} images — hover to preview`}
          >
            +{Math.max(0, (p.imageCount || 1) - 1)}
          </span>
        ) : null}
        {brand ? (
          <span
            className="lib-card__brand-dot"
            style={{ background: brand.color || '#1c1c1f' }}
            title={brand.name}
          />
        ) : null}
      </div>
      <div className="lib-card__body">
        <div className="lib-card__sku">{p.sku}</div>
        {p.name ? <div className="lib-card__name">{p.name}</div> : null}
        <div className="lib-card__meta">
          {p.colorFinish ? <span className="muted">{p.colorFinish}</span> : null}
          <span className="muted">{p.imageCount}/50</span>
        </div>
        <div className="lib-card__badges">
          {proc ? <Badge tone={proc.tone}>{proc.label}</Badge> : null}
        </div>
        {/* v0.22.5: small attribution line under the badges so the
            grid card shows who edited last + when. Mirrors the new
            table "Edited" column. Stays hidden if there's no updatedAt
            (fresh import with no edit history). */}
        {p.updatedAt ? (
          <div className="lib-card__attribution">
            <CompactAttribution updatedAt={p.updatedAt} updatedByUserId={p.updatedByUserId} />
          </div>
        ) : null}
      </div>
    </div>
  );
});
