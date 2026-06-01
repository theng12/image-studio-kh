import { useEffect, useState } from 'react';
import { Button } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { formatBytes, relativeTime } from '../../components/BackupReminder.jsx';

// Inlined copy of SettingRow (also lives in Settings/index.jsx and
// MultiMacPanel.jsx). Kept in sync by hand — see the Settings docblock.
function SettingRow({ label, hint, children }) {
  return (
    <div className="setting-row">
      <div className="setting-row__label">
        <div className="setting-row__title">{label}</div>
        {hint ? <div className="setting-row__hint">{hint}</div> : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

/**
 * v0.49.31: Settings → Backups. A practical, local safety net before
 * the app goes to production:
 *   - Create a backup now (DB + assets + config → one .iskhbackup).
 *   - See recent backups with date, size, and path.
 *   - Reveal a backup in Finder.
 *   - Restore a backup (replaces the data folder, keeps a safety copy,
 *     then restarts).
 *
 * Everything is local — no cloud. Restore is the one destructive
 * action here, gated behind a danger confirm + an automatic
 * move-aside of the current data folder.
 */
export function BackupsPanel({ config }) {
  const addToast = useAppStore((s) => s.addToast);
  const [list, setList] = useState({ backupsDir: null, backups: [], loading: true });
  const [creating, setCreating] = useState(false);
  const [restoringPath, setRestoringPath] = useState(null);

  async function refresh() {
    try {
      const res = await window.api.backups.list();
      setList({ ...res, loading: false });
    } catch (err) {
      setList({ backupsDir: null, backups: [], loading: false });
      addToast(`Couldn't list backups: ${err.message}`, 'error');
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

  async function handlePickFolder() {
    try {
      const next = await window.api.backups.pickFolder();
      if (!next) return;
      addToast('Backups will be written here from now on.', 'success');
      await refresh();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleReveal(backupPath) {
    try { await window.api.backups.reveal(backupPath); }
    catch (err) { addToast(err.message, 'error'); }
  }

  async function handleRestore(backup) {
    // Read + validate the manifest first so the confirm can show what's
    // inside before the user commits to replacing their data.
    let preview = null;
    try {
      preview = await window.api.backups.preview(backup.backupPath);
    } catch (err) {
      addToast(`Can't restore — ${err.message}`, 'error');
      return;
    }
    const ok = await confirm({
      title: 'Restore this backup?',
      message:
        'This REPLACES everything in your current data folder (database, ' +
        'products, brands, images, AI gallery) with the contents of this backup. ' +
        'Your current data is moved aside to a timestamped folder next to it first, ' +
        'so you can recover it from Finder if anything looks wrong.',
      detail:
        `Backup: ${backup.fileName}\n` +
        `Created: ${formatDateTime(preview.createdAt)} from app v${preview.appVersion ?? '—'}\n` +
        `Includes: ${(preview.includes ?? []).join(', ')}\n\n` +
        `Target (this Mac):\n${config?.dataDir ?? ''}\n\n` +
        'The app will restart automatically when the restore finishes.',
      confirmLabel: 'Replace and restart',
      danger: true,
    });
    if (!ok) return;

    setRestoringPath(backup.backupPath);
    try {
      await window.api.backups.restore(backup.backupPath);
      addToast('Backup restored. Restarting…', 'success');
      setTimeout(() => window.api.app.relaunch(), 700);
    } catch (err) {
      addToast(`Restore failed: ${err.message}`, 'error');
      setRestoringPath(null);
    }
  }

  return (
    <div className="settings-page">
      <h2 className="settings-section-heading">Backups</h2>

      <p className="setting-row__hint" style={{ marginTop: 0, maxWidth: 640 }}>
        Local snapshots of your database, images, and preferences. Use one before any
        large delete, duplicate-merge purge, bulk re-encode, or data-folder change.
        Backups stay on this Mac — they are never uploaded anywhere.
      </p>

      <SettingRow
        label="Create a backup"
        hint="Packs the SQLite database (consistent snapshot), all image assets, and your AI keys + presets into one .iskhbackup file in the backups folder below."
      >
        <div className="setting-control-row">
          <Button variant="primary" onClick={handleCreate} disabled={creating}>
            {creating ? 'Backing up…' : 'Create backup now'}
          </Button>
        </div>
      </SettingRow>

      <SettingRow
        label="Backups folder"
        hint="Where backups are written. Defaults to a `backups` folder inside your data folder; point it at an external drive to keep backups off the working disk."
      >
        <div className="setting-control-row">
          <code className="backups-dir-path">{list.backupsDir ?? '—'}</code>
          <Button onClick={() => window.api.backups.openFolder()}>Open</Button>
          <Button onClick={handlePickFolder}>Change…</Button>
        </div>
      </SettingRow>

      <SettingRow
        label="Recent backups"
        hint="Newest first. Restore replaces the current data folder (a safety copy of the old data is kept) and restarts the app."
      >
        <div className="backups-list">
          {list.loading ? (
            <p className="muted" style={{ margin: 0 }}>Loading…</p>
          ) : list.backups.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No backups yet. Click <strong>Create backup now</strong> above to make your first one.
            </p>
          ) : (
            <ul className="backups-table">
              {list.backups.map((b) => (
                <li key={b.backupPath} className="backups-row">
                  <div className="backups-row__main">
                    <span className="backups-row__when">{formatDateTime(b.createdAt)}</span>
                    <span className="muted backups-row__rel"> · {relativeTime(b.createdAt)}</span>
                    <span className="muted backups-row__size"> · {formatBytes(b.sizeBytes)}</span>
                    <div className="muted backups-row__file">{b.fileName}</div>
                  </div>
                  <div className="backups-row__actions">
                    <Button variant="ghost" onClick={() => handleReveal(b.backupPath)}>Reveal</Button>
                    <Button
                      onClick={() => handleRestore(b)}
                      disabled={restoringPath !== null}
                    >
                      {restoringPath === b.backupPath ? 'Restoring…' : 'Restore…'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingRow>
    </div>
  );
}

function formatDateTime(ts) {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleString(); } catch { return '—'; }
}
