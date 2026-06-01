import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Pagination, paginate, Select, Textarea } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { BulkSourcePanel } from './BulkSourcePanel.jsx';
import { BulkGallery } from './BulkGallery.jsx';
import { PromptLibraryModal } from './PromptLibraryModal.jsx';

const MODE_STORAGE_KEY = 'AIStudio.mode';
const BULK_EXPORT_DIR_STORAGE_KEY = 'AIStudio.bulkExportDir';

function loadMode() {
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY);
    if (v === 'bulk' || v === 'product') return v;
  } catch {}
  return 'product';
}

function loadBulkExportDir() {
  try { return localStorage.getItem(BULK_EXPORT_DIR_STORAGE_KEY) || null; }
  catch { return null; }
}

const STATUS_TONE = {
  queued:    { tone: 'slate',   label: 'Queued' },
  running:   { tone: 'blue',    label: 'Running' },
  done:      { tone: 'emerald', label: 'Done' },
  failed:    { tone: 'rose',    label: 'Failed' },
  cancelled: { tone: 'slate',   label: 'Cancelled' },
};

const VARIABLE_TOKENS = ['{sku}', '{name}', '{brand}', '{color}', '{category}', '{description}'];

function fillTemplate(body, ctx) {
  if (!body) return '';
  return body
    .replace(/\{sku\}/gi,         ctx.sku ?? '')
    .replace(/\{name\}/gi,        ctx.name ?? '')
    .replace(/\{brand\}/gi,       ctx.brand ?? '')
    .replace(/\{color\}/gi,       ctx.colorFinish ?? '')
    .replace(/\{category\}/gi,    ctx.category ?? '')
    .replace(/\{description\}/gi, ctx.description ?? '')
    .trim();
}

