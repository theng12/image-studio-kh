import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Modal, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { MARKETPLACE_PRESETS } from '../../lib/presets.js';
import { prefetchLocalModel } from '../../lib/bgRemoval.js';
import { loadHoverPreview, saveHoverPreview } from '../ProductLibrary/index.jsx';
import { CategoriesBody } from '../Categories/index.jsx';
import { BgModelCachePanel } from './BgModelCachePanel.jsx';
import { ModeSegment, ServerModePanel, ClientModePanel, RestartBanner, MigrationPanel } from './MultiMacPanel.jsx';
// CrashLogPanel is used INSIDE AboutCard — no need to re-import it here.
import { AboutCard } from './AboutPanel.jsx';
import { BackupsPanel } from './BackupsPanel.jsx';
import { RolesPanel } from './RolesPanel.jsx';
import { BackupReminder } from '../../components/BackupReminder.jsx';

// v0.22.13: Settings is now tabbed. SETTINGS_TABS is the source of
// truth for both the left rail (label + key) and the conditional
// render below. To add a new section: append an entry here, then
// render its block inside a `{tab === '<key>' && (...)}` guard in the
// return body.
const SETTINGS_TABS = [
  { key: 'general',     label: 'General' },
  { key: 'library',     label: 'Product Library' },
  // v0.22.14: Categories is a tab here, not a top-level sidebar
  // entry. Reasoning: categories are `{ id, name }` — they don't
  // earn dedicated nav real estate the way Brands (icon + color +
  // products) does. They're a settings-style "list of strings" that
  // belongs alongside the other settings tabs.
  { key: 'categories',  label: 'Categories' },
  { key: 'ai',          label: 'AI Generation' },
  // v0.49.31: local backup / restore. Hidden in client mode (a client
  // has no local data folder to back up — see visibleTabs below).
  { key: 'backups',     label: 'Backups' },
  { key: 'multi-mac',   label: 'Multi-Mac' },
  // v0.49.51: custom roles + permission matrix.
  { key: 'roles',       label: 'Roles & permissions' },
  { key: 'about',       label: 'About' },
];
const SETTINGS_TAB_STORAGE_KEY = 'Settings.activeTab';

function loadActiveTab() {
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
    if (saved && SETTINGS_TABS.some((t) => t.key === saved)) return saved;
  } catch {}
  return 'general';
}
function saveActiveTab(key) {
  try { localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, key); } catch {}
}

