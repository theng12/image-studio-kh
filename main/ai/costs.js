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
  // v0.49.25: re-checked against the official pricing table at
  // https://fal.ai/models/openai/gpt-image-2/edit — fal exposes a real
  // size × quality matrix. The numbers below use the 1024×1024 MEDIUM
  // quality row as the default estimate. Real numbers for reference:
  //   Size         Low      Medium   High
  //   1024×768     $0.011   $0.043   $0.151
  //   1024×1024    $0.015   $0.061   $0.219
  //   1024×1536    $0.018   $0.054   $0.178
  //   1920×1080    $0.017   $0.053   $0.158
  //   2560×1440    $0.019   $0.068   $0.234
  //   3840×2160    $0.024   $0.113   $0.413
  // Note: a single perImageUsd can\'t encode the variance; until the cost
  // estimator learns about quality, we estimate medium 1024×1024 = $0.061.
  // Use the Quality picker in AI Studio to actually control cost.
  'openai/gpt-image-2/edit':        { perImageUsd: 0.061 },
  'openai/gpt-image-2':             { perImageUsd: 0.061 },
  // Legacy entries — only resolve cost for in-flight queued tasks; the
  // picker hides these via the `deprecated` flag in models.js.
  'fal-ai/gpt-image-2/edit-image':  { perImageUsd: 0.061 },
  'fal-ai/gpt-image-2/text-to-image': { perImageUsd: 0.061 },
  'fal-ai/nano-banana/edit':        { perImageUsd: 0.039 },
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
