import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Pagination, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Lightbox } from '../../components/Lightbox.jsx';
import { ProductForm } from './ProductForm.jsx';
import { AutoMatchModal } from './AutoMatchModal.jsx';
import { DuplicateMergeModal } from './DuplicateMergeModal.jsx';
import { ImportModal } from './ImportModal.jsx';
import { ProcessDestinationModal } from '../../components/ProcessDestinationModal.jsx';
import { BulkEditModal } from './BulkEditModal.jsx';
import { BulkProductsAIRunModal } from './BulkProductsAIRunModal.jsx';
import { BulkOverlayRunModal } from './BulkOverlayRunModal.jsx';
// v0.49.34: the combined "Convert · compress · resize" modal was split into
// three independent modals — one knob per tool. Same backend IPC; the
// renderer just gates which form fields each modal exposes.
import { BulkConvertModal } from './BulkConvertModal.jsx';
import { BulkCompressModal } from './BulkCompressModal.jsx';
import { BulkResizeModal } from './BulkResizeModal.jsx';
import { AutoCropRunModal } from './AutoCropRunModal.jsx';
import { BulkBgRemovalModal } from './BulkBgRemovalModal.jsx';
import { AutoEnhanceRunModal } from './AutoEnhanceRunModal.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { confirmWithBackup } from '../../components/BackupReminder.jsx';
import { TableView } from './LibraryTable.jsx';
import {
  GridView,
  GridSortControl,
  GridSizeControl,
  GRID_SIZE_OPTIONS,
  GRID_SIZE_STORAGE_KEY,
  loadGridSize,
} from './LibraryGrid.jsx';
import {
  ColumnsControl,
  COLUMN_DEFS,
  loadVisibleColumns,
  saveVisibleColumns,
} from './LibraryColumns.jsx';
import { PROCESS_STATUS_OPTIONS, STATUS_OPTIONS } from './libraryConstants.js';

/**
 * v0.26.23: persist the Table/Grid view toggle across navigation.
 * The Library module unmounts when the user navigates to another
 * tab (Settings, AI Studio, etc.) and re-mounts on return, so
 * `useState('table')` was resetting the view to Table every single
 * time. Same pattern as gridSize / hoverPreview / panelVisible
 * already used: load from localStorage on init, save on change.
 * Falls back to 'table' for fresh installs.
 */
const VIEW_STORAGE_KEY = 'ProductLibrary.view';
function loadView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === 'table' || v === 'grid') return v;
  } catch {}
  return 'table';
}
function saveView(v) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch {}
}

/**
 * v0.12.3: the hover-cycle behavior (cycle through every image on a
 * multi-image card when the user hovers it) is now a user preference.
 * Default remains 'on' so the v0.10.6 behavior is preserved for users
 * who like it. The +N badge that shows multi-image count is independent
 * of this setting and always visible.
 *
 * Stored via localStorage and read at mount; flipping it in Settings
 * takes effect the next time the user opens the Library (the module
 * re-mounts on navigation).
 */
const HOVER_PREVIEW_STORAGE_KEY = 'ProductLibrary.hoverPreview';
export function loadHoverPreview() {
  try {
    const v = localStorage.getItem(HOVER_PREVIEW_STORAGE_KEY);
    if (v === 'off') return false;
    if (v === 'on') return true;
  } catch {}
  return true;
}
export function saveHoverPreview(on) {
  try { localStorage.setItem(HOVER_PREVIEW_STORAGE_KEY, on ? 'on' : 'off'); } catch {}
}

/**
 * v0.22.1: side panel visibility preference. v0.10.7 made the
 * Library's right-side detail panel always-mounted so users could
 * keep product details visible while browsing — but there was no
 * way to retract it short of pressing Esc. The "always visible"
 * behavior eats ~480px of horizontal width, which gets cramped on
 * smaller MacBook displays.
 *
 * Now this is a user preference toggleable from the Library
 * toolbar. Persists in localStorage so the choice survives
 * relaunches. On fresh installs, defaults to OFF when the
 * viewport is narrower than 1400px (small displays); ON
 * otherwise (preserves the v0.10.7 behavior on big screens).
 */
