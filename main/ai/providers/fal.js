/**
 * fal.ai provider via the queue API.
 *   Base:    https://queue.fal.run
 *   Storage: https://rest.alpha.fal.ai/storage/upload (multipart)
 *   Auth:    Authorization: Key <FAL_KEY>            (note: "Key", not "Bearer")
 * See AI_INTEGRATION.md for the reference.
 */

const fs = require('node:fs');
const path = require('node:path');
// v0.26.40: shared timeout helper. Every fetch in this file goes
// through fetchWithTimeout so a hung fal.ai endpoint can't freeze
// the queue runner forever. See main/ai/_fetchTimeouts.js for the
// timeout policy (different ceilings per operation type).
const {
  fetchWithTimeout,
  TIMEOUT_SUBMIT, TIMEOUT_UPLOAD, TIMEOUT_POLL, TIMEOUT_HEALTH,
} = require('../_fetchTimeouts');

const QUEUE = 'https://queue.fal.run';
const STORAGE = 'https://rest.alpha.fal.ai/storage/upload';

function authHeaders(apiKey, jsonBody = true) {
  const h = { Authorization: `Key ${apiKey}` };
  if (jsonBody) h['Content-Type'] = 'application/json';
  return h;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { _raw: text, _status: res.status }; }
}

/* ── Source upload ─────────────────────────────────────────── */

/**
 * For <= 4 MB images we send a base64 data URL inline (no upload round-trip).
 * Larger images go through fal's storage endpoint.
 */
async function uploadSource(apiKey, { absPath, mimeType }) {
  // Async fs so we don't block the event loop on a multi-MB read. The
  // missing-file branch maps the platform's ENOENT into a friendlier message.
  let bytes;
  try {
    bytes = await fs.promises.readFile(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Source image missing');
    throw err;
  }
  const ext = (path.extname(absPath) || '.png').slice(1).toLowerCase();
  const ct = mimeType || `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  if (bytes.length <= 4 * 1024 * 1024) {
    return { url: `data:${ct};base64,${bytes.toString('base64')}` };
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: ct }), path.basename(absPath));
  // v0.26.40: bounded by TIMEOUT_UPLOAD so a hung storage endpoint
  // doesn't freeze the queue runner.
  const res = await fetchWithTimeout(STORAGE, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}` },
    body: form,
  }, TIMEOUT_UPLOAD);
  const body = await readJson(res);
  if (!res.ok) throw new Error(`fal storage upload failed: ${body?._raw || body?.detail || res.status}`);
  // fal storage returns { url, ... } or { access_url } depending on endpoint version.
  const url = body.url || body.access_url || body.file_url;
  if (!url) throw new Error(`fal storage: no URL in response`);
  return { url };
}

/* ── Submit ────────────────────────────────────────────────── */

/**
 * Build the request body for the model and POST to queue.fal.run/<model-id>.
 */
