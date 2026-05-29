/**
 * v0.14.3: client-mode runtime.
 *
 * When the app boots with `config.mode === 'client'` we:
 *   - SKIP local DB init (no `database.sqlite` on this Mac)
 *   - SKIP the local `app-image://` protocol that resolves to disk; replace
 *     it with a passthrough that fetches `/assets/<rel>` from the server
 *     with the user's bearer token attached.
 *   - Wire each known RPC channel up to `ipcMain.handle` so the renderer
 *     can call `window.api.products.list(...)` exactly like it always has
 *     — but the call hops to the server over HTTP and back.
 *
 * The set of "known RPC channels" is hand-rolled here, not auto-discovered
 * from the server, because:
 *   1. The renderer wires `window.api` from `preload.js`, which is a
 *      compile-time surface. If we tried to lazily install handlers as
 *      the renderer asked for them we'd lose the "throws fast when the
 *      channel doesn't exist" property — `ipcMain.handle` throws
 *      synchronously on a duplicate registration and we'd rather have
 *      the channel list be explicit and reviewable in one place.
 *   2. The server has a strict allow-list anyway (only channels passed
 *      to `expose()` are in the registry). The client list mirroring it
 *      is intentional belt-and-braces.
 *
 * To add a channel to the client surface:
 *   - Server side: call `expose('domain:action', handler)` in main/ipc.js
 *   - Client side: add `'domain:action'` to PROXIED_CHANNELS below
 *
 * Channels not in PROXIED_CHANNELS still register as `ipcMain.handle`
 * stubs that throw a clear "not available in client mode" error, so the
 * renderer surfaces an honest toast instead of hanging on an
 * unregistered channel.
 */

const { ipcMain, app, BrowserWindow } = require('electron');
// v0.15.1: WebSocket client (same `ws` lib as the server). Used in
// client mode to subscribe to live update events. Loaded lazily so
// standalone / server mode doesn't pay the import cost.
let WebSocket = null;

/* ─── HTTP RPC ─────────────────────────────────────────────────── */

let _config = null;
let _connectionState = {
  // v0.26.38: added 'degraded' — used when the server RESPONDED but
  // with a 5xx on /api/ping. That means the network is fine and the
  // HTTP layer is up; something inside the server hiccuped. Distinct
  // from 'disconnected' (truly unreachable) so the user can tell the
  // two failure modes apart at a glance.
  status: 'unknown',     // 'unknown' | 'connecting' | 'connected' | 'degraded' | 'disconnected'
  lastOkAt: 0,
  lastError: null,
  user: null,
  serverVersion: null,
};
let _pollTimer = null;
let _pollBackoffMs = 2000;
// v0.26.38: debounce counter for the ping loop. We only flip the
// chip red after N consecutive failures — a single transient ping
// failure (slow GC, momentary packet loss, server's HTTP layer
// pausing for a sec) shouldn't make the connection chip blink red.
// 2 is enough to absorb single-tick noise without making real
// disconnections invisible. Resets to 0 on any 2xx ping or any
// successful RPC call.
let _consecutivePingFailures = 0;
const PING_FAILURE_THRESHOLD = 2;
// v0.26.38: bumped from 5s to 10s. 5s was too aggressive for slow
// Tailscale hops or a server doing a heavy sharp re-encode while a
// ping comes in — caused legitimate-but-slow round-trips to time
// out and flip the chip red. 10s still bounds the user's wait but
// gives realistic networks the headroom they need.
const PING_TIMEOUT_MS = 10_000;

function getConnectionState() {
  return { ..._connectionState };
}

function setConnectionState(patch) {
  _connectionState = { ..._connectionState, ...patch };
  // Push to renderer if a window is open.
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('client:connectionState', _connectionState);
    }
  } catch (_) { /* main window not up yet */ }
}

function baseUrl() {
  if (!_config?.clientServerUrl) return null;
  return _config.clientServerUrl.replace(/\/+$/, '');
}

function authHeader() {
  if (!_config?.clientToken) return null;
  return `Bearer ${_config.clientToken}`;
}

/**
 * v0.15.0: walk a renderer-supplied IPC arg and base64-encode any
 * binary payloads (ArrayBuffer / TypedArray / Buffer) we find inside
 * objects or arrays. JSON can't carry binary, so this is how
 * `images:importFromBytes` / `watermarks:uploadFromBytes` get across
 * the wire. The server's RPC dispatcher mirrors this with
 * `deserializeForServer()` and turns the marker back into a Node
 * Buffer the handler can hand straight to Sharp.
 *
 * Format: `{ __bin: true, b64: '<base64>' }`. Chosen because it's
 * trivially detectable (no plain object should have `__bin: true` as
 * its own field) and JSON-clean. ~33% overhead is fine for product
 * imagery (1–5 MB → 1.3–6.6 MB).
 */
/**
 * Inverse of serializeForServer + the server's serializeResultForWire.
 * The handler may return `{ bytes: <Buffer> }`; the server wraps that
 * as `{ bytes: { __bin, b64 } }`; we unwrap back to a Node Buffer so
 * the renderer (via Electron's structured-clone IPC) sees binary.
 */
function deserializeFromServer(val) {
  if (val == null) return val;
  if (Array.isArray(val)) return val.map(deserializeFromServer);
  if (typeof val === 'object') {
    if (val.__bin === true && typeof val.b64 === 'string') {
      return Buffer.from(val.b64, 'base64');
    }
    const out = {};
    for (const k of Object.keys(val)) out[k] = deserializeFromServer(val[k]);
    return out;
  }
  return val;
}

function serializeForServer(arg) {
  if (arg == null) return arg;
  if (arg instanceof ArrayBuffer) {
    return { __bin: true, b64: Buffer.from(arg).toString('base64') };
  }
  if (ArrayBuffer.isView(arg)) {
    return { __bin: true, b64: Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength).toString('base64') };
  }
  if (Buffer.isBuffer(arg)) {
    return { __bin: true, b64: arg.toString('base64') };
  }
  if (Array.isArray(arg)) return arg.map(serializeForServer);
  if (typeof arg === 'object') {
    const out = {};
    for (const k of Object.keys(arg)) out[k] = serializeForServer(arg[k]);
    return out;
  }
  return arg;
}

/**
 * Call a channel on the server. Returns whatever the handler returned
 * (`result` field of the JSON envelope). Throws if the server returns
 * an error status or `{ error }` body.
 *
 * Single-arg convention matches the server's expose() contract. The
 * preload calls `(method)(arg)` and we forward the same arg shape.
 */
