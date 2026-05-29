import { getPreset } from './presets.js';

export function defaultSettings() {
  const preset = getPreset('amazon');
  return {
    presetId: preset.id,
    canvasWidth: preset.width,
    canvasHeight: preset.height,
    colorProfile: preset.colorProfile,
    productFillPct: 85,
    removeBackground: true,
    backgroundColor: '#FFFFFF',
    autoAdjust: false,
    brightness: 0,
    contrast: 0,
    shadow: false,
    watermark: {
      enabled: false,
      relativePath: null,
      corner: 'br',
      opacity: 0.7,
    },
    cropRect: null,  // null = no crop; { x, y, width, height } as fractions of canvas
    // Rotation in degrees, multiples of 90. Stored in the workspace so it
    // round-trips through processing and re-opens with the same orientation.
    // Applied BEFORE crop + composition so the crop rect refers to the
    // already-rotated image (user-intuitive).
    rotation: 0,
  };
}

export function mergeSettings(stored) {
  const base = defaultSettings();
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    watermark: { ...base.watermark, ...(stored.watermark ?? {}) },
  };
}
