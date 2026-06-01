const { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Lock the app's identity so dev and packaged builds resolve to the SAME
// userData folder. Without this, npm run dev uses the package.json `name`
// (`image-studio-kh`) while the packaged build uses `productName`
// (`Image Studio KH`) — producing two separate folders in
// ~/Library/Application Support that don't share data or config.
// Must run before app.whenReady().
app.setName('Image Studio KH');

const { registerImageProtocol, registerClientImageProtocol, registerRendererProtocol } = require('./protocol');
const { registerIpc } = require('./ipc');
const { initDb } = require('./db');
const { loadConfig, saveConfig, legacyDataDir } = require('./config');
const aiQueueRunner = require('./ai/queueRunner');
const clientRuntime = require('./client');
// v0.15.1: shared event bus. Initialised early so queueRunner +
// IPC handlers can call broadcast() without depending on window
// readiness.
const events = require('./events');

const isDev = !app.isPackaged;

// Match the briefing's data folder name: ~/Library/Application Support/Image Studio KH/
// Set this BEFORE any path resolution so app.getPath('userData') returns the
// new location consistently. The migration below copies existing data from
// the old lowercase folder on first run.
app.setName('Image Studio KH');

function migrateLegacyUserData() {
  try {
    const newUserData = app.getPath('userData');
    if (fs.existsSync(newUserData) && fs.readdirSync(newUserData).length > 0) {
      return; // Already migrated or fresh install with the new name.
    }
    const parent = path.dirname(newUserData);
    const oldUserData = path.join(parent, 'image-studio-kh');
    if (!fs.existsSync(oldUserData)) return;
    fs.mkdirSync(newUserData, { recursive: true });
    fs.cpSync(oldUserData, newUserData, { recursive: true, errorOnExist: false, force: false });
    process.stdout.write(`[migrate] copied ${oldUserData} → ${newUserData}\n`);
  } catch (err) {
    process.stderr.write(`[migrate] legacy userData failed: ${err.message}\n`);
  }
}

migrateLegacyUserData();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-image',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    // Production renderer is served via app://local/... so blob URLs created
    // by the page have a proper origin (blob:app://local) — required for
    // ONNX runtime's dynamic-import of WASM backends used by @imgly.
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function crashLogPath() {
  return userDataPath('crash.log');
}

function logEvent(event, detail) {
  const line = `[${new Date().toISOString()}] ${event}${detail ? ' :: ' + detail : ''}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(crashLogPath()), { recursive: true });
    fs.appendFileSync(crashLogPath(), line);
  } catch (err) {
    process.stderr.write(`[crash-log] failed to write: ${err.message}\n`);
  }
}

logEvent('boot', `pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node}`);

process.on('uncaughtException', (err) => {
  logEvent('uncaughtException', err && (err.stack || err.message));
});
process.on('unhandledRejection', (reason) => {
  logEvent('unhandledRejection', reason && (reason.stack || String(reason)));
});

/**
 * v0.26.19: turn an `app-image://local/<relpath>` URL back into the
 * absolute disk path so the right-click context menu can hand the
 * file to clipboard / Finder. Mirrors the security checks in
 * `main/protocol.js`'s handler — same allowed roots, same
 * path-traversal block — because this helper bypasses the protocol
 * fetch and reads the file directly.
 *
 * Returns the absolute path on success, throws on:
 *   - non-app-image URL (caller already checks but defensive)
 *   - absolute path injected after the scheme (path traversal)
 *   - path escaping the dataDir asset roots
 *   - file missing on disk
 */
function resolveAppImageUrl(srcUrl) {
  if (!srcUrl || !srcUrl.startsWith('app-image://local/')) {
    throw new Error('not an app-image url');
  }
  const stripped = srcUrl.replace(/^app-image:\/\/local\//, '');
  const noQuery = stripped.split('?')[0];
  const decoded = decodeURIComponent(noQuery);
  if (path.isAbsolute(decoded)) throw new Error('absolute path not allowed');

  // dataDir resolution mirrors `registerImageProtocol`'s contract.
  // We re-read it via the loaded config rather than wiring another
  // module import — keeps this helper self-contained.
  const dataDir = loadConfig().dataDir;
  const assetsRoot    = path.normalize(path.join(dataDir, 'assets'));
  const processedRoot = path.normalize(path.join(dataDir, 'processed'));
  const aiGalleryRoot = path.normalize(path.join(dataDir, 'ai-gallery'));

  let abs;
  if (decoded.startsWith('processed/') || decoded.startsWith('ai-gallery/')) {
    abs = path.join(dataDir, decoded);
  } else {
    abs = path.join(assetsRoot, decoded);
  }
  const normalized = path.normalize(abs);

  if (
    !normalized.startsWith(assetsRoot) &&
    !normalized.startsWith(processedRoot) &&
    !normalized.startsWith(aiGalleryRoot)
  ) {
    throw new Error('path escapes asset roots');
  }
  if (!fs.existsSync(normalized)) {
    throw new Error('file missing on disk');
  }
  return normalized;
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f7f7f8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: false — required because the preload script uses CommonJS
      // `require('electron')` to bootstrap the contextBridge surface. With
      // sandbox enabled the preload runs in a stripped-down V8 isolate where
      // node-style `require` is unavailable, which breaks the entire IPC
      // bridge. nodeIntegration + contextIsolation already constrain what
      // the renderer can see, so the trade-off is acceptable.
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    logEvent('window:shown');
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logEvent('render-process-gone', JSON.stringify(details));
  });

  /**
   * v0.26.19: native right-click context menu for images. Electron's
   * default is no menu at all in the renderer (a security choice —
   * web apps need to opt in to native chrome). We opt in just for
   * the image case so users can drag pixels out into Slack, Mail,
   * Photoshop, etc. without going through Export Center.
   *
   * Only fires when:
   *   - `params.mediaType === 'image'` (Electron classifies the right-
   *     clicked element as an <img> or background-image)
   *   - the srcURL is one of OUR app-image://local/ URLs. We don't
   *     offer the menu on arbitrary remote / data URLs because we
   *     can't translate those back to a stable disk path, and Copy
   *     Image on a data: URL is meaningless anyway.
   *
   * "Copy Image" uses `nativeImage.createFromPath` on the resolved
   * disk file. This puts a BITMAP on the clipboard, not the URL — so
   * Cmd+V in any app that accepts images works directly. Confirmed
   * working in Photoshop, Slack, Mail, Preview, Pages.
   *
   * "Copy Image Address" copies the on-disk absolute path (not the
   * `app-image://...` URL — that\'s renderer-only and useless in
   * Finder/Terminal). "Reveal in Finder" opens Finder with the file
   * selected, same as Cmd-clicking a download chip.
   */
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (params.mediaType !== 'image') return;
    if (!params.srcURL || !params.srcURL.startsWith('app-image://local/')) return;

    // v0.26.20: detect client mode + whether the file is locally on
    // disk. Server / standalone Macs have all three menu items; client
    // Macs (where images live on the REMOTE server and the local disk
    // has no asset tree) get just "Copy Image" because "Copy Address"
    // and "Reveal in Finder" would point to a path that doesn't exist
    // on this machine.
    //
    // Detection: prefer the explicit mode flag; fall back to a disk
    // probe via resolveAppImageUrl so a misconfigured client doesn't
    // accidentally show local-disk items. The probe also doubles as
    // the absPath lookup for the server case — one call, two answers.
    const isClient = loadConfig().mode === 'client';
    let absPath = null;
    if (!isClient) {
      try {
        absPath = resolveAppImageUrl(params.srcURL);
      } catch (err) {
        // On a server-mode machine we expect resolution to succeed.
        // If it doesn't, log + fall through with absPath=null so the
        // user still gets a working "Copy Image" via net.fetch.
        logEvent('context-menu:resolve-failed', err.message);
      }
    }

    const template = [
      {
        label: 'Copy Image',
        click: async () => {
          // v0.26.20: switched from `nativeImage.createFromPath(absPath)`
          // (server-only — fails on clients because the file isn't on
          // local disk) to `net.fetch(srcURL)`. `net.fetch` routes
          // through whichever `app-image` protocol handler is
          // registered:
          //   - server / standalone → registerImageProtocol → reads
          //     bytes from local disk
          //   - client              → registerClientImageProtocol →
          //     HTTPs to the remote server with the auth token and
          //     proxies the bytes back
          // Either way we end up with a buffer in the main process,
          // which we hand to nativeImage.createFromBuffer + clipboard.
          // One code path, both modes.
          try {
            const res = await net.fetch(params.srcURL);
            if (!res.ok) throw new Error(`fetch returned ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            const img = nativeImage.createFromBuffer(buf);
            if (img.isEmpty()) {
              logEvent('context-menu:copy-image-empty', params.srcURL);
              return;
            }
            clipboard.writeImage(img);
          } catch (err) {
            logEvent('context-menu:copy-image-failed', err.message);
          }
        },
      },
    ];

    // Local-disk items only show on the server / standalone Mac. On a
    // client these would point to a path that doesn't exist on this
    // machine, which is confusing rather than helpful — the user
    // asked us to skip "Reveal in Finder" specifically.
    if (absPath) {
      template.push(
        {
          label: 'Copy Image Address',
          click: () => {
            try { clipboard.writeText(absPath); }
            catch (err) { logEvent('context-menu:copy-address-failed', err.message); }
          },
        },
        { type: 'separator' },
        {
          label: 'Reveal in Finder',
          click: () => {
            try { shell.showItemInFolder(absPath); }
            catch (err) { logEvent('context-menu:reveal-failed', err.message); }
          },
        },
      );
    }
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // Any window.open() from the renderer (e.g. donation widget) lands in the
  // user's default browser. Crypto wallet extensions live there, not here.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (isDev && devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('app://local/index.html');
  }
}

app.on('child-process-gone', (_e, details) => {
  logEvent('child-process-gone', JSON.stringify(details));
});

/**
 * On the very first launch (or any later launch where the recorded data
 * folder no longer exists), offer the user a chance to pick a custom data
 * folder. Skip → keep the default. We also detect a pre-v0.5 install via
 * its legacy ~/Library/Application Support/<name>/data/ folder and offer to
 * keep using that path so existing test data isn't orphaned.
 */
function handleFirstLaunch(config) {
  // Pick the most-data-bearing legacy folder. There are historically two
  // possible locations (see the long comment near app.setName above):
  //   ~/Library/Application Support/Image Studio KH/data/    (packaged)
  //   ~/Library/Application Support/image-studio-kh/data/    (dev, pre-fix)
  // We prefer the one with a database.sqlite, then the one most recently
  // modified, so we don't lose data the user actually cares about.
  const candidates = [
    legacyDataDir(),
    path.join(path.dirname(legacyDataDir()), '..', 'image-studio-kh', 'data'),
  ];
  const legacyPath = candidates.find((p) =>
    fs.existsSync(path.join(p, 'database.sqlite')) || fs.existsSync(path.join(p, 'assets')),
  ) || legacyDataDir();
  const legacyHasData =
    fs.existsSync(path.join(legacyPath, 'database.sqlite')) ||
    fs.existsSync(path.join(legacyPath, 'assets'));

  // If we've already prompted once AND the configured folder still exists,
  // nothing to do.
  if (config.firstLaunchHandled && fs.existsSync(config.dataDir)) {
    return config;
  }

  // Existing v0.4.x install: silently keep using the legacy path.
  if (legacyHasData && !config.firstLaunchHandled) {
    const next = { ...config, dataDir: legacyPath, firstLaunchHandled: true };
    saveConfig(next);
    logEvent('first-launch:legacy-kept', legacyPath);
    return next;
  }

  // Fresh install — ask where to put data.
  // v0.13.0: clarify that "Choose a folder" can mean either a fresh
  // folder OR an existing one — particularly useful when the user has
  // their library on iCloud Drive and is setting up a second Mac.
  const res = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Choose a folder…', 'Use default', 'Quit'],
    defaultId: 1,
    cancelId: 2,
    title: 'Where should Image Studio KH save your images?',
    message: 'Image Studio KH stores your raw product photos, processed images, and AI generations in a single folder.',
    detail:
      `The default is:\n${config.dataDir}\n\n` +
      `You can also point at an existing data folder — for example, one on ` +
      `iCloud Drive from another Mac. The app will pick up your existing ` +
      `companies, products, and assets and continue from there.\n\n` +
      `You can change this anytime in Settings → Data folder.`,
  });
  if (res === 2) {
    app.exit(0);
    return config;
  }
  if (res === 0) {
    const pick = dialog.showOpenDialogSync({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Pick a folder for Image Studio KH data',
    });
    if (pick && pick[0]) {
      const next = { ...config, dataDir: pick[0], firstLaunchHandled: true };
      saveConfig(next);
      logEvent('first-launch:custom-folder', pick[0]);
      return next;
    }
  }
  // Use default
  const next = { ...config, firstLaunchHandled: true };
  saveConfig(next);
  logEvent('first-launch:default-folder', config.dataDir);
  return next;
}

app.whenReady().then(() => {
  logEvent('app:ready');

  // v0.15.1: initialise the event bus before anything that might
  // call broadcast() (queueRunner, IPC writes, server WS handler).
  events.init({ getMainWindow: () => mainWindow });

  let config = loadConfig();
  logEvent('config:loaded', `dataDir=${config.dataDir} mode=${config.mode}`);

  /* ─── Client-mode boot ─────────────────────────────────────────
   * Client Macs have no local DB and no on-disk assets — the data
   * lives on the server. We skip initDb / registerImageProtocol /
   * registerIpc and install the RPC proxy + asset passthrough
   * instead. The renderer is unchanged: `window.api.products.list(...)`
   * still works, it just hops the network.
   */
  if (config.mode === 'client') {
    registerRendererProtocol(path.join(__dirname, '..', '..', 'dist-renderer'));
    registerClientImageProtocol(() => ({
      baseUrl: clientRuntime.baseUrl,
      authHeader: clientRuntime.authHeader,
    }));
    clientRuntime.registerClientProxies(loadConfig);
    logEvent('client:ready', `server=${config.clientServerUrl || '(unset)'}`);

    // CSP override for client mode: allow connect-src to the configured
    // server URL so the renderer's fetches (if any) work. The IPC proxy
    // does the heavy lifting; renderer fetches are only used for asset
    // protocol metadata. The asset bytes themselves come back through
    // `app-image://` so the renderer's CSP doesn't need to whitelist
    // the server origin for img-src — `app-image:` already does.
    if (!isDev) {
      const serverOrigin = (() => {
        try { return new URL(config.clientServerUrl).origin; } catch { return ''; }
      })();
      session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
        cb({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; " +
              "img-src 'self' app-image: data: blob:; " +
              "style-src 'self' 'unsafe-inline'; " +
              // v0.26.5: 'unsafe-eval' is required by @imgly's ONNX
              // backend. See the comment on the standalone-mode CSP
              // below for the full rationale.
              "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:; " +
              "worker-src 'self' blob:; " +
              // v0.49.33: added `https://staticimgly.com` to the
              // client-mode CSP allow-list. Without it, bg-removal on
              // client Macs blew up on first use with "Failed to fetch
              // dynamically imported module" — @imgly tries to pull the
              // ~80 MB ONNX model from staticimgly.com and the CSP
              // dropped the request silently. Standalone mode already
              // had this whitelisted (see the headers block below);
              // client mode was missing it because the policy was
              // hand-rolled separately. Both branches now whitelist
              // the same model host. After v0.49.33 the model
              // downloads + caches the same way it does in standalone
              // mode — first run pulls ~80 MB; subsequent launches are
              // offline.
              `connect-src 'self' ${serverOrigin} https://staticimgly.com app-image: data: blob:;`,
            ],
          },
        });
      });
    }

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    return;
  }

  /* ─── Standalone / server boot (DB + assets local) ─────────── */

  config = handleFirstLaunch(config);

  try {
    initDb(config.dataDir);
    logEvent('db:ready');
  } catch (err) {
    logEvent('db:error', err.stack || err.message);
  }

  registerImageProtocol(config.dataDir);
  registerRendererProtocol(path.join(__dirname, '..', '..', 'dist-renderer'));
  registerIpc({ getMainWindow: () => mainWindow });

  // v0.14.2: in server mode, boot the HTTP server after IPC handlers
  // have registered themselves in the registry. Don't block app startup
  // on it — if the port is taken, log and continue (the UI will show
  // "Server not running" and let the user pick a different port).
  if (config.mode === 'server') {
    const { bootServer } = require('./server');
    bootServer({ port: config.serverPort || 13180, dataDir: config.dataDir })
      .then((info) => {
        logEvent('server:listening', `port=${info.port} addresses=${info.addresses.map((a) => a.ip).join(',')}`);
      })
      .catch((err) => {
        logEvent('server:failed', err.message);
      });
  }

  // In packaged builds, override the renderer's CSP with a stricter header
  // that drops the dev-server escape hatches (`http://localhost:*`, `ws:`).
  // The relaxed meta-CSP in index.html still wins in dev (HMR needs the WS),
  // but in production this header takes precedence and blocks any chance of
  // accidental requests to localhost. Headers + meta combine via intersection
  // so prod is strictly tighter than dev.
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
            "img-src 'self' app-image: data: blob:; " +
            "style-src 'self' 'unsafe-inline'; " +
            // `blob:` in script-src is required by @imgly/background-removal:
            // ONNX Runtime spawns a worker from a Blob URL and then does
            // dynamic `import('blob:...')` for its WASM backend. Without
            // blob: here, the prod build fails with
            //   "Failed to create session: no available backend found.
            //    ERR: [wasm] TypeError: Failed to fetch dynamically imported
            //    module: blob:app://local/<uuid>"
            // (regression introduced when this header was added in v0.6.0.)
            //
            // v0.26.5: 'unsafe-eval' added. @imgly v1.5.x's ONNX backend
            // now also uses runtime JS code generation (new Function /
            // eval) — 'wasm-unsafe-eval' only covers WebAssembly.compile,
            // not JS code generation. Symptom without it: "Background
            // removal failed: Refused to evaluate a string as JavaScript
            // because 'unsafe-eval' is not an allowed source of script".
            // Safe in our context: contextIsolation: true and
            // nodeIntegration: false sandbox the renderer from Node;
            // the script-src origin allowlist still restricts WHERE
            // scripts can come from ('self' + blob: for the ONNX worker).
            "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:; " +
            "worker-src 'self' blob:; " +
            // v0.49.33: dropped `https://api.remove.bg` — the paid
            // bg-removal engine was removed. The only third-party host
            // in connect-src now is staticimgly.com (for the local
            // @imgly model download).
            "connect-src 'self' https://staticimgly.com app-image: data: blob:;",
          ],
        },
      });
    });
  }

  // Start AI queue runner. Reads config on each tick so settings changes
  // (API keys, concurrency) take effect without restarting the app.
  aiQueueRunner.start({
    getMainWindow: () => mainWindow,
    getConfig: () => loadConfig(),
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => logEvent('before-quit'));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
