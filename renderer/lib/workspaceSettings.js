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
    // v0.49.15: aspect-ratio constraint for the crop tool. Null = Free.
    // Otherwise a string: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | a
    // user-entered "X:Y" (validated to numeric ratio). When set, new drags
    // and handle-resizes preserve this ratio. The chosen ratio is persisted
    // so reopening the workspace remembers your last crop intent.
    cropAspectRatio: null,
    // v0.49.16: free-angle straighten for the crop tool. Range -45..+45°.
    // Applied as a pre-extract sharp.rotate on the server. Lives in workspace
    // settings so it round-trips through Save and reopens with the same tilt.
    cropStraighten: 0,
    // Rotation in degrees, multiples of 90. Stored in the workspace so it
    // round-trips through processing and re-opens with the same orientation.
    // Applied BEFORE crop + composition so the crop rect refers to the
    // already-rotated image (user-intuitive).
    rotation: 0,
    // v0.49.18: Tone + Detail panels. Applied in the processing pipeline
    // AFTER crop, BEFORE save. All default to 0 (no change). Sharp-native
    // ops: exposure → linear(2^(exposure/100), 0); sharpen → sharpen({sigma});
    // denoise → median(size).
    tone:   { exposure: 0 },           // -100..+100 (one stop per ±100)
    detail: { sharpen: 0, denoise: 0 }, // 0..100 each
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
