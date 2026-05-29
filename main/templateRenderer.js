/**
 * Overlay Studio renderer. Composites a template's elements onto an input
 * image using Sharp + bwip-js. Returns either bytes (for previews) or
 * writes to disk (for batch runs).
 *
 * Element schema (stored as JSON in image_templates.elements):
 *
 *   {
 *     id: uuid,
 *     type: 'text' | 'barcode' | 'image',
 *     // Position in 0..1 fractions of the template's *design* canvas.
 *     // The renderer rescales for whatever input image we end up
 *     // applying to (typically the processed file's actual dimensions).
 *     x: 0..1, y: 0..1,
 *     // Anchor of (x, y) on the element bounding box. 'tl'/'tr'/'bl'/'br'
 *     // /'tc'/'bc'/'lc'/'rc'/'c'.
 *     anchor: 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc' | 'lc' | 'rc' | 'c',
 *     // Element-specific width/height in fractions. Optional for text
 *     // (font size dominates); required for barcode + image.
 *     width?: 0..1, height?: 0..1,
 *     rotation?: degrees,
 *
 *     // type === 'text'
 *     content: '{sku}' | 'Some literal' | mix,
 *     font: { family, size, weight, italic, color },
 *     align?: 'left' | 'center' | 'right',
 *     bg?:   { color, opacity, padding, radius },
 *
 *     // type === 'barcode'
 *     content: '{sku}' | '{barcode}' | literal,
 *     format: 'code128' | 'code39' | 'ean13' | 'upca' | 'qrcode',
 *     showText?: boolean,
 *     bg?: { color, opacity, padding, radius },
 *
 *     // type === 'image'
 *     source: 'brand-icon' | 'product-image:0..N' | 'asset:<relativePath>',
 *     opacity?: 0..1,
 *   }
 *
 * Tokens supported in text/barcode content: {sku} {name} {brand}
 * {barcode} {color} {category} {description} {price_retail}
 * {price_wholesale} {date} {date_short}.
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const bwipjs = require('bwip-js');
const { getDataDir } = require('./db');
const { slugify } = require('./util/slug');
const { reframeImage } = require('./util/reframe');

/* ── Token fill ─────────────────────────────────────────────────── */

function fmtDate(d, short = false) {
  if (!(d instanceof Date)) d = new Date();
  if (short) return d.toISOString().slice(0, 10);
  return d.toLocaleDateString();
}

function fillTokens(template, ctx = {}) {
  if (template == null) return '';
  return String(template)
    .replace(/\{sku\}/gi,             ctx.sku ?? '')
    .replace(/\{name\}/gi,            ctx.name ?? '')
    .replace(/\{brand\}/gi,           ctx.brand ?? '')
    .replace(/\{barcode\}/gi,         ctx.barcode ?? '')
    .replace(/\{color\}/gi,           ctx.colorFinish ?? ctx.color ?? '')
    .replace(/\{category\}/gi,        ctx.category ?? '')
    .replace(/\{description\}/gi,     ctx.description ?? '')
    .replace(/\{price_retail\}/gi,    ctx.priceRetail != null ? String(ctx.priceRetail) : '')
    .replace(/\{price_wholesale\}/gi, ctx.priceWholesale != null ? String(ctx.priceWholesale) : '')
    .replace(/\{date\}/gi,            fmtDate(ctx.date))
    .replace(/\{date_short\}/gi,      fmtDate(ctx.date, true));
}

/* ── Geometry helpers ───────────────────────────────────────────── */

/**
 * Resolve an element's pixel-space box given the input image dimensions.
 * Returns `{ left, top, width, height }` clamped to the image. We anchor
 * the box using the element's `anchor` corner so designers think in
 * "place this corner at this point" rather than always top-left.
 */
