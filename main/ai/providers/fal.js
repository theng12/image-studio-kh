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
// v0.49.22: fal\'s legacy single-POST `/storage/upload` endpoint returned 404
// "Not Found" — it was retired in favour of the two-step initiate → presigned-
// PUT pattern. STORAGE_HOST is the REST base; the actual paths get appended in
// uploadSource().
const STORAGE_HOST = 'https://rest.alpha.fal.ai';

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
async function uploadSource(apiKey, { absPath, mimeType, model }) {
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

  // v0.49.16: some fal endpoints (notably fal-ai/gpt-image-2/edit-image)
  // reject inline data URLs in `image_urls` — they require fetchable HTTPS
  // URLs from fal storage. Models opt in via `model.requiresFalStorage`.
  // Otherwise we keep the data-URL shortcut for small images: skips a
  // round-trip and works fine for most fal models (nano-banana, seedream, …).
  const forceStorage = !!model?.requiresFalStorage;
  if (!forceStorage && bytes.length <= 4 * 1024 * 1024) {
    return { url: `data:${ct};base64,${bytes.toString('base64')}` };
  }

  // v0.49.22: two-step upload. The legacy single-POST `/storage/upload`
  // endpoint (used through v0.49.21) was retired by fal — it returns 404
  // "Not Found". Current flow:
  //   1. POST `${HOST}/storage/upload/initiate` with JSON {content_type, file_name}
  //      → response { upload_url, file_url }
  //   2. PUT raw bytes to `upload_url` with Content-Type matching the body
  //   3. Use `file_url` as the publicly-fetchable URL passed to the model.
  // Source: fal-client (python + node) reference implementations as of 2025.
  const fileName = path.basename(absPath);
  const initRes = await fetchWithTimeout(`${STORAGE_HOST}/storage/upload/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify({ content_type: ct, file_name: fileName }),
  }, TIMEOUT_UPLOAD);
  const initBody = await readJson(initRes);
  if (!initRes.ok) {
    throw new Error(`fal storage initiate failed: ${initBody?._raw || initBody?.detail || initRes.status}`);
  }
  const uploadUrl = initBody.upload_url;
  const fileUrl   = initBody.file_url;
  if (!uploadUrl || !fileUrl) {
    throw new Error('fal storage initiate: missing upload_url / file_url in response');
  }
  const putRes = await fetchWithTimeout(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': ct },
    body: bytes,
  }, TIMEOUT_UPLOAD);
  if (!putRes.ok) {
    const putBody = await readJson(putRes);
    throw new Error(`fal storage put failed: ${putBody?._raw || putBody?.detail || putRes.status}`);
  }
  return { url: fileUrl };
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

  // v0.49.26: fal\'s actual error message from the dashboard for a 422 was:
  //   "Input should be 'square_hd', 'square', 'portrait_4_3', 'portrait_16_9',
  //    'landscape_4_3', 'landscape_16_9' or 'auto'"
  // So fal\'s `image_size` expects their GENERIC FAL ENUM strings — NOT
  // OpenAI\'s pixel dimensions ("1024x1024" etc) like v0.49.25 was sending.
  // The pricing-matrix sizes (1024×1024, 1024×768, …) are OUTPUT dims that
  // fal derives from the enum value internally; you don\'t set them directly.
  // v0.49.16 → v0.49.25 had the wrong shape; this is the corrected mapping.
  function gptImage2Size(s) {
    if (!s || s === 'auto') return 'auto';
    if (s === '1:1')   return 'square_hd';      // 1024×1024 output
    if (s === '4:3')   return 'landscape_4_3';  // landscape orientation
    if (s === '3:4')   return 'portrait_4_3';
    if (s === '16:9')  return 'landscape_16_9';
    if (s === '9:16')  return 'portrait_16_9';
    return null; // unsupported; default to auto
  }
  // v0.49.25: detect BOTH the legacy `fal-ai/gpt-image-2/*` and the new
  // `openai/gpt-image-2/*` endpoints (same model, different namespace at fal).
  const isGptImage2 = /^(fal-ai|openai)\/gpt-image-2\b/.test(model.key);

  // Generic optional parameters
  if (options.size) {
    if (isGptImage2) {
      const mapped = gptImage2Size(options.size);
      if (mapped && mapped !== 'auto') body.image_size = mapped;
      // omit when 'auto' — fal\'s schema defaults image_size to "auto".
    } else if (/^\d+x\d+$/.test(options.size)) {
      const [w, h] = options.size.split('x').map(Number);
      body.image_size = { width: w, height: h };
    } else {
      body.image_size = options.size;  // e.g. 'square_hd', 'portrait_4_3'
    }
  }
  // v0.49.25: pass through `quality` for GPT Image-2 endpoints. Skip "auto"
  // (that\'s the server default; sending it is harmless but noisy in logs).
  if (isGptImage2 && options.quality && options.quality !== 'auto') {
    body.quality = options.quality;
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

// v0.49.27: empirically `queue.fal.run` only accepts POST on the status +
// result endpoints; `Allow: POST` in the response header confirms this.
// fal-js client routes through `fal.run` (the unified host) which DOES
// accept GET, which is why their source uses GET — but on `queue.fal.run`
// we must POST. This helper tries POST first, then falls back to GET so
// our code stays correct if fal flips it again.
async function falQueueRequest(url, apiKey, label) {
  // Primary: POST (current `queue.fal.run` behaviour as of v0.49.23+).
  let res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: authHeaders(apiKey, true),
    body: '{}',
  }, TIMEOUT_POLL);
  if (res.status === 405) {
    // Fal might flip back to GET-only at some point. Try once.
    process.stderr.write(`[ai/fal] ${label}: POST returned 405; retrying GET\n`);
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: authHeaders(apiKey, false),
    }, TIMEOUT_POLL);
  }
  return res;
}

// v0.49.27: read JSON but ALSO keep the raw body text on failure so the
// caller can surface "what the server actually returned" in the error
// message. Truncated to 500 chars in the error to avoid log floods.
async function readJsonWithRaw(res) {
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
  return { parsed, text };
}

// v0.49.27: extract image URLs from fal\'s response. The standard shape is
// `{images: [{url, ...}]}` per the llms.txt for `openai/gpt-image-2/edit`,
// but historical fal endpoints have used `{image: {url}}`, `{output_url}`,
// and `{images: ['https://...']}`. Try each shape and emit a stderr log
// when we fall through to a non-standard one so we notice schema drift.
function extractFalImageUrls(data, taskLabel) {
  if (!data || typeof data !== 'object') return [];
  // Most common: { images: [{url, content_type, ...}, ...] }
  if (Array.isArray(data.images) && data.images.length) {
    return data.images.map((i) => (typeof i === 'string' ? i : i?.url)).filter(Boolean);
  }
  // Some single-image models use the singular form.
  if (data.image) {
    const arr = Array.isArray(data.image) ? data.image : [data.image];
    const urls = arr.map((i) => (typeof i === 'string' ? i : i?.url)).filter(Boolean);
    if (urls.length) { process.stderr.write(`[ai/fal] ${taskLabel}: used singular image[] path\n`); return urls; }
  }
  // Some older fal models put the URL at the top level.
  if (typeof data.output_url === 'string') {
    process.stderr.write(`[ai/fal] ${taskLabel}: used data.output_url\n`);
    return [data.output_url];
  }
  // Some wrap everything in `data` (rare; surfaced via streaming).
  if (data.data && typeof data.data === 'object') {
    const inner = extractFalImageUrls(data.data, `${taskLabel} (data wrapper)`);
    if (inner.length) return inner;
  }
  return [];
}

async function pollStatus(apiKey, { providerTaskId, model }) {
  const taskLabel = `${model.key}/${providerTaskId.slice(0, 8)}`;
  const statusUrl = `${QUEUE}/${model.key}/requests/${providerTaskId}/status`;
  const res = await falQueueRequest(statusUrl, apiKey, `status ${taskLabel}`);
  const { parsed: body, text: rawStatus } = await readJsonWithRaw(res);
  if (!res.ok) {
    // Surface fal\'s actual response so users (and us) don\'t have to guess.
    const detail = body?.detail || rawStatus?.slice(0, 200) || `HTTP ${res.status}`;
    process.stderr.write(`[ai/fal] status ${taskLabel} failed: ${detail}\n`);
    return { status: 'failed', error: `status ${res.status}: ${detail}` };
  }
  const s = body?.status;
  if (s === 'IN_QUEUE')    return { status: 'running', progress: 0.05, raw: body };
  if (s === 'IN_PROGRESS') return { status: 'running', progress: 0.5,  raw: body };
  if (s === 'COMPLETED') {
    if (body.error) return { status: 'failed', error: body.error, raw: body };
    // Fetch the response payload at the request id (no /status suffix).
    const resultUrl = `${QUEUE}/${model.key}/requests/${providerTaskId}`;
    const resp = await falQueueRequest(resultUrl, apiKey, `result ${taskLabel}`);
    const { parsed: data, text: rawResult } = await readJsonWithRaw(resp);
    if (!resp.ok) {
      const detail = data?.detail || rawResult?.slice(0, 200) || `HTTP ${resp.status}`;
      process.stderr.write(`[ai/fal] result ${taskLabel} failed: ${detail}\n`);
      return { status: 'failed', error: `result ${resp.status}: ${detail}`, raw: data };
    }
    const urls = extractFalImageUrls(data, taskLabel);
    if (!urls.length) {
      // Log the raw shape so we can spot a future schema change quickly.
      process.stderr.write(`[ai/fal] result ${taskLabel} parsed but had no URLs. Raw body: ${rawResult?.slice(0, 300)}\n`);
    }
    return { status: 'done', progress: 1, outputUrls: urls, raw: data };
  }
  // Unknown status — could be a new state (CANCELLED? FAILED?) we don\'t recognise.
  return { status: 'failed', error: `unexpected fal status: ${s}`, raw: body };
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
  // v0.49.23: POST not GET (see pollStatus). The empty-body POST still
  // gets through the auth check, so 401 still discriminates good vs bad keys.
  const probe = `${QUEUE}/fal-ai/nano-banana/edit/requests/00000000-0000-0000-0000-000000000000/status`;
  const res = await fetchWithTimeout(probe, {
    method: 'POST',
    headers: authHeaders(apiKey, true),
    body: '{}',
  }, TIMEOUT_HEALTH);
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
