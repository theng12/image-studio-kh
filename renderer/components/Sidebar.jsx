import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/index.js';
import { WhatsNewModal } from './WhatsNewModal.jsx';
import { PresenceModal } from './PresenceModal.jsx';
import { ConnectionLegendModal } from './ConnectionLegendModal.jsx';

/**
 * v0.26.30: collapsible sidebar. When the user runs the app on a
 * smaller display (or just wants more room for the page content), the
 * 220px sidebar can be reduced to a ~56px icon-only rail. Saves about
 * 164px of horizontal real estate — directly fixes the header-overflow
 * complaint on narrow windows because the page actions get room to
 * breathe.
 *
 * Preference persists in localStorage so the choice survives reloads.
 * Same load-on-init / save-on-change pattern the Library uses for its
 * view toggle (v0.26.23). Falls back to expanded on any read error.
 */
const SIDEBAR_COLLAPSED_KEY = 'Sidebar.collapsed';
function loadSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; }
  catch { return false; }
}
function saveSidebarCollapsed(v) {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? 'true' : 'false'); } catch {}
}

// v0.45.0: `roleMin` (optional) — the lowest role for which this nav item is
// shown. Omitted = visible to everyone. Hierarchy: viewer < photographer <
// editor < admin. Standalone / server-host renderers always run as admin
// since local IPC isn't gated.
const NAV = [
  {
    label: null,
    items: [
      { id: 'company',    name: 'Company',         icon: IconCompany },
      { id: 'dashboard',  name: 'Dashboard',       icon: IconDashboard,  shortcut: '1' },
      { id: 'brands',     name: 'Brands',          icon: IconBrand },
      // v0.22.13 promoted Categories to a top-level sidebar entry;
      // v0.22.14 demoted it back to a Settings tab. Brands has rich
      // per-row content (icon, color, product count) that justifies
      // top-level real estate; categories are just `{ id, name }`
      // and live more comfortably inside Settings. The full UI moved
      // with it (paginated list, inline rename, danger delete) — only
      // its location changed.
    ],
  },
  {
    label: 'Production',
    items: [
      { id: 'library',   name: 'Product Library', icon: IconLibrary,   shortcut: '2' },
      // The four below are all write-driven workflows — Viewer and
      // Photographer can't usefully do anything inside them, so they're
      // hidden rather than presented as dead links that 403 on every action.
      { id: 'workspace', name: 'Image Workspace', icon: IconWorkspace, shortcut: '3', roleMin: 'editor' },
      { id: 'aistudio',  name: 'AI Studio',       icon: IconAiStudio,  shortcut: '4', roleMin: 'editor' },
      { id: 'overlay',   name: 'Overlay Studio',  icon: IconOverlay,   shortcut: '5', roleMin: 'editor' },
      { id: 'export',    name: 'Export Center',   icon: IconExport,    shortcut: '6', roleMin: 'editor' },
    ],
  },
  {
    // v0.49.46: OPERATIONS section. v0.49.46 shipped Suppliers; v0.49.47
    // adds Purchase Orders + Cost Calculator. Hidden for viewer /
    // photographer roles because cost data is the kind of thing they
    // shouldn't see — the lowest role with access is editor. The whole
    // section is dropped if every item inside it is gated out (see
    // Sidebar render filter).
    label: 'Operations',
    items: [
      { id: 'suppliers',      name: 'Suppliers',       icon: IconSupplier, shortcut: '8', roleMin: 'editor' },
      { id: 'purchaseorders', name: 'Purchase Orders', icon: IconPo,       shortcut: '9', roleMin: 'editor' },
      { id: 'costcalc',       name: 'Cost Calculator', icon: IconCostCalc,                roleMin: 'editor' },
    ],
  },
  {
    label: 'System',
    items: [
      // v0.26.31: global audit-log feed. Sits above Settings because
      // it's something users will visit often ("what did my assistant
      // change yesterday?") whereas Settings is a configure-once page.
      { id: 'history',  name: 'History',  icon: IconHistory, shortcut: '7', roleMin: 'editor' },
      { id: 'settings', name: 'Settings', icon: IconSettings, shortcut: ',' },
    ],
  },
];

