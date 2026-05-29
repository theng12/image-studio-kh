/**
 * v0.20.1: tests for the shared slugify helper. This rule shows up
 * everywhere — asset filenames, folder names, export tokens — so
 * regressions here cause silent file-path drift across the app.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { slugify } = require('../main/util/slug');

test('slugify — collapses non-alnum runs to a single dash', () => {
  assert.equal(slugify('hello world'), 'hello-world');
  assert.equal(slugify('foo  bar / baz'), 'foo-bar-baz');
});

test('slugify — preserves case (v0.11.6)', () => {
  assert.equal(slugify('BF-R5232-GD'), 'BF-R5232-GD');
  assert.equal(slugify('KT-Ceramic'), 'KT-Ceramic');
});

test('slugify — trims leading and trailing dashes', () => {
  assert.equal(slugify('---hello---'), 'hello');
  assert.equal(slugify('!!!world!!!'), 'world');
});

test('slugify — caps result at 60 chars', () => {
  const long = 'A'.repeat(100);
  const out = slugify(long);
  assert.equal(out.length, 60);
  assert.equal(out, 'A'.repeat(60));
});

test('slugify — returns the fallback when result would be empty', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('!!!!'), '');
  assert.equal(slugify('---'), '');
  assert.equal(slugify(null, 'unassigned'), 'unassigned');
  assert.equal(slugify(undefined, 'unknown'), 'unknown');
  assert.equal(slugify('   ', 'fallback'), 'fallback');
});

test('slugify — handles numbers + letters mixed', () => {
  assert.equal(slugify('SKU-123-ABC'), 'SKU-123-ABC');
  assert.equal(slugify('42'), '42');
});

test('slugify — strips emoji + non-ASCII runs', () => {
  // We only keep [A-Za-z0-9]; everything else collapses to a dash.
  assert.equal(slugify('café-rouge'), 'caf-rouge');
  assert.equal(slugify('🚀 launch'), 'launch');
});

test('slugify — coerces non-string inputs', () => {
  assert.equal(slugify(42), '42');
  assert.equal(slugify(true), 'true');
});
