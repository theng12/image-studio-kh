/**
 * v0.20.1: tests for the per-token sliding-window rate limiter.
 *
 * Each test injects an explicit `now` timestamp so we don't depend
 * on wall-clock advancement. Calls reset() at the top of each test
 * to start from a known empty state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRate, reset, WINDOW_MS, LIMIT } = require('../main/server/rateLimit');

test('rate limiter — allows the first call', () => {
  reset();
  const r = checkRate('user-1', 1000);
  assert.equal(r.ok, true);
});

test('rate limiter — allows up to LIMIT calls inside a window', () => {
  reset();
  for (let i = 0; i < LIMIT; i++) {
    assert.equal(checkRate('user-1', 1000 + i).ok, true, `call ${i + 1} should be allowed`);
  }
});

test('rate limiter — rejects the LIMIT+1 call inside a window', () => {
  reset();
  for (let i = 0; i < LIMIT; i++) checkRate('user-1', 1000 + i);
  const r = checkRate('user-1', 1000 + LIMIT);
  assert.equal(r.ok, false);
  assert.equal(typeof r.retryAfterMs, 'number');
  assert.ok(r.retryAfterMs > 0, 'should suggest a positive retry window');
});

test('rate limiter — retryAfter shrinks as the window slides', () => {
  reset();
  for (let i = 0; i < LIMIT; i++) checkRate('user-1', 1000 + i);
  const r1 = checkRate('user-1', 1000 + LIMIT);
  const r2 = checkRate('user-1', 1500 + LIMIT);
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.ok(r2.retryAfterMs < r1.retryAfterMs);
});

test('rate limiter — allows again after the window passes', () => {
  reset();
  for (let i = 0; i < LIMIT; i++) checkRate('user-1', 1000);
  // All those calls happened at t=1000. After WINDOW_MS they expire.
  const r = checkRate('user-1', 1000 + WINDOW_MS + 1);
  assert.equal(r.ok, true);
});

test('rate limiter — separate users have independent buckets', () => {
  reset();
  for (let i = 0; i < LIMIT; i++) checkRate('user-1', 1000 + i);
  // user-1 is now at the limit, but user-2 has used zero.
  const r = checkRate('user-2', 1000 + LIMIT);
  assert.equal(r.ok, true);
});

test('rate limiter — missing userId allows the call', () => {
  reset();
  assert.equal(checkRate(null, 1000).ok, true);
  assert.equal(checkRate(undefined, 1000).ok, true);
});

test('rate limiter — reset clears all buckets', () => {
  for (let i = 0; i < LIMIT; i++) checkRate('user-1', 1000 + i);
  reset();
  assert.equal(checkRate('user-1', 1000 + LIMIT).ok, true);
});