function resolveBox(el, imgW, imgH) {
  const w = Math.max(1, Math.round((el.width ?? 0) * imgW));
  const h = Math.max(1, Math.round((el.height ?? 0) * imgH));
  const ax = Math.round((el.x ?? 0) * imgW);
  const ay = Math.round((el.y ?? 0) * imgH);
  let left = ax;
  let top = ay;
  switch (el.anchor) {
    case 'tr': left = ax - w;       top = ay;            break;
    case 'bl': left = ax;           top = ay - h;        break;
    case 'br': left = ax - w;       top = ay - h;        break;
    case 'tc': left = ax - w / 2;   top = ay;            break;
    case 'bc': left = ax - w / 2;   top = ay - h;        break;
    case 'lc': left = ax;           top = ay - h / 2;    break;
    case 'rc': left = ax - w;       top = ay - h / 2;    break;
    case 'c':  left = ax - w / 2;   top = ay - h / 2;    break;
    case 'tl':
    default:   left = ax;           top = ay;            break;
  }
  return {
    left: Math.max(0, Math.round(left)),
    top:  Math.max(0, Math.round(top)),
    width:  w,
    height: h,
  };
}

/* ── Element → SVG/PNG buffer ───────────────────────────────────── */

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/** Approximate text width — Sharp + SVG renders pango, we just need a sane
 *  bounding box guess for the bg pill. ~0.55em per character is close
 *  enough for the default sans font at typical body sizes. */
function approxTextWidth(text, fontSize) {
  return Math.ceil(String(text).length * fontSize * 0.55);
}