export function Settings() {
  const exportProfiles = useAppStore((s) => s.exportProfiles);
  const refreshExportProfiles = useAppStore((s) => s.refreshExportProfiles);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);

  const [config, setConfig] = useState(null);
  // v0.26.25: snapshot the restart-sensitive values at the moment
  // Settings first loaded. The client runtime + the server runtime
  // read these once at app boot — changing them in this session
  // means the still-running runtime is using the OLD values. Compare
  // current vs snapshot to decide when to surface the restart banner.
  // Captured on first config load (see useEffect below) and never
  // touched again until the next app launch.
  const [bootSnapshot, setBootSnapshot] = useState(null);
  // v0.49.33: removed `showApiKey` + `testing` — they only existed
  // for the remove.bg API key field, which is gone with the engine.
  const [versionInfo, setVersionInfo] = useState(null);
  const [pendingDataFolder, setPendingDataFolder] = useState(null);
  const [modelDownload, setModelDownload] = useState({ state: 'idle', label: '' });
  // v0.22.13: which tab is showing. Persists in localStorage so a
  // round-trip to Library + back doesn't drop you back on General.
  const [tab, setTab] = useState(loadActiveTab);
  function selectTab(key) {
    setTab(key);
    saveActiveTab(key);
  }
  // v0.49.33: refreshAppConfig is no longer subscribed here — the only
  // call site was the bgRemovalEngine / removeBgApiKey patch handler,
  // both of which are gone with the paid bg-removal engine.

  useEffect(() => {
    window.api?.settings.getAll().then((cfg) => {
      setConfig(cfg);
      // v0.26.25: take the boot snapshot once, on first config load.
      // Subsequent patches mutate `config` but not `bootSnapshot`, so
      // the comparison in RestartBanner stays anchored to the values
      // the running runtimes ACTUALLY have in memory.
      setBootSnapshot((prev) => prev ?? {
        mode: cfg?.mode ?? 'standalone',
        clientServerUrl: cfg?.clientServerUrl ?? '',
        clientToken: cfg?.clientToken ?? '',
      });
    }).catch(() => setConfig(null));
    window.api?.app.getVersionInfo().then(setVersionInfo).catch(() => setVersionInfo(null));
  }, []);

  useEffect(() => {
    if (activeCompanyId) refreshExportProfiles();
  }, [activeCompanyId, refreshExportProfiles]);

  if (!config) {
    return (
      <div className="page">
        <PageHeader title="Settings" />
        <div className="muted" style={{ padding: 'var(--s-5)' }}>Loading…</div>
      </div>
    );
  }

  async function patch(key, value) {
    const next = await window.api.settings.setOne(key, value);
    setConfig(next);
    // v0.49.33: the only keys we used to mirror in the Zustand store
    // (`bgRemovalEngine`, `removeBgApiKey`) were removed with the paid
    // bg-removal engine. If we ever start mirroring another key here,
    // re-add the `refreshAppConfig()` call inside its branch.
  }

  async function handlePrefetchBgModel() {
    setModelDownload({ state: 'running', label: 'Connecting…' });
    try {
      await prefetchLocalModel((stage, ratio) => {
        const pct = Math.round((ratio ?? 0) * 100);
        if (stage.startsWith('fetch:')) {
          setModelDownload({ state: 'running', label: `Downloading model… ${pct}%` });
        } else if (stage === 'compile') {
          setModelDownload({ state: 'running', label: `Compiling WASM… ${pct}%` });
        } else {
          setModelDownload({ state: 'running', label: `Warming up… ${pct}%` });
        }
      });
      setModelDownload({ state: 'done', label: 'Model ready' });
      addToast('Background-removal model downloaded and cached', 'success');
    } catch (err) {
      setModelDownload({ state: 'error', label: err.message || 'Download failed' });
      addToast(err.message || 'Model download failed', 'error');
    }
  }

  async function handlePickDefaultExportFolder() {
    const folder = await window.api.files.pickFolder();
    if (folder) await patch('defaultExportFolder', folder);
  }

  async function handleChangeDataFolder() {
    // Pick the new folder first.
    const next = await window.api.files.pickFolder();
    if (!next) return;
    if (next === config.dataDir) {
      addToast('That’s already the current data folder.', 'info');
      return;
    }
    // Open the dedicated modal — explicit "Move existing data" checkbox + single confirm button.
    setPendingDataFolder(next);
  }

  async function confirmChangeDataFolder(move) {
    const next = pendingDataFolder;
    if (!next) return;
    setPendingDataFolder(null);
    try {
      const result = await window.api.settings.changeDataFolder(next, move);
      // v0.21.4: if we just MOVED data and the old folder still
      // has files (cpSync doesn't delete the source — it copies),
      // offer to send the old folder to Trash. Recoverable from
      // Finder if anything turns out to be missing.
      if (move && result?.oldStillHasData && result?.oldPath) {
        const trashIt = await confirm({
          title: 'Move old data folder to Trash?',
          message: `Your data is now at:\n${result.newPath}\n\nThe old copy at the following path is still on disk — same files, but no longer referenced by the app:\n${result.oldPath}`,
          detail: 'You can recover it from Trash if anything turns out to be missing in the new location. If you keep it, you can delete it manually later.',
          confirmLabel: 'Move to Trash',
          cancelLabel: 'Keep for now',
        });
        if (trashIt) {
          try {
            await window.api.settings.trashFolder(result.oldPath);
            addToast('Old data folder moved to Trash.', 'success');
          } catch (err) {
            addToast(`Couldn't trash old folder: ${err.message}`, 'error');
          }
        }
      }
      addToast(move ? 'Data moved. Restarting…' : 'Pointed at new folder. Restarting…', 'success');
      setTimeout(() => window.api.app.relaunch(), 600);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  // v0.49.33: handleTestRemoveBg was removed with the paid bg-removal
  // engine — the API-key field, the test button, and the monthly-usage
  // counter that drove it are all gone.

  // v0.22.13: category add/remove handlers used to live here. They
  // moved to renderer/modules/Categories/index.jsx so the Settings
  // page doesn't grow when the user adds a category mid-session.

  const TOKEN_OPTIONS = ['SKU', 'NAME', 'COLOR', 'BRAND', 'INDEX', 'DATE'];

  return (
    <div className="page page--settings">
      <PageHeader title="Settings" />

      {/* v0.26.25: restart banner. Pinned just below the page header
          so it sits above ALL tabs — connection settings live in the
          Multi-Mac tab, but the banner needs to be visible from any
          tab the user might have open (you might switch back to
          General after editing the URL and forget the change is
          pending). Compares current config against the boot snapshot
          and shows itself only when something restart-relevant has
          drifted in this session. */}
      <RestartBanner config={config} snapshot={bootSnapshot} addToast={addToast} />

      <div className="settings-shell">
        {/* v0.22.13: vertical tab rail on the left. Each button is
            also accessible via keyboard (focus + Enter); the rail
            stays put as a sibling of the scrollable pane so navigating
            doesn't lose your place. */}
        <nav className="settings-tabs" aria-label="Settings sections">
          {SETTINGS_TABS
            .filter((t) => t.key !== 'backups' || config.mode !== 'client')
            .map((t) => (
            <button
              key={t.key}
              type="button"
              className={`settings-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => selectTab(t.key)}
              aria-pressed={tab === t.key}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-pane">

        {tab === 'multi-mac' && (
        <div className="settings-page">
        <h2 className="settings-section-heading">Multi-Mac (beta)</h2>

        <SettingRow
          label="Mode"
          hint="Standalone: this Mac only (default). Server: this Mac hosts data for other Macs over the network. Client: this Mac is a thin frontend for a remote server. Changing mode restarts the app. Networking ships across v0.14.x — v0.14.0 is the foundation only."
        >
          <ModeSegment config={config} addToast={addToast} />
        </SettingRow>

        {config.mode === 'server' ? (
          <ServerModePanel config={config} addToast={addToast} />
        ) : null}

        {config.mode === 'client' ? (
          <ClientModePanel config={config} patch={patch} />
        ) : null}

        {/* v0.26.32: migration section — applies in all three modes.
            Standalone Macs may want to move to a new machine; Server
            Macs migrating to a dedicated Mac mini is the canonical
            use case; Client Macs probably won't use it but it's still
            harmless to show — the buttons only touch the local
            machine's filesystem. Hidden behind a small visual divider
            so the user sees Migration as its own concern, separate
            from per-mode setup. */}
        {config.mode !== 'client' ? (
          <>
            <h3 className="settings-subsection-heading">Migration</h3>
            <MigrationPanel config={config} addToast={addToast} />
          </>
        ) : null}
        </div>
        )}

        {tab === 'general' && (
        <div className="settings-page">
        <h2 className="settings-section-heading">General</h2>

        <SettingRow
          label="Theme"
          hint="Light, Dark, or follow your operating system."
        >
          <ThemeSegment />
        </SettingRow>

        <SettingRow
          label="Default output folder"
          hint="Where Export Center writes the final marketplace-ready image files (JPG / PNG / WEBP). Pre-fills the destination picker so you don't keep navigating to the same folder on every export run."
        >
          <div className="setting-control-row">
            <Input
              value={config.defaultExportFolder ?? ''}
              readOnly
              placeholder="Not set — Export Center will ask each time"
              onChange={() => {}}
            />
            <Button onClick={handlePickDefaultExportFolder}>Pick…</Button>
            {config.defaultExportFolder ? (
              <Button variant="ghost" onClick={() => patch('defaultExportFolder', null)}>Clear</Button>
            ) : null}
          </div>
        </SettingRow>

        <SettingRow
          label="Default export profile"
          hint={activeCompanyId
            ? 'A profile bundles output size + format + quality + background fill + naming pattern (e.g. an Amazon 2000×2000 JPG profile). Pre-selecting one means Export Center opens to it instead of an empty selector. Build profiles in Export Center.'
            : 'Select a company first — profiles are managed per company in Export Center.'}
        >
          <Select
            value={config.defaultExportProfileId ?? ''}
            onChange={(e) => patch('defaultExportProfileId', e.target.value || null)}
          >
            <option value="">— None —</option>
            {exportProfiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow
          label="Data folder"
          hint="SQLite database and image assets live here. Changing the folder restarts the app. Point at a folder on iCloud Drive (or any cloud-synced folder) to share data across Macs — see notes below."
        >
          <div className="setting-control-row">
            <Input value={config.dataDir} readOnly onChange={() => {}} />
            {config.dataDirIsCloud ? (
              <span className="data-folder-tag data-folder-tag--cloud" title="This folder is inside iCloud Drive">☁ iCloud</span>
            ) : (
              <span className="data-folder-tag data-folder-tag--local" title="This folder is on local disk only">📁 Local</span>
            )}
            <Button onClick={() => window.api.app.openDataFolder()}>Open</Button>
            <Button onClick={handleChangeDataFolder}>Change…</Button>
          </div>
          {config.dataDirIsCloud ? (
            <div className="cloud-sync-note">
              <strong>iCloud sync mode active.</strong> Image Studio KH switched SQLite into a sync-friendly journal mode automatically. To avoid corruption:
              <ul>
                <li><b>Quit the app completely before switching computers.</b> Cmd+Q, not just closing the window.</li>
                <li>Wait until iCloud finishes syncing on the source Mac before opening on the destination — the folder's cloud icon in Finder should be a solid checkmark, not cycling arrows.</li>
                <li><b>Don't open the app on two Macs at once.</b> SQLite will corrupt if both write simultaneously.</li>
                <li>In System Settings → iCloud → iCloud Drive, make sure <em>Optimize Mac Storage</em> is OFF for this folder — otherwise macOS may evict files you need.</li>
              </ul>
            </div>
          ) : null}
        </SettingRow>

        {/* v0.49.33: the "Background removal engine" picker (local vs
            remove.bg API) was removed along with the paid engine
            itself. Only the bundled local @imgly engine remains, so
            there's no choice to surface anymore — the section now
            jumps straight to the model pre-download + cache management
            rows below. */}

        <SettingRow
          label="Pre-download local model"
          hint={
            config.mode === 'client'
              ? 'Bg removal runs ON THIS MAC. The @imgly WASM model downloads ~80 MB from staticimgly.com on first use. Pre-fetch it now so you\'re not stuck waiting the first time you open the Workspace. Subsequent app launches reuse the cache. The server is NOT a middleman — each Mac downloads + caches its own copy.'
              : 'The @imgly engine downloads a ~80 MB model on first use. Pre-fetch it now so you\'re not stuck waiting the first time you open the Workspace. Subsequent app launches reuse the cache.'
          }
        >
          <div className="setting-control-row">
            <Button
              onClick={handlePrefetchBgModel}
              disabled={modelDownload.state === 'running'}
            >
              {modelDownload.state === 'running' ? 'Downloading…' :
               modelDownload.state === 'done'    ? 'Re-download' :
                                                   'Download model now'}
            </Button>
            {modelDownload.label ? (
              <span
                className={`muted bg-model-status bg-model-status--${modelDownload.state}`}
              >
                {modelDownload.label}
              </span>
            ) : null}
          </div>
        </SettingRow>

        {/* v0.26.39: cache visibility + Clear cache. Reads from
            `app:getCacheInfo` on mount + after Clear. Showing the
            actual MB count + last-used date converts "is it cached?"
            from a leap-of-faith into a visible fact, which is the
            whole point of this row. App updates do NOT touch this
            cache — it lives in ~/Library/Application Support/...
            which is outside the .app bundle. */}
        <SettingRow
          label="Local model cache"
          hint="Where the @imgly model is stored on this Mac. App updates DO NOT touch this cache — only deleting the data folder or clicking Clear below forces a re-download. Total size dominated by the ~80MB ONNX model; a few KB of other HTTPS responses live here too."
        >
          <BgModelCachePanel />
        </SettingRow>

        {/* v0.49.33: the "remove.bg API key" + "remove.bg usage this
            month" rows were removed when the paid engine was dropped.
            The local @imgly model is now the only background-removal
            path; it doesn't need an API key or a monthly counter. */}

        </div>
        )}

        {tab === 'library' && (
        <div className="settings-page">
        <h2 className="settings-section-heading">Product Library</h2>

        <SettingRow
          label="Hover preview"
          hint="When on, hovering a grid card with multiple images cycles through all of them. When off, the card just shows the main image (the small +N badge in the corner stays either way so you can tell at a glance which products have extras)."
        >
          <HoverPreviewSegment />
        </SettingRow>

        </div>
        )}

        {tab === 'categories' && (
        <div className="settings-page">
          <h2 className="settings-section-heading">Categories</h2>
          {/* v0.22.14: dedicated Settings tab. CategoriesBody is the
              same component that used to render as a stand-alone page —
              autofocuses its add input on mount so users immediately
              see where to type (the "+ Add" button was being mistaken
              for permanently-disabled). */}
          <CategoriesBody autoFocus />
        </div>
        )}

        {tab === 'ai' && (
        <div className="settings-page">
        <h2 className="settings-section-heading">AI Generation</h2>

        <SettingRow
          label="kie.ai API key"
          hint="Required for kie.ai models (gpt4o-image, flux-kontext). Get a key at kie.ai/api-key."
        >
          <ApiKeyRow
            valueKey="kieApiKey"
            config={config}
            patch={patch}
            testFn={(k) => window.api.ai.testKie(k)}
          />
        </SettingRow>

        <SettingRow
          label="kie.ai concurrency"
          hint="Maximum simultaneous kie.ai generations (1–10)."
        >
          <Input
            type="number" min="1" max="10"
            value={config.kieConcurrency ?? 3}
            onChange={(e) => patch('kieConcurrency', Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            style={{ width: 100 }}
          />
        </SettingRow>

        <SettingRow
          label="fal.ai API key"
          hint="Required for fal.ai models. Get a key at fal.ai/dashboard/keys."
        >
          <ApiKeyRow
            valueKey="falApiKey"
            config={config}
            patch={patch}
            testFn={(k) => window.api.ai.testFal(k)}
          />
        </SettingRow>

        <SettingRow
          label="fal.ai concurrency"
          hint="Maximum simultaneous fal.ai generations (1–10)."
        >
          <Input
            type="number" min="1" max="10"
            value={config.falConcurrency ?? 3}
            onChange={(e) => patch('falConcurrency', Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            style={{ width: 100 }}
          />
        </SettingRow>

        <SettingRow
          label="Default filename separator"
          hint="Used when creating new export profiles."
        >
          <Select
            value={config.defaultSeparator ?? '-'}
            onChange={(e) => patch('defaultSeparator', e.target.value)}
          >
            <option value="-">Dash (-)</option>
            <option value="_">Underscore (_)</option>
            <option value="">None</option>
          </Select>
        </SettingRow>

        <SettingRow
          label="Default token order"
          hint="Pre-fills the naming pattern in new export profiles."
        >
          <div className="settings-tokens">
            {TOKEN_OPTIONS.map((tok) => {
              const tokens = config.defaultTokens ?? [];
              const active = tokens.includes(tok);
              return (
                <button
                  key={tok}
                  type="button"
                  className={`token-chip${active ? ' is-active' : ''}`}
                  onClick={() => {
                    const next = active ? tokens.filter((t) => t !== tok) : [...tokens, tok];
                    patch('defaultTokens', next);
                  }}
                >
                  {tok}
                </button>
              );
            })}
          </div>
        </SettingRow>

        <SettingRow
          label="Built-in marketplace presets"
          hint="Bundled with the app. Use these as starting points when creating an Export profile, or define your own below."
        >
          <ul className="settings-list settings-list--readonly">
            {MARKETPLACE_PRESETS.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <span className="muted">{p.width}×{p.height} · {p.format.toUpperCase()} · {p.colorProfile}</span>
              </li>
            ))}
          </ul>
        </SettingRow>

        <SettingRow
          label="Custom marketplace presets"
          hint="Your own size/format profiles that appear in the Export Center alongside the built-ins."
        >
          <CustomPresetEditor config={config} onChange={(presets) => patch('customPresets', presets)} />
        </SettingRow>

        {/* v0.22.13: the old inline category list lived here. Lifted
            to its own sidebar page (Categories) so the Settings
            layout stops shifting as the list grows. */}
        </div>
        )}

        {tab === 'backups' && config.mode !== 'client' && (
          <BackupsPanel config={config} />
        )}

        {tab === 'roles' && (
        <div className="settings-page">
          <RolesPanel addToast={addToast} />
        </div>
        )}

        {tab === 'about' && (
        <div className="settings-page">
        <AboutCard versionInfo={versionInfo} />
        </div>
        )}

        </div>{/* /.settings-pane */}
      </div>{/* /.settings-shell */}

      <ChangeDataFolderModal
        open={pendingDataFolder !== null}
        fromPath={config.dataDir}
        toPath={pendingDataFolder}
        onCancel={() => setPendingDataFolder(null)}
        onConfirm={confirmChangeDataFolder}
      />
    </div>
  );
}

function ChangeDataFolderModal({ open, fromPath, toPath, onCancel, onConfirm }) {
  const [moveData, setMoveData] = useState(true);
  const [busy, setBusy] = useState(false);

  // Reset to default each time the modal re-opens.
  useEffect(() => {
    if (open) {
      setMoveData(true);
      setBusy(false);
    }
  }, [open]);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm(moveData);
    } finally {
      // Window restarts; no need to reset busy.
    }
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Change data folder"
      closeOnBackdrop={false}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={busy}>
            {busy ? 'Working…' : 'Switch & restart'}
          </Button>
        </>
      }
    >
      <div className="confirm-modal__body">
        <p className="confirm-modal__message">
          The app will restart after this.
        </p>
        <div className="data-folder-paths">
          <div className="data-folder-paths__row">
            <span className="data-folder-paths__label">From</span>
            <code>{fromPath}</code>
          </div>
          <div className="data-folder-paths__row">
            <span className="data-folder-paths__label">To</span>
            <code>{toPath}</code>
          </div>
        </div>
        <label className="data-folder-move">
          <input
            type="checkbox"
            checked={moveData}
            onChange={(e) => setMoveData(e.target.checked)}
            disabled={busy}
          />
          <span>
            <strong>Move existing data</strong> — copy the database, raw images,
            processed images, and AI gallery to the new folder.
          </span>
        </label>
        <p className="confirm-modal__detail">
          When unchecked, the app just points at the new folder; the existing data
          stays where it is and will look empty until you put files there.
        </p>
        {/* v0.49.31: a data-folder change moves/relocates everything —
            surface the last backup + a one-click backup before switching. */}
        <BackupReminder />
      </div>
    </Modal>
  );
}

function ApiKeyRow({ valueKey, config, patch, testFn }) {
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const addToast = useAppStore((s) => s.addToast);
  const value = config[valueKey] ?? '';

  async function handleTest() {
    if (!value) { addToast('Enter a key first', 'error'); return; }
    setTesting(true);
    try {
      const res = await testFn(value);
      addToast(`Connected${res?.hint ? ' — ' + res.hint : ''}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="setting-control-row">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => patch(valueKey, e.target.value || null)}
        autoComplete="off"
        spellCheck={false}
        placeholder="(not set)"
      />
      <Button variant="ghost" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</Button>
      <Button onClick={handleTest} disabled={testing || !value}>
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
    </div>
  );
}

function CustomPresetEditor({ config, onChange }) {
  const [draft, setDraft] = useState({ name: '', width: '', height: '', format: 'jpg', colorProfile: 'sRGB' });
  const presets = config.customPresets ?? [];

  function handleAdd() {
    const name = draft.name.trim();
    const w = Number(draft.width);
    const h = Number(draft.height);
    if (!name || !Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64) return;
    const id = `custom-${Date.now().toString(36)}`;
    const next = [...presets, { id, name, width: w, height: h, format: draft.format, colorProfile: draft.colorProfile }];
    onChange(next);
    setDraft({ name: '', width: '', height: '', format: 'jpg', colorProfile: 'sRGB' });
  }

  function handleRemove(id) {
    onChange(presets.filter((p) => p.id !== id));
  }

  return (
    <div className="settings-list-control">
      {presets.length === 0 ? (
        <p className="setting-row__hint" style={{ marginTop: 0 }}>No custom presets yet.</p>
      ) : (
        <ul className="settings-list">
          {presets.map((p) => (
            <li key={p.id}>
              <span>{p.name}</span>
              <span className="muted">{p.width}×{p.height} · {p.format.toUpperCase()} · {p.colorProfile}</span>
              <button type="button" className="row-action" onClick={() => handleRemove(p.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      <div className="custom-preset-add">
        <Input
          placeholder="Name (e.g. Catalog 4×6)"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <Input
          type="number"
          placeholder="W"
          value={draft.width}
          onChange={(e) => setDraft((d) => ({ ...d, width: e.target.value }))}
        />
        <Input
          type="number"
          placeholder="H"
          value={draft.height}
          onChange={(e) => setDraft((d) => ({ ...d, height: e.target.value }))}
        />
        <Select
          value={draft.format}
          onChange={(e) => setDraft((d) => ({ ...d, format: e.target.value }))}
        >
          <option value="jpg">JPG</option>
          <option value="png">PNG</option>
          <option value="webp">WEBP</option>
        </Select>
        <Button onClick={handleAdd} disabled={!draft.name.trim() || !draft.width || !draft.height}>
          + Add
        </Button>
      </div>
    </div>
  );
}

/**
 * v0.12.3: Library hover-preview on/off. Persisted in localStorage via
 * helpers exported from ProductLibrary so both the Library page and this
 * Settings page agree on the key + default. Changes take effect the next
 * time the user opens the Library (the module re-mounts on navigation).
 */
function HoverPreviewSegment() {
  const [on, setOn] = useState(loadHoverPreview);
  function toggle(next) {
    setOn(next);
    saveHoverPreview(next);
  }
  return (
    <div className="ws-toolbar__group" style={{ alignSelf: 'flex-start' }}>
      <button
        type="button"
        className={`segment${on ? ' is-active' : ''}`}
        onClick={() => toggle(true)}
      >On</button>
      <button
        type="button"
        className={`segment${!on ? ' is-active' : ''}`}
        onClick={() => toggle(false)}
      >Off</button>
    </div>
  );
}

function ThemeSegment() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const opts = [
    { value: 'light',  label: 'Light' },
    { value: 'dark',   label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
  return (
    <div className="ws-toolbar__group" style={{ alignSelf: 'flex-start' }}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`segment${theme === o.value ? ' is-active' : ''}`}
          onClick={() => setTheme(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

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

