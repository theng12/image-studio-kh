import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * v0.26.0 (Phase 4): canvas-size presets shown in the editor toolbar.
 * Picked from real-world product-photo + social-media + label sizes
 * so the user doesn't have to type dimensions for the common cases.
 * Pixel-storage (matches our base unit choice — see v0.22.13 plan).
 */
const CANVAS_PRESETS = [
  { key: 'sq-2000',   label: 'Square 2000 × 2000',        w: 2000, h: 2000 },
  { key: 'sq-1080',   label: 'Square 1080 × 1080 (IG)',    w: 1080, h: 1080 },
  { key: 'story',     label: 'Story 1080 × 1920 (IG/TikTok)', w: 1080, h: 1920 },
  { key: 'photo-4-3', label: 'Photo 4:3 (2000 × 1500)',    w: 2000, h: 1500 },
  { key: 'photo-3-2', label: 'Photo 3:2 (2000 × 1333)',    w: 2000, h: 1333 },
  { key: 'banner',    label: 'Banner 3000 × 1000',         w: 3000, h: 1000 },
  { key: 'wide-fb',   label: 'Wide 1200 × 630 (FB / OG)',  w: 1200, h: 630  },
];
import { useAppStore } from '../../store/index.js';
import { Button, Field, Input, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { defaultElement } from './elementDefaults.js';
import { EditorCanvas } from './EditorCanvas.jsx';
import { Inspector } from './Inspector.jsx';
import { BulkOverlayRunModal } from '../ProductLibrary/BulkOverlayRunModal.jsx';

/**
 * Template editor — the heart of Overlay Studio.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────┐
 *   │  Header strip: name · canvas size · backdrop picker     │
 *   ├──────────────┬─────────────────────────────────────────┤
 *   │   inspector  │   canvas (drag/drop elements)            │
 *   │   sidebar    │                                          │
 *   └──────────────┴─────────────────────────────────────────┘
 *
 * Auto-save: every change debounces to 500ms; the save-status pill in
 * the header surfaces the state. Explicit Save button forces a flush.
 * Per CLAUDE.md §6 (updated 2026-05-20).
 *
 * Backdrop: optional. The user picks a product whose main image is shown
 * behind the elements so they can design in context. With nothing picked,
 * a transparent checkerboard backdrop appears.
 */
export function TemplateEditor({ templateId, onClose, onChanged }) {
  const addToast = useAppStore((s) => s.addToast);
  const products = useAppStore((s) => s.products);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);

  // Local state owns the in-progress template. Loaded from IPC on mount;
  // every change debounces back to disk via `templates:update`.
  const [template, setTemplate] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [backdropProductId, setBackdropProductId] = useState(null);
  const [productImages, setProductImages] = useState([]);
  const [saveStatus, setSaveStatus] = useState({ state: 'idle', lastSavedAt: null });
  // v0.26.15: single-product apply modal. Reuses the same component
  // the Library bulk toolbar opens — when productIds has length 1,
  // the scope toggle just shows "Selected (1)" and skips the filter
  // path. Cleaner than building a parallel modal for one product.
  const [applyOpen, setApplyOpen] = useState(false);
  // v0.24.0 (Phase 2): snap-to-grid toggle. Defaults ON; the user can
  // turn it off if they need pixel-perfect placement against an irregular
  // backdrop. Stored in component state (not localStorage) since the
  // value is editor-session-local — when you close and reopen the editor
  // for a different template, defaulting back to "snap on" is the right
  // help most of the time.
  const [snapToGrid, setSnapToGrid] = useState(true);
  // v0.29.0: "Show bounds" outlines every element's box (not just the
  // selected one) so you can see the whole overlay footprint at once and
  // spot where elements will land on the product — a safe-zone guide.
  const [showBounds, setShowBounds] = useState(false);

  const saveTimer = useRef(null);
  const lastSavedJSON = useRef(null);

  // v0.25.0 (Phase 3): undo/redo history stack + clipboard.
  //
  // History strategy: passive "settle commit". After any template
  // change, wait HISTORY_DEBOUNCE_MS. If no further change happens
  // in that window, push the current state to history. Naturally
  // captures end-of-drag / end-of-keystroke states without needing
  // explicit pointer-up signals from the canvas. The downside is a
  // small commit-delay (~300ms) but Cmd+Z still works the moment a
  // checkpoint lands.
  //
  // History is per-session — closing and reopening the editor resets
  // it. Saved templates obviously persist via the normal save path.
  //
  // Clipboard is also session-local in-memory. Survives across
  // template-editor open/close cycles within the same app launch.
  const HISTORY_DEBOUNCE_MS = 300;
  const HISTORY_LIMIT = 50;
  const [history, setHistory] = useState({ past: [], future: [] });
  const historyTimer = useRef(null);
  const skipNextCommitRef = useRef(false);
  const clipboardRef = useRef(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await window.api.templates.get(templateId);
        if (cancelled) return;
        setTemplate(t);
        lastSavedJSON.current = JSON.stringify(stripEphemeral(t));
        // Auto-pick a backdrop: first product in the company, if any.
        if (products.length > 0) setBackdropProductId(products[0].id);
      } catch (err) {
        if (!cancelled) addToast(err.message, 'error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // When backdrop product changes, fetch its images so the canvas can show
  // image #0 and the inspector's image-source dropdown can resolve previews.
  useEffect(() => {
    if (!backdropProductId) { setProductImages([]); return; }
    window.api.images.listByProduct(backdropProductId)
      .then(setProductImages)
      .catch(() => setProductImages([]));
  }, [backdropProductId]);

  // Build the product context for token-filling in the live preview.
  const backdropProduct = products.find((p) => p.id === backdropProductId) ?? null;
  const productContext = useMemo(() => {
    if (!backdropProduct) return null;
    const brand = backdropProduct.brandId ? brands.find((b) => b.id === backdropProduct.brandId) : null;
    const category = backdropProduct.categoryId ? categories.find((c) => c.id === backdropProduct.categoryId) : null;
    return {
      sku: backdropProduct.sku,
      name: backdropProduct.name,
      brand: brand?.name ?? '',
      brandIcon: brand?.icon ?? null,
      barcode: backdropProduct.barcode,
      colorFinish: backdropProduct.colorFinish,
      category: category?.name ?? '',
      description: backdropProduct.description,
      priceRetail: backdropProduct.priceRetail,
      priceWholesale: backdropProduct.priceWholesale,
      productImages,
    };
  }, [backdropProduct, brands, categories, productImages]);

  const backdropSrc = useMemo(() => {
    if (!productImages.length) return null;
    // Prefer the processed main image so the user designs against the
    // final-looking photo, not the raw shot.
    const main = productImages.find((i) => i.isProcessed && i.processedFilepath) || productImages[0];
    const rel = main?.isProcessed && main.processedFilepath ? main.processedFilepath : main?.filepath;
    if (!rel) return null;
    return `app-image://local/${encodeURIComponent(rel)}`;
  }, [productImages]);

  /* ── change handling ──────────────────────────────────────── */

  // Generic patch dispatcher used by every form. Computes the new template
  // synchronously, kicks off a debounced save. We intentionally bypass
  // React state for the saved-JSON tracking so subsequent renders within
  // the 500ms debounce window don't re-fire saves.
  const updateTemplate = useCallback((mutator) => {
    setTemplate((prev) => {
      if (!prev) return prev;
      const next = typeof mutator === 'function' ? mutator(prev) : mutator;
      scheduleSave(next);
      scheduleHistoryCommit(prev);
      return next;
    });
  }, []);

  // v0.25.0: settle-commit history. Whenever `updateTemplate` fires
  // we (re)start a timer; if no further change in 300ms, snapshot the
  // PREVIOUS state into history.past. That way Cmd+Z restores
  // whatever the template was BEFORE the change ended. Future stack
  // is cleared on any new change (standard "branching invalidates the
  // redo path" semantics).
  function scheduleHistoryCommit(prevState) {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false;
      return;
    }
    if (historyTimer.current) clearTimeout(historyTimer.current);
    historyTimer.current = setTimeout(() => {
      setHistory((h) => {
        // Skip pushing if the most recent past entry is already this
        // shape (e.g. a no-op patch).
        const snapshot = stripEphemeral(prevState);
        const snapJSON = JSON.stringify(snapshot);
        const lastPast = h.past[h.past.length - 1];
        if (lastPast && JSON.stringify(lastPast) === snapJSON) return h;
        const past = [...h.past, snapshot];
        if (past.length > HISTORY_LIMIT) past.shift();
        return { past, future: [] };
      });
    }, HISTORY_DEBOUNCE_MS);
  }

  function undo() {
    if (history.past.length === 0 || !template) return;
    const target = history.past[history.past.length - 1];
    const past = history.past.slice(0, -1);
    const future = [...history.future, stripEphemeral(template)];
    skipNextCommitRef.current = true;  // navigating, not editing — don't recommit
    setHistory({ past, future });
    const restored = { ...template, ...target };
    setTemplate(restored);
    scheduleSave(restored);
  }

  function redo() {
    if (history.future.length === 0 || !template) return;
    const target = history.future[history.future.length - 1];
    const future = history.future.slice(0, -1);
    const past = [...history.past, stripEphemeral(template)];
    skipNextCommitRef.current = true;
    setHistory({ past, future });
    const restored = { ...template, ...target };
    setTemplate(restored);
    scheduleSave(restored);
  }

  // v0.25.0: Cmd+D duplicate / Cmd+C copy / Cmd+V paste.
  function duplicateElement(elementId) {
    if (!template) return null;
    const el = template.elements.find((e) => e.id === elementId);
    if (!el) return null;
    const copy = { ...el, id: `el-${Math.random().toString(36).slice(2, 9)}`,
      // Offset by 0.02 (≈ 2% of canvas) so the copy is visible, not
      // perfectly stacked on the original.
      x: Math.min(1, (el.x ?? 0.5) + 0.02),
      y: Math.min(1, (el.y ?? 0.5) + 0.02),
    };
    updateTemplate((prev) => ({ ...prev, elements: [...prev.elements, copy] }));
    setSelectedId(copy.id);
    return copy.id;
  }

  function copySelected() {
    if (!selectedId || !template) return;
    const el = template.elements.find((e) => e.id === selectedId);
    if (el) clipboardRef.current = el;
  }

  function pasteFromClipboard() {
    const src = clipboardRef.current;
    if (!src || !template) return;
    const copy = { ...src, id: `el-${Math.random().toString(36).slice(2, 9)}`,
      x: Math.min(1, (src.x ?? 0.5) + 0.02),
      y: Math.min(1, (src.y ?? 0.5) + 0.02),
    };
    updateTemplate((prev) => ({ ...prev, elements: [...prev.elements, copy] }));
    setSelectedId(copy.id);
  }

  // v0.27.0: bulk-inset config helpers. `inset` lives on the template
  // ({ enabled, scale, fillMode, fillColor }); editing it goes through
  // updateTemplate so it auto-saves + joins the undo history like any
  // other change.
  function updateInset(patch) {
    updateTemplate((prev) => {
      const base = prev.inset || { enabled: false, scale: 0.85, fillMode: 'color', fillColor: '#FFFFFF' };
      return { ...prev, inset: { ...base, ...patch } };
    });
  }

  async function sampleInsetColor() {
    if (!backdropProductId) {
      addToast('Pick a product in "Preview against" first', 'info');
      return;
    }
    try {
      const hex = await window.api.templates.sampleBgColor(backdropProductId);
      updateInset({ fillMode: 'color', fillColor: hex });
      addToast(`Matched margin to image background ${hex}`, 'success');
    } catch (err) {
      addToast(`Couldn't sample colour: ${err.message}`, 'error');
    }
  }

  function scheduleSave(next) {
    const json = JSON.stringify(stripEphemeral(next));
    if (json === lastSavedJSON.current) return;  // no-op
    setSaveStatus((s) => ({ ...s, state: 'saving' }));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveNow(next, /* showToast */ false);
    }, 500);
  }

  async function saveNow(snapshot, showToast = true) {
    const t = snapshot ?? template;
    if (!t) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const json = JSON.stringify(stripEphemeral(t));
    if (json === lastSavedJSON.current && saveStatus.state !== 'error') {
      if (showToast) addToast('Already saved', 'info');
      return;
    }
    try {
      await window.api.templates.update(t.id, {
        name: t.name,
        description: t.description,
        canvasWidth: t.canvasWidth,
        canvasHeight: t.canvasHeight,
        elements: t.elements,
        inset: t.inset ?? null,
        tags: t.tags,
      });
      lastSavedJSON.current = json;
      setSaveStatus({ state: 'saved', lastSavedAt: Date.now() });
      onChanged?.();
      if (showToast) addToast('Saved', 'success');
    } catch (err) {
      setSaveStatus({ state: 'error', lastSavedAt: null });
      addToast(`Save failed: ${err.message}`, 'error');
    }
  }

  // Tick every 30s so the "X min ago" text in the save indicator refreshes
  // without polling anything else.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  /* ── element ops ──────────────────────────────────────────── */

  function addElement(type) {
    const el = defaultElement(type);
    updateTemplate((prev) => ({ ...prev, elements: [...prev.elements, el] }));
    setSelectedId(el.id);
  }

  function updateElement(id, partial) {
    updateTemplate((prev) => ({
      ...prev,
      elements: prev.elements.map((el) => (el.id === id ? { ...el, ...partial } : el)),
    }));
  }

  async function deleteSelected() {
    if (!selectedId) return;
    const el = template?.elements.find((e) => e.id === selectedId);
    if (!el) return;
    // Skip the confirm dialog for empty elements — common when the user
    // adds one accidentally and immediately wants it gone.
    const isEmpty = !el.content && !el.source;
    const ok = isEmpty ? true : await confirm({
      title: 'Delete this element?',
      message: `Removes the ${el.type} element from the template.`,
      danger: true,
      confirmLabel: 'Delete element',
    });
    if (!ok) return;
    updateTemplate((prev) => ({ ...prev, elements: prev.elements.filter((e) => e.id !== selectedId) }));
    setSelectedId(null);
  }

  // Keyboard shortcuts in the editor:
  //   Delete / Backspace → delete selected element (skipped when typing).
  //   Cmd/Ctrl+Z          → undo
  //   Cmd/Ctrl+Shift+Z    → redo
  //   Cmd/Ctrl+D          → duplicate selected element
  //   Cmd/Ctrl+C          → copy selected element to clipboard
  //   Cmd/Ctrl+V          → paste clipboard element
  // All shortcuts skip when an input/textarea/select has focus so the
  // user can still type, paste text, etc. in the inspector fields.
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        if (selectedId) {
          e.preventDefault();
          duplicateElement(selectedId);
        }
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (selectedId) {
          e.preventDefault();
          copySelected();
        }
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        if (clipboardRef.current) {
          e.preventDefault();
          pasteFromClipboard();
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) { e.preventDefault(); deleteSelected(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /* ── render ──────────────────────────────────────────────── */

  if (!template) {
    return <div className="ovl-editor"><p className="muted" style={{ padding: 'var(--s-4)' }}>Loading template…</p></div>;
  }

  const selectedElement = template.elements.find((e) => e.id === selectedId) ?? null;
  const inset = template.inset || null;
  const insetPct = Math.round((inset?.scale ?? 0.85) * 100);
  const insetIsWhite = (inset?.fillColor || '').toUpperCase() === '#FFFFFF';

  return (
    <div className="ovl-editor">
      <header className="ovl-editor__head">
        <div className="ovl-editor__head-left">
          <Field label="Template name">
            {({ id }) => (
              <Input
                id={id}
                value={template.name}
                onChange={(e) => updateTemplate({ ...template, name: e.target.value })}
                placeholder="Untitled template"
              />
            )}
          </Field>
          <div className="ovl-editor__size">
            <Field label="Canvas W">
              {({ id }) => (
                <CanvasDimensionInput
                  id={id}
                  label="width"
                  value={template.canvasWidth}
                  otherDim={template.canvasHeight}
                  onCommit={(next) => updateTemplate({ ...template, canvasWidth: next })}
                />
              )}
            </Field>
            <Field label="Canvas H">
              {({ id }) => (
                <CanvasDimensionInput
                  id={id}
                  label="height"
                  value={template.canvasHeight}
                  otherDim={template.canvasWidth}
                  onCommit={(next) => updateTemplate({ ...template, canvasHeight: next })}
                />
              )}
            </Field>
          </div>
        </div>

        <div className="ovl-editor__head-right">
          <SaveStatus status={saveStatus} />
          {/* v0.26.15: single-product apply. Renders the template against
              whichever product the user has in "Preview against" (the
              dropdown below this header), routes the output per the
              destination radio in the modal. Disabled until a product is
              chosen so the user gets a tooltip instead of a silent no-op. */}
          <Button
            onClick={() => setApplyOpen(true)}
            disabled={!backdropProductId}
            title={backdropProductId
              ? 'Render this template against the previewed product and save the result.'
              : 'Pick a product in "Preview against" below to enable Apply.'}
          >Apply…</Button>
          <Button onClick={() => saveNow()} disabled={saveStatus.state === 'saving'}>
            {saveStatus.state === 'saving' ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </header>

      <div className="ovl-editor__toolbar">
        <div className="ws-toolbar__group">
          <button type="button" className="segment" onClick={() => addElement('text')}>+ Text</button>
          <button type="button" className="segment" onClick={() => addElement('barcode')}>+ Barcode</button>
          <button type="button" className="segment" onClick={() => addElement('image')}>+ Image</button>
        </div>
        {/* v0.25.0 (Phase 3): undo / redo / duplicate. Keyboard works
            everywhere via Cmd+Z / Cmd+Shift+Z / Cmd+D; these buttons
            make the affordance discoverable for users who don't know
            the shortcuts. */}
        <div className="ws-toolbar__group">
          <button
            type="button"
            className="segment"
            onClick={undo}
            disabled={history.past.length === 0}
            title="Undo last change (Cmd+Z)"
          >↶ Undo</button>
          <button
            type="button"
            className="segment"
            onClick={redo}
            disabled={history.future.length === 0}
            title="Redo (Cmd+Shift+Z)"
          >↷ Redo</button>
          <button
            type="button"
            className="segment"
            onClick={() => selectedId && duplicateElement(selectedId)}
            disabled={!selectedId}
            title="Duplicate selected element (Cmd+D)"
          >⎘ Duplicate</button>
        </div>
        {/* v0.26.0 (Phase 4): canvas size presets. Picking a preset
            opens the same confirm modal we use for manual W/H edits
            (from v0.22.17) so the user is warned about off-canvas
            elements before the resize lands. */}
        <div className="ws-toolbar__group">
          <Select
            value=""
            onChange={async (e) => {
              const key = e.target.value;
              if (!key) return;
              const preset = CANVAS_PRESETS.find((p) => p.key === key);
              if (!preset) return;
              // Reset the select back to placeholder so picking the
              // same preset twice still triggers a change event.
              e.target.value = '';
              if (preset.w === template.canvasWidth && preset.h === template.canvasHeight) return;
              const ok = await confirm({
                title: `Resize canvas to ${preset.w}×${preset.h}?`,
                message: `Current size is ${template.canvasWidth} × ${template.canvasHeight} px. New size will be ${preset.w} × ${preset.h} px.`,
                detail: 'Existing elements keep their x/y positions. Anything beyond the new canvas edge will be off-screen (still in the template, just clipped). You can drag them back into view after.',
                confirmLabel: 'Resize',
              });
              if (ok) {
                updateTemplate({ ...template, canvasWidth: preset.w, canvasHeight: preset.h });
              }
            }}
            title="Pre-configured canvas sizes"
          >
            <option value="">Presets…</option>
            {CANVAS_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </Select>
        </div>
        {/* v0.24.0 (Phase 2): Snap toggle. Drives both grid-snap during
            drag and the visible grid background on the canvas. Smart
            guides (snap-to-other-elements) always run regardless — they
            don't get a toggle because they only fire when within
            5px of another element's edge, so they don't get in the way. */}
        <div className="ws-toolbar__group">
          <button
            type="button"
            className={`segment${snapToGrid ? ' is-active' : ''}`}
            onClick={() => setSnapToGrid((v) => !v)}
            aria-pressed={snapToGrid}
            title="Snap dragged elements to an 8px grid. Smart-guide alignment to other elements is always on."
          >
            {snapToGrid ? '⊞ Snap on' : '⊞ Snap off'}
          </button>
          <button
            type="button"
            className={`segment${showBounds ? ' is-active' : ''}`}
            onClick={() => setShowBounds((v) => !v)}
            aria-pressed={showBounds}
            title="Outline every element's box so you can see the whole overlay footprint and spot collisions with the product."
          >
            {showBounds ? '⧉ Bounds on' : '⧉ Bounds off'}
          </button>
        </div>
        {/* v0.27.0: bulk inset. Shrinks the base image to leave a safe
            margin so overlay elements (logo, SKU) never collide with a
            tightly-framed product. Applies to EVERY image at apply time;
            per-image touch-ups come later in the Reframe tab. The canvas
            preview reflects this live. */}
        <div className="ws-toolbar__group ovl-inset-controls">
          <button
            type="button"
            className={`segment${inset?.enabled ? ' is-active' : ''}`}
            onClick={() => updateInset({ enabled: !(inset?.enabled) })}
            aria-pressed={!!inset?.enabled}
            title="Shrink the base image to leave a safe margin for the overlay. Applied to every image when you Apply this template."
          >
            {inset?.enabled ? '⤢ Inset on' : '⤢ Inset off'}
          </button>
          {inset?.enabled && (
            <>
              <label className="ovl-inset-pct" title="Product size as a percentage of the canvas. Lower = more margin.">
                <input
                  type="range"
                  min="40"
                  max="100"
                  step="1"
                  value={insetPct}
                  onChange={(e) => updateInset({ scale: Number(e.target.value) / 100 })}
                />
                <span className="muted">{insetPct}%</span>
              </label>
              <div className="ws-toolbar__group">
                <button
                  type="button"
                  className={`segment${inset.fillMode === 'blur' ? ' is-active' : ''}`}
                  onClick={() => updateInset({ fillMode: 'blur' })}
                  title="Fill the margin with a blurred copy of the image — best for lifestyle / scene shots so there's no hard border."
                >Blur</button>
                <button
                  type="button"
                  className={`segment${inset.fillMode === 'color' && insetIsWhite ? ' is-active' : ''}`}
                  onClick={() => updateInset({ fillMode: 'color', fillColor: '#FFFFFF' })}
                  title="Fill the margin with solid white (classic catalog look)."
                >White</button>
                <button
                  type="button"
                  className={`segment${inset.fillMode === 'color' && !insetIsWhite ? ' is-active' : ''}`}
                  onClick={() => updateInset({ fillMode: 'color', fillColor: insetIsWhite ? '#F2F2F2' : (inset.fillColor || '#F2F2F2') })}
                  title="Fill the margin with a custom colour."
                >Colour</button>
              </div>
              {inset.fillMode === 'color' && (
                <input
                  type="color"
                  className="ovl-inset-swatch"
                  value={expandHex(inset.fillColor || '#FFFFFF')}
                  onChange={(e) => updateInset({ fillColor: e.target.value.toUpperCase() })}
                  title="Margin fill colour"
                  aria-label="Margin fill colour"
                />
              )}
              <button
                type="button"
                className="segment"
                onClick={sampleInsetColor}
                disabled={!backdropProductId}
                title="Sample the previewed image's background colour and use it as the margin fill — makes the seam invisible on white-background shots."
              >⦿ Match bg</button>
            </>
          )}
        </div>
        <div className="ovl-editor__backdrop-picker">
          <span className="muted">Preview against</span>
          <Select
            value={backdropProductId ?? ''}
            onChange={(e) => setBackdropProductId(e.target.value || null)}
          >
            <option value="">— Empty canvas —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.sku}{p.name ? ` · ${p.name}` : ''}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="ovl-editor__body">
        {/* v0.26.1: split the left column into Inspector (top, for the
            selected element's properties) + Layers panel (bottom, for
            element list + reorder + visibility / lock toggles). The
            Layers panel is always visible so users can navigate the
            element stack even when nothing is selected. */}
        <div className="ovl-editor__left">
          <Inspector
            element={selectedElement}
            onChange={(patch) => updateElement(selectedElement.id, patch)}
            onDelete={deleteSelected}
          />
          <LayersPanel
            elements={template.elements}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={updateElement}
            onReorder={(id, dir) => {
              updateTemplate((prev) => {
                const idx = prev.elements.findIndex((e) => e.id === id);
                if (idx === -1) return prev;
                const swap = dir === 'up' ? idx + 1 : idx - 1;
                if (swap < 0 || swap >= prev.elements.length) return prev;
                const next = [...prev.elements];
                [next[idx], next[swap]] = [next[swap], next[idx]];
                return { ...prev, elements: next };
              });
            }}
            onDelete={(id) => {
              if (selectedId === id) setSelectedId(null);
              updateTemplate((prev) => ({ ...prev, elements: prev.elements.filter((e) => e.id !== id) }));
            }}
          />
        </div>
        <EditorCanvas
          template={template}
          selectedId={selectedId}
          onSelectElement={setSelectedId}
          onChangeElement={updateElement}
          backdropSrc={backdropSrc}
          productContext={productContext}
          snapToGrid={snapToGrid}
          showBounds={showBounds}
        />
      </div>

      {/* v0.26.15: single-product apply modal — reuses the Library
          bulk modal with a 1-element productIds array. Scope toggle
          will show "Selected (1)"; the user can still flip to
          "Current filter" if they want to fan out from here. */}
      <BulkOverlayRunModal
        open={applyOpen}
        productIds={backdropProductId ? [backdropProductId] : []}
        filters={null}
        onClose={() => setApplyOpen(false)}
        onDone={() => setApplyOpen(false)}
      />
    </div>
  );
}

/**
 * v0.26.1: Layers panel — modeled on label-studio-kh's left-sidebar
 * Layers section. Shows every element in the template, top-to-bottom
 * in REVERSE z-index order so the visually-topmost (last in array)
 * sits at the top of the list (Photoshop / Figma convention).
 *
 * Per-row controls:
 *   - Click row name → select
 *   - 👁 eye toggle  → flip element.visible
 *   - 🔒 lock toggle → flip element.locked
 *   - ↑ / ↓ arrows  → swap with neighbor in elements array (moves
 *     the layer forward / backward in the render order)
 *   - × delete      → drop the element entirely (no confirm — the
 *     row already has an explicit delete affordance separate from
 *     the canvas Delete-key flow, which DOES have a confirm)
 */
function LayersPanel({ elements, selectedId, onSelect, onChange, onReorder, onDelete }) {
  // The elements array is rendered bottom-up (later items composite
  // ON TOP of earlier items). The Layers list shows topmost FIRST so
  // we iterate in reverse for display, but the up/down arrows still
  // refer to "up = visually higher = later in array".
  const rows = [...elements].map((el, arrIdx) => ({ el, arrIdx })).reverse();
  return (
    <section className="ovl-layers">
      <h3 className="ovl-layers__title">LAYERS</h3>
      {elements.length === 0 ? (
        <p className="ovl-layers__empty muted">
          No elements yet. Use the + Text / + Barcode / + Image buttons in the toolbar to add one.
        </p>
      ) : (
        <ul className="ovl-layers__list">
          {rows.map(({ el, arrIdx }) => {
            const isSelected = el.id === selectedId;
            const isHidden = el.visible === false;
            const isLocked = el.locked === true;
            const isTop = arrIdx === elements.length - 1;
            const isBottom = arrIdx === 0;
            return (
              <li
                key={el.id}
                className={`ovl-layer${isSelected ? ' is-selected' : ''}${isHidden ? ' is-hidden' : ''}${isLocked ? ' is-locked' : ''}`}
              >
                <button
                  type="button"
                  className="ovl-layer__name"
                  onClick={() => onSelect(el.id)}
                  title="Select layer"
                >
                  <span className="ovl-layer__name-label">{layerLabel(el)}</span>
                  <span className="ovl-layer__name-sub">{el.type}</span>
                </button>
                <button
                  type="button"
                  className={`ovl-layer__icon${isHidden ? ' is-off' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onChange(el.id, { visible: isHidden }); }}
                  title={isHidden ? 'Show layer' : 'Hide layer'}
                  aria-label={isHidden ? 'Show layer' : 'Hide layer'}
                >{isHidden ? '◌' : '●'}</button>
                <button
                  type="button"
                  className={`ovl-layer__icon${isLocked ? ' is-on' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onChange(el.id, { locked: !isLocked }); }}
                  title={isLocked ? 'Unlock layer' : 'Lock layer'}
                  aria-label={isLocked ? 'Unlock layer' : 'Lock layer'}
                >{isLocked ? '🔒' : '🔓'}</button>
                <button
                  type="button"
                  className="ovl-layer__icon"
                  onClick={(e) => { e.stopPropagation(); onReorder(el.id, 'up'); }}
                  disabled={isTop}
                  title="Move layer up (forward in stack)"
                  aria-label="Move up"
                >↑</button>
                <button
                  type="button"
                  className="ovl-layer__icon"
                  onClick={(e) => { e.stopPropagation(); onReorder(el.id, 'down'); }}
                  disabled={isBottom}
                  title="Move layer down (backward in stack)"
                  aria-label="Move down"
                >↓</button>
                <button
                  type="button"
                  className="ovl-layer__icon ovl-layer__icon--danger"
                  onClick={(e) => { e.stopPropagation(); onDelete(el.id); }}
                  title="Delete layer"
                  aria-label="Delete layer"
                >×</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Friendly label for a layer row. Text elements show their content
 *  (or token like {sku}); barcodes show "Barcode" + content; images
 *  show their source. Truncates long content. */
function layerLabel(el) {
  if (el.type === 'text') {
    const c = (el.content ?? '').trim();
    if (!c) return 'Text';
    return c.length > 24 ? c.slice(0, 22) + '…' : c;
  }
  if (el.type === 'barcode') {
    const c = (el.content ?? '').trim();
    return c ? `Barcode · ${c.length > 16 ? c.slice(0, 14) + '…' : c}` : 'Barcode';
  }
  if (el.type === 'image') {
    if (el.source === 'brand-icon') return 'Image · brand icon';
    if (el.source?.startsWith('product-image:')) return `Image · #${el.source.split(':')[1] ?? '0'}`;
    if (el.source?.startsWith('asset:')) {
      const rel = el.source.slice(6);
      return `Image · ${rel.length > 20 ? '…' + rel.slice(-18) : rel}`;
    }
    return 'Image';
  }
  return el.type;
}

/** Subset of the template that drives the save-equality check. Excludes
 *  ephemeral fields (timestamps) so the comparison doesn't ping-pong. */
/**
 * v0.22.17: dedicated input for Canvas W / Canvas H.
 *
 * Solves two problems with the old `<Input type="number">` direct-bind:
 *
 *   (1) Clamp-on-every-keystroke. The original onChange ran
 *       `Math.max(64, Math.min(8192, Number(e.target.value) || 0))`
 *       on every keystroke. Selecting all + Backspace gave
 *       `Number('') = NaN`, fell back to `|| 0`, then `Math.max(64, 0)`
 *       snapped the field to 64 — meaning you couldn't actually clear
 *       the input to retype it from scratch. You had to character-
 *       delete one digit at a time, which is the kind of thing you
 *       blame on a haunted Mac, not on app code.
 *
 *   (2) Live canvas resize on every keystroke. Typing "1024" did four
 *       resizes (1 → 10 → 102 → 1024), each one potentially pushing
 *       elements off the new canvas. No warning, no undo, no chance
 *       to back out.
 *
 * Now the field holds its own draft state until you blur or press
 * Enter. On commit it validates against the 64..8192 range, then
 * opens a confirm modal before actually mutating the template. Esc
 * reverts to the original value without committing.
 *
 * Empty string commits as "don't change" (treated like Esc); we never
 * silently store 64 just because the field is blank.
 */
function CanvasDimensionInput({ id, label, value, otherDim, onCommit }) {
  // Local draft = what's currently in the input. Seeded from the
  // template value; updates ONLY on commit (or external value change
  // from another source, e.g. an Undo).
  const [draft, setDraft] = useState(String(value ?? ''));
  // Track whether we've got an in-flight commit (the confirm modal is
  // open) so the value-sync effect below doesn't fight the user.
  const committingRef = useRef(false);

  // Keep the draft in sync with external changes (template loaded /
  // undo / reset) — but only when we're not in the middle of a commit.
  useEffect(() => {
    if (committingRef.current) return;
    setDraft(String(value ?? ''));
  }, [value]);

  async function commitDraft() {
    const raw = draft.trim();
    if (raw === '') {
      // Empty = the user cleared and didn't type anything else. Treat
      // as a cancel — restore the template's current value.
      setDraft(String(value ?? ''));
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
      setDraft(String(value ?? ''));
      return;
    }
    const clamped = Math.max(64, Math.min(8192, Math.round(parsed)));
    if (clamped !== parsed) {
      // Reflect the clamp back to the input so the user sees what
      // they actually committed (e.g. typed 10000 → shows 8192).
      setDraft(String(clamped));
    }
    if (clamped === value) {
      // No-op; don't bother prompting.
      return;
    }
    committingRef.current = true;
    try {
      const ok = await confirm({
        title: `Resize canvas ${label} to ${clamped}px?`,
        message: `Current size is ${otherDim} × ${value} px. New size will be ${
          label === 'width' ? `${clamped} × ${otherDim}` : `${otherDim} × ${clamped}`
        } px.`,
        detail:
          'Existing text, barcode, and image elements stay at their current ' +
          'x/y positions. Anything beyond the new canvas edge will be off-screen ' +
          '(still in the template, just clipped in the preview). You can drag ' +
          'them back into view after the resize.',
        confirmLabel: 'Resize canvas',
      });
      if (ok) {
        onCommit(clamped);
      } else {
        // Cancelled — restore the field to the (unchanged) template value.
        setDraft(String(value ?? ''));
      }
    } finally {
      committingRef.current = false;
    }
  }

  return (
    <Input
      id={id}
      type="number"
      min="64"
      max="8192"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitDraft}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();   // triggers commitDraft via onBlur
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(String(value ?? ''));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function stripEphemeral(t) {
  if (!t) return null;
  return {
    name: t.name,
    description: t.description,
    canvasWidth: t.canvasWidth,
    canvasHeight: t.canvasHeight,
    elements: t.elements,
    // v0.27.0: inset must be in the saved/compared shape, otherwise an
    // inset-only change looks like a no-op (no save) and undo/redo can't
    // capture it.
    inset: t.inset ?? null,
    tags: t.tags,
  };
}

/** Expand #RGB → #RRGGBB so <input type="color"> (which requires the
 *  6-digit form) shows the right swatch. Anything invalid falls back to
 *  white. */
function expandHex(hex) {
  const s = String(hex || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toUpperCase();
  }
  return '#FFFFFF';
}

function SaveStatus({ status }) {
  if (status.state === 'saving') return <span className="ws-save ws-save--amber">Saving…</span>;
  if (status.state === 'error')  return <span className="ws-save ws-save--rose">● Save failed</span>;
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
