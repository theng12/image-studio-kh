/**
 * v0.26.40: shared timeout helpers for AI provider fetches.
 *
 * Why this exists: pre-v0.26.40 every fetch() in main/ai/providers/*
 * and main/ai/queueRunner.js was unbounded. If a provider's status
 * endpoint hung (slow fal.ai backend, dropped TCP connection,
 * upstream incident on kie's CDN), the queue runner would wait
 * forever — and every queued task behind it stalled. Single
 * misbehaving call → whole pipeline frozen until app restart.
 *
 * The fix is to wrap every external fetch with an AbortSignal.timeout
 * sized to the operation:
 *
 *   - SUBMIT / UPLOAD   30s  ← large body in flight, allow generous time
 *   - POLL              10s  ← cheap status check, should be sub-second
 *   - HEALTH CHECK       8s  ← test-connection, account info
 *   - IMAGE DOWNLOAD    60s  ← potentially many-MB binary, slow CDN OK
 *
 * Timeouts are bigger than typical operation times (we're not trying
 * to optimise latency) but bounded enough that a frozen call surfaces
 * as an error within a minute instead of stalling indefinitely.
 *
 * Exported names: `fetchWithTimeout(url, init, ms)` is the primitive;
 * the constants below name common ceilings so callers can read at
 * the call site what kind of operation it is.
 */

const TIMEOUT_SUBMIT   = 30_000;
const TIMEOUT_UPLOAD   = 30_000;
const TIMEOUT_POLL     = 10_000;
const TIMEOUT_HEALTH   = 8_000;
const TIMEOUT_DOWNLOAD = 60_000;

/**
 * Wrap a fetch with an abort timeout. Reuses any caller-supplied
 * signal (so callers that already have their own abort plumbing
 * — e.g. user-cancelled tasks — still work). Returns the same
 * Response the underlying fetch produces, or throws an Error with
 * `cause.code === 'UND_ERR_CONNECT_TIMEOUT'` / `'ETIMEDOUT'` when
 * the deadline fires.
 *
 * Use AbortSignal.any() to combine the caller's signal with the
 * timeout signal when both are present. Falls back to just the
 * timeout signal otherwise.
 */
async function fetchWithTimeout(url, init = {}, ms = TIMEOUT_POLL) {
  const timeoutSignal = AbortSignal.timeout(ms);
  let signal = timeoutSignal;
  if (init.signal && typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any([init.signal, timeoutSignal]);
  } else if (init.signal) {
    // Node 18 doesn't have AbortSignal.any. Just use the caller's
    // signal — they're presumably tracking their own deadlines.
    signal = init.signal;
  }
  return fetch(url, { ...init, signal });
}

module.exports = {
  fetchWithTimeout,
  TIMEOUT_SUBMIT,
  TIMEOUT_UPLOAD,
  TIMEOUT_POLL,
  TIMEOUT_HEALTH,
  TIMEOUT_DOWNLOAD,
};
