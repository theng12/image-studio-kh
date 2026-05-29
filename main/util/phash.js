/**
 * Perceptual hashing for near-duplicate image detection (v0.28.0).
 *
 * The problem this solves: our byte-level dedup (SHA-1 of the file in
 * product_images.content_hash) only catches IDENTICAL files. When several
 * client Macs each import their own copy of the same product photo — and
 * those copies got re-saved / re-compressed / EXIF-stripped along the way —
 * the bytes differ, so the SHA-1 differs, so they all land in the library
 * as separate images. Visually they're "99% the same."
 *
 * A perceptual hash fingerprints what the image LOOKS like, not its bytes,
 * so re-encoded copies of one photo get near-identical fingerprints.
 *
 * Algorithm: dHash (difference hash).
 *   1. Downscale to a 9×8 grayscale grid (fit:'fill' — aspect-agnostic).
 *   2. For each row, compare each pixel to its right neighbour → 8 bits/row
 *      × 8 rows = 64 bits. Bit = 1 if left brighter than right.
 *   3. Encode the 64 bits as a 16-char hex string.
 *
 * dHash is robust to scaling, gamma/brightness shifts, and compression
 * artifacts (it only cares about relative brightness gradients), which is
 * exactly the re-save scenario we're targeting. Similarity is the Hamming
 * distance between two hashes (number of differing bits, 0..64).
 *
 * No new dependency — sharp does the downscale; the bit math is pure JS.
 */
const sharp = require('sharp');

const GRID_W = 9; // 9 wide → 8 horizontal comparisons per row
const GRID_H = 8;
const BITS = (GRID_W - 1) * GRID_H; // 64

/**
 * Compute the dHash of an image.
 * @param {Buffer|string} input  image bytes or absolute path
 * @returns {Promise<string>} 16-char lowercase hex (64 bits), or null on failure
 */
async function perceptualHash(input) {
  try {
    const { data } = await sharp(input, { failOn: 'none' })
      .rotate() // honour EXIF orientation so a rotated re-save still matches
      .resize(GRID_W, GRID_H, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // data is GRID_W*GRID_H bytes (1 channel after grayscale).
    let bits = '';
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W - 1; x++) {
        const left = data[y * GRID_W + x];
        const right = data[y * GRID_W + x + 1];
        bits += left > right ? '1' : '0';
      }
    }
    // 64 bits → 16 hex chars.
    let hex = '';
    for (let i = 0; i < BITS; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch (_) {
    return null;
  }
}

const POPCOUNT = (() => {
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) t[i] = (i & 1) + t[i >> 1];
  return t;
})();

/**
 * Hamming distance between two hex dHashes (count of differing bits).
 * Returns BITS (max distance = "completely different") for malformed or
 * mismatched-length input, so bad data never reads as a false match.
 */
function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return BITS;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    const x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    if (Number.isNaN(x)) return BITS;
    dist += POPCOUNT[x];
  }
  return dist;
}

/** Similarity as a 0..100 percentage (100 = identical fingerprint). */
function similarityPct(hexA, hexB) {
  return Math.round((1 - hammingDistance(hexA, hexB) / BITS) * 100);
}

/**
 * Convert a user-facing similarity percentage (e.g. 95) to the max Hamming
 * distance that counts as a duplicate. 99% → ~1 bit, 95% → ~3, 90% → ~6.
 * Clamped to [0, BITS].
 */
function pctToMaxDistance(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.round(((100 - p) / 100) * BITS);
}

/**
 * Group items into near-duplicate clusters via union-find (connected
 * components): two items join the same group when their hashes are within
 * `maxDistance`. Single-linkage, so A~B and B~C puts A,B,C together even if
 * A≁C — fine for the tight thresholds this feature uses, and the review UI
 * surfaces every group before anything is removed.
 *
 * @param {{id:string, hash:string}[]} items
 * @param {number} maxDistance  inclusive Hamming threshold
 * @returns {string[][]} array of groups (each a list of item ids); only
 *          groups with 2+ members are returned (singletons aren't dupes).
 */
function groupByHamming(items, maxDistance) {
  const valid = items.filter((it) => it && typeof it.hash === 'string' && it.hash.length > 0);
  const n = valid.length;
  const parent = valid.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hammingDistance(valid[i].hash, valid[j].hash) <= maxDistance) union(i, j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(valid[i].id);
  }
  return [...byRoot.values()].filter((g) => g.length >= 2);
}

module.exports = {
  perceptualHash,
  hammingDistance,
  similarityPct,
  pctToMaxDistance,
  groupByHamming,
  BITS,
};
