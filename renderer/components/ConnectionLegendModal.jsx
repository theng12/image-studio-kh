/**
 * v0.22.11: connection-state legend + live troubleshooter.
 *
 * Why: the client-mode chip in the sidebar has a tiny coloured dot
 * — green / amber / red / grey — and the only hint about what each
 * means is a hover tooltip. Users (rightly) asked "what does the
 * red dot mean and what do I do about it?". This modal answers that
 * upfront with a per-state explanation, then shows the LIVE current
 * state (URL, last error, last successful ping, server version)
 * with a manual "Test connection now" button.
 *
 * Only renders meaningfully in client mode — server mode and
 * standalone mode have no remote server to be connected to, so the
 * modal explains that they don't apply.
 */
import { useState } from 'react';
import { Modal } from './ui.jsx';
import { useAppStore } from '../store/index.js';

const STATES = [
  {
    key: 'connected',
    label: 'Connected',
    color: '#10b981',
    body:
      'Your latest ping to the server succeeded. Reads and writes are flowing. '
      + 'Live updates from other users come in over the WebSocket as they happen.',
  },
  {
    key: 'connecting',
    label: 'Connecting',
    color: '#f59e0b',
    body:
      'We\'re actively reaching out to the server but haven\'t got a ping back '
      + 'yet. Normally lasts a few seconds; longer than ~10 seconds usually '
      + 'means the server is offline or the URL is wrong.',
  },
  {
    // v0.26.38: new state. The server responded to /api/ping but
    // with a 5xx — connection is fine, server's HTTP layer just
    // had a brief hiccup. The renderer shows amber instead of red
    // so users can tell this apart from a real disconnection.
    // Should self-clear on the next successful ping (within 30s)
    // or the next successful RPC call.
    key: 'degraded',
    label: 'Server hiccup',
    color: '#f59e0b',
    body:
      'The server is reachable but the last /api/ping returned a 5xx error. '
      + 'The connection itself is fine — something inside the server software '
      + 'briefly returned an error response. Usually clears itself in the next '
      + '30 seconds. If you see this state persist for minutes at a time, ask '
      + 'the server admin to check the crash.log on the server Mac '
      + '(Settings → About → Open logs folder) for what went wrong.',
  },
  {
    key: 'unknown',
    label: 'Checking',
    color: '#9ca3af',
    body:
      'First-run state, before the very first ping completes. Should flip to '
      + 'Connected or Disconnected within a couple of seconds of opening the app.',
  },
  {
    key: 'disconnected',
    label: 'Disconnected',
    color: '#ef4444',
    body:
      'The last ping or RPC call failed. Likely causes (in order of frequency): '
      + '(1) the server Mac is off / sleeping / not running the app, '
      + '(2) the Wi-Fi network between you and the server changed, '
      + '(3) the server URL changed (it includes the server\'s IP, which can '
      + 'shift on a DHCP network), '
      + '(4) your token was deleted from the server\'s user list, '
      + '(5) firewall on either Mac is blocking port 13180.',
  },
];

function relativeSince(ts) {
  if (!ts) return null;
  const diff = Date.now() - Number(ts);
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

export function ConnectionLegendModal({ open, onClose }) {
  const appMode = useAppStore((s) => s.appMode);
  const clientConnection = useAppStore((s) => s.clientConnection);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Re-fetch the connection state — main side polls /api/ping
      // on a timer; we just refresh our snapshot of it. There's no
      // explicit "ping now" IPC, but reading state pulls the most
      // recent push value the main process broadcast.
      const fresh = await window.api?.client?.connectionState?.();
      if (fresh) {
        useAppStore.setState({ clientConnection: fresh });
        setTestResult(fresh.status === 'connected'
          ? 'Server reachable.'
          : `Still ${fresh.status}: ${fresh.lastError || 'no further detail'}.`);
      } else {
        setTestResult('Connection state unavailable.');
      }
    } catch (err) {
      setTestResult(`Test failed: ${err.message}`);
    } finally {
      setTesting(false);
    }
  }

  const status = clientConnection?.status || 'unknown';

  return (
    <Modal open={open} onClose={onClose} title="Connection status" size="md">
      <div className="conn-legend">
        {appMode === 'client' ? (
          <>
            <section className="conn-legend__current">
              <h4>Current state</h4>
              <div className="conn-legend__state-row">
                <span
                  className="conn-legend__dot"
                  style={{ background: STATES.find((s) => s.key === status)?.color || '#9ca3af' }}
                  aria-hidden="true"
                />
                <strong>{STATES.find((s) => s.key === status)?.label || 'Unknown'}</strong>
                <button
                  type="button"
                  className="conn-legend__test"
                  onClick={handleTest}
                  disabled={testing}
                >
                  {testing ? 'Checking…' : 'Test connection now'}
                </button>
              </div>
              <dl className="conn-legend__detail">
                {clientConnection?.serverVersion ? (
                  <>
                    <dt>Server version</dt>
                    <dd>v{clientConnection.serverVersion}</dd>
                  </>
                ) : null}
                {clientConnection?.user?.name ? (
                  <>
                    <dt>You are</dt>
                    <dd>{clientConnection.user.name}{clientConnection.user.role ? ` (${clientConnection.user.role})` : ''}</dd>
                  </>
                ) : null}
                {clientConnection?.lastOkAt ? (
                  <>
                    <dt>Last successful ping</dt>
                    <dd>{relativeSince(clientConnection.lastOkAt)}</dd>
                  </>
                ) : null}
                {clientConnection?.lastError ? (
                  <>
                    <dt>Last error</dt>
                    <dd className="conn-legend__error">{clientConnection.lastError}</dd>
                  </>
                ) : null}
              </dl>
              {testResult ? (
                <p className="conn-legend__test-result muted">{testResult}</p>
              ) : null}
            </section>

            <section className="conn-legend__states">
              <h4>What each state means</h4>
              <ul>
                {STATES.map((s) => (
                  <li
                    key={s.key}
                    className={`conn-legend__state${status === s.key ? ' is-current' : ''}`}
                  >
                    <span
                      className="conn-legend__dot"
                      style={{ background: s.color }}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{s.label}</strong>
                      <p>{s.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="conn-legend__troubleshoot">
              <h4>If you're disconnected</h4>
              <ol>
                <li>Open <strong>Settings → Multi-Mac</strong> and re-paste the server URL + token to make sure they match what the server admin gave you.</li>
                <li>Ping-test from Terminal: <code>curl http://&lt;server-ip&gt;:13180/api/ping</code> should return JSON. If it hangs, the server isn't reachable from this Mac.</li>
                <li>Ask the server admin to check Settings → Multi-Mac → Users that your account still exists with the same token.</li>
                <li>If you're on a coffee-shop / hotel network, server-to-client connections are usually blocked. Use a hotspot or the same Wi-Fi as the server Mac.</li>
              </ol>
            </section>
          </>
        ) : appMode === 'server' ? (
          <p className="muted">
            This Mac is running in <strong>Server mode</strong>, so there's no
            remote server to connect to — this Mac IS the server. Other
            client Macs see their connection status to this Mac. To see who's
            currently connected, click the presence row in the sidebar.
          </p>
        ) : (
          <p className="muted">
            This Mac is running in <strong>Standalone mode</strong> — no server,
            no clients. The connection status indicator only appears in client
            mode. To enable multi-Mac access, switch modes in
            Settings → Multi-Mac.
          </p>
        )}
      </div>
    </Modal>
  );
}
