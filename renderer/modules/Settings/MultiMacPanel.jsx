/**
 * v0.26.43: extracted from Settings/index.jsx. Five components that
 * collectively render Settings → Multi-Mac tab plus the page-level
 * RestartBanner. Pure move, no behaviour change.
 *
 *  - ModeSegment      — Standalone / Server / Client picker (top of tab)
 *  - ServerModePanel  — server status + users table (server mode only)
 *  - ClientModePanel  — server URL + token + diagnostic (client mode only)
 *  - RestartBanner    — sticky banner shown at the top of Settings
 *                       whenever a restart-sensitive field has drifted
 *  - MigrationPanel   — Export / Import .iskhbundle (bottom of tab)
 *
 * SettingRow is intentionally inlined below (also defined in
 * Settings/index.jsx) — the two files would otherwise have a circular
 * import. Keep the two copies in sync if you ever change SettingRow.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Modal, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

// Inlined copy of SettingRow (also lives in Settings/index.jsx). See the
// file docblock for why this is duplicated rather than imported.
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
 * v0.14.0: Mode picker (Standalone / Server / Client). Switching modes
 * is restart-required because the boot path differs sharply. We confirm
 * first, then call the IPC which writes config + relaunches.
 */
export function ModeSegment({ config, addToast }) {
  const current = config?.mode ?? 'standalone';
  async function pick(next) {
    if (next === current) return;
    const ok = await confirm({
      title: `Switch to ${next} mode?`,
      message: 'Image Studio KH will quit and relaunch to apply the new mode.',
      detail:
        next === 'server'
          ? 'In server mode this Mac hosts the data over the network for other Macs to connect to. Your local data folder stays exactly as it is. (Networking ships in v0.14.1 — v0.14.0 lets you set up users now.)'
          : next === 'client'
            ? 'In client mode this Mac connects to a remote server instead of using its own data folder. You\'ll need a server address and a user token before you can do anything.'
            : 'In standalone mode this Mac uses only its local data folder. No network exposure.',
      confirmLabel: 'Switch & restart',
    });
    if (!ok) return;
    try {
      await window.api.settings.setMode(next);
      // Restart happens 200ms after the IPC returns, so showing a toast
      // is a courtesy that the user may or may not see.
      addToast?.('Restarting in mode: ' + next, 'info');
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }
  const opts = [
    { value: 'standalone', label: 'Standalone' },
    { value: 'server',     label: 'Server' },
    { value: 'client',     label: 'Client' },
  ];
  return (
    <div className="ws-toolbar__group" style={{ alignSelf: 'flex-start' }}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`segment${current === o.value ? ' is-active' : ''}`}
          onClick={() => pick(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

/**
 * Server-mode panel: lists users with their tokens, role, and last-seen.
 * Tokens are shown in full (not redacted) because the admin needs to be
 * able to copy them. This page exists only on the server Mac itself.
 */
export function ServerModePanel({ config, addToast }) {
  const [users, setUsers] = useState([]);
  const [showTokenFor, setShowTokenFor] = useState(null); // user id with token revealed
  const [busy, setBusy] = useState(false);
  // v0.14.1: inline add-user form replaces a broken window.prompt() that
  // Electron's BrowserWindow silently no-ops on.
  const [addForm, setAddForm] = useState(null); // null | { name, role }
  // v0.14.2: live server status (running / port / bind addresses).
  const [serverStatus, setServerStatus] = useState({ running: false });
  // v0.34.0: mobile/iPad web viewer toggle. Local mirror of the
  // `webViewerEnabled` config flag (default ON) so the switch is snappy;
  // persisted via settings.setOne. Server reads the flag per-request.
  const [webViewer, setWebViewer] = useState(config?.webViewerEnabled !== false);
  async function toggleWebViewer(next) {
    setWebViewer(next);
    try { await window.api.settings.setOne('webViewerEnabled', next); }
    catch (err) { setWebViewer(!next); addToast?.(err.message, 'error'); }
  }
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const s = await window.api.server.status();
        if (!cancelled) setServerStatus(s);
      } catch (_) {}
    }
    poll();
    const t = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  async function refresh() {
    try {
      const list = await window.api.users.list();
      setUsers(list);
      if (list.length === 0) {
        // First time in server mode — create the Owner user automatically
        // and reveal their token immediately for copy.
        const owner = await window.api.users.ensureOwner();
        if (owner) {
          setUsers([owner]);
          setShowTokenFor(owner.id);
        }
      }
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }
  // v0.26.41 (audit pass): `refresh` is omitted from deps on purpose —
  // it's recreated on every render of ServerModePanel and adding it
  // would re-fire the effect after every render (which calls setUsers,
  // which re-renders, infinite loop). Run-once-on-mount is what we want
  // here; subsequent refreshes are user-driven (Add user, regenerate, etc.).
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function openAdd() {
    setAddForm({ name: '', role: 'editor' });
  }
  function cancelAdd() {
    setAddForm(null);
  }
  async function submitAdd() {
    if (!addForm?.name?.trim()) {
      addToast?.('Name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      const u = await window.api.users.create(addForm.name.trim(), addForm.role);
      setUsers((curr) => [...curr, u]);
      setShowTokenFor(u.id);
      setAddForm(null);
      addToast?.(`Created ${u.name}. Token is shown — copy it before navigating away.`, 'info');
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function handleRegenerate(id) {
    const ok = await confirm({
      title: 'Regenerate token?',
      message: 'The user\'s existing clients will lose access on their next request.',
      confirmLabel: 'Regenerate',
      danger: true,
    });
    if (!ok) return;
    try {
      const u = await window.api.users.regenerateToken(id);
      setUsers((curr) => curr.map((x) => (x.id === id ? u : x)));
      setShowTokenFor(id);
      addToast?.('Token regenerated. Copy the new one before leaving this page.', 'info');
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  async function handleRemove(id, name) {
    const ok = await confirm({
      title: `Revoke ${name}?`,
      message: 'Their clients lose access immediately.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.api.users.remove(id);
      setUsers((curr) => curr.filter((u) => u.id !== id));
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  async function handleRoleChange(id, role) {
    try {
      const u = await window.api.users.update(id, { role });
      setUsers((curr) => curr.map((x) => (x.id === id ? u : x)));
    } catch (err) { addToast?.(err.message, 'error'); }
  }

  async function startServer() {
    try {
      const info = await window.api.server.start();
      setServerStatus({ running: true, ...info });
      addToast?.(`Server started on port ${info.port}`, 'success');
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  async function stopServer() {
    try {
      await window.api.server.stop();
      setServerStatus({ running: false });
      addToast?.('Server stopped', 'info');
    } catch (err) { addToast?.(err.message, 'error'); }
  }

  return (
    <>
    <SettingRow
      label="Server status"
      hint="The HTTP server clients connect to. Paste one of the addresses below (plus the port) into a client Mac's Connection settings. Tailscale addresses (100.x.x.x) work from anywhere; the Bonjour name (yourmac.local) is recommended for LAN clients because it doesn't change when your router hands out a new IP; raw LAN IPs (192.168 / 10.x) work but can stop working if DHCP gives the server a new lease."
    >
      <div className="server-status">
        <div className="server-status__row">
          <span className={`server-status__dot ${serverStatus.running ? 'is-on' : ''}`} aria-hidden />
          <span className="server-status__label">
            {serverStatus.running
              ? `Listening on port ${serverStatus.port}`
              : 'Not running'}
          </span>
          {serverStatus.running ? (
            <Button onClick={stopServer}>Stop</Button>
          ) : (
            <Button variant="primary" onClick={startServer}>Start</Button>
          )}
        </div>
        {serverStatus.running && serverStatus.addresses?.length > 0 ? (
          <div className="server-status__addrs">
            {serverStatus.addresses.map((a) => {
              const url = `http://${a.ip}:${serverStatus.port}`;
              // v0.26.35: pretty label per kind. The 'mdns' kind is
              // the new Bonjour entry — call it out as "BONJOUR" so
              // the user knows what they're looking at vs the LAN IPs
              // immediately below.
              const kindLabel = a.kind === 'tailscale' ? 'TAILSCALE'
                : a.kind === 'mdns' ? 'BONJOUR'
                : a.kind === 'lan' ? 'LAN'
                : a.kind.toUpperCase();
              const isRecommendedForLan = a.kind === 'mdns';
              return (
                <div key={a.ip} className="server-status__addr">
                  <span className={`server-status__kind server-status__kind--${a.kind}`}>{kindLabel}</span>
                  <code
                    className="server-status__url"
                    onClick={() => {
                      navigator.clipboard?.writeText(url);
                      addToast?.('Copied: ' + url, 'success');
                    }}
                    title={
                      a.kind === 'mdns'
                        ? 'Click to copy. Works for any Mac on the same Wi-Fi; survives router-assigned IP changes.'
                        : a.kind === 'tailscale'
                          ? 'Click to copy. Works from anywhere as long as both Macs are signed into the same Tailscale tailnet.'
                          : 'Click to copy. Same Wi-Fi only. May stop working if the router gives the server Mac a new IP — prefer the bonjour entry above.'
                    }
                  >{url}</code>
                  {isRecommendedForLan ? (
                    <span className="server-status__recommended" title="Recommended for LAN clients — doesn't change when DHCP assigns a new IP">Recommended for LAN</span>
                  ) : null}
                  <span className="muted server-status__iface">{a.name}</span>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* v0.26.35: tip about DHCP / LAN-IP volatility. Shown only
            when the server is running AND the address list contains
            at least one LAN IP (no point bothering Tailscale-only
            users). Explains why the IPs can change and points to the
            two stable alternatives: the Bonjour name (one click
            above) or a DHCP reservation (router-side). */}
        {serverStatus.running && (serverStatus.addresses ?? []).some((a) => a.kind === 'lan') ? (
          <div className="server-status__tip">
            <strong>Tip: LAN IPs can change.</strong> Your router uses DHCP, which means
            the <code>192.168 / 10.x</code> address above can be different after a sleep,
            a router reboot, or a lease expiration. If you pasted an IP into a client
            and they suddenly can&apos;t connect, that&apos;s most likely what happened.
            Two ways to dodge it:
            <ul>
              <li><strong>Use the Bonjour name</strong> ({(serverStatus.addresses ?? []).find((a) => a.kind === 'mdns')?.ip || 'yourmac.local'}) — Bonjour resolves it fresh on every connection, so the underlying IP can change without breaking anything. Works for any Mac on the same Wi-Fi.</li>
              <li><strong>Set a DHCP reservation on your router</strong> — log into the router admin, find the server Mac in the device list, tell it &quot;always give this Mac IP <code>192.168.x.x</code>&quot;. Survives reboots forever. One-time setup.</li>
            </ul>
            Tailscale users don&apos;t have to worry — those <code>100.x.x.x</code> addresses are tied to the Tailscale account, not the local network.
          </div>
        ) : null}
      </div>
    </SettingRow>
    <SettingRow
      label="Mobile web viewer"
      hint="Serves a lightweight phone/iPad page at /m on this same server — for viewing, searching, and adding product photos straight from the camera or photo library. Nothing to install: open the address in Safari and paste a user token. Toggle off to disable the page (your Mac clients' API stays up either way)."
    >
      <label className="toggle">
        <input type="checkbox" checked={webViewer} onChange={(e) => toggleWebViewer(e.target.checked)} />
        <span>{webViewer ? 'On' : 'Off'}</span>
      </label>
      {webViewer && serverStatus.running && (serverStatus.addresses ?? []).length > 0 ? (
        <div className="server-status__addrs" style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Open one of these in Safari on the phone/iPad:</div>
          {serverStatus.addresses.map((a) => {
            const url = `http://${a.ip}:${serverStatus.port}/m`;
            return (
              <div key={a.ip} className="server-status__addr">
                <code
                  className="server-status__url"
                  onClick={() => { navigator.clipboard?.writeText(url); addToast?.('Copied: ' + url, 'success'); }}
                  title="Click to copy — open this in Safari on your phone/iPad, then paste a user token."
                >{url}</code>
              </div>
            );
          })}
        </div>
      ) : null}
    </SettingRow>
    <SettingRow
      label="Users"
      hint="Each connecting Mac authenticates with a user token. Add one per person who'll use the app. Tokens are long random strings — show them to the admin once, then they're stored in the DB. Anyone with the token has the user's role; regenerate if a token leaks."
    >
      <div className="server-mode-users">
        <table className="users-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Token</th><th>Last seen</th><th></th></tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan="5" className="muted">No users yet.</td></tr>
            ) : users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>
                  <Select value={u.role} onChange={(e) => handleRoleChange(u.id, e.target.value)}>
                    <option value="admin">admin — full control</option>
                    <option value="editor">editor — edit catalog</option>
                    <option value="photographer">photographer — add photos only</option>
                    <option value="viewer">viewer — read-only</option>
                  </Select>
                </td>
                <td>
                  {showTokenFor === u.id ? (
                    <code className="user-token" onClick={() => {
                      navigator.clipboard?.writeText(u.token);
                      addToast?.('Token copied to clipboard', 'success');
                    }}>{u.token}</code>
                  ) : (
                    <button type="button" className="row-action" onClick={() => setShowTokenFor(u.id)}>Show token</button>
                  )}
                </td>
                <td className="muted">{u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : '—'}</td>
                <td>
                  <button type="button" className="row-action" onClick={() => handleRegenerate(u.id)} title="Regenerate token">↻</button>
                  <button type="button" className="row-action" onClick={() => handleRemove(u.id, u.name)} title="Revoke user">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {addForm ? (
          <div className="users-add-form">
            <Input
              autoFocus
              placeholder="User name (e.g. Assistant)"
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAdd();
                else if (e.key === 'Escape') cancelAdd();
              }}
            />
            <Select
              value={addForm.role}
              onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value }))}
            >
              <option value="editor">editor — edit catalog</option>
              <option value="admin">admin — full control</option>
              <option value="photographer">photographer — add photos only</option>
              <option value="viewer">viewer — read-only</option>
            </Select>
            <Button variant="primary" onClick={submitAdd} disabled={busy || !addForm.name.trim()}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
            <Button onClick={cancelAdd} disabled={busy}>Cancel</Button>
          </div>
        ) : (
          <div className="setting-control-row" style={{ marginTop: 'var(--s-3)' }}>
            <Button onClick={openAdd} disabled={busy}>+ Add user</Button>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
              Each user gets a 64-char token. Pin one to your assistant, one to yourself.
            </span>
          </div>
        )}
      </div>
    </SettingRow>
    </>
  );
}

/**
 * Client-mode panel: server URL + token entry. The "Test connection"
 * button is a placeholder until v0.14.1 actually boots the server.
 */
export function ClientModePanel({ config, patch }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, user, registeredChannels } | { ok:false, error }
  // v0.26.34: step-by-step diagnostic. Separate from testConnection so
  // a user who can't get past "Test connection" has a richer debug
  // surface to see which layer (URL / network / token) is the actual
  // problem.
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostic, setDiagnostic] = useState(null); // { overall, steps, serverVersion?, user? } | null
  const addToast = useAppStore((s) => s.addToast);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.api.client.testConnection(
        (config.clientServerUrl ?? '').trim(),
        (config.clientToken ?? '').trim(),
      );
      setTestResult(r);
      addToast?.(`Connected as ${r.user.name}`, 'success');
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
      addToast?.(err.message, 'error');
    } finally {
      setTesting(false);
    }
  }

  // v0.26.34: walk the URL → /api/ping → /api/whoami chain so the user
  // can see WHERE the connection fails, not just that it failed. Each
  // step renders with a pass/fail badge + a one-line explanation.
  async function runDiagnostic() {
    setDiagnosing(true);
    setDiagnostic(null);
    try {
      const r = await window.api.client.diagnoseServer(
        (config.clientServerUrl ?? '').trim(),
        (config.clientToken ?? '').trim(),
      );
      setDiagnostic(r);
      if (r.overall === 'ok') {
        addToast?.('All checks passed.', 'success');
      } else {
        const failed = r.steps?.find((s) => s.ok === false);
        if (failed) addToast?.(`Failed at: ${failed.label}`, 'error');
      }
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setDiagnosing(false);
    }
  }

  // v0.26.25: explicit Restart-now action for the success banner.
  // After a successful test the connection works, but the client
  // RUNTIME (the long-lived RPC + WS that all subsequent IPC calls
  // route through) reads URL + token once at boot. If the user
  // edited them in-session, the runtime is still using the old
  // values — and the app appears broken until they relaunch. This
  // button is the explicit "yes, restart and start using it" CTA.
  async function applyAndRestart() {
    try {
      addToast?.('Restarting…', 'info');
      await window.api.app.relaunch();
    } catch (err) {
      addToast?.(`Restart failed: ${err.message}`, 'error');
    }
  }

  return (
    <>
      <SettingRow
        label="Server address"
        hint="The IP or hostname where the Server-mode Mac is reachable. Over Tailscale that's a 100.x.x.x address; on LAN it's a 192.168 / 10.x address. Include http:// and the port (default 13180)."
      >
        <Input
          value={config.clientServerUrl ?? ''}
          onChange={(e) => patch('clientServerUrl', e.target.value)}
          placeholder="http://100.64.0.5:13180"
        />
      </SettingRow>
      <SettingRow
        label="User token"
        hint="The long random string the server admin gave you. Paste it once; it's stored locally and sent with every request as a Bearer token."
      >
        <Input
          type="password"
          value={config.clientToken ?? ''}
          onChange={(e) => patch('clientToken', e.target.value)}
          placeholder="64-character hex token"
        />
      </SettingRow>
      <SettingRow
        label="Connection"
        hint="Pings the server with your token. If it works you'll see your user info; if not you'll see why (server unreachable, token rejected, etc.). If Test connection fails with a vague error, click Run diagnostic to see exactly which layer failed (URL syntax / network / token)."
      >
        <div className="setting-control-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="setting-control-row">
            <Button variant="primary" onClick={testConnection} disabled={testing || diagnosing}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {/* v0.26.34: step-by-step diagnostic. Sits next to Test
                connection so the user has a richer fallback when the
                one-line error from Test isn't enough to debug. */}
            <Button onClick={runDiagnostic} disabled={testing || diagnosing}>
              {diagnosing ? 'Running…' : 'Run network diagnostic'}
            </Button>
          </div>

          {/* v0.26.34: diagnostic step list. Renders one row per step
              (URL / Server reachable / Token accepted), each with a
              pass/fail badge + a one-line explanation. So a user
              looking at "Server returned 401" knows the URL and
              network are fine and the token is the only thing left
              to fix. */}
          {diagnostic ? (
            <div className={`diagnostic-result diagnostic-result--${diagnostic.overall}`}>
              <div className="diagnostic-result__head">
                <strong>{diagnostic.overall === 'ok' ? 'All checks passed' : 'Diagnostic stopped at a failure'}</strong>
                {diagnostic.serverVersion ? (
                  <span className="muted"> · Server v{diagnostic.serverVersion}</span>
                ) : null}
              </div>
              <ol className="diagnostic-result__steps">
                {(diagnostic.steps ?? []).map((step, i) => (
                  <li
                    key={step.name ?? i}
                    className={`diagnostic-step diagnostic-step--${step.ok === true ? 'ok' : step.ok === false ? 'fail' : 'skip'}`}
                  >
                    <span className="diagnostic-step__badge" aria-hidden>
                      {step.ok === true ? '✓' : step.ok === false ? '✕' : '–'}
                    </span>
                    <div className="diagnostic-step__body">
                      <div className="diagnostic-step__label">{step.label || step.name}</div>
                      <div className="diagnostic-step__message">{step.message}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {testResult?.ok ? (
            <div className="connection-result connection-result--ok">
              <strong>Connected.</strong> Hello {testResult.user.name} ({testResult.user.role}).
              {/* v0.26.52: reworded the channel count. "Server exposes
                  89 channels" confused users into thinking 89 was a
                  number they had to interpret. It's just the size of
                  the server's RPC API surface — a "yep, full API is
                  available" sanity signal, nothing to act on. New
                  wording makes that clear; the raw number is demoted
                  to a hover title for the curious. */}
              {' '}
              <span
                className="muted"
                title={`The server exposes ${testResult.registeredChannels?.length ?? 0} RPC operations (its full API). This number is just a sanity check — nothing to act on.`}
              >
                Full API available ✓
              </span>
              {/* v0.26.25: when the test succeeds, surface the
                  next-step CTA inline so the user knows the click
                  worked AND that one more step (restart) is needed
                  before the rest of the app starts using this
                  connection. Without this prompt users in v0.14.x →
                  v0.26.24 said "I clicked Test, it said Connected,
                  but the Library is still broken" — because the
                  client runtime is initialised at app boot, not when
                  Test runs. The button explicitly applies and
                  restarts. */}
              <div className="connection-result__cta">
                <span>Restart now to start using this server.</span>
                <Button variant="primary" onClick={applyAndRestart}>
                  Restart now
                </Button>
              </div>
            </div>
          ) : testResult?.error ? (
            <div className="connection-result connection-result--err">
              {testResult.error}
            </div>
          ) : null}
        </div>
      </SettingRow>
    </>
  );
}

/**
 * v0.26.25: sticky restart banner shown at the top of Settings
 * whenever a restart-sensitive field has drifted from the boot
 * snapshot. The client runtime + server runtime read URL + token +
 * mode ONCE at app startup; mutating them in this session writes to
 * config.json but the running app still uses the old values until
 * relaunch. Before this banner the only signal was "the app seems
 * broken" — user changed URL, expected it to take effect, nothing
 * happened, blamed the app.
 *
 * Hidden when nothing has drifted. Three render states:
 *  - All-equal → renders null (no DOM weight)
 *  - clientServerUrl or clientToken changed → "Connection settings
 *    changed. Restart to apply." (the most common case)
 *  - mode changed via setMode WITHOUT the auto-relaunch firing
 *    (shouldn't happen — setMode self-restarts — but defensive)
 */
export function RestartBanner({ config, snapshot, addToast }) {
  if (!config || !snapshot) return null;
  const urlDrifted   = (config.clientServerUrl ?? '') !== (snapshot.clientServerUrl ?? '');
  const tokenDrifted = (config.clientToken     ?? '') !== (snapshot.clientToken     ?? '');
  const modeDrifted  = (config.mode            ?? 'standalone') !== (snapshot.mode  ?? 'standalone');
  const dirty = urlDrifted || tokenDrifted || modeDrifted;
  if (!dirty) return null;

  // Compose a precise message so the user knows WHY a restart is
  // needed (not just "something changed"). Order: mode first if it
  // changed, then URL/token. mode + url+token in the same session
  // is rare but possible (you toggled to client, switched back,
  // typed a URL).
  const changes = [];
  if (modeDrifted)  changes.push(`mode (${snapshot.mode} → ${config.mode})`);
  if (urlDrifted)   changes.push('server URL');
  if (tokenDrifted) changes.push('user token');
  const list = changes.length === 1
    ? changes[0]
    : changes.slice(0, -1).join(', ') + ' and ' + changes[changes.length - 1];

  async function restart() {
    try {
      addToast?.('Restarting…', 'info');
      await window.api.app.relaunch();
    } catch (err) {
      addToast?.(`Restart failed: ${err.message}`, 'error');
    }
  }

  return (
    <div className="restart-banner" role="status" aria-live="polite">
      <div className="restart-banner__icon" aria-hidden>↻</div>
      <div className="restart-banner__body">
        <div className="restart-banner__title">Restart needed to apply changes</div>
        <div className="restart-banner__detail">
          You changed {list} during this session. The running app is still using
          the old values; click below to relaunch and pick up the new ones.
        </div>
      </div>
      <button type="button" className="restart-banner__btn" onClick={restart}>
        Restart now
      </button>
    </div>
  );
}

/**
 * v0.26.32: Migration panel.
 *
 * Two sibling actions:
 *   - Export bundle: pack the active data folder + portable config
 *     keys into a single `.iskhbundle` file. The user picks where to
 *     save it (Save dialog). Bundle is portable across Macs.
 *   - Import bundle: pick a `.iskhbundle`, peek at its manifest,
 *     confirm, pick the target data folder on this Mac, write the
 *     contents in, restart so the new DB takes effect.
 *
 * Why both buttons live in one panel: they're the two halves of the
 * same migration story. Showing them together (with the divider above)
 * tells the user "this is how data moves between Macs."
 *
 * What does NOT travel through the bundle (and why):
 *   - mode / serverPort / clientServerUrl / clientToken — the new Mac
 *     keeps its own networking. If you import a server bundle onto a
 *     fresh Mac, you set it to Server mode there separately.
 *   - dataDir — path is unique per machine. The import flow lets you
 *     pick where the data should LIVE on the new Mac.
 *
 * What DOES travel: SQLite DB, all asset trees (assets/, processed/,
 * ai-gallery/, overlays/), AI provider keys, custom presets, default
 * tokens / separator, and the default export profile id. See
 * `main/serverBundle.js` PORTABLE_CONFIG_KEYS for the exact whitelist.
 */
export function MigrationPanel({ config, addToast }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { manifest, bundlePath } | null
  const [importing, setImporting] = useState(false);

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDate(ts) {
    if (!ts) return '—';
    try { return new Date(Number(ts)).toLocaleString(); } catch { return '—'; }
  }

  async function handleExport() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await window.api.servers.exportBundle();
      if (!res) {
        // user canceled the Save dialog — no toast, just bail
        return;
      }
      addToast?.(
        `Bundle written: ${res.bundlePath.split('/').pop()} · ${formatBytes(res.sizeBytes)}`,
        'success',
      );
    } catch (err) {
      addToast?.(`Export failed: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handlePickBundle() {
    if (busy) return;
    setBusy(true);
    try {
      const manifest = await window.api.servers.previewBundle();
      if (!manifest) return; // user canceled
      setPreview(manifest);
    } catch (err) {
      addToast?.(`Couldn't read bundle: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleImportConfirm() {
    if (!preview || importing) return;
    // Warn loudly — this REPLACES the active data folder.
    const ok = await confirm({
      title: 'Replace this Mac\'s data?',
      message:
        'Importing a bundle replaces everything in your current data folder ' +
        '(database, products, brands, images, AI gallery, overlays). ' +
        'The existing data will be moved aside to a timestamped backup ' +
        'folder next to it — you can recover from there if anything goes wrong, ' +
        'or delete it later to reclaim disk space.\n\n' +
        'The app will restart automatically after the import completes.',
      detail: `Bundle: ${preview.bundlePath.split('/').pop()}\n` +
              `Created: ${formatDate(preview.createdAt)} from app v${preview.appVersion}\n` +
              `Includes: ${(preview.includes ?? []).join(', ')}\n\n` +
              `Target data folder (on this Mac):\n${config.dataDir}`,
      confirmLabel: 'Replace and restart',
      danger: true,
    });
    if (!ok) return;

    setImporting(true);
    try {
      await window.api.servers.importBundle(preview.bundlePath, config.dataDir);
      addToast?.('Bundle imported. Restarting…', 'success');
      // Small grace period so the toast renders before the relaunch
      // pulls the rug out. applyImportedDataDir is a no-op when the
      // path didn't change, but we call it to atomically persist the
      // path (in case the import wrote to a different folder than the
      // live config — defensive) and trigger the relaunch.
      await window.api.servers.applyImportedDataDir(config.dataDir, true);
    } catch (err) {
      addToast?.(`Import failed: ${err.message}`, 'error');
      setImporting(false);
    }
  }

  return (
    <>
      <SettingRow
        label="Export bundle"
        hint="Writes a single .iskhbundle file containing the database, all images (assets / processed / ai-gallery / overlays), and the AI provider keys + presets. The bundle is portable — copy it to another Mac and use Import to take over there. Mode / network settings are NOT bundled (the new Mac keeps its own)."
      >
        <div className="setting-control-row">
          <Button variant="primary" onClick={handleExport} disabled={busy}>
            {busy ? 'Working…' : 'Export bundle…'}
          </Button>
          <span className="muted" style={{ fontSize: 12 }}>
            Pick a destination — Desktop, external drive, AirDrop staging folder, etc.
          </span>
        </div>
      </SettingRow>

      <SettingRow
        label="Import bundle"
        hint="Read a .iskhbundle written by another Mac. Replaces this Mac's data folder (a timestamped backup is kept first). Restarts the app on success."
      >
        <div className="setting-control-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="setting-control-row">
            <Button onClick={handlePickBundle} disabled={busy || importing}>
              {busy ? 'Reading…' : 'Pick bundle to import…'}
            </Button>
            {preview ? (
              <Button variant="ghost" onClick={() => setPreview(null)} disabled={importing}>
                Clear
              </Button>
            ) : null}
          </div>

          {preview ? (
            <div className="bundle-preview">
              <div className="bundle-preview__head">
                <strong>{preview.bundlePath.split('/').pop()}</strong>
                <span className="muted"> · {formatBytes(preview.bundleSizeBytes)}</span>
              </div>
              <dl className="bundle-preview__meta">
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(preview.createdAt)}</dd>
                </div>
                <div>
                  <dt>From version</dt>
                  <dd>v{preview.appVersion ?? '—'}</dd>
                </div>
                <div>
                  <dt>Format</dt>
                  <dd>v{preview.bundleFormatVersion ?? '—'}</dd>
                </div>
                <div>
                  <dt>Source folder</dt>
                  <dd className="muted">{preview.sourceDataDir ?? '—'}</dd>
                </div>
                <div>
                  <dt>Includes</dt>
                  <dd>{(preview.includes ?? []).join(', ') || '—'}</dd>
                </div>
              </dl>
              <div className="bundle-preview__target">
                <span className="muted">Will write into your current data folder:</span>
                <code>{config.dataDir}</code>
              </div>
              <Button
                variant="primary"
                onClick={handleImportConfirm}
                disabled={importing}
              >
                {importing ? 'Importing…' : 'Replace this Mac\'s data and restart'}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingRow>
    </>
  );
}
