/**
 * v0.45.0: tests for the role ACL (main/util/permissions.js). Pure JS, no
 * DB / no Electron. Locks the per-role allow/deny behaviour and the
 * fail-safe default for unknown roles + unknown-to-restricted-roles channels.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, isAllowed, READ_CHANNELS, ADMIN_ONLY_CHANNELS, PHOTOGRAPHER_EXTRA } = require('../main/util/permissions');

test('ROLES — exactly the four expected roles, in the documented order', () => {
  assert.deepEqual(ROLES, ['admin', 'editor', 'photographer', 'viewer']);
});

test('admin — allowed for every conceivable channel, including unknown ones', () => {
  assert.equal(isAllowed('admin', 'products:list'), true);
  assert.equal(isAllowed('admin', 'products:remove'), true);
  assert.equal(isAllowed('admin', 'users:create'), true);
  assert.equal(isAllowed('admin', 'some:future:channel'), true);
});

test('editor — denied admin-only, allowed for everything else', () => {
  assert.equal(isAllowed('editor', 'users:create'), false);
  assert.equal(isAllowed('editor', 'app:relaunch'), false);
  assert.equal(isAllowed('editor', 'products:list'), true);
  assert.equal(isAllowed('editor', 'products:remove'), true);
  assert.equal(isAllowed('editor', 'images:autoCropProducts'), true);
  assert.equal(isAllowed('editor', 'exports:catalogCsv'), true);
  // Editor passes through on an unknown channel — by design, editor is trusted.
  assert.equal(isAllowed('editor', 'some:future:channel'), true);
});

test('photographer — reads + image add only; no delete, edit, bulk, or admin', () => {
  // Reads
  assert.equal(isAllowed('photographer', 'products:list'), true);
  assert.equal(isAllowed('photographer', 'images:listByProduct'), true);
  assert.equal(isAllowed('photographer', 'companies:setActive'), true);
  // Image add — the whole point of the role
  assert.equal(isAllowed('photographer', 'images:importFromBytes'), true);
  assert.equal(isAllowed('photographer', 'files:pickImageFile'), true);
  // Denied writes
  assert.equal(isAllowed('photographer', 'images:removeFromProduct'), false);
  assert.equal(isAllowed('photographer', 'images:setMainImage'), false);
  assert.equal(isAllowed('photographer', 'products:update'), false);
  assert.equal(isAllowed('photographer', 'images:autoCropProducts'), false);
  assert.equal(isAllowed('photographer', 'exports:catalogCsv'), false);
  // Denied admin
  assert.equal(isAllowed('photographer', 'users:create'), false);
  // Fail-safe — unknown channel → deny
  assert.equal(isAllowed('photographer', 'some:future:channel'), false);
});

test('viewer — strictly reads; cannot add, delete, or do anything else', () => {
  // Reads
  assert.equal(isAllowed('viewer', 'products:list'), true);
  assert.equal(isAllowed('viewer', 'products:get'), true);
  assert.equal(isAllowed('viewer', 'images:listByProduct'), true);
  assert.equal(isAllowed('viewer', 'categories:list'), true);
  assert.equal(isAllowed('viewer', 'dashboard:stats'), true);
  // Denied — every kind of write
  assert.equal(isAllowed('viewer', 'images:importFromBytes'), false); // even add is denied
  assert.equal(isAllowed('viewer', 'images:removeFromProduct'), false);
  assert.equal(isAllowed('viewer', 'products:update'), false);
  assert.equal(isAllowed('viewer', 'exports:catalogCsv'), false);
  assert.equal(isAllowed('viewer', 'users:create'), false);
  // Fail-safe
  assert.equal(isAllowed('viewer', 'some:future:channel'), false);
});

test('unknown role — always denied, even for obvious reads', () => {
  assert.equal(isAllowed('superuser', 'products:list'), false);
  assert.equal(isAllowed('', 'products:list'), false);
  assert.equal(isAllowed(null, 'products:list'), false);
  assert.equal(isAllowed(undefined, 'products:list'), false);
});

test('disjoint sets — a channel never appears in more than one category', () => {
  for (const ch of READ_CHANNELS) {
    assert.ok(!PHOTOGRAPHER_EXTRA.has(ch), `${ch} is in both READ_CHANNELS and PHOTOGRAPHER_EXTRA`);
    assert.ok(!ADMIN_ONLY_CHANNELS.has(ch), `${ch} is in both READ_CHANNELS and ADMIN_ONLY_CHANNELS`);
  }
  for (const ch of PHOTOGRAPHER_EXTRA) {
    assert.ok(!ADMIN_ONLY_CHANNELS.has(ch), `${ch} is in both PHOTOGRAPHER_EXTRA and ADMIN_ONLY_CHANNELS`);
  }
});

test('integration spot-checks — the obviously-sensitive channels', () => {
  // Every role except admin must be DENIED on user management.
  for (const r of ['editor', 'photographer', 'viewer']) {
    assert.equal(isAllowed(r, 'users:create'), false, `${r} should not be able to create users`);
    assert.equal(isAllowed(r, 'server:start'), false, `${r} should not be able to start server`);
  }
  // Every role except admin/editor must be DENIED on catalog deletes.
  for (const r of ['photographer', 'viewer']) {
    assert.equal(isAllowed(r, 'products:remove'), false);
    assert.equal(isAllowed(r, 'images:removeFromProduct'), false);
  }
});
