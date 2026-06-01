/**
 * v0.39.0: built-in AI prompt library.
 *
 * A curated set of image-processing prompts grouped by purpose. These are
 * STATIC (shipped in code, not the DB) — the Prompt Library browser lists
 * them so the user can either "Use" one immediately (fills the prompt box)
 * or "Save to my presets" (creates a normal ai_prompt_templates row via the
 * existing ai:createPrompt channel, after which it behaves like any custom
 * preset: favorite, edit, rename, delete).
 *
 * Bodies are written for IMAGE-TO-IMAGE editing models (Nano Banana Edit,
 * GPT Image-2 image-to-image, etc.) — i.e. they transform the product's
 * existing photo. They use the same {placeholder} tokens the rest of AI
 * Studio supports ({sku} {name} {brand} {color} {category} {description}),
 * which are filled from the selected product before sending.
 *
 * Keep these tight and reusable; the user labels/edits freely once saved.
 */

// Ordered so the browser groups read top-to-bottom in a sensible workflow.
export const PROMPT_CATEGORIES = [
  'Studio conversion',
  'Lighting',
  'Backgrounds',
  'Cleanup & retouch',
  'Color',
  'Product spec',
  'Angles',
  'Marketing',
];

export const PROMPT_LIBRARY = [
  // ── Studio conversion ─────────────────────────────────────────
  {
    id: 'lib.handheld-to-studio',
    category: 'Studio conversion',
    label: 'Hand-taken → studio',
    body: 'Turn this casual phone photo of the product into a clean professional studio product shot on a seamless pure-white background. Even soft lighting, true-to-life colours, crisp focus, product centered and upright. Keep the product exactly as-is — do not change its shape, pattern, or proportions.',
  },
  {
    id: 'lib.catalog-white',
    category: 'Studio conversion',
    label: 'Catalog white background',
    body: 'Place the product on a pure white (#FFFFFF) seamless studio background. Remove all background clutter, soft even lighting, a subtle natural contact shadow beneath the product. Preserve the product\'s true colours and surface texture.',
  },
  {
    id: 'lib.ecommerce-hero',
    category: 'Studio conversion',
    label: 'E-commerce hero shot',
    body: 'Professional e-commerce hero shot of the product: centered on a clean white background, crisp edges, gentle soft reflection beneath, bright and inviting. Magazine-quality, no props, no text.',
  },

  // ── Lighting ─────────────────────────────────────────────────
  {
    id: 'lib.soft-studio-light',
    category: 'Lighting',
    label: 'Soft studio lighting',
    body: 'Relight the product with soft, diffused studio lighting coming from the upper-left, gentle falloff and no harsh shadows. Preserve the material texture and true colours; keep the background unchanged.',
  },
  {
    id: 'lib.warm-showroom',
    category: 'Lighting',
    label: 'Warm showroom glow',
    body: 'Relight with a warm, inviting showroom glow: soft golden key light with subtle ambient fill, premium boutique feel. Keep the product\'s real colours accurate and avoid an orange colour cast.',
  },
  {
    id: 'lib.bright-even',
    category: 'Lighting',
    label: 'Bright & even (shadowless)',
    body: 'Relight with bright, shadowless, perfectly even lighting as used for top-down flat-lay photography. Neutral white balance, clean highlights, no blown-out areas.',
  },

  // ── Backgrounds ──────────────────────────────────────────────
  {
    id: 'lib.marble',
    category: 'Backgrounds',
    label: 'White marble surface',
    body: 'Place the product on a polished white marble surface with a soft neutral out-of-focus background. Natural soft lighting, premium feel, realistic contact shadow.',
  },
  {
    id: 'lib.wood-table',
    category: 'Backgrounds',
    label: 'Light wooden table',
    body: 'Stage the product on a light natural wooden table with a blurred neutral interior in the background. Soft daylight from a window, warm but accurate colours, shallow depth of field.',
  },
  {
    id: 'lib.gradient-backdrop',
    category: 'Backgrounds',
    label: 'Gradient studio backdrop',
    body: 'Place the product on a smooth studio backdrop that fades from light grey at the top to white at the bottom. Product centered, soft shadow grounding it, clean and modern.',
  },
  {
    id: 'lib.lifestyle-scene',
    category: 'Backgrounds',
    label: 'Lifestyle interior scene',
    body: 'Stage this {category} naturally in a tasteful modern interior setting that suits it, with soft natural light and a shallow depth of field. Keep the product the clear focus and unchanged.',
  },

  // ── Cleanup & retouch ────────────────────────────────────────
  {
    id: 'lib.cutout-white',
    category: 'Cleanup & retouch',
    label: 'Remove background → white',
    body: 'Cleanly cut the product out from its current background and place it on a pure white background. Keep the edges crisp and natural, no haloing, preserve fine detail and true colour.',
  },
  {
    id: 'lib.remove-glare',
    category: 'Cleanup & retouch',
    label: 'Remove glare & reflections',
    body: 'Reduce harsh glare, hotspots, and unwanted reflections on the product surface while keeping its real colours, glaze, and texture intact. Do not flatten or repaint the material.',
  },
  {
    id: 'lib.remove-dust',
    category: 'Cleanup & retouch',
    label: 'Remove dust, scratches & smudges',
    body: 'Retouch out dust, fingerprints, smudges, and minor scratches from the product and background. Keep the product authentic and unmodified in shape and pattern.',
  },
  {
    id: 'lib.remove-tags',
    category: 'Cleanup & retouch',
    label: 'Remove price tags / stickers',
    body: 'Remove any price tags, stickers, barcodes, or stray labels from the product and reconstruct the underlying surface naturally and seamlessly.',
  },

  // ── Color ────────────────────────────────────────────────────
  {
    id: 'lib.color-correct',
    category: 'Color',
    label: 'True-to-life colour correct',
    body: 'Correct the white balance and exposure to neutral and render the product\'s real-life colours accurately. The {color} finish should look true to life. No oversaturation, no colour cast.',
  },
  {
    id: 'lib.vivid',
    category: 'Color',
    label: 'Vivid & punchy',
    body: 'Increase contrast and saturation slightly for a vivid, eye-catching catalog look while keeping skin/material tones natural and believable. Do not clip highlights or shadows.',
  },

  // ── Product spec ─────────────────────────────────────────────
  {
    id: 'lib.spec-sheet',
    category: 'Product spec',
    label: 'Product spec view',
    body: 'Produce a clean straight-on documentation view of the product suitable for a spec sheet: neutral seamless background, no props, accurate proportions and colour, evenly lit, sharp detail across the whole product.',
  },
  {
    id: 'lib.outline',
    category: 'Product spec',
    label: 'Outline on white',
    body: 'Render the product as a clean, sharply-defined silhouette-style shot perfectly centered on pure white, with crisp true-to-shape edges and accurate proportions. Useful as a reference / outline image.',
  },

  // ── Angles ───────────────────────────────────────────────────
  {
    id: 'lib.three-quarter',
    category: 'Angles',
    label: 'Three-quarter angle',
    body: 'Re-render the product at a flattering three-quarter angle showing the front and one side, on a clean white studio background with soft lighting and a subtle shadow. Keep the product identical in design.',
  },
  {
    id: 'lib.flat-lay',
    category: 'Angles',
    label: 'Top-down flat lay',
    body: 'Top-down flat-lay of the {name}, perfectly centered on a clean white surface, bright even lighting, a slight soft shadow for grounding. No props, no text.',
  },

  // ── Marketing ────────────────────────────────────────────────
  {
    id: 'lib.seasonal',
    category: 'Marketing',
    label: 'Seasonal / festive styling',
    body: 'Stage the product with subtle, tasteful seasonal props and soft festive lighting that complement it without crowding. Keep the product the clear hero and unchanged. Leave clean negative space for marketing text.',
  },
];
