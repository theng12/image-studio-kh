const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_FILE = 'config.json';

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

/**
 * Default data folder. Until v0.5.0 we used ~/Library/Application Support/...
 * — fine for the SQLite database but wrong place for user-facing image
 * files. New installs now default to ~/Pictures so the assets are easy to
 * find in Finder. Existing installs keep whatever path they wrote into
 * config.json (no auto-migration — Settings has a Change folder flow).
 *
 * The legacy path is still exposed (legacyDataDir) so we can detect existing
 * installs and avoid clobbering their data.
 */
function defaultDataDir() {
  return path.join(os.homedir(), 'Pictures', 'Image Studio KH');
}

function legacyDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function defaultConfig() {
  return {
    dataDir: defaultDataDir(),
    // v0.49.31: where local backups (.iskhbackup) are written. null →
    // <dataDir>/backups. The user can repoint this at an external drive
    // from Settings → Backups. Machine-specific (NOT bundled / restored).
    backupsDir: null,
    firstLaunchHandled: false,
    defaultExportFolder: null,
    defaultExportProfileId: null,
    // v0.49.33: removed `bgRemovalEngine`, `removeBgApiKey`, and
    // `removeBgUsage` — the paid remove.bg cloud engine was dropped,
    // leaving only the local @imgly WASM engine. Old configs that
    // still have these keys are harmless; we just ignore them.
    defaultSeparator: '-',     // '-' | '_' | ''
    defaultTokens: ['SKU', 'INDEX'],
    theme: 'light',            // 'light' | 'dark' | 'system'
    customPresets: [],         // [{ id, name, width, height, format, colorProfile }]

    // AI Studio
    kieApiKey: null,
    falApiKey: null,
    kieConcurrency: 3,         // 1–10
    falConcurrency: 3,         // 1–10
    // v0.26.47: default bumped from `fal-ai/flux-pro/kontext` (removed
    // from catalog) to GPT Image-2 — the best-quality option in the
    // current dropdown. Existing installs that have a saved
    // aiDefaultModel pointing at the old flux key will fall back to
    // the first available model via the renderer's snap-to-valid
    // guard in modules/AIStudio/index.jsx.
    aiDefaultModel: 'kie:gpt-image-2-image-to-image',
    aiSuggestionProvider: 'kie', // 'kie' | 'fal' — for prompt suggestions
    aiUsage: {                 // monthly counters, reset on month rollover
      month: monthKey(),
      kieCalls: 0,
      falCalls: 0,
    },

    /* ─── v0.14.0: multi-Mac server mode foundation ─────────────────
     * `mode` determines how the app runs:
     *   - standalone (default): single-user, this Mac only. DB + assets
     *     are local. No network exposure. The behavior every install
     *     has had until now.
     *   - server: this Mac hosts the data. Boots an HTTP server (wired
     *     in v0.14.1) on `serverPort` so other Macs can connect. The
     *     local app still works normally — server mode is additive.
     *   - client: this Mac doesn't open a local DB. Instead it talks
     *     to a remote server (wired in v0.14.2) using `clientServerUrl`
     *     + `clientToken` for auth.
     *
     * Mode changes are restart-required (the boot path differs sharply
     * between standalone/server and client). */
    mode: 'standalone',                 // 'standalone' | 'server' | 'client'
    serverPort: 13180,                  // server mode: HTTP port to bind
    // v0.34.0: when in server mode, also serve the lightweight mobile/iPad
    // web viewer at GET /m (view + search + add-photo). Default on; the
    // server checks this per-request so toggling takes effect immediately.
    webViewerEnabled: true,
    clientServerUrl: '',                // client mode: e.g. 'http://100.64.0.5:13180'
    clientToken: '',                    // client mode: user token from server admin
    clientUserName: '',                 // client mode: cached display name
  };
}

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    ensureDir(cfg.dataDir);
    return cfg;
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const cfg = { ...defaultConfig(), ...parsed };
    ensureDir(cfg.dataDir);
    return cfg;
  } catch (err) {
    process.stderr.write(`[config] parse error: ${err.message}; using defaults\n`);
    const cfg = defaultConfig();
    ensureDir(cfg.dataDir);
    return cfg;
  }
}

function saveConfig(cfg) {
  const p = configPath();
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return cfg;
}

function updateConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  return saveConfig(next);
}

module.exports = {
  loadConfig,
  saveConfig,
  updateConfig,
  configPath,
  defaultDataDir,
  legacyDataDir,
};
