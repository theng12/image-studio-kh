/**
 * Element factory + token constants. Lives in its own file so both the
 * editor and the eventual Phase 3 batch-config dialog can import from the
 * same source of truth.
 */
import { nanoidish } from './nanoidish.js';

export const TOKENS = [
  '{sku}', '{name}', '{brand}', '{barcode}', '{color}',
  '{category}', '{description}', '{price_retail}', '{price_wholesale}',
  '{date}', '{date_short}',
];

export const ANCHORS = [
  ['tl', 'Top left'],   ['tc', 'Top center'],   ['tr', 'Top right'],
  ['lc', 'Center left'],['c',  'Center'],       ['rc', 'Center right'],
  ['bl', 'Bottom left'],['bc', 'Bottom center'],['br', 'Bottom right'],
];

export const BARCODE_FORMATS = [
  { value: 'code128', label: 'Code 128 (alphanumeric)' },
  { value: 'code39',  label: 'Code 39' },
  { value: 'ean13',   label: 'EAN-13 (13 digits)' },
  { value: 'upca',    label: 'UPC-A (12 digits)' },
  { value: 'qrcode',  label: 'QR code' },
];

export const IMAGE_SOURCES = [
  { value: 'brand-icon',        label: "Brand icon (product's brand)" },
  { value: 'product-image:0',   label: 'Product image #1 (main)' },
  { value: 'product-image:1',   label: 'Product image #2' },
  { value: 'product-image:2',   label: 'Product image #3' },
  // 'asset:<path>' handled separately in the inspector — upload flow comes
  // in Phase 4 when we hook the existing asset import path through.
];

export function defaultElement(type) {
  const base = {
    id: `el-${nanoidish()}`,
    type,
    x: 0.5, y: 0.5, anchor: 'c',
    // v0.23.0: rotation in degrees, normalised to (-180, 180]. 0 = upright.
    // Stored on the element so it survives save/load + server-side render.
    // Rotation pivot is the element's visual center (CSS transform-origin
    // 50% 50%) — same in the editor and in the templateRenderer.
    rotation: 0,
    // v0.26.0 (Phase 4): layer flags.
    //   visible: when false, element is greyed out in the editor and
    //     skipped entirely by the server-side renderer (no composite).
    //     Useful for "temporarily hide this to see what's underneath".
    //   locked:  when true, element can't be moved/resized/rotated in
    //     the editor (the body's pointer events still fire so you can
    //     SELECT it, but drag handlers no-op). Inspector fields still
    //     work — locked is a "don't accidentally bump it" guard, not a
    //     "make this read-only" guard.
    visible: true,
    locked: false,
  };
  if (type === 'text') {
    return {
      ...base,
      content: '{sku}',
      font: { family: 'Inter, "Helvetica Neue", Arial, sans-serif', size: 48, weight: 'bold', color: '#111111' },
      align: 'left',
      bg: { color: '#FFFFFF', opacity: 0.9, padding: 12, radius: 6 },
    };
  }
  if (type === 'barcode') {
    return {
      ...base,
      x: 0.95, y: 0.95, anchor: 'br',
      // Code128's natural rendered aspect is roughly 4:1 (bars + human-readable
      // line); a 0.28 × 0.07 box gives that ratio without weird letterboxing.
      // Was 0.28 × 0.10 in v0.10.0 — looked stretched-tall.
      width: 0.28, height: 0.07,
      content: '{sku}',
      format: 'code128',
      showText: true,
      bg: { color: '#FFFFFF', opacity: 1, padding: 12, radius: 6 },
    };
  }
  if (type === 'image') {
    return {
      ...base,
      x: 0.05, y: 0.05, anchor: 'tl',
      width: 0.15, height: 0.15,
      source: 'brand-icon',
      opacity: 1,
    };
  }
  throw new Error(`Unknown element type: ${type}`);
}

/**
 * Compute the on-canvas pixel box for an element given the canvas size
 * in CSS pixels (NOT the design canvas — the editor scales the design
 * canvas to fit the viewport). Mirrors the main-process renderer's
 * `resolveBox` so the editor preview matches the actual render.
 *
 * `previewText` is optional and only used for text-element width
 * estimation when the element doesn't declare an explicit width. Caller
 * passes the token-filled content so the bg pill auto-sizes to fit
 * "BF-R5232-GD" instead of the un-filled "{sku}" string.
 */
export function elementBox(el, canvasW, canvasH, previewText = null) {
  const explicitW = (el.width  ?? 0) * canvasW;
  const explicitH = (el.height ?? 0) * canvasH;
  // Text fallback: estimate from the actual content + font + padding so a
  // 12-char SKU doesn't get clipped at the bg pill's right edge. The
  // ~0.55em-per-char heuristic matches the main-process renderer's
  // approxTextWidth(); padding * 2 matches the SVG pill's L+R padding so
  // the editor preview = the baked output.
  let fallbackW = explicitW;
  let fallbackH = explicitH;
  if (el.type === 'text') {
    const fontSize = el.font?.size ?? 48;
    const padding = (el.bg?.padding ?? 0);
    const scale = canvasW / 2000;
    const designFontPx = fontSize;
    const sample = previewText && previewText.length > 0 ? previewText : (el.content || '');
    // Width = character count × 0.55em + horizontal padding × 2, scaled
    // for the editor's CSS pixel size. Clamp to a sane minimum so a
    // brand-new empty text element is still grabbable.
    const designW = Math.max(80, sample.length * designFontPx * 0.55 + padding * 2);
    const designH = Math.max(designFontPx * 1.15, designFontPx + padding * 2);
    fallbackW = designW * scale;
    fallbackH = designH * (canvasH / 2000);
  }
  const w = Math.max(20, explicitW || fallbackW);
  const h = Math.max(16, explicitH || fallbackH);
  const ax = (el.x ?? 0) * canvasW;
  const ay = (el.y ?? 0) * canvasH;
  let left = ax, top = ay;
  switch (el.anchor) {
    case 'tr': left = ax - w;     top = ay;         break;
    case 'bl': left = ax;         top = ay - h;     break;
    case 'br': left = ax - w;     top = ay - h;     break;
    case 'tc': left = ax - w / 2; top = ay;         break;
    case 'bc': left = ax - w / 2; top = ay - h;     break;
    case 'lc': left = ax;         top = ay - h / 2; break;
    case 'rc': left = ax - w;     top = ay - h / 2; break;
    case 'c':  left = ax - w / 2; top = ay - h / 2; break;
    case 'tl':
    default:   left = ax;         top = ay;         break;
  }
  return { left, top, width: w, height: h };
}
