/**
 * v0.26.15: BulkOverlayRunModal — Overlay Studio's "apply template
 * to many products" surface, mirrored from BulkProductsAIRunModal.
 *
 * Three scopes (radio):
 *   - "Selected (N)"        — uses the productIds the caller passed in
 *   - "Current filter (M)"  — uses the Library's live filter via a
 *                             dry-run lookup on the backend so the
 *                             user sees the matched count BEFORE
 *                             committing. Showing the count is the
 *                             safety guard for "oops, fired on 800
 *                             products instead of 8".
 *
 * Three destinations (radio):
 *   - Append as new image — keeps the original, adds render at end
 *   - Replace main         — appends then setMain (non-destructive,
 *                            original demotes to position 1)
 *   - Save to folder       — writes the render to a folder on disk,
 *                            doesn't touch the product
 *
 * Calls `window.api.templates.applyBulk` or `applyByFilter`
 * depending on scope. Sync — blocks the modal until done (sharp
 * compose is fast, ~100-300ms/render, so 50 products = ~10s).
 */

import { useEffect, useState } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

export function BulkOverlayRunModal({ open, productIds, filters, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [scope, setScope] = useState('selection'); // 'selection' | 'filter'
  // v0.49.44: `appendAsMain` replaces `replaceMain` as the user-facing
  // choice for "render becomes main, original kept at position 1". The
  // backend accepts both kinds (alias), so any saved presets / older
  // sessions that hold `replaceMain` keep working.
  const [destination, setDestination] = useState('append'); // 'append' | 'appendAsMain' | 'overwrite' | 'saveToFolder'
  const [folder, setFolder] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // v0.49.52: which images of each product to overlay. 'main' = just the
  // main image (original behaviour); 'all' = every image of each product.
  const [imageScope, setImageScope] = useState('main'); // 'main' | 'all'

  // When the user picks "Current filter", we ask the backend for
  // the match count via dryRun so the confirm button shows
  // "Apply to 47 products" rather than a vague "Apply".
  const [filterMatch, setFilterMatch] = useState(null); // { matchedCount, sampleSkus } | null

  // v0.26.41 (audit pass): the dep array is intentionally `[open]`
  // only. Effect references `templateId` and `addToast` too, but:
  //   - `templateId` is local state we're about to reset; including
  //     it would cause the effect to re-fire when the user picks a
  //     different template, which would re-fetch the templates list
  //     and reset their scope choice — wrong behavior.
  //   - `addToast` is a stable zustand selector ref, but ESLint can't
  //     prove that; adding it has no functional cost but creates a
  //     misleading "the modal re-init depends on addToast" signal.
  // The disable is documented; the behavior we want is "reset state
  // whenever the modal opens, nothing else."
  useEffect(() => {
    if (!open) return;
    window.api.templates.list().then((rows) => {
      setTemplates(rows);
      if (rows.length > 0 && !templateId) setTemplateId(rows[0].id);
    }).catch((err) => addToast(err.message, 'error'));
    setScope('selection');
    setImageScope('main');
    setFilterMatch(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dry-run lookup whenever the user picks "Current filter" so the
  // count is fresh. Also re-runs if the template changes (currently
  // the count doesn't depend on template but keeps the contract
  // honest if we ever filter eligibility per template).
  useEffect(() => {
    if (!open || scope !== 'filter' || !templateId) { setFilterMatch(null); return; }
    let cancelled = false;
    window.api.templates.applyByFilter({
      templateId,
      filters: filters ?? {},
      destination: { kind: 'append' }, // placeholder; ignored in dryRun
      dryRun: true,
    }).then((res) => { if (!cancelled) setFilterMatch(res); })
      .catch((err) => { if (!cancelled) addToast(err.message, 'error'); });
    return () => { cancelled = true; };
  }, [open, scope, templateId, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectionCount = productIds?.length ?? 0;
  const filterCount    = filterMatch?.matchedCount ?? 0;
  const finalCount     = scope === 'selection' ? selectionCount : filterCount;

  async function handlePickFolder() {
    try {
      const f = await window.api.files.pickFolder();
      if (f) setFolder(f);
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function handleSubmit() {
    if (!templateId) { addToast('Pick a template first', 'error'); return; }
    if (destination === 'saveToFolder' && !folder) {
      addToast('Pick a folder to save into', 'error');
      return;
    }
    if (finalCount === 0) {
      addToast('No products match', 'info');
      return;
    }
    const dest = destination === 'saveToFolder'
      ? { kind: 'saveToFolder', folder }
      : { kind: destination };
    setSubmitting(true);
    try {
      let res;
      if (scope === 'selection') {
        res = await window.api.templates.applyBulk({
          templateId, productIds, destination: dest, scope: imageScope,
        });
      } else {
        res = await window.api.templates.applyByFilter({
          templateId, filters: filters ?? {}, destination: dest, scope: imageScope,
        });
      }
      const done = res?.done?.length ?? 0;
      const failed = res?.failed?.length ?? 0;
      const skipped = res?.skipped?.length ?? 0;
      const total = res?.total ?? finalCount;
      if (failed + skipped === 0) {
        addToast(`Applied template to ${done} product${done === 1 ? '' : 's'}`, 'success');
      } else {
        addToast(`Applied ${done} of ${total} — ${skipped} skipped, ${failed} failed`, failed > 0 ? 'error' : 'info');
      }
      // Refresh Library so new images are reflected in thumbs / counts.
      if (destination !== 'saveToFolder') refreshProducts();
      onDone?.(res);
      onClose?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <Modal open={open} title="Overlay Studio · apply template" onClose={onClose}>
      <div className="bulk-overlay-run">
        <p className="bulk-overlay-run__intro">
          Render an Overlay Studio template against products and route the result.
          Source image used is each product&rsquo;s main image (processed wins over raw).
        </p>

        <Field label="Template" required>
          {({ id }) => (
            <Select id={id} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.length === 0 ? <option value="">— No templates available —</option> : null}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.canvasWidth ? ` · ${t.canvasWidth}×${t.canvasHeight}` : ''}</option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset className="bulk-overlay-run__group">
          <legend>Scope</legend>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-scope"
              checked={scope === 'selection'}
              onChange={() => setScope('selection')}
              disabled={selectionCount === 0}
            />
            <span>
              <strong>Selected ({selectionCount})</strong>
              {selectionCount === 0 ? <span className="muted"> — none selected</span> : null}
            </span>
          </label>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-scope"
              checked={scope === 'filter'}
              onChange={() => setScope('filter')}
            />
            <span>
              <strong>Current Library filter ({filterCount})</strong>
              {filterMatch?.sampleSkus?.length ? (
                <span className="muted"> — e.g. {filterMatch.sampleSkus.join(', ')}{filterMatch.matchedCount > filterMatch.sampleSkus.length ? '…' : ''}</span>
              ) : null}
            </span>
          </label>
        </fieldset>

        {/* v0.49.52: which images of each product to overlay. */}
        <fieldset className="bulk-overlay-run__group">
          <legend>Apply to which images</legend>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-image-scope"
              checked={imageScope === 'main'}
              onChange={() => setImageScope('main')}
            />
            <span>
              <strong>Main image only</strong>
              <span className="muted"> — overlay just the product&rsquo;s main image</span>
            </span>
          </label>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-image-scope"
              checked={imageScope === 'all'}
              onChange={() => setImageScope('all')}
            />
            <span>
              <strong>All images of each product</strong>
              <span className="muted"> — overlay every image, not just the main one</span>
            </span>
          </label>
        </fieldset>

        <fieldset className="bulk-overlay-run__group">
          <legend>Destination</legend>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'append'}
              onChange={() => setDestination('append')}
            />
            <span>
              <strong>Append as new image{imageScope === 'all' ? '(s)' : ''}</strong>
              <span className="muted"> — original images untouched, {imageScope === 'all' ? 'an overlaid copy added per image' : 'render added to end'}</span>
            </span>
          </label>
          {/* v0.49.44: renamed from "Replace main" because that label
              sounded destructive. The behaviour was always to append
              the render then promote it to main, with the original
              kept at position 1 — nothing is deleted. New label says
              that plainly. Backend still accepts `replaceMain` as a
              kind alias for backward compat. */}
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'appendAsMain' || destination === 'replaceMain'}
              onChange={() => setDestination('appendAsMain')}
            />
            <span>
              <strong>Append as main image</strong>
              <span className="muted"> — render becomes position 0 (the main), original demotes to position 1 (kept, not deleted)</span>
            </span>
          </label>
          {/* v0.49.52: stamp the overlay onto the image file itself. The
              natural choice when applying to all images (e.g. watermark
              every photo). Destructive — no undo. */}
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'overwrite'}
              onChange={() => setDestination('overwrite')}
            />
            <span>
              <strong>Overwrite each image in place</strong>
              <span className="muted"> — stamp the overlay onto the image file{imageScope === 'all' ? 's' : ''}. Destructive: replaces the original, no undo.</span>
            </span>
          </label>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'saveToFolder'}
              onChange={() => setDestination('saveToFolder')}
            />
            <span>
              <strong>Save to folder only</strong>
              <span className="muted"> — write to disk, don&rsquo;t change the product&rsquo;s images</span>
            </span>
          </label>
          {destination === 'saveToFolder' ? (
            <div className="bulk-overlay-run__folder">
              <Button onClick={handlePickFolder} disabled={submitting}>Pick folder…</Button>
              <span className="bulk-overlay-run__folder-path">{folder || <em className="muted">(no folder picked)</em>}</span>
            </div>
          ) : null}
        </fieldset>

        <footer className="bulk-overlay-run__footer">
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            disabled={submitting || !templateId || finalCount === 0 || (destination === 'saveToFolder' && !folder)}
            onClick={handleSubmit}
          >
            {submitting
              ? 'Applying…'
              : `Apply to ${finalCount} product${finalCount === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
