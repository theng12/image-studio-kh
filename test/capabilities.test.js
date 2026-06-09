/**
 * v0.49.51 — capability mapping + capability-based permission checks.
 *
 * isAllowed() resolves a role's capabilities from the DB, which the test
 * runner has no access to (so isAllowed falls back to legacy — covered by
 * permissions.test.js). Here we test the two PURE pieces that the engine
 * is built on: channelCapability() (the channel → capability map) and
 * allowedByCaps() (the gate, given an explicit capability set).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { channelCapability, CAPABILITIES, CAPABILITY_KEYS } = require('../main/util/capabilities');
const { allowedByCaps } = require('../main/util/permissions');

// Helper: a capability Set from a list.
const caps = (...keys) => new Set(keys);

test('channelCapability — baseline reads are baseline', () => {
  for (const ch of ['products:list', 'products:get', 'companies:list', 'dashboard:stats', 'settings:getAll', 'roles:list']) {
    assert.equal(channelCapability(ch), 'baseline', ch);
  }
});

test('channelCapability — product writes vs deletes', () => {
  assert.equal(channelCapability('products:create'), 'products.edit');
  assert.equal(channelCapability('products:update'), 'products.edit');
  assert.equal(channelCapability('products:bulkUpsert'), 'products.edit');
  assert.equal(channelCapability('products:remove'), 'products.delete');
  assert.equal(channelCapability('products:bulkRemove'), 'products.delete');
});

test('channelCapability — image add vs manage vs delete', () => {
  assert.equal(channelCapability('images:importForProduct'), 'images.add');
  assert.equal(channelCapability('images:importFromBytes'), 'images.add');
  assert.equal(channelCapability('files:pickImageFile'), 'images.add');
  assert.equal(channelCapability('images:setMainImage'), 'images.manage');
  assert.equal(channelCapability('images:reorderImages'), 'images.manage');
  assert.equal(channelCapability('images:autoMatchBySku'), 'images.manage');
  assert.equal(channelCapability('images:removeFromProduct'), 'products.delete');
});

test('channelCapability — operations reads vs writes', () => {
  assert.equal(channelCapability('suppliers:list'), 'costing.view');
  assert.equal(channelCapability('pos:getDetail'), 'costing.view');
  assert.equal(channelCapability('pos:listPayments'), 'costing.view');
  assert.equal(channelCapability('costing:suggestedRetail'), 'costing.view');
  assert.equal(channelCapability('suppliers:create'), 'costing.manage');
  assert.equal(channelCapability('pos:addPayment'), 'costing.manage');
  assert.equal(channelCapability('pos:setStatus'), 'costing.manage');
});

test('channelCapability — admin-ish channels map to users/system', () => {
  assert.equal(channelCapability('users:create'), 'users.manage');
  assert.equal(channelCapability('roles:update'), 'users.manage');
  assert.equal(channelCapability('server:start'), 'system.manage');
  assert.equal(channelCapability('settings:changeDataFolder'), 'system.manage');
  assert.equal(channelCapability('backups:restore'), 'system.manage');
  assert.equal(channelCapability('audit:clearHistory'), 'system.manage');
});

test('channelCapability — history reads gated under history.view', () => {
  assert.equal(channelCapability('audit:listRecent'), 'history.view');
  assert.equal(channelCapability('audit:listForEntity'), 'history.view');
});

test('channelCapability — a totally unknown channel is unmapped (null)', () => {
  assert.equal(channelCapability('totally:madeup'), null);
});

test('allowedByCaps — null caps always defers to legacy (null)', () => {
  assert.equal(allowedByCaps(null, 'products:list'), null);
  assert.equal(allowedByCaps(null, 'products:create'), null);
});

test('allowedByCaps — admin star allows everything', () => {
  const admin = caps('*');
  assert.equal(allowedByCaps(admin, 'products:create'), true);
  assert.equal(allowedByCaps(admin, 'users:create'), true);
  assert.equal(allowedByCaps(admin, 'settings:changeDataFolder'), true);
});

test('allowedByCaps — baseline reads allowed for any known role', () => {
  const viewer = caps(); // no capabilities at all
  assert.equal(allowedByCaps(viewer, 'products:list'), true);
  assert.equal(allowedByCaps(viewer, 'dashboard:stats'), true);
});

test('allowedByCaps — viewer (no caps) denied every write', () => {
  const viewer = caps();
  assert.equal(allowedByCaps(viewer, 'products:create'), false);
  assert.equal(allowedByCaps(viewer, 'images:importForProduct'), false);
  assert.equal(allowedByCaps(viewer, 'suppliers:list'), false); // costing.view gated now
  assert.equal(allowedByCaps(viewer, 'audit:listRecent'), false); // history.view gated now
});

test('allowedByCaps — photographer can add images, nothing else', () => {
  const photographer = caps('images.add');
  assert.equal(allowedByCaps(photographer, 'images:importForProduct'), true);
  assert.equal(allowedByCaps(photographer, 'files:pickImageFile'), true);
  assert.equal(allowedByCaps(photographer, 'images:setMainImage'), false); // manage, not add
  assert.equal(allowedByCaps(photographer, 'products:create'), false);
  assert.equal(allowedByCaps(photographer, 'suppliers:list'), false);
});

test('allowedByCaps — a custom "bookkeeper" role: costs yes, catalog edits no', () => {
  const bookkeeper = caps('costing.view', 'costing.manage');
  assert.equal(allowedByCaps(bookkeeper, 'suppliers:list'), true);
  assert.equal(allowedByCaps(bookkeeper, 'pos:addPayment'), true);
  assert.equal(allowedByCaps(bookkeeper, 'pos:getDetail'), true);
  assert.equal(allowedByCaps(bookkeeper, 'products:list'), true); // baseline browse
  assert.equal(allowedByCaps(bookkeeper, 'products:create'), false); // no catalog edit
  assert.equal(allowedByCaps(bookkeeper, 'users:create'), false);
});

test('allowedByCaps — costing.view alone is read-only on operations', () => {
  const analyst = caps('costing.view');
  assert.equal(allowedByCaps(analyst, 'pos:getDetail'), true);
  assert.equal(allowedByCaps(analyst, 'pos:addPayment'), false); // manage, not view
  assert.equal(allowedByCaps(analyst, 'suppliers:create'), false);
});

test('allowedByCaps — unmapped channel for a known role defers to legacy (null)', () => {
  const someRole = caps('products.edit');
  assert.equal(allowedByCaps(someRole, 'totally:madeup'), null);
});

test('CAPABILITIES — every capability key is unique + in CAPABILITY_KEYS', () => {
  const seen = new Set();
  for (const c of CAPABILITIES) {
    assert.ok(!seen.has(c.key), `duplicate capability ${c.key}`);
    seen.add(c.key);
    assert.ok(CAPABILITY_KEYS.has(c.key));
    assert.ok(c.label && c.description && c.group);
  }
  assert.equal(seen.size, CAPABILITY_KEYS.size);
});