const PANEL_VISIBLE_STORAGE_KEY = 'ProductLibrary.panelVisible';
function loadPanelVisible() {
  try {
    const v = localStorage.getItem(PANEL_VISIBLE_STORAGE_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch {}
  // First-load default depends on viewport. Below ~1400px the
  // panel + filter sidebar + table is too tight to be useful.
  try {
    return window.innerWidth >= 1400;
  } catch { return true; }
}
function savePanelVisible(on) {
  try { localStorage.setItem(PANEL_VISIBLE_STORAGE_KEY, on ? 'on' : 'off'); } catch {}
}

/**
 * Client-side sort for the Library. The DB already returns rows in
 * `updated_at DESC` order; switching to any other column re-sorts in-memory
 * so we don't need a separate IPC roundtrip for every header click.
 *
 * `brandsById` / `categoriesById` let us sort by the *resolved name* of the
 * lookup (so "MACEPRO" sorts under M, not by the brand's UUID). We use
 * `localeCompare` with `numeric: true` so SKUs like "AV-M8101", "AV-M81",
 * "AV-M8200" sort the way a human reads them rather than lexicographically.
 */
const SORT_GETTERS = {
  sku:      (p) => p.sku ?? '',
  name:     (p) => p.name ?? '',
  brand:    (p, ix) => ix.brand.get(p.brandId)?.name ?? '',
  category: (p, ix) => ix.category.get(p.categoryId)?.name ?? '',
  color:    (p) => p.colorFinish ?? '',
  images:   (p) => p.imageCount ?? 0,
  updated:  (p) => p.updatedAt ?? 0,
};

function sortProducts(rows, sort, brandsById, categoriesById) {
  const getter = SORT_GETTERS[sort.key];
  if (!getter) return rows;
  const ix = { brand: brandsById, category: categoriesById };
  const dir = sort.dir === 'desc' ? -1 : 1;
  // Slice first because Array#sort mutates in place — and our caller passes
  // the store's products array which must stay immutable for React.
  return rows.slice().sort((a, b) => {
    const av = getter(a, ix);
    const bv = getter(b, ix);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

export function ProductLibrary() {
  const products = useAppStore((s) => s.products);
  const loading = useAppStore((s) => s.productsLoading);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const filters = useAppStore((s) => s.productFilters);
  const sort = useAppStore((s) => s.productSort);
  const page = useAppStore((s) => s.page);
  const pageSize = useAppStore((s) => s.pageSize);
  const setProductSearch = useAppStore((s) => s.setProductSearch);
  const toggleBrandFilter = useAppStore((s) => s.toggleBrandFilter);
  const clearBrandFilter = useAppStore((s) => s.clearBrandFilter);
  const toggleCategoryFilter = useAppStore((s) => s.toggleCategoryFilter);
  const clearCategoryFilter = useAppStore((s) => s.clearCategoryFilter);
  const setStatusFilter = useAppStore((s) => s.setStatusFilter);
  const setProcessStatusFilter = useAppStore((s) => s.setProcessStatusFilter);
  const setHasImagesFilter = useAppStore((s) => s.setHasImagesFilter);
  const setProductSort = useAppStore((s) => s.setProductSort);
  const resetFilters = useAppStore((s) => s.resetFilters);
  const setPage = useAppStore((s) => s.setPage);
  const setPageSize = useAppStore((s) => s.setPageSize);
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  // v0.11.2: "Process →" in the Library opens a small router modal asking
  // whether to take the product to Image Workspace or AI Studio. The
  // store actions below cover both paths; the modal calls one of them.
  const setAiSourceProduct = useAppStore((s) => s.setAiSourceProduct);

  const [editing, setEditing] = useState(null); // product or 'new' or null
  // v0.26.23: seed from localStorage so the user's choice survives
  // module unmount/remount on tab switches. Wrap setView so the
  // value is written back on every change — single source of truth.
  const [view, setViewRaw] = useState(loadView);
  const setView = (v) => { setViewRaw(v); saveView(v); };
  const [gridSize, setGridSize] = useState(loadGridSize); // 'compact' | 'comfortable' | 'roomy' | 'large'
  // v0.22.1: side-panel visibility toggle. When OFF the right
  // column is removed from the layout grid, freeing ~480px of
  // horizontal width — crucial on smaller MacBook displays.
  const [panelVisible, setPanelVisible] = useState(loadPanelVisible);
  function togglePanel() {
    setPanelVisible((prev) => {
      const next = !prev;
      savePanelVisible(next);
      // Keep the editing state untouched on toggle: hiding +
      // re-showing the panel keeps the user on the same product
      // instead of forcing them to re-click.
      return next;
    });
  }
  // v0.12.3: respect the user's hover-preview preference. Read once on
  // mount — if the user flips it in Settings, navigating back here
  // re-mounts the module and picks up the new value.
  const [hoverPreview] = useState(loadHoverPreview);
  const [autoMatchOpen, setAutoMatchOpen] = useState(false);
  const [dedupOpen, setDedupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [lightbox, setLightbox] = useState(null); // { product, images, startIndex } | null
  // The product the user just clicked "Process →" for. The destination
  // router modal owns the actual route choice (Workspace or AI Studio).
  const [processingProduct, setProcessingProduct] = useState(null);
  // v0.18.1: multi-select for bulk edit. Stored as a Set of product
  // ids; the toolbar appears as soon as the set is non-empty.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  // v0.22.0: bulk AI run modal + bulk delete confirm state.
  const [bulkAiOpen, setBulkAiOpen] = useState(false);
  // v0.26.15: Overlay Studio bulk-apply modal. Same toolbar
  // position as the AI bulk modal so the two batch surfaces are
  // discoverable side-by-side.
  const [bulkOverlayOpen, setBulkOverlayOpen] = useState(false);
  // v0.49.34: three independent bulk modals replace the combined
  // "Convert · compress · resize" — same backend, focused UIs.
  const [bulkConvertOpen, setBulkConvertOpen] = useState(false);
  const [bulkCompressOpen, setBulkCompressOpen] = useState(false);
  const [bulkResizeOpen, setBulkResizeOpen] = useState(false);
  // v0.37.0: batch auto-crop-to-product modal (trim + uniform reframe).
  const [autoCropOpen, setAutoCropOpen] = useState(false);
  // v0.38.0: bulk background-removal modal (clean white bg on main image).
  const [bulkBgOpen, setBulkBgOpen] = useState(false);
  // v0.40.0: bulk auto-enhance modal (white-balance + levels + saturation).
  const [autoEnhanceOpen, setAutoEnhanceOpen] = useState(false);
  // v0.26.16: when the user picks "Overlay Studio" from the Process
  // router (single-product Process button on a row / side panel),
  // we stash the single product id so the BulkOverlayRunModal
  // opens with productIds=[id] instead of the multi-select array.
  // Cleared when the modal closes.
  const [overlayApplyProductId, setOverlayApplyProductId] = useState(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // v0.22.7: which table columns the user wants visible. Persisted to
  // localStorage. Read by TableView when rendering the header + each
  // row; the data the columns *display* still comes from the products
  // slice, this only controls which cells render.
  const [visibleCols, setVisibleCols] = useState(loadVisibleColumns);
  function toggleColumn(key) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveVisibleColumns(next);
      return next;
    });
  }
  function resetColumns() {
    const next = new Set(COLUMN_DEFS.filter((c) => c.defaultVisible).map((c) => c.key));
    saveVisibleColumns(next);
    setVisibleCols(next);
  }

  // v0.49.48: landed-cost map for the Cost column. Keyed by productId →
  // { latestLandedCostUsd, latestPoId, ... }. Fetched in one bulk call,
  // only when the Cost column is actually visible (skip the query
  // otherwise). Re-fetched when the product set changes, since a PO
  // received elsewhere updates these numbers.
  const [productCosts, setProductCosts] = useState(() => new Map());
  const costColumnVisible = visibleCols.has('cost');

  /**
   * v0.22.0: bulk delete with a clear danger confirm. Same
   * cascade behavior as single-row delete — DB rows go via the
   * normal ON DELETE CASCADE chain, on-disk asset folders are
   * rm-rf'd, and ai-gallery files are unlinked. No undo.
   */
  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const ok = await confirmWithBackup({
      title: `Delete ${ids.length} product${ids.length === 1 ? '' : 's'}?`,
      message: 'All images, AI generations, and metadata for these products will be removed from disk.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: `Delete ${ids.length}`,
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      const res = await window.api.products.bulkRemove(ids);
      const failedCount = res?.failed?.length ?? 0;
      if (failedCount === 0) {
        useAppStore.getState().addToast(`Deleted ${res.deleted} product${res.deleted === 1 ? '' : 's'}.`, 'success');
      } else {
        useAppStore.getState().addToast(
          `Deleted ${res.deleted} of ${ids.length} — ${failedCount} failed.`,
          'info',
        );
      }
      clearSelection();
      useAppStore.getState().refreshProducts();
      useAppStore.getState().refreshAllProducts?.();
      useAppStore.getState().refreshDashboard?.();
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    } finally {
      setBulkDeleting(false);
    }
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function setManySelected(ids, on) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }

  // Persist the grid-size choice so it survives reloads. localStorage write
  // is cheap (synchronous string set) — fine inside an effect.
  useEffect(() => {
    try { localStorage.setItem(GRID_SIZE_STORAGE_KEY, gridSize); } catch {}
  }, [gridSize]);

  const gridCardMinPx = useMemo(
    () => (GRID_SIZE_OPTIONS.find((o) => o.value === gridSize) ?? GRID_SIZE_OPTIONS[1]).px,
    [gridSize],
  );
  // The detail panel is ALWAYS mounted now (per the user's request to keep
  // product details persistently visible). These derived flags tell the
  // panel which mode to render: empty placeholder, new-product form, or
  // edit-existing-product form.
  const isCreatingProduct = editing === 'new';
  const editingProduct = isCreatingProduct ? null : editing;
  const selectedProductId = editingProduct?.id ?? null;

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="Product Library" />
        <EmptyState
          title="No company selected"
          body="Create or select a company before adding products."
          action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Company</Button>}
        />
      </div>
    );
  }

  const brandsById = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);
  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  // v0.49.48: pull the bulk landed-cost map for the Cost column. Gated on
  // the column being visible + a company being active. `products.length`
  // in the deps means it refreshes after imports / deletes; a PO received
  // on another Mac won't auto-push here, but switching modules or toggling
  // the column re-fetches, which is enough for a cost-reference column.
  useEffect(() => {
    if (!activeCompanyId || !costColumnVisible) return;
    let cancelled = false;
    window.api.purchaseOrders.listProductCosts(activeCompanyId)
      .then((list) => {
        if (cancelled) return;
        const map = new Map();
        for (const c of (Array.isArray(list) ? list : [])) map.set(c.productId, c);
        setProductCosts(map);
      })
      .catch(() => { if (!cancelled) setProductCosts(new Map()); });
    return () => { cancelled = true; };
  }, [activeCompanyId, costColumnVisible, products.length]);

  const openPurchaseOrder = useAppStore((s) => s.openPurchaseOrder);

  // Client-side hasImages filter + sort applied to the SQL result. This way
  // the SQL stays simple and toggling a sort header doesn't roundtrip to
  // SQLite. The sort is stable (preserves DB order within equal keys).
  //
  // `Number(p.imageCount)` coerces BigInt / string-shaped counts safely.
  // better-sqlite3 normally returns integers as Number, but rows that
  // round-tripped through some JSON paths can come back as strings — and
  // strict equality `"0" === 0` is false, which is what was breaking the
  // "No images" filter for users with certain DB states.
  const filteredAndSorted = useMemo(() => {
    let arr = products;
    if (filters.hasImages === 'with')    arr = arr.filter((p) => Number(p.imageCount ?? 0) > 0);
    if (filters.hasImages === 'without') arr = arr.filter((p) => Number(p.imageCount ?? 0) === 0);
    return sortProducts(arr, sort, brandsById, categoriesById);
  }, [products, filters.hasImages, sort, brandsById, categoriesById]);

  const total = filteredAndSorted.length;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const currentPage = Math.min(page, maxPage);
  const pageStart = currentPage * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, total);
  const visible = filteredAndSorted.slice(pageStart, pageEnd);

  const brandFilterEmpty = !filters.brandIds || filters.brandIds.length === 0;
  const categoryFilterEmpty = !filters.categoryIds || filters.categoryIds.length === 0;
  const hasActiveFilters =
    filters.search !== '' ||
    !brandFilterEmpty ||
    !categoryFilterEmpty ||
    filters.status !== null ||
    filters.processStatus !== null ||
    filters.hasImages !== null;

  async function handleDownloadSample() {
    try {
      const saved = await window.api.samples.generateProductSheet();
      if (saved) useAppStore.getState().addToast(`Saved to ${saved}`, 'success');
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    }
  }

  // v0.36.0: export the whole catalog as a CSV/feed (generic / Shopify /
  // Google Shopping). The IPC returns the CSV text; we trigger a download
  // client-side (works on desktop AND the iPad web viewer). Prepend a UTF-8
  // BOM so Excel opens Khmer/Unicode names correctly.
  async function handleExportCsv(format) {
    if (!format) return;
    try {
      const res = await window.api.exports.catalogCsv(activeCompanyId, format);
      if (!res || !res.csv) { useAppStore.getState().addToast('Nothing to export', 'info'); return; }
      const blob = new Blob(['﻿' + res.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.filename || 'catalog.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      useAppStore.getState().addToast(`Exported ${res.count} product${res.count === 1 ? '' : 's'} (${format})`, 'success');
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    }
  }

  // Stable row handlers so memoized rows don't re-render on every parent
  // state change (filter typing, page change, etc.). Without useCallback the
  // arrow functions get a fresh identity each render, defeating React.memo.
  const handleOpen = useCallback((p) => setEditing(p), []);
  // "Process →" now opens a small destination picker — Image Workspace or
  // AI Studio. The actual store call happens inside the modal callbacks
  // below. Kept the function name + signature so existing call sites
  // (table row, side panel footer) don't need to change.
  const handleProcess = useCallback((p) => setProcessingProduct(p), []);

  const goToWorkspace = useCallback(() => {
    if (!processingProduct) return;
    openProductInWorkspace(processingProduct.id);
    setProcessingProduct(null);
  }, [processingProduct, openProductInWorkspace]);

  const goToAiStudio = useCallback(() => {
    if (!processingProduct) return;
    setAiSourceProduct(processingProduct.id);
    // Note: the module key is `aistudio` (no hyphen, no space) — same as
    // in store/index.js MODULES allowlist. v0.11.2 shipped with the wrong
    // 'ai' name which silently no-op'd (the allowlist guard logged a
    // console.warn but nothing visible happened in the UI).
    setActiveModule('aistudio');
    setProcessingProduct(null);
  }, [processingProduct, setAiSourceProduct, setActiveModule]);

  // v0.26.16: third option from the Process router — open the
  // Overlay Studio apply modal pre-targeted at this product. Reuses
  // the same BulkOverlayRunModal as the bulk-toolbar path, with a
  // single-product productIds array so the scope toggle naturally
  // shows "Selected (1)". The user can flip to "Current Library
  // filter" inside the modal if they change their mind.
  const goToOverlay = useCallback(() => {
    if (!processingProduct) return;
    // Stash the single product id so the modal mounts with it.
    setOverlayApplyProductId(processingProduct.id);
    setProcessingProduct(null);
    setBulkOverlayOpen(true);
  }, [processingProduct]);

  // Thumbnail click → open the lightbox with all the product's images.
  // We hit IPC at click time (rather than preloading every product's image
  // list) so a 500-product library doesn't carry image arrays in memory.
  const handlePreview = useCallback(async (p, startIndex = 0) => {
    try {
      const images = await window.api.images.listByProduct(p.id);
      if (!images || images.length === 0) {
        useAppStore.getState().addToast('No images on this product yet', 'info');
        return;
      }
      setLightbox({
        product: p,
        images,
        startIndex,
      });
    } catch (err) {
      useAppStore.getState().addToast(err.message, 'error');
    }
  }, []);

  return (
    <div className="page page--library">
      <PageHeader
        title="Product Library"
        subtitle={loading
          ? 'Loading…'
          : `${total} product${total === 1 ? '' : 's'}${hasActiveFilters ? ' (filtered)' : ''}`}
        actions={
          <>
            <div className="search-wrap">
              <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
                <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                className="search-input"
                /* v0.49.37: dropped the misleading "tags" hint — tags
                   haven't been part of the Library search since v0.26.49
                   when the scope narrowed to (sku, name, color_finish).
                   Now the placeholder matches what actually gets searched. */
                placeholder="Search SKU, name, color…"
                value={filters.search}
                onChange={(e) => setProductSearch(e.target.value)}
              />
            </div>
            <div className="ws-toolbar__group">
              <button
                type="button"
                className={`segment${view === 'table' ? ' is-active' : ''}`}
                onClick={() => setView('table')}
                title="Table view"
              >Table</button>
              <button
                type="button"
                className={`segment${view === 'grid' ? ' is-active' : ''}`}
                onClick={() => setView('grid')}
                title="Grid view"
              >Grid</button>
            </div>
            {/* v0.22.1: side-panel show/hide. Persists in
                localStorage. Defaults OFF on narrow first-load
                viewports (<1400px) so small MacBook screens
                don't feel squashed. */}
            <button
              type="button"
              className={`segment lib-panel-toggle${panelVisible ? ' is-active' : ''}`}
              onClick={togglePanel}
              title={panelVisible
                ? 'Hide product side panel'
                : 'Show product side panel when you click a row'}
              aria-pressed={panelVisible}
            >
              {panelVisible ? '◧ Panel on' : '◧ Panel off'}
            </button>
            {view === 'grid' ? (
              <>
                <GridSortControl sort={sort} onSort={setProductSort} />
                <GridSizeControl value={gridSize} onChange={setGridSize} />
              </>
            ) : (
              // v0.22.7: column picker — only meaningful for the
              // table view (grid card content is curated). Lives in
              // a small popover; closes on outside click + Esc.
              <ColumnsControl
                visibleCols={visibleCols}
                onToggle={toggleColumn}
                onReset={resetColumns}
              />
            )}
            {/* v0.26.21: manual refresh affordance. Catalog events
                already auto-refresh from server-driven changes, but a
                manual button is good for two reasons: (1) a peace-of-
                mind "give me the latest" button users expect, (2) a
                cheap escape hatch if any auto-refresh path ever
                misses an edge case (like the AI-promote updated_at
                bug fixed in this same release). Refreshes the same
                slices the catalog dispatcher does. */}
            <RefreshButton />
            <Button onClick={() => setAutoMatchOpen(true)}>Auto-match images…</Button>
            <Button onClick={() => setDedupOpen(true)}>Merge duplicates…</Button>
            <Button onClick={handleDownloadSample}>Download sample</Button>
            <Button onClick={() => setImportOpen(true)}>Import Excel/CSV</Button>
            {/* v0.36.0: catalog CSV / marketplace feed export. Pick a format;
                snaps back to the placeholder so the same one can re-fire.
                Labels kept SHORT so the closed select doesn't dominate the
                toolbar — hover/title carries the full explanation. */}
            <Select
              value=""
              className="lib-csv-select"
              aria-label="Export catalog CSV"
              title="Export the whole catalog as a CSV / marketplace feed (Catalog · Shopify · Google Shopping)"
              onChange={(e) => { const f = e.target.value; e.target.value = ''; handleExportCsv(f); }}
            >
              <option value="">CSV…</option>
              <option value="generic">Catalog</option>
              <option value="shopify">Shopify</option>
              <option value="google">Google</option>
            </Select>
            <Button variant="primary" onClick={() => setEditing('new')}>+ New product</Button>
          </>
        }
      />

      <div className={`lib-layout${panelVisible ? ' lib-layout--has-panel' : ''}`}>
        <aside className="lib-filters" aria-label="Filters">
          <FilterGroup label="Brand" canClear={!brandFilterEmpty} onClear={clearBrandFilter}>
            {brands.map((b) => (
              <FilterPill
                key={b.id}
                active={(filters.brandIds ?? []).includes(b.id)}
                onClick={() => toggleBrandFilter(b.id)}
              >{b.name}</FilterPill>
            ))}
            <FilterPill
              active={(filters.brandIds ?? []).includes(null)}
              onClick={() => toggleBrandFilter(null)}
            >Unassigned</FilterPill>
          </FilterGroup>

          <FilterGroup label="Category" canClear={!categoryFilterEmpty} onClear={clearCategoryFilter}>
            {categories.map((c) => (
              <FilterPill
                key={c.id}
                active={(filters.categoryIds ?? []).includes(c.id)}
                onClick={() => toggleCategoryFilter(c.id)}
              >{c.name}</FilterPill>
            ))}
            <FilterPill
              active={(filters.categoryIds ?? []).includes(null)}
              onClick={() => toggleCategoryFilter(null)}
            >Uncategorized</FilterPill>
          </FilterGroup>

          <FilterGroup label="Status">
            <FilterPill active={filters.status === null} onClick={() => setStatusFilter(null)}>Any</FilterPill>
            {STATUS_OPTIONS.map((o) => (
              <FilterPill
                key={o.value}
                active={filters.status === o.value}
                onClick={() => setStatusFilter(o.value)}
              >{o.label}</FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Process status">
            <FilterPill active={filters.processStatus === null} onClick={() => setProcessStatusFilter(null)}>Any</FilterPill>
            {PROCESS_STATUS_OPTIONS.map((o) => (
              <FilterPill
                key={o.value}
                active={filters.processStatus === o.value}
                onClick={() => setProcessStatusFilter(o.value)}
              >{o.label}</FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Images">
            <FilterPill active={filters.hasImages === null} onClick={() => setHasImagesFilter(null)}>Any</FilterPill>
            <FilterPill active={filters.hasImages === 'with'} onClick={() => setHasImagesFilter('with')}>With images</FilterPill>
            <FilterPill active={filters.hasImages === 'without'} onClick={() => setHasImagesFilter('without')}>No images</FilterPill>
          </FilterGroup>

          {hasActiveFilters ? (
            <button type="button" className="lib-filters__reset" onClick={resetFilters}>
              Reset all filters
            </button>
          ) : null}
        </aside>

        <section className="lib-main">
          {/* v0.17.0: distinguish "loading first batch" from "empty
             catalog". Without this, the EmptyState briefly flashes
             on every Library mount before products arrive — most
             noticeable on client mode where the first refresh
             round-trips the network. */}
          {loading && total === 0 ? (
            <div className="lib-loading">
              <div className="lib-loading__spinner" aria-hidden="true" />
              <div className="lib-loading__label">Loading products…</div>
            </div>
          ) : total === 0 ? (
            <EmptyState
              title={hasActiveFilters ? 'No products match these filters' : 'No products yet'}
              body={hasActiveFilters
                ? 'Try resetting filters or adjusting the search.'
                : 'Create your first product to get started.'}
              action={
                hasActiveFilters ? (
                  <Button onClick={resetFilters}>Reset filters</Button>
                ) : (
                  <Button variant="primary" onClick={() => setEditing('new')}>+ New product</Button>
                )
              }
            />
          ) : (
            <>
              {selectedIds.size > 0 ? (
                <div className="lib-bulk-toolbar">
                  <span className="lib-bulk-toolbar__count">
                    {selectedIds.size} selected
                  </span>
                  <div className="lib-bulk-toolbar__spacer" />
                  {/* v0.49.30: toolbar shape:
                       AI Studio  →  Image operations ▾  |  Edit fields  |  Delete N  |  Clear
                      AI Studio stays its own top-level button — it has cost
                      + provider-queue implications that don\'t belong in
                      the same menu as free local sharp passes.
                      Image operations groups the six free local image-
                      changing bulk modals (bg removal, auto-crop / reframe,
                      auto-enhance, re-encode, apply overlay), split inside
                      the menu by destructive vs non-destructive so the user
                      sees which actions overwrite originals before clicking.
                      Edit fields is metadata-only — stays its own button.
                      Delete + Clear stay inline (destructive affordance / escape). */}
                  <Button onClick={() => setBulkAiOpen(true)} disabled={bulkDeleting} title="Queues a paid AI generation for each — kie.ai / fal.ai. Confirms cost before running.">
                    AI Studio ({selectedIds.size}) →
                  </Button>
                  <BulkActionsMenu
                    label={`Image operations (${selectedIds.size}) ▾`}
                    disabled={bulkDeleting}
                    sections={[
                      {
                        label: 'Non-destructive · original kept',
                        items: [
                          { label: 'Remove background',  hint: 'Cutout via @imgly. Adds the result as a new image and promotes it to main; original demotes to #2.', onClick: () => setBulkBgOpen(true) },
                          { label: 'Apply overlay',      hint: 'Composite an Overlay template onto the main image. Defaults to Append (new image); Replace main is opt-in.', onClick: () => setBulkOverlayOpen(true) },
                        ],
                      },
                      {
                        label: 'Destructive · overwrites originals',
                        items: [
                          {
                            // v0.49.45 — renamed from "Auto-crop / reframe"
                            // because the side-panel per-image Reframe button
                            // is the actual reframe tool (better controls).
                            // This bulk action is the trim-edges-and-resize
                            // automation; reframe is what the user does
                            // manually per image. Clearer names: bulk = "Auto
                            // crop", side panel = "Reframe".
                            label: 'Auto crop',
                            hint: 'Trim background edges and recompose to a uniform fill. For precise per-image reframe, open the side panel.',
                            onClick: () => setAutoCropOpen(true),
                          },
                          { label: 'Enhance',             hint: 'White-balance + auto-levels + saturation. Rewrites the source file in place.', onClick: () => setAutoEnhanceOpen(true) },
                          // v0.49.34: three focused tools instead of one combined modal.
                          { label: 'Convert format',      hint: 'Re-encode each image as JPEG, PNG, or WebP. Renames the file on disk when the extension changes.', onClick: () => setBulkConvertOpen(true) },
                          { label: 'Compress',            hint: 'Re-encode at a chosen quality, keep the existing format. Shrinks file size without renaming.', onClick: () => setBulkCompressOpen(true) },
                          { label: 'Resize',              hint: 'Change pixel dimensions — cap the long edge, or set exact W × H with a fit mode and (for Contain) a background colour.', onClick: () => setBulkResizeOpen(true) },
                        ],
                      },
                    ]}
                  />
                  <Button onClick={() => setBulkEditOpen(true)} disabled={bulkDeleting} title="Bulk-update metadata fields (brand, category, status, etc.) — doesn’t touch the image bytes.">
                    Edit fields ({selectedIds.size})
                  </Button>
                  <Button variant="danger" onClick={handleBulkDelete} disabled={bulkDeleting}>
                    {bulkDeleting ? 'Deleting…' : `Delete ${selectedIds.size}`}
                  </Button>
                  <Button onClick={clearSelection} disabled={bulkDeleting}>Clear</Button>
                </div>
              ) : null}
              {view === 'table' ? (
                <TableView
                  rows={visible}
                  brandsById={brandsById}
                  categoriesById={categoriesById}
                  onOpen={handleOpen}
                  onProcess={handleProcess}
                  onPreview={handlePreview}
                  sort={sort}
                  onSort={setProductSort}
                  selectedProductId={selectedProductId}
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                  onToggleAllVisible={(on) => setManySelected(visible.map((p) => p.id), on)}
                  visibleCols={visibleCols}
                  productCosts={productCosts}
                  onOpenCost={(poId) => { if (poId) openPurchaseOrder(poId); }}
                />
              ) : (
                <GridView
                  rows={visible}
                  brandsById={brandsById}
                  onOpen={handleOpen}
                  onPreview={handlePreview}
                  selectedProductId={selectedProductId}
                  cardMinPx={gridCardMinPx}
                  hoverPreview={hoverPreview}
                  // v0.26.48: bulk-select wired into grid cards. Same
                  // selectedIds Set the table view uses, same toggle
                  // callback. The bulk toolbar at the top of the page
                  // (Edit selected / AI / Overlay / Delete) reacts to
                  // selection from either view interchangeably.
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                />
              )}

              <Pagination
                total={total}
                pageStart={pageStart}
                pageEnd={pageEnd}
                currentPage={currentPage}
                maxPage={maxPage}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </>
          )}
        </section>

        {panelVisible ? (
          <ProductForm
            product={editingProduct}
            isCreating={isCreatingProduct}
            onClose={() => setEditing(null)}
            onStartCreate={() => setEditing('new')}
            onProcess={handleProcess}
            // v0.26.13: side-panel thumbs now open the same Lightbox
            // the row/grid thumbs do. ProductForm only knows the
            // index — Library owns the Lightbox state and fetches the
            // image list via handlePreview's existing IPC path.
            onPreview={editingProduct && editingProduct !== 'new'
              ? (startIndex) => handlePreview(editingProduct, startIndex)
              : null}
          />
        ) : null}
      </div>

      <AutoMatchModal open={autoMatchOpen} onClose={() => setAutoMatchOpen(false)} />
      <DuplicateMergeModal open={dedupOpen} onClose={() => setDedupOpen(false)} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />

      <BulkEditModal
        open={bulkEditOpen}
        count={selectedIds.size}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkEditOpen(false)}
        onDone={() => { setBulkEditOpen(false); clearSelection(); }}
      />

      <BulkProductsAIRunModal
        open={bulkAiOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkAiOpen(false)}
        onDone={() => { setBulkAiOpen(false); /* keep selection so user can re-queue if needed */ }}
      />

      <BulkOverlayRunModal
        open={bulkOverlayOpen}
        // v0.26.16: when the Process router routed a single product
        // here, that id wins over the multi-select. Otherwise we use
        // the toolbar's selected ids as before.
        productIds={overlayApplyProductId ? [overlayApplyProductId] : Array.from(selectedIds)}
        filters={filters}
        onClose={() => { setBulkOverlayOpen(false); setOverlayApplyProductId(null); }}
        onDone={() => { setBulkOverlayOpen(false); setOverlayApplyProductId(null); }}
      />

      <AutoCropRunModal
        open={autoCropOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setAutoCropOpen(false)}
        onDone={() => setAutoCropOpen(false)}
      />

      <BulkBgRemovalModal
        open={bulkBgOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkBgOpen(false)}
        onDone={() => setBulkBgOpen(false)}
      />

      <AutoEnhanceRunModal
        open={autoEnhanceOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setAutoEnhanceOpen(false)}
        onDone={() => setAutoEnhanceOpen(false)}
      />

      {/* v0.49.34: three independent modals replace the combined
          BulkReencodeModal. All three call images:reencodeProducts; the
          renderer side just constrains which knobs each surfaces. */}
      <BulkConvertModal
        open={bulkConvertOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkConvertOpen(false)}
        onDone={() => setBulkConvertOpen(false)}
      />
      <BulkCompressModal
        open={bulkCompressOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkCompressOpen(false)}
        onDone={() => setBulkCompressOpen(false)}
      />
      <BulkResizeModal
        open={bulkResizeOpen}
        productIds={Array.from(selectedIds)}
        onClose={() => setBulkResizeOpen(false)}
        onDone={() => setBulkResizeOpen(false)}
      />

      <ProcessDestinationModal
        open={processingProduct !== null}
        product={processingProduct}
        onClose={() => setProcessingProduct(null)}
        onPickWorkspace={goToWorkspace}
        onPickAiStudio={goToAiStudio}
        onPickOverlay={goToOverlay}
      />

      <Lightbox
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
        images={lightbox?.images ?? []}
        startIndex={lightbox?.startIndex ?? 0}
        title={lightbox ? (lightbox.product.name
          ? `${lightbox.product.sku} · ${lightbox.product.name}`
          : lightbox.product.sku) : null}
        // v0.26.14: pass productId so the Lightbox can offer the
        // Flip H / Flip V buttons (destructive — rewrites the source
        // file). When the user flips, we splice the updated image row
        // back into the open lightbox's `images` array so the rest
        // of the strip stays consistent without a re-fetch.
        productId={lightbox?.product?.id ?? null}
        onImageMutated={(updated) => {
          setLightbox((prev) => {
            if (!prev || !updated?.filepath) return prev;
            const next = prev.images.map((img) =>
              img.filepath === updated.filepath ? { ...img, ...updated } : img,
            );
            return { ...prev, images: next };
          });
        }}
      />
    </div>
  );
}

function FilterGroup({ label, canClear, onClear, children }) {
  return (
    <div className="filter-group">
      <div className="filter-group__head">
        <span className="filter-group__label">{label}</span>
        {canClear ? (
          <button type="button" className="filter-group__clear" onClick={onClear}>Clear</button>
        ) : null}
      </div>
      <div className="filter-group__items">{children}</div>
    </div>
  );
}

function FilterPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={`filter-pill${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}


/**
 * v0.26.21: manual Refresh button for the Library header. The store
 * already auto-refreshes via the catalog-event bus, but a manual
 * button is two things at once: (1) the muscle-memory "give me the
 * latest" affordance users expect from any data-driven page, (2) a
 * cheap escape hatch when an auto-refresh path silently misses a
 * change (like the AI promote `updated_at` bug fixed alongside this
 * button — that bug existed because we forgot one `touchUpdated`
 * call; future similar misses are recoverable in one click).
 *
 * Refreshes the same slices the catalog dispatcher does for
 * `kind: 'images'` + `kind: 'product'`: products, allProducts,
 * brands, categories, dashboard. The spin animation runs for a
 * minimum of 600ms even if the IPC returns faster — gives the user
 * positive feedback that the click did something rather than
 * flashing on-and-off in < 50ms on a local DB hit.
 */
function RefreshButton() {
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshAllProducts = useAppStore((s) => s.refreshAllProducts);
  const refreshBrands = useAppStore((s) => s.refreshBrands);
  const refreshCategories = useAppStore((s) => s.refreshCategories);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    const startedAt = Date.now();
    try {
      await Promise.all([
        refreshProducts?.(),
        refreshAllProducts?.(),
        refreshBrands?.(),
        refreshCategories?.(),
        refreshDashboard?.(),
      ]);
    } finally {
      // Minimum visible spin so the user sees feedback.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 600) await new Promise((r) => setTimeout(r, 600 - elapsed));
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className={`lib-refresh-btn${busy ? ' is-spinning' : ''}`}
      onClick={onClick}
      disabled={busy}
      title="Refresh"
      aria-label="Refresh Library"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {/* circular arrow — refresh icon, stroke-based per CLAUDE.md §16 */}
        <path
          d="M14 8a6 6 0 1 1-1.76-4.24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M14 2.5v3h-3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </button>
  );
}

/**
 * v0.49.29: dropdown menu for the Library bulk toolbar.
 *
 * `sections` is an array of `{label, items: [{label, hint, onClick}]}` so the
 * caller decides the grouping (Generate, Edit, future Manage / Export …).
 * New bulk actions slot into a category instead of pushing the toolbar wider.
 *
 * Behaviour:
 *   - Esc or click-outside closes the menu.
 *   - Each item runs its onClick AND closes the menu.
 *   - The button is disabled when nothing is selected or a bulk op is running.
 *
 * Built inline (not a generic Popover primitive) because this is the only
 * caller and the styling is purpose-specific. If we ever need a second
 * popover in the app, extract then.
 */
function BulkActionsMenu({ label, count, disabled, sections }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocDown(e) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // v0.49.30: caller can pass a custom `label` (e.g. "Image operations (N) ▾").
  // Falls back to the v0.49.29 generic label when not given.
  const triggerLabel = label || `Bulk actions${count != null ? ` (${count})` : ''} ▾`;

  return (
    <div className="lib-bulk-menu" ref={containerRef}>
      <Button
        variant="primary"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {triggerLabel}
      </Button>
      {open ? (
        <div className="lib-bulk-menu__panel" role="menu">
          {sections.map((sec, sx) => (
            <div key={sec.label} className="lib-bulk-menu__section">
              {sx > 0 ? <div className="lib-bulk-menu__divider" /> : null}
              <div className="lib-bulk-menu__heading">{sec.label}</div>
              {sec.items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  className="lib-bulk-menu__item"
                  onClick={() => { setOpen(false); it.onClick(); }}
                  role="menuitem"
                >
                  <div className="lib-bulk-menu__item-label">{it.label}</div>
                  {it.hint ? <div className="lib-bulk-menu__item-hint">{it.hint}</div> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

