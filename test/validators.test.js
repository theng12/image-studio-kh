/**
 * v0.20.1: tests for the RPC validator registry in
 * main/server/validators.js. These exercise the pure-JS validation
 * logic; no DB, no Electron, no native modules.
 *
 * Run with: `npm test`
 *
 * Each test pair checks one "good" args shape and at least one
 * "bad" shape to confirm the validator rejects with a useful
 * message. Validators return `true` on success or a string error
 * on failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { getValidator } = require('../main/server/validators');

test('products:update — rejects missing id', () => {
  const v = getValidator('products:update');
  assert.notEqual(v, null);
  const err = v({ patch: { name: 'Hi' } });
  assert.equal(typeof err, 'string');
  assert.match(err, /missing required field: id|id must/);
});

test('products:update — rejects non-object patch', () => {
  const v = getValidator('products:update');
  const err = v({ id: 'p1', patch: 'not an object' });
  assert.equal(typeof err, 'string');
  assert.match(err, /patch must be an object/);
});

test('products:update — accepts valid args', () => {
  const v = getValidator('products:update');
  assert.equal(v({ id: 'p1', patch: { name: 'Hi' } }), true);
});

test('products:create — rejects empty sku', () => {
  const v = getValidator('products:create');
  const err = v({ companyId: 'c1', sku: '   ' });
  assert.match(err, /sku is required/);
});

test('products:create — rejects missing companyId', () => {
  const v = getValidator('products:create');
  const err = v({ sku: 'ABC' });
  assert.match(err, /companyId is required/);
});

test('products:create — accepts the bare minimum', () => {
  const v = getValidator('products:create');
  assert.equal(v({ companyId: 'c1', sku: 'ABC' }), true);
});

test('products:remove — accepts a string id', () => {
  const v = getValidator('products:remove');
  assert.equal(v('p1'), true);
});

test('products:remove — rejects an object', () => {
  const v = getValidator('products:remove');
  const err = v({ id: 'p1' });
  assert.match(err, /must be a string/);
});

test('products:bulkUpdate — caps ids length', () => {
  const v = getValidator('products:bulkUpdate');
  const ids = new Array(5001).fill('x');
  const err = v({ ids, patch: { status: 'active' } });
  assert.match(err, /too large/);
});

test('products:bulkUpdate — rejects non-array ids', () => {
  const v = getValidator('products:bulkUpdate');
  const err = v({ ids: 'p1', patch: {} });
  assert.match(err, /ids must be an array/);
});

test('products:bulkUpdate — accepts valid args', () => {
  const v = getValidator('products:bulkUpdate');
  assert.equal(v({ ids: ['a', 'b'], patch: { status: 'active' } }), true);
});

test('images:importFromBytes — rejects missing bytes', () => {
  const v = getValidator('images:importFromBytes');
  const err = v({ productId: 'p1' });
  assert.match(err, /bytes required/);
});

test('images:importFromBytes — accepts wire envelope shape', () => {
  const v = getValidator('images:importFromBytes');
  assert.equal(
    v({ productId: 'p1', bytes: { __bin: true, b64: 'AAAA' }, ext: '.jpg' }),
    true,
  );
});

test('images:importFromBytes — accepts buffer-like shape', () => {
  const v = getValidator('images:importFromBytes');
  assert.equal(
    v({ productId: 'p1', bytes: Buffer.from('hi'), ext: '.jpg' }),
    true,
  );
});

test('ai:queueTask — rejects empty prompt', () => {
  const v = getValidator('ai:queueTask');
  const err = v({ companyId: 'c1', provider: 'fal', model: 'm', prompt: '   ' });
  assert.match(err, /prompt required/);
});

test('ai:queueTask — accepts valid args', () => {
  const v = getValidator('ai:queueTask');
  assert.equal(
    v({ companyId: 'c1', provider: 'fal', model: 'm', prompt: 'a desk' }),
    true,
  );
});

test('search:global — rejects non-string query', () => {
  const v = getValidator('search:global');
  const err = v({ query: 123 });
  assert.match(err, /query must be a string/);
});

test('search:global — accepts query + numeric limit', () => {
  const v = getValidator('search:global');
  assert.equal(v({ query: 'BBC', limit: 30 }), true);
});

test('companies:setActive — accepts null id (clear)', () => {
  const v = getValidator('companies:setActive');
  assert.equal(v(null), true);
});

test('companies:setActive — accepts string id', () => {
  const v = getValidator('companies:setActive');
  assert.equal(v('c1'), true);
});

test('companies:setActive — rejects number id', () => {
  const v = getValidator('companies:setActive');
  const err = v(42);
  assert.match(err, /string or null/);
});

test('unknown channel — getValidator returns null', () => {
  assert.equal(getValidator('does:not:exist'), null);
});
