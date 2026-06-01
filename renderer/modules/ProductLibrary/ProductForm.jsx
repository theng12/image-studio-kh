import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Field, Input, Select, Textarea } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { Attribution } from '../../components/Attribution.jsx';
import { HistoryModal } from '../../components/HistoryModal.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { parseConflictError, showConflict } from '../../components/ConflictModal.jsx';
import { ReframeModal } from './ReframeModal.jsx';

// v0.27.0: raised 20 → 50 (matches imageManager.MAX_IMAGES_PER_PRODUCT
// server-side). This is the client-side guard for the ProductForm image
// grid; the authoritative cap is still enforced in IPC.
const MAX_IMAGES = 50;

// v0.31.0: human-readable file size for the image grid.
function fmtBytes(n) {
  if (!n || n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'draft',    label: 'Draft' },
];

function emptyForm() {
  return {
    sku: '',
    name: '',
    brandId: '',
    barcode: '',
    secondaryCode: '',
    categoryId: '',
    subcategory: '',
    colorFinish: '',
    variant: '',
    unit: '',
    status: 'active',
    tags: '',
    description: '',
    priceRetail: '',
    priceWholesale: '',
  };
}

function productToForm(p) {
  return {
    sku: p.sku ?? '',
    name: p.name ?? '',
    brandId: p.brandId ?? '',
    barcode: p.barcode ?? '',
    secondaryCode: p.secondaryCode ?? '',
    categoryId: p.categoryId ?? '',
    subcategory: p.subcategory ?? '',
    colorFinish: p.colorFinish ?? '',
    variant: p.variant ?? '',
    unit: p.unit ?? '',
    status: p.status ?? 'active',
    tags: Array.isArray(p.tags) ? p.tags.join(', ') : '',
    description: p.description ?? '',
    priceRetail: p.priceRetail == null ? '' : String(p.priceRetail),
    priceWholesale: p.priceWholesale == null ? '' : String(p.priceWholesale),
  };
}

