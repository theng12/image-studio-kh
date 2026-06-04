/**
 * v0.49.43: client-mode retry/backoff math for HTTP 429 (rate limited).
 *
 * The server's /api/rpc limiter (main/server/rateLimit.js) returns a 429
 * with a `Retry-After: <seconds>` header when a token exceeds 120 calls
 * per 10s. Until now the client just threw, so a brief burst (e.g. a
 * post-bulk-op refetch storm) failed the whole operation. Now the client
 * waits and retries a bounded number of times.
 *
 * Pulled into a dependency-free helper so the wait math is unit-testable
 * without booting Electron (main/client/index.js requires electron at
 * load) — same pattern as backupSafety.js / exportIndex.js / slug.js.
 */

const MAX_RETRIES = 5;       // total attempts after the first = 5
const BASE_MS = 500;         // exponential base when no header is present
const MAX_WAIT_MS = 8_000;   // never sleep longer than this between tries
const MIN_WAIT_MS = 250;     // …or shorter than this

/**
 * Parse a `Retry-After` header value into milliseconds. The server only
 * ever sends an integer number of seconds, so we handle that form (and
 * ignore the HTTP-date form, returning null → caller falls back to
 * exponential backoff).
 */
function parseRetryAfterMs(headerValue) {
  if (headerValue == null) return null;
  const secs = Number(String(headerValue).trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  return null;
}

/**
 * How long to wait before retry attempt `attempt` (0-based: 0 = the
 * first retry). Honours the server's Retry-After when present, otherwise
 * backs off exponentially. Always clamped to [MIN_WAIT_MS, MAX_WAIT_MS].
 *
 * @param {string|number|null} headerValue  the Retry-After header, if any
 * @param {number} attempt                  0-based retry index
 * @returns {number} milliseconds to sleep
 */
function retryWaitMs(headerValue, attempt) {
  const fromHeader = parseRetryAfterMs(headerValue);
  const base = fromHeader != null
    ? fromHeader
    : BASE_MS * Math.pow(2, Math.max(0, attempt)); // 500, 1000, 2000, …
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, base));
}

/** Should we retry a 429 given how many retries we've already done? */
function shouldRetry(attempt) {
  return attempt < MAX_RETRIES;
}

module.exports = {
  MAX_RETRIES,
  BASE_MS,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  parseRetryAfterMs,
  retryWaitMs,
  shouldRetry,
};
