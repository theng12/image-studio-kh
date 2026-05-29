/**
 * v0.22.11: "Who's online" modal.
 *
 * Opens from the sidebar's presence row (server admin + client both)
 * and shows the live WebSocket-connected user list with name, role,
 * and how long they've been connected. A Refresh button re-fetches
 * via `users:presence` so the user can force-poll without waiting
 * for the next push event.
 *
 * Note about server-mode admins: the local admin renderer doesn't
 * open a WS to itself, so it doesn't appear in `presence` — only
 * clients do. The modal shows a "You're the server admin" footer
 * so the user understands their own absence from the list is
 * expected behaviour, not a bug.
 *
 * Client mode: same modal, same data — but the calling client DOES
 * appear in the list (the server saw their WS connect). We tag the
 * "you" row visually so it's obvious which entry is the caller.
 */
import { useEffect, useState } from 'react';
import { Modal, Badge } from './ui.jsx';
import { useAppStore } from '../store/index.js';

function relativeSince(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'}`;
}

function roleTone(role) {
  switch (role) {
    case 'admin':   return 'rose';
    case 'editor':  return 'blue';
    case 'viewer':  return 'slate';
    default:        return 'slate';
  }
}

export function PresenceModal({ open, onClose }) {
  const presence = useAppStore((s) => s.presence);
  const appMode = useAppStore((s) => s.appMode);
  const clientConnection = useAppStore((s) => s.clientConnection);
  // Used to highlight the "you" row in client mode.
  const myUserId = clientConnection?.user?.id ?? null;

  const [refreshing, setRefreshing] = useState(false);
  const [lastFetched, setLastFetched] = useState(0);
  // Force a re-render every 30s so "5 min" creeps up to "6 min" while
  // the modal is open.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, [open]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const fresh = await window.api?.users?.presence?.();
      if (Array.isArray(fresh)) {
        // Push to store so the sidebar row reflects the same fresh
        // data. The store's own presence subscriber (in bootstrap)
        // overwrites on push events; this is the manual path.
        useAppStore.setState({ presence: fresh });
        setLastFetched(Date.now());
      }
    } catch (_) {
      /* non-fatal — server might be offline */
    } finally {
      setRefreshing(false);
    }
  }

  const sorted = [...(presence ?? [])].sort((a, b) => {
    // "You" first in client mode, then alphabetical.
    if (a.id === myUserId && b.id !== myUserId) return -1;
    if (b.id === myUserId && a.id !== myUserId) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return (
    <Modal open={open} onClose={onClose} title="Who's online" size="md">
      <div className="presence-modal">
        <div className="presence-modal__head">
          <p className="muted presence-modal__intro">
            Everyone currently connected via WebSocket to the server.
            The list updates automatically when someone joins or leaves.
            {appMode === 'server' ? (
              <> Refresh polls the live connection set immediately.</>
            ) : (
              <> Refresh asks the server for the latest list.</>
            )}
          </p>
          <button
            type="button"
            className="presence-modal__refresh"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Re-fetch the live presence list from the server"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {sorted.length === 0 ? (
          <div className="presence-modal__empty">
            <p>No connected clients right now.</p>
            {appMode === 'server' ? (
              <p className="muted">
                When a teammate logs in via client mode using your server URL +
                their token, they'll appear here automatically.
              </p>
            ) : appMode === 'client' ? (
              <p className="muted">
                It looks like you're not currently authenticated against the
                server. Check Settings → Multi-Mac for your token and URL.
              </p>
            ) : null}
          </div>
        ) : (
          <ul className="presence-modal__list">
            {sorted.map((u) => {
              const isMe = u.id === myUserId;
              return (
                <li key={u.id} className={`presence-modal__row${isMe ? ' is-me' : ''}`}>
                  <span className="presence-modal__dot" aria-hidden="true" />
                  <span className="presence-modal__name">
                    {u.name}
                    {isMe ? <span className="presence-modal__you"> (you)</span> : null}
                  </span>
                  {u.role ? <Badge tone={roleTone(u.role)}>{u.role}</Badge> : null}
                  <span className="presence-modal__since" title={u.connectedAt ? new Date(u.connectedAt).toLocaleString() : ''}>
                    {u.connectedAt ? `connected ${relativeSince(u.connectedAt)} ago` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {appMode === 'server' ? (
          <p className="presence-modal__footer muted">
            <strong>Note:</strong> you (server admin) don't open a WebSocket to
            yourself, so you won't appear in this list — that's by design, not
            a bug. Your own edits still surface to clients via push events the
            same way.
          </p>
        ) : null}

        {lastFetched > 0 ? (
          <p className="presence-modal__footer muted">
            Last refreshed {relativeSince(lastFetched)} ago.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
