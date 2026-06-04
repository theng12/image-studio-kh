/**
 * v0.49.43: tests for client-mode 429 retry/backoff math. The server's
 * /api/rpc limiter (120/10s) returns a Retry-After header; the client
 * honours it and retries a bounded number of times instead of failing
 * the operation. These guard the wait computation + retry cap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_RETRIES,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  parseRetryAfterMs,
  retryWaitMs,
  shouldRetry,
} = require('../main/util/rateLimitRetry');

/* ── parseRetryAfterMs ─────────────────────────────────────────── */

test('parseRetryAfterMs — integer seconds → ms', () => {
  assert.equal(parseRetryAfterMs('1'), 1000);
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs(2), 2000);
  assert.equal(parseRetryAfterMs('0'), 0);
});

test('parseRetryAfterMs — missing / non-numeric → null', () => {
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(undefined), null);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT'), null); // HTTP-date form ignored
  assert.equal(parseRetryAfterMs('soon'), null);
});

/* ── retryWaitMs ───────────────────────────────────────────────── */

test('retryWaitMs — honours Retry-After header, clamped', () => {
  assert.equal(retryWaitMs('1', 0), 1000);   // server said 1s
  assert.equal(retryWaitMs('3', 0), 3000);
  assert.equal(retryWaitMs('0', 0), MIN_WAIT_MS); // 0s → floored, don't busy-spin
  assert.equal(retryWaitMs('999', 0), MAX_WAIT_MS); // absurd → capped
});

test('retryWaitMs — exponential backoff when no header', () => {
  assert.equal(retryWaitMs(null, 0), 500);
  assert.equal(retryWaitMs(null, 1), 1000);
  assert.equal(retryWaitMs(null, 2), 2000);
  assert.equal(retryWaitMs(null, 3), 4000);
  assert.equal(retryWaitMs(null, 4), 8000);
  assert.equal(retryWaitMs(null, 5), MAX_WAIT_MS); // capped
});

test('retryWaitMs — always within [MIN, MAX]', () => {
  for (let a = 0; a < 10; a++) {
    const w = retryWaitMs(null, a);
    assert.ok(w >= MIN_WAIT_MS && w <= MAX_WAIT_MS, `attempt ${a} → ${w}`);
  }
});

/* ── shouldRetry ───────────────────────────────────────────────── */

test('shouldRetry — bounded by MAX_RETRIES', () => {
  assert.equal(shouldRetry(0), true);
  assert.equal(shouldRetry(MAX_RETRIES - 1), true);
  assert.equal(shouldRetry(MAX_RETRIES), false);
  assert.equal(shouldRetry(MAX_RETRIES + 3), false);
});
