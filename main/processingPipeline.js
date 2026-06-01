const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { getDataDir } = require('./db');
const { slugify } = require('./util/slug');

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHexColor(hex) {
  const fallback = { r: 255, g: 255, b: 255, alpha: 1 };
  if (!HEX_RE.test(hex)) return fallback;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b, alpha: 1 };
}

function cornerPosition(corner, canvasW, canvasH, wmW, wmH, margin) {
  switch (corner) {
    case 'tl': return { left: margin,                   top: margin };
    case 'tr': return { left: canvasW - wmW - margin,   top: margin };
    case 'bl': return { left: margin,                   top: canvasH - wmH - margin };
    case 'br':
    default:   return { left: canvasW - wmW - margin,   top: canvasH - wmH - margin };
  }
}

function clampNumber(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function processedDirForSku(sku) {
  // Briefing layout: <dataDir>/processed/<sku>/<file>. The app-image://
  // protocol resolves paths starting with `processed/` from the dataDir root.
  // Slugifying first means a SKU like "../etc/passwd" can never escape the
  // processed/ root (defended via the shared util/slug helper).
  const safeSku = slugify(sku, 'unknown');
  const dir = path.join(getDataDir(), 'processed', safeSku);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, safeSku };
}

/**
 * Process a product image into a final canvas.
 *
 * @param {object} args
 * @param {string} args.sku — used to scope the processed folder
 * @param {string} args.originalFilename — e.g. "abc-1234567890.jpg"
 * @param {Buffer} args.foregroundBuffer — bytes of the foreground (transparent PNG from @imgly,
 *                                          or raw image bytes when removeBackground is false)
 * @param {object} args.settings — workspace settings (see defaultSettings in renderer)
 * @returns {Promise<{relativePath: string, absolutePath: string, filename: string}>}
 */
