/**
 * Tiny client-side id generator. Used for element ids in the editor.
 * crypto.randomUUID is available in modern browsers — fall back to a
 * timestamp-based one for environments missing it.
 */
export function nanoidish() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