function toNumberOrNull(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function ProductForm({ product, isCreating = false, onClose, onStartCreate, onProcess, onPreview }) {
  // The panel is persistently mounted (per the user's request to keep the
  // detail view always visible). There are three modes:
  //   - `product` truthy            → edit-existing form
  //   - `isCreating` truthy         → blank new-product form
  //   - neither                     → friendly empty placeholder
  // `onClose` clears the active selection back to the empty state (it does
  // not unmount this component anymore).
  const isEmpty = !product && !isCreating;
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const createProduct = useAppStore((s) => s.createProduct);
  const updateProduct = useAppStore((s) => s.updateProduct);
  const removeProduct = useAppStore((s) => s.removeProduct);
  // v0.17.2: used to repopulate the form after a conflict-refresh.
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const createBrand = useAppStore((s) => s.createBrand);
  const createCategory = useAppStore((s) => s.createCategory);
  const addToast = useAppStore((s) => s.addToast);
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);
  // v0.49.39: drag-out is hidden in client mode (the multi-file
  // drag-out IPC is a no-op there pending Phase 2 — see
  // main/client/index.js for the rationale). "Copy to folder…" still
  // works in every mode because the bytes get pulled through the
  // app-image:// protocol passthrough.
  const appMode = useAppStore((s) => s.appMode);

  const [form, setForm] = useState(emptyForm());
  const [images, setImages] = useState([]);
  const [saving, setSaving] = useState(false);
  // v0.49.39: multi-select state for the image grid. Set of FILEPATHS
  // (not indices — indices shift after a delete/reorder; filepaths are
  // stable per row). When non-empty, the selection toolbar appears
  // above the grid with Copy / Drag / Clear. The set resets when the
  // displayed product changes — selections shouldn't leak across
  // products since their filepaths reference different rows.
  const [selectedFilepaths, setSelectedFilepaths] = useState(() => new Set());
  // Copying-in-progress flag so we can disable the buttons + show
  // "Copying…" during the IPC roundtrip. Folder picker latency + fetch
  // time means a 20-image copy isn't instant on a slow client link.
  const [copyingImages, setCopyingImages] = useState(false);
  // v0.49.39: side-panel "Copy ▾" dropdown visibility. Closes on
  // outside-click via a window-level handler installed when open.
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  // v0.49.40: drag-prep state. In client mode the drag pill needs to
  // download bytes from the server first; the dragstart handler
  // awaits the download before calling startDrag. Shows a "Preparing
  // {n}…" label so the user knows to keep holding their mouse — on
  // Tailscale at 5 product images this typically completes inside
  // 1 sec, well before the OS would cancel the gesture. In
  // standalone mode prepareDrag is instant so this state flickers
  // by too fast to see (and the pill label is back to "Drag" before
  // the next paint).
  const [draggingPrep, setDraggingPrep] = useState(false);
  // v0.29.0: per-image Reframe modal target ({ id, filepath, ... } | null).
  const [reframeTarget, setReframeTarget] = useState(null);
  // v0.18.0: Duplicate button busy state. Separate from saving so
  // the Save button shows its own spinner correctly during a save.
  const [duplicating, setDuplicating] = useState(false);
  // v0.22.6: history modal for this product's audit trail.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [skuError, setSkuError] = useState(null);
  const [activeProductId, setActiveProductId] = useState(product?.id ?? null);

  useEffect(() => {
    if (product) {
      setForm(productToForm(product));
      setActiveProductId(product.id);
      window.api?.images.listByProduct(product.id).then(setImages).catch(() => setImages([]));
    } else {
      // Either creating a new product or showing the empty state — either
      // way we want a clean form so the next interaction starts fresh.
      setForm(emptyForm());
      setImages([]);
      setActiveProductId(null);
    }
    setSkuError(null);
    // v0.49.39: drop any per-image selection when the displayed product
    // changes. Filepaths reference rows of the OLD product; carrying
    // them over would either match nothing or (worse) match a same-
    // path image of the new product. Always reset.
    setSelectedFilepaths(new Set());
    setCopyMenuOpen(false);
  }, [product, isCreating]);

  // v0.49.39: when the loaded image list shrinks (delete, reorder
  // renumber, etc.), drop any selected filepaths that no longer exist.
  // Same fix the Library does for selected product ids.
  useEffect(() => {
    setSelectedFilepaths((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(images.map((im) => im.filepath));
      let changed = false;
      const next = new Set();
      for (const fp of prev) {
        if (live.has(fp)) next.add(fp);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [images]);

  // v0.49.39: close the "Copy" dropdown on outside click. Capture
  // phase so a click on the dropdown trigger itself (which manages its
  // own toggle) reaches us first and we don't re-close right after the
  // open. Bail when the menu is closed to keep the listener cost zero
  // in the common case.
  useEffect(() => {
    if (!copyMenuOpen) return undefined;
    function onDocClick(e) {
      // Anything tagged with [data-copy-menu] is part of the trigger
      // or the menu itself — let the trigger toggle handle it.
      if (e.target.closest && e.target.closest('[data-copy-menu]')) return;
      setCopyMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [copyMenuOpen]);

  // v0.26.18: live-refresh the panel's image grid whenever ANY image
  // mutation hits the currently-displayed product. Previously the
  // useEffect above only re-loaded when `product` (identity) changed,
  // so an Overlay Studio apply / AI promote / etc. against the
  // already-displayed product left the panel showing stale pixels
  // until the user clicked off and back. The store's catalog-event
  // dispatcher refreshes the LIBRARY products + workspace; the side-
  // panel's images array is local to this component so it needs its
  // own subscription.
  useEffect(() => {
    if (!activeProductId || !window.api?.events?.onCatalogChanged) return undefined;
    const off = window.api.events.onCatalogChanged((evt) => {
      if (evt?.kind !== 'images') return;
      // evt.id is either the product id (single-product paths emit it)
      // or null (end-of-batch broad signal). Match either way for this
      // product, falling back to a refetch on null so a bulk batch
      // refresh still reaches us.
      if (evt.id != null && evt.id !== activeProductId) return;
      window.api.images.listByProduct(activeProductId)
        .then(setImages)
        .catch(() => { /* keep stale list rather than blank */ });
    });
    return off;
  }, [activeProductId]);

  const isCreate = !activeProductId;
  const skuValid = form.sku.trim().length > 0;

  const setField = (key) => (e) => {
    const value = e && e.target ? e.target.value : e;
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function handleCreateBrandInline() {
    const name = window.prompt('New brand name');
    if (!name?.trim()) return;
    try {
      const b = await createBrand({ name: name.trim() });
      setForm((f) => ({ ...f, brandId: b.id }));
      addToast(`Brand "${b.name}" added`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleCreateCategoryInline() {
    const name = window.prompt('New category name');
    if (!name?.trim()) return;
    try {
      const c = await createCategory({ name: name.trim() });
      setForm((f) => ({ ...f, categoryId: c.id }));
      addToast(`Category "${c.name}" added`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  function buildPayload() {
    return {
      sku: form.sku.trim(),
      name: form.name.trim() || null,
      brandId: form.brandId || null,
      barcode: form.barcode.trim() || null,
      secondaryCode: form.secondaryCode.trim() || null,
      categoryId: form.categoryId || null,
      subcategory: form.subcategory.trim() || null,
      colorFinish: form.colorFinish.trim() || null,
      variant: form.variant.trim() || null,
      unit: form.unit.trim() || null,
      status: form.status,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      description: form.description.trim() || null,
      priceRetail: toNumberOrNull(form.priceRetail),
      priceWholesale: toNumberOrNull(form.priceWholesale),
    };
  }

  async function handleSave() {
    if (!skuValid) {
      setSkuError('SKU is required');
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const created = await createProduct(buildPayload());
        setActiveProductId(created.id);
        addToast(`Created ${created.sku}`, 'success');
        setSkuError(null);
      } else {
        // v0.17.2: optimistic concurrency. We send the product's
        // `updatedAt` from when it was loaded; the server rejects
        // the save if anyone else has written to the row since.
        // When that happens we ask the user what to do and either
        // refresh the form, overwrite (retry without the token), or
        // bail out leaving their pending edits intact in the form.
        try {
          const updated = await updateProduct(activeProductId, {
            ...buildPayload(),
            expectedUpdatedAt: product?.updatedAt,
          });
          addToast(`Saved ${updated.sku}`, 'success');
          setSkuError(null);
        } catch (err) {
          const conflict = parseConflictError(err);
          if (!conflict) throw err;
          const choice = await showConflict(conflict);
          if (choice === 'refresh') {
            // Pull the fresh row into the form. The selector that
            // drives `product` reads from the store, so refreshing
            // products is enough — the useEffect that syncs form
            // state will pick up the new updatedAt and content.
            await refreshProducts();
            addToast('Form refreshed with the latest data', 'info');
          } else if (choice === 'overwrite') {
            const updated = await updateProduct(activeProductId, buildPayload());
            addToast(`Overwrote ${updated.sku}`, 'success');
            setSkuError(null);
          } else {
            // 'cancel' — leave form unchanged, no further action.
          }
        }
      }
    } catch (err) {
      setSkuError(err.message);
      addToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!activeProductId) return;
    const ok = await confirm({
      title: `Delete ${form.sku || 'this product'}?`,
      message: 'All images, AI generations, and metadata for this product will be removed.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete product',
    });
    if (!ok) return;
    try {
      await removeProduct(activeProductId);
      addToast('Deleted', 'success');
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  /**
   * v0.18.0: duplicate the current product. Server appends " (copy)"
   * (or " (copy 2)" / etc. on collision) to SKU and name, clones
   * every scalar field, clones images (content-addressed dedup so
   * no extra bytes on disk), and resets process status to
   * 'unprocessed'.
   *
   * Confirmation is a simple yes/no; v0.18.0 ships with images
   * always included since that's the dominant use case. A future
   * pass can add an "include images" toggle to a dedicated modal.
   */
  async function handleDuplicate() {
    if (!activeProductId) return;
    const ok = await confirm({
      title: `Duplicate ${form.sku || 'this product'}?`,
      message: 'A new product will be created with the same fields and images. The new SKU appends " (copy)" to the original.',
      detail: 'You can edit the SKU and name on the new product right after.',
      confirmLabel: 'Duplicate',
    });
    if (!ok) return;
    setDuplicating(true);
    try {
      const created = await window.api.products.duplicate(activeProductId, true);
      addToast(`Duplicated to ${created.sku}`, 'success');
      useAppStore.getState().refreshProducts();
      useAppStore.getState().refreshAllProducts?.();
      // Jump the side panel to the new product so the user can edit
      // its SKU / name without hunting for it in the table.
      useAppStore.getState().setActiveProductId(created.id);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setDuplicating(false);
    }
  }

  function handleProcess() {
    if (!activeProductId) return;
    // v0.11.2: prefer the parent-supplied router (Library opens the
    // destination picker modal). Fall back to the direct workspace jump
    // if a parent didn't wire `onProcess` — keeps any future re-use of
    // ProductForm outside Library working.
    if (onProcess) {
      onProcess(product);
    } else {
      openProductInWorkspace(activeProductId);
      onClose();
    }
  }

  /* ─── Image grid handlers ─── */

  async function refreshImagesFromIpc() {
    if (!activeProductId) return;
    const next = await window.api.images.listByProduct(activeProductId);
    setImages(next);
    // Refresh products list so thumbnail/count in the table updates too.
    useAppStore.getState().refreshProducts();
  }

  async function handleAddImage() {
    if (!activeProductId) {
      addToast('Save the product first, then add images.', 'info');
      return;
    }
    if (images.length >= MAX_IMAGES) {
      addToast(`Image cap is ${MAX_IMAGES}.`, 'error');
      return;
    }
    try {
      const filePath = await window.api.files.pickImageFile();
      if (!filePath) return;
      const res = await window.api.images.importForProduct(activeProductId, filePath);
      setImages(res.images);
      useAppStore.getState().refreshProducts();
      if (res.skipped) addToast('Same image already on this product — skipped.', 'info');
      else addToast('Image added', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleSetMain(filepath) {
    try {
      const next = await window.api.images.setMainImage(activeProductId, filepath);
      setImages(next);
      useAppStore.getState().refreshProducts();
      // v0.12.4: explicit toast so the user sees confirmation. Without
      // it, the operation looks silent — especially when both involved
      // images look similar (the visual swap is subtle).
      addToast('Set as main', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleReorder(filepath, direction) {
    const idx = images.findIndex((i) => i.filepath === filepath);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= images.length) return;
    const next = [...images];
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      const updated = await window.api.images.reorderImages(activeProductId, next.map((i) => i.filepath));
      setImages(updated);
      useAppStore.getState().refreshProducts();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleRemoveImage(filepath) {
    // v0.22.4: confirm before deleting. Misclicking the small × on an
    // image tile used to silently delete it — annoying because the
    // delete cascades to disk (the asset file is removed), so there
    // was no "undo" once it fired. The asset is still content-
    // addressed in the dedup pool, so other products referencing the
    // same hash keep their copy; but if this was the only reference,
    // the bytes are gone after this call.
    const tile = images.find((i) => i.filepath === filepath);
    const isMain = tile && images[0]?.filepath === filepath;
    const basename = (filepath?.split('/').pop() ?? 'this image');
    const ok = await confirm({
      title: 'Remove this image?',
      message: isMain
        ? `Position 0 (main image) will be removed${images.length > 1 ? '; the next image takes its place' : ''}.`
        : `"${basename}" will be removed from this product.`,
      detail: 'The file is deleted from disk if no other product references it. This can\'t be undone.',
      danger: true,
      confirmLabel: 'Remove image',
      // v0.26.21: power-user shortcut. Shift+D fires the confirm
      // without reaching for the mouse. Hint is shown next to the
      // button label automatically (⇧D).
      hotkey: 'shift+d',
    });
    if (!ok) return;
    try {
      const next = await window.api.images.removeFromProduct(activeProductId, filepath);
      setImages(next);
      useAppStore.getState().refreshProducts();
      // v0.22.9: explicit success toast that names the file that was
      // removed. Beyond the basic "yes it worked" feedback, this is
      // the explicit visual confirmation of WHICH file the click
      // affected — important now that the surrounding tiles re-flow
      // and the user can't easily eyeball which one disappeared.
      addToast(`Removed ${basename}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  /* ─── v0.49.39: multi-image copy + drag-out helpers ────────────── */

  // Toggle a single image's selection. The ImageTile checkbox calls
  // this — passes the filepath. Toggling the selection of an image
  // that's currently the only-selected one leaves the set empty,
  // which auto-hides the selection toolbar (the JSX below tests
  // size > 0). No animation; the toolbar just disappears.
  function toggleImageSelected(filepath) {
    setSelectedFilepaths((prev) => {
      const next = new Set(prev);
      if (next.has(filepath)) next.delete(filepath);
      else next.add(filepath);
      return next;
    });
  }

  function clearImageSelection() {
    setSelectedFilepaths(new Set());
  }

  function selectAllImages() {
    setSelectedFilepaths(new Set(images.map((im) => im.filepath)));
  }

  // Pop the OS folder picker, copy the chosen filepaths there.
  // `scope` is 'selected' | 'all' | 'main' — affects the filepath
  // list AND the toast wording. The handler routes through one IPC
  // (`images:copyImagesToFolder`) so the backend writer is the same
  // path; we just preset which subset of images get included.
  async function handleCopyImagesToFolder(scope) {
    if (!activeProductId) return;
    if (images.length === 0) {
      addToast('No images on this product.', 'info');
      return;
    }
    let filepaths;
    if (scope === 'main') {
      filepaths = [images[0].filepath];
    } else if (scope === 'selected') {
      filepaths = images
        .filter((im) => selectedFilepaths.has(im.filepath))
        .map((im) => im.filepath);
      if (filepaths.length === 0) {
        addToast('Select at least one image first.', 'info');
        return;
      }
    } else { // 'all'
      filepaths = images.map((im) => im.filepath);
    }
    setCopyingImages(true);
    setCopyMenuOpen(false);
    try {
      const res = await window.api.images.copyImagesToFolder({
        productId: activeProductId,
        // Renderer passes the SKU directly so the main handler doesn't
        // need to hit the DB — same code path works in standalone,
        // server, AND client mode (no local DB available on a client).
        sku: form.sku || 'product',
        filepaths,
      });
      if (res?.canceled) {
        // User cancelled the folder picker — silently exit; no toast,
        // they made an explicit choice.
        return;
      }
      const copied = res?.copied ?? 0;
      const failed = (res?.failures || []).length;
      if (copied > 0 && failed === 0) {
        addToast(`Copied ${copied} image${copied === 1 ? '' : 's'} to ${res.folder}`, 'success');
      } else if (copied > 0) {
        addToast(`Copied ${copied}, ${failed} failed.`, 'info');
      } else {
        addToast('No images copied — see Crash log for details.', 'error');
      }
    } catch (err) {
      addToast(`Copy failed: ${err.message}`, 'error');
    } finally {
      setCopyingImages(false);
    }
  }

  // Drag handle's onDragStart. preventDefault() is REQUIRED — without
  // it Chromium starts its OWN drag of the button's HTML and our IPC
  // races against that, so we get a weird mixed drag (Chromium's HTML
  // ghost + Electron's file drop) on some targets. preventDefault
  // suppresses the default; we then prepareDrag (which downloads
  // bytes to a temp dir in client mode, no-op resolve in standalone)
  // and ask main to start a proper native multi-file drag via
  // webContents.startDrag.
  //
  // v0.49.40 timing note: dragstart is fired by Chromium the moment
  // the user has moved enough pixels with the button held. We
  // preventDefault synchronously, then do async prep, then call
  // startDragOut. The OS keeps the gesture alive while the user
  // continues to hold the button — as long as startDragOut fires
  // before the user releases the mouse, the native drag begins. On
  // standalone this is sub-millisecond. On client with a fast
  // Tailscale link, ~200–800ms for typical product image sizes.
  async function handleDragOutStart(e, scope) {
    e.preventDefault();
    if (!activeProductId) return;
    let filepaths;
    if (scope === 'selected') {
      filepaths = images
        .filter((im) => selectedFilepaths.has(im.filepath))
        .map((im) => im.filepath);
    } else { // 'all'
      filepaths = images.map((im) => im.filepath);
    }
    if (filepaths.length === 0) return;
    setDraggingPrep(true);
    try {
      const prep = await window.api.images.prepareDrag(activeProductId, filepaths);
      const paths = Array.isArray(prep?.files) ? prep.files : [];
      if (paths.length === 0) {
        addToast(
          (prep?.failed?.[0]?.error)
            ? `Drag prep failed: ${prep.failed[0].error}`
            : 'Drag prep returned no files.',
          'error',
        );
        return;
      }
      if (Array.isArray(prep.failed) && prep.failed.length) {
        addToast(`Drag prepared with ${prep.failed.length} skipped (server unreachable).`, 'info');
      }
      window.api.images.startDragOut(paths);
    } catch (err) {
      // Likely client-mode network error or the server rejected the
      // request. Surface plainly — the user's mouse is probably
      // already released; no live drag to cancel.
      addToast(`Drag prep failed: ${err.message}`, 'error');
    } finally {
      setDraggingPrep(false);
    }
  }

  async function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((it) => it.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    if (!activeProductId) {
      addToast('Save the product first, then paste images.', 'info');
      return;
    }
    if (images.length >= MAX_IMAGES) {
      addToast(`Image cap is ${MAX_IMAGES}.`, 'error');
      return;
    }
    const blob = imageItem.getAsFile();
    if (!blob) return;
    try {
      const buf = await blob.arrayBuffer();
      const subtype = (blob.type.split('/')[1] || 'png').toLowerCase();
      const ext = subtype === 'jpeg' ? '.jpg' : `.${subtype}`;
      const res = await window.api.images.importFromBytes(activeProductId, buf, ext);
      setImages(res.images);
      useAppStore.getState().refreshProducts();
      if (res.skipped) addToast('Same image already on this product — skipped.', 'info');
      else addToast('Image pasted', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  const title = isEmpty
    ? 'Product details'
    : isCreate
      ? 'New product'
      : `Edit product · ${form.sku}`;

  // Esc clears the current selection (reverts to the empty placeholder).
  // No-op when the panel is already empty so other handlers on the page
  // (e.g. modal close) keep priority.
  useEffect(() => {
    if (isEmpty) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isEmpty, onClose]);

  if (isEmpty) {
    return (
      <aside className="lib-panel lib-panel--empty" role="complementary" aria-label={title}>
        <header className="lib-panel__head">
          <div className="lib-panel__title">{title}</div>
        </header>
        <div className="lib-panel__empty">
          <svg
            className="lib-panel__empty-icon"
            width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden
          >
            <rect x="8" y="10" width="40" height="36" rx="4" stroke="currentColor" strokeWidth="1.5" />
            <path d="M16 22h24M16 30h24M16 38h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div className="lib-panel__empty-title">No product selected</div>
          <div className="lib-panel__empty-body">
            Click any product in the list to view and edit its details here,
            or start a new one.
          </div>
          {onStartCreate ? (
            <Button variant="primary" onClick={onStartCreate}>+ New product</Button>
          ) : null}
        </div>
      </aside>
    );
  }

  return (
    <aside className="lib-panel" role="complementary" aria-label={title}>
      <header className="lib-panel__head">
        <div className="lib-panel__title">{title}</div>
        <button
          type="button"
          className="lib-panel__close"
          aria-label="Close (Esc)"
          title="Close (Esc)"
          onClick={onClose}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="lib-panel__body">
        <div className="form-grid" onPaste={handlePaste}>
        <Field label="SKU" required error={skuError} span="full">
          {({ id }) => (
            <Input
              id={id}
              autoFocus
              value={form.sku}
              invalid={!!skuError}
              onChange={(e) => { setField('sku')(e); if (skuError) setSkuError(null); }}
              placeholder="e.g. BBC-TILE-001"
            />
          )}
        </Field>

        <Field label="Name">
          {({ id }) => <Input id={id} value={form.name} onChange={setField('name')} />}
        </Field>

        <Field label="Brand">
          {({ id }) => (
            <div className="field__row">
              <Select id={id} value={form.brandId} onChange={setField('brandId')}>
                <option value="">— Unassigned —</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </Select>
              <button type="button" className="field__inline-btn" onClick={handleCreateBrandInline} title="Create new brand">
                +
              </button>
            </div>
          )}
        </Field>

        <Field label="Barcode" hint="EAN, UPC, or other">
          {({ id }) => <Input id={id} value={form.barcode} onChange={setField('barcode')} />}
        </Field>

        <Field label="Secondary code" hint="Supplier code or alt SKU">
          {({ id }) => <Input id={id} value={form.secondaryCode} onChange={setField('secondaryCode')} />}
        </Field>

        <Field label="Category">
          {({ id }) => (
            <div className="field__row">
              {/* v0.22.19: searchable. With 70+ categories the native
                  <select> was a long scroll; this is type-to-filter
                  with keyboard nav (↑↓ + Enter). The "+ New" inline
                  button stays for quick creation. */}
              <SearchableSelect
                id={id}
                value={form.categoryId || ''}
                options={categories}
                getLabel={(c) => c.name}
                getValue={(c) => c.id}
                getSecondary={(c) => c.productCount != null
                  ? `${c.productCount} product${c.productCount === 1 ? '' : 's'}`
                  : null}
                onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}
                emptyLabel="— Uncategorized —"
                emptyValue=""
              />
              <button type="button" className="field__inline-btn" onClick={handleCreateCategoryInline} title="Create new category">
                +
              </button>
            </div>
          )}
        </Field>

        <Field label="Subcategory">
          {({ id }) => <Input id={id} value={form.subcategory} onChange={setField('subcategory')} />}
        </Field>

        <Field label="Color / Finish">
          {({ id }) => <Input id={id} value={form.colorFinish} onChange={setField('colorFinish')} placeholder="e.g. Matte White" />}
        </Field>

        <Field label="Variant" hint="Size, material, etc.">
          {({ id }) => <Input id={id} value={form.variant} onChange={setField('variant')} />}
        </Field>

        <Field label="Unit" hint="e.g. sqm, piece, box">
          {({ id }) => <Input id={id} value={form.unit} onChange={setField('unit')} />}
        </Field>

        <Field label="Status">
          {({ id }) => (
            <Select id={id} value={form.status} onChange={setField('status')}>
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
        </Field>

        <Field label="Retail price">
          {({ id }) => <Input id={id} type="number" step="any" value={form.priceRetail} onChange={setField('priceRetail')} />}
        </Field>

        <Field label="Wholesale price">
          {({ id }) => <Input id={id} type="number" step="any" value={form.priceWholesale} onChange={setField('priceWholesale')} />}
        </Field>

        <Field label="Tags" hint="Comma-separated" span="full">
          {({ id }) => <Input id={id} value={form.tags} onChange={setField('tags')} />}
        </Field>

        <Field label="Description" span="full">
          {({ id }) => <Textarea id={id} value={form.description} onChange={setField('description')} rows={3} />}
        </Field>

        {/* Image grid */}
        <div className="field field--full">
          <div className="image-grid__header">
            <span className="field__label">
              Images <span className="image-grid__count">
                {images.length} / {MAX_IMAGES}
                {(() => {
                  const totalSize = images.reduce((s, im) => s + (im.fileSize || 0), 0);
                  return totalSize > 0 ? ` · ${fmtBytes(totalSize)}` : '';
                })()}
              </span>
            </span>
            {/* v0.49.39: "Copy ▾" dropdown — main / all / save to folder. Only
                shows when there's at least one image (otherwise there's
                nothing to copy). Sits next to "+ Add image" so the related
                actions (write to grid / read out of grid) live together. */}
            {activeProductId && images.length > 0 ? (
              <div className="copy-menu" data-copy-menu>
                <Button
                  onClick={() => setCopyMenuOpen((v) => !v)}
                  disabled={copyingImages}
                  title="Save copies of these images to a folder"
                  aria-expanded={copyMenuOpen}
                  aria-haspopup="menu"
                >
                  {copyingImages ? 'Copying…' : 'Copy ▾'}
                </Button>
                {copyMenuOpen ? (
                  <div className="copy-menu__panel" data-copy-menu role="menu">
                    <button
                      type="button"
                      className="copy-menu__item"
                      role="menuitem"
                      onClick={() => handleCopyImagesToFolder('main')}
                      disabled={copyingImages}
                    >
                      <span className="copy-menu__label">Save main image to folder…</span>
                      <span className="copy-menu__hint">The first image only</span>
                    </button>
                    <button
                      type="button"
                      className="copy-menu__item"
                      role="menuitem"
                      onClick={() => handleCopyImagesToFolder('all')}
                      disabled={copyingImages}
                    >
                      <span className="copy-menu__label">Save all {images.length} images to folder…</span>
                      <span className="copy-menu__hint">Named {(form.sku || 'product').replace(/[^A-Za-z0-9._-]+/g, '-')}-001, -002, …</span>
                    </button>
                    <div className="copy-menu__sep" aria-hidden />
                    <button
                      type="button"
                      className="copy-menu__item"
                      role="menuitem"
                      onClick={() => {
                        selectAllImages();
                        setCopyMenuOpen(false);
                      }}
                      disabled={copyingImages}
                    >
                      <span className="copy-menu__label">Select all for multi-action</span>
                      <span className="copy-menu__hint">Tick boxes appear on each image — then Copy / Drag / Delete from the strip</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <Button onClick={handleAddImage} disabled={!activeProductId || images.length >= MAX_IMAGES}>
              + Add image
            </Button>
          </div>
          <p className="field__hint">
            {activeProductId
              ? `Paste images directly from clipboard (⌘V). Same image is detected and skipped automatically.`
              : `Save the product first, then add images.`}
          </p>
          {/* v0.49.39: multi-select action strip. Appears only when the
              user has ticked at least one image (selectAllImages() from
              the Copy ▾ menu can also seed the selection). Three actions:
                - "Copy selected to folder…" — folder picker + writes N
                  files with the same clean naming as the dropdown's
                  "Save all" option.
                - "Drag selected" — multi-file native drag. Hidden in
                  client mode where startDragOut is a no-op. The button
                  is `draggable` and its onDragStart preventDefault()s
                  Chromium's default drag so main can start a proper
                  native one via webContents.startDrag.
                - "Clear" — drops the selection. Same affordance as the
                  Esc key would do if we wired one. */}
          {selectedFilepaths.size > 0 ? (
            <div className="image-select-bar">
              <span className="image-select-bar__count">
                {selectedFilepaths.size} selected
              </span>
              <Button
                onClick={() => handleCopyImagesToFolder('selected')}
                disabled={copyingImages}
              >
                {copyingImages ? 'Copying…' : 'Copy to folder…'}
              </Button>
              {/* v0.49.40: drag pill works in ALL modes now. In client
                  mode the dragstart handler awaits a download from the
                  server before the OS-level drag begins; the label
                  changes to "Preparing N…" during that window so the
                  user knows to keep their mouse held. */}
              <button
                type="button"
                className={`image-select-bar__drag${draggingPrep ? ' is-prepping' : ''}`}
                draggable
                onDragStart={(e) => handleDragOutStart(e, 'selected')}
                // Click is a no-op — the button only does anything
                // during a drag gesture. Prevent default so the click
                // doesn't accidentally submit a parent form.
                onClick={(e) => e.preventDefault()}
                title={appMode === 'client'
                  ? 'Click and drag onto any drop target — files download from the server on demand'
                  : 'Click and drag to copy these files to Finder, Mail, Slack, or any drop target'}
              >
                {draggingPrep
                  ? `Preparing ${selectedFilepaths.size}…`
                  : `⤴ Drag ${selectedFilepaths.size}`}
              </button>
              <Button onClick={clearImageSelection}>Clear</Button>
            </div>
          ) : null}
          {images.length === 0 ? (
            <div className="image-grid__empty">No images yet.</div>
          ) : (
            <div className="image-grid">
              {images.map((img, i) => (
                <ImageTile
                  // v0.22.8: key by row id, not filepath. The server
                  // renumbers files on remove/reorder so filepath
                  // changes for surviving rows — keying by filepath
                  // makes React think a tile in the middle was removed
                  // when actually the LAST tile was. Row id is stable
                  // through renames so React removes the correct DOM
                  // node for the actually-deleted image.
                  key={img.id ?? img.filepath}
                  image={img}
                  index={i}
                  total={images.length}
                  onSetMain={() => handleSetMain(img.filepath)}
                  onMoveLeft={() => handleReorder(img.filepath, -1)}
                  onMoveRight={() => handleReorder(img.filepath, 1)}
                  onRemove={() => handleRemoveImage(img.filepath)}
                  // v0.26.13: clicking the thumb opens the Lightbox at
                  // this index. Library owns the Lightbox state so it
                  // can also be opened from row/grid thumbs — we just
                  // hand the index back up.
                  onPreview={onPreview ? () => onPreview(i) : null}
                  onReframe={() => setReframeTarget(img)}
                  // v0.49.39: multi-select state for this tile.
                  selected={selectedFilepaths.has(img.filepath)}
                  onToggleSelected={() => toggleImageSelected(img.filepath)}
                />
              ))}
            </div>
          )}
        </div>
        </div>
      </div>

      {!isCreate && product?.updatedAt ? (
        <div className="lib-panel__attribution">
          <Attribution
            updatedAt={product.updatedAt}
            updatedByUserId={product.updatedByUserId}
          />
          {/* v0.22.6: gateway into the audit trail. Kept as a tiny
              text-style link so it doesn't compete with Save/Delete
              for visual weight — power users go to History rarely. */}
          <button
            type="button"
            className="lib-panel__history-link"
            onClick={() => setHistoryOpen(true)}
            title="See every recorded edit to this product"
          >
            History →
          </button>
        </div>
      ) : null}

      {/* v0.22.6: full audit log feed for this product, including the
          interleaved image add/remove/set-main/reorder events. */}
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        entityType="product"
        entityId={activeProductId}
        title={`History — ${form.sku || 'product'}`}
      />

      {/* v0.29.0: per-image reframe. Commits in place + bumps the
          content hash, so on save we just refetch the image list to pick
          up the new cache-bust stamp. */}
      <ReframeModal
        open={!!reframeTarget}
        productId={activeProductId}
        image={reframeTarget}
        onClose={() => setReframeTarget(null)}
        onSaved={() => {
          if (activeProductId) {
            window.api.images.listByProduct(activeProductId).then(setImages).catch(() => {});
          }
        }}
      />


      <footer className="lib-panel__footer">
        {!isCreate ? (
          <>
            <Button variant="danger" onClick={handleDelete}>Delete</Button>
            <Button onClick={handleDuplicate} disabled={duplicating}>
              {duplicating ? 'Duplicating…' : 'Duplicate'}
            </Button>
          </>
        ) : null}
        <div style={{ flex: 1 }} />
        {!isCreate ? (
          <Button onClick={handleProcess}>Process →</Button>
        ) : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!skuValid || saving} onClick={handleSave}>
          {saving ? 'Saving…' : isCreate ? 'Create' : 'Save'}
        </Button>
      </footer>
    </aside>
  );
}

function ImageTile({ image, index, total, onSetMain, onMoveLeft, onMoveRight, onRemove, onPreview, onReframe, selected, onToggleSelected }) {
  // v0.22.9: cache-bust strictly. Order of preference for the
  // version stamp:
  //   1. image.contentHash — content-addressed, definitive.
  //   2. image.id          — row-addressed, stable per row identity.
  //   3. image.filepath    — last resort, BROKEN by itself because
  //                          renumberFiles recycles paths across rows
  //                          (the row that used to be at /004 now
  //                          lives at /003 after a delete).
  //
  // v0.22.8 used (1) || (3), which broke for legacy rows that
  // predate the content_hash column backfill from v0.10.x — their
  // contentHash is null, the fallback to filepath defeats the
  // cache bust, and the user still sees stale pixels after delete.
  // v0.22.9 inserts row id between content hash and filepath: id
  // differs between the deleted row and the surviving row that
  // takes its filepath slot, so the URL ?v=<id> definitively
  // changes even without a content hash.
  const src = appImageSrc(image.filepath, image.contentHash || image.id || image.filepath);
  const isMain = index === 0;
  // v0.26.13: thumb is now clickable to open the Lightbox. We wrap the
  // <img> in a transparent button so it gets keyboard focus + an ARIA
  // role for free. The existing controls (Set as main / Remove / arrows)
  // are siblings outside this button so their own clicks aren't shadowed
  // — no stopPropagation gymnastics needed.
  return (
    <div className={`image-tile${isMain ? ' is-main' : ''}${selected ? ' is-selected' : ''}`}>
      {/* v0.49.39: per-image multi-select checkbox. Sits top-LEFT so
          it doesn't overlap the existing X remove (top-right) or the
          Reframe button. Visible on hover OR when ANY image on the
          product is selected (so the rest of the grid shows their
          empty boxes too — Mac Finder pattern: once selection mode
          starts, all targets become tickable). */}
      {onToggleSelected ? (
        <label
          className="image-tile__check"
          onClick={(e) => e.stopPropagation()}
          title="Select for multi-action (Copy / Drag / Delete)"
          aria-label={`Select image #${index + 1}`}
        >
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelected}
          />
          <span className="image-tile__check-box" aria-hidden />
        </label>
      ) : null}
      {onPreview ? (
        <button
          type="button"
          className="image-tile__preview-btn"
          onClick={onPreview}
          aria-label={`Preview image #${index + 1} full size`}
          title="Click to preview"
        >
          <img src={src} alt="" loading="lazy" />
        </button>
      ) : (
        <img src={src} alt="" loading="lazy" />
      )}
      {isMain ? <span className="image-tile__badge">Main</span> : (
        <button type="button" className="image-tile__set-main" onClick={onSetMain}>
          Set as main
        </button>
      )}
      <button
        type="button"
        className="image-tile__remove"
        aria-label="Remove image"
        title="Remove image"
        onClick={onRemove}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {onReframe ? (
        <button
          type="button"
          className="image-tile__reframe"
          onClick={onReframe}
          title="Reframe — shrink this image within its frame and fill the margin"
        >Reframe</button>
      ) : null}
      <div className="image-tile__nav">
        <button
          type="button"
          className="image-tile__nav-btn"
          onClick={onMoveLeft}
          disabled={index === 0}
          aria-label="Move earlier"
        >←</button>
        <span className="image-tile__pos">
          #{index + 1}{image.fileSize ? <span className="image-tile__size"> · {fmtBytes(image.fileSize)}</span> : null}
        </span>
        <button
          type="button"
          className="image-tile__nav-btn"
          onClick={onMoveRight}
          disabled={index === total - 1}
          aria-label="Move later"
        >→</button>
      </div>
    </div>
  );
}