async function processImage({ sku, originalFilename, foregroundBuffer, settings }) {
  const canvasW = clampNumber(Math.round(settings.canvasWidth || 2000), 64, 8192);
  const canvasH = clampNumber(Math.round(settings.canvasHeight || 2000), 64, 8192);
  const fillPct = clampNumber(Number(settings.productFillPct ?? 85), 30, 100) / 100;

  /* ── 1. Prep foreground ─────────────────────────────────────── */

  // `.rotate()` with no args reads EXIF and auto-orients. Followed by an
  // explicit `.rotate(N)` to apply the user's manual rotation (in 90° steps
  // — Sharp accepts any angle but odd ones produce blurry results without
  // resampling). Multiples of 90 are lossless rotations.
  const rotateDeg = ((Math.round(Number(settings.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
  let fg = sharp(foregroundBuffer, { failOn: 'none' }).rotate();
  if (rotateDeg !== 0) {
    fg = sharp(await fg.toBuffer()).rotate(rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }

  // Only trim transparent edges when bg removal produced a cutout.
  if (settings.removeBackground) {
    try {
      fg = sharp(await fg.toBuffer()).trim({ threshold: 10 });
    } catch (_) {
      // trim may throw if image has no edges to trim; ignore.
    }
  }

  // Brightness / contrast / auto-adjust
  const brightness = clampNumber(Number(settings.brightness ?? 0), -100, 100);
  const contrast   = clampNumber(Number(settings.contrast   ?? 0), -100, 100);

  if (brightness !== 0) {
    fg = fg.modulate({ brightness: 1 + brightness / 100 });
  }
  if (contrast !== 0) {
    const a = 1 + contrast / 100;
    const b = (1 - a) * 128;
    fg = fg.linear(a, b);
  }
  // v0.49.19: Workspace "Auto-adjust" used to be a simple `fg.normalize()` —
  // a luminance stretch and nothing else. The Library bulk Enhance modal
  // (v0.40.0) runs the richer WB + auto-levels + saturation + brightness
  // pipeline via util/autoEnhance.js. Now they\'re the same: a single
  // mental model, same look across Workspace and Library bulk.
  if (settings.autoAdjust) {
    const { autoEnhance } = require('./util/autoEnhance');
    const interBuf = await fg.png().toBuffer();
    const enhanced = await autoEnhance(interBuf, {
      whiteBalance: true,
      autoLevels: true,
      saturation: 1.08,
      brightness: 1.0,
    });
    fg = sharp(enhanced, { failOn: 'none' });
  }

  // Resize to fit inside fillBound
  const fillBound = Math.round(Math.min(canvasW, canvasH) * fillPct);
  fg = fg.resize({
    width: fillBound,
    height: fillBound,
    fit: 'inside',
    withoutEnlargement: false,
  });

  // Materialize foreground to a PNG buffer so we know its size.
  const fgBuffer = await fg.png().toBuffer();
  const fgMeta = await sharp(fgBuffer).metadata();
  const fgW = fgMeta.width ?? fillBound;
  const fgH = fgMeta.height ?? fillBound;

  const fgLeft = Math.round((canvasW - fgW) / 2);
  const fgTop  = Math.round((canvasH - fgH) / 2);

  /* ── 2. Build canvas ───────────────────────────────────────── */

  const bgColor = parseHexColor(settings.backgroundColor || '#FFFFFF');
  let canvas = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: bgColor,
    },
  });

  const composites = [];

  /* ── 3. Drop shadow (under foreground) ─────────────────────── */

  if (settings.shadow && settings.removeBackground) {
    try {
      // Build a soft shadow from the foreground's alpha channel.
      const alphaBuffer = await sharp(fgBuffer)
        .extractChannel('alpha')
        .toBuffer();

      // Blur it to feather the shadow.
      const blurred = await sharp(alphaBuffer, {
        raw: { width: fgW, height: fgH, channels: 1 },
      })
        .blur(18)
        .toBuffer();

      // Convert grayscale shadow → RGBA black with reduced opacity.
      const shadowAlpha = await sharp(blurred, {
        raw: { width: fgW, height: fgH, channels: 1 },
      }).raw().toBuffer();

      const rgba = Buffer.alloc(fgW * fgH * 4);
      for (let i = 0; i < shadowAlpha.length; i++) {
        const a = Math.round(shadowAlpha[i] * 0.35); // ~35 % opacity
        const j = i * 4;
        rgba[j]     = 0;
        rgba[j + 1] = 0;
        rgba[j + 2] = 0;
        rgba[j + 3] = a;
      }

      const shadowBuffer = await sharp(rgba, {
        raw: { width: fgW, height: fgH, channels: 4 },
      })
        .png()
        .toBuffer();

      composites.push({
        input: shadowBuffer,
        left: fgLeft,
        top: fgTop + Math.round(canvasH * 0.012),
      });
    } catch (err) {
      // Shadow is non-critical; skip on failure.
    }
  }

  /* ── 4. Foreground ─────────────────────────────────────────── */

  composites.push({ input: fgBuffer, left: fgLeft, top: fgTop });

  /* ── 5. Watermark ──────────────────────────────────────────── */

  const wm = settings.watermark;
  if (wm?.enabled && wm.relativePath) {
    try {
      const wmAbs = path.join(getDataDir(), 'assets', wm.relativePath);
      if (fs.existsSync(wmAbs)) {
        const opacity = clampNumber(Number(wm.opacity ?? 0.7), 0, 1);
        const wmTargetW = Math.round(canvasW * 0.18);
        const margin = Math.round(canvasW * 0.03);

        // Resize, then multiply alpha by opacity via dest-in blend.
        const opacityLayer = Buffer.from([255, 255, 255, Math.round(opacity * 255)]);
        const wmBuffer = await sharp(wmAbs)
          .rotate()
          .resize({ width: wmTargetW, withoutEnlargement: true })
          .ensureAlpha()
          .composite([
            {
              input: opacityLayer,
              raw: { width: 1, height: 1, channels: 4 },
              tile: true,
              blend: 'dest-in',
            },
          ])
          .png()
          .toBuffer();

        const wmMeta = await sharp(wmBuffer).metadata();
        const pos = cornerPosition(
          wm.corner || 'br',
          canvasW,
          canvasH,
          wmMeta.width ?? wmTargetW,
          wmMeta.height ?? wmTargetW,
          margin,
        );
        composites.push({ input: wmBuffer, ...pos });
      }
    } catch (_) {
      // Watermark is non-critical; skip on failure.
    }
  }

  canvas = canvas.composite(composites);

  /* ── 5b. Optional crop ─────────────────────────────────────── */

  // Crop is stored as fractions of the canvas (0–1). After composing the full
  // canvas, extract the crop region and resize back to the profile's canvas
  // size so downstream consumers still get the configured WxH.
  const cr = settings.cropRect;
  if (cr && (cr.x > 0 || cr.y > 0 || cr.width < 1 || cr.height < 1)) {
    const cropL = clampNumber(Math.round(cr.x * canvasW), 0, canvasW - 1);
    const cropT = clampNumber(Math.round(cr.y * canvasH), 0, canvasH - 1);
    const cropW = clampNumber(Math.round(cr.width  * canvasW), 1, canvasW - cropL);
    const cropH = clampNumber(Math.round(cr.height * canvasH), 1, canvasH - cropT);

    const composedBuffer = await canvas.png().toBuffer();
    canvas = sharp(composedBuffer)
      .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
      .resize(canvasW, canvasH, { fit: 'fill' });
  }

  /* ── 5c. Tone + Detail (v0.49.18) ──────────────────────────── */

  // Tone: exposure is a true stop scale (±100 = ±1 stop, ±50 = ±½ stop).
  // Implemented via sharp.linear(factor, 0) — multiplicative, matches the
  // "exposure" knob in Lightroom / Camera Raw rather than additive brightness.
  const tone = settings.tone || {};
  const expo = Number(tone.exposure) || 0;
  if (expo !== 0) {
    const factor = Math.pow(2, expo / 100);
    canvas = canvas.linear(factor, 0);
  }

  // Detail: sharpen (unsharp mask via sharp.sharpen) and denoise (median
  // filter). Sharpen sigma scales from a gentle 0.5 at 1/100 up to a strong
  // 2.5 at 100/100. Denoise picks an odd window size (3/5/7) based on
  // strength; bigger = more aggressive smoothing, more lost detail. Skip
  // entirely at 0 — sharp ops cost real time on large canvases.
  const detail = settings.detail || {};
  const sh = Math.max(0, Math.min(100, Number(detail.sharpen) || 0));
  if (sh > 0) {
    const sigma = 0.5 + (sh / 100) * 2.0;
    canvas = canvas.sharpen({ sigma });
  }
  const dn = Math.max(0, Math.min(100, Number(detail.denoise) || 0));
  if (dn > 0) {
    // Median window size must be odd and small (sharp\'s upper bound is 7).
    const winSize = dn < 34 ? 3 : (dn < 67 ? 5 : 7);
    canvas = canvas.median(winSize);
  }

  /* ── 6. Save ───────────────────────────────────────────────── */

  const baseName = path.basename(originalFilename, path.extname(originalFilename));
  const outFilename = `${baseName}.png`;
  const { dir: outDir, safeSku } = processedDirForSku(sku);
  const outAbs = path.join(outDir, outFilename);

  await canvas.png({ compressionLevel: 7 }).toFile(outAbs);

  // Always emit the *slugified* SKU in the stored relative path so it round-
  // trips correctly through the app-image:// protocol.
  const relativePath = `processed/${safeSku}/${outFilename}`;
  return { relativePath, absolutePath: outAbs, filename: outFilename };
}

module.exports = { processImage, parseHexColor };