async function renderTextElement(el, ctx, imgW, imgH) {
  const content = fillTokens(el.content ?? '', ctx);
  if (!content) return null;
  const fontSize = Math.max(8, Math.round((el.font?.size ?? 48)));
  const fontFamily = el.font?.family ?? 'Inter, "Helvetica Neue", Arial, sans-serif';
  const fontWeight = el.font?.weight ?? 'normal';
  const fontStyle  = el.font?.italic ? 'italic' : 'normal';
  const color = el.font?.color ?? '#000';
  const padding = Math.round(el.bg?.padding ?? 0);
  const radius  = Math.round(el.bg?.radius  ?? 0);
  const bgColor = el.bg?.color ?? null;
  const bgOpacity = el.bg?.opacity ?? 1;

  // Width: caller can constrain via el.width (fraction of image). Otherwise
  // grow to fit text + padding.
  const intrinsicW = approxTextWidth(content, fontSize) + padding * 2;
  const explicitW  = el.width ? Math.round(el.width * imgW) : null;
  const w = explicitW ?? intrinsicW;
  const lineHeight = Math.round(fontSize * 1.15);
  const h = lineHeight + padding * 2;

  const align = el.align ?? 'left';
  const textAnchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const textX = align === 'center' ? w / 2 : align === 'right' ? w - padding : padding;
  const textY = padding + Math.round(fontSize * 0.85);   // baseline approx

  const bg = bgColor
    ? `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="${escapeXml(bgColor)}" fill-opacity="${bgOpacity}" />`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${bg}
    <text x="${textX}" y="${textY}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" fill="${escapeXml(color)}" text-anchor="${textAnchor}">${escapeXml(content)}</text>
  </svg>`;

  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buf, naturalWidth: w, naturalHeight: h };
}

/**
 * v0.26.4: barcode rendering — bars only via bwip-js, human-readable
 * text rendered separately as SVG-text below. Mirrors the editor
 * preview in EditorCanvas.jsx so what you see in Overlay Studio is
 * what the exported image gets.
 *
 * Old behaviour: bwip-js's includetext rendered text INSIDE the SVG
 * at fixed positions in its natural coordinate system. When we then
 * stretched the SVG to the target box size with `fit: 'contain'`,
 * the SVG letterboxed (height inspector value had no visible effect)
 * AND for EAN-13 the rightmost digits visually overlapped the right
 * guard bars. Both fixed by separating bars from text.
 *
 * Numbers below the bars follow the standard's expected grouping
 * (formatBarcodeText in barcodePreview.js): EAN-13 = "8 395100 802107",
 * UPC-A = "0 39510 08021 7", EAN-8 = "1234 5678".
 */
function formatBarcodeHumanText(content, format) {
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

async function renderBarcodeElement(el, ctx, imgW, imgH) {
  const content = fillTokens(el.content ?? '', ctx).trim();
  if (!content) return null;
  const bcid = {
    code128: 'code128',
    code39:  'code39',
    ean13:   'ean13',
    upca:    'upca',
    qrcode:  'qrcode',
  }[el.format] ?? 'code128';

  const targetW = Math.max(64, Math.round((el.width ?? 0.25) * imgW));
  const targetH = Math.max(32, Math.round((el.height ?? 0.08) * imgH));

  const showText = el.showText !== false && bcid !== 'qrcode';
  // Bars take ~78% of vertical space when text is shown; text takes
  // ~22%. Same ratio as the editor preview so what-you-see matches.
  const barsH = showText ? Math.round(targetH * 0.78) : targetH;
  const textH = Math.max(0, targetH - barsH);

  // Render bars-only with bwip-js. `includetext: false` skips the
  // bottom digits; we draw them ourselves below.
  let barsPng;
  try {
    barsPng = await bwipjs.toBuffer({
      bcid,
      text: content,
      scale: 3,                 // hi-res raster; resized down with Sharp
      height: Math.max(8, Math.round(barsH / 4)),
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0,
      backgroundcolor: 'FFFFFF',
    });
  } catch (err) {
    throw new Error(`Barcode "${content}" couldn't be encoded as ${bcid}: ${err.message}`);
  }

  // Stretch bars to fill the target box width × barsH exactly. fit:'fill'
  // intentionally non-proportional — bar SCANNERS only care about
  // relative bar widths, and uniform stretching preserves that.
  const resizedBars = await sharp(barsPng)
    .resize(targetW, barsH, { fit: 'fill' })
    .png()
    .toBuffer();

  // Compose bars + text on a transparent canvas of the target size.
  const layers = [{ input: resizedBars, left: 0, top: 0 }];
  if (showText && textH >= 8) {
    const humanText = formatBarcodeHumanText(content, bcid);
    // Scale font size to the allocated text height — 70% of the slot
    // gives a readable label without crowding the bars above.
    const fontPx = Math.max(8, Math.round(textH * 0.7));
    // Letter-spacing for readability of grouped digits.
    const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${targetW}" height="${textH}">
      <text x="${targetW / 2}" y="${textH * 0.78}"
        text-anchor="middle"
        font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
        font-size="${fontPx}"
        font-variant-numeric="tabular-nums"
        letter-spacing="${Math.round(fontPx * 0.04)}"
        fill="#000">${escapeXml(humanText)}</text>
    </svg>`;
    const textBuf = await sharp(Buffer.from(textSvg)).png().toBuffer();
    layers.push({ input: textBuf, left: 0, top: barsH });
  }

  // Underlying white background — barcodes need a light background
  // for scanner contrast even when the surrounding element bg is off.
  const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${targetW}" height="${targetH}">
    <rect width="${targetW}" height="${targetH}" fill="#ffffff" />
  </svg>`;
  const barcodeCard = await sharp(Buffer.from(baseSvg))
    .composite(layers)
    .png()
    .toBuffer();

  const padding = Math.round(el.bg?.padding ?? 0);
  const radius  = Math.round(el.bg?.radius  ?? 0);
  const bgColor = el.bg?.color ?? null;
  const bgOpacity = el.bg?.opacity ?? 1;

  if (!bgColor) {
    return { buf: barcodeCard, naturalWidth: targetW, naturalHeight: targetH };
  }

  // Compose on a bg pill (extra padding around the barcode card).
  const pillW = targetW + padding * 2;
  const pillH = targetH + padding * 2;
  const pillSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${pillH}">
    <rect x="0" y="0" width="${pillW}" height="${pillH}" rx="${radius}" ry="${radius}" fill="${escapeXml(bgColor)}" fill-opacity="${bgOpacity}" />
  </svg>`;
  const composed = await sharp(Buffer.from(pillSvg))
    .composite([{ input: barcodeCard, left: padding, top: padding }])
    .png()
    .toBuffer();
  return { buf: composed, naturalWidth: pillW, naturalHeight: pillH };
}

async function renderImageElement(el, ctx, imgW, imgH) {
  if (!el.source) return null;
  const dataDir = getDataDir();
  let abs = null;
  if (el.source === 'brand-icon') {
    if (ctx.brandIcon) abs = path.join(dataDir, 'assets', ctx.brandIcon);
  } else if (el.source.startsWith('product-image:')) {
    const idx = Number(el.source.split(':')[1] ?? 0);
    const rel = ctx.productImages?.[idx]?.filepath;
    if (rel) abs = path.join(dataDir, 'assets', rel);
  } else if (el.source.startsWith('asset:')) {
    const rel = el.source.slice('asset:'.length);
    if (rel && !path.isAbsolute(rel)) abs = path.join(dataDir, 'assets', rel);
  }
  if (!abs || !fs.existsSync(abs)) return null;

  const targetW = Math.max(16, Math.round((el.width  ?? 0.15) * imgW));
  const targetH = Math.max(16, Math.round((el.height ?? 0.15) * imgH));
  const opacity = Math.max(0, Math.min(1, el.opacity ?? 1));

  let pipeline = sharp(abs).resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  if (opacity < 1) {
    pipeline = pipeline.composite([{
      input: Buffer.from(
        `<svg width="${targetW}" height="${targetH}"><rect width="100%" height="100%" fill="black" fill-opacity="${1 - opacity}"/></svg>`,
      ),
      blend: 'dest-in',
    }]);
  }
  const buf = await pipeline.png().toBuffer();
  return { buf, naturalWidth: targetW, naturalHeight: targetH };
}

/* ── Top-level compose ──────────────────────────────────────────── */

/**
 * @param {object} args
 * @param {Buffer | string} args.inputImage — either bytes or an absolute path
 * @param {object} args.template — { canvasWidth, canvasHeight, elements }
 * @param {object} args.context  — { sku, name, brand, brandIcon, ... }
 * @returns {Promise<Buffer>} PNG bytes of the composited image
 */
async function compose({ inputImage, template, context = {} }) {
  if (!template || !Array.isArray(template.elements)) {
    throw new Error('Template missing or has no elements');
  }

  // v0.27.0: optional inset. When the template has inset enabled, reframe
  // the base image first — shrink it to a target fill % on the template's
  // canvas and fill the margin — so the overlay elements always have a
  // guaranteed safe zone regardless of how tightly the source image fills
  // the frame. After this, the base is exactly canvasWidth × canvasHeight,
  // and every element's fractional position resolves against that.
  let effectiveInput = inputImage;
  const inset = template.inset;
  if (inset && inset.enabled) {
    try {
      effectiveInput = await reframeImage({
        inputImage,
        canvasW: template.canvasWidth || 2000,
        canvasH: template.canvasHeight || 2000,
        scale: Math.max(0.3, Math.min(1, Number(inset.scale ?? 0.85))),
        fillMode: inset.fillMode === 'blur' ? 'blur' : 'color',
        fillColor: inset.fillColor || '#FFFFFF',
      });
    } catch (err) {
      // Inset is an enhancement — if it fails, fall back to the raw image
      // rather than aborting the whole overlay render.
      process.stderr.write(`[overlay] inset failed, using raw image: ${err.message}\n`);
      effectiveInput = inputImage;
    }
  }

  const baseInput = sharp(effectiveInput, { failOn: 'none' });
  const meta = await baseInput.metadata();
  const imgW = meta.width ?? template.canvasWidth ?? 2000;
  const imgH = meta.height ?? template.canvasHeight ?? 2000;

  const composites = [];
  for (const el of template.elements) {
    // v0.26.0: respect the visible flag. `false` = explicitly hidden;
    // both `true` and undefined (legacy templates) render normally.
    if (el.visible === false) continue;
    let rendered = null;
    try {
      if (el.type === 'text')    rendered = await renderTextElement(el, context, imgW, imgH);
      else if (el.type === 'barcode') rendered = await renderBarcodeElement(el, context, imgW, imgH);
      else if (el.type === 'image')   rendered = await renderImageElement(el, context, imgW, imgH);
    } catch (err) {
      // Per-element failure shouldn't kill the whole composite — surface
      // through stderr so the runner can capture it in batch results.
      process.stderr.write(`[overlay] element ${el.id ?? '?'} (${el.type}) failed: ${err.message}\n`);
      continue;
    }
    if (!rendered) continue;
    // Use the rendered buffer's *actual* dimensions for the anchor math,
    // but place using the element's declared box. Most elements declare a
    // width/height, but text often doesn't — fall back to natural.
    const box = resolveBox(
      { ...el, width: el.width ?? rendered.naturalWidth / imgW, height: el.height ?? rendered.naturalHeight / imgH },
      imgW,
      imgH,
    );
    // v0.23.0: apply rotation if non-zero. sharp.rotate() expands the
    // output canvas to fit the rotated content (so a 100×100 square
    // rotated 45° becomes ~142×142). We compensate by shifting the
    // composite anchor so the element's CENTER stays at the same
    // canvas position the editor previews — matches the editor's
    // CSS transform-origin: 50% 50%.
    let composite = { input: rendered.buf, left: box.left, top: box.top };
    const rot = Number(el.rotation ?? 0);
    if (Number.isFinite(rot) && Math.abs(rot) > 0.01) {
      try {
        const rotatedBuf = await sharp(rendered.buf, { failOn: 'none' })
          .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();
        const rotMeta = await sharp(rotatedBuf).metadata();
        const oldW = box.width;
        const oldH = box.height;
        const newW = rotMeta.width ?? oldW;
        const newH = rotMeta.height ?? oldH;
        // Center-preserving shift: the rotated buffer is larger, so
        // offset by half the expansion in each axis to keep the center
        // where it was unrotated.
        composite = {
          input: rotatedBuf,
          left: Math.round(box.left - (newW - oldW) / 2),
          top:  Math.round(box.top  - (newH - oldH) / 2),
        };
      } catch (err) {
        process.stderr.write(`[overlay] element ${el.id ?? '?'} rotate(${rot}) failed: ${err.message}\n`);
        // Fall through with the unrotated composite — better to ship a
        // wrong-orientation render than a blank one.
      }
    }
    composites.push(composite);
  }

  if (composites.length === 0) {
    // Nothing rendered — return the (possibly reframed) base unchanged,
    // still as PNG so the caller has a uniform output format.
    return sharp(effectiveInput, { failOn: 'none' }).png().toBuffer();
  }
  return sharp(effectiveInput, { failOn: 'none' })
    .composite(composites)
    .png({ compressionLevel: 7 })
    .toBuffer();
}

/* ── Output path helper ─────────────────────────────────────────── */

/**
 * Where overlay outputs live on disk:
 *   <dataDir>/overlays/<template-slug>/<sku>/<filename>--<template-slug>.png
 * Separate root from `processed/` so overlay-baked variants never collide
 * with the bare processed file.
 */
function outputPathFor(template, productSku, originalFilename) {
  const templateSlug = slugify(template.name, 'template');
  const safeSku = slugify(productSku, 'unknown');
  const base = originalFilename
    ? originalFilename.replace(/\.[^.]+$/, '')
    : 'image';
  const dir = path.join(getDataDir(), 'overlays', templateSlug, safeSku);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${base}--${templateSlug}.png`;
  return {
    absolute: path.join(dir, filename),
    relative: `overlays/${templateSlug}/${safeSku}/${filename}`,
  };
}

module.exports = { compose, fillTokens, outputPathFor };
