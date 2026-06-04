/**
 * v0.49.42: tests for per-profile {INDEX} export-token formatting.
 * Covers pad clamping, prefix sanitisation, and the rendered token for
 * the schemes users asked for (1 / 01 / 001 / 0001, A1, B001, …).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PAD,
  clampIndexPad,
  sanitizeIndexPrefix,
  formatIndexToken,
} = require('../main/util/exportIndex');

/* ── clampIndexPad ─────────────────────────────────────────────── */

test('clampIndexPad — clamps into [1,4]', () => {
  assert.equal(clampIndexPad(1), 1);
  assert.equal(clampIndexPad(4), 4);
  assert.equal(clampIndexPad(0), 1);
  assert.equal(clampIndexPad(9), 4);
  assert.equal(clampIndexPad(-3), 1);
});

test('clampIndexPad — falls back to default for junk/missing', () => {
  assert.equal(clampIndexPad(undefined), DEFAULT_PAD);
  assert.equal(clampIndexPad(null), DEFAULT_PAD);
  assert.equal(clampIndexPad('abc'), DEFAULT_PAD);
  assert.equal(clampIndexPad('3'), 3); // numeric strings are fine
});

/* ── sanitizeIndexPrefix ───────────────────────────────────────── */

test('sanitizeIndexPrefix — keeps alphanumerics only', () => {
  assert.equal(sanitizeIndexPrefix('A'), 'A');
  assert.equal(sanitizeIndexPrefix('REV2'), 'REV2');
  assert.equal(sanitizeIndexPrefix(''), '');
});

test('sanitizeIndexPrefix — strips unsafe chars and path separators', () => {
  assert.equal(sanitizeIndexPrefix('A-'), 'A');
  assert.equal(sanitizeIndexPrefix('../x'), 'x');
  assert.equal(sanitizeIndexPrefix('a b/c'), 'abc');
  assert.equal(sanitizeIndexPrefix('A_1'), 'A1');
});

test('sanitizeIndexPrefix — caps length and rejects non-strings', () => {
  assert.equal(sanitizeIndexPrefix('ABCDEFGHIJK').length, 8);
  assert.equal(sanitizeIndexPrefix(null), '');
  assert.equal(sanitizeIndexPrefix(42), '');
});

/* ── formatIndexToken ──────────────────────────────────────────── */

test('formatIndexToken — default is 3-digit, 1-based', () => {
  assert.equal(formatIndexToken(0), '001');
  assert.equal(formatIndexToken(1), '002');
  assert.equal(formatIndexToken(9), '010');
});

test('formatIndexToken — honours pad width 1–4', () => {
  assert.equal(formatIndexToken(0, { indexPad: 1 }), '1');
  assert.equal(formatIndexToken(0, { indexPad: 2 }), '01');
  assert.equal(formatIndexToken(0, { indexPad: 3 }), '001');
  assert.equal(formatIndexToken(0, { indexPad: 4 }), '0001');
});

test('formatIndexToken — applies a fixed prefix', () => {
  assert.equal(formatIndexToken(0, { indexPad: 1, indexPrefix: 'A' }), 'A1');
  assert.equal(formatIndexToken(1, { indexPad: 1, indexPrefix: 'B' }), 'B2');
  assert.equal(formatIndexToken(0, { indexPad: 3, indexPrefix: 'A' }), 'A001');
  assert.equal(formatIndexToken(11, { indexPad: 4, indexPrefix: 'REV' }), 'REV0012');
});

test('formatIndexToken — sanitises a hostile prefix before use', () => {
  assert.equal(formatIndexToken(0, { indexPad: 3, indexPrefix: '../' }), '001');
  assert.equal(formatIndexToken(0, { indexPad: 2, indexPrefix: 'A/B' }), 'AB01');
});

test('formatIndexToken — tolerates bad imageIndex', () => {
  assert.equal(formatIndexToken(undefined), '001');
  assert.equal(formatIndexToken(-5), '001');
  assert.equal(formatIndexToken('2'), '003');
});
