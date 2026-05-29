/**
 * v0.14.2: HTTP server for multi-Mac client/server mode.
 *
 * Design — single generic RPC endpoint backed by a channel registry.
 * Instead of writing 60+ REST routes that mirror the existing IPC API,
 * we register handlers by channel name (same names as `ipcMain.handle`)
 * and expose them all behind one POST endpoint:
 *
 *   POST /api/rpc
 *     Body: { "channel": "products:list", "args": { ... } }
 *     Auth: Authorization: Bearer <user-token>
 *     Returns: { "result": ... } or { "error": "..." }
 *
 * The same handler function serves local IPC AND remote HTTP. Adding a
 * new client-accessible channel means calling `expose(channel, handler)`
 * once in ipc.js. No route boilerplate.
 *
 * Asset files (images) are served separately via `GET /assets/<path>`
 * with the same `assetsRoot`-bounded security check the local
 * `app-image://` protocol uses.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
// v0.15.1: WebSocket support for live-update push to clients.
// Loaded lazily inside bootServer() so dev workflows that don't run
// the server (standalone mode) don't pay the import cost.
let WebSocketServer = null;

// In-memory registry of channel → handler. Populated by ipc.js via
// `registerHandler(channel, fn)` after the local DB is up.
const handlers = new Map();

/**
 * v0.15.2: per-request caller identity. Set immediately before each
 * RPC handler runs, read by helpers like `companies.getActiveId()` to
 * scope state per-user. Cleared in a `finally` so an async handler's
 * later micro-tasks don't leak the wrong user-id into an unrelated
 * call. (better-sqlite3 is synchronous and our handlers mostly are,
 * so the window for an out-of-order interleave is tiny — but the
 * finally makes it provably safe.)
 *
 * The local renderer (server-mode admin or standalone) has NO caller
 * user — it goes through ipcMain.handle, not /api/rpc. In that case
 * `getCurrentUserId()` returns null and downstream code falls back
 * to the shared app_state.
 */
let _currentUserId = null;
function getCurrentUserId() { return _currentUserId; }

/**
 * v0.15.0: undo the client's base64 envelope so binary payloads
 * (`{ __bin: true, b64: '...' }`) arrive at the handler as Node
 * Buffers — the form `productImages.addFromBytes` and friends already
 * accept. Mirrors `serializeForServer()` in main/client/index.js.
 */
function deserializeFromClient(arg) {
  if (arg == null) return arg;
  if (Array.isArray(arg)) return arg.map(deserializeFromClient);
  if (typeof arg === 'object') {
    if (arg.__bin === true && typeof arg.b64 === 'string') {
      return Buffer.from(arg.b64, 'base64');
    }
    const out = {};
    for (const k of Object.keys(arg)) out[k] = deserializeFromClient(arg[k]);
    return out;
  }
  return arg;
}

/**
 * v0.15.0: re-encode binary returns (e.g. `templates:renderPreview`
 * returns `{ bytes: <Buffer> }`) into the same `{ __bin, b64 }` envelope
 * for the wire. The client's rpc() helper undoes this on receipt.
 */
function serializeResultForWire(val) {
  if (val == null) return val;
  if (Buffer.isBuffer(val)) {
    return { __bin: true, b64: val.toString('base64') };
  }
  if (val instanceof ArrayBuffer) {
    return { __bin: true, b64: Buffer.from(val).toString('base64') };
  }
  if (ArrayBuffer.isView(val)) {
    return { __bin: true, b64: Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64') };
  }
  if (Array.isArray(val)) return val.map(serializeResultForWire);
  if (typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[k] = serializeResultForWire(val[k]);
    return out;
  }
  return val;
}

function registerHandler(channel, fn) {
  if (typeof fn !== 'function') throw new Error(`registerHandler(${channel}): not a function`);
  handlers.set(channel, fn);
}

function getRegisteredChannels() {
  return Array.from(handlers.keys()).sort();
}

let _server = null;
let _bindings = null; // { port, addresses: string[] }

/**
 * Read the request body, JSON-parse it, and yield the parsed object.
 * Caps at 100MB to keep a misbehaving client from OOMing the server.
 */
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 100 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error('Invalid JSON: ' + err.message)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const users = require('../db/users');
    const user = users.getByToken(token);
    if (!user) return null;
    users.touchLastSeen(user.id);
    return user;
  } catch (_) { return null; }
}

