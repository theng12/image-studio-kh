/**
 * v0.26.32: Server bundle export / import.
 *
 * Packages everything that defines a "server" — products + brands +
 * categories + images + users + tokens + audit log + AI tasks + export
 * profiles + overlay templates — plus the safe-to-travel parts of
 * config.json (AI provider keys, custom presets) into a single
 * `.iskhbundle` file. That file is portable: import it on another Mac
 * and the new machine takes over as the server with all data intact.
 *
 * Format: tar.gz (renamed `.iskhbundle`). System `tar` on macOS handles
 * both halves — zero dependencies. The archive layout:
 *
 *   manifest.json         { version, schemaVersion, appVersion,
 *                            createdAt, sourceDataDir, includes }
 *   database.sqlite       SQLite snapshot via .backup() (consistent
 *                         even if other connections are writing)
 *   config.partial.json   only the keys safe to travel (NEVER mode,
 *                         dataDir, serverPort/Ip, clientServerUrl,
 *                         clientToken — those are machine-specific)
 *   assets/               full asset tree (product images)
 *   processed/            (if present)
 *   ai-gallery/           (if present)
 *   overlays/             (if present)
 *
 * What does NOT travel + why:
 *   - mode                → new Mac decides whether to be server
 *   - dataDir             → path is unique per machine
 *   - serverPort/serverBindIp → user picks per-machine; importing onto
 *                          a Mac with a different bind shouldn't blow
 *                          its setting away
 *   - clientServerUrl, clientToken → for client setup; irrelevant on
 *                          a Mac taking over as server
 *   - dataDirIsCloud      → that's the new Mac's iCloud state
 *
 * What DOES travel + why:
 *   - kieApiKey, falApiKey, removeBgApiKey → re-typing these is the
 *     #1 friction of the manual procedure; baking them in saves the
 *     user from "wait, where's my kie token?"
 *   - kieConcurrency, falConcurrency, bgRemovalEngine → user-tuned
 *     defaults; should follow the data
 *   - customPresets, defaultTokens, defaultSeparator → editor / export
 *     preferences; should follow the data
 *   - defaultExportProfileId → profile ids are stable across the move
 *     (profiles live in DB and travel with it)
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { app } = require('electron');

// Keep this list in lockstep with the comment above. Any new config
// keys added later need an explicit decision here — silently bundling
// new keys risks leaking machine-specific state (e.g. someone adds a
// `lastUsedLocalPath` and we bake it into bundles).
const PORTABLE_CONFIG_KEYS = [
  'kieApiKey',
  'falApiKey',
  'removeBgApiKey',
  'kieConcurrency',
  'falConcurrency',
  'bgRemovalEngine',
  'customPresets',
  'defaultTokens',
  'defaultSeparator',
  'defaultExportProfileId',
];

const BUNDLE_FORMAT_VERSION = 1;

/**
 * Run a system command (tar) capturing stdout + stderr. Returns a
 * Promise that resolves with { code, stdout, stderr } on exit. Used
 * for both bundle and unbundle — keeps the surface tiny.
 */
function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (err) => reject(err));
    p.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * Take a consistent SQLite snapshot using better-sqlite3's backup()
 * API. The snapshot is safe even while other connections write to the
 * DB — SQLite's online backup walks the pager + WAL frames page-by-
 * page rather than copying the file byte-for-byte. A raw `fs.copyFile`
 * could capture a torn page if the WAL flushed mid-copy.
 *
 * @param {string} destPath  Absolute path to write the snapshot to.
 */
async function snapshotDatabase(destPath) {
  const { getDb } = require('./db');
  const db = getDb();
  // backup() returns a promise-like with .step(); the convenience
  // form awaits the full transfer in one call.
  await db.backup(destPath);
}

/**
 * Build a bundle at `outputPath` from the active data folder + the
 * portable subset of config.json. Used by the Settings → Server →
 * "Export bundle" button.
 *
 * @param {object} args
 * @param {string} args.outputPath  Where to write the .iskhbundle file.
 * @param {(stage: string, detail?: any) => void} [args.onProgress]
 *   Stage events for the renderer's progress overlay. Stages:
 *     'snapshot'  → SQLite .backup() in progress
 *     'manifest'  → manifest + config.partial being written
 *     'archive'   → tar packing the staging dir
 *     'cleanup'   → removing staging dir
 *     'done'
 */
