/**
 * v0.15.3: tiny "Edited <when> [by <who>]" chip.
 *
 * Used in the Library side panel, brand panel, etc. Resolves the user
 * name through the store's `attributionUsers` map so the chip is the
 * user's display name, not their UUID. If `updatedByUserId` is null
 * (server admin / standalone), we just show the relative time.
 *
 * Re-renders on a 60s timer so "5 min ago" graduates to "6 min ago"
 * without the parent component needing to know.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/index.js';

function relativeTime(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diffMs = now - Number(ts);
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} mo ago`;
  const yr = Math.floor(mo / 12);
  return `${yr} yr ago`;
}

export function Attribution({ updatedAt, updatedByUserId, prefix = 'Edited' }) {
  const attributionUsers = useAppStore((s) => s.attributionUsers);
  // Force a re-render once a minute so the relative time stays fresh.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!updatedAt) return undefined;
    const t = setInterval(() => tick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [updatedAt]);

  if (!updatedAt) return null;
  const name = updatedByUserId ? (attributionUsers?.[updatedByUserId] ?? null) : null;

  return (
    <div className="attribution" title={new Date(Number(updatedAt)).toLocaleString()}>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.1" />
        <path d="M6 3.2v3l1.8 1.1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
      <span>{prefix} {relativeTime(updatedAt)}</span>
      {name ? <span className="attribution__by">by <strong>{name}</strong></span> : null}
    </div>
  );
}

/**
 * v0.22.5: very compact attribution used in list rows. No icon, no
 * "Edited" prefix — just `<time> · <name>` (or just `<time>` if no
 * user). The full timestamp is in the tooltip. Designed to fit in a
 * table cell or a one-line grid card footer where the regular
 * Attribution component would be too tall.
 *
 * Shares the 60-second tick from above so a Library page open in the
 * background keeps "5 min ago" honest as the minute hand turns.
 */
export function CompactAttribution({ updatedAt, updatedByUserId }) {
  const attributionUsers = useAppStore((s) => s.attributionUsers);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!updatedAt) return undefined;
    const t = setInterval(() => tick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [updatedAt]);

  if (!updatedAt) return null;
  const name = updatedByUserId ? (attributionUsers?.[updatedByUserId] ?? null) : null;
  const when = relativeTime(updatedAt);
  const tip = name
    ? `Edited ${when} by ${name} (${new Date(Number(updatedAt)).toLocaleString()})`
    : `Edited ${new Date(Number(updatedAt)).toLocaleString()}`;
  return (
    <span className="attribution--compact" title={tip}>
      <span className="attribution--compact__when">{when}</span>
      {name ? <span className="attribution--compact__by"> · {name}</span> : null}
    </span>
  );
}
