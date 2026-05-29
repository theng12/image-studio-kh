/**
 * v0.26.43: extracted from Settings/index.jsx. Three components that
 * collectively render the Settings → About tab.
 *
 *  - AboutCard      — version info + Sponsor / data-folder / logs links
 *  - CrashLogPanel  — collapsible tail of crash.log for support copy/paste
 *  - AboutItem      — internal one-cell key/value row used by AboutCard
 *
 * Pure move from Settings/index.jsx, no behaviour change. AboutItem is
 * intentionally not re-exported from Settings/index.jsx since it's only
 * consumed by AboutCard.
 */
import { useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button } from '../../components/ui.jsx';

export function AboutCard({ versionInfo }) {
  const openExternal = (url) => window.api?.app.openExternal(url);
  return (
    <section className="about-card">
      <header className="about-card__head">
        <div>
          <div className="about-card__label">About</div>
          <h2 className="about-card__title">Image Studio KH</h2>
          <div className="about-card__subtitle">Batch product image processor</div>
        </div>
        <div className="about-card__version">v{versionInfo?.app ?? '—'}</div>
      </header>

      <div className="about-card__grid">
        <AboutItem label="Platform"  value={versionInfo ? `${versionInfo.platform} · ${versionInfo.arch}` : '—'} />
        <AboutItem label="Electron"  value={versionInfo?.electron ?? '—'} />
        <AboutItem label="Chromium"  value={versionInfo?.chrome   ?? '—'} />
        <AboutItem label="Node"      value={versionInfo?.node     ?? '—'} />
      </div>

      <p className="about-card__updates">When a new build is available it'll appear in <strong>What's new</strong>. Auto-update prompts coming in a future release.</p>
      <footer className="about-card__actions">
        <Button onClick={() => window.api?.app.openDataFolder()}>Open data folder</Button>
        <Button onClick={() => window.api?.app.openLogsFolder()}>Open logs folder</Button>
        <Button onClick={() => openExternal('https://github.com/sponsors')}>Sponsor</Button>
        <Button onClick={() => useAppStore.getState().addToast(`You're on v${versionInfo?.app ?? '?'} — the latest dev build.`, 'info')}>
          Check for updates
        </Button>
      </footer>
      <CrashLogPanel />
    </section>
  );
}

/**
 * v0.19.0: Crash log viewer. Lets a beta user paste the last 100
 * lines of crash.log into chat when something goes wrong — much
 * easier than walking them through Finder.
 */
export function CrashLogPanel() {
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  async function loadLog() {
    try {
      const result = await window.api?.app?.readCrashLog(100);
      setContent(result?.content ?? '');
      setLoaded(true);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function copyToClipboard() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      addToast('Crash log copied to clipboard.', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  return (
    <div className="crash-log">
      <div className="crash-log__head">
        <div className="crash-log__title">Crash log (last 100 lines)</div>
        <div className="crash-log__actions">
          {loaded ? (
            <Button onClick={copyToClipboard} disabled={!content}>Copy</Button>
          ) : null}
          <Button onClick={loadLog}>{loaded ? 'Reload' : 'Show'}</Button>
        </div>
      </div>
      {loaded ? (
        <pre className="crash-log__body">{content || '(empty)'}</pre>
      ) : (
        <div className="crash-log__hint">
          Click <strong>Show</strong> to load the tail of crash.log. Useful when something looks
          broken — copy the contents and paste them when reporting the issue.
        </div>
      )}
    </div>
  );
}

function AboutItem({ label, value }) {
  return (
    <div className="about-item">
      <div className="about-item__label">{label}</div>
      <div className="about-item__value">{value}</div>
    </div>
  );
}