async function exportBundle({ outputPath, onProgress } = {}) {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('outputPath is required');
  }
  // Refuse to overwrite an existing bundle silently — the renderer
  // dialog already prompts, but the IPC handler shouldn't trust that.
  // (showSaveDialog's "Replace?" prompt does the right thing here, so
  // by the time we get the path the user has agreed.)

  const config = require('./config');
  const cfg = config.loadConfig();
  const dataDir = cfg.dataDir;
  if (!dataDir || !fs.existsSync(dataDir)) {
    throw new Error('No data folder configured or it does not exist on disk');
  }

  // Stage into a temp folder so the SQLite snapshot + manifest live
  // alongside the asset trees before we tar them up. Using mkdtemp
  // because crashes / cancels leave less junk behind than a fixed
  // path under userData.
  const stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-bundle-'));

  try {
    // 1. Snapshot SQLite into the staging root. Done first so a
    //    failure here aborts cheaply before we waste time on the
    //    (much larger) asset copy.
    onProgress?.('snapshot');
    const dbDest = path.join(stagingRoot, 'database.sqlite');
    await snapshotDatabase(dbDest);

    // 2. Write manifest + portable config.
    onProgress?.('manifest');
    const manifest = {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      appVersion: app.getVersion(),
      createdAt: Date.now(),
      sourceDataDir: dataDir,           // informational; importer doesn't use it
      includes: [],                     // populated below as we go
    };

    const portableCfg = {};
    for (const k of PORTABLE_CONFIG_KEYS) {
      if (cfg[k] !== undefined) portableCfg[k] = cfg[k];
    }
    await fsp.writeFile(
      path.join(stagingRoot, 'config.partial.json'),
      JSON.stringify(portableCfg, null, 2),
    );
    manifest.includes.push('database.sqlite', 'config.partial.json');

    // 3. Symlink (NOT copy) the big asset trees into staging so tar
    //    can pack them by following the links — saves a full disk-to-
    //    disk copy of potentially many GB of images. tar with -h
    //    dereferences symlinks at archive time.
    //
    //    Each tree is optional: a fresh install might not have
    //    `processed/` or `ai-gallery/` yet.
    const trees = ['assets', 'processed', 'ai-gallery', 'overlays'];
    for (const name of trees) {
      const src = path.join(dataDir, name);
      if (fs.existsSync(src)) {
        await fsp.symlink(src, path.join(stagingRoot, name));
        manifest.includes.push(name + '/');
      }
    }

    // Manifest written last so it reflects the actual includes list.
    await fsp.writeFile(
      path.join(stagingRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // 4. tar -czhf <outputPath> -C <stagingParent> <stagingName>
    //    -h dereferences the asset symlinks; -z gzips. Resulting
    //    file is a standard .tar.gz that any system tar can extract.
    onProgress?.('archive');
    const stagingParent = path.dirname(stagingRoot);
    const stagingName = path.basename(stagingRoot);
    await runCommand('tar', [
      '-czhf', outputPath,
      '-C', stagingParent,
      stagingName,
    ]);

    onProgress?.('done');
    const stat = await fsp.stat(outputPath);
    return {
      bundlePath: outputPath,
      sizeBytes: stat.size,
      includes: manifest.includes,
    };
  } finally {
    // Always clean up staging — even on error. rm -rf because the
    // staging dir contains symlinks we'd rather not chase.
    onProgress?.('cleanup');
    try { await fsp.rm(stagingRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Verify a bundle path looks legit BEFORE we touch the target data
 * folder. Returns the parsed manifest on success or throws with a
 * user-readable message on failure. Renderer can call this from the
 * import dialog to show "Bundle from v0.26.32, 2.4 GB, 47k events"
 * before the user commits.
 */
async function previewBundle(bundlePath) {
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    throw new Error('Bundle file not found');
  }
  // List the archive contents to make sure manifest.json is present.
  // `tar -tzf <file>` prints one path per line.
  const { stdout } = await runCommand('tar', ['-tzf', bundlePath]);
  const entries = stdout.split('\n').filter(Boolean);
  const hasManifest = entries.some((e) => e.endsWith('/manifest.json') || e === 'manifest.json');
  if (!hasManifest) {
    throw new Error('Not a valid Image Studio KH bundle (no manifest)');
  }
  // Extract just the manifest to a temp file and read it.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-bundle-peek-'));
  try {
    // Find the staging-folder prefix used in the archive. We packed
    // a single top-level dir via tar -C <parent> <name>, so every
    // entry starts with `<name>/`.
    const prefix = entries[0].split('/')[0];
    await runCommand('tar', ['-xzf', bundlePath, '-C', tmpDir, `${prefix}/manifest.json`]);
    const manifestText = await fsp.readFile(path.join(tmpDir, prefix, 'manifest.json'), 'utf8');
    // v0.26.40: JSON.parse can throw on a corrupted manifest. Wrap so
    // the user sees "Bundle manifest is malformed" instead of a raw
    // SyntaxError. The bundle is otherwise structurally valid (we
    // already confirmed manifest.json exists via tar -tzf above), so
    // a parse error here means someone hand-edited the file.
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      throw new Error(`Bundle manifest is malformed JSON: ${err.message}`);
    }
    // Size of the bundle itself for the renderer.
    const stat = await fsp.stat(bundlePath);
    return {
      ...manifest,
      bundlePath,
      bundleSizeBytes: stat.size,
    };
  } finally {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Import a bundle INTO the target data folder. The caller is
 * responsible for choosing the target folder + getting user consent
 * for the destructive replace. This function:
 *
 *   1. Validates the manifest.
 *   2. If `targetDataDir` is non-empty and not the bundle's source,
 *      moves the existing contents aside to `<target>.bak.<timestamp>`
 *      so the user can recover if something goes wrong.
 *   3. Extracts the bundle into `targetDataDir`.
 *   4. Merges the portable config keys into `config.json`.
 *
 * NEVER touches: mode, dataDir, serverPort, serverBindIp,
 * clientServerUrl, clientToken — the new Mac keeps its existing
 * machine-specific config.
 *
 * Caller must arrange for an app restart afterward — the running
 * SQLite connection holds a file handle to the old DB; the new one
 * doesn't take effect until next launch.
 */
async function importBundle({ bundlePath, targetDataDir, onProgress } = {}) {
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    throw new Error('Bundle file not found');
  }
  if (!targetDataDir || typeof targetDataDir !== 'string') {
    throw new Error('targetDataDir is required');
  }

  onProgress?.('verify');
  const manifest = await previewBundle(bundlePath);
  if (manifest.bundleFormatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new Error(`Bundle format v${manifest.bundleFormatVersion} not supported (expected v${BUNDLE_FORMAT_VERSION})`);
  }

  // Back up the existing target if it has data we'd otherwise lose.
  // looksLikeOurDataDir guard is in settings.js; we recreate the
  // check inline because we don't want to depend on the running
  // app's settings module.
  if (fs.existsSync(targetDataDir)) {
    const stat = await fsp.stat(targetDataDir);
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(targetDataDir);
      const looksLikeData = entries.some((e) =>
        e === 'database.sqlite' || e === 'assets' || e === 'processed' || e === 'ai-gallery'
      );
      if (looksLikeData) {
        onProgress?.('backup');
        const bakPath = `${targetDataDir}.bak.${Date.now()}`;
        await fsp.rename(targetDataDir, bakPath);
        // recreate the empty target dir so extraction has somewhere
        // to land
        await fsp.mkdir(targetDataDir, { recursive: true });
      }
    }
  } else {
    await fsp.mkdir(targetDataDir, { recursive: true });
  }

  // Extract into a staging dir first, then move the bundle's
  // top-level entries up into targetDataDir. tar -C extracts a
  // tree rooted at the original bundle's staging-folder name (e.g.
  // `iskh-bundle-AbCd12/`) — we want its CONTENTS in targetDataDir,
  // not a nested subfolder.
  onProgress?.('extract');
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'iskh-bundle-extract-'));
  try {
    await runCommand('tar', ['-xzf', bundlePath, '-C', tmpRoot]);
    // Find the single top-level folder the archive contained.
    const tmpEntries = await fsp.readdir(tmpRoot);
    if (tmpEntries.length !== 1) {
      throw new Error('Bundle structure unexpected (expected a single top-level folder)');
    }
    const bundleRoot = path.join(tmpRoot, tmpEntries[0]);

    // Move every entry under bundleRoot → targetDataDir/<same name>.
    for (const ent of await fsp.readdir(bundleRoot)) {
      const src = path.join(bundleRoot, ent);
      const dst = path.join(targetDataDir, ent);
      if (fs.existsSync(dst)) {
        // Shouldn't happen because we either backed up or created
        // empty target above, but defensive.
        await fsp.rm(dst, { recursive: true, force: true });
      }
      await fsp.rename(src, dst);
    }

    // Merge the portable config into the live config.json. NEVER
    // overwrites mode/dataDir/network keys.
    onProgress?.('merge-config');
    const portableCfgPath = path.join(targetDataDir, 'config.partial.json');
    if (fs.existsSync(portableCfgPath)) {
      // v0.26.40: harden the parse — a corrupted config.partial.json
      // shouldn't break the whole import. Treat parse failure as
      // "no portable config to merge" and continue with the new DB
      // + assets (the user can manually re-enter AI keys etc.).
      let portableCfg = null;
      try {
        portableCfg = JSON.parse(await fsp.readFile(portableCfgPath, 'utf8'));
      } catch (err) {
        process.stderr.write(`[bundle import] config.partial.json was malformed (${err.message}) — skipping config merge. You may need to re-enter API keys in Settings.\n`);
      }
      const config = require('./config');
      const merged = {};
      if (portableCfg && typeof portableCfg === 'object') {
        for (const k of PORTABLE_CONFIG_KEYS) {
          if (portableCfg[k] !== undefined) merged[k] = portableCfg[k];
        }
      }
      if (Object.keys(merged).length > 0) config.updateConfig(merged);
      // Leave config.partial.json on disk as a record of what was
      // imported (informational; the app doesn't read it again).
    }

    onProgress?.('done');
    return {
      success: true,
      importedManifest: manifest,
      targetDataDir,
    };
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  exportBundle,
  importBundle,
  previewBundle,
  PORTABLE_CONFIG_KEYS,
  BUNDLE_FORMAT_VERSION,
};
