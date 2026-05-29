/**
 * Browser-side barcode preview using bwip-js. Renders to inline SVG so we
 * can drop it straight into the editor canvas via dangerouslySetInnerHTML.
 *
 * Cached aggressively: encoding the same content+format twice in a render
 * pass is common (selection + re-render), and bwip-js's SVG rendering isn't
 * the cheapest. The cache is keyed by content+format+showText so it stays
 * accurate when the user edits properties.
 */
import bwipjs from 'bwip-js';

const cache = new Map();
const MAX_CACHE = 100;

function cacheKey(content, format, showText) {
  return `${format}::${showText ? 1 : 0}::${content}`;
}

/**
 * Render a barcode as an inline SVG string. Returns a placeholder SVG if
 * encoding fails (invalid content for the format, etc.) so the editor
 * never shows a broken-image icon.
 *
 * v0.26.4: ALWAYS renders bars-only (includetext: false). The caller
 * renders the human-readable digits as separate HTML next to the SVG —
 * see ElementContent in EditorCanvas.jsx. Why:
 *
 *   bwip-js's built-in text rendering puts digits at fixed coordinates
 *   inside the SVG. When the SVG gets stretched to fit the editor's
 *   element box (which usually has a different aspect ratio than the
 *   natural barcode), the text scales relative to the bars and ends up
 *   overlapping the guard bars on the right side. Worse, the
 *   `preserveAspectRatio` default ("xMidYMid meet") letterboxes the
 *   SVG inside the box, making the inspector's Height field have no
 *   apparent effect because the bars stay at the natural aspect.
 *
 *   Separating the text into HTML gives us full CSS control (font,
 *   alignment, spacing, color) AND lets the bars stretch with
 *   `preserveAspectRatio="none"` to fill the element box exactly.
 *   Uniform stretching is fine for barcode scanners — they only care
 *   about RELATIVE bar widths, not absolute proportions.
 */
export function renderBarcodeSVG(content, format = 'code128', { showText = true } = {}) {
  const safe = (content ?? '').trim() || 'preview';
  // The `showText` flag is now consumed by the CALLER (it controls
  // whether to render the HTML text element); we always pass
  // `includetext: false` to bwip-js. Cache key still keys on showText
  // so the cache invalidates if it ever changes (defensive).
  const key = cacheKey(safe, format, showText);
  if (cache.has(key)) return cache.get(key);

  let svg;
  try {
    svg = bwipjs.toSVG({
      bcid: format,
      text: safe,
      includetext: false,           // v0.26.4: HTML text instead
      paddingwidth: 0,
      paddingheight: 0,
      backgroundcolor: 'FFFFFF',
    });
    // Force preserveAspectRatio="none" so the SVG stretches to fill
    // whatever box we give it. bwip-js does not set this attribute by
    // default, so the SVG inherits the SVG-default "xMidYMid meet"
    // which letterboxes. Patch it in.
    svg = svg.replace(/<svg /, '<svg preserveAspectRatio="none" ');
  } catch (err) {
    // Friendly inline placeholder so the editor stays usable while the
    // user fixes their content (e.g. EAN-13 requires 12 digits + check).
    svg = placeholderSvg(format, String(err?.message ?? err));
  }

  // LRU-ish: drop the oldest entry when we hit the cap. Map preserves
  // insertion order so the first key is the oldest.
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, svg);
  return svg;
}

/**
 * Format the human-readable text the way each barcode standard expects.
 * EAN-13: "8 395100 802107" (1 + 6 + 6 grouping). UPC-A: "0 39510 08021 7"
 * (1 + 5 + 5 + 1). Everything else just shows the content verbatim.
 *
 * v0.26.4: called by the editor's ElementContent + the server-side
 * renderer to draw the digits below the bars in HTML / SVG-text
 * separately from the bars-only SVG. Keeping the formatter here means
 * editor preview + baked output agree on spacing.
 */
export function formatBarcodeText(content, format) {
  const s = String(content ?? '').trim();
  if (!s) return '';
  if (format === 'ean13' && /^\d{13}$/.test(s)) {
    return `${s[0]} ${s.slice(1, 7)} ${s.slice(7)}`;
  }
  if (format === 'upca' && /^\d{12}$/.test(s)) {
    return `${s[0]} ${s.slice(1, 6)} ${s.slice(6, 11)} ${s[11]}`;
  }
  if (format === 'ean8' && /^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)} ${s.slice(4)}`;
  }
  return s;
}

function placeholderSvg(format, message) {
  const safeMessage = String(message ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="200" height="80" fill="#fff8e1" stroke="#d97706" stroke-width="1" />
    <text x="100" y="32" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="#92400e">Bad ${format}</text>
    <text x="100" y="52" text-anchor="middle" font-family="ui-monospace, monospace" font-size="8" fill="#92400e">${safeMessage.slice(0, 50)}</text>
  </svg>`;
}
