import { useEffect, useState } from 'react';
import { useAppStore } from './store/index.js';
import { Sidebar } from './components/Sidebar.jsx';
import { ToastHost } from './components/Toast.jsx';
import { ProgressOverlay } from './components/ProgressOverlay.jsx';
// v0.26.44: ClientSyncOverlay (the full-window first-sync splash) was
// removed. The sidebar NetworkChip now shows boot-sync progress
// inline — no more blocking modal.
import { ConflictModalHost } from './components/ConflictModal.jsx';
import { ShortcutsModal } from './components/ShortcutsModal.jsx';
import { SearchPalette } from './components/SearchPalette.jsx';
// v0.26.44: RemoteChangesBanner removed. Remote events from other
// Macs now auto-apply silently (debounced via catalogEvents.js so
// bursts coalesce to a single per-slice refetch). Conflict detection
// at save time (v0.17.2) still catches the rare two-people-edited-
// the-same-row case. Users can audit cross-Mac edits via the History
// page.
import { PageErrorBoundary } from './components/PageErrorBoundary.jsx';
import { Dashboard } from './modules/Dashboard/index.jsx';
import { Companies } from './modules/Companies/index.jsx';
import { Brands } from './modules/Brands/index.jsx';
import { ProductLibrary } from './modules/ProductLibrary/index.jsx';
import { ImageWorkspace } from './modules/ImageWorkspace/index.jsx';
import { ExportCenter } from './modules/ExportCenter/index.jsx';
import { AIStudio } from './modules/AIStudio/index.jsx';
import { OverlayStudio } from './modules/OverlayStudio/index.jsx';
import { History } from './modules/History/index.jsx';
import { Settings } from './modules/Settings/index.jsx';
import { Support } from './modules/Support/index.jsx';

const PAGES = {
  dashboard: Dashboard,
  company:   Companies,
  brands:    Brands,
  library:   ProductLibrary,
  workspace: ImageWorkspace,
  aistudio:  AIStudio,
  overlay:   OverlayStudio,
  export:    ExportCenter,
  history:   History,
  settings:  Settings,
  support:   Support,
};

const SHORTCUTS = {
  '1': 'dashboard',
  '2': 'library',
  '3': 'workspace',
  '4': 'aistudio',
  '5': 'overlay',
  '6': 'export',
  ',': 'settings',
};

export default function App() {
  const activeModule = useAppStore((s) => s.activeModule);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const isModuleAvailable = useAppStore((s) => s.isModuleAvailable);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const platform = useAppStore((s) => s.platform);
  const [ready, setReady] = useState(false);
  // v0.18.0: shortcuts modal toggled via Cmd/Ctrl+? — discovery hook
  // for everything the keyboard can do in the app.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // v0.18.2: global search palette toggled via Cmd/Ctrl+K.
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    bootstrap().finally(() => setReady(true));
  }, [bootstrap]);

  useEffect(() => {
    const onKey = (e) => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!cmdOrCtrl || e.altKey) return;
      // v0.18.0: Cmd/Ctrl + ? opens the shortcuts list. The `?` key
      // typically requires Shift on US keyboards, so we accept either
      // with Shift held OR the literal key '?' (some layouts produce
      // it without). `/` is the unshifted physical key on US layout
      // so we also accept Cmd+Shift+/.
      if (e.key === '?' || (e.shiftKey && (e.key === '/' || e.key === '?'))) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      // v0.18.2: Cmd/Ctrl + K opens the search palette.
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if (e.shiftKey) return;
      const target = SHORTCUTS[e.key];
      if (!target) return;
      if (!isModuleAvailable(target)) return;
      e.preventDefault();
      setActiveModule(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveModule, isModuleAvailable]);

  const Page = PAGES[activeModule] ?? Dashboard;
  const isMac = platform === 'darwin';

  return (
    <div className="shell">
      <Sidebar />
      <main className="shell__content">
        <div className={`titlebar${isMac ? ' titlebar--mac' : ''}`} />
        {ready ? (
          <PageErrorBoundary pageKey={activeModule}>
            <Page />
          </PageErrorBoundary>
        ) : null}
      </main>
      <ToastHost />
      <ProgressOverlay />
      {/* v0.26.44: ClientSyncOverlay + RemoteChangesBanner removed.
          Sync progress moved to the sidebar NetworkChip (less
          intrusive — user can keep working while data loads).
          Remote-change auto-apply replaced the Refresh banner. */}
      <ConflictModalHost />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
