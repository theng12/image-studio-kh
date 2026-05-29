export const MARKETPLACE_PRESETS = [
  { id: 'amazon',  name: 'Amazon',      width: 2000, height: 2000, format: 'jpg',  colorProfile: 'sRGB' },
  { id: 'shopify', name: 'Shopify',     width: 2048, height: 2048, format: 'webp', colorProfile: 'sRGB' },
  { id: 'etsy',    name: 'Etsy',        width: 2000, height: 2000, format: 'jpg',  colorProfile: 'sRGB' },
  { id: 'lazada',  name: 'Lazada',      width: 800,  height: 800,  format: 'jpg',  colorProfile: 'sRGB' },
  { id: 'tiktok',  name: 'TikTok Shop', width: 800,  height: 800,  format: 'jpg',  colorProfile: 'sRGB' },
];

export const FILL_SWATCHES = [
  { value: '#FFFFFF', label: 'White' },
  { value: '#F5F5F5', label: 'Light grey' },
  { value: '#E0E0E0', label: 'Grey' },
  { value: '#000000', label: 'Black' },
];

export const WATERMARK_CORNERS = [
  { value: 'tl', label: 'Top left' },
  { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'br', label: 'Bottom right' },
];

export function getPreset(id, customPresets = []) {
  return [...MARKETPLACE_PRESETS, ...customPresets].find((p) => p.id === id) ?? MARKETPLACE_PRESETS[0];
}

/**
 * Return all marketplace presets — built-ins followed by user-defined ones.
 * Custom presets get a `custom: true` flag so the UI can mark them.
 */
export function getAllPresets(customPresets = []) {
  return [
    ...MARKETPLACE_PRESETS,
    ...customPresets.map((p) => ({ ...p, custom: true })),
  ];
}
