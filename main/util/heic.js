/**
 * HEIC/HEIF → JPEG conversion (v0.41.0).
 *
 * iPhone/iPad photos are HEIC by default. The sharp build we ship has libvips
 * with HEIF support compiled for AVIF only — it can't decode HEIC (no HEVC/
 * libde265). So before HEIC bytes hit the sharp import pipeline we transcode
 * them to JPEG. On macOS the system `sips` tool does this with zero extra
 * dependencies (and the app ships macOS-only). On other platforms we leave the
 * file untouched and let sharp try (it'll throw a clear error the caller
 * surfaces as a failed import).
 *
 * Pure-ish: only touches the temp dir + spawns sips. No DB, no Electron.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const HEIC_EXT_RE = /\.(heic|heif)$/i;

// ISO-BMFF: bytes 4..8 are 'ftyp'; 8..12 is the major brand. HEIC files carry
// brands like heic/heix/mif1/msf1 etc. (AVIF uses 'avif'/'avis' — excluded so
// we don't needlessly transcode AVIFs, which sharp CAN read.)
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

function isHeicName(name) {
  return HEIC_EXT_RE.test(name || '');
}

function isHeicBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  return HEIC_BRANDS.has(buf.toString('ascii', 8, 12).toLowerCase());
}

function looksHeic(srcAbs) {
  if (isHeicName(srcAbs)) return true;
  try {
    const fd = fs.openSync(srcAbs, 'r');
    try {
      const head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
      return isHeicBuffer(head);
    } finally { fs.closeSync(fd); }
  } catch (_) { return false; }
}

function sipsToJpeg(srcAbs, outAbs) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', srcAbs, '--out', outAbs], (err) => {
      if (err) reject(new Error(`HEIC → JPEG conversion failed (sips): ${err.message}`));
      else resolve(outAbs);
    });
  });
}

/**
 * If `srcAbs` is a HEIC/HEIF image (by extension or magic bytes) and we're on
 * macOS, transcode it to a temp JPEG and return { path, cleanup }. Otherwise
 * return the original path with cleanup=null. Callers MUST call cleanup() (if
 * present) when done with the path.
 */
async function ensureDecodablePath(srcAbs) {
  if (!srcAbs || process.platform !== 'darwin' || !looksHeic(srcAbs)) {
    return { path: srcAbs, cleanup: null };
  }
  const out = path.join(os.tmpdir(), `iskh-heic-${crypto.randomUUID()}.jpg`);
  await sipsToJpeg(srcAbs, out);
  return {
    path: out,
    cleanup: () => { try { fs.unlinkSync(out); } catch (_) {} },
  };
}

module.exports = { isHeicName, isHeicBuffer, looksHeic, ensureDecodablePath };
