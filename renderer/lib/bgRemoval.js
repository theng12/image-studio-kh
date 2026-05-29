// Thin wrapper around background-removal engines. The rest of the renderer
// doesn't import the heavy WASM module directly — we lazy-load on first use
// so the initial app boot doesn't pay for the model download.
//
// Two engines are supported:
//   - 'local'    → @imgly/background-removal (WASM, offline after first run)
//   - 'removebg' → https://api.remove.bg paid cloud API (free 50 calls/month)
//
// Caller picks via the `engine` argument (defaulting to 'local'). The
// Workspace reads `bgRemovalEngine` from Settings and passes it through, so
// the toggle in Settings is now honored. (Before v0.8.2 it was dead — the
// renderer always ran the local engine.)

let enginePromise = null;
const cutoutCache = new Map(); // `${engine}::${filepath}` -> { blob, bytes }
const inFlight = new Map();    // same key -> Promise

function cacheKey(engine, filepath) { return `${engine}::${filepath}`; }

function loadLocalEngine() {
  if (!enginePromise) {
    enginePromise = import('@imgly/background-removal').then((m) => {
      const engine = m.removeBackground ?? m.default;
      if (typeof engine !== 'function') {
        throw new Error('Failed to load @imgly/background-removal — engine export not found');
      }
      return engine;
    });
  }
  return enginePromise;
}

/**
 * Generate a small but valid PNG via canvas. Used by prefetchLocalModel
 * to warm the @imgly engine cache without needing a user-supplied image.
 *
 * Pre-v0.22.12 we hand-rolled a 64-byte 1×1 PNG, but @imgly v1.5.x
 * tightened its input validation and started rejecting it with
 * "The source image could not be decoded." 64×64 is a comfortable
 * size — well above any internal min-size threshold, small enough
 * that the inference itself stays sub-second.
 *
 * Canvas-generated PNGs are guaranteed valid by the browser, so this
 * sidesteps every "is my hand-crafted PNG actually correct?" question
 * the next time @imgly tightens validation again.
 */
async function makeWarmupBlob() {
  const SIZE = 64;
  // OffscreenCanvas is broadly supported in Electron renderers; fall back
  // to a hidden DOM canvas if it isn't there for some reason.
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(SIZE, SIZE);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // A small dark dot in the center gives the model something
    // foreground-shaped to chew on — not strictly required, but makes
    // the warm-up exercise the actual segmentation path (not just the
    // "image is uniform → bail out fast" path).
    ctx.fillStyle = '#202020';
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 4, 0, Math.PI * 2);
    ctx.fill();
    return c.convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#202020';
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 4, 0, Math.PI * 2);
    ctx.fill();
    c.toBlob((b) => resolve(b), 'image/png');
  });
}

/**
 * Trigger the @imgly engine load + a small no-op inference so the WASM
 * runtime and model weights are cached. Used by the "Download model now"
 * button in Settings so the user isn't stuck waiting the first time they
 * open the Workspace.
 *
 * v0.22.12: switched the warm-up image from a hand-crafted 64-byte
 * 1×1 PNG to a canvas-generated 64×64 PNG because @imgly v1.5.x
 * rejected the tiny one with "The source image could not be decoded".
 * The model + WASM still cache the same way; only the input changed.
 */
export async function prefetchLocalModel(onProgress) {
  const engine = await loadLocalEngine();
  let blob;
  try {
    blob = await makeWarmupBlob();
  } catch (err) {
    throw new Error(`Failed to build warm-up image: ${err.message}`);
  }
  if (!blob) throw new Error('Failed to build warm-up image (canvas returned null)');
  try {
    await engine(blob, {
      output: { format: 'image/png' },
      progress: onProgress
        ? (key, current, total) => onProgress(key, total > 0 ? current / total : 0)
        : undefined,
    });
  } catch (err) {
    // Reuse the same friendly translator the workspace uses so users
    // get the actionable "switch to remove.bg" / "check internet" hints
    // instead of the raw "no available backend" / "publicPath" jargon.
    throw new Error(friendlyLocalEngineError(err));
  }
}

export async function fetchImageBlob(filepath) {
  const url = `app-image://local/${encodeURIComponent(filepath)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load image (${res.status})`);
  return res.blob();
}

async function removeViaLocal(filepath, onProgress) {
  const engine = await loadLocalEngine();
  const inputBlob = await fetchImageBlob(filepath);
  try {
    const outBlob = await engine(inputBlob, {
      output: { format: 'image/png' },
      progress: onProgress
        ? (key, current, total) => onProgress(key, total > 0 ? current / total : 0)
        : undefined,
    });
    const bytes = await outBlob.arrayBuffer();
    return { blob: outBlob, bytes };
  } catch (err) {
    throw new Error(friendlyLocalEngineError(err));
  }
}

