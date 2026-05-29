/**
 * v0.22.0: BulkProductsAIRunModal — fire one AI Studio task per
 * selected product, using each product's main image as the
 * source. With optional "auto-promote first variant as main",
 * the renderer doesn't have to click Promote N times after.
 *
 * Triggered from the Library's bulk-select toolbar ("AI Studio
 * →") and from the AI Studio "By products" tab.
 *
 * Skips logic lives server-side: products with no main image or
 * the wrong company surface as `skipped: [{productId, sku, error}]`
 * in the result. We show a one-line summary in a toast after
 * queueing — detailed list lives in AI Studio's queue.
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Field, Select, Textarea } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

export function BulkProductsAIRunModal({ open, productIds, onClose, onDone }) {
  const aiModels = useAppStore((s) => s.aiModels);
  const aiPrompts = useAppStore((s) => s.aiPrompts);
  const refreshAiPrompts = useAppStore((s) => s.refreshAiPrompts);
  const refreshAiModels = useAppStore((s) => s.refreshAiModels);
  const refreshAiTasks = useAppStore((s) => s.refreshAiTasks);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const addToast = useAppStore((s) => s.addToast);

  // Persist the last picked model so the user doesn't reselect
  // every time. Falls back to the store's currently-active model
  // selection (which the per-product AI Studio also reads).
  const persistedModel = useAppStore((s) => s.aiSelectedModelKey);

  const [modelKey, setModelKey] = useState(persistedModel || '');
  const [promptText, setPromptText] = useState('');
  const [promptTemplateId, setPromptTemplateId] = useState('');
  const [autoPromoteAsMain, setAutoPromoteAsMain] = useState(true);
  const [nVariants, setNVariants] = useState(1);
  const [size, setSize] = useState('1:1');
  const [submitting, setSubmitting] = useState(false);

  // Load model + prompt catalogs on first open.
  useEffect(() => {
    if (!open) return;
    if (!aiModels || aiModels.length === 0) refreshAiModels?.();
    refreshAiPrompts?.();
  }, [open, aiModels, refreshAiModels, refreshAiPrompts]);

  // Re-sync the model selection when the persisted one changes
  // outside this component (e.g. user picked one in AI Studio).
  useEffect(() => {
    if (open && persistedModel && !modelKey) setModelKey(persistedModel);
  }, [open, persistedModel, modelKey]);

  // Cost estimate is a rough multiplier: per-task × N tasks.
  const selectedModel = useMemo(
    () => (aiModels || []).find((m) => m.key === modelKey) ?? null,
    [aiModels, modelKey],
  );
  const estimatedCostUsd = useMemo(() => {
    if (!selectedModel?.pricing?.perOutputUsd) return null;
    return (selectedModel.pricing.perOutputUsd * nVariants * (productIds?.length ?? 0)).toFixed(2);
  }, [selectedModel, nVariants, productIds]);

  function pickTemplate(id) {
    setPromptTemplateId(id);
    if (!id) return;
    const t = aiPrompts.find((p) => p.id === id);
    // v0.26.10: the DB column / API field is `body` (see
    // main/db/aiPrompts.js → rowToTemplate). This modal used to read
    // `t.template`, which never existed, so picking a preset silently
    // left the textarea empty. AI Studio's main module reads `p.body`
    // everywhere — this is the one outlier path.
    if (t?.body) setPromptText(t.body);
  }

  async function handleSubmit() {
    const trimmed = promptText.trim();
    if (!trimmed) { addToast('Prompt is required.', 'error'); return; }
    if (!modelKey) { addToast('Pick a model first.', 'error'); return; }
    if (!productIds || productIds.length === 0) {
      addToast('No products selected.', 'error');
      return;
    }
    // v0.26.11: send the FULL model key (e.g. `kie:gpt-image-2-image-to-image`)
    // as `model`, with `provider` derived alongside. The queue runner looks
    // up the model catalog via `byKey(task.model)` — and the model catalog
    // uses the prefixed form as its primary key (see main/ai/models.js).
    // Earlier versions of this modal split the key and sent only the tail
    // (`gpt-image-2-image-to-image`), which made the runner reject every
    // queued task as "Unknown model …". The per-product AI Studio path was
    // never affected because it sends `model: selectedModel.key` directly.
    const provider = selectedModel?.provider ?? modelKey.split(':')[0];
    const fullModelKey = selectedModel?.key ?? modelKey;
    setSubmitting(true);
    try {
      const res = await window.api.ai.queueBulkForProducts({
        productIds,
        provider,
        model: fullModelKey,
        prompt: trimmed,
        options: { size, nVariants, numImages: nVariants },
        promptTemplateId: promptTemplateId || null,
        autoPromoteAsMain,
      });
      const skippedCount = res?.skipped?.length ?? 0;
      const queuedCount = res?.queued ?? 0;
      if (queuedCount === 0) {
        addToast(`No tasks queued. ${skippedCount} skipped (no main image?).`, 'info');
      } else if (skippedCount === 0) {
        addToast(`Queued ${queuedCount} task${queuedCount === 1 ? '' : 's'}. ${autoPromoteAsMain ? 'Results will auto-promote as main image.' : 'Promote manually from the gallery when ready.'}`, 'success');
      } else {
        addToast(`Queued ${queuedCount} of ${productIds.length} — ${skippedCount} skipped (no main image or other).`, 'info');
      }
      refreshAiTasks?.();
      onDone?.(res);
      onClose?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;
  const count = productIds?.length ?? 0;

  return (
    <Modal
      open={open}
      title={`AI Studio · ${count} product${count === 1 ? '' : 's'}`}
      onClose={onClose}
    >
      <div className="bulk-ai-run">
        <p className="bulk-ai-run__intro">
          Queue one AI task per selected product. Each task uses the product&rsquo;s main
          image as the source. Results appear in AI Studio&rsquo;s gallery as they finish.
        </p>

        <Field label="Prompt template (optional)">
          {({ id }) => (
            <Select
              id={id}
              value={promptTemplateId}
              onChange={(e) => pickTemplate(e.target.value)}
            >
              <option value="">— Start from blank —</option>
              {(aiPrompts || []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Prompt" required>
          {({ id }) => (
            <Textarea
              id={id}
              rows={5}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="Describe what you want the AI to do with each product's main image…"
            />
          )}
        </Field>

        <div className="bulk-ai-run__grid">
          <Field label="Model" required>
            {({ id }) => (
              <Select
                id={id}
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value)}
              >
                <option value="">— Pick a model —</option>
                {(aiModels || []).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label || m.key}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Variants per product">
            {({ id }) => (
              <Select
                id={id}
                value={String(nVariants)}
                onChange={(e) => setNVariants(Number(e.target.value))}
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </Select>
            )}
          </Field>

          <Field label="Aspect ratio">
            {({ id }) => (
              <Select id={id} value={size} onChange={(e) => setSize(e.target.value)}>
                <option value="1:1">1:1 (square)</option>
                <option value="3:4">3:4 (portrait)</option>
                <option value="4:3">4:3 (landscape)</option>
                <option value="16:9">16:9 (wide)</option>
                <option value="9:16">9:16 (tall)</option>
              </Select>
            )}
          </Field>
        </div>

        <label className="bulk-ai-run__toggle">
          <input
            type="checkbox"
            checked={autoPromoteAsMain}
            onChange={(e) => setAutoPromoteAsMain(e.target.checked)}
          />
          <span>
            <strong>Auto-promote first variant as main image.</strong> When a task
            finishes, the first successful result is immediately set as the
            product&rsquo;s main image. Other variants stay in the gallery as alternates.
          </span>
        </label>

        {estimatedCostUsd != null ? (
          <div className="bulk-ai-run__cost">
            Estimated cost: <strong>${estimatedCostUsd}</strong>
            {' '}({nVariants} × {count} variant{nVariants * count === 1 ? '' : 's'})
          </div>
        ) : null}

        <footer className="bulk-ai-run__footer">
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={() => { onClose?.(); setActiveModule('aistudio'); }} disabled={submitting}>
            Open AI Studio
          </Button>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            disabled={submitting || !promptText.trim() || !modelKey || count === 0}
            onClick={handleSubmit}
          >
            {submitting ? 'Queueing…' : `Queue ${count} task${count === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