// Lowest → highest. Used by both nav filtering and the body data-role attr
// that downstream CSS gating in the Library / ProductForm keys off.
const ROLE_RANK = { viewer: 1, photographer: 2, editor: 3, admin: 4 };
function hasRoleAtLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 0);
}

export function Sidebar() {
  const activeModule = useAppStore((s) => s.activeModule);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const platform = useAppStore((s) => s.platform);
  const version = useAppStore((s) => s.appVersion);
  // v0.13.0: cloud-folder indicator. The store mirrors the
  // `dataDirIsCloud` flag the main process computes on each settings
  // read, so the sidebar can show a small ☁ badge when the user is
  // running against an iCloud-synced data folder.
  const dataDirIsCloud = useAppStore((s) => s.dataDirIsCloud);
  // v0.14.0: show mode chip in the footer when mode != standalone.
  // Helps users quickly verify whether the laptop's pointing at the
  // right server vs accidentally talking to its own data.
  const appMode = useAppStore((s) => s.appMode);
  // v0.14.3: live client-mode connection state (green/red dot). Updated
  // by the main-process ping loop and pushed via `client:connectionState`.
  const clientConnection = useAppStore((s) => s.clientConnection);
  // v0.17.0: currently-connected users (server + clients with an open
  // WebSocket). Updated via the `users:presence` push event from main.
  // Only meaningful in server / client modes; in standalone it's [].
  const presence = useAppStore((s) => s.presence);
  const isModuleAvailable = useAppStore((s) => s.isModuleAvailable);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  // v0.22.11: clickable presence + connection chip → modals.
  const [presenceOpen, setPresenceOpen] = useState(false);
  const [connLegendOpen, setConnLegendOpen] = useState(false);

  const modKey = platform === 'darwin' ? '⌘' : 'Ctrl+';

  // v0.26.30: collapse/expand toggle. The state lives here (not in
  // the store) because it's a pure UI preference local to the sidebar
  // component; nothing else in the app cares whether the sidebar is
  // collapsed. Persisted via localStorage helpers above.
  const [collapsed, setCollapsedRaw] = useState(loadSidebarCollapsed);
  const setCollapsed = (v) => { setCollapsedRaw(v); saveSidebarCollapsed(v); };

  // v0.45.0: effective role. Local IPC isn't role-gated, so standalone /
  // server-host renderers are admin by definition. In client mode we trust
  // the role the server attached to our connection; defaults to 'admin'
  // while whoami is still loading so the nav doesn't briefly hide modules
  // a connected admin / editor will get back a moment later.
  const role = appMode === 'client'
    ? (clientConnection?.user?.role || 'admin')
    : 'admin';

  // Mirror the role to <body> so module-level CSS (Library bulk toolbar,
  // ProductForm image × buttons, etc.) can hide write affordances without
  // every component having to re-derive it. Set/reset on every change so
  // a role switch (admin demotes a user mid-session) updates the UI cleanly.
  useEffect(() => {
    document.body.dataset.role = role;
    return () => { document.body.dataset.role = ''; };
  }, [role]);

  return (
    <>
      <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark">IS</div>
          <div className="sidebar__brand-name">Image Studio KH</div>
          {/* v0.26.30: collapse toggle. Chevron flips direction based
              on state — points LEFT when expanded (click to collapse,
              chevron points away from content), points RIGHT when
              collapsed (click to expand, chevron points toward
              content). Always-visible in both states so the user has
              a way back regardless of collapsed-state. */}
          <button
            type="button"
            className="sidebar__collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              {collapsed
                ? <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M8 2L4 6l4 4"  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              }
            </svg>
          </button>
        </div>

        <CompanySwitcher />

        <nav className="sidebar__nav" aria-label="Primary">
          {NAV.map((section, sectionIdx) => (
            <div key={sectionIdx} className="sidebar__section">
              {section.label ? (
                <div className="sidebar__section-label">{section.label}</div>
              ) : null}
              {section.items.filter((item) => !item.roleMin || hasRoleAtLeast(role, item.roleMin)).map((item) => {
                const Icon = item.icon;
                const active = activeModule === item.id;
                const disabled = !isModuleAvailable(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`sidebar__item${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
                    onClick={() => !disabled && setActiveModule(item.id)}
                    title={
                      disabled
                        ? 'Create a company first'
                        : item.shortcut
                        ? `${item.name} (${modKey}${item.shortcut})`
                        : item.name
                    }
                    disabled={disabled}
                  >
                    <Icon className="sidebar__item-icon" />
                    <span>{item.name}</span>
                    {item.shortcut ? (
                      <span className="sidebar__item-shortcut">{modKey}{item.shortcut}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar__footer">
          <button
            type="button"
            className="sidebar__footer-btn"
            onClick={() => setWhatsNewOpen(true)}
          >
            <IconSparkles className="sidebar__footer-btn-icon" />
            <span>What's new</span>
          </button>
          <button
            type="button"
            className={`sidebar__footer-btn${activeModule === 'support' ? ' is-active' : ''}`}
            onClick={() => setActiveModule('support')}
          >
            <IconHeart className="sidebar__footer-btn-icon" />
            <span>Support this app</span>
          </button>

          {/* v0.22.11: always render the presence row in non-standalone
              modes so the user has a stable click target — even when
              nobody else is connected. Empty list still opens the modal
              and explains the situation. */}
          {appMode !== 'standalone' ? (
            <PresenceRow
              presence={presence}
              onClick={() => setPresenceOpen(true)}
            />
          ) : null}

          {/* v0.26.33: steady-state network heartbeat for client mode.
              Always-on once the boot SyncOverlay dismisses — gives the
              user a persistent "data is flowing" affordance so they
              never have to guess whether a slow page is "still
              loading" or "frozen". */}
          {appMode === 'client' ? <NetworkChip /> : null}

          <div className="sidebar__footer-row">
            <span className="sidebar__version">v{version || '0.0.0'}</span>
            {appMode === 'server' ? (
              <span
                className="sidebar__storage-tag sidebar__storage-tag--server"
                title="This Mac is running in Server mode — it hosts data for other Macs."
              >🌐 Server</span>
            ) : appMode === 'client' ? (
              // v0.22.11: clickable. Opens the legend modal which
              // explains what each colour means + shows live state +
              // a "Test connection now" button.
              <button
                type="button"
                className={`sidebar__storage-tag sidebar__storage-tag--client sidebar__storage-tag--conn-${clientConnection?.status || 'unknown'}`}
                onClick={() => setConnLegendOpen(true)}
                title={(() => {
                  const s = clientConnection?.status;
                  if (s === 'connected') return `Connected to server${clientConnection?.serverVersion ? ` (v${clientConnection.serverVersion})` : ''}. Click for details.`;
                  if (s === 'disconnected') return `Disconnected: ${clientConnection?.lastError || 'check Server URL / Token in Settings.'} Click for help.`;
                  // v0.26.38: 'degraded' — server returned a 5xx on
                  // /api/ping. Connection is up but the server had a
                  // transient hiccup. Distinct from disconnected.
                  if (s === 'degraded') return `Server is reachable but returned an error: ${clientConnection?.lastError || 'unknown'}. Click for details.`;
                  return 'Checking connection to server… click for details.';
                })()}
              >
                <span className="sidebar__conn-dot" aria-hidden="true" />
                📡 Client
              </button>
            ) : dataDirIsCloud ? (
              <span
                className="sidebar__storage-tag"
                title="Data folder is on iCloud Drive. Quit before switching Macs; don't open on two Macs at once."
              >☁ iCloud</span>
            ) : null}
          </div>
        </div>
      </aside>

      <WhatsNewModal open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
      <PresenceModal open={presenceOpen} onClose={() => setPresenceOpen(false)} />
      <ConnectionLegendModal open={connLegendOpen} onClose={() => setConnLegendOpen(false)} />
    </>
  );
}

function CompanySwitcher() {
  const companies = useAppStore((s) => s.companies);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const setActiveCompany = useAppStore((s) => s.setActiveCompany);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const active = companies.find((c) => c.id === activeCompanyId) ?? null;

  useEffect(() => {
    if (!open) return undefined;
    function onClick(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleSelect(id) {
    setOpen(false);
    setActiveCompany(id);
  }

  function handleNew() {
    setOpen(false);
    setActiveModule('company');
  }

  return (
    <div className="company-switcher" ref={wrapRef}>
      <button
        type="button"
        className="company-switcher__button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {active ? (
          <>
            <span
              className="company-switcher__swatch"
              style={{ background: active.color || '#1c1c1f' }}
            />
            <span className="company-switcher__name">{active.name}</span>
          </>
        ) : (
          <span className="company-switcher__name company-switcher__name--empty">
            No company yet
          </span>
        )}
        <svg className="company-switcher__chevron" width="10" height="6" viewBox="0 0 10 6">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="company-switcher__menu" role="listbox">
          {companies.length === 0 ? (
            <div className="company-switcher__empty">No companies yet.</div>
          ) : (
            companies.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`company-switcher__option${c.id === activeCompanyId ? ' is-active' : ''}`}
                onClick={() => handleSelect(c.id)}
                role="option"
                aria-selected={c.id === activeCompanyId}
              >
                <span className="company-switcher__swatch" style={{ background: c.color || '#1c1c1f' }} />
                <span className="company-switcher__option-name">{c.name}</span>
                {c.id === activeCompanyId ? <IconCheck className="company-switcher__check" /> : null}
              </button>
            ))
          )}
          <div className="company-switcher__sep" />
          <button type="button" className="company-switcher__new" onClick={handleNew}>
            + Manage companies…
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * v0.17.0: Presence chip in the sidebar footer. Shows currently-
 * connected WebSocket users with a green dot and their names. When
 * there are 4+ users, collapses to the first three names plus "+N
 * more" so the chip stays one line in the 220px sidebar.
 *
 * Hover the chip to see the full list with roles. Standalone Macs
 * never render this (parent gates on `appMode !== 'standalone'` and
 * a non-empty list).
 */
function PresenceRow({ presence, onClick }) {
  // v0.22.11: clickable; opens the PresenceModal. The empty case
  // ("Nobody else online") still shows a click target so the user
  // can confirm + see help when they expect a teammate but don't
  // see them.
  const list = presence ?? [];
  const MAX_INLINE = 3;
  const inline = list.slice(0, MAX_INLINE);
  const overflow = list.length - inline.length;

  // Tooltip = full list with roles, one per line. Helps the user
  // identify e.g. "Sarah (editor)" vs "Theng (admin)" at a glance.
  const titleText = list.length === 0
    ? 'Nobody else online. Click for details.'
    : list.map((u) => `${u.name}${u.role ? ` (${u.role})` : ''}`).join(' · ') + ' · click for details';

  return (
    <button
      type="button"
      className={`sidebar__presence${list.length === 0 ? ' is-empty' : ''}`}
      title={titleText}
      onClick={onClick}
    >
      <span className="sidebar__presence-dot" aria-hidden="true" />
      <span className="sidebar__presence-label">
        {list.length === 0 ? (
          <span className="sidebar__presence-more">Nobody else online</span>
        ) : (
          <>
            {inline.map((u, i) => (
              <span key={u.id}>
                {u.name}
                {i < inline.length - 1 ? ', ' : ''}
              </span>
            ))}
            {overflow > 0 ? <span className="sidebar__presence-more"> +{overflow} more</span> : null}
          </>
        )}
      </span>
    </button>
  );
}

/**
 * v0.26.33: NetworkChip — sidebar footer indicator showing cumulative
 * bytes downloaded + time since last RPC activity. Visible in client
 * mode only. The user always has a "yes, the app is alive" signal,
 * not just during boot.
 *
 * Why this matters: the connection-state chip above (📡 Client · green
 * dot) tells the user "I CAN reach the server," but it doesn't tell
 * them "I JUST received data from the server." On a slow link those
 * are different facts — pings come back fast, but the actual catalog
 * RPC might still be hung on a 3-second response. This chip surfaces
 * the more useful signal: when did data last actually arrive.
 *
 * Re-rendering: subscribes to client:rpcActivity push events for the
 * counter updates + a 1s timer to keep the "Xs ago" string honest
 * between calls.
 */
function NetworkChip() {
  const [stats, setStats] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!window.api?.client?.syncStats) return undefined;
    let cancelled = false;
    window.api.client.syncStats().then((s) => {
      if (!cancelled) setStats(s);
    }).catch(() => {});
    const off = window.api.client.onRpcActivity?.((evt) => {
      if (cancelled) return;
      if (evt?.stats) setStats(evt.stats);
    });
    return () => { cancelled = true; off?.(); };
  }, []);

  // Tick once a second so the "X seconds ago" text doesn't go stale
  // between RPC calls. setInterval over setTimeout because we want
  // it always running, not stop-on-quiet.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!stats) return null;

  // Format helpers — duplicated from ClientSyncOverlay so the chip
  // can stay rendered in trees that don't import the overlay (none
  // today, but defensive).
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function fmtAgo(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'never';
    const s = Math.floor(ms / 1000);
    if (s < 2)  return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  const idle = stats.lastActivityAt ? (now - stats.lastActivityAt) : null;
  const isActive = stats.inFlight > 0;
  const isStale  = idle != null && idle > 60_000;
  // v0.26.44: boot-state detection. The dedicated full-window
  // ClientSyncOverlay was removed; this chip now picks up that job.
  // Heuristic: if call count is still small (< 12, which roughly
  // matches the bootstrap fan-out) AND elapsed since launch is < 30s,
  // we're still in the initial-sync phase. The chip gets a more
  // prominent "Syncing data…" label so the user knows what's happening
  // without a window-blocking modal.
  const elapsedSinceStart = stats.startedAt ? (now - stats.startedAt) : 0;
  const isBooting = stats.callCount < 12 && elapsedSinceStart < 30_000 && (isActive || stats.callCount === 0);

  return (
    <div
      className={`sidebar__net-chip${isActive ? ' is-active' : ''}${isStale ? ' is-stale' : ''}${isBooting ? ' is-booting' : ''}`}
      title={[
        isBooting ? 'First sync in progress — pages will fill in as their data arrives.' : null,
        `Downloaded: ${fmtBytes(stats.totalBytesIn)}`,
        `Uploaded: ${fmtBytes(stats.totalBytesOut)}`,
        `Total calls: ${stats.callCount}${stats.errorCount > 0 ? ` (${stats.errorCount} failed)` : ''}`,
        `In flight: ${stats.inFlight}`,
        `Last call: ${stats.lastChannel || '—'}`,
        idle != null ? `Last activity: ${fmtAgo(idle)}` : 'No activity yet',
      ].filter(Boolean).join('\n')}
    >
      <span className="sidebar__net-chip-arrow" aria-hidden>↓</span>
      <span className="sidebar__net-chip-bytes">{fmtBytes(stats.totalBytesIn)}</span>
      <span className="sidebar__net-chip-sep" aria-hidden>·</span>
      <span className="sidebar__net-chip-ago">
        {/* v0.26.44: boot-state label takes priority — replaces the
            old full-window ClientSyncOverlay. "First sync…" reads as
            "this is normal, data is loading", whereas the steady-
            state "syncing…" reads as "an action just fired now". */}
        {isBooting
          ? 'first sync…'
          : isActive
            ? 'syncing…'
            : idle != null
              ? fmtAgo(idle)
              : 'idle'}
      </span>
    </div>
  );
}

/* ─── Inline SVG icons ─────────────────────────────────────────── */

function IconDashboard({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="5.5" height="6"  rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.5" y="10.5" width="5.5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="2.5" width="5.5" height="5"   rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="9.5" width="5.5" height="6"   rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconCompany({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 15.5V5l5-2.5L13 5v10.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 15.5h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="6" y="9.5" width="4" height="6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconBrand({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M8.5 2.5h6V8.5L8.5 14.5L2.5 8.5L8.5 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="11" cy="6" r="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// v0.22.13: folder-stack glyph — fitting for "category" (a grouping
// concept). Kept stroke-only for visual parity with IconBrand etc.
function IconCategory({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.5 6V5a1 1 0 0 1 1-1h3l1.4 1.6h5.6a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V6z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M5 9h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconLibrary({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 7.5h13M7 3v12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconWorkspace({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 13l3.5-3.5 3 3 2-2L15 13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconExport({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 11.5V2.5M9 2.5L5.5 6M9 2.5L12.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v3.5C3 15.3 3.7 16 4.5 16h9c.8 0 1.5-.7 1.5-1.5V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// v0.49.10: was a sun (circle + 8 rays) which read as "weather / brightness"
// rather than "settings." Swapped for a Feather-style gear — recognised
// across every desktop OS as the universal settings symbol.
function IconSettings({ className }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// v0.26.31: clock with arrow — classic "history" iconography.
// v0.49.46: small box-on-a-shelf glyph for Suppliers. Two horizontal
// shelf lines + a stacked box reads as "inventory source" — distinct
// from Library (grid) and Brands (shield).
function IconSupplier({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2.5 6.5h13M2.5 12.5h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="5" y="3" width="5" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="9" width="4" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="9" width="5" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// v0.49.47: clipboard with check — Purchase Orders. Reads as
// "documented order" without colliding with Library's grid or
// History's clock.
function IconPo({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3.5" y="2.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="1.5" width="6" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M6 9.5l2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// v0.49.47: percentage/calc glyph — Cost Calculator. The "%" reads
// as margin/pricing; the surrounding rect echoes a calculator body.
function IconCostCalc({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="2.5" width="12" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="7" r="1" fill="currentColor" />
      <circle cx="11" cy="11" r="1" fill="currentColor" />
      <path d="M6.5 11.5l5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconHistory({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 5v4l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 4.5L3.5 7l2.5-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSparkles({ className }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1.5l1.2 3.3L11.5 6l-3.3 1.2L7 10.5 5.8 7.2 2.5 6l3.3-1.2L7 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M11.5 10l.5 1.5L13.5 12l-1.5.5L11.5 14l-.5-1.5L9.5 12l1.5-.5L11.5 10z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function IconHeart({ className }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 12.5S1.5 9.5 1.5 5.5C1.5 3.6 3 2 5 2c1.1 0 2.1.5 2.7 1.4l.3.4.3-.4C8.9 2.5 9.9 2 11 2c2 0 3.5 1.6 3.5 3.5 0 4-5.5 7-5.5 7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" transform="translate(-1, 0)" />
    </svg>
  );
}

function IconAiStudio({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 1.5l1.3 3.6L14 6.5l-3.7 1.4L9 11.5 7.7 7.9 4 6.5l3.7-1.4L9 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M14 11.5l.6 1.7L16.5 14l-1.9.8L14 16.5l-.6-1.7L11.5 14l1.9-.8L14 11.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function IconOverlay({ className }) {
  // Two stacked rectangles suggesting layers being composited.
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="9" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.08" />
    </svg>
  );
}

function IconCheck({ className }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 6.5L4.5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
