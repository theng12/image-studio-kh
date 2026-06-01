/**
 * v0.41.0: tests for HEIC detection (main/util/heic.js). Pure JS — no sharp,
 * no sips invoked (the sips conversion needs a real HEIC + macOS, exercised
 * manually). These lock the detection logic that decides WHETHER to convert.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isHeicName, isHeicBuffer, looksHeic, ensureDecodablePath } = require('../main/util/heic');

// Minimal ISO-BMFF ftyp box: [size]'ftyp'[major brand][...]
function ftyp(brand) {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from(brand, 'ascii'),
    Buffer.from('mif1', 'ascii'),
  ]);
}
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

test('isHeicName — extension match, case-insensitive', () => {
  assert.equal(isHeicName('IMG_4021.HEIC'), true);
  assert.equal(isHeicName('photo.heif'), true);
  assert.equal(isHeicName('photo.jpg'), false);
  assert.equal(isHeicName('photo.png'), false);
  assert.equal(isHeicName(''), false);
});

test('isHeicBuffer — recognises HEIC brands, rejects AVIF/JPEG', () => {
  assert.equal(isHeicBuffer(ftyp('heic')), true);
  assert.equal(isHeicBuffer(ftyp('heix')), true);
  assert.equal(isHeicBuffer(ftyp('mif1')), true);
  assert.equal(isHeicBuffer(ftyp('avif')), false); // AVIF — sharp can read it
  assert.equal(isHeicBuffer(JPEG_MAGIC), false);
  assert.equal(isHeicBuffer(Buffer.alloc(4)), false);
});

test('looksHeic — detects by magic bytes even when the extension lies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskh-heic-test-'));
  try {
    const heicMislabeled = path.join(dir, 'photo.jpg'); // .jpg name, HEIC bytes
    fs.writeFileSync(heicMislabeled, ftyp('heic'));
    assert.equal(looksHeic(heicMislabeled), true);

    const realJpeg = path.join(dir, 'real.jpg');
    fs.writeFileSync(realJpeg, JPEG_MAGIC);
    assert.equal(looksHeic(realJpeg), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDecodablePath — passes non-HEIC straight through (no temp, no cleanup)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskh-heic-test-'));
  try {
    const jpg = path.join(dir, 'real.jpg');
    fs.writeFileSync(jpg, JPEG_MAGIC);
    const res = await ensureDecodablePath(jpg);
    assert.equal(res.path, jpg);
    assert.equal(res.cleanup, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