/**
 * Asset serving. URL form `/assets/<rel>` where `<rel>` is a path
 * relative to `<dataDir>/assets/`. Identical security checks to the
 * local `app-image://` protocol handler: must resolve inside the
 * assets / processed / ai-gallery roots, no `..`, no absolute paths.
 */
// v0.26.42: async asset serving. Pre-v0.26.42 this used existsSync +
// statSync, which blocked the entire HTTP server while the kernel
// statted the file. On iCloud-stored data dirs that's potentially
// seconds per request — and the server runs ALL HTTP requests on
// the same event loop, so one slow stat froze every other client.
// Now uses fs.promises and only this single request waits.
async function serveAsset(req, res, urlPath, dataDir) {
  const rel = decodeURIComponent(urlPath.replace(/^\/assets\//, ''));
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end(); return;
  }
  // Mirror protocol.js's three-root resolution.
  const assetsRoot = path.normalize(path.join(dataDir, 'assets'));
  const processedRoot = path.normalize(path.join(dataDir, 'processed'));
  const aiGalleryRoot = path.normalize(path.join(dataDir, 'ai-gallery'));
  let abs;
  if (rel.startsWith('processed/') || rel.startsWith('ai-gallery/')) {
    abs = path.join(dataDir, rel);
  } else {
    abs = path.join(assetsRoot, rel);
  }
  const normalized = path.normalize(abs);
  if (
    !normalized.startsWith(assetsRoot) &&
    !normalized.startsWith(processedRoot) &&
    !normalized.startsWith(aiGalleryRoot)
  ) {
    res.writeHead(403); res.end(); return;
  }
  // v0.26.42: combined stat + existence check in one async call.
  // stat() returns the file info if it exists; ENOENT if not.
  let stat;
  try {
    stat = await fs.promises.stat(normalized);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404); res.end(); return;
    }
    process.stderr.write(`[serveAsset] stat error: ${err.message}\n`);
    res.writeHead(500); res.end(); return;
  }
  const ext = path.extname(normalized).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.png'  ? 'image/png' :
    ext === '.webp' ? 'image/webp' :
    ext === '.svg'  ? 'image/svg+xml' :
    'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache', // mtime changes on renumber; force revalidation
    'Last-Modified': stat.mtime.toUTCString(),
  });
  fs.createReadStream(normalized).pipe(res);
}

