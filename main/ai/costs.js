/**
 * Ballpark per-image USD costs. Shown in the confirmation dialog. Refresh
 * from each provider's pricing page periodically — this table is the
 * single source of truth.
 *
 * Values are best-effort estimates; the precise charge is what kie.ai
 * deducts in credits at task completion (visible at kie.ai/logs).
 */

const COSTS = {
  // ───── kie.ai · Market endpoint (newest) ─────
  'kie:gpt-image-2-image-to-image': { perImageUsd: 0.045 },
  'kie:gpt-image-2-text-to-image':  { perImageUsd: 0.045 },
  'kie:nano-banana-pro':            { perImageUsd: 0.040 },
  'kie:nano-banana-2':              { perImageUsd: 0.035 },
  'kie:nano-banana-edit':           { perImageUsd: 0.030 },
  'kie:seedream-5-lite-image-to-image': { perImageUsd: 0.025 },
  'kie:flux-2-pro-image-to-image':  { perImageUsd: 0.040 },

  // ───── kie.ai · legacy ─────
  // v0.26.47: legacy entries kept for any in-flight tasks already
  // queued under these keys (the queue runner does byKey lookup
  // on task.model). New tasks can't pick them from the catalog.
  'kie:gpt4o-image':                { perImageUsd: 0.040 },
  'kie:flux-kontext-pro':           { perImageUsd: 0.035 },
  'kie:flux-kontext-max':           { perImageUsd: 0.055 },

  // ───── fal.ai ─────
  // v0.26.47: added GPT Image-2 entries (same cost band as kie's
  // GPT Image-2 — fal's pricing tracks OpenAI's per-image rate
  // closely). Removed `fal-ai/flux-pro/kontext` from the catalog;
  // legacy `flux/schnell`, `flux/dev`, `flux-pro/v1.1` cost rows
  // kept so old queued tasks still resolve a cost estimate, but
  // they're no longer pickable.
  'fal-ai/gpt-image-2/edit-image':  { perImageUsd: 0.045 },
  'fal-ai/gpt-image-2/text-to-image': { perImageUsd: 0.045 },
  'fal-ai/nano-banana/edit':        { perImageUsd: 0.035 },
  'fal-ai/seedream/v4/edit':        { perImageUsd: 0.030 },
  'fal-ai/recraft/v3/image-to-image': { perImageUsd: 0.040 },
  // Legacy fal entries — only for cost estimation on already-queued
  // tasks that picked these keys before v0.26.47:
  'fal-ai/flux/schnell':            { perImageUsd: 0.003 },
  'fal-ai/flux/dev':                { perImageUsd: 0.025 },
  'fal-ai/flux-pro/v1.1':           { perImageUsd: 0.040 },
  'fal-ai/flux-pro/kontext':        { perImageUsd: 0.040 },
};

function estimateForModel(modelId, count = 1) {
  const row = COSTS[modelId];
  if (!row) return null;
  return +(row.perImageUsd * count).toFixed(4);
}

module.exports = { COSTS, estimateForModel };
