/**
 * Auto-enhance engine (v0.40.0).
 *
 * A free, local "make this hand-taken phone shot look decent" pass built on
 * sharp — no AI, no network. Three stages, each independently toggleable:
 *
 *   1. White balance (gray-world): neutralises colour casts (the warm/yellow
 *      tint of indoor light, the blue of shade) by scaling each RGB channel so
 *      their averages match. Gains are clamped so a legitimately coloured scene
 *      isn't wrecked.
 *   2. Auto-levels (sharp .normalize): stretches luminance to the full range,
 *      lifting dull/underexposed shots. Luminance-based, so it doesn't re-introduce
 *      the cast the white-balance step just removed.
 *   3. Modulate: a gentle brightness + saturation nudge for a punchier catalog look.
 *
 * Pure image-in → image-out (Buffer or absolute path) → PNG Buffer; the caller
 * re-encodes to the source's own format. No DB, no fs, no Electron.
 */
const sharp = require('sharp');

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * @param {Buffer|string} input
 * @param {object} [opts]
 * @param {boolean} [opts.whiteBalance=true]
 * @param {boolean} [opts.autoLevels=true]
 * @param {number}  [opts.saturation=1.08]  1 = unchanged
 * @param {number}  [opts.brightness=1.0]   1 = unchanged
 * @returns {Promise<Buffer>} PNG bytes
 */
async function autoEnhance(input, {
  whiteBalance = true,
  autoLevels = true,
  saturation = 1.08,
  brightness = 1.0,
} = {}) {
  let pipeline = sharp(input, { failOn: 'none' }).rotate(); // bake EXIF orientation

  if (whiteBalance) {
    try {
      const stats = await sharp(input, { failOn: 'none' }).rotate().stats();
      const ch = stats.channels || [];
      if (ch.length >= 3) {
        const [r, g, b] = ch;
        const rm = r.mean || 0; const gm = g.mean || 0; const bm = b.mean || 0;
        const avg = (rm + gm + bm) / 3;
        // Only correct when there's real signal (skip near-black / single-colour).
        if (avg > 4 && rm > 1 && gm > 1 && bm > 1) {
          const gains = [avg / rm, avg / gm, avg / bm].map((x) => clamp(x, 0.6, 1.8));
          // Keep a 4th gain for any alpha channel so .linear doesn't choke on RGBA.
          const arr = ch.length >= 4 ? [...gains, 1] : gains;
          pipeline = pipeline.linear(arr, ch.length >= 4 ? [0, 0, 0, 0] : [0, 0, 0]);
        }
      }
    } catch (_) { /* stats failed → skip WB, keep going */ }
  }

  if (autoLevels) pipeline = pipeline.normalize();

  const sat = clamp(Number(saturation) || 1, 0.1, 3);
  const bri = clamp(Number(brightness) || 1, 0.1, 3);
  if (sat !== 1 || bri !== 1) pipeline = pipeline.modulate({ saturation: sat, brightness: bri });

  return pipeline.png({ compressionLevel: 7 }).toBuffer();
}

module.exports = { autoEnhance };
