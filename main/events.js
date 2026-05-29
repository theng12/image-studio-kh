/**
 * v0.15.1: central event bus for cross-Mac live updates.
 *
 * Three sources of events exist in this app:
 *   1. The AI queue runner — emits `ai:taskUpdate` and `ai:galleryAdded`
 *      while tasks progress / complete (poll-driven from main).
 *   2. Write IPC handlers in main/ipc.js — after each successful
 *      mutation (`products:update`, `images:reorderImages`, etc.) we
 *      emit a small `catalog:*` event so other Macs can refetch.
 *   3. Server boot — emits `server:hello` when a client first connects
 *      so the renderer can update its connection-state slice.
 *
 * `broadcast(channel, payload)` delivers each event to TWO audiences:
 *   - The local main-window renderer (existing IPC path, unchanged
 *     for standalone mode).
 *   - Every WebSocket client connected to the server (new in v0.15.1).
 *
 * The two paths are independent — local IPC delivery has nothing to
 * do with the WS connection set, and vice versa. A standalone Mac
 * (no server running, no clients connected) just hits the IPC path
 * and exits early on the WS side.
 */

let _ctx = null;        // { getMainWindow }
// v0.15.3 / v0.22.11: each WS client is annotated with the user
// record + a per-socket connectedAt timestamp so presence can show
// "Mengly · connected 14 min ago" honestly. Pre-v0.22.11 we
// stamped Date.now() inside getPresence() every call which made
// every entry read "just now" forever — useless.
//
// Stored as Map<ws, { user, connectedAt }>.
const _wsClients = new Map();

function init(ctx) {
  _ctx = ctx;
}

/**
 * Send `payload` to the local main-window renderer over IPC.
 * No-op if there's no window or it's been destroyed.
 */
function sendToLocalRenderer(channel, payload) {
  try {
    const win = _ctx?.getMainWindow?.();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch (_) { /* renderer not up yet, or HMR mid-swap */ }
}

/**
 * Send `payload` over the wire to every connected WS client. Skips
 * clients whose socket isn't in the OPEN state (closing / errored).
 *
 * Best-effort: a write error on one socket doesn't block delivery to
 * the others. Dead sockets get pruned when their `close` handler fires.
 */
function sendToWsClients(channel, payload) {
  if (_wsClients.size === 0) return;
  const frame = JSON.stringify({ channel, payload });
  for (const ws of _wsClients.keys()) {
    try {
      // ws.OPEN === 1 per the standard
      if (ws.readyState === 1) ws.send(frame);
    } catch (_) { /* socket will close itself */ }
  }
}

function broadcast(channel, payload) {
  sendToLocalRenderer(channel, payload);
  sendToWsClients(channel, payload);
}

function addWsClient(ws, user) {
  // v0.22.11: stash a per-socket connectedAt so presence can show a
  // real "connected 14 min ago" instead of always "just now".
  _wsClients.set(ws, { user: user || null, connectedAt: Date.now() });
  // Fire a presence event so anyone listening (Settings page) can
  // refresh their list without polling.
  broadcast('users:presence', getPresence());
}

function removeWsClient(ws) {
  _wsClients.delete(ws);
  broadcast('users:presence', getPresence());
}

function getWsClientCount() {
  return _wsClients.size;
}

/**
 * Snapshot of currently-connected users. One row per user (deduped
 * across multiple sockets — opening two tabs of the same client
 * doesn't show "Theng" twice). Sockets without an attached user
 * (shouldn't happen given auth, but be defensive) are omitted.
 */
function getPresence() {
  // v0.22.11: dedupe by user id (one row even if user has two
  // sockets open) but keep the EARLIEST connectedAt — that's the
  // honest "since when have they been here" answer. The structure
  // is `Map<ws, { user, connectedAt }>` as of v0.22.11; older
  // builds stored bare `user` so be defensive in case of in-place
  // upgrades that didn't restart cleanly.
  const byId = new Map();
  for (const entry of _wsClients.values()) {
    const user = entry?.user ?? entry; // back-compat
    if (!user?.id) continue;
    const connectedAt = entry?.connectedAt ?? Date.now();
    const prev = byId.get(user.id);
    if (!prev) {
      byId.set(user.id, {
        id: user.id,
        name: user.name,
        role: user.role,
        connectedAt,
      });
    } else if (connectedAt < prev.connectedAt) {
      prev.connectedAt = connectedAt;
    }
  }
  return Array.from(byId.values());
}

module.exports = {
  init,
  broadcast,
  addWsClient,
  removeWsClient,
  getWsClientCount,
  getPresence,
};