async function handleRequest(req, res, dataDir) {
  // CORS preflight: clients are Electron renderers loaded from app://
  // protocol. Allow them.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const urlPath = req.url.split('?')[0];

  // Public health check — no auth required so clients can verify
  // they have the right URL before pasting in a token.
  if (req.method === 'GET' && urlPath === '/api/ping') {
    // v0.26.52: was `require('../../package.json').version`, which
    // works in the dev source layout but THROWS in the packaged app —
    // the compiled file lives at dist-electron/main/server/index.js
    // inside the asar, so `../../package.json` points at a
    // non-existent dist-electron/package.json. The throw made the
    // ENTIRE ping endpoint return 500, which surfaced to clients as a
    // permanent "Server hiccup" (amber) chip + a failing network
    // diagnostic ("reachable but not an Image Studio KH server"),
    // even though /api/whoami and all RPC calls worked fine. Use
    // app.getVersion() — the canonical Electron API that reads the
    // version correctly in both dev and production. Inline-required
    // to match the lazy-require style used elsewhere in this file.
    const appVersion = require('electron').app.getVersion();
    sendJson(res, 200, { ok: true, app: 'image-studio-kh', version: appVersion });
    return;
  }

  // Everything else requires auth.
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'Invalid or missing token' });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/whoami') {
    sendJson(res, 200, {
      user: { id: user.id, name: user.name, role: user.role },
      registeredChannels: getRegisteredChannels(),
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/rpc') {
    // v0.20.0: rate-limit each user before even reading the body.
    const { checkRate, WINDOW_MS, LIMIT } = require('./rateLimit');
    const gate = checkRate(user.id);
    if (!gate.ok) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
      });
      res.end(JSON.stringify({
        error: `Rate limit exceeded (${LIMIT} calls per ${WINDOW_MS / 1000}s). Try again in a moment.`,
      }));
      return;
    }

    let body;
    try { body = await readJsonBody(req); }
    catch (err) { sendJson(res, 400, { error: err.message }); return; }
    const channel = body?.channel;
    if (!channel) { sendJson(res, 400, { error: 'channel required' }); return; }
    const handler = handlers.get(channel);
    if (!handler) { sendJson(res, 404, { error: `Unknown channel: ${channel}` }); return; }

    // v0.20.0: validate args before invoking the handler. Channels
    // without a registered validator pass through (current
    // behavior); registered ones return a clear 400 on bad shape.
    // Note: validators see the SERIALIZED args (with `__bin`
    // envelopes still wrapped) so bytes-handling channels write
    // their validators to expect that shape.
    const { getValidator } = require('./validators');
    const validate = getValidator(channel);
    if (validate) {
      const result = validate(body.args);
      if (result !== true) {
        sendJson(res, 400, { error: `Bad request: ${result}` });
        return;
      }
    }

    try {
      _currentUserId = user.id;
      let result;
      try {
        result = await handler(deserializeFromClient(body.args));
      } finally {
        _currentUserId = null;
      }
      sendJson(res, 200, { result: serializeResultForWire(result) });
    } catch (err) {
      // Surface the error message but not the stack trace by default.
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (req.method === 'GET' && urlPath.startsWith('/assets/')) {
    // v0.26.42: await — serveAsset is now async. The outer handler
    // doesn't need the result (status is written directly to `res`)
    // but we DO want errors to be catchable by handleRequest's
    // try/catch up the stack.
    await serveAsset(req, res, urlPath, dataDir);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Boot the HTTP server. Returns a promise that resolves to the
 * { port, addresses } binding info, or rejects if the port is taken.
 * Listens on 0.0.0.0 so Tailscale / LAN clients can reach it.
 */
function bootServer({ port, dataDir }) {
  if (_server) return Promise.resolve(_bindings);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      handleRequest(req, res, dataDir).catch((err) => {
        process.stderr.write(`[server] unhandled: ${err.stack || err.message}\n`);
        try { sendJson(res, 500, { error: 'Internal server error' }); } catch (_) {}
      });
    });
    srv.on('error', reject);

    // v0.15.1: attach a WebSocket server to the same HTTP port.
    // Endpoint: ws://host:port/api/events?token=<bearer>. We can't
    // pass an Authorization header from a browser-style WebSocket
    // client, so the token rides in the query string. The transport
    // is private (Tailscale / LAN) so the leak risk is low; we log
    // only the user.name + connection event, never the raw token.
    try {
      if (!WebSocketServer) WebSocketServer = require('ws').WebSocketServer;
      const events = require('../events');
      const users = require('../db/users');
      const wss = new WebSocketServer({ noServer: true });

      srv.on('upgrade', (req, socket, head) => {
        const url = req.url || '';
        if (!url.startsWith('/api/events')) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }
        // Parse the token query param. Anything else is rejected.
        let token = '';
        try {
          token = new URL(url, 'http://x').searchParams.get('token') || '';
        } catch (_) { /* malformed URL */ }
        if (!token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        let user = null;
        try {
          user = users.getByToken(token);
        } catch (_) { /* db unavailable */ }
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        try { users.touchLastSeen(user.id); } catch (_) {}

        wss.handleUpgrade(req, socket, head, (ws) => {
          // v0.15.3: attach the user record so presence queries can
          // list "who's online" without crawling the users table.
          events.addWsClient(ws, user);
          process.stdout.write(`[server] ws connected: ${user.name} (clients=${events.getWsClientCount()})\n`);
          // Greeting frame so the client knows the connection is
          // live before any catalog event fires.
          try {
            ws.send(JSON.stringify({
              channel: 'server:hello',
              payload: { user: { id: user.id, name: user.name, role: user.role } },
            }));
          } catch (_) {}
          ws.on('close', () => {
            events.removeWsClient(ws);
            process.stdout.write(`[server] ws disconnected: ${user.name} (clients=${events.getWsClientCount()})\n`);
          });
          ws.on('error', (err) => {
            process.stderr.write(`[server] ws error: ${err.message}\n`);
            events.removeWsClient(ws);
          });
          // Heartbeat ping every 30s so dead connections (laptop lid
          // closed, network drop) are detected and cleaned up
          // instead of lingering in _wsClients forever.
          const interval = setInterval(() => {
            if (ws.readyState !== 1) {
              clearInterval(interval);
              return;
            }
            try { ws.ping(); } catch (_) {}
          }, 30_000);
          ws.on('close', () => clearInterval(interval));
        });
      });
    } catch (err) {
      process.stderr.write(`[server] ws init failed: ${err.message}\n`);
    }

    srv.listen(port, '0.0.0.0', () => {
      _server = srv;
      _bindings = { port, addresses: collectLocalAddresses() };
      process.stdout.write(`[server] listening on port ${port}\n`);
      resolve(_bindings);
    });
  });
}

