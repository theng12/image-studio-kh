import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Badge, EmptyState, Modal, Pagination, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { ProfileForm } from './ProfileForm.jsx';

/**
 * v0.26.29: persist the Export Center category filter per-company.
 * Category IDs are scoped to a company (the same id in a different
 * company is meaningless), so we key the storage by activeCompanyId.
 * Each company remembers its own last-used filter; switching company
 * doesn't bleed the filter across.
 *
 * Same module-local persistence pattern the Library uses for its
 * Table/Grid view (v0.26.23) — load on mount, save on every change.
 * Falls back gracefully when localStorage is unavailable (sandbox,
 * first launch, quota exceeded).
 */
function categoryFilterKey(companyId) {
  return `ExportCenter.categoryFilter.${companyId || 'none'}`;
}
function loadCategoryFilter(companyId) {
  try {
    const v = localStorage.getItem(categoryFilterKey(companyId));
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}
function saveCategoryFilter(companyId, value) {
  try { localStorage.setItem(categoryFilterKey(companyId), value || ''); } catch {}
}

export function ExportCenter() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const profiles = useAppStore((s) => s.exportProfiles);
  const selectedId = useAppStore((s) => s.selectedExportProfileId);
  const setSelected = useAppStore((s) => s.setSelectedExportProfile);
  const queueIds = useAppStore((s) => s.exportQueueIds);
  const setQueue = useAppStore((s) => s.setExportQueue);
  const toggleQueueProduct = useAppStore((s) => s.toggleQueueProduct);
  const clearExportQueue = useAppStore((s) => s.clearExportQueue);
  const outputRoot = useAppStore((s) => s.exportOutputRoot);
  const setOutputRoot = useAppStore((s) => s.setExportOutputRoot);
  const saveToLibrary = useAppStore((s) => s.exportSaveToLibrary);
  const setSaveToLibrary = useAppStore((s) => s.setExportSaveToLibrary);
  const running = useAppStore((s) => s.exportRunning);
  const lastResult = useAppStore((s) => s.exportLastResult);
  const products = useAppStore((s) => s.products);
  const categories = useAppStore((s) => s.categories);
  const refreshCategories = useAppStore((s) => s.refreshCategories);
  const refreshProfiles = useAppStore((s) => s.refreshExportProfiles);
  const createProfile = useAppStore((s) => s.createExportProfile);
  const updateProfile = useAppStore((s) => s.updateExportProfile);
  const removeProfile = useAppStore((s) => s.removeExportProfile);
  const duplicateProfile = useAppStore((s) => s.duplicateExportProfile);
  const runExport = useAppStore((s) => s.runExport);
  const checkExportCollisions = useAppStore((s) => s.checkExportCollisions);
  const addToast = useAppStore((s) => s.addToast);
  const setActiveModule = useAppStore((s) => s.setActiveModule);

  const [editing, setEditing] = useState(null);
  const [queuePage, setQueuePage] = useState(0);
  // Default page size is intentionally small (10) so the toolbar — page nav,
  // output folder, Run export — stays visible without scrolling once a real
  // company-sized product list is loaded.
  const [queuePageSize, setQueuePageSize] = useState(10);
  const [queueSearch, setQueueSearch] = useState('');
  // v0.26.28: category filter for the queue list. '' = all categories;
  // anything else = filter to products whose categoryId matches. Sits
  // alongside the search box and feeds the same filteredProducts memo
  // so "Select all" / "Ready only" / Pagination all reflect the
  // category filter without any extra plumbing.
  //
  // v0.26.29: persist per-company via localStorage. Seeded from the
  // active company's saved value on mount, validated against the
  // category list after it loads (silently clears if the saved id
  // doesn't exist in the current company — covers the case where a
  // category was deleted between sessions, or the user is logging in
  // with a different account that doesn't have that company).
  const [categoryFilter, setCategoryFilterRaw] = useState(() => loadCategoryFilter(activeCompanyId));
  const setCategoryFilter = (v) => {
    setCategoryFilterRaw(v);
    saveCategoryFilter(activeCompanyId, v);
  };
  // Re-seed when the active company changes mid-session. The Sidebar
  // company-switcher swaps activeCompanyId on the fly; without this
  // effect the dropdown would still show the previous company's
  // filter id (which is gibberish in the new company).
  useEffect(() => {
    setCategoryFilterRaw(loadCategoryFilter(activeCompanyId));
  }, [activeCompanyId]);
  // After categories load, validate the persisted filter. If the
  // saved id doesn't match any current category, fall back to ''
  // rather than show "0 of N in filter selected" forever.
  useEffect(() => {
    if (!categoryFilter) return;
    if (categories.length === 0) return; // categories haven't loaded yet
    const match = categories.some((c) => c.id === categoryFilter);
    if (!match) {
      setCategoryFilterRaw('');
      saveCategoryFilter(activeCompanyId, '');
    }
  }, [categories, categoryFilter, activeCompanyId]);

  useEffect(() => {
    if (activeCompanyId && profiles.length === 0) refreshProfiles();
  }, [activeCompanyId, profiles.length, refreshProfiles]);

  // Categories aren't auto-loaded by the Export Center route (they're
  // a Library concern), so load them on mount when the user lands
  // here. Same pattern as refreshProfiles above.
  useEffect(() => {
    if (activeCompanyId && categories.length === 0) refreshCategories?.();
  }, [activeCompanyId, categories.length, refreshCategories]);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;
  const queueSet = useMemo(() => new Set(queueIds), [queueIds]);
  const totalImagesQueued = useMemo(
    () => products.filter((p) => queueSet.has(p.id)).reduce((n, p) => n + (p.imageCount || 0), 0),
    [products, queueSet],
  );

  // Pre-flight: walk the selected products and bucket them so the user can
  // see what'll happen BEFORE clicking Run. Export is now pass-through:
  // products without processed images still export — they just use the raw
  // source straight through the resize/format pipeline. Only "no images at
  // all" is a true skip.
  //
  // Categories are mutually exclusive so the counts always add up to
  // queueIds.length.
  const preflight = useMemo(() => {
    let processed = 0;   // all images already processed (background removed, watermarked, etc.)
    let rawOnly = 0;     // has raw images but none processed → we'll export from raw source
    let mixed = 0;       // some processed, some raw → mix of both
    let noImages = 0;    // no source images at all → genuine skip
    let exportableImages = 0;  // total images that will export
    for (const p of products) {
      if (!queueSet.has(p.id)) continue;
      const total = p.imageCount ?? 0;
      const proc = p.processedImageCount ?? 0;
      if (total === 0)        noImages += 1;
      else if (proc === 0)    { rawOnly += 1;   exportableImages += total; }
      else if (proc < total)  { mixed += 1;     exportableImages += total; }
      else                    { processed += 1; exportableImages += total; }
    }
    return { processed, rawOnly, mixed, noImages, exportableImages };
  }, [products, queueSet]);

  // Client-side search: matches SKU + Name (case-insensitive, multi-word
  // AND so "BF 1611" finds "BF-M1611-CH"). The Pagination operates on the
  // filtered list, so paging numbers reflect what the user is actually
  // looking at — not the full company catalog.
  const filteredProducts = useMemo(() => {
    const terms = queueSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return products.filter((p) => {
      // v0.26.28: category filter — empty string = no filter.
      if (categoryFilter && p.categoryId !== categoryFilter) return false;
      if (terms.length === 0) return true;
      const hay = `${p.sku ?? ''} ${p.name ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [products, queueSearch, categoryFilter]);

  // Pagination state for the queue list (CLAUDE.md §10).
  const queuePager = useMemo(
    () => paginate(filteredProducts.length, queuePage, queuePageSize),
    [filteredProducts.length, queuePage, queuePageSize],
  );
  const visibleProducts = useMemo(
    () => filteredProducts.slice(queuePager.pageStart, queuePager.pageEnd),
    [filteredProducts, queuePager.pageStart, queuePager.pageEnd],
  );

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="Export Center" />
        <EmptyState
          title="No company selected"
          body="Create or select a company before exporting."
          action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Company</Button>}
        />
      </div>
    );
  }

  async function handleSubmitProfile(payload) {
    if (editing && editing.id) {
      await updateProfile(editing.id, payload);
      addToast('Profile saved', 'success');
    } else {
      await createProfile(payload);
      addToast('Profile created', 'success');
    }
  }

  async function handleDeleteProfile() {
    if (!editing?.id) return;
    const ok = await confirm({
      title: `Delete "${editing.name}"?`,
      message: 'This profile will be removed from this company.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete profile',
    });
    if (!ok) return;
    try {
      await removeProfile(editing.id);
      addToast('Profile deleted', 'success');
      setEditing(null);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDuplicate(id) {
    try {
      await duplicateProfile(id);
      addToast('Profile duplicated', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handlePickOutputFolder() {
    try {
      const folder = await window.api.files.pickFolder();
      if (folder) setOutputRoot(folder);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  // v0.26.24: collision modal state. When the user clicks Run, we
  // first dry-run-check the destination folder. If there are any
  // collisions, this state holds the preview so we can pop the modal;
  // null means "no decision pending". Run resumes via runWithMode().
  const [collisionPrompt, setCollisionPrompt] = useState(null);

  async function handleRun() {
    try {
      // v0.26.24: ask the backend whether the output folder already
      // contains files that would collide with this export. If yes,
      // hand off to the modal which calls back into runWithMode(...)
      // with the user's chosen policy. Zero collisions → just run.
      const preview = await checkExportCollisions();
      if (preview.collisionCount > 0) {
        setCollisionPrompt(preview);
        return;
      }
      await runWithMode('keepBoth');
    } catch (_) {
      // toast already shown by store
    }
  }

  async function runWithMode(onExisting) {
    try {
      const result = await runExport(onExisting);
      const parts = [];
      parts.push(`Exported ${result.exported} image${result.exported === 1 ? '' : 's'}`);
      if (result.replaced > 0) parts.push(`replaced ${result.replaced}`);
      if (result.skippedExisting > 0) parts.push(`kept ${result.skippedExisting} existing`);
      if (result.skipped > result.skippedExisting) {
        parts.push(`${result.skipped - result.skippedExisting} skipped`);
      }
      let msg = parts.join(', ');
      // v0.30.0: surface the total size right in the toast.
      if (result.totalBytes > 0) msg += ` · ${fmtBytes(result.totalBytes)}`;
      if (result.savedToLibrary > 0) msg += ` · ${result.savedToLibrary} to library`;
      const tone = (result.skipped - (result.skippedExisting || 0)) > 0 ? 'info' : 'success';
      addToast(msg, tone);
    } catch (_) {
      // toast already shown by store
    }
  }

  // When a search is active, Select all / Ready only operate on the
  // filtered subset — that's almost always what the user means by "all".
  // With no search active, they cover the whole company catalog as before.
  function selectAll() {
    setQueue(filteredProducts.map((p) => p.id));
  }
  function selectReadyOnly() {
    setQueue(filteredProducts
      .filter((p) => p.imageCount > 0 && (p.processStatus === 'done' || p.processStatus === 'exported'))
      .map((p) => p.id));
  }

  return (
    <div className="page page--export">
      <PageHeader
        title="Export Center"
        subtitle="One profile per run. Unprocessed images are skipped and reported in the summary."
      />

      <div className="export-layout">
        <aside className="export-profiles">
          <header className="export-profiles__head">
            <span className="filter-group__label">Profiles</span>
            <Button variant="ghost" onClick={() => setEditing({})}>+ New</Button>
          </header>
          {profiles.length === 0 ? (
            <div className="export-profiles__empty">
              No profiles yet. Create one to set output size, format, and naming.
            </div>
          ) : (
            <ul className="export-profiles__list">
              {profiles.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`export-profile-card${p.id === selectedId ? ' is-active' : ''}`}
                    onClick={() => setSelected(p.id)}
                  >
                    <div className="export-profile-card__name">{p.name}</div>
                    <div className="export-profile-card__meta">
                      {p.width}×{p.height} · {p.format.toUpperCase()} · {p.colorProfile}
                    </div>
                  </button>
                  <div className="export-profile-card__actions">
                    <button type="button" className="row-action" onClick={() => setEditing(p)}>Edit</button>
                    <button type="button" className="row-action" onClick={() => handleDuplicate(p.id)}>Duplicate</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="export-main">
          {selected ? (
            <>
              <header className="export-detail">
                <div className="export-detail__row">
                  <ProfilePreview profile={selected} products={products} queueSet={queueSet} />
                  <div className="export-detail__title">
                    <h2>{selected.name}</h2>
                    <div className="export-detail__cards">
                      <DetailCard label="Size"           value={`${selected.width} × ${selected.height}`} />
                      <DetailCard label="Format"         value={`${selected.format.toUpperCase()}${selected.format !== 'png' ? ` · q${selected.quality}` : ''}`} />
                      <DetailCard label="Background"     value={selected.backgroundColor} swatch={selected.backgroundColor} />
                      <DetailCard label="Color profile"  value={selected.colorProfile} />
                      <DetailCard label="Naming pattern" value={selected.namingPattern} mono />
                      {selected.outputSubfolder ? (
                        <DetailCard label="Subfolder" value={selected.outputSubfolder} mono />
                      ) : null}
                    </div>
                  </div>
                </div>
              </header>

              {/* Top runbar — output folder + Run export sit above the queue
                  so the user doesn't have to scroll past hundreds of products
                  to start a run. The summary on the left always reflects
                  selection counts, not the filtered view. */}
              <div className="export-runbar export-runbar--top">
                <div className="export-runbar__summary">
                  {queueIds.length} product{queueIds.length === 1 ? '' : 's'} ·
                  {' '}{totalImagesQueued} image{totalImagesQueued === 1 ? '' : 's'} queued
                </div>
                <div className="export-runbar__folder">
                  <span className="muted">Output folder:</span>{' '}
                  {outputRoot ? <code>{outputRoot}</code> : <span className="muted">— not set —</span>}
                  <Button onClick={handlePickOutputFolder}>{outputRoot ? 'Change…' : 'Pick…'}</Button>
                </div>
                {/* v0.31.0: also append the exported (web-size) copy back
                    onto each product as its main image. Flagged dedup-exempt
                    so the duplicate scan never pits it against the original. */}
                <label className="export-runbar__tolib" title="Append each exported web-size image onto its product as the new main image. Marked exempt from the duplicate scan.">
                  <input
                    type="checkbox"
                    checked={!!saveToLibrary}
                    onChange={(e) => setSaveToLibrary(e.target.checked)}
                  />
                  <span>Also save to product library</span>
                </label>
                <Button
                  variant="primary"
                  onClick={handleRun}
                  disabled={running || !outputRoot || queueIds.length === 0}
                >
                  {running ? 'Exporting…' : 'Run export'}
                </Button>
              </div>

              <div className="export-queue">
                <div className="export-queue__head">
                  <span className="filter-group__label">
                    Products ({queueIds.length} / {filteredProducts.length}
                    {(queueSearch || categoryFilter) ? ' in filter' : ''} selected)
                  </span>
                  <div className="export-queue__head-spacer" />
                  {/* v0.26.28: category filter dropdown. Sits next to
                      the search box so the two filters compose into the
                      same `filteredProducts`. "All categories" = no
                      filter; otherwise products are limited to that
                      category. The "Select all" button below picks up
                      the filtered subset automatically — there's no
                      separate "select filtered" action because
                      "Select all" already operates on the filtered
                      list (correct mental model: the toolbar shows
                      what you're working on, the button selects what
                      you can see). */}
                  <select
                    className="search-input export-queue__cat-filter"
                    value={categoryFilter}
                    onChange={(e) => { setCategoryFilter(e.target.value); setQueuePage(0); }}
                    aria-label="Filter by category"
                  >
                    <option value="">All categories</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <div className="search-wrap export-queue__search">
                    <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
                      <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                    <input
                      type="text"
                      className="search-input"
                      placeholder="Search SKU or name…"
                      value={queueSearch}
                      onChange={(e) => { setQueueSearch(e.target.value); setQueuePage(0); }}
                      spellCheck={false}
                    />
                  </div>
                  <div className="export-queue__actions">
                    {/* v0.26.28: clearer labels + tooltip on Ready
                        explaining the rule. Previously the user said
                        "I don't understand what 'ready' means" — now
                        the tooltip spells it out, and "Select all"
                        explicitly says "in filter" when one is active
                        so the user knows the count reflects their
                        category/search choices. */}
                    <Button
                      variant="ghost"
                      onClick={selectAll}
                      title={(queueSearch || categoryFilter)
                        ? `Select the ${filteredProducts.length} product${filteredProducts.length === 1 ? '' : 's'} matching the current filter`
                        : `Select every product in the company catalog (${products.length})`}
                    >
                      {(queueSearch || categoryFilter) ? `Select all in filter (${filteredProducts.length})` : 'Select all'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={selectReadyOnly}
                      title='"Ready" = has at least one image AND its processing status is "done" (Workspace finished) or "exported" (already exported once). Skips products that are still raw / unprocessed / missing images.'
                    >Ready only</Button>
                    {queueIds.length ? (
                      <Button variant="ghost" onClick={clearExportQueue}>Clear</Button>
                    ) : null}
                  </div>
                </div>
                {/* Top pagination — keeps page nav accessible without scrolling
                    past N items first. Same component instance as bottom would
                    be visually redundant, so the bottom pagination is removed. */}
                {filteredProducts.length > 0 ? (
                  <Pagination
                    total={filteredProducts.length}
                    pageStart={queuePager.pageStart}
                    pageEnd={queuePager.pageEnd}
                    currentPage={queuePager.currentPage}
                    maxPage={queuePager.maxPage}
                    pageSize={queuePageSize}
                    onPageChange={setQueuePage}
                    onPageSizeChange={(n) => { setQueuePageSize(n); setQueuePage(0); }}
                    pageSizeOptions={[10, 25, 50, 100, 200]}
                  />
                ) : null}
                {products.length === 0 ? (
                  <div className="export-queue__empty">
                    No products in this company yet.
                  </div>
                ) : filteredProducts.length === 0 ? (
                  <div className="export-queue__empty">
                    No products match “{queueSearch}”.
                  </div>
                ) : (
                  <>
                    <ul className="export-queue__list">
                      {visibleProducts.map((p) => {
                        const checked = queueSet.has(p.id);
                        const total = p.imageCount ?? 0;
                        const proc = p.processedImageCount ?? 0;
                        return (
                          <li key={p.id} className={`export-queue__row${checked ? ' is-selected' : ''}`}>
                            <input
                              type="checkbox"
                              className="export-queue__checkbox"
                              checked={checked}
                              onChange={() => toggleQueueProduct(p.id)}
                              aria-label={`Include ${p.sku} in run`}
                            />
                            <div className="export-queue__thumb">
                              {p.mainImagePath
                                ? <img src={`app-image://local/${encodeURIComponent(p.mainImagePath)}`} alt="" />
                                : <div className="thumb-placeholder">·</div>}
                            </div>
                            <div className="export-queue__col">
                              <span className="col-sku">{p.sku}</span>
                              {p.name ? <span className="muted">{p.name}</span> : null}
                            </div>
                            <span className="export-queue__count">{p.imageCount}/50</span>
                            {/* Badge shows what this product will produce on export:
                                  - Ready: all images already processed (Workspace step done)
                                  - Mixed: some processed, some raw — exports both
                                  - Raw:   no processed images, exports raw source as-is
                                  - No images: genuine skip */}
                            {total === 0 ? (
                              <Badge tone="slate">No images</Badge>
                            ) : proc === total ? (
                              <Badge tone="emerald">Ready</Badge>
                            ) : proc > 0 ? (
                              <Badge tone="amber">Mixed · {proc}/{total} processed</Badge>
                            ) : (
                              <Badge tone="amber">Raw</Badge>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>

              {/* Pre-flight summary: shows what will happen before the user
                  clicks Run. Mutually-exclusive buckets so counts add up. */}
              {queueIds.length > 0 ? (
                <PreflightSummary preflight={preflight} totalImagesQueued={totalImagesQueued} />
              ) : null}

              {lastResult ? (
                <ExportResultPanel result={lastResult} />
              ) : null}
            </>
          ) : (
            <EmptyState
              title={profiles.length === 0 ? 'No export profile yet' : 'Select a profile'}
              body={profiles.length === 0
                ? 'Profiles define output size, format, color, and file naming. Start from a marketplace preset.'
                : 'Pick a profile from the list to configure the queue.'}
              action={profiles.length === 0
                ? <Button variant="primary" onClick={() => setEditing({})}>+ New profile</Button>
                : null}
            />
          )}
        </section>
      </div>

      <ProfileForm
        open={editing !== null}
        profile={editing && editing.id ? editing : null}
        onClose={() => setEditing(null)}
        onSubmit={handleSubmitProfile}
        onDelete={handleDeleteProfile}
      />

      {collisionPrompt ? (
        <CollisionPromptModal
          preview={collisionPrompt}
          onCancel={() => setCollisionPrompt(null)}
          onPick={async (mode) => {
            setCollisionPrompt(null);
            await runWithMode(mode);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * v0.26.24: collision-handling modal. Shown when `exports:checkCollisions`
 * reports that the output folder already contains files that would
 * collide with this export. Three choices:
 *   - Replace      → overwrite existing files
 *   - Skip         → keep existing, don't write new
 *   - Keep both    → suffix new files with -2, -3 (old default)
 * Cancel just dismisses without running. No default — every collision
 * surfaces this modal so the user is never surprised. Hidden when zero
 * collisions exist (Export Center routes directly to runWithMode then).
 */
function CollisionPromptModal({ preview, onCancel, onPick }) {
  const { collisionCount, totalExpected, sampleCollisions = [] } = preview;
  const samplesText = sampleCollisions
    .slice(0, 3)
    .map((s) => s.name)
    .join(', ');
  return (
    <Modal
      open
      title="Folder already contains matching files"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button onClick={() => onPick('keepBoth')}>Keep both</Button>
          <Button onClick={() => onPick('skip')}>Skip existing</Button>
          <Button variant="primary" onClick={() => onPick('replace')}>Replace</Button>
        </>
      }
    >
      <p className="export-collision__lead">
        <strong>{collisionCount}</strong> of {totalExpected} file{totalExpected === 1 ? '' : 's'} in this
        export already exist in the destination folder.
        {samplesText ? <> e.g. <code>{samplesText}</code>{sampleCollisions.length > 3 ? '…' : ''}.</> : null}
      </p>
      <p className="export-collision__choice">
        <strong>Replace</strong> overwrites the existing files with the new bytes. Best for
        "I updated some products and want the folder to match my catalog."
      </p>
      <p className="export-collision__choice">
        <strong>Skip existing</strong> keeps the old files untouched and only writes the missing
        ones. Best for "fill the gaps" / resuming an interrupted run.
      </p>
      <p className="export-collision__choice">
        <strong>Keep both</strong> writes the new files alongside, with <code>-2</code>,{' '}
        <code>-3</code> suffixes. Best when you want side-by-side comparison.
      </p>
    </Modal>
  );
}

/**
 * Pre-run readiness banner. Export is pass-through — products without a
 * processed image just use the raw source. The only true skip is "no
 * images at all". Color tone:
 *   - emerald: everything will export with full processed images
 *   - amber:   some images will be exported from raw (no Workspace touch-up)
 *   - slate:   nothing exportable in this selection
 */
function PreflightSummary({ preflight, totalImagesQueued }) {
  const { processed, rawOnly, mixed, noImages, exportableImages } = preflight;
  const willExport = processed + rawOnly + mixed;
  const usingRaw = rawOnly + mixed;

  let tone = 'emerald';
  if (willExport === 0) tone = 'slate';
  else if (usingRaw > 0) tone = 'amber';

  return (
    <div className={`export-preflight export-preflight--${tone}`}>
      <div className="export-preflight__title">
        {willExport === 0
          ? 'Nothing exportable in this selection'
          : `${exportableImages} of ${totalImagesQueued} image${totalImagesQueued === 1 ? '' : 's'} will export`}
      </div>
      <div className="export-preflight__buckets">
        {processed > 0 ? <Badge tone="emerald">{processed} fully processed</Badge> : null}
        {mixed     > 0 ? <Badge tone="amber">{mixed} mixed (some raw)</Badge> : null}
        {rawOnly   > 0 ? <Badge tone="amber">{rawOnly} raw only</Badge> : null}
        {noImages  > 0 ? <Badge tone="slate">{noImages} no images — will skip</Badge> : null}
      </div>
      {usingRaw > 0 ? (
        <p className="export-preflight__hint">
          “Raw only” and “Mixed” products will export their original photo through the
          profile’s resize/format pipeline. Background removal, watermarks, and canvas
          composition are skipped for raw images — process them in Image Workspace first
          if you want those touches. Click <strong>Ready only</strong> above to limit
          this run to fully-processed products.
        </p>
      ) : null}
      {noImages > 0 && willExport > 0 ? (
        <p className="export-preflight__hint">
          {noImages} product{noImages === 1 ? '' : 's'} in the queue {noImages === 1 ? 'has' : 'have'} no
          image attached and will be skipped silently.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Result panel after a Run. Replaces the old wall-of-skip-lines with a
 * grouped summary by skip category — `unprocessed`, `missing`, etc. — each
 * with a count, a brief fix-it hint, and a collapsible details list showing
 * the first 50 affected SKUs.
 */
const SKIP_CATEGORY_INFO = {
  no_images: {
    label: 'No images attached',
    hint:  'These products don\'t have any source images yet. Import images via Auto-match, Excel, or the product form.',
  },
  missing: {
    label: 'File missing on disk',
    hint:  'Neither the processed nor the raw source file was found in the data folder. Re-import the image or restore from backup.',
  },
  not_found: {
    label: 'Product no longer exists',
    hint:  'These product IDs were in the queue but have been deleted. Refresh and re-select.',
  },
  error: {
    label: 'Errored during export',
    hint:  'Something went wrong while writing the output file. Check the error message and try again.',
  },
};

// v0.30.0: KB under 1 MB, MB above — matches how the user thinks about
// "is this small enough for fast mobile loading".
function fmtBytes(n) {
  if (!n || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function ExportResultPanel({ result }) {
  const grouped = useMemo(() => {
    const m = new Map();
    for (const s of result.skips ?? []) {
      const cat = s.category ?? 'error';
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat).push(s);
    }
    // Stable order: most common categories first so the user's eye lands
    // on what matters most.
    return ['no_images', 'missing', 'error', 'not_found']
      .filter((k) => m.has(k))
      .map((k) => ({ key: k, items: m.get(k) }));
  }, [result]);

  const fromRaw = result.exportedFromRaw ?? 0;
  // v0.30.0: output-size summary so the user knows how much they're about
  // to copy (and that each file landed in the small-for-mobile range).
  const total = result.totalBytes ?? 0;
  const avg = result.exported > 0 && total > 0 ? Math.round(total / result.exported) : 0;
  return (
    <div className={`export-result${result.skipped > 0 ? ' export-result--warn' : ' export-result--ok'}`}>
      <strong>
        Exported {result.exported} image{result.exported === 1 ? '' : 's'}
        {result.outputPath ? <> to <code>{result.outputPath}</code></> : null}.
      </strong>
      {total > 0 ? (
        <div className="export-result__size">
          <strong>{fmtBytes(total)}</strong> total
          {result.exported > 1 ? (
            <span className="muted">
              {' '}· avg {fmtBytes(avg)} · range {fmtBytes(result.minBytes)}–{fmtBytes(result.maxBytes)} per image
            </span>
          ) : null}
        </div>
      ) : null}
      {result.savedToLibrary > 0 ? (
        <div className="export-result__note">
          Saved {result.savedToLibrary} copy{result.savedToLibrary === 1 ? '' : 'ies'} back into the product
          library as the main image (exempt from the duplicate scan).
        </div>
      ) : null}
      {fromRaw > 0 ? (
        <div className="export-result__note">
          {fromRaw} of those came from the raw source (no Workspace step applied).
        </div>
      ) : null}
      {result.skipped > 0 ? (
        <div className="export-result__skips">
          <div className="export-result__skips-head">
            {result.skipped} skipped — grouped by reason:
          </div>
          {grouped.map(({ key, items }) => {
            const info = SKIP_CATEGORY_INFO[key] ?? { label: key, hint: '' };
            return (
              <details key={key} className="export-result__group">
                <summary>
                  <span className="export-result__group-count">{items.length}</span>
                  <span className="export-result__group-label">{info.label}</span>
                </summary>
                {info.hint ? <p className="export-result__group-hint">{info.hint}</p> : null}
                <ul className="export-result__group-list">
                  {items.slice(0, 50).map((s, i) => (
                    <li key={i}><code>{s.sku}</code> — {s.reason}</li>
                  ))}
                  {items.length > 50 ? <li className="muted">…and {items.length - 50} more</li> : null}
                </ul>
              </details>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function DetailCard({ label, value, swatch, mono }) {
  return (
    <div className="detail-card">
      <div className="detail-card__label">{label}</div>
      <div className={`detail-card__value${mono ? ' detail-card__value--mono' : ''}`}>
        {swatch ? <span className="detail-card__swatch" style={{ background: swatch }} /> : null}
        <span>{value}</span>
      </div>
    </div>
  );
}

function ProfilePreview({ profile, products, queueSet }) {
  // Prefer a real product image so the user previews what the profile will
  // actually output. Priority:
  //   1. First queued product that has any image
  //   2. Otherwise the first product in the company with any image
  //   3. Otherwise fall back to the abstract SVG placeholder.
  const previewSrc = useMemo(() => {
    if (!products?.length) return null;
    const queued = products.find((p) => queueSet?.has(p.id) && p.mainImagePath);
    if (queued) return queued.mainImagePath;
    const any = products.find((p) => p.mainImagePath);
    return any?.mainImagePath ?? null;
  }, [products, queueSet]);

  return (
    <div className="profile-preview">
      <div
        className="profile-preview__canvas"
        style={{
          aspectRatio: `${profile.width} / ${profile.height}`,
          background: profile.backgroundColor || '#ffffff',
        }}
      >
        {previewSrc ? (
          <img
            className="profile-preview__image"
            src={`app-image://local/${encodeURIComponent(previewSrc)}`}
            alt=""
          />
        ) : (
          <svg className="profile-preview__product" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
            <rect x="20" y="22" width="60" height="50" rx="4" fill="rgba(20,20,28,0.16)" />
            <circle cx="38" cy="38" r="5" fill="rgba(20,20,28,0.28)" />
            <path d="M22 70 L40 52 L55 62 L78 42 L78 72 L22 72 Z" fill="rgba(20,20,28,0.28)" />
          </svg>
        )}
      </div>
      <div className="profile-preview__meta">
        {profile.width} × {profile.height}
      </div>
    </div>
  );
}
