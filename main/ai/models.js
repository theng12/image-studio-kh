/**
 * Curated catalog of AI models exposed in the UI. Newer kie.ai models go
 * through their unified Market endpoint (POST /api/v1/jobs/createTask,
 * GET /api/v1/jobs/recordInfo) — `kieMarketModel` carries the exact value
 * for the request body's `model` field. The older 4o-image and flux-kontext
 * endpoints stay supported for callers that already have tasks queued, but
 * the catalog points new generations at the newer Market models.
 */

const MODELS = [
  // ───── kie.ai · GPT Image-2 (the user's primary requested model) ─────
  {
    key: 'kie:gpt-image-2-image-to-image',
    provider: 'kie',
    displayName: 'GPT Image-2 · Image-to-Image',
    family: 'Image edit',
    description: 'Latest OpenAI image model via kie.ai. Best fidelity for product edits.',
    supportsSource: true,
    kieKind: 'market',
    kieMarketModel: 'gpt-image-2-image-to-image',
    sourceParam: 'input_urls',
    sizes: ['auto', '1:1', '9:16', '16:9', '4:3', '3:4'],
    resolutions: ['1K', '2K', '4K'],
  },
  {
    key: 'kie:gpt-image-2-text-to-image',
    provider: 'kie',
    displayName: 'GPT Image-2 · Text-to-Image',
    family: 'Text-to-image',
    description: 'Latest OpenAI image model — prompt-only generation.',
    supportsSource: false,
    kieKind: 'market',
    kieMarketModel: 'gpt-image-2-text-to-image',
    sizes: ['auto', '1:1', '9:16', '16:9', '4:3', '3:4'],
    resolutions: ['1K', '2K', '4K'],
  },

  // ───── kie.ai · Google Nano Banana (latest Gemini image models) ─────
  {
    key: 'kie:nano-banana-pro',
    provider: 'kie',
    displayName: 'Nano Banana Pro',
    family: 'Image edit',
    description: "Google's premium Gemini image model — best quality for product edits.",
    supportsSource: true,
    kieKind: 'market',
    kieMarketModel: 'nano-banana-pro',
    sourceParam: 'image_input',
    sizes: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'],
  },
  {
    key: 'kie:nano-banana-2',
    provider: 'kie',
    displayName: 'Nano Banana 2',
    family: 'Image edit',
    description: "Google's latest Gemini image model — supports up to 14 reference images.",
    supportsSource: true,
    kieKind: 'market',
    kieMarketModel: 'nano-banana-2',
    sourceParam: 'image_input',
    sizes: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'],
  },
  {
    key: 'kie:nano-banana-edit',
    provider: 'kie',
    displayName: 'Nano Banana · Edit',
    family: 'Image edit',
    description: 'Original Nano Banana editing model — fast, lower cost.',
    supportsSource: true,
    kieKind: 'market',
    kieMarketModel: 'nano-banana-edit',
    sourceParam: 'image_input',
  },

  // ───── kie.ai · Seedream 5 Lite, Flux-2 Pro ─────
  {
    key: 'kie:seedream-5-lite-image-to-image',
    provider: 'kie',
    displayName: 'Seedream 5 Lite · Image-to-Image',
    family: 'Image-to-image',
    description: 'ByteDance Seedream 5 Lite — photorealistic transforms.',
    supportsSource: true,
    kieKind: 'market',
    kieMarketModel: 'seedream-v5-lite-image-to-image',
    sourceParam: 'image_urls',
  },
  {
    key: 'kie:flux-2-pro-image-to-image',
    provider: 'kie',
    displayName: 'Flux-2 Pro · Image-to-Image',
    family: 'Image edit',
    description: 'Black Forest Labs Flux-2 Pro — next-gen Flux for image edits.',
    supportsSource: true,
    kieKind: 'market',
    kieMarketModel: 'flux-2-pro-image-to-image',
    sourceParam: 'image_urls',
  },

  // v0.26.47: removed the legacy `kie:flux-kontext-pro` entry. The
  // /flux/kontext endpoint stays implemented in providers/kie.js for
  // any existing queued tasks that still reference it, but it's no
  // longer in the catalog the UI presents — users get steered to the
  // newer `kie:flux-2-pro-image-to-image` above.

  // ───── fal.ai · queue API ─────
  {
    key: 'fal-ai/gpt-image-2/edit-image',
    provider: 'fal',
    displayName: 'fal · GPT Image-2 · Edit',
    family: 'Image edit',
    description: "OpenAI's GPT Image-2 via fal — best fidelity image edit. If fal hasn't enabled this endpoint on your account yet, use kie's GPT Image-2 above (same model, different host).",
    supportsSource: true,
    sourceParam: 'image_urls',
  },
  {
    key: 'fal-ai/gpt-image-2/text-to-image',
    provider: 'fal',
    displayName: 'fal · GPT Image-2 · Text-to-Image',
    family: 'Text-to-image',
    description: "OpenAI's GPT Image-2 via fal — prompt-only generation.",
    supportsSource: false,
  },
  {
    key: 'fal-ai/nano-banana/edit',
    provider: 'fal',
    displayName: 'fal · Nano Banana · Edit',
    family: 'Image edit',
    description: "Google's Nano Banana edit on fal. Use kie's nano-banana-2/pro for newer variants.",
    supportsSource: true,
    sourceParam: 'image_urls',
  },
  {
    key: 'fal-ai/seedream/v4/edit',
    provider: 'fal',
    displayName: 'fal · Seedream v4 · Edit',
    family: 'Image edit',
    description: 'ByteDance Seedream v4 image editor on fal.',
    supportsSource: true,
    sourceParam: 'image_urls',
  },
  {
    key: 'fal-ai/recraft/v3/image-to-image',
    provider: 'fal',
    displayName: 'fal · Recraft v3 · Image-to-Image',
    family: 'Image-to-image',
    description: 'Recraft v3 with controllable strength.',
    supportsSource: true,
    sourceParam: 'image_url',
    extraInputs: { strength: 0.8 },
  },
  // v0.26.47: removed `fal-ai/flux-pro/kontext`, `fal-ai/flux/dev`,
  // `fal-ai/flux/schnell`. The newer GPT Image-2 / Nano Banana /
  // Seedream / Recraft entries above cover both text-to-image and
  // image-to-image with better quality. The provider plumbing in
  // providers/fal.js still handles `fal-ai/flux/*` keys if someone
  // somehow queues a legacy task, but new tasks can't pick them
  // from the dropdown.
];

function byKey(key) {
  return MODELS.find((m) => m.key === key) ?? null;
}

function listByProvider(provider) {
  return MODELS.filter((m) => m.provider === provider);
}

module.exports = { MODELS, byKey, listByProvider };
