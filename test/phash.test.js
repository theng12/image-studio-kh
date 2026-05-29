/**
 * v0.28.0: tests for the perceptual-hash engine (main/util/phash.js) that
 * powers near-duplicate detection.
 *
 * The pure bit-math (hammingDistance, similarityPct, pctToMaxDistance,
 * groupByHamming) runs with no native deps. The image-hashing checks need
 * a loadable sharp binary; after a dual-arch `npm run dist` the on-disk
 * sharp can be the other arch, so those self-skip when sharp won't load
 * (npm run postinstall rebuilds the host-arch binary).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const phash = require('../main/util/phash');

let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* arch mismatch → skip image tests */ }
const skipImg = !sharp;

/* ── pure bit math (always run) ─────────────────────────────────── */

test('hammingDistance — identical hashes are distance 0', () => {
  assert.equal(phash.hammingDistance('00ff00ff00ff00ff', '00ff00ff00ff00ff'), 0);
});

test('hammingDistance — one differing nibble counts the right bits', () => {
  // 0x0 ^ 0xf = 0xf = 4 bits set.
  assert.equal(phash.hammingDistance('0000000000000000', '000000000000000f'), 4);
});

test('hammingDistance — malformed / mismatched input reads as max distance', () => {
  assert.equal(phash.hammingDistance(null, '00ff00ff00ff00ff'), phash.BITS);
  assert.equal(phash.hammingDistance('abc', 'abcd'), phash.BITS);
});

test('similarityPct — identical = 100, opposite = 0', () => {
  assert.equal(phash.similarityPct('0000000000000000', '0000000000000000'), 100);
  assert.equal(phash.similarityPct('0000000000000000', 'ffffffffffffffff'), 0);
});

test('pctToMaxDistance — maps similarity % to a bit budget', () => {
  assert.equal(phash.pctToMaxDistance(100), 0);
  assert.equal(phash.pctToMaxDistance(99), 1);   // 0.64 → 1
  assert.equal(phash.pctToMaxDistance(95), 3);   // 3.2 → 3
  assert.equal(phash.pctToMaxDistance(90), 6);   // 6.4 → 6
});

test('groupByHamming — clusters near hashes, drops singletons', () => {
  const items = [
    { id: 'a', hash: '0000000000000000' },
    { id: 'b', hash: '0000000000000001' }, // 1 bit from a
    { id: 'c', hash: 'ffffffffffffffff' }, // far from a/b
    { id: 'd', hash: 'fffffffffffffffe' }, // 1 bit from c
    { id: 'e', hash: '0f0f0f0f0f0f0f0f' }, // alone
  ];
  const groups = phash.groupByHamming(items, 1).map((g) => g.sort());
  // Expect {a,b} and {c,d}; e is a singleton → excluded.
  assert.equal(groups.length, 2);
  const flat = groups.map((g) => g.join(',')).sort();
  assert.deepEqual(flat, ['a,b', 'c,d']);
});

/* ── real image hashing (needs sharp) ───────────────────────────── */

// Vertical blocks of distinct, well-separated gray values → decisive
// horizontal contrast, so each dHash comparison has a stable sign that
// survives a resize + JPEG round-trip. (A smooth gradient/sine is a bad
// fixture: near its flat regions adjacent pixels are nearly equal, so the
// comparison bit flips on the slightest re-encode noise. Real product
// photos sit closer to the high-contrast case.)
async function columnsPng(values, blockW = 7, blockH = 7) {
  const w = values.length * blockW;
  const h = 8 * blockH;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = values[Math.min(values.length - 1, Math.floor(x / blockW))];
      const i = (y * w + x) * 3;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

const COLS = [40, 200, 90, 250, 130, 20, 180, 70, 220];

test('perceptualHash — a re-encoded copy of one photo is a near-duplicate', { skip: skipImg }, async () => {
  const a = await columnsPng(COLS);
  const hashA = await phash.perceptualHash(a);
  // Simulate a re-save: a proportional resize + JPEG recompression.
  // (Proportional — not fit:'cover', which would CROP and shift the
  // column boundaries; that's a different transform than re-compression.)
  const reencoded = await sharp(a).resize({ width: 96 }).jpeg({ quality: 50 }).toBuffer();
  const hashB = await phash.perceptualHash(reencoded);
  assert.equal(typeof hashA, 'string');
  assert.equal(hashA.length, 16);
  const dist = phash.hammingDistance(hashA, hashB);
  assert.ok(dist <= 2, `re-encoded copy should be near-identical, got distance ${dist}`);
});

test('perceptualHash — a structurally different image is NOT a duplicate', { skip: skipImg }, async () => {
  const a = await phash.perceptualHash(await columnsPng(COLS));
  // Reversed column order flips every horizontal comparison → far apart.
  const b = await phash.perceptualHash(await columnsPng([...COLS].reverse()));
  const dist = phash.hammingDistance(a, b);
  assert.ok(dist >= 16, `reversed structure should differ a lot, got distance ${dist}`);
});

test('perceptualHash — returns null on undecodable input', { skip: skipImg }, async () => {
  const out = await phash.perceptualHash(Buffer.from('not an image'));
  assert.equal(out, null);
});