async function submit(apiKey, { model, prompt, sourceUrl, options = {} }) {
  const body = { prompt, ...(model.extraInputs ?? {}) };

  // Map source param. Some models want an array, some a string.
  if (sourceUrl && model.supportsSource) {
    const src = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];
    if (model.sourceParam === 'image_urls') body.image_urls = src;
    else body.image_url = src[0];
  }

  // Generic optional parameters
  if (options.size && /^\d+x\d+$/.test(options.size)) {
    const [w, h] = options.size.split('x').map(Number);
    body.image_size = { width: w, height: h };
  } else if (options.size) {
    body.image_size = options.size;  // e.g. 'square_hd', 'portrait_4_3'
  }
  if (options.numImages && Number.isFinite(options.numImages)) {
    body.num_images = options.numImages;
  }
  if (options.seed != null) body.seed = options.seed;
  if (options.strength != null) body.strength = options.strength;
  if (options.guidanceScale != null) body.guidance_scale = options.guidanceScale;
  if (options.outputFormat) body.output_format = options.outputFormat;

  const url = `${QUEUE}/${model.key}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  }, TIMEOUT_SUBMIT);
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(`fal submit ${model.key}: ${data?.detail || data?._raw || res.status}`);
  }
  if (!data.request_id) {
    throw new Error(`fal submit ${model.key}: no request_id in response`);
  }
  return { providerTaskId: data.request_id, raw: data };
}

/* ── Poll ──────────────────────────────────────────────────── */

async function pollStatus(apiKey, { providerTaskId, model }) {
  const statusUrl = `${QUEUE}/${model.key}/requests/${providerTaskId}/status`;
  const res = await fetchWithTimeout(statusUrl, { headers: authHeaders(apiKey, false) }, TIMEOUT_POLL);
  const body = await readJson(res);
  if (!res.ok) {
    return { status: 'failed', error: body?.detail || body?._raw || `HTTP ${res.status}` };
  }
  const s = body.status;
  if (s === 'IN_QUEUE') return { status: 'running', progress: 0.05, raw: body };
  if (s === 'IN_PROGRESS') return { status: 'running', progress: 0.5, raw: body };
  if (s === 'COMPLETED') {
    if (body.error) {
      return { status: 'failed', error: body.error, raw: body };
    }
    // Fetch the response payload — uses POLL ceiling, it's a small
    // metadata fetch (URLs only, not image bytes).
    const resp = await fetchWithTimeout(`${QUEUE}/${model.key}/requests/${providerTaskId}`, {
      headers: authHeaders(apiKey, false),
    }, TIMEOUT_POLL);
    const data = await readJson(resp);
    const images = data.images || data.image || [];
    const arr = Array.isArray(images) ? images : [images];
    const urls = arr.map((i) => (typeof i === 'string' ? i : i?.url)).filter(Boolean);
    return { status: 'done', progress: 1, outputUrls: urls, raw: data };
  }
  return { status: 'failed', error: `unexpected status: ${s}`, raw: body };
}

/* ── Test connection ───────────────────────────────────────── */

/**
 * fal.ai doesn't have a single documented health endpoint. We hit a known
 * model's status endpoint with a bogus request_id and accept "not found" /
 * "validation" responses as proof the key is accepted. 401 means bad key.
 */
async function testConnection(apiKey) {
  // v0.26.47: probe endpoint switched from `fal-ai/flux/schnell`
  // (removed from our catalog) to `fal-ai/nano-banana/edit`, which
  // is still in the dropdown. fal.ai still hosts flux/schnell so
  // the old probe would work, but using a current model keeps the
  // probe consistent with what users can actually pick.
  const probe = `${QUEUE}/fal-ai/nano-banana/edit/requests/00000000-0000-0000-0000-000000000000/status`;
  const res = await fetchWithTimeout(probe, { headers: authHeaders(apiKey, false) }, TIMEOUT_HEALTH);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Invalid API key (${res.status})`);
  }
  return { ok: true, hint: `reachable (HTTP ${res.status})` };
}

/**
 * Read balance from fal's Platform API. Needs an "admin" key — the same
 * fal key may or may not have this scope depending on how it was created.
 * If the call fails (403/permission, network), return null so the UI shows
 * a dash instead of throwing.
 */
async function getCredits(apiKey) {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) return null;
  try {
    const res = await fetchWithTimeout('https://api.fal.ai/v1/account/billing?expand=credits', {
      method: 'GET',
      headers: { Authorization: `Key ${trimmed}` },
    }, TIMEOUT_HEALTH);
    if (!res.ok) return null;
    const body = await readJson(res);
    const balance = body?.credits?.current_balance;
    const currency = body?.credits?.currency || 'USD';
    if (typeof balance !== 'number') return null;
    return { balance, currency };
  } catch { return null; }
}

module.exports = { uploadSource, submit, pollStatus, testConnection, getCredits };
