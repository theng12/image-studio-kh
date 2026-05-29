/**
 * v0.26.39: cache visibility + clear button for the @imgly background-
 * removal model.
 *
 * The panel is its own component so it can manage its own loading +
 * refresh state without bloating the ClientModePanel / AI tab. Loads
 * on mount via `app:getCacheInfo`; refreshes after a successful Clear
 * so the user sees the numbers drop to 0 immediately.
 *
 * Why this matters: users worry that updating the app forces a
 * re-download of the 80 MB model. Showing the cached MB count + last
 * activity date + actual filesystem path converts "is it cached?"
 * from a leap-of-faith question into a visible fact. The Clear button
 * is here for the rare cases where (a) we ship a build that bumps the
 * @imgly version and the user wants to force a refetch, (b) the cache
 * gets corrupted, or (c) they want to reclaim disk on a Mac that's
 * never going to do bg removal again.
 *
 * v0.26.43: extracted from Settings/index.jsx (was inline at lines
 * 1342–1491). Pure move — no behaviour change. Settings/index.jsx now
 * imports BgModelCachePanel from this file.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

// Pretty-print helpers — only used by this panel.
function formatBytesShort(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function formatAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  return `${mo} mo ago`;
}

export function BgModelCachePanel() {
  const [info, setInfo] = useState(null); // { cachePath, totalBytes, fileCount, mostRecentMtime, exists } | null
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  async function refresh() {
    if (!window.api?.app?.getCacheInfo) return;
    setLoading(true);
    try {
      const r = await window.api.app.getCacheInfo();
      setInfo(r);
    } catch (err) {
      addToast?.(`Couldn't read cache info: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // v0.26.41 (audit pass): `refresh` intentionally omitted — re-runs
    // only when the user clicks the Refresh button or after a Clear
    // cache call; we don't want re-fires on parent re-renders.
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleClear() {
    if (clearing) return;
    // Confirm because clearing forces a ~80 MB re-download on the
    // next bg-removal call. Not destructive to data, but destructive
    // to the user's "I already downloaded that" expectation.
    const ok = await confirm({
      title: 'Clear the model cache?',
      message:
        'This wipes Electron\'s HTTP cache on this Mac, including the ' +
        '~80 MB @imgly model. The next time you run background removal, ' +
        'the model will re-download from staticimgly.com (one-time, then ' +
        're-cached). No product data is touched.',
      detail: info?.totalBytes
        ? `Cache currently: ${formatBytesShort(info.totalBytes)} across ${info.fileCount} files.`
        : undefined,
      confirmLabel: 'Clear cache',
      danger: true,
    });
    if (!ok) return;

    setClearing(true);
    try {
      const r = await window.api.app.clearCache();
      addToast?.(`Cleared ${formatBytesShort(r.bytesFreed)} of cache.`, 'success');
      await refresh();
    } catch (err) {
      addToast?.(`Clear failed: ${err.message}`, 'error');
    } finally {
      setClearing(false);
    }
  }

  function handleCopyPath() {
    if (!info?.cachePath) return;
    navigator.clipboard?.writeText(info.cachePath);
    addToast?.('Cache path copied to clipboard.', 'success');
  }

  return (
    <div className="bg-cache-panel">
      <div className="bg-cache-panel__stats">
        <div className="bg-cache-panel__stat">
          <div className="bg-cache-panel__stat-label">Cached size</div>
          <div className="bg-cache-panel__stat-value">
            {loading
              ? 'Checking…'
              : !info?.exists
                ? <span className="muted">Not cached yet</span>
                : formatBytesShort(info.totalBytes)}
          </div>
        </div>
        <div className="bg-cache-panel__stat">
          <div className="bg-cache-panel__stat-label">Files</div>
          <div className="bg-cache-panel__stat-value">
            {loading ? '…' : (info?.fileCount ?? 0).toLocaleString()}
          </div>
        </div>
        <div className="bg-cache-panel__stat">
          <div className="bg-cache-panel__stat-label">Last activity</div>
          <div className="bg-cache-panel__stat-value">
            {loading ? '…' : formatAgo(info?.mostRecentMtime)}
          </div>
        </div>
      </div>

      {info?.cachePath ? (
        <div className="bg-cache-panel__path">
          <code
            className="bg-cache-panel__path-code"
            onClick={handleCopyPath}
            title="Click to copy the cache path. Useful if you ever need to inspect or wipe it manually."
          >{info.cachePath}</code>
        </div>
      ) : null}

      <div className="bg-cache-panel__actions">
        <Button onClick={refresh} disabled={loading || clearing}>
          {loading ? 'Checking…' : 'Refresh'}
        </Button>
        <Button
          variant="danger"
          onClick={handleClear}
          disabled={loading || clearing || !info?.exists}
          title="Wipes the cache. Next bg-removal call will re-download the ~80 MB model."
        >
          {clearing ? 'Clearing…' : 'Clear cache'}
        </Button>
      </div>

      <p className="bg-cache-panel__note muted">
        App updates do NOT touch this cache — it lives in <code>~/Library/Application Support/...</code>,
        separate from the <code>.app</code> bundle. The only ways the cache gets wiped are: clicking Clear
        cache here, uninstalling the app and deleting its data folder, or this Mac running out of disk
        and Electron evicting it.
      </p>
    </div>
  );
}