/**
 * Translate the @imgly / ONNX-runtime error messages into something that
 * tells the user what to actually do. The raw messages reference internals
 * (publicPath, WASM backends, blob URLs) that mean nothing to a beta tester.
 */
function friendlyLocalEngineError(err) {
  const msg = err?.message ?? String(err);
  if (/no available backend|Failed to fetch dynamically imported module/i.test(msg)) {
    return (
      'Background-removal engine failed to start (ONNX WASM backend couldn\'t load). ' +
      'This is usually a Content-Security-Policy issue in the packaged build, ' +
      'or a network block fetching the model. If the problem persists, switch to ' +
      'remove.bg in the Workspace settings panel.'
    );
  }
  if (/Resource (.+) not found|publicPath is configured/i.test(msg)) {
    return (
      'Couldn\'t fetch the @imgly model assets. Check your internet connection — ' +
      'the first run pulls ~80MB from staticimgly.com. After that it\'s cached and offline.'
    );
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return (
      'Couldn\'t reach the @imgly model server. Check your internet — the first run ' +
      'needs to download ~80MB. Or switch to remove.bg in the Workspace settings panel.'
    );
  }
  // v0.22.12: @imgly v1.5.x rejects very small / unusual images with
  // "The source image could not be decoded." When the user hits this
  // from the Settings prefetch it means our warm-up image is bad
  // (fixed in v0.22.12). When they hit it from the Workspace it means
  // their product photo is in a format @imgly doesn't grok — usually
  // HEIC, AVIF, or an exotic CMYK JPEG.
  if (/could not be decoded|cannot be decoded|unsupported image format/i.test(msg)) {
    return (
      'The image couldn\'t be decoded by the background-removal engine. ' +
      '@imgly accepts PNG, JPEG, and WebP — try converting HEIC / AVIF / CMYK ' +
      'images first. If this is the warm-up running from Settings, you\'re on ' +
      'an older build; rebuild from v0.22.12 or later.'
    );
  }
  return `Background removal failed: ${msg}`;
}

async function removeViaRemoveBg(filepath, apiKey, onProgress) {
  if (!apiKey) {
    throw new Error('remove.bg API key is not set — open Settings → remove.bg API key to add one.');
  }
  onProgress?.('upload', 0);
  const inputBlob = await fetchImageBlob(filepath);
  const form = new FormData();
  form.append('image_file', inputBlob);
  form.append('size', 'auto');
  form.append('format', 'png');

  const res = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey },
    body: form,
  });
  if (!res.ok) {
    // The API returns JSON errors with `{ errors: [{ title }] }` on failure.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.errors?.[0]?.title) detail = body.errors[0].title;
    } catch { /* not JSON */ }
    throw new Error(`remove.bg failed: ${detail}`);
  }
  onProgress?.('download', 0.5);
  const outBlob = await res.blob();
  const bytes = await outBlob.arrayBuffer();
  // Best-effort usage counter bump so Settings shows the call.
  try { await window.api?.settings?.bumpRemoveBgUsage?.(); } catch { /* non-fatal */ }
  onProgress?.('done', 1);
  return { blob: outBlob, bytes };
}

/**
 * Run background removal on the image at `filepath` using the configured
 * engine. Returns the cutout as both a Blob (for display) and an
 * ArrayBuffer (for IPC).
 *
 * @param {string} filepath
 * @param {(stage: string, ratio: number) => void} [onProgress]
 * @param {object} [opts]
 * @param {'local' | 'removebg'} [opts.engine='local']
 * @param {string} [opts.apiKey] — required when engine === 'removebg'
 */
export async function removeBackground(filepath, onProgress, opts = {}) {
  const engine = opts.engine === 'removebg' ? 'removebg' : 'local';
  const key = cacheKey(engine, filepath);
  if (cutoutCache.has(key)) return cutoutCache.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const result = engine === 'removebg'
      ? await removeViaRemoveBg(filepath, opts.apiKey, onProgress)
      : await removeViaLocal(filepath, onProgress);
    cutoutCache.set(key, result);
    return result;
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

export function clearCutoutCache(filepath) {
  if (filepath) {
    for (const k of cutoutCache.keys()) {
      if (k.endsWith(`::${filepath}`)) cutoutCache.delete(k);
    }
  } else {
    cutoutCache.clear();
  }
}

export async function rawImageBytes(filepath) {
  const blob = await fetchImageBlob(filepath);
  return blob.arrayBuffer();
}
