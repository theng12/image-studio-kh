/**
 * v0.17.2: ConflictModal — shown when an optimistic-concurrency
 * check fails. Two clients edited the same row at roughly the same
 * time; this modal lets the user decide what to do with their
 * pending changes:
 *
 *   - Refresh  — discard their pending changes, pull the server's
 *                fresh row, re-render the form. Safest default.
 *   - Overwrite — re-save with `expectedUpdatedAt` cleared so the
 *                 next write succeeds. Their changes win; the other
 *                 editor's last write is gone.
 *   - Cancel   — close the dialog, leave the form as-is. User can
 *                copy text out to paste back after a refresh.
 *
 * Driven by an imperative `showConflict(conflict)` helper so any
 * write handler can call it without threading state through props.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal, Button } from './ui.jsx';
import { useAppStore } from '../store/index.js';

let _setRequest = null;

/**
 * Call this from any write handler that caught a CONFLICT error.
 * Resolves to one of: 'refresh' | 'overwrite' | 'cancel'.
 */
export function showConflict(conflict) {
  return new Promise((resolve) => {
    if (_setRequest) {
      _setRequest({ conflict, resolve });
    } else {
      // Host not mounted (shouldn't happen in app). Default to cancel.
      resolve('cancel');
    }
  });
}

/**
 * Extract conflict details from a thrown error. Returns null if the
 * error doesn't carry the CONFLICT sentinel.
 *
 * v0.26.9: the sentinel may appear anywhere in the message, not just
 * at position 0. Electron's `ipcRenderer.invoke` wraps every thrown
 * error from a main-process handler as:
 *
 *   "Error invoking remote method '<channel>': Error: <original>"
 *
 * so what the main process threw as `CONFLICT|<json>` arrives in the
 * renderer with that prefix. Earlier versions used `startsWith` and
 * silently failed to detect any conflict that came through plain
 * Electron IPC (every desktop save). The conflict dialog only ever
 * surfaced over HTTP RPC (client mode), where the error wasn't
 * re-wrapped. Fix: locate the sentinel by `indexOf` and slice from
 * there.
 */
export function parseConflictError(err) {
  if (typeof err?.message !== 'string') return null;
  const at = err.message.indexOf('CONFLICT|');
  if (at < 0) return null;
  try {
    return JSON.parse(err.message.slice(at + 'CONFLICT|'.length));
  } catch {
    return null;
  }
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return new Date(Number(ts)).toLocaleString();
}

export function ConflictModalHost() {
  const [request, setRequest] = useState(null);
  const requestRef = useRef(null);
  const attributionUsers = useAppStore((s) => s.attributionUsers);

  useEffect(() => {
    _setRequest = setRequest;
    return () => { _setRequest = null; };
  }, []);

  useEffect(() => { requestRef.current = request; }, [request]);

  if (!request) return null;
  const { conflict, resolve } = request;

  const editorName = conflict?.updatedByUserId
    ? (attributionUsers?.[conflict.updatedByUserId] ?? 'another user')
    : 'the server admin';
  const when = relativeTime(conflict?.updatedAt);
  const label = conflict?.sku || conflict?.name || conflict?.id || 'this item';

  function done(outcome) {
    setRequest(null);
    resolve(outcome);
  }

  return (
    <Modal open title="Edit conflict" onClose={() => done('cancel')} closeOnBackdrop={false}>
      <div className="conflict-modal__body">
        <p>
          <strong>{label}</strong> was edited by <strong>{editorName}</strong> {when} while
          you had it open. Your unsaved changes haven&rsquo;t been applied yet.
        </p>
        <p className="conflict-modal__choices">
          What would you like to do?
        </p>
        <ul className="conflict-modal__list">
          <li><strong>Refresh</strong> — discard your pending changes and load the latest version. Safest.</li>
          <li><strong>Overwrite</strong> — apply your changes anyway. {editorName}&rsquo;s recent edits will be lost.</li>
          <li><strong>Cancel</strong> — keep the form open so you can copy text out. Nothing is saved.</li>
        </ul>
      </div>
      <footer className="conflict-modal__footer">
        <Button onClick={() => done('cancel')}>Cancel</Button>
        <div style={{ flex: 1 }} />
        <Button variant="danger" onClick={() => done('overwrite')}>Overwrite</Button>
        <Button variant="primary" onClick={() => done('refresh')}>Refresh</Button>
      </footer>
    </Modal>
  );
}
