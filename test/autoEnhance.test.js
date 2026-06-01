/**
 * v0.40.0: tests for the auto-enhance engine (main/util/autoEnhance.js).
 * Exercises the real sharp pipeline, so self-skip on an arch-mismatched
 * native binary (same guard as reframe.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

let sharp = null;
let autoEnhance = null;
try {
  sharp = require('sharp');
  ({ autoEnhance } = require('../main/util/autoEnhance'));
} catch (_) { /* sharp unavailable → skip */ }

const skip = !sharp || !autoEnhance;

async function solid(w, h, rgb) {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();
}

async function channelMeans(buf) {
  const stats = await sharp(buf).stats();
  return stats.channels.slice(0, 3).map((c) => c.mean);
}

test('white balance — gray-world neutralises a warm colour cast', { skip }, async () => {
  // Strongly warm: lots of red, little blue. After gray-world WB the three
  // channel means should be close to equal.
  const src = await solid(80, 80, { r: 200, g: 150, b: 90 });
  const out = await autoEnhance(src, { whiteBalance: true, autoLevels: false, saturation: 1, brightness: 1 });
  const [r, g, b] = await channelMeans(out);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  assert.ok(spread < 12, `channels should be near-neutral after WB, spread=${spread.toFixed(1)} (r${r.toFixed(0)} g${g.toFixed(0)} b${b.toFixed(0)})`);
});

test('output keeps the source dimensions (non-square, full pipeline)', { skip }, async () => {
  const src = await solid(120, 80, { r: 120, g: 110, b: 100 });
  const out = await autoEnhance(src, {});
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 120);
  assert.equal(meta.height, 80);
});

test('near-black image — WB self-skips without throwing', { skip }, async () => {
  const src = await solid(60, 60, { r: 1, g: 1, b: 2 });
  const out = await autoEnhance(src, { whiteBalance: true, autoLevels: false, saturation: 1, brightness: 1 });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 60);
  assert.equal(meta.height, 60);
});

test('saturation = 100% + brightness = 100% + no WB/levels ≈ passthrough', { skip }, async () => {
  const src = await solid(50, 50, { r: 130, g: 120, b: 110 });
  const out = await autoEnhance(src, { whiteBalance: false, autoLevels: false, saturation: 1, brightness: 1 });
  const [r, g, b] = await channelMeans(out);
  assert.ok(Math.abs(r - 130) < 4 && Math.abs(g - 120) < 4 && Math.abs(b - 110) < 4, `expected ~130/120/110, got ${r.toFixed(0)}/${g.toFixed(0)}/${b.toFixed(0)}`);
});