/* ─── v0.26.33: RPC activity telemetry ─────────────────────────────
 *
 * Why this exists: on slow LAN / Tailscale links the initial slice
 * fetch (companies + brands + categories + products + dashboard +
 * exports + AI prompts + AI tasks) can take 5–15 seconds. Without a
 * visible "this is alive" signal, users assume the app is broken and
 * force-quit. The SyncOverlay reads from these events so the renderer
 * can show:
 *   - which RPC channel is currently in flight ("Loading products…")
 *   - bytes downloaded so far ("12.4 MB")
 *   - how many calls have completed
 *
 * Two surfaces consume this:
 *   1. Boot SyncOverlay — full-window during the initial bootstrap.
 *   2. Sidebar footer chip — persistent "↓ 2.3 MB · 47 calls" so the
 *      user has a heartbeat in steady-state too.
 *
 * Counters never decay; they're per-launch lifetime totals. The
 * renderer interprets "no activity for N ms" as quiet.
 */
const _syncStats = {
  totalBytesIn: 0,        // response bytes summed (post-headers, body only)
  totalBytesOut: 0,       // request bytes summed
  callCount: 0,           // total RPC calls completed (ok + failed)
  okCount: 0,
  errorCount: 0,
  lastActivityAt: 0,
  lastChannel: null,
  lastDurationMs: 0,
  startedAt: Date.now(),
  inFlight: 0,
};

function getSyncStats() { return { ..._syncStats }; }

function broadcastRpcActivity(payload) {
  // We don't import ../events here because that module is server-side
  // (talks to ws clients we don't have). Use direct BrowserWindow
  // dispatch on the local renderer instead — same pattern
  // dispatchIncoming() uses.
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('client:rpcActivity', payload);
    }
  } catch (_) {}
}

