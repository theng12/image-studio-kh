import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Button, EmptyState } from '../../components/ui.jsx';
import { Lightbox } from '../../components/Lightbox.jsx';
import { ImageStrip } from './ImageStrip.jsx';
import { CanvasView } from './CanvasView.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { defaultSettings, mergeSettings } from '../../lib/workspaceSettings.js';
import { removeBackground } from '../../lib/bgRemoval.js';

export function ImageWorkspace() {
  const activeProductId = useAppStore((s) => s.activeProductId);
  const sku = useAppStore((s) => s.workspaceProductSku);
  const productName = useAppStore((s) => s.workspaceProductName);
  const images = useAppStore((s) => s.workspaceImages);
  const activeIdx = useAppStore((s) => s.workspaceImageIndex);
  const loading = useAppStore((s) => s.workspaceLoading);
  const processing = useAppStore((s) => s.workspaceProcessing);
  const progress = useAppStore((s) => s.workspaceProgress);
  const fillPreview = useAppStore((s) => s.workspaceFillPreview);
  const viewMode = useAppStore((s) => s.workspaceViewMode);
  const divider = useAppStore((s) => s.workspaceDivider);
  const zoom = useAppStore((s) => s.workspaceZoom);
  const guides = useAppStore((s) => s.workspaceGuides);
  const setWorkspaceZoom = useAppStore((s) => s.setWorkspaceZoom);
  const toggleWorkspaceGuides = useAppStore((s) => s.toggleWorkspaceGuides);
  const loadWorkspaceForProduct = useAppStore((s) => s.loadWorkspaceForProduct);
  const setWorkspaceImageIndex = useAppStore((s) => s.setWorkspaceImageIndex);
  const setWorkspaceFillPreview = useAppStore((s) => s.setWorkspaceFillPreview);
  const setWorkspaceViewMode = useAppStore((s) => s.setWorkspaceViewMode);
  const setWorkspaceDivider = useAppStore((s) => s.setWorkspaceDivider);
  const setWorkspaceProcessing = useAppStore((s) => s.setWorkspaceProcessing);
  const refreshWorkspaceImages = useAppStore((s) => s.refreshWorkspaceImages);
  const bumpProcessedTick = useAppStore((s) => s.bumpProcessedTick);
  const processedTick = useAppStore((s) => s.workspaceProcessedTick);
  const addToast = useAppStore((s) => s.addToast);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const appConfig = useAppStore((s) => s.appConfig);
  const refreshAppConfig = useAppStore((s) => s.refreshAppConfig);
  // Product list + jump action used by the in-workspace product picker so
  // the user can move between products without bouncing back to Library.
  const products = useAppStore((s) => s.products);
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);

  const [settings, setSettings] = useState(defaultSettings());
  const [processingLabel, setProcessingLabel] = useState(null);
  const [cropMode, setCropMode] = useState(false);
  // Lightbox state for previewing strip thumbnails. v0.26.8 — matches the
  // Product Library's "click a thumb to preview" UX. The strip's primary
  // click still SELECTS the image as the active workspace target; preview
  // is the secondary action (magnifier button or double-click).
  const [lightbox, setLightbox] = useState({ open: false, idx: 0 });
  // Auto-save status indicator per CLAUDE.md §6 — Editors don't have a Save
  // button; every change persists via IPC immediately. We surface the state
  // ('idle' | 'saving' | 'saved' | 'error') so the user knows their tweaks
  // are durable without clicking anything.
  const [saveStatus, setSaveStatus] = useState({ state: 'idle', lastSavedAt: null });
  // Debounce settings writes so a slider drag doesn't fire 50 IPC calls.
  // Holds the most recent timer + the settings snapshot keyed by image
  // filepath; the effect below cleans both up when the image switches.
  const saveDebounceRef = useRef(null);
  const lastSavedKeyRef = useRef(null);  // 'filepath::serialised-settings' last successfully saved

  function handleCropChange(rect) {
    setSettings((s) => ({ ...s, cropRect: rect }));
  }
  function toggleCropMode() {
    setCropMode((v) => !v);
  }

  // Load product images on activeProductId change.
  useEffect(() => {
    if (activeProductId) loadWorkspaceForProduct(activeProductId);
  }, [activeProductId, loadWorkspaceForProduct]);

  // When the active image changes, seed settings from its stored workspace_settings.
  const activeImage = images[activeIdx] ?? null;
  useEffect(() => {
    if (!activeImage) return;
    setSettings(mergeSettings(activeImage.workspaceSettings));
    // The freshly-seeded settings are by definition "saved" — track that
    // key so the debounce below doesn't fire a redundant write.
    lastSavedKeyRef.current = `${activeImage.filepath}::${JSON.stringify(mergeSettings(activeImage.workspaceSettings))}`;
    setSaveStatus({ state: 'idle', lastSavedAt: activeImage.workspaceSettings ? Date.now() : null });
    // v0.26.41 (audit pass): activeImage is in scope but only filepath
    // is in the dep array on purpose. We want to re-seed ONLY when the
    // user navigates to a different image file — not every time the
    // image object's workspaceSettings reference changes (which happens
    // after every save). Adding activeImage to deps would cause an
    // infinite save loop: save → store update → new activeImage → seed
    // → debounce fires → save again.
  }, [activeImage?.filepath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save: 500ms debounce after the last settings change. We compare a
  // serialised key per (image, settings) tuple to skip writes when nothing
  // actually differs from the last saved state (e.g. flip-and-flip-back).
  useEffect(() => {
    if (!activeImage || !activeProductId) return undefined;
    const key = `${activeImage.filepath}::${JSON.stringify(settings)}`;
    if (key === lastSavedKeyRef.current) return undefined;

    setSaveStatus((s) => ({ ...s, state: 'saving' }));
    const handle = setTimeout(async () => {
      try {
        await window.api.workspace.saveSettings(activeProductId, activeImage.filepath, settings);
        lastSavedKeyRef.current = key;
        setSaveStatus({ state: 'saved', lastSavedAt: Date.now() });
      } catch (err) {
        setSaveStatus({ state: 'error', lastSavedAt: null });
        addToast(`Save failed: ${err.message}`, 'error');
      }
    }, 500);
    saveDebounceRef.current = handle;
    return () => clearTimeout(handle);
  }, [settings, activeImage?.filepath, activeProductId, addToast]);

  // Refresh the "X min ago" display every 30s without re-fetching anything —
  // matches the CLAUDE.md §6 auto-refresh requirement for the indicator.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // Compute a renderer-side watermark URL if one is set.
  const watermarkSrc = settings.watermark?.relativePath
    ? `app-image://local/${encodeURIComponent(settings.watermark.relativePath)}`
    : null;

  async function handleUploadWatermark() {
    try {
      const filePath = await window.api.files.pickImageFile();
      if (!filePath) return;
      const { relativePath } = await window.api.watermarks.upload(filePath);
      setSettings((s) => ({ ...s, watermark: { ...s.watermark, relativePath } }));
      addToast('Watermark uploaded', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function processOne(image) {
    let foregroundBytes = null;
    if (settings.removeBackground) {
      // Engine is whatever the user picked in the SettingsPanel (or the
      // Settings page). 'local' is the bundled @imgly WASM; 'removebg' is
      // the paid cloud API. Both share the same disk cache + IPC pipeline
      // after this point.
      const engine = appConfig.bgRemovalEngine === 'removebg' ? 'removebg' : 'local';
      const { bytes } = await removeBackground(
        image.filepath,
        (stage, ratio) => {
          if (engine === 'removebg') {
            if (stage === 'upload') setProcessingLabel('Uploading to remove.bg…');
            else if (stage === 'download') setProcessingLabel('Downloading cutout from remove.bg…');
            else setProcessingLabel('Removing background…');
          } else if (stage.startsWith('fetch:')) {
            setProcessingLabel(`Downloading bg-removal model… ${Math.round(ratio * 100)}%`);
          } else {
            setProcessingLabel(`Removing background… ${Math.round(ratio * 100)}%`);
          }
        },
        { engine, apiKey: appConfig.removeBgApiKey },
      );
      foregroundBytes = bytes;
    }
    setProcessingLabel('Compositing…');
    const res = await window.api.workspace.processImage(
      activeProductId,
      image.filepath,
      settings,
      foregroundBytes,
    );
    await refreshWorkspaceImages(activeProductId);
    bumpProcessedTick();
    return res;
  }

  /**
   * Explicit Save: persist current settings *now*, bypassing the 500ms
   * debounce. Cancels the pending auto-save timer so we don't fire twice.
   * Idempotent — if no changes since last save, no IPC call is made.
   * Per CLAUDE.md §6 (updated 2026-05-20): editors keep an explicit Save
   * button as the user's deliberate-commit affordance, on top of the
   * automatic debounced save.
   */
  async function handleSaveNow() {
    if (!activeImage || !activeProductId) return;
    const key = `${activeImage.filepath}::${JSON.stringify(settings)}`;
    if (key === lastSavedKeyRef.current && saveStatus.state !== 'error') {
      // Already saved — give a friendly nudge so the click doesn't feel
      // ignored.
      addToast('Already saved', 'info');
      return;
    }
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    setSaveStatus((s) => ({ ...s, state: 'saving' }));
    try {
      await window.api.workspace.saveSettings(activeProductId, activeImage.filepath, settings);
      lastSavedKeyRef.current = key;
      setSaveStatus({ state: 'saved', lastSavedAt: Date.now() });
      addToast('Saved', 'success');
    } catch (err) {
      setSaveStatus({ state: 'error', lastSavedAt: null });
      addToast(`Save failed: ${err.message}`, 'error');
    }
  }

  async function handleApplyThis() {
    if (!activeImage) return;
    setWorkspaceProcessing(true);
    try {
      await processOne(activeImage);
      // Refresh the products list so the table reflects the new process status.
      useAppStore.getState().refreshProducts();
      addToast('Image processed', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setProcessingLabel(null);
      setWorkspaceProcessing(false);
    }
  }

  async function handleApplyAll() {
    if (images.length === 0) return;
    setWorkspaceProcessing(true, { current: 0, total: images.length });
    let failures = 0;
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      setWorkspaceProcessing(true, { current: i, total: images.length });
      setProcessingLabel(`Processing ${i + 1} of ${images.length}…`);
      try {
        await processOne(img);
      } catch (err) {
        failures += 1;
        // Continue with the rest, but record the issue.
        // eslint-disable-next-line no-console
        console.warn(`Failed to process ${img.filename}:`, err);
      }
    }
    setProcessingLabel(null);
    setWorkspaceProcessing(false, null);
    useAppStore.getState().refreshProducts();
    if (failures === 0) addToast(`Processed ${images.length} image${images.length === 1 ? '' : 's'}`, 'success');
    else addToast(`${images.length - failures} processed, ${failures} failed`, failures === images.length ? 'error' : 'info');
  }

  // v0.26.14: destructive flip of the active source image. Same IPC
  // the Library Lightbox uses. After it returns we refresh the
  // workspace image list + bump the processed-tick so the strip
  // thumb + canvas re-fetch with the new content hash. Errors land
  // in a toast rather than alert() since we have toast plumbing here.
  async function handleFlipActive(axis) {
    if (!activeImage || !activeProductId) return;
    try {
      await window.api.images.flipSource(activeProductId, activeImage.filepath, axis);
      await refreshWorkspaceImages(activeProductId);
      bumpProcessedTick();
      addToast(`Flipped ${axis === 'h' ? 'horizontally' : 'vertically'}`, 'success');
    } catch (err) {
      addToast(`Flip failed: ${err.message}`, 'error');
    }
  }

  // Top toolbar (view mode + flip + fill preview)
  const topBar = (
    <div className="ws-toolbar">
      <ProductNav
        products={products}
        activeProductId={activeProductId}
        onPick={(id) => { if (id) openProductInWorkspace(id); }}
      />
      <div className="ws-toolbar__group">
        <button
          type="button"
          className={`segment${viewMode === 'single' ? ' is-active' : ''}`}
          onClick={() => setWorkspaceViewMode('single')}
        >Single</button>
        <button
          type="button"
          className={`segment${viewMode === 'beforeAfter' ? ' is-active' : ''}`}
          disabled={!activeImage?.processedFilepath}
          title={!activeImage?.processedFilepath ? 'Process the image first to enable compare' : ''}
          onClick={() => setWorkspaceViewMode('beforeAfter')}
        >Before / After</button>
      </div>
      {/* v0.26.14: flip the source file on disk. Destructive — same
          IPC the Library Lightbox calls. Disabled if no active image. */}
      <div className="ws-toolbar__group" role="group" aria-label="Flip source image">
        <button
          type="button"
          className="segment"
          onClick={() => handleFlipActive('h')}
          disabled={!activeImage || processing}
          title="Flip horizontally (mirror left ↔ right). Rewrites the source file on disk."
          aria-label="Flip horizontally"
        >⇋ Flip H</button>
        <button
          type="button"
          className="segment"
          onClick={() => handleFlipActive('v')}
          disabled={!activeImage || processing}
          title="Flip vertically (mirror top ↕ bottom). Rewrites the source file on disk."
          aria-label="Flip vertically"
        >⥯ Flip V</button>
      </div>
      <SaveIndicator status={saveStatus} />
    </div>
  );

  if (!activeProductId) {
    return (
      <div className="page page--workspace">
        <PageHeader
          title="Image Workspace"
          subtitle="Process images per product — background, canvas, enhance."
          backTo={{ module: 'library', label: 'Product Library' }}
        />
        <EmptyState
          title="No product selected"
          body="Open a product from the Product Library to start processing."
          action={<Button variant="primary" onClick={() => setActiveModule('library')}>Go to Product Library</Button>}
        />
      </div>
    );
  }

  return (
    <div className="page page--workspace">
      <PageHeader
        title="Image Workspace"
        backTo={{ module: 'library', label: 'Product Library' }}
        contextChip={sku ? (productName ? `${sku} · ${productName}` : sku) : null}
        actions={topBar}
      />

      {loading ? (
        <EmptyState title="Loading…" />
      ) : images.length === 0 ? (
        <EmptyState
          title="No images on this product"
          body="Add some images from the Product Library, then come back here."
          action={<Button onClick={() => setActiveModule('library')}>Open Library</Button>}
        />
      ) : (
        <div className="ws-layout">
          <ImageStrip
            images={images}
            activeIndex={activeIdx}
            onSelect={(idx) => { setWorkspaceImageIndex(idx); setWorkspaceViewMode('single'); }}
            onPreview={(idx) => setLightbox({ open: true, idx })}
          />
          <CanvasView
            image={activeImage}
            settings={settings}
            fillPreview={fillPreview}
            viewMode={viewMode}
            divider={divider}
            onDividerChange={setWorkspaceDivider}
            processing={processing}
            processingLabel={progress
              ? `${processingLabel ?? 'Processing'} (${progress.current + 1}/${progress.total})`
              : processingLabel}
            cacheBust={processedTick}
            zoom={zoom}
            onZoomChange={setWorkspaceZoom}
            guides={guides}
            onToggleGuides={toggleWorkspaceGuides}
            cropMode={cropMode}
            onToggleCropMode={toggleCropMode}
            onCropChange={handleCropChange}
          />
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            onApplyThis={handleApplyThis}
            onApplyAll={handleApplyAll}
            onSave={handleSaveNow}
            saveStatus={saveStatus}
            totalImages={images.length}
            processing={processing}
            hasImage={!!activeImage}
            watermarkSrc={watermarkSrc}
            onUploadWatermark={handleUploadWatermark}
            fillPreview={fillPreview}
            onToggleFillPreview={setWorkspaceFillPreview}
          />
        </div>
      )}

      <Lightbox
        open={lightbox.open}
        onClose={() => setLightbox({ open: false, idx: 0 })}
        images={images}
        startIndex={lightbox.idx}
        title={sku ? (productName ? `${sku} · ${productName}` : sku) : null}
        // v0.26.14: Workspace also gets the destructive flip control
        // inside the Lightbox. After the IPC returns, we refresh the
        // workspace's image list so the strip + canvas show the new
        // pixels too.
        productId={activeProductId}
        onImageMutated={() => {
          refreshWorkspaceImages(activeProductId);
          bumpProcessedTick();
        }}
      />
    </div>
  );
}

/**
 * In-workspace product navigation. Three controls compressed into one
 * compact group:
 *
 *  - ◀ / ▶  step to prev / next product in the company-wide product list
 *           (same order Library shows, with normal pagination skipped — we
 *           operate on the full list)
 *  - select dropdown: jump to any product. Plain native select for now;
 *           300+ companies probably want the typeahead pattern we built
 *           for AI Studio, but the dropdown is fine for typical sizes.
 *
 * Disabled when at the ends of the list. The label shows current index so
 * the user knows where they are ("12 / 344").
 */
function ProductNav({ products, activeProductId, onPick }) {
  const idx = products.findIndex((p) => p.id === activeProductId);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < products.length - 1;
  return (
    <div className="ws-toolbar__group ws-prodnav">
      <button
        type="button"
        className="segment"
        disabled={!canPrev}
        title="Previous product"
        onClick={() => onPick(products[idx - 1]?.id)}
      >◀</button>
      <select
        className="ws-prodnav__select segment"
        value={activeProductId ?? ''}
        onChange={(e) => onPick(e.target.value || null)}
        title="Jump to product"
      >
        {idx < 0 ? <option value="">— Pick a product —</option> : null}
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.sku}{p.name ? ` · ${p.name}` : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="segment"
        disabled={!canNext}
        title="Next product"
        onClick={() => onPick(products[idx + 1]?.id)}
      >▶</button>
      {idx >= 0 ? (
        <span className="ws-prodnav__counter muted">{idx + 1} / {products.length}</span>
      ) : null}
    </div>
  );
}

/**
 * Save-status indicator per CLAUDE.md §6. Reflects the auto-save state
 * effect's `state` machine: 'idle' | 'saving' | 'saved' | 'error'.
 * Re-renders every 30s (via the parent's tick state) so the relative time
 * ("2 min ago") stays current without re-fetching anything.
 */
function SaveIndicator({ status }) {
  if (status.state === 'saving') {
    return <span className="ws-save ws-save--amber">Saving…</span>;
  }
  if (status.state === 'error') {
    return <span className="ws-save ws-save--rose">● Save failed</span>;
  }
  if (status.state === 'saved' || (status.state === 'idle' && status.lastSavedAt)) {
    return (
      <span className="ws-save ws-save--emerald" title={status.lastSavedAt ? new Date(status.lastSavedAt).toLocaleString() : ''}>
        ● All changes saved{status.lastSavedAt ? ` · ${formatAgo(status.lastSavedAt)}` : ''}
      </span>
    );
  }
  return null;
}

function formatAgo(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 5)   return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60)  return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}
