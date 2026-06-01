import { useEffect, useState } from 'react';
import { Button } from './ui.jsx';
import { confirm } from './ConfirmModal.jsx';
import { useAppStore } from '../store/index.js';

/**
 * v0.49.31: a small, self-contained "last backup was…" + "Create
 * backup now" affordance. Designed to be dropped into the body of a
 * destructive confirm dialog (via ConfirmModal's `extra` slot) or
 * inline in a bulk-action modal, so the user is reminded — at the
 * moment they're about to do something irreversible — whether they
 * have a recent safety net, and can make one without leaving the flow.
 *
 * It manages its own IPC state, so callers just render <BackupReminder/>.
 * In client mode the backups channels are stubbed (no local data
 * folder); we detect the thrown "not available" error and render
 * nothing rather than a broken control.
 */
export function BackupReminder() {
  const addToast = useAppStore((s) => s.addToast);
  const [state, setState] = useState({ phase: 'loading', last: null, unsupported: false });
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      const last = await window.api.backups.last();
      setState({ phase: 'ready', last, unsupported: false });
    } catch (err) {
      // Client mode (or any environment without local backups) → hide.
      setState({ phase: 'ready', last: null, unsupported: true });
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await window.api.backups.create();
      addToast(`Backup created: ${res.fileName} · ${formatBytes(res.sizeBytes)}`, 'success');
      await refresh();
    } catch (err) {
      addToast(`Backup failed: ${err.message}`, 'error');
    } finally {
      setCreating(false);
    }
  }

  if (state.phase === 'loading' || state.unsupported) return null;

  return (
    <div className="backup-reminder">
      <span className="backup-reminder__status">
        {state.last
          ? <>Last backup: <strong>{relativeTime(state.last.createdAt)}</strong> · {formatBytes(state.last.sizeBytes)}</>
          : <>No backups yet — this can't be undone, so consider one first.</>}
      </span>
      <Button onClick={handleCreate} disabled={creating}>
        {creating ? 'Backing up…' : 'Create backup now'}
      </Button>
    </div>
  );
}

/**
 * Like the imperative `confirm()`, but with a live BackupReminder
 * rendered into the dialog body. Use for high-impact destructive bulk
 * operations (bulk delete, merge purge, re-encode overwrite, etc.).
 *
 *   if (await confirmWithBackup({ title: 'Delete 40 products?', danger: true })) { … }
 */
export function confirmWithBackup(opts) {
  return confirm({ ...opts, extra: <BackupReminder /> });
}

/* ── formatting helpers (kept local; mirror MigrationPanel's) ── */

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function relativeTime(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff)) return 'unknown';
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  try { return new Date(Number(ts)).toLocaleDateString(); } catch { return `${day} days ago`; }
}
