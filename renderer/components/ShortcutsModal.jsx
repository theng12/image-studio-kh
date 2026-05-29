/**
 * v0.18.0: keyboard shortcuts cheat sheet.
 *
 * Opens via Cmd+? (Mac) / Ctrl+? (Win/Linux) — same chord that any
 * modern Mac app uses for help. Lists every shortcut grouped by area
 * so users can discover features without hunting through menus.
 *
 * The list is hand-curated here rather than auto-derived from
 * `SHORTCUTS` in App.jsx, because some shortcuts are deeper than
 * top-level navigation (Workspace arrow keys, Library search /
 * focus, etc.) — and the grouping reads more naturally for humans
 * than the flat map the keydown handler uses.
 */

import { Modal } from './ui.jsx';
import { useAppStore } from '../store/index.js';

function Key({ children }) {
  return <kbd className="shortcut-key">{children}</kbd>;
}

const GROUPS = (mod) => [
  {
    title: 'Navigation',
    rows: [
      { keys: [`${mod}1`], action: 'Dashboard' },
      { keys: [`${mod}2`], action: 'Product Library' },
      { keys: [`${mod}3`], action: 'Image Workspace' },
      { keys: [`${mod}4`], action: 'AI Studio' },
      { keys: [`${mod}5`], action: 'Overlay Studio' },
      { keys: [`${mod}6`], action: 'Export Center' },
      { keys: [`${mod},`], action: 'Settings' },
      { keys: [`${mod}K`], action: 'Global search palette' },
      { keys: [`${mod}?`], action: 'Show this shortcuts list' },
    ],
  },
  {
    title: 'Product Library',
    rows: [
      { keys: ['Click row'], action: 'Open side panel for product' },
      { keys: ['Esc'], action: 'Close side panel' },
      { keys: ['⌘V / Ctrl+V'], action: 'Paste image into selected product' },
    ],
  },
  {
    title: 'Modal dialogs',
    rows: [
      { keys: ['Esc'], action: 'Close any modal' },
      { keys: ['Click backdrop'], action: 'Close most modals (except destructive ones)' },
    ],
  },
  {
    title: 'Image Workspace',
    rows: [
      { keys: ['←', '→'], action: 'Previous / next image on this product' },
      { keys: ['+ / -'], action: 'Zoom in / out' },
      { keys: ['0'], action: 'Reset zoom to fit' },
    ],
  },
];

export function ShortcutsModal({ open, onClose }) {
  const platform = useAppStore((s) => s.platform);
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';
  if (!open) return null;
  const groups = GROUPS(mod);
  return (
    <Modal open={open} title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcuts-modal">
        {groups.map((group) => (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-group__title">{group.title}</h3>
            <table className="shortcuts-table">
              <tbody>
                {group.rows.map((row, i) => (
                  <tr key={i}>
                    <td className="shortcuts-table__keys">
                      {row.keys.map((k, j) => (
                        <span key={j}>
                          <Key>{k}</Key>
                          {j < row.keys.length - 1 ? <span className="shortcuts-or"> or </span> : null}
                        </span>
                      ))}
                    </td>
                    <td className="shortcuts-table__action">{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  );
}
