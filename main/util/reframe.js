/**
 * Reframe engine (v0.27.0).
 *
 * Places a (optionally shrunk + nudged) copy of an image onto a fixed-size
 * canvas, filling the margin around it. This is the shared core behind two
 * features so they can never drift apart:
 *
 *   1. Bulk inset at overlay-apply (templateRenderer.compose) — every image
 *      gets a uniform safe margin so the overlay's logo/SKU never land on
 *      the product. scale is uniform, placement is centered.
 *   2. The per-image Reframe tab (granular touch-ups after the bulk pass) —
 *      same engine, but scale + offset come from the user's drag and are
 *      persisted per image.
 *
 * Why this matters: AI-generated product shots don't fill the frame
 * consistently. Some are tight (product fills 95%), some loose. A fixed
 * overlay template assumes a reserved "safe zone" — tight images collide
 * with it. Shrinking the image to a target fill % and padding the margin
 * gives the overlay guaranteed clear space.
 *
 * Margin fill modes:
 *   - 'color' : solid fill (white default, or a brand/custom colour, or a
 *               colour sampled from the image's own background so the seam
 *               is invisible on white-background catalog shots).
 *   - 'blur'  : a blurred, cover-cropped copy of the image itself — keeps
 *               lifestyle/scene shots from getting a hard border.
 *
 * Pure image-in → image-out; no DB, no fs writes, no Electron. Callers
 * pass either a Buffer or an absolute path.
 */
const sharp = require('sharp');

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHexColor(hex, fallback = { r: 255, g: 255, b: 255, alpha: 1 }) {
  if (!HEX_RE.test(hex || '')) return fallback;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    alpha: 1,
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * @param {object} args
 * @param {Buffer|string} args.inputImage  source bytes or absolute path
 * @param {number} args.canvasW, args.canvasH  output canvas size (px)
 * @param {number} [args.scale=0.85]  placed image size as a fraction of the
 *        canvas's *shorter* side (the "fill %"). 0.3..1.
 * @param {number} [args.offsetX=0], [args.offsetY=0]  -1..1 fractional nudge
 *        of the placed image away from center (0 = centered). For the
 *        Reframe tab's drag; clamped so the image never leaves the canvas.
 * @param {'blur'|'color'} [args.fillMode='color']
 * @param {string} [args.fillColor='#FFFFFF']  used when fillMode === 'color'
 * @param {number} [args.blurSigma=28]  blur strength for 'blur' fill
 * @returns {Promise<Buffer>}  PNG bytes, exactly canvasW × canvasH
 */
async function reframeImage({
  inputImage,
  canvasW,
  canvasH,
  scale = 0.85,
  offsetX = 0,
  offsetY = 0,
  fillMode = 'color',
  fillColor = '#FFFFFF',
  blurSigma = 28,
}) {
  const W = Math.max(16, Math.round(canvasW || 2000));
  const H = Math.max(16, Math.round(canvasH || 2000));
  const s = clamp(Number(scale) || 0.85, 0.05, 1);

  // Foreground: shrink the whole image to fit inside (shorter side * scale).
  // `.rotate()` with no args first applies EXIF orientation.
  const bound = Math.round(Math.min(W, H) * s);
  const fgBuf = await sharp(inputImage, { failOn: 'none' })
    .rotate()
    .resize({ width: bound, height: bound, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
  const fgMeta = await sharp(fgBuf).metadata();
  const fgW = fgMeta.width ?? bound;
  const fgH = fgMeta.height ?? bound;

  // Placement: centered, plus a fractional nudge clamped so the image edge
  // never crosses the canvas edge (no clipping the product off-frame).
  const slackX = Math.max(0, (W - fgW) / 2);
  const slackY = Math.max(0, (H - fgH) / 2);
  const dx = clamp(Number(offsetX) || 0, -1, 1) * slackX;
  const dy = clamp(Number(offsetY) || 0, -1, 1) * slackY;
  const left = Math.round((W - fgW) / 2 + dx);
  const top = Math.round((H - fgH) / 2 + dy);

  // Background fill.
  let bgBuf;
  if (fillMode === 'blur') {
    // Cover-crop a copy of the image to the full canvas, then blur it. This
    // gives the "framed photo over a soft version of itself" look so scene
    // shots don't get a hard solid border.
    bgBuf = await sharp(inputImage, { failOn: 'none' })
      .rotate()
      .resize({ width: W, height: H, fit: 'cover' })
      .blur(clamp(Number(blurSigma) || 28, 1, 100))
      .removeAlpha()
      .png()
      .toBuffer();
  } else {
    const bg = parseHexColor(fillColor);
    bgBuf = await sharp({
      create: { width: W, height: H, channels: 4, background: bg },
    })
      .png()
      .toBuffer();
  }

  return sharp(bgBuf)
    .composite([{ input: fgBuf, left, top }])
    .png({ compressionLevel: 7 })
    .toBuffer();
}

/**
 * Best-effort estimate of an image's background colour, for the eyedropper.
 * Resizes to a tiny grid (one decode) and averages the 4 corners + the
 * top/bottom edge midpoints — the regions most likely to be background on a
 * typical centered product shot. Returns an uppercase #RRGGBB hex.
 */
async function sampleBackgroundColor(inputImage) {
  try {
    const N = 32;
    const { data, info } = await sharp(inputImage, { failOn: 'none' })
      .rotate()
      .resize(N, N, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const ch = info.channels; // 3 after removeAlpha
    const at = (x, y) => {
      const i = (y * w + x) * ch;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const pts = [
      at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1),
      at(Math.floor(w / 2), 0), at(Math.floor(w / 2), h - 1),
    ];
    let r = 0; let g = 0; let b = 0;
    for (const p of pts) { r += p[0]; g += p[1]; b += p[2]; }
    const n = pts.length;
    const toHex = (v) => clamp(Math.round(v / n), 0, 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
  } catch (_) {
    return '#FFFFFF';
  }
}

module.exports = { reframeImage, sampleBackgroundColor, parseHexColor };
