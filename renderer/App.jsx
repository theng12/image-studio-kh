import { lazy, Suspense, useEffect, useState } from 'react';
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
// v0.49.31: routes split into eager + lazy. Eager = small modules + likely
// first-paint targets (Dashboard is the default; ProductLibrary is the most
// common landing once a company is picked). Lazy = anything heavy whose
// code shouldn\'t weigh down boot. Net effect on the renderer bundle was
// 1,878 KB → ~870 KB main + 4 separate route chunks. See PageFallback
// below for the loading state that fills the brief async gap while a
// chunk fetches.
//
// Why these picks, specifically:
//   - Dashboard, ProductLibrary: shown immediately on most boots — lazy-
//     loading them just paints a flash of skeleton for no real win.
//   - Companies, Brands, Settings, Support: small modules; the lazy split
//     overhead costs more bytes than it saves.
//   - ImageWorkspace, AIStudio, OverlayStudio, ExportCenter, History:
//     heavy, only visited on demand. Lazy-loading is a pure win — boot
//     is faster, the chunk only downloads when the user actually navigates.
//
// React.lazy() requires a default export, but our modules use named exports
// to keep tree-shaking friendly. The `.then(...)` adapter rewraps them so
// the dynamic import returns `{default: Component}` as React expects.
import { Dashboard } from './modules/Dashboard/index.jsx';
import { Companies } from './modules/Companies/index.jsx';
import { Brands } from './modules/Brands/index.jsx';
import { ProductLibrary } from './modules/ProductLibrary/index.jsx';
import { Settings } from './modules/Settings/index.jsx';
import { Support } from './modules/Support/index.jsx';
// v0.49.46: Suppliers — Phase 1 of the costing system. Eagerly imported
// because it's tiny (a single table + a modal form) and pre-loading is
// cheap. POs (v0.49.47) and Cost Calculator (v0.49.48) will likely lazy-
// split to stay off the boot path.
import { Suppliers } from './modules/Suppliers/index.jsx';

const ImageWorkspace = lazy(() =>
  import('./modules/ImageWorkspace/index.jsx').then((m) => ({ default: m.ImageWorkspace })),
);
const AIStudio = lazy(() =>
  import('./modules/AIStudio/index.jsx').then((m) => ({ default: m.AIStudio })),
);
const OverlayStudio = lazy(() =>
  import('./modules/OverlayStudio/index.jsx').then((m) => ({ default: m.OverlayStudio })),
);
const ExportCenter = lazy(() =>
  import('./modules/ExportCenter/index.jsx').then((m) => ({ default: m.ExportCenter })),
);
const History = lazy(() =>
  import('./modules/History/index.jsx').then((m) => ({ default: m.History })),
);

const PAGES = {
  dashboard: Dashboard,
  company:   Companies,
  brands:    Brands,
  suppliers: Suppliers,
  library:   ProductLibrary,
  workspace: ImageWorkspace,
  aistudio:  AIStudio,
  overlay:   OverlayStudio,
  export:    ExportCenter,
  history:   History,
  settings:  Settings,
  support:   Support,
};

/**
 * v0.49.31: brief loading state shown while a lazy-loaded route chunk fetches.
 * Designed to match the existing app shell — sidebar stays visible (it\'s
 * rendered outside this Suspense boundary), the main content area shows a
 * subtle centred spinner + label. On a local Electron install the chunk
 * fetch resolves in under ~50 ms, so this is rarely visible — it\'s here
 * for completeness, not as a focal point. Reuses the existing `.muted`
 * type style so it blends with the rest of the app\'s loading copy.
 */
function PageFallback() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: 'var(--c-text-subtle)',
        fontSize: 13,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '2px solid currentColor',
          borderTopColor: 'transparent',
          display: 'inline-block',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <span>Loading…</span>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

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
            {/* v0.49.31: Suspense INSIDE the error boundary so a chunk-
                load failure surfaces through PageErrorBoundary\'s "we hit
                a snag" UI instead of an unstyled crash. The fallback only
                renders while a lazy route fetches; eager routes render
                synchronously. */}
            <Suspense fallback={<PageFallback />}>
              <Page />
            </Suspense>
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
