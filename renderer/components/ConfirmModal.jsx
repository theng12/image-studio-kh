import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from './ui.jsx';

/**
 * Reusable destructive-confirm dialog. Replaces ad-hoc `window.confirm`
 * calls across the app so we get consistent styling, theming, and the
 * same Esc behavior that the rest of the app's modals have.
 *
 * Use the imperative `confirm()` helper for the most common pattern:
 *
 *   if (await confirm({ title: 'Delete tile?', danger: true })) { ... }
 *
 * Or render <ConfirmModal /> directly when you want declarative control.
 *
 * Per CLAUDE.md §2 "destructive confirmations" are the documented opt-out
 * from backdrop-click dismissal — `closeOnBackdrop` defaults to false here
 * to avoid accidental deletes when the user clicks outside the dialog.
 */
export function ConfirmModal({
  open,
  onCancel,
  onConfirm,
  title,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  closeOnBackdrop = false,
  // v0.26.21: optional keyboard hotkey for the confirm action so the
  // user can fire destructive ops without reaching for the mouse.
  // Format: lower-case 'shift+d', 'cmd+enter', 'd', etc. Parsed by
  // `matchHotkey` below. When set, we append a `⇧D` hint to the
  // confirm button label so the shortcut is discoverable.
  hotkey,
}) {
  // Register the window-level keydown handler ONLY while the modal
  // is open. Capture-phase so we beat any other Esc / shortcut
  // handlers further down the tree (same pattern Lightbox uses).
  useEffect(() => {
    if (!open || !hotkey || busy) return undefined;
    function onKey(e) {
      // Ignore key events fired from form inputs so the user can
      // still type "d" in a text field elsewhere on the page without
      // accidentally confirming. ConfirmModal has no inputs of its
      // own; this is purely defensive against ambient typing.
      if (e.target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
      if (!matchHotkey(e, hotkey)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onConfirm?.();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, hotkey, busy, onConfirm]);

  const hint = hotkey ? formatHotkey(hotkey) : null;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      closeOnBackdrop={closeOnBackdrop}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : (
              <>
                {confirmLabel}
                {hint ? <span className="confirm-modal__hotkey">{hint}</span> : null}
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="confirm-modal__body">
        {message ? <p className="confirm-modal__message">{message}</p> : null}
        {detail ? <p className="confirm-modal__detail">{detail}</p> : null}
      </div>
    </Modal>
  );
}

/**
 * Parse a string like 'shift+d', 'cmd+enter', 'd' against a KeyboardEvent.
 * - Modifier order doesn't matter ('shift+d' === 'd+shift').
 * - 'cmd' matches metaKey on Mac (and ctrlKey on Windows/Linux — we don't
 *   ship for those but kept symmetric for future-proofing).
 * - Plain alpha keys match case-insensitively against `e.key`.
 * - 'enter', 'space', 'esc' supported as named keys.
 */
function matchHotkey(e, spec) {
  const parts = spec.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  let needShift = false, needAlt = false, needCmd = false, needCtrl = false;
  let key = null;
  for (const p of parts) {
    if (p === 'shift') needShift = true;
    else if (p === 'alt' || p === 'option') needAlt = true;
    else if (p === 'cmd' || p === 'meta') needCmd = true;
    else if (p === 'ctrl' || p === 'control') needCtrl = true;
    else key = p;
  }
  if (!key) return false;
  if (e.shiftKey !== needShift) return false;
  if (e.altKey   !== needAlt)   return false;
  if (e.metaKey  !== needCmd)   return false;
  if (e.ctrlKey  !== needCtrl)  return false;
  // Map named keys; everything else compared case-insensitively.
  if (key === 'enter')  return e.key === 'Enter';
  if (key === 'space')  return e.key === ' ' || e.key === 'Spacebar';
  if (key === 'esc')    return e.key === 'Escape';
  return e.key.toLowerCase() === key;
}

/** Render the hint with Mac-native symbols: ⇧ ⌥ ⌘ ⌃. */
function formatHotkey(spec) {
  const parts = spec.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods = [];
  let key = '';
  for (const p of parts) {
    if (p === 'shift') mods.push('⇧');
    else if (p === 'alt' || p === 'option') mods.push('⌥');
    else if (p === 'cmd' || p === 'meta') mods.push('⌘');
    else if (p === 'ctrl' || p === 'control') mods.push('⌃');
    else key = p === 'enter' ? '⏎' : p === 'space' ? '␣' : p.toUpperCase();
  }
  return mods.join('') + key;
}

/* ── Imperative helper ─────────────────────────────────────────
 * Mounts a temporary host into <body>, renders a one-shot
 * ConfirmModal, returns a Promise<boolean>. This is the closest
 * analogue to `window.confirm` while keeping our Modal styling
 * and Esc handling intact.
 *
 *   const ok = await confirm({ title: 'Delete?', danger: true });
 */
import { createRoot } from 'react-dom/client';

export function confirm(opts) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.dataset.role = 'confirm-modal-host';
    document.body.appendChild(host);
    const root = createRoot(host);

    function teardown(answer) {
      try { root.unmount(); } catch (_) {}
      try { host.remove(); } catch (_) {}
      resolve(answer);
    }

    function Wrap() {
      // Manage the "busy" state when the caller's onConfirm returns a
      // Promise. Lets the dialog show "Working…" while the action runs
      // (e.g. a long DB delete) and only tears down on resolve.
      const [busy, setBusy] = useState(false);
      const cancelRef = useRef(() => teardown(false));
      const confirmRef = useRef(() => {
        const maybe = opts.onBeforeConfirm?.();
        if (maybe && typeof maybe.then === 'function') {
          setBusy(true);
          maybe.then(
            () => teardown(true),
            () => { setBusy(false); /* keep open for retry */ },
          );
        } else {
          teardown(true);
        }
      });

      useEffect(() => () => {
        // Defensive cleanup if the component unmounts via another path.
        try { root.unmount(); } catch (_) {}
        try { host.remove(); } catch (_) {}
      }, []);

      return (
        <ConfirmModal
          open
          title={opts.title || 'Confirm'}
          message={opts.message}
          detail={opts.detail}
          confirmLabel={opts.confirmLabel ?? (opts.danger ? 'Delete' : 'Confirm')}
          cancelLabel={opts.cancelLabel ?? 'Cancel'}
          danger={!!opts.danger}
          busy={busy}
          closeOnBackdrop={!!opts.closeOnBackdrop}
          hotkey={opts.hotkey}
          onCancel={cancelRef.current}
          onConfirm={confirmRef.current}
        />
      );
    }

    root.render(<Wrap />);
  });
}