function stopServer() {
  if (!_server) return Promise.resolve();
  return new Promise((resolve) => {
    _server.close(() => {
      _server = null;
      _bindings = null;
      // v0.20.0: clear rate-limit state so stale token buckets
      // don't survive a server stop / restart cycle.
      try { require('./rateLimit').reset(); } catch (_) {}
      resolve();
    });
  });
}

function getStatus() {
  return _bindings ? { running: true, ..._bindings } : { running: false };
}

/**
 * Collect interesting local IPs the client could connect to: LAN IPs
 * (192.168.*, 10.*, 172.16-31.*) and Tailscale (100.64-127.*) on the
 * server Mac. Loopback / link-local skipped. Used by Settings to show
 * the admin the right URL to paste into clients.
 *
 * v0.26.35: also emit the `<hostname>.local` Bonjour name as a first-
 * class entry (kind='mdns'). macOS publishes the computer name over
 * mDNS automatically — any Mac on the same Wi-Fi resolves it
 * regardless of what DHCP did with the IP. This is the easy fix for
 * the most common LAN-client breakage: your router gave the server
 * Mac a new IP after a sleep / reboot and now every client's
 * `clientServerUrl` is stale. With the `.local` hostname they don't
 * see the IP change at all — DNS resolves freshly each connect.
 *
 * Caveat: mDNS only works inside one broadcast domain. Multi-subnet
 * setups (managed switches with VLANs, mesh routers with isolation
 * mode, public Wi-Fi networks that block mDNS) won't resolve
 * `.local`. The IPs stay in the list as fallback for those cases.
 *
 * Why we don't strip `.local` if `os.hostname()` already includes it:
 * on macOS, `os.hostname()` returns the LocalHostName which already
 * ends in `.local` if Sharing is on. Detect + reuse rather than
 * append blindly.
 */
function collectLocalAddresses() {
  const os = require('node:os');
  const ifs = os.networkInterfaces();
  const out = [];

  // v0.26.35: mDNS hostname entry. Listed FIRST when no Tailscale
  // address is present — for LAN-only users this is the friendliest
  // option to recommend to clients ("type ServerMac.local instead of
  // an IP that might change tomorrow").
  try {
    const raw = os.hostname();
    if (raw && typeof raw === 'string') {
      const trimmed = raw.trim();
      const host = trimmed.toLowerCase().endsWith('.local') ? trimmed : `${trimmed}.local`;
      // Only surface if the hostname is a reasonable shape — empty
      // strings or single-word "localhost" wouldn't actually work.
      if (host && host !== '.local' && host !== 'localhost.local') {
        out.push({ name: 'Bonjour hostname', ip: host, kind: 'mdns' });
      }
    }
  } catch (_) { /* hostname unavailable — fine, we still have IPs */ }

  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] || []) {
      if (iface.family !== 'IPv4') continue;
      if (iface.internal) continue;
      const ip = iface.address;
      // Categorize: Tailscale gets priority because it's the
      // recommended transport.
      let kind = 'lan';
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) kind = 'tailscale';
      else if (/^192\.168\./.test(ip)) kind = 'lan';
      else if (/^10\./.test(ip)) kind = 'lan';
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) kind = 'lan';
      else continue; // skip public / unusual ranges
      out.push({ name, ip, kind });
    }
  }
  // v0.26.35: sort order — Tailscale first (most robust across
  // networks), then mDNS (most robust within one network, survives
  // IP changes), then raw LAN IPs (most brittle but most universally
  // supported — works even on weird subnet setups where mDNS doesn't).
  const kindRank = { tailscale: 0, mdns: 1, lan: 2 };
  out.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9));
  return out;
}

module.exports = {
  registerHandler,
  getRegisteredChannels,
  getCurrentUserId,
  bootServer,
  stopServer,
  getStatus,
  collectLocalAddresses,
};
