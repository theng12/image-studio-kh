/**
 * v0.27.0: tests for the reframe engine (main/util/reframe.js) — the
 * shared core behind the overlay bulk-inset and the Reframe tab.
 *
 * These exercise the real sharp pipeline (generate image → reframe →
 * inspect output), so they need a loadable sharp native binary. After a
 * dual-arch `npm run dist` the on-disk sharp binary can be the OTHER
 * arch (x64 left over from the Intel build) while node is arm64 — in that
 * case sharp throws on require. Rather than fail the whole suite on an
 * environment quirk unrelated to this code, we detect that and skip.
 * `npm run postinstall` (electron-builder install-app-deps) rebuilds the
 * host-arch binary, after which these run normally.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let sharp = null;
let reframe = null;
try {
  sharp = require('sharp');
  reframe = require('../main/util/reframe');
} catch (_) {
  // sharp couldn't load (arch mismatch) — tests below self-skip.
}

const skip = !sharp || !reframe;

/** Build a solid-colour PNG buffer of the given size. */
async function solid(w, h, rgb) {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } })
    .png()
    .toBuffer();
}

test('reframe — output is exactly the requested canvas size (color fill)', { skip }, async () => {
  const src = await solid(200, 200, { r: 10, g: 20, b: 30 });
  const out = await reframe.reframeImage({
    inputImage: src, canvasW: 400, canvasH: 400, scale: 0.5,
    fillMode: 'color', fillColor: '#FFFFFF',
  });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 400);
});

test('reframe — non-square canvas + blur fill keeps the canvas size', { skip }, async () => {
  const src = await solid(300, 200, { r: 80, g: 120, b: 160 });
  const out = await reframe.reframeImage({
    inputImage: src, canvasW: 500, canvasH: 300, scale: 0.7, fillMode: 'blur',
  });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 500);
  assert.equal(meta.height, 300);
});

test('reframe — color fill leaves the expected margin colour in the corner', { skip }, async () => {
  // Shrink a small red image onto a big WHITE canvas; the corner pixel
  // must be the fill colour (white), proving the margin actually renders.
  const src = await solid(100, 100, { r: 220, g: 10, b: 10 });
  const out = await reframe.reframeImage({
    inputImage: src, canvasW: 600, canvasH: 600, scale: 0.4,
    fillMode: 'color', fillColor: '#FFFFFF',
  });
  const { data, info } = await sharp(out).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Top-left pixel.
  const r = data[0]; const g = data[1]; const b = data[2];
  assert.ok(r > 250 && g > 250 && b > 250, `corner should be white, got ${r},${g},${b}`);
});

test('sampleBackgroundColor — reads the dominant solid colour', { skip }, async () => {
  const src = await solid(120, 120, { r: 200, g: 30, b: 40 });
  const hex = await reframe.sampleBackgroundColor(src);
  assert.equal(hex, '#C81E28');
});

/** White canvas with a centered solid block — a "product on white bg". */
async function productOnWhite(canvas, block, rgb) {
  const blk = await sharp({ create: { width: block, height: block, channels: 3, background: rgb } })
    .png().toBuffer();
  return sharp({ create: { width: canvas, height: canvas, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: blk, gravity: 'centre' }])
    .png().toBuffer();
}

/** Fraction of non-white pixels in a PNG buffer. */
async function fractionColored(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let colored = 0;
  for (let i = 0; i < data.length; i += 3) {
    if (!(data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240)) colored += 1;
  }
  return colored / (info.width * info.height);
}

test('autoCrop — trims the white border so the product fills the frame', { skip }, async () => {
  // A tiny 80px product floating in a 400px white field. With autoCrop the
  // white is trimmed first, so the product should fill ~scale² of the canvas.
  // Without it, the whole 400px (mostly white) shrinks and the product stays
  // tiny. Comparing the two proves the trim actually happened.
  const src = await productOnWhite(400, 80, { r: 220, g: 10, b: 10 });

  const cropped = await reframe.reframeImage({
    inputImage: src, canvasW: 400, canvasH: 400, scale: 0.8, autoCrop: true,
    fillMode: 'color', fillColor: '#FFFFFF',
  });
  const plain = await reframe.reframeImage({
    inputImage: src, canvasW: 400, canvasH: 400, scale: 0.8, autoCrop: false,
    fillMode: 'color', fillColor: '#FFFFFF',
  });

  const cropFrac = await fractionColored(cropped);
  const plainFrac = await fractionColored(plain);
  assert.ok(cropFrac > 0.4, `auto-cropped product should fill the frame, got ${cropFrac.toFixed(3)}`);
  assert.ok(plainFrac < 0.1, `un-cropped product should stay tiny, got ${plainFrac.toFixed(3)}`);
  assert.ok(cropFrac > plainFrac * 4, 'auto-crop should massively enlarge the product');
});

test('autoCrop — a uniform image (nothing to trim) falls back without throwing', { skip }, async () => {
  const src = await solid(300, 300, { r: 255, g: 255, b: 255 });
  const out = await reframe.reframeImage({
    inputImage: src, canvasW: 500, canvasH: 500, scale: 0.9, autoCrop: true,
    fillMode: 'color', fillColor: '#FFFFFF',
  });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 500);
  assert.equal(meta.height, 500);
});

test('parseHexColor — expands #RGB and rejects garbage', { skip }, () => {
  assert.deepEqual(reframe.parseHexColor('#abc'), { r: 170, g: 187, b: 204, alpha: 1 });
  assert.deepEqual(reframe.parseHexColor('#FF8800'), { r: 255, g: 136, b: 0, alpha: 1 });
  // Invalid → white fallback.
  assert.deepEqual(reframe.parseHexColor('not-a-colour'), { r: 255, g: 255, b: 255, alpha: 1 });
});