export function AIStudio() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  // v0.11.3: read from `allProducts` (filter-agnostic) so the Source
  // picker isn't surprised when the Library is filtered. Previously the
  // combobox showed `products` which mirrors the Library's filters — new
  // products outside the active filter were invisible from AI Studio.
  const products = useAppStore((s) => s.allProducts);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const models = useAppStore((s) => s.aiModels);
  const tasks = useAppStore((s) => s.aiTasks);
  const prompts = useAppStore((s) => s.aiPrompts);
  const galleryByProduct = useAppStore((s) => s.aiGalleryByProduct);
  const sourceProductId = useAppStore((s) => s.aiSourceProductId);
  const sourceImagePath = useAppStore((s) => s.aiSourceImagePath);
  const selectedModelKey = useAppStore((s) => s.aiSelectedModelKey);
  const promptText = useAppStore((s) => s.aiPromptText);
  const aiOptions = useAppStore((s) => s.aiOptions);
  const setAiSourceProduct = useAppStore((s) => s.setAiSourceProduct);
  const setAiSourceImage = useAppStore((s) => s.setAiSourceImage);
  const setAiSelectedModel = useAppStore((s) => s.setAiSelectedModel);
  const setAiPrompt = useAppStore((s) => s.setAiPrompt);
  const setAiOptions = useAppStore((s) => s.setAiOptions);
  const queueAiTask = useAppStore((s) => s.queueAiTask);
  const repairAiTask = useAppStore((s) => s.repairAiTask);
  const queueFreshAiTask = useAppStore((s) => s.queueFreshAiTask);
  const cancelAiTask = useAppStore((s) => s.cancelAiTask);
  const removeAiTask = useAppStore((s) => s.removeAiTask);
  const refreshAiGalleryFor = useAppStore((s) => s.refreshAiGalleryFor);
  const refreshAiPrompts = useAppStore((s) => s.refreshAiPrompts);
  const refreshAiTasks = useAppStore((s) => s.refreshAiTasks);
  const refreshAiModels = useAppStore((s) => s.refreshAiModels);
  const refreshAiCredits = useAppStore((s) => s.refreshAiCredits);
  const aiCredits = useAppStore((s) => s.aiCredits);
  const addToast = useAppStore((s) => s.addToast);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  // v0.11.1: lets the user jump from AI Studio's Source picker straight
  // into Image Workspace for the selected product — mirrors the Library's
  // table row "Process →" action so users don't have to navigate back.
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);

  const [sourceImages, setSourceImages] = useState([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [promptModalOpen, setPromptModalOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(null);
  // v0.39.0: built-in prompt-library browser.
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [costEstimate, setCostEstimate] = useState(null);
  const [previewingPath, setPreviewingPath] = useState(null);
  const [queuePage, setQueuePage] = useState(0);

  // v0.11.0: bulk mode. `mode` toggles between the existing per-product
  // flow and the new folder/bulk flow. `bulkFiles` is the list of source
  // files picked for the next batch (each { abs, rel, name, size }).
  // `bulkRefreshKey` bumps after a successful enqueue so BulkGallery
  // re-fetches once the runner finishes the new tasks.
  const [mode, setMode] = useState(loadMode);
  const [bulkFiles, setBulkFiles] = useState([]);
  const [bulkRefreshKey, setBulkRefreshKey] = useState(0);
  // v0.11.5: optional external export folder. When set, the runner copies
  // each bulk result here (in addition to the internal gallery) using the
  // input file's basename. Persisted so users don't pick every session.
  const [bulkExportDir, setBulkExportDir] = useState(loadBulkExportDir);
  useEffect(() => {
    try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch {}
  }, [mode]);
  useEffect(() => {
    try {
      if (bulkExportDir) localStorage.setItem(BULK_EXPORT_DIR_STORAGE_KEY, bulkExportDir);
      else localStorage.removeItem(BULK_EXPORT_DIR_STORAGE_KEY);
    } catch {}
  }, [bulkExportDir]);
  // Small default (10) keeps the queue compact — the gallery above stays
  // visible without scrolling once a few generations are running.
  const [queuePageSize, setQueuePageSize] = useState(10);
  // Local cache for products referenced by queue tasks but missing from
  // the store's product list (e.g. fetched lazily, paginated out, or
  // belonging to a no-longer-active filter). Maps productId → product|null.
  // null means "we asked and the product genuinely doesn't exist anymore".
  const [extraProducts, setExtraProducts] = useState(() => new Map());

  // Initial loads.
  useEffect(() => {
    if (models.length === 0) refreshAiModels();
    // v0.11.3: ensure the filter-agnostic product list is populated. It's
    // normally seeded by setActiveCompany on boot, but a defensive
    // refresh on AI Studio mount guards against stale state from very
    // long sessions or future call paths that skip the company switch.
    if (products.length === 0) useAppStore.getState().refreshAllProducts();
    refreshAiTasks();
    refreshAiPrompts();
    refreshAiCredits();
    // v0.26.41 (audit pass): `[]` is intentional. We want a single
    // mount-time kickoff of the AI page's data. The conditional
    // `models.length === 0` guards inside the effect mean adding
    // models.length to deps would cause a flicker (effect re-runs
    // when list changes from empty to non-empty). The refreshX
    // functions are zustand selector outputs — stable refs, so
    // listing them wouldn't cause re-fires, but listing them
    // without models.length / products.length wouldn't lint clean
    // either. Cleanest: keep `[]` + document why.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // If the saved/default model key isn't in the catalog (e.g. a model was
  // removed between releases, or a fresh install hits a stale config), snap
  // to the first available model so the <Select> doesn't show a phantom
  // value the user can't actually pick.
  useEffect(() => {
    if (!models.length) return;
    if (!models.some((m) => m.key === selectedModelKey)) {
      setAiSelectedModel(models[0].key);
    }
  }, [models, selectedModelKey, setAiSelectedModel]);

  // Whenever the source product changes, fetch its images + gallery.
  useEffect(() => {
    if (!sourceProductId) { setSourceImages([]); return; }
    window.api.images.listByProduct(sourceProductId).then(setSourceImages).catch(() => setSourceImages([]));
    refreshAiGalleryFor(sourceProductId);
  }, [sourceProductId, refreshAiGalleryFor]);

  // Recompute cost when model / options change.
  useEffect(() => {
    const count = aiOptions.nVariants ?? aiOptions.numImages ?? 1;
    if (!window.api) return;
    window.api.ai.estimateCost(selectedModelKey, count).then(setCostEstimate).catch(() => setCostEstimate(null));
  }, [selectedModelKey, aiOptions.nVariants, aiOptions.numImages]);

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="AI Studio" />
        <EmptyState
          title="No company selected"
          body="Create or select a company before queueing generations."
          action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Company</Button>}
        />
      </div>
    );
  }

  const selectedModel = models.find((m) => m.key === selectedModelKey) ?? models[0];
  const requiresSource = selectedModel?.supportsSource;
  const sourceImg = sourceImages.find((i) => i.filepath === sourceImagePath);
  // Memoize a products-by-id Map so the queue row loop below doesn't do
  // products.find() (O(N) per row → O(N×M) per render — really bites at
  // 100 tasks × 500 products).
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  /**
   * Resolve a task's product. Hits the local store first; falls back to the
   * `extraProducts` cache for ones we've lazy-fetched. Returns:
   *   - product object if known
   *   - null if we've checked and the product genuinely no longer exists
   *   - undefined if we haven't tried yet (the backfill effect below
   *     will fetch it on the next tick)
   */
  function resolveTaskProduct(t) {
    if (!t?.productId) return null;
    if (productsById.has(t.productId)) return productsById.get(t.productId);
    if (extraProducts.has(t.productId)) return extraProducts.get(t.productId);
    return undefined;
  }

  // Backfill: any task whose productId isn't in the local products list and
  // hasn't been resolved yet gets a single IPC fetch. Caches the result
  // (including null for "gone") in `extraProducts` so we never re-fetch.
  // Without this, deleted products / paginated-out products leave the queue
  // showing an unhelpful "—" with no way to recover the SKU.
  useEffect(() => {
    const missing = new Set();
    for (const t of tasks) {
      if (!t.productId) continue;
      if (productsById.has(t.productId)) continue;
      if (extraProducts.has(t.productId)) continue;
      missing.add(t.productId);
    }
    if (missing.size === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        [...missing].map(async (id) => {
          try {
            const p = await window.api.products.get(id);
            return [id, p ?? null];
          } catch {
            return [id, null];
          }
        }),
      );
      if (cancelled) return;
      setExtraProducts((prev) => {
        const next = new Map(prev);
        for (const [id, p] of results) next.set(id, p);
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [tasks, productsById, extraProducts]);

  const sourceProduct = productsById.get(sourceProductId);

  const productCtx = sourceProduct ? {
    sku: sourceProduct.sku,
    name: sourceProduct.name,
    brand: brands.find((b) => b.id === sourceProduct.brandId)?.name,
    colorFinish: sourceProduct.colorFinish,
    category: categories.find((c) => c.id === sourceProduct.categoryId)?.name,
    description: sourceProduct.description,
  } : {};

  const filledPrompt = fillTemplate(promptText, productCtx);

  function handleApplyTemplate(tpl) {
    setAiPrompt(tpl.body);
    addToast(`Applied template "${tpl.name}"`, 'info');
  }

  function openConfirm() {
    if (!filledPrompt) { addToast('Prompt is empty', 'error'); return; }
    if (mode === 'bulk') {
      if (bulkFiles.length === 0) { addToast('Pick at least one image first', 'error'); return; }
    } else if (requiresSource && !sourceImagePath) {
      addToast('Pick a source image', 'error'); return;
    }
    setConfirmOpen(true);
  }

  async function handleQueue() {
    setConfirmOpen(false);
    try {
      const opts = { ...aiOptions };
      if (mode === 'bulk') {
        const sourcePaths = bulkFiles.map((f) => f.abs);
        // v0.11.5: thread the export folder into each task's options so
        // the runner can mirror outputs there. Trim trailing slashes for
        // path consistency on the main process side.
        const optionsWithExport = bulkExportDir
          ? { ...opts, exportDir: bulkExportDir.replace(/\/+$/, '') }
          : opts;
        const res = await window.api.ai.queueBulkBatch({
          companyId: activeCompanyId,
          sourcePaths,
          provider: selectedModel.provider,
          model: selectedModel.key,
          prompt: filledPrompt,
          options: optionsWithExport,
        });
        // Refresh the on-page task list so they show up immediately in the queue.
        await refreshAiTasks();
        if (res.skipped?.length) {
          addToast(`Queued ${res.queued} · ${res.skipped.length} skipped (import failed)`, 'info');
        } else {
          addToast(`Queued ${res.queued} bulk task${res.queued === 1 ? '' : 's'}`, 'success');
        }
        setBulkFiles([]);
        setBulkRefreshKey((k) => k + 1);
      } else {
        // For kie:gpt4o-image the count param is nVariants; everything else uses numImages.
        const count = selectedModel?.key === 'kie:gpt4o-image'
          ? (opts.nVariants ?? 1)
          : (opts.numImages ?? 1);
        const task = await queueAiTask({
          productId: sourceProductId,
          sourceImagePath: requiresSource ? sourceImagePath : null,
          provider: selectedModel.provider,
          model: selectedModel.key,
          prompt: filledPrompt,
          options: opts,
        });
        addToast(`Queued ${count} generation${count === 1 ? '' : 's'}`, 'success');
      }
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  function openNewPrompt() {
    setEditingPrompt({});
    setPromptModalOpen(true);
  }
  function openEditPrompt(tpl) {
    setEditingPrompt(tpl);
    setPromptModalOpen(true);
  }
  async function handleSavePrompt(payload) {
    try {
      if (editingPrompt?.id) {
        await window.api.ai.updatePrompt(editingPrompt.id, payload);
        addToast('Template saved', 'success');
      } else {
        await window.api.ai.createPrompt({ companyId: activeCompanyId, ...payload });
        addToast('Template created', 'success');
      }
      await refreshAiPrompts();
      setPromptModalOpen(false);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }
  async function handleDeletePrompt(id) {
    const ok = await confirm({
      title: 'Delete this template?',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete template',
    });
    if (!ok) return;
    try {
      await window.api.ai.removePrompt(id);
      await refreshAiPrompts();
      addToast('Template deleted', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handlePromoteGallery(entryId, { asMain = false } = {}) {
    try {
      await window.api.ai.promoteGallery({ galleryId: entryId, asMain });
      refreshAiGalleryFor(sourceProductId);
      useAppStore.getState().refreshProducts();
      // Refresh tasks too so the "promoted N/M" badge updates immediately,
      // without waiting for the next ai:taskUpdate event from the runner.
      refreshAiTasks();
      addToast(asMain ? 'Set as main image' : 'Added to product images', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleFavoriteGallery(entryId, isFavorite) {
    try {
      await window.api.ai.favoriteGallery(entryId, isFavorite);
      refreshAiGalleryFor(sourceProductId);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  /**
   * Click a queue row's SKU → load that task's product (and its source image,
   * if any) back into the Source picker at the top of the page so the user
   * can keep iterating with the same input. We also smooth-scroll the page
   * back to the top so the Source section is visible — without this, on a
   * long page the picker change is invisible and the click feels broken.
   */
  function jumpToTaskSource(task) {
    if (!task?.productId) return;
    setAiSourceProduct(task.productId);
    if (task.sourceImagePath) {
      // Set the source image too — the store clears it on setAiSourceProduct,
      // so we have to re-set after.
      setTimeout(() => setAiSourceImage(task.sourceImagePath), 0);
    }
    try {
      // Scroll the AI Studio scroll container to the top. Fall back to
      // window scroll for layouts where the page itself scrolls.
      const root = document.querySelector('.page--ai, .ai-layout, .page');
      if (root) root.scrollTo({ top: 0, behavior: 'smooth' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (_) { /* not fatal */ }
  }

  async function handleRemoveGallery(entryId) {
    const ok = await confirm({
      title: 'Delete this generation?',
      message: 'The image file is removed from disk.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete generation',
    });
    if (!ok) return;
    try {
      await window.api.ai.removeGallery(entryId);
      refreshAiGalleryFor(sourceProductId);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  const queueLen = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;

  // Queue pagination — newest first (the store already returns tasks in DESC order).
  const queuePager = useMemo(
    () => paginate(tasks.length, queuePage, queuePageSize),
    [tasks.length, queuePage, queuePageSize],
  );
  const visibleTasks = useMemo(
    () => tasks.slice(queuePager.pageStart, queuePager.pageEnd),
    [tasks, queuePager.pageStart, queuePager.pageEnd],
  );
  const gallery = sourceProductId ? (galleryByProduct[sourceProductId] ?? []) : [];

  return (
    <div className="page page--ai">
      <PageHeader
        title="AI Studio"
        subtitle={mode === 'bulk'
          ? 'Bulk mode — pick a folder or drop images to run them through any model.'
          : 'Image-to-image generation via kie.ai and fal.ai.'}
        actions={
          <>
            <div className="ws-toolbar__group" role="tablist" aria-label="AI Studio mode">
              <button
                type="button"
                className={`segment${mode === 'product' ? ' is-active' : ''}`}
                onClick={() => setMode('product')}
                title="Generate for a specific product"
                role="tab"
                aria-selected={mode === 'product'}
              >Per product</button>
              <button
                type="button"
                className={`segment${mode === 'bulk' ? ' is-active' : ''}`}
                onClick={() => setMode('bulk')}
                title="Run a folder of images through any model"
                role="tab"
                aria-selected={mode === 'bulk'}
              >Bulk / Folder</button>
            </div>
            <CreditPills credits={aiCredits} onRefresh={refreshAiCredits} />
          </>
        }
      />

      <p className="ai-retention-note">
        Tasks expire at the provider after a while —{' '}
        <strong>kie.ai keeps results for 7 days</strong>, <strong>fal.ai retains them indefinitely</strong>.
        Repair only works while the provider still has the task.
      </p>

      <div className="ai-layout">
        {/* ─── Source picker ─── */}
        {mode === 'bulk' ? (
          <section className="ai-card">
            <h3 className="ai-card__title">1. Source</h3>
            <BulkSourcePanel
              files={bulkFiles}
              onFilesChange={setBulkFiles}
              onError={(msg) => addToast(msg, 'error')}
              exportDir={bulkExportDir}
              onExportDirChange={setBulkExportDir}
            />
          </section>
        ) : (
        <section className="ai-card">
          <div className="ai-card__title-row">
            <h3 className="ai-card__title">1. Source</h3>
            {sourceProductId ? (
              <Button
                onClick={() => openProductInWorkspace(sourceProductId)}
                title="Open this product in the Image Workspace (crop, watermark, bg removal, etc.)"
              >Process →</Button>
            ) : null}
          </div>
          <Field label="Product" hint="Generated images attach to this product's gallery.">
            {({ id }) => (
              <ProductCombobox
                id={id}
                products={products}
                value={sourceProductId}
                onChange={setAiSourceProduct}
              />
            )}
          </Field>

          {sourceProductId ? (
            <>
              <div className="ai-source-thumbs">
                {sourceImages.length === 0 ? (
                  <p className="muted">This product has no images yet. Add some in the Product Library or use a text-to-image model.</p>
                ) : (
                  sourceImages.map((img) => {
                    const src = `app-image://local/${encodeURIComponent(img.filepath)}`;
                    const active = sourceImagePath === img.filepath;
                    return (
                      <button
                        key={img.filepath}
                        type="button"
                        className={`ai-thumb${active ? ' is-active' : ''}`}
                        onClick={() => setAiSourceImage(img.filepath)}
                        title={img.filename}
                      >
                        <img src={src} alt="" loading="lazy" />
                      </button>
                    );
                  })
                )}
              </div>

              {/* Large preview of the currently-selected source image. Click to
                  open the lightbox (shared with gallery previews) for a full-res look. */}
              {sourceImagePath ? (
                <button
                  type="button"
                  className="ai-source-preview"
                  onClick={() => setPreviewingPath(sourceImagePath)}
                  title="Click for full-size preview"
                >
                  <img
                    src={`app-image://local/${encodeURIComponent(sourceImagePath)}`}
                    alt="Source preview"
                  />
                  <span className="ai-source-preview__hint">
                    {sourceImages.find((i) => i.filepath === sourceImagePath)?.filename ?? 'Selected source'}
                    <span className="ai-source-preview__expand" aria-hidden>⤢ Click to zoom</span>
                  </span>
                </button>
              ) : sourceImages.length > 0 ? (
                <p className="muted ai-source-preview__pick">Pick a thumbnail above to preview the source.</p>
              ) : null}
            </>
          ) : null}
        </section>
        )}

        {/* ─── Prompt builder ─── */}
        <section className="ai-card">
          <h3 className="ai-card__title">2. Prompt</h3>

          <div className="ai-prompt-templates">
            <div className="filter-group__head">
              <span className="filter-group__label">Templates</span>
              <span className="ai-template-head-actions">
                <button type="button" className="filter-group__clear" onClick={() => setPromptLibraryOpen(true)}>Browse library</button>
                <button type="button" className="filter-group__clear" onClick={openNewPrompt}>+ New</button>
              </span>
            </div>
            {prompts.length === 0 ? (
              <p className="muted setting-row__inline-empty">No templates yet. Save your favorite prompts as templates and pick them with one click.</p>
            ) : (
              <ul className="ai-templates">
                {prompts.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="ai-template-row"
                      onClick={() => handleApplyTemplate(p)}
                      title={p.body}
                    >
                      <span className="ai-template-row__name">{p.name}</span>
                      <span className="ai-template-row__preview">{p.body.slice(0, 80)}{p.body.length > 80 ? '…' : ''}</span>
                    </button>
                    <button type="button" className="row-action" onClick={() => openEditPrompt(p)}>Edit</button>
                    <button type="button" className="row-action" onClick={() => handleDeletePrompt(p.id)}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Field label="Prompt" hint="Use placeholders like {sku}, {name}, {color}, {brand}, {category} — they'll be filled from the selected product.">
            {({ id }) => (
              <Textarea
                id={id}
                rows={4}
                value={promptText}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="Studio photo of the product on a clean white background, soft daylight, no shadows…"
              />
            )}
          </Field>

          {sourceProduct && /\{(sku|name|brand|color|category|description)\}/i.test(promptText) ? (
            <div className="ai-prompt-preview">
              <span className="filter-group__label">After filling</span>
              <div className="ai-prompt-preview__body">{filledPrompt}</div>
            </div>
          ) : null}

          <div className="ai-token-row">
            {VARIABLE_TOKENS.map((tok) => (
              <button
                key={tok}
                type="button"
                className="token-chip"
                onClick={() => setAiPrompt(promptText ? `${promptText} ${tok}` : tok)}
              >{tok}</button>
            ))}
          </div>
        </section>

        {/* ─── Model + options ─── */}
        <section className="ai-card">
          <h3 className="ai-card__title">3. Model</h3>
          <Field label="Provider · model">
            {({ id }) => (
              <Select id={id} value={selectedModelKey} onChange={(e) => setAiSelectedModel(e.target.value)}>
                <optgroup label="kie.ai">
                  {models.filter((m) => m.provider === 'kie' && !m.deprecated).map((m) => (
                    <option key={m.key} value={m.key}>{m.displayName}</option>
                  ))}
                </optgroup>
                <optgroup label="fal.ai">
                  {/* v0.49.25: hide deprecated models from the picker but keep them
                      in the MODELS array so already-queued tasks still resolve a
                      displayName + cost row when the queue runner looks them up. */}
                  {models.filter((m) => m.provider === 'fal' && !m.deprecated).map((m) => (
                    <option key={m.key} value={m.key}>{m.displayName}</option>
                  ))}
                </optgroup>
              </Select>
            )}
          </Field>
          {selectedModel ? (
            <p className="setting-row__hint">{selectedModel.description}</p>
          ) : null}

          {/* Size (kie models) */}
          {selectedModel?.sizes?.length ? (
            <Field label="Aspect ratio / size">
              {({ id }) => (
                <Select id={id} value={aiOptions.size ?? selectedModel.sizes[0]} onChange={(e) => setAiOptions({ size: e.target.value })}>
                  {selectedModel.sizes.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              )}
            </Field>
          ) : null}

          {/* Resolution (newer kie market models like GPT Image-2).
              v0.49.22: hint clarifies what 1K / 2K / 4K actually mean in
              pixels — easy to confuse 1K (a resolution tier) with the
              fal `1024x1024` image_size enum, and the "it\'s cheap" question
              was really about which pixel dimensions the K labels resolve to. */}
          {selectedModel?.resolutions?.length ? (
            <Field label="Resolution" hint="1K ≈ 1024px on the long edge, 2K ≈ 2048px, 4K ≈ 4096px. 1K is required for 1:1 / auto aspect.">
              {({ id }) => (
                <Select id={id} value={aiOptions.resolution ?? selectedModel.resolutions[0]} onChange={(e) => setAiOptions({ resolution: e.target.value })}>
                  {selectedModel.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
              )}
            </Field>
          ) : null}

          {/* v0.49.25: Quality picker for `openai/gpt-image-2/*` models.
              Cost varies ~6× between low and high on the same size, so
              exposing this is a real lever. The official pricing matrix:
                1024×1024 low=$0.015 medium=$0.061 high=$0.219.
              "auto" defers to the model\'s own quality routing. */}
          {selectedModel?.qualities?.length ? (
            <Field label="Quality" hint="auto: model picks. low: cheap & fast (~$0.015/img at 1024×1024). medium: balanced (~$0.061). high: best fidelity, ~6× the cost of low.">
              {({ id }) => (
                <Select id={id} value={aiOptions.quality ?? selectedModel.qualities[0]} onChange={(e) => setAiOptions({ quality: e.target.value })}>
                  {selectedModel.qualities.map((q) => <option key={q} value={q}>{q}</option>)}
                </Select>
              )}
            </Field>
          ) : null}

          {/* Count: nVariants (kie:gpt4o-image legacy) or numImages (fal) */}
          {selectedModel?.nVariants ? (
            <Field label="Variants per task">
              {({ id }) => (
                <Select id={id} value={String(aiOptions.nVariants ?? 1)} onChange={(e) => setAiOptions({ nVariants: Number(e.target.value) })}>
                  {selectedModel.nVariants.map((n) => <option key={n} value={String(n)}>{n}</option>)}
                </Select>
              )}
            </Field>
          ) : selectedModel?.provider === 'fal' ? (
            <Field label="Number of images" hint="1–4">
              {({ id }) => (
                <Input
                  id={id} type="number" min="1" max="4"
                  value={aiOptions.numImages ?? 1}
                  onChange={(e) => setAiOptions({ numImages: Math.max(1, Math.min(4, Number(e.target.value) || 1)) })}
                />
              )}
            </Field>
          ) : null}

          {/* v0.26.22: post-generation attach options. Per-product
              mode only — bulk-from-folder doesn't have a target
              product to attach to, and bulk-from-Library has its own
              modal with the same controls (BulkProductsAIRunModal).
              Two checkboxes with a dependency: promote-as-main
              implies add-to-product (you can't promote without
              adding first). Toggling promote on auto-enables add;
              toggling add off auto-disables promote.
              Hidden when no product is picked — the toggles would
              have no target. */}
          {mode === 'product' && sourceProductId ? (
            <div className="ai-attach-options">
              <label className="ai-attach-options__row">
                <input
                  type="checkbox"
                  checked={!!aiOptions.autoAddToProduct || !!aiOptions.autoPromoteAsMain}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setAiOptions({
                      autoAddToProduct: next,
                      // If you turn OFF add, promote can't stay on.
                      autoPromoteAsMain: next ? !!aiOptions.autoPromoteAsMain : false,
                    });
                  }}
                />
                <span>
                  <strong>Auto-add generated image to product.</strong>
                  <span className="muted"> When the task finishes, append the first successful variant as a new image on the product. Other variants stay in the gallery as alternates.</span>
                </span>
              </label>
              <label className="ai-attach-options__row ai-attach-options__row--child">
                <input
                  type="checkbox"
                  checked={!!aiOptions.autoPromoteAsMain}
                  disabled={!aiOptions.autoAddToProduct && !aiOptions.autoPromoteAsMain ? false : false /* always interactive; sibling logic syncs add */}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setAiOptions({
                      autoPromoteAsMain: next,
                      // Promote implies add — enable both together so
                      // the user doesn't have to tick the parent first.
                      autoAddToProduct: next || !!aiOptions.autoAddToProduct,
                    });
                  }}
                />
                <span>
                  <strong>Promote as main image.</strong>
                  <span className="muted"> Move the added image to position 0. Current main demotes to position 1 (kept as alternate, not deleted).</span>
                </span>
              </label>
            </div>
          ) : null}

          <div className="ai-cost-line">
            <span>{queueLen > 0 ? `${queueLen} task${queueLen === 1 ? '' : 's'} in queue` : 'Queue is idle'}</span>
            {costEstimate != null ? (
              <span className="ai-cost-line__money">Est. ${costEstimate.toFixed(3)} / generation</span>
            ) : null}
          </div>

          <Button
            variant="primary"
            onClick={openConfirm}
            disabled={
              !selectedModel ||
              (mode === 'product' && !sourceProductId) ||
              (mode === 'bulk' && bulkFiles.length === 0)
            }
          >
            {mode === 'bulk'
              ? `Review & queue ${bulkFiles.length || ''} task${bulkFiles.length === 1 ? '' : 's'} →`
              : 'Review & generate →'}
          </Button>
        </section>

        {/* ─── Gallery (above queue) ───
            Gallery sits between the controls and the queue so that newly-
            queued tasks pushing the queue list longer doesn't shove the
            gallery preview off-screen. This was the layout v0.5 had
            inverted — corrected in v0.9.2. */}
        {mode === 'bulk' ? (
          <BulkGallery
            refreshKey={bulkRefreshKey}
            addToast={addToast}
          />
        ) : sourceProductId ? (
          <section className="ai-card ai-card--gallery">
            <div className="filter-group__head">
              <h3 className="ai-card__title">
                Gallery {sourceProduct ? `· ${sourceProduct.sku}` : ''}
              </h3>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span className="filter-group__label">{gallery.length} generation{gallery.length === 1 ? '' : 's'}</span>
                <button
                  type="button"
                  className="filter-group__clear"
                  onClick={() => refreshAiGalleryFor(sourceProductId)}
                  title="Refresh gallery"
                >Refresh</button>
              </div>
            </div>
            {gallery.length === 0 ? (
              <p className="muted">No generations for this product yet.</p>
            ) : (
              <div className="ai-gallery">
                {gallery.map((g) => {
                  const src = `app-image://local/${encodeURIComponent(g.filepath)}`;
                  return (
                    <div key={g.id} className={`ai-gallery__tile${g.isFavorite ? ' is-fav' : ''}${g.promotedToProduct ? ' is-promoted' : ''}`}>
                      <button
                        type="button"
                        className="ai-gallery__open"
                        onClick={() => setPreviewingPath(g.filepath)}
                        title="Click to preview at full size"
                      >
                        <img src={src} alt="" loading="lazy" />
                      </button>
                      <div className="ai-gallery__caption" title={g.prompt}>
                        {g.prompt ? g.prompt.slice(0, 60) : '(no prompt)'}{g.prompt && g.prompt.length > 60 ? '…' : ''}
                      </div>
                      <div className="ai-gallery__actions">
                        <button
                          type="button"
                          className="row-action"
                          title={g.isFavorite ? 'Unfavorite' : 'Favorite'}
                          onClick={() => handleFavoriteGallery(g.id, !g.isFavorite)}
                        >{g.isFavorite ? '★' : '☆'}</button>
                        {!g.promotedToProduct ? (
                          <>
                            <button
                              type="button"
                              className="row-action"
                              title="Add to product images (appended to the end)"
                              onClick={() => handlePromoteGallery(g.id)}
                            >Promote</button>
                            <button
                              type="button"
                              className="row-action row-action--primary"
                              title="Add to product images AND set as the main image (position 0)"
                              onClick={() => handlePromoteGallery(g.id, { asMain: true })}
                            >Set as main</button>
                          </>
                        ) : (
                          <>
                            <span className="muted">In product</span>
                            <button
                              type="button"
                              className="row-action"
                              title="Re-import and set as the main image (handy if the product already has this generation but you want it on top)"
                              onClick={() => handlePromoteGallery(g.id, { asMain: true })}
                            >Set as main</button>
                          </>
                        )}
                        <button
                          type="button"
                          className="row-action"
                          title="Delete"
                          onClick={() => handleRemoveGallery(g.id)}
                        >×</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {/* ─── Queue (below gallery, capped height) ─── */}
        <section className="ai-card ai-card--queue">
          <div className="filter-group__head">
            <h3 className="ai-card__title">Queue</h3>
            {tasks.length > 0 ? (
              <span className="filter-group__label">{queueLen} active · {tasks.length} total</span>
            ) : null}
          </div>
          {tasks.length === 0 ? (
            <p className="muted">No tasks yet. Queue your first generation above.</p>
          ) : (
            <ul className="ai-queue">
              {visibleTasks.map((t) => {
                // Resolver also checks extraProducts (lazy-fetched cache) so
                // SKUs surface even when the store's products list doesn't
                // include them — e.g. when the product was deleted (and
                // ON DELETE SET NULL kicked in for ai_tasks.product_id) or
                // when products are still loading.
                const productResolved = resolveTaskProduct(t);
                const product = productResolved && typeof productResolved === 'object' ? productResolved : null;
                // A "Done" task that produced no gallery entries is effectively
                // recoverable — treat it like Failed for the action buttons and
                // label it so the user sees something is off.
                const isStuckDone = t.status === 'done' && (t.galleryCount ?? 0) === 0;
                // v0.49.27: also surface Repair on tasks that have been
                // running > 5 minutes AND have a providerTaskId. That covers
                // the "fal says success, our app shows running forever"
                // class of bug — the user can force a re-poll instead of
                // waiting on whatever ticks left. Threshold is conservative
                // so normal in-flight tasks don\'t get a useless button.
                const startedAtMs = t.startedAt || t.createdAt || 0;
                const ageMin = startedAtMs ? (Date.now() - Number(startedAtMs)) / 60000 : 0;
                const longRunning = t.status === 'running' && !!t.providerTaskId && ageMin > 5;
                const needsRecovery = t.status === 'failed' || t.status === 'cancelled' || isStuckDone || longRunning;
                let status = STATUS_TONE[t.status] ?? STATUS_TONE.queued;
                if (isStuckDone) status = { tone: 'amber', label: 'Done · no images' };
                const errorOrPrompt = needsRecovery && (t.errorMessage || isStuckDone)
                  ? (t.errorMessage
                      || 'Provider reported success but no images landed in the gallery. Click Repair to re-fetch.')
                  : null;
                return (
                  <li key={t.id} className="ai-queue__row">
                    <div className="ai-queue__col">
                      {product ? (
                        <button
                          type="button"
                          className="ai-queue__sku-link col-sku"
                          onClick={() => jumpToTaskSource(t)}
                          title={`Open ${product.sku} in Source above`}
                        >
                          {product.sku}
                        </button>
                      ) : !t.productId ? (
                        <span className="col-sku muted" title="This task was queued without a source product">(no product)</span>
                      ) : productResolved === null ? (
                        <span className="col-sku muted" title={`Product ${t.productId} no longer exists in this company`}>(product removed)</span>
                      ) : (
                        // productResolved === undefined → still loading
                        <span className="col-sku muted">…</span>
                      )}
                      <span className="muted">{t.model}</span>
                    </div>
                    {errorOrPrompt ? (
                      <span className="ai-queue__error" title={errorOrPrompt}>{errorOrPrompt}</span>
                    ) : (
                      <span className="muted">{t.prompt.slice(0, 50)}{t.prompt.length > 50 ? '…' : ''}</span>
                    )}
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {/* Promotion indicator. Lives in a dedicated grid column
                        (.ai-queue__promo) so it can't be visually clipped by
                        the progress column. We always render the wrapper so
                        column placement stays stable across rows; only the
                        badge itself is conditional. */}
                    <span className="ai-queue__promo">
                      {(t.galleryCount ?? 0) > 0 ? (
                        <Badge tone={t.promotedCount >= t.galleryCount ? 'emerald'
                                  : t.promotedCount > 0                ? 'amber'
                                                                       : 'slate'}>
                          {t.promotedCount >= t.galleryCount
                            ? `★ All ${t.galleryCount} on product`
                            : t.promotedCount > 0
                              ? `★ ${t.promotedCount}/${t.galleryCount} on product`
                              : `${t.galleryCount} awaiting review`}
                        </Badge>
                      ) : null}
                    </span>
                    {t.status === 'running' ? (
                      <span className="ai-queue__progress">{Math.round((t.progress ?? 0) * 100)}%</span>
                    ) : <span className="ai-queue__progress" />}
                    <div className="ai-queue__actions">
                      {needsRecovery ? (
                        <>
                          <button
                            type="button"
                            className="row-action"
                            title="Try to recover the result from the provider"
                            onClick={() => repairAiTask(t.id)}
                          >Repair</button>
                          <button
                            type="button"
                            className="row-action"
                            title="Submit a brand-new task with the same parameters"
                            onClick={() => queueFreshAiTask(t.id)}
                          >Queue fresh</button>
                        </>
                      ) : null}
                      {/* v0.49.24: when a task drags on (no log in the UI to
                          help diagnose why), let the user grab the provider
                          task ID so they can look it up on the provider\'s
                          own dashboard. Only meaningful once the provider
                          has assigned one (i.e. submit has gone through). */}
                      {t.providerTaskId && (t.status === 'running' || t.status === 'queued' || t.status === 'failed') ? (
                        <button
                          type="button"
                          className="row-action"
                          title={`Copy task ID — paste on ${t.provider === 'fal' ? 'fal.ai/dashboard/requests' : 'kie.ai/logs'} to look it up`}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(t.providerTaskId);
                              const where = t.provider === 'fal'
                                ? 'Open fal.ai/dashboard/requests and search'
                                : 'Open kie.ai/logs and search';
                              addToast(`Copied ${t.providerTaskId.slice(0, 8)}… — ${where}`, 'success');
                            } catch (err) {
                              addToast(`Clipboard failed: ${err.message}`, 'error');
                            }
                          }}
                        >Copy ID</button>
                      ) : null}
                      {t.status === 'running' || t.status === 'queued' ? (
                        <button type="button" className="row-action" onClick={() => cancelAiTask(t.id)}>Cancel</button>
                      ) : null}
                      <button type="button" className="row-action" onClick={() => removeAiTask(t.id)}>×</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {tasks.length > queuePageSize ? (
            <Pagination
              total={tasks.length}
              pageStart={queuePager.pageStart}
              pageEnd={queuePager.pageEnd}
              currentPage={queuePager.currentPage}
              maxPage={queuePager.maxPage}
              pageSize={queuePageSize}
              onPageChange={setQueuePage}
              onPageSizeChange={(n) => { setQueuePageSize(n); setQueuePage(0); }}
            />
          ) : null}
        </section>

      </div>

      {/* Confirmation dialog */}
      <ConfirmDialog
        open={confirmOpen}
        model={selectedModel}
        product={sourceProduct}
        sourceImg={sourceImg}
        prompt={filledPrompt}
        options={aiOptions}
        cost={costEstimate}
        onConfirm={handleQueue}
        onCancel={() => setConfirmOpen(false)}
        bulkCount={mode === 'bulk' ? bulkFiles.length : null}
      />

      {/* Prompt template editor */}
      <PromptTemplateModal
        open={promptModalOpen}
        template={editingPrompt}
        onClose={() => setPromptModalOpen(false)}
        onSave={handleSavePrompt}
      />

      {/* v0.39.0: built-in prompt-library browser */}
      <PromptLibraryModal
        open={promptLibraryOpen}
        companyId={activeCompanyId}
        onClose={() => setPromptLibraryOpen(false)}
        onUse={(body) => setAiPrompt(body)}
        onSaved={() => refreshAiPrompts()}
      />

      {/* Gallery image preview */}
      {previewingPath ? (
        <Modal
          open={true}
          onClose={() => setPreviewingPath(null)}
          title="Preview"
          size="xl"
        >
          <div className="ai-preview">
            <img
              src={`app-image://local/${encodeURIComponent(previewingPath)}`}
              alt=""
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Searchable product picker for the AI Studio Source section. The native
 * <Select> doesn't filter, so once a company has more than a couple dozen
 * SKUs it becomes painful to find a specific product. This combobox:
 *
 *   - Shows the currently-selected product label when collapsed.
 *   - Opens on focus / click and reveals a typeahead input + filtered list.
 *   - Filters by SKU or Name (case-insensitive substring, order-independent
 *     for multi-word queries like "blue mace 6101").
 *   - Caps the rendered list to 100 entries to keep things snappy for
 *     companies with thousands of products — once the user types, the
 *     filter narrows it down anyway.
 *   - Keyboard: ↑/↓ to move, Enter to pick, Esc to close, Tab to commit
 *     focus elsewhere.
 *   - Closes on outside click via a global mousedown listener.
 */
function ProductCombobox({ id, products, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = useMemo(
    () => products.find((p) => p.id === value) ?? null,
    [products, value],
  );

  // Multi-word AND search across SKU + Name. "ag m81" matches "AV-M8111-AG".
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const base = !terms.length
      ? products
      : products.filter((p) => {
          const hay = `${p.sku ?? ''} ${p.name ?? ''}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
    return base.slice(0, 100);
  }, [products, query]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // When the dropdown opens, focus the search input and reset the highlight
  // to the first row. Resetting the query on close would lose typing if the
  // user clicked outside accidentally — we keep it instead.
  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      // Focus on next tick — the input only mounts when `open` flips to true.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function pick(product) {
    onChange(product?.id ?? null);
    setOpen(false);
    setQuery('');
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIdx]) pick(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  // Keep the highlighted row scrolled into view when the user moves with the
  // arrow keys past the visible window of the dropdown list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const buttonLabel = selected
    ? (selected.name ? `${selected.sku} · ${selected.name}` : selected.sku)
    : '— Pick a product —';

  return (
    <div className="product-combobox" ref={wrapRef}>
      <button
        type="button"
        id={id}
        className={`product-combobox__trigger${selected ? '' : ' is-placeholder'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="product-combobox__label">{buttonLabel}</span>
        <span className="product-combobox__chev" aria-hidden>▾</span>
      </button>

      {open ? (
        <div className="product-combobox__pop" role="listbox">
          <input
            ref={inputRef}
            type="text"
            className="product-combobox__search"
            placeholder={`Search ${products.length} product${products.length === 1 ? '' : 's'}…`}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
          />
          <ul ref={listRef} className="product-combobox__list">
            {selected ? (
              <li
                key="__clear"
                className="product-combobox__row product-combobox__row--clear"
                onClick={() => pick(null)}
              >
                Clear selection
              </li>
            ) : null}
            {filtered.length === 0 ? (
              <li className="product-combobox__empty">No products match “{query}”</li>
            ) : (
              filtered.map((p, i) => (
                <li
                  key={p.id}
                  data-idx={i}
                  className={`product-combobox__row${i === activeIdx ? ' is-active' : ''}${p.id === value ? ' is-selected' : ''}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(p)}
                >
                  <span className="product-combobox__sku">{p.sku}</span>
                  {p.name ? <span className="product-combobox__name">{p.name}</span> : null}
                </li>
              ))
            )}
            {!query && products.length > filtered.length ? (
              <li className="product-combobox__hint">
                Showing first {filtered.length} of {products.length}. Type to search.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CreditPills({ credits, onRefresh }) {
  const kieLabel = credits?.kie != null
    ? `${credits.kie.toLocaleString()} credits`
    : '—';
  const falLabel = credits?.fal?.balance != null
    ? `${(credits.fal.currency || 'USD') === 'USD' ? '$' : ''}${credits.fal.balance.toFixed(2)} ${credits.fal.currency || ''}`.trim()
    : '—';
  return (
    <div className="ai-credits">
      <button
        type="button"
        className={`ai-credit-pill${credits?.kie == null ? ' is-empty' : ''}`}
        onClick={onRefresh}
        title="Click to refresh from kie.ai"
      >
        <span className="ai-credit-pill__label">kie</span>
        <span className="ai-credit-pill__value">{kieLabel}</span>
      </button>
      <button
        type="button"
        className={`ai-credit-pill${credits?.fal == null ? ' is-empty' : ''}`}
        onClick={onRefresh}
        title="Click to refresh from fal.ai"
      >
        <span className="ai-credit-pill__label">fal</span>
        <span className="ai-credit-pill__value">{falLabel}</span>
      </button>
    </div>
  );
}

function ConfirmDialog({ open, model, product, sourceImg, prompt, options, cost, onConfirm, onCancel, bulkCount }) {
  if (!open) return null;
  const perTaskCount = model?.key === 'kie:gpt4o-image'
    ? (options.nVariants ?? 1)
    : (options.numImages ?? 1);
  const isBulk = typeof bulkCount === 'number' && bulkCount > 0;
  // In bulk mode the user is queueing N tasks, each producing perTaskCount
  // generations. Total = bulkCount × perTaskCount.
  const totalGenerations = isBulk ? bulkCount * perTaskCount : perTaskCount;
  const totalCost = cost != null ? cost * totalGenerations : null;
  const srcUrl = sourceImg ? `app-image://local/${encodeURIComponent(sourceImg.filepath)}` : null;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={isBulk ? 'Confirm bulk queue' : 'Confirm generation'}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>
            {isBulk
              ? `Queue ${bulkCount} task${bulkCount === 1 ? '' : 's'} (${totalGenerations} image${totalGenerations === 1 ? '' : 's'})`
              : `Queue ${totalGenerations} generation${totalGenerations === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="ai-confirm">
        {isBulk ? (
          <div className="ai-confirm__source ai-confirm__source--empty">{bulkCount} source image{bulkCount === 1 ? '' : 's'}</div>
        ) : srcUrl ? (
          <img src={srcUrl} alt="source" className="ai-confirm__source" />
        ) : (
          <div className="ai-confirm__source ai-confirm__source--empty">No source (text-to-image)</div>
        )}
        <div className="ai-confirm__body">
          <div className="detail-card">
            <div className="detail-card__label">{isBulk ? 'Mode' : 'Product'}</div>
            <div className="detail-card__value">{isBulk ? 'Bulk (no product)' : (product?.sku ?? '—')}</div>
          </div>
          <div className="detail-card">
            <div className="detail-card__label">Model</div>
            <div className="detail-card__value">{model?.displayName ?? '—'}</div>
          </div>
          <div className="detail-card">
            <div className="detail-card__label">Count</div>
            <div className="detail-card__value">
              {isBulk
                ? `${bulkCount} × ${perTaskCount} = ${totalGenerations}`
                : totalGenerations}
            </div>
          </div>
          {options.size ? (
            <div className="detail-card">
              <div className="detail-card__label">Size</div>
              <div className="detail-card__value">{options.size}</div>
            </div>
          ) : null}
          {totalCost != null ? (
            <div className="detail-card">
              <div className="detail-card__label">Est. cost</div>
              <div className="detail-card__value">${totalCost.toFixed(3)}</div>
            </div>
          ) : null}
          <div className="detail-card detail-card--wide">
            <div className="detail-card__label">Prompt</div>
            <div className="detail-card__value">{prompt}</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PromptTemplateModal({ open, template, onClose, onSave }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? '');
    setBody(template?.body ?? '');
  }, [open, template]);
  const isEdit = !!template?.id;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit "${template.name}"` : 'New prompt template'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !body.trim()} onClick={() => onSave({ name: name.trim(), body: body.trim() })}>
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <Field label="Name" required>
        {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Studio shot" autoFocus />}
      </Field>
      <Field label="Body" hint="Use placeholders: {sku}, {name}, {color}, {brand}, {category}, {description}." span="full">
        {({ id }) => <Textarea id={id} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />}
      </Field>
    </Modal>
  );
}