async function rpc(channel, args) {
  const url = baseUrl();
  const auth = authHeader();
  if (!url) throw new Error('Server URL not set (Settings → Multi-Mac → Client mode)');
  if (!auth) throw new Error('Server token not set (Settings → Multi-Mac → Client mode)');

  const startedAt = Date.now();
  const requestBody = JSON.stringify({ channel, args: serializeForServer(args) });
  const requestBytes = Buffer.byteLength(requestBody, 'utf8');
  _syncStats.inFlight += 1;
  _syncStats.lastChannel = channel;
  // Fire a "started" event so the overlay can show the current
  // channel immediately, not just after the response lands.
  broadcastRpcActivity({
    phase: 'start', channel, startedAt, requestBytes,
    stats: getSyncStats(),
  });

  let res;
  let responseBytes = 0;
  let body = null;
  try {
    try {
      res = await fetch(`${url}/api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: requestBody,
      });
    } catch (err) {
      // Network-level failure → flag disconnected so the sidebar chip can
      // turn red. v0.26.34: route through analyzeFetchError so the
      // toast shows the actual reason ("Server refused the connection
      // on port 13180") instead of the opaque "fetch failed".
      const { analyzeFetchError } = require('../util/fetchErrors');
      const analyzed = analyzeFetchError(err, url);
      setConnectionState({ status: 'disconnected', lastError: analyzed.message });
      _syncStats.errorCount += 1;
      throw new Error(analyzed.message);
    }

    // Read response body as text first so we know its byte count, then
    // parse JSON. The double-pass costs ~1 ms per call vs. .json()
    // directly, but it gives us an accurate "bytes downloaded" stat
    // even when the server omits Content-Length (chunked transfer).
    let responseText = '';
    try {
      responseText = await res.text();
      responseBytes = Buffer.byteLength(responseText, 'utf8');
      if (responseText) body = JSON.parse(responseText);
    } catch (_) { /* leave body null; downstream handles */ }

    if (res.status === 401) {
      setConnectionState({ status: 'disconnected', lastError: 'Token rejected' });
      _syncStats.errorCount += 1;
      throw new Error('Token rejected by server. Ask the admin to regenerate.');
    }
    if (!res.ok) {
      const msg = body?.error || `Server returned ${res.status}`;
      _syncStats.errorCount += 1;
      // Don't flip connection state on per-call errors (e.g. "Product not
      // found" is a 500 — the server itself is fine). Only network/auth
      // failures count as disconnection.
      throw new Error(msg);
    }
    // Successful call → also a successful health check. Bump lastOkAt
    // so the sidebar chip stays green. v0.26.38: also reset the ping
    // debounce counter and clear 'degraded' state — a successful RPC
    // is strictly a stronger signal than a successful /api/ping (it
    // exercises more of the server's stack).
    _consecutivePingFailures = 0;
    if (_connectionState.status !== 'connected') {
      setConnectionState({ status: 'connected', lastOkAt: Date.now(), lastError: null });
    } else {
      setConnectionState({ lastOkAt: Date.now() });
    }
    _syncStats.okCount += 1;
    return deserializeFromServer(body?.result);
  } finally {
    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;
    _syncStats.inFlight = Math.max(0, _syncStats.inFlight - 1);
    _syncStats.callCount += 1;
    _syncStats.totalBytesIn += responseBytes;
    _syncStats.totalBytesOut += requestBytes;
    _syncStats.lastActivityAt = endedAt;
    _syncStats.lastDurationMs = durationMs;
    broadcastRpcActivity({
      phase: 'end', channel, startedAt, endedAt, durationMs,
      requestBytes, responseBytes,
      ok: !!res?.ok,
      stats: getSyncStats(),
    });
  }
}

/* ─── Live updates (WebSocket subscription) ────────────────────── */

let _ws = null;
let _wsReconnectTimer = null;
let _wsBackoffMs = 1000;

/**
 * Forward an incoming WS event frame into the renderer over IPC.
 * The renderer already has subscribers (`window.api.ai.onTaskUpdate`,
 * etc.); we re-emit on the SAME channels the standalone path uses so
 * the renderer doesn't need to know whether it's running locally or
 * over the wire.
 *
 * `client:catalogChanged` is the one new channel — used by clients to
 * refetch when another Mac edits the catalog. The store wires this up
 * to the existing `refreshProducts / refreshBrands / etc.` actions.
 */
function dispatchIncoming({ channel, payload }) {
  if (!channel) return;
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch (_) {}
}

function wsUrl() {
  const base = baseUrl();
  if (!base || !_config?.clientToken) return null;
  // http(s) → ws(s). URL parsing handles the protocol swap cleanly.
  try {
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/api/events';
    u.searchParams.set('token', _config.clientToken);
    return u.toString();
  } catch (_) {
    return null;
  }
}

function startWsClient() {
  if (!WebSocket) {
    try { WebSocket = require('ws'); }
    catch (err) {
      process.stderr.write(`[client ws] require failed: ${err.message}\n`);
      return;
    }
  }
  const url = wsUrl();
  if (!url) {
    // Nothing to connect to yet — try again later (URL may be set
    // after the user pastes credentials in Settings).
    _wsReconnectTimer = setTimeout(startWsClient, 5000);
    return;
  }

  try {
    _ws = new WebSocket(url);
  } catch (err) {
    process.stderr.write(`[client ws] construct failed: ${err.message}\n`);
    scheduleReconnect();
    return;
  }

  _ws.on('open', () => {
    process.stdout.write('[client ws] connected\n');
    _wsBackoffMs = 1000;
  });

  _ws.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString('utf8'));
      dispatchIncoming(frame);
    } catch (err) {
      process.stderr.write(`[client ws] parse error: ${err.message}\n`);
    }
  });

  _ws.on('close', () => {
    process.stdout.write('[client ws] disconnected\n');
    _ws = null;
    scheduleReconnect();
  });

  _ws.on('error', (err) => {
    process.stderr.write(`[client ws] error: ${err.message}\n`);
    // The 'close' handler will run after this and schedule reconnect.
  });
}

function scheduleReconnect() {
  if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
  _wsReconnectTimer = setTimeout(startWsClient, _wsBackoffMs);
  _wsBackoffMs = Math.min(_wsBackoffMs * 2, 30_000);
}

/* ─── Connection polling ───────────────────────────────────────── */

/**
 * Background ping. Hits `/api/ping` (public) so it works even if the
 * token is stale — the renderer's auth-failure path covers the token
 * case separately. Backs off to 30s on success and rapidly retries
 * (2s → 4s → 8s → 16s → 30s cap) on failure.
 *
 * Stays running for the entire client-mode session. There's no
 * stopPolling() because client mode IS the entire session — `setMode`
 * relaunches the app to flip back to standalone.
 */
/**
 * v0.22.3: fetch /api/whoami once and stash the result in
 * `_connectionState.user`. The renderer reads this through the
 * `client:connectionState` IPC to figure out which user it is — used
 * by v0.22.2's self-vs-remote classification for catalog:changed
 * events. Without this, the renderer would treat its OWN echoed edits
 * as "from another user" and queue them behind the Refresh banner
 * instead of auto-applying.
 *
 * One-shot: we only fetch when user is null. If the server is
 * restarted with a different user table, the token would 401 first
 * and force a reconfigure anyway, so we don't need to refresh user
 * info on every reconnect.
 */
async function ensureWhoami() {
  if (_connectionState.user?.id) return; // already have it
  const url = baseUrl();
  const auth = authHeader();
  if (!url || !auth) return; // nothing to query with
  try {
    const res = await fetch(`${url}/api/whoami`, {
      headers: { Authorization: auth },
      // v0.26.40: bumped 5s → 8s to match the other client-mode
      // fetch ceilings (testConnection, diagnoseServer). 5s was too
      // aggressive for slow Tailscale hops during the very-first
      // boot — see the rationale on PING_TIMEOUT_MS above.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return; // 401 path handled by RPC error flow
    const body = await res.json().catch(() => null);
    if (body?.user?.id) {
      setConnectionState({ user: body.user });
    }
  } catch (_) {
    /* network blip — try again on next ping */
  }
}

function startPolling() {
  async function tick() {
    const url = baseUrl();
    if (!url) {
      // No URL configured yet — just keep waiting; user is probably
      // about to fill it in.
      _pollTimer = setTimeout(tick, 5000);
      return;
    }

    // v0.26.38: three-way ping classification, replacing the old
    // binary throw-on-anything-not-2xx logic. The previous code
    // treated a 500 response identically to a fetch-failed network
    // error, which made the chip flash red on transient server
    // hiccups even though the network was fine — see the bug report
    // we tracked down before this build.
    //
    // The three outcomes:
    //   - 2xx                → connected (green)
    //   - 5xx response       → degraded (amber); server is REACHABLE
    //                          but its HTTP layer returned an error.
    //                          Log it so headless servers leave a
    //                          breadcrumb in the crash.log.
    //   - 4xx (except 401)   → degraded; same as 5xx — the server
    //                          responded, so the connection is fine.
    //                          (401 is handled by /rpc separately —
    //                          /api/ping doesn't require auth.)
    //   - fetch threw /
    //     timeout / 401 ping → counts toward `_consecutivePingFailures`;
    //                          flips to disconnected only after
    //                          PING_FAILURE_THRESHOLD in a row.
    //
    // The debounce on consecutive failures is the meat of this fix.
    // A single noisy poll cycle no longer triggers a red glow — you
    // need 2 in a row, which is much rarer than 1 in isolation.
    let res = null;
    let netError = null;
    try {
      res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    } catch (err) {
      netError = err;
    }

    if (res && res.ok) {
      // Healthy ping.
      const body = await res.json().catch(() => ({}));
      _consecutivePingFailures = 0;
      if (_connectionState.status !== 'connected') {
        setConnectionState({
          status: 'connected',
          lastOkAt: Date.now(),
          lastError: null,
          serverVersion: body?.version ?? null,
        });
      } else {
        setConnectionState({ lastOkAt: Date.now(), serverVersion: body?.version ?? null });
      }
      ensureWhoami();
      _pollBackoffMs = 30_000;
    } else if (res && !res.ok) {
      // Server replied with a non-2xx — connection is fine, server
      // had a hiccup. Don't flip to disconnected; flag as degraded
      // and leave a breadcrumb in stderr (mirrors to crash.log on
      // the server admin's `tail` workflow, useful for the headless
      // mac-mini case where they don't see UI errors).
      const detail = `Status ${res.status}`;
      process.stderr.write(`[client ping] server responded with ${detail} on /api/ping at ${new Date().toISOString()}\n`);
      // Reset the network-failure debounce — this ISN'T a network
      // failure. The degraded state replaces it cleanly.
      _consecutivePingFailures = 0;
      setConnectionState({
        status: 'degraded',
        lastError: `Server returned ${detail} on /api/ping (the connection is up — something inside the server hiccuped briefly)`,
      });
      _pollBackoffMs = 30_000;
    } else {
      // Genuine network failure (fetch threw, timed out, etc).
      // Debounce — only flip to disconnected after two in a row, so
      // single-tick noise doesn't make the chip blink red.
      _consecutivePingFailures += 1;
      const isFinal = _consecutivePingFailures >= PING_FAILURE_THRESHOLD;
      if (isFinal) {
        setConnectionState({ status: 'disconnected', lastError: netError?.message || 'Network error' });
      } else {
        // Single failure — don't change the user-visible status yet.
        // Log quietly so we can investigate later if it's a pattern.
        process.stderr.write(
          `[client ping] transient failure (${_consecutivePingFailures}/${PING_FAILURE_THRESHOLD}): ${netError?.message || 'unknown'}\n`,
        );
      }
      _pollBackoffMs = Math.min(_pollBackoffMs * 2, 30_000);
    }
    _pollTimer = setTimeout(tick, _pollBackoffMs);
  }
  // First tick fires soon after boot so the badge transitions out of
  // 'unknown' quickly.
  _pollTimer = setTimeout(tick, 500);
}

/* ─── Channel proxies ──────────────────────────────────────────── */

/**
 * The list of channels the renderer is allowed to invoke in client
 * mode. Each one is forwarded to the server's `/api/rpc` endpoint with
 * the same argument shape as the local IPC would have received.
 *
 * Keep this in sync with the `expose()` calls in main/ipc.js. v0.14.3
 * ships just the Library read path; v0.14.4 grows the list.
 */
const PROXIED_CHANNELS = [
  // v0.14.3 — first wave: Library + side panel + company switcher.
  // (v0.26.36: `app:getVersion` and `app:getPlatform` USED to be
  // here, RPC'd to the server. That was wrong — a client always
  // knows its OWN version (it's baked into the bundle) and its OWN
  // platform (it's process.platform). Proxying them caused the
  // sidebar footer to show `v0.0.0` whenever bootstrap ran before
  // the server was reachable — boot order race that's especially
  // visible on a freshly-configured client. They're now registered
  // as local handlers below, identical to standalone/server mode.)
  'companies:list',
  'companies:get',
  'companies:getActiveId',
  'companies:setActive',
  'products:list',
  'products:get',
  'images:listByProduct',
  'brands:list',
  'brands:get',
  'categories:list',
  // v0.14.4 — second wave: dashboard, exports list, AI Studio reads,
  // Overlay template reads.
  'dashboard:stats',
  'dashboard:recentBrands',
  'dashboard:recentProducts',
  'exports:listProfiles',
  'exports:getProfile',
  'exports:filenamePreview',
  'exports:listRuns',
  'ai:listModels',
  'ai:estimateCost',
  'ai:listPrompts',
  'ai:listTasks',
  'ai:listGallery',
  'ai:listBulkGallery',
  'templates:list',
  'templates:get',
  'templates:listRuns',
  // v0.27.0: eyedropper — server holds the image bytes, so proxy it.
  'templates:sampleBgColor',
  // v0.15.0 — write endpoints. Catalog CRUD, image reorder/set-main/
  // remove, AI prompt CRUD, AI task lifecycle, gallery favorite/remove/
  // promote, export profile CRUD, template CRUD + renderPreview,
  // workspace processing, bytes-uploads (images / watermarks).
  'companies:create', 'companies:update', 'companies:remove',
  'products:create',  'products:update',  'products:remove', 'products:bulkUpsert',
  'products:duplicate',
  'products:bulkUpdate',
  'products:bulkRemove',
  // v0.18.2: global search palette.
  'search:global',
  // v0.22.6: audit log feed (history modal in the side panel).
  'audit:listForEntity', 'audit:countForEntity',
  // v0.26.31: global feed for the History sidebar page.
  'audit:listRecent', 'audit:countRecent',
  'brands:create',    'brands:update',    'brands:remove',
  'categories:create','categories:update','categories:remove',
  'ai:createPrompt','ai:updatePrompt','ai:removePrompt',
  'ai:queueTask','ai:repairTask','ai:queueFreshTask','ai:cancelTask','ai:removeTask',
  'ai:favoriteGallery','ai:removeGallery','ai:promoteGalleryToProduct',
  'exports:createProfile','exports:updateProfile','exports:removeProfile','exports:duplicateProfile',
  'templates:create','templates:update','templates:remove','templates:duplicate','templates:renderPreview',
  // v0.26.15: apply-template handlers (single + bulk + by-filter).
  'templates:applyToProduct','templates:applyBulk','templates:applyByFilter',
  'images:setMainImage','images:reorderImages','images:removeFromProduct','images:flipSource',
  'images:importFromBytes','watermarks:uploadFromBytes',
  // v0.28.0: near-duplicate scan/merge/revert. All run server-side (the
  // image files + DB live there), so clients just proxy.
  'images:findDuplicates','images:mergeDuplicates','images:autoMergeDuplicates','images:listMergeOps',
  'images:revertMerge','images:purgeMerge','images:quarantineInfo','images:purgeAllMerges',
  // v0.29.0: per-image reframe — server holds the image bytes, so proxy.
  'images:reframePreview','images:reframeImage','images:sampleImageBgColor',
  // v0.16.0: bytes-based brand icon upload (client reads the icon
  // file locally, sends bytes; server runs normal importBrandIcon).
  'brands:uploadIconFromBytes',
  // v0.16.1: bytes-based bulk AI source upload + bytes-back-to-client
  // bulk export. The standalone-named `ai:queueBulkBatch` and
  // `ai:exportBulkImage` channels are overridden locally below to
  // bridge to these via bytes.
  'ai:queueBulkBatchFromBytes',
  'ai:queueBulkForProducts',
  'ai:exportBulkImageBytes',
  // v0.16.2: bytes-back-to-client export. Server zips its temp
  // output, client writes each file under its own outputRoot.
  'exports:runForClient',
  'workspace:processImage','workspace:saveSettings',
  // v0.15.3 — attribution + presence.
  'users:listForAttribution',
  'users:presence',
];

/**
 * Channels we deliberately stub out in client mode because they're
 * either irrelevant (settings:getAll → use the client's local config)
 * or destined to be locally handled (app:openExternal — the client
 * has its own shell).
 *
 * The "throw clearly" pattern is intentional: if a future feature
 * tries to call one of these we want it to fail loud in dev, not
 * mysteriously hang or return undefined.
 */
const LOCAL_STUBS = new Set([
  'app:openExternal',
  'app:openDataFolder',
  'app:openLogsFolder',
  'app:relaunch',
  'app:getVersionInfo',
  'settings:getAll',
  'settings:setOne',
  'settings:setMany',
  'settings:setMode',
  'client:testConnection',
]);

/**
 * Channels NOT yet portable to client mode. We register an
 * ipcMain.handle stub so the renderer gets a useful toast instead of
 * hanging on an unregistered channel. v0.15.0 migrates these.
 */
const NOT_YET_PORTABLE = [
  // (v0.16.2 moved exports:run to a local bridge — bytes flow back
  // from the server's temp folder and we write them under the
  // client's chosen outputRoot.)
  // (v0.16.1 moved ai:queueBulkBatch + ai:exportBulkImage to local
  // bridges below — no longer stubbed.)
  // (v0.16.2 moved exports:run to a local bridge — see below.)
  // Provider keys live in the client's local config (per-Mac), so
  // these reads must stay local.
  'ai:testKie','ai:testFal','ai:getCredits',
  // Users / server controls — admin runs these on the server's own
  // Settings page, not on a client.
  'users:list','users:create','users:update','users:remove','users:regenerateToken','users:ensureOwner',
  'server:status','server:addresses','server:start','server:stop',
  // Settings — data folder + per-Mac counters live locally.
  'settings:pickAndSetDataFolder','settings:changeDataFolder',
  'settings:testRemoveBg','settings:bumpRemoveBgUsage',
  // v0.26.51: data-folder trash + server-bundle migration. These all
  // operate on a LOCAL data folder, which a client doesn't have (its
  // data lives on the server). The Migration UI in Settings is
  // already gated to non-client modes, and the data-folder-change
  // flow is stubbed above — so these are unreachable in client mode.
  // Stubbed anyway so a future code path that reaches them fails with
  // a clear message instead of "No handler registered".
  'settings:trashFolder',
  'servers:exportBundle','servers:importBundle','servers:previewBundle','servers:applyImportedDataDir',
];

/**
 * Install all the ipcMain handlers a client-mode renderer needs.
 * Returns the connection-state getter so the caller (main/index.js)
 * can wire `client:connectionState` IPC.
 */
function registerClientProxies(loadConfigFn) {
  _config = loadConfigFn();

  // Re-read config on each `settings:setMany` call so a token swap
  // takes effect without a relaunch.
  function refreshConfig() {
    try { _config = loadConfigFn(); } catch (_) { /* ignore */ }
  }

  /* RPC-proxied channels — forward args verbatim to the server. */
  for (const channel of PROXIED_CHANNELS) {
    ipcMain.handle(channel, (_e, arg) => rpc(channel, arg));
  }

  /* Locally-handled stubs (operations that don't make sense to RPC). */

  // v0.26.36: keep `app:getVersion` + `app:getPlatform` LOCAL even
  // in client mode. The client always knows its own version (it's
  // baked into the bundle) and its own platform (process.platform).
  // Pre-v0.26.36 these were proxied through RPC to the server, which
  // (a) was wasteful (one round-trip per boot for a constant), and
  // (b) caused the sidebar footer to show "v0.0.0" whenever the
  // server was unreachable during bootstrap — a freshly-configured
  // client where the user hadn't entered the right URL yet would
  // get stuck on v0.0.0 forever until they fixed connection AND
  // relaunched. Trivial to make local; the server's version is
  // surfaced separately via `serverVersion` in the connection state.
  ipcMain.handle('app:getVersion',  () => app.getVersion());
  ipcMain.handle('app:getPlatform', () => process.platform);

  // v0.26.51: model-cache panel handlers. These inspect / clear THIS
  // Mac's Electron HTTP cache (where the ~80 MB @imgly model lives),
  // so they're per-Mac local operations — never proxied to the
  // server. Pre-v0.26.51 they were only registered in standalone /
  // server mode (main/ipc/app.js), so a client opening Settings got
  // "No handler registered for 'app:getCacheInfo'". Same shared
  // helper both modes use.
  {
    const { readCacheInfo, clearAppCache } = require('../util/appCache');
    ipcMain.handle('app:getCacheInfo', () => readCacheInfo());
    ipcMain.handle('app:clearCache', () => clearAppCache());
  }

  // v0.26.51: crash-log tail reader. The About tab's "Recent crash
  // log" panel calls this, and the About tab is visible in ALL modes
  // — so a client opening it hit "No handler registered for
  // 'app:readCrashLog'". The crash.log on the CLIENT's disk is the
  // relevant one (its own lifecycle events), so this stays local.
  ipcMain.handle('app:readCrashLog', async (_e, { lines = 100 } = {}) => {
    const fsp = require('node:fs/promises');
    const path = require('node:path');
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    try {
      const content = await fsp.readFile(logPath, 'utf8');
      const all = content.split('\n');
      const tail = all.slice(Math.max(0, all.length - Math.min(lines, 200)));
      return { content: tail.join('\n'), path: logPath, lines: tail.length };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { content: '(no crash.log yet — nothing has been logged)', path: logPath, lines: 0 };
      }
      throw err;
    }
  });

  ipcMain.handle('app:getVersionInfo', () => ({
    app: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    mode: 'client',
    server: baseUrl(),
  }));

  ipcMain.handle('app:openExternal', async (_e, target) => {
    const { shell } = require('electron');
    if (typeof target !== 'string') throw new Error('Disallowed URL scheme');
    let parsed;
    try { parsed = new URL(target); } catch { throw new Error('Disallowed URL scheme'); }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Disallowed URL scheme');
    await shell.openExternal(target);
    return true;
  });

  ipcMain.handle('app:openDataFolder', async () => {
    // In client mode, "data folder" doesn't really exist. Open the
    // userData folder so the user can grab logs etc.
    const { shell } = require('electron');
    await shell.openPath(app.getPath('userData'));
    return true;
  });

  ipcMain.handle('app:openLogsFolder', async () => {
    const { shell } = require('electron');
    await shell.openPath(app.getPath('userData'));
    return true;
  });

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('settings:getAll', () => {
    // The renderer needs at minimum: mode, the active company id (so
    // bootstrap doesn't hang waiting on getActiveId), and the small
    // bits the settings UI reads. Return a curated subset based on
    // the client's local config so iCloud / removebg / theme prefs are
    // per-Mac (which is the right behavior — settings shouldn't sync).
    const cfg = _config || loadConfigFn();
    return {
      ...cfg,
      // No "is iCloud" badge on clients — the asset folder lives on
      // the server.
      dataDirIsCloud: false,
    };
  });

  ipcMain.handle('settings:setOne', (_e, { key, value }) => {
    const { updateConfig } = require('../config');
    const next = updateConfig({ [key]: value });
    refreshConfig();
    return next;
  });
  ipcMain.handle('settings:setMany', (_e, patch) => {
    const { updateConfig } = require('../config');
    const next = updateConfig(patch ?? {});
    refreshConfig();
    return next;
  });
  ipcMain.handle('settings:setMode', async (_e, nextMode) => {
    if (!['standalone', 'server', 'client'].includes(nextMode)) {
      throw new Error(`Invalid mode: ${nextMode}`);
    }
    const { updateConfig } = require('../config');
    updateConfig({ mode: nextMode });
    setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
    return { ok: true, mode: nextMode };
  });

  ipcMain.handle('client:testConnection', async (_e, { url, token }) => {
    // v0.26.34: shared error analyser — see main/util/fetchErrors.js
    // for the full mapping table. Replaces the old `${err.message}`
    // pass-through that surfaced an opaque "fetch failed".
    const { validateServerUrl, analyzeFetchError } = require('../util/fetchErrors');
    const urlCheck = validateServerUrl(url);
    if (!urlCheck.ok) throw new Error(urlCheck.error);
    if (!token || !String(token).trim()) {
      throw new Error('User token is empty. Ask the server admin to give you the long random string from their Settings → Multi-Mac → Users page.');
    }
    const base = url.replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const analyzed = analyzeFetchError(err, base);
      throw new Error(analyzed.message);
    }
    if (res.status === 401) throw new Error('Token rejected by server. Ask the admin to regenerate it (their Settings → Multi-Mac → Users → ↻ button), then paste the new one here.');
    if (!res.ok) throw new Error(`Server returned ${res.status}. The address is reachable but isn't speaking the Image Studio KH protocol — is this URL pointing at a different app?`);
    const data = await res.json();
    return { ok: true, user: data.user, registeredChannels: data.registeredChannels };
  });

  /* v0.26.34: step-by-step network diagnostic. See ipc/settings.js
     for the standalone-mode twin handler. */
  ipcMain.handle('client:diagnoseServer', async (_e, { url, token } = {}) => {
    const { diagnoseServer } = require('../util/fetchErrors');
    return diagnoseServer({ url, token });
  });

  /* Connection-state IPC for the renderer's sidebar badge. */
  ipcMain.handle('client:connectionState', () => getConnectionState());

  /* v0.26.33: RPC activity stats — exposed as a one-shot snapshot for
     the sidebar chip + SyncOverlay seed. Continuous updates flow via
     the `client:rpcActivity` push channel (see broadcastRpcActivity). */
  ipcMain.handle('client:syncStats', () => getSyncStats());

  /* ─── v0.16.0: client-mode local handlers ──────────────────────
   * These channels run on the client's own Mac (the OS dialog is its
   * dialog, the disk scan is its disk). They don't talk to the server
   * directly — but `images:importForProduct` and friends DO end up
   * sending bytes to the server via the RPC layer at the end.
   * That keeps the renderer API identical: callers don't branch on
   * mode.
   */
  registerClientFileHandlers();
  registerClientImageImportBridges();

  /* Stubs for the still-not-portable channels. Throw a clear,
   * actionable error so the user understands why something didn't
   * work.
   */
  for (const channel of NOT_YET_PORTABLE) {
    ipcMain.handle(channel, () => {
      throw new Error(`"${channel}" is not yet available in client mode. Switch this Mac to standalone in Settings, or wait for the next release.`);
    });
  }

  startPolling();
  // v0.15.1: open the live-update WebSocket. Failures are non-fatal —
  // the HTTP ping loop is the primary connection-state signal; the
  // WS is best-effort on top.
  startWsClient();
  return { getConnectionState };
}

/* ─── v0.16.0: file handlers that run locally on the client Mac ─── */

function registerClientFileHandlers() {
  const { dialog } = require('electron');
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  // imageManager pulls in db/index.js at load time, but the parts we
  // use here (scanImagesRecursive, slugify, groupAndSortMatches) don't
  // call getDataDir. Safe in client mode.
  const imageManager = require('../imageManager');

  ipcMain.handle('files:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('files:pickImageFile', async (_e, { multiple = false } = {}) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return multiple ? res.filePaths : res.filePaths[0];
  });

  ipcMain.handle('files:pickWorkbook', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv', 'tsv'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('files:parseWorkbook', (_e, filePath) => {
    // Spreadsheet parsing is pure (just reads the file with xlsx), so
    // it works the same on client or server. The file path is on the
    // client's disk — exactly where we want it for a client-mode flow
    // that bulkUpserts to the server right after parsing.
    const fileHandler = require('../fileHandler');
    return fileHandler.readWorkbook(filePath);
  });

  ipcMain.handle('files:readImageThumb', async (_e, absPath) => {
    if (!absPath || typeof absPath !== 'string') throw new Error('absPath required');
    if (!fs.existsSync(absPath)) throw new Error('File not found');
    const sharp = require('sharp');
    const buf = await sharp(absPath)
      .rotate()
      .resize({ width: 160, height: 160, fit: 'cover' })
      .jpeg({ quality: 72 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  });

  // ai:scanBulkFolder runs on the picker's Mac (the user just picked
  // a folder there). The result is a list of paths that we then read
  // bytes from before queueing AI tasks — that's handled separately
  // in v0.16.2.
  ipcMain.handle('ai:scanBulkFolder', (_e, folderPath) => {
    if (!folderPath) throw new Error('folderPath required');
    const paths = imageManager.scanImagesRecursive(folderPath);
    return paths.slice(0, 1000).map((abs) => {
      let size = 0;
      try { size = fs.statSync(abs).size; } catch (_) {}
      return { abs, rel: path.relative(folderPath, abs), name: path.basename(abs), size };
    });
  });

  ipcMain.handle('samples:generateProductSheet', async () => {
    // The sample workbook is a constant the renderer doesn't need
    // server data for. Local handler is fine.
    const res = await dialog.showSaveDialog({
      title: 'Save sample workbook',
      defaultPath: 'image-studio-kh-products-sample.xlsx',
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const fileHandler = require('../fileHandler');
    fileHandler.writeProductSampleWorkbook(res.filePath);
    return res.filePath;
  });
}

/* ─── v0.16.0: read-then-upload bridges for image imports ───────── */

/**
 * The renderer's existing API surface assumes:
 *   - `images:importForProduct(productId, sourcePath)` — bytes the
 *     handler reads from disk
 *   - `images:autoMatchBySku(companyId, folderPath)` — folder scan
 *     plus per-match import
 *   - `brands:uploadIcon(sourcePath, name)` — bytes from disk
 *   - `watermarks:upload(sourcePath)` — bytes from disk
 *
 * In client mode the path is on a DIFFERENT Mac than the server. We
 * keep the same channel names but the client-side handler reads
 * bytes locally first, then calls the bytes-based RPC equivalent on
 * the server. Callers don't notice the difference.
 */
function registerClientImageImportBridges() {
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const imageManager = require('../imageManager');

  ipcMain.handle('images:importForProduct', async (_e, { productId, sourcePath } = {}) => {
    if (!productId) throw new Error('productId required');
    if (!sourcePath) throw new Error('sourcePath required');
    const bytes = await fsp.readFile(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
    return rpc('images:importFromBytes', { productId, bytes, ext });
  });

  ipcMain.handle('brands:uploadIcon', async (_e, { sourcePath, name } = {}) => {
    if (!sourcePath) throw new Error('sourcePath required');
    const bytes = await fsp.readFile(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    // The server doesn't yet have a bytes-based brand-icon upload —
    // add `brands:uploadIconFromBytes` on the server side and proxy
    // to that. See ipc.js for the handler.
    return rpc('brands:uploadIconFromBytes', { bytes, ext, name });
  });

  ipcMain.handle('watermarks:upload', async (_e, { sourcePath } = {}) => {
    if (!sourcePath) throw new Error('sourcePath required');
    const bytes = await fsp.readFile(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const name = path.basename(sourcePath, path.extname(sourcePath));
    // Server already has watermarks:uploadFromBytes (v0.15.0).
    return rpc('watermarks:uploadFromBytes', { bytes, ext, name });
  });

  /**
   * v0.16.1: bulk AI queue from a folder on the client's Mac. Read
   * each file's bytes locally and forward them to the server's
   * bytes-based handler. The renderer's existing AI Studio Bulk flow
   * calls `ai:queueBulkBatch(sourcePaths, ...)`; this handler keeps
   * the same shape and converts paths → bytes silently.
   */
  ipcMain.handle('ai:queueBulkBatch', async (_e, input = {}) => {
    if (!Array.isArray(input?.sourcePaths) || input.sourcePaths.length === 0) {
      throw new Error('No source images supplied');
    }
    // v0.17.1: progress for the read-bytes-locally phase. The
    // server-side enqueue then happens in one RPC call (we batch
    // everything in `sources`), so there's no per-task progress
    // beyond "reading file N of M".
    const events = require('../events');
    const opId = `bulk-queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const total = input.sourcePaths.length;
    events.broadcast('progress:event', {
      id: opId, kind: 'bulk-queue', done: 0, total, phase: 'reading',
    });

    const sources = [];
    const skipped = [];
    for (const sp of input.sourcePaths) {
      try {
        const bytes = await fsp.readFile(sp);
        sources.push({
          bytes,
          ext: path.extname(sp).toLowerCase() || '.jpg',
          name: path.basename(sp),
        });
      } catch (err) {
        skipped.push({ sourcePath: sp, error: err.message });
      }
      events.broadcast('progress:event', {
        id: opId, kind: 'bulk-queue', done: sources.length + skipped.length, total,
        phase: 'reading', label: path.basename(sp),
      });
    }
    if (sources.length === 0) {
      events.broadcast('progress:event', { id: opId, complete: true });
      return { queued: 0, tasks: [], skipped };
    }
    events.broadcast('progress:event', {
      id: opId, kind: 'bulk-queue', done: sources.length, total, phase: 'uploading',
    });
    let result;
    try {
      result = await rpc('ai:queueBulkBatchFromBytes', {
        companyId: input.companyId,
        provider: input.provider,
        model: input.model,
        prompt: input.prompt,
        options: input.options ?? {},
        promptTemplateId: input.promptTemplateId,
        sources,
      });
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }
    // Merge the locally-detected read failures into the server's
    // skipped list so the renderer's stats are complete.
    return {
      ...result,
      skipped: [...(result?.skipped ?? []), ...skipped],
    };
  });

  /**
   * v0.16.2: Export Center run from a client Mac. The server runs
   * the Sharp pipeline against its own DB + assets (where the files
   * actually live), produces output into a temp folder, then sends
   * us the bytes for every file. We write each one under the
   * user's chosen outputRoot. The renderer's return-shape contract
   * is preserved — same `{ exported, skipped, products, outputPath,
   * skips }` so the Export Center's result modal Just Works.
   */
  ipcMain.handle('exports:run', async (_e, { profileId, productIds, outputRoot, saveToLibrary } = {}) => {
    if (!profileId) throw new Error('profileId required');
    if (!outputRoot) throw new Error('outputRoot required');
    // v0.31.0: forward saveToLibrary — the server appends the exports to
    // ITS library (the shared source of truth) + broadcasts a catalog
    // change, which this client picks up like any other remote edit.
    const result = await rpc('exports:runForClient', { profileId, productIds, saveToLibrary });
    const files = Array.isArray(result?.files) ? result.files : [];
    // Validate + write every file under outputRoot. Reject any
    // relPath that escapes (defensive — the server would never emit
    // these, but treat the wire as hostile).
    const outRootAbs = path.resolve(outputRoot);
    for (const f of files) {
      const rel = String(f?.relPath || '').replace(/^\/+/, '');
      if (!rel || rel.includes('..')) continue;
      const dest = path.resolve(outRootAbs, rel);
      if (!dest.startsWith(outRootAbs + path.sep) && dest !== outRootAbs) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(f.bytes));
    }
    // Drop the bytes from the return value — renderer doesn't need
    // them and we shouldn't keep them in store memory.
    const { files: _files, ...rest } = result;
    return { ...rest, outputPath: outRootAbs };
  });

  /**
   * v0.26.50: client-mode local bridge for the export collision check.
   *
   * The bug this fixes: `exports:checkCollisions` was exposed on the
   * server and bound in preload, but never added to the client's
   * proxy list — so a client calling it got "No handler registered for
   * 'exports:checkCollisions'". (The export itself still ran via the
   * exports:run bridge; only the pre-flight collision warning broke.)
   *
   * Why we can't just proxy it to the server: the collision check does
   * fs.existsSync against the OUTPUT folder, and in client mode that
   * folder is on the CLIENT's disk (e.g. the user's Desktop). The
   * server can't see it — proxying would check the server's filesystem
   * and report "no collisions" even when the client's Desktop is full
   * of same-named files.
   *
   * The fix mirrors the exports:run bridge: fetch the expected
   * filenames from the server (which has the DB + naming pattern),
   * then run the existence check LOCALLY against the client's
   * outputRoot. Same return shape as the server-side previewCollisions
   * so the Export Center's collision modal works identically.
   */
  ipcMain.handle('exports:checkCollisions', async (_e, { profileId, productIds, outputRoot } = {}) => {
    if (!profileId || !outputRoot) {
      return { totalExpected: 0, collisionCount: 0, sampleCollisions: [] };
    }
    const { totalExpected, entries } = await rpc('exports:expectedOutputs', { profileId, productIds });
    const outRootAbs = path.resolve(outputRoot);
    const collisions = [];
    for (const { rel, sku } of (entries || [])) {
      const cleaned = String(rel || '').replace(/^\/+/, '');
      if (!cleaned || cleaned.includes('..')) continue;
      const dest = path.resolve(outRootAbs, cleaned);
      // Stay inside outputRoot (defensive — server-computed names
      // never escape, but the wire is treated as hostile).
      if (!dest.startsWith(outRootAbs + path.sep) && dest !== outRootAbs) continue;
      try {
        if (fs.existsSync(dest)) collisions.push({ name: path.basename(dest), sku });
      } catch { /* ignore unreadable path */ }
    }
    return {
      totalExpected: totalExpected ?? 0,
      collisionCount: collisions.length,
      sampleCollisions: collisions.slice(0, 5),
    };
  });

  /**
   * v0.16.1: export a bulk gallery image to a path on the client's
   * Mac. Fetches the bytes from the server, opens the save dialog
   * locally, writes the file. Same return contract as the
   * standalone version (returns destination path or null on cancel).
   */
  ipcMain.handle('ai:exportBulkImage', async (_e, { galleryId } = {}) => {
    if (!galleryId) throw new Error('galleryId required');
    const result = await rpc('ai:exportBulkImageBytes', { galleryId });
    if (!result?.bytes) throw new Error('No image bytes returned');
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.getFocusedWindow();
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save AI result as…',
      defaultPath: result.defaultName || 'bulk-export.png',
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, Buffer.from(result.bytes));
    return filePath;
  });

  /**
   * Auto-match in client mode:
   *   1. Scan the client's folder locally for image files.
   *   2. Fetch the SKU list from the server.
   *   3. Group + sort matches purely on the client (no DB needed).
   *   4. Stream per-file uploads to the server via importFromBytes.
   *   5. Aggregate the same diagnostic stats the server-side handler
   *      returns so the result modal looks identical.
   */
  ipcMain.handle('images:autoMatchBySku', async (_e, { companyId, folderPath } = {}) => {
    if (!companyId) throw new Error('companyId is required');
    if (!folderPath) throw new Error('Folder path is required');

    // v0.17.1: progress events. In client mode `broadcast` only
    // delivers to the local renderer (no WS server here), which is
    // exactly what we want — the user staring at the import modal.
    const events = require('../events');
    const opId = `auto-match-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    events.broadcast('progress:event', {
      id: opId, kind: 'auto-match', done: 0, total: null, phase: 'scanning',
    });

    const list = await rpc('products:list', { companyId });
    if (!Array.isArray(list)) throw new Error('Could not fetch product list from server');
    const skuToProduct = new Map(list.map((p) => [p.sku.toLowerCase(), p]));
    const skuSet = new Set(skuToProduct.keys());

    const allImages = imageManager.scanImagesRecursive(folderPath);
    const { groups, unmatched } = imageManager.groupAndSortMatches(allImages, folderPath, skuSet);

    // We don't know the server's MAX_IMAGES_PER_PRODUCT for sure
    // (the imageManager constant is local), but the server-side cap
    // is also imageManager.MAX_IMAGES_PER_PRODUCT — they're the same
    // module bundled into both processes, so the number matches.
    const MAX = imageManager.MAX_IMAGES_PER_PRODUCT;
    let productsTouched = 0;
    let imagesImported = 0;
    let imagesSkippedDup = 0;
    let imagesSkippedCap = 0;

    // Pre-tally for a determinate bar.
    let total = 0;
    for (const [, candidates] of groups) total += candidates.length;
    let done = 0;

    try {
      for (const [sku, candidates] of groups) {
        const product = skuToProduct.get(sku);
        if (!product) continue;
        const remainingCap = MAX - (product.imageCount ?? 0);
        const capped = candidates.slice(0, Math.max(0, remainingCap));
        imagesSkippedCap += candidates.length - capped.length;
        done += candidates.length - capped.length;

        let touched = false;
        for (const c of capped) {
          try {
            const bytes = await fsp.readFile(c.sourcePath);
            const ext = path.extname(c.sourcePath).toLowerCase() || '.jpg';
            const res = await rpc('images:importFromBytes', {
              productId: product.id, bytes, ext,
            });
            if (res?.skipped) imagesSkippedDup += 1;
            else { imagesImported += 1; touched = true; }
          } catch (_err) {
            imagesSkippedDup += 1;
          }
          done += 1;
          events.broadcast('progress:event', {
            id: opId, kind: 'auto-match', done, total,
            phase: 'uploading', label: product.sku,
          });
        }
        if (touched) productsTouched += 1;
      }
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }

    // Mirror the shape the server-side handler returns so the result
    // modal's existing fields just work. We don't recompute the
    // "products still empty" list here — fetching it would require a
    // post-import products:list round-trip; let the renderer do that
    // itself if it wants the precise number.
    const unmatchedRelative = unmatched
      .map((abs) => {
        try {
          const rel = path.relative(folderPath, abs);
          return rel && !rel.startsWith('..') ? rel : abs;
        } catch (_) { return abs; }
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const UNMATCHED_CAP = 500;
    const unmatchedSamples = unmatchedRelative.slice(0, UNMATCHED_CAP);
    const extCounts = {};
    for (const rel of unmatchedRelative) {
      const ext = (path.extname(rel) || '(no ext)').toLowerCase();
      extCounts[ext] = (extCounts[ext] ?? 0) + 1;
    }

    return {
      productsTouched,
      imagesImported,
      imagesSkippedDup,
      imagesSkippedCap,
      unmatchedFiles: unmatched.length,
      unmatchedSamples,
      unmatchedSamplesCapped: unmatched.length > unmatchedSamples.length,
      unmatchedExtCounts: extCounts,
      productsStillEmpty: [],          // skipped — see comment above
      productsStillEmptyCapped: false,
      scannedFiles: allImages.length,
      totalProducts: list.length,
      matchedSkus: groups.size,
      maxImagesPerProduct: MAX,
    };
  });
}

module.exports = {
  registerClientProxies,
  getConnectionState,
  rpc,
  baseUrl,
  authHeader,
};
