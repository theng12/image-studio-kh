/**
 * v0.20.0: per-token sliding-window rate limiter for /api/rpc.
 *
 * Tracks a circular buffer of timestamps per user-id. On each call,
 * we drop timestamps older than WINDOW_MS, then check whether the
 * remaining count is below LIMIT. If yes, push the new timestamp
 * and allow. If no, reject with a Retry-After hint.
 *
 * Defaults: 120 calls per 10s — comfortably above a normal user's
 * Library-browsing burst (refresh fires ~10 RPCs, bulk operations
 * fire one per write), but tight enough to detect a runaway loop
 * or a malicious caller hammering the endpoint.
 *
 * Per-token (not per-IP) because authenticated users are the unit
 * of trust here. An admin can run multiple clients on a Tailscale
 * network from a single IP; we shouldn't lump them together.
 */

const WINDOW_MS = 10_000;
const LIMIT = 120;

const _hits = new Map(); // userId → array<timestamp>

/**
 * Returns `{ ok: true }` if the call is within the rate limit, or
 * `{ ok: false, retryAfterMs }` if it isn't. Callers should send a
 * 429 with Retry-After: <ceil(retryAfterMs/1000)> on rejection.
 *
 * If `userId` is falsy (shouldn't happen — authenticate() runs
 * first), we allow the call. Defensive: don't block valid
 * server-internal traffic if something upstream loses the user id.
 */
function checkRate(userId, now = Date.now()) {
  if (!userId) return { ok: true };
  let buf = _hits.get(userId);
  if (!buf) {
    buf = [];
    _hits.set(userId, buf);
  }
  // Drop expired entries. The buffer is FIFO so we can shift from
  // the front until the head is within the window.
  const cutoff = now - WINDOW_MS;
  while (buf.length > 0 && buf[0] < cutoff) buf.shift();

  if (buf.length >= LIMIT) {
    const oldest = buf[0];
    return { ok: false, retryAfterMs: Math.max(50, (oldest + WINDOW_MS) - now) };
  }
  buf.push(now);
  return { ok: true };
}

/**
 * Drop all rate-limit state. Used by tests + the server-stop path
 * so a token revoke doesn't leave stale entries around.
 */
function reset() {
  _hits.clear();
}

module.exports = { checkRate, reset, WINDOW_MS, LIMIT };
