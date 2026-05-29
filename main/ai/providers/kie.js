/**
 * kie.ai provider. Dispatches between three endpoint families:
 *   - 'market'        → POST /api/v1/jobs/createTask         (newest models)
 *                       GET  /api/v1/jobs/recordInfo
 *   - 'gpt4o-image'   → POST /api/v1/gpt4o-image/generate    (legacy 4o image)
 *                       GET  /api/v1/gpt4o-image/record-info
 *   - 'flux-kontext'  → POST /api/v1/flux/kontext/generate   (legacy flux-kontext)
 *                       GET  /api/v1/flux/kontext/record-info
 *
 * File uploads always go through https://kieai.redpandaai.co/api/file-* —
 * generate endpoints take URLs, not bytes.
 *
 * Auth: `Authorization: Bearer <key>` + `Content-Type: application/json`.
 * See AI_INTEGRATION.md for the full reference.
 */

const fs = require('node:fs');
const path = require('node:path');
// v0.26.40: bounded fetches — every kie.ai call is wrapped with
// AbortSignal.timeout via fetchWithTimeout. Prevents the queue
// runner from hanging if kie's CDN or API endpoint stops
// responding mid-call. See main/ai/_fetchTimeouts.js.
const {
  fetchWithTimeout,
  TIMEOUT_SUBMIT, TIMEOUT_UPLOAD, TIMEOUT_POLL, TIMEOUT_HEALTH,
} = require('../_fetchTimeouts');

const API = 'https://api.kie.ai';
const FILE_API = 'https://kieai.redpandaai.co';

function authHeaders(apiKey, jsonBody = true) {
  const h = { Authorization: `Bearer ${apiKey}` };
  if (jsonBody) h['Content-Type'] = 'application/json';
  return h;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { _raw: text, _status: res.status }; }
}

function assertOk(body, hint) {
  if (body?.code === 200) return body;
  const msg = body?.msg || body?.message || body?._raw || 'Unknown error';
  throw new Error(`kie.ai ${hint}: ${msg}`);
}

/* ── Source upload ─────────────────────────────────────────── */

async function uploadSource(apiKey, { absPath, mimeType }) {
  let bytes;
  try {
    bytes = await fs.promises.readFile(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Source image missing');
    throw err;
  }
  const ext = (path.extname(absPath) || '.png').slice(1).toLowerCase();
  const fileName = `${Date.now()}-${path.basename(absPath)}`;

  if (bytes.length < 6 * 1024 * 1024) {
    const res = await fetchWithTimeout(`${FILE_API}/api/file-base64-upload`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        base64: bytes.toString('base64'),
        uploadPath: 'images',
        fileName,
      }),
    }, TIMEOUT_UPLOAD);
    const body = await readJson(res);
    if (res.ok && body?.code === 200) return { url: body.data.downloadUrl || body.data.fileUrl };
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType || `image/${ext}` }), fileName);
  form.append('uploadPath', 'images');
  form.append('fileName', fileName);
  const res2 = await fetchWithTimeout(`${FILE_API}/api/file-stream-upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  }, TIMEOUT_UPLOAD);
  const body2 = await readJson(res2);
  if (!res2.ok || body2?.code !== 200) {
    throw new Error(`kie.ai upload failed: ${body2?.msg || body2?._raw || res2.status}`);
  }
  return { url: body2.data.downloadUrl || body2.data.fileUrl };
}

/* ── Submit ────────────────────────────────────────────────── */

async function submit(apiKey, { model, prompt, sourceUrl, options = {} }) {
  // Newest: unified Market endpoint.
  if (model.kieKind === 'market') {
    const input = { prompt };
    if (model.supportsSource && sourceUrl) {
      const srcs = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];
      // Newer GPT Image-2 + Seedream + Flux-2 use `input_urls` / `image_urls`;
      // Nano Banana family uses `image_input`. Driven by model.sourceParam.
      input[model.sourceParam || 'input_urls'] = srcs;
    }
    if (options.size && options.size !== 'auto') input.aspect_ratio = options.size;
    else if (options.aspect_ratio) input.aspect_ratio = options.aspect_ratio;
    if (options.resolution) input.resolution = options.resolution;

    const res = await fetchWithTimeout(`${API}/api/v1/jobs/createTask`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ model: model.kieMarketModel, input }),
    }, TIMEOUT_SUBMIT);
    const data = assertOk(await readJson(res), `submit ${model.kieMarketModel}`);
    return { providerTaskId: data.data.taskId, raw: data };
  }

  // Legacy: per-endpoint families.
  if (model.kieKind === 'gpt4o-image' || model.key === 'kie:gpt4o-image') {
    const body = {
      prompt,
      size: options.size || '1:1',
      nVariants: options.nVariants || 1,
      isEnhance: !!options.isEnhance,
      enableFallback: !!options.enableFallback,
    };
    if (sourceUrl) body.filesUrl = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];
    if (options.maskUrl) body.maskUrl = options.maskUrl;
    const res = await fetchWithTimeout(`${API}/api/v1/gpt4o-image/generate`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    }, TIMEOUT_SUBMIT);
    const data = assertOk(await readJson(res), 'submit gpt4o-image');
    return { providerTaskId: data.data.taskId, raw: data };
  }

  if (model.kieKind === 'flux-kontext') {
    const body = {
      prompt,
      model: model.kieModelId,
      aspectRatio: options.size || options.aspectRatio || '1:1',
      outputFormat: options.outputFormat || 'png',
      promptUpsampling: !!options.promptUpsampling,
    };
    if (sourceUrl) body.inputImage = Array.isArray(sourceUrl) ? sourceUrl[0] : sourceUrl;
    const res = await fetchWithTimeout(`${API}/api/v1/flux/kontext/generate`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    }, TIMEOUT_SUBMIT);
    const data = assertOk(await readJson(res), 'submit flux-kontext');
    return { providerTaskId: data.data.taskId, raw: data };
  }

  throw new Error(`kie.ai: model ${model.key} not implemented`);
}

/* ── Poll ──────────────────────────────────────────────────── */

async function pollStatus(apiKey, { providerTaskId, model }) {
  if (model.kieKind === 'market') {
    const url = `${API}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`;
    const res = await fetchWithTimeout(url, { headers: authHeaders(apiKey, false) }, TIMEOUT_POLL);
    const body = await readJson(res);
    if (body?.code !== 200) {
      return { status: 'failed', error: body?.msg || body?._raw || 'poll failed' };
    }
    const d = body.data ?? {};
    const state = d.state;

    if (state === 'success') {
      // `resultJson` is *documented* as a JSON-encoded string like
      // `{"resultUrls":["..."]}` but in practice kie sometimes returns it
      // already parsed (an object), or the URLs may be exposed directly on
      // `data` (resultUrls / result_urls / urls). Be liberal in what we
      // accept.
      let urls = [];
      const rj = d.resultJson;
      try {
        const parsed = typeof rj === 'string' ? JSON.parse(rj || '{}') : (rj || {});
        urls = parsed.resultUrls || parsed.result_urls || parsed.urls || [];
      } catch { /* fall through to the data-level checks below */ }

      if (!Array.isArray(urls) || urls.length === 0) {
        if (Array.isArray(d.resultUrls))   urls = d.resultUrls;
        else if (Array.isArray(d.result_urls)) urls = d.result_urls;
        else if (Array.isArray(d.urls))    urls = d.urls;
        else if (typeof d.resultUrl === 'string') urls = [d.resultUrl];
      }

      if (!Array.isArray(urls) || urls.length === 0) {
        // Surface a snapshot of the response so the queue runner can log it
        // and we don't silently mark the task as Done-with-nothing.
        process.stderr.write(
          `[kie market] success state but no result URLs. raw=${JSON.stringify(d).slice(0, 600)}\n`,
        );
      }

      return { status: 'done', progress: 1, outputUrls: urls || [], raw: d };
    }
    if (state === 'fail') {
      return { status: 'failed', error: d.failMsg || d.failCode || 'Generation failed', raw: d };
    }
    // waiting / queuing / generating
    const progress = typeof d.progress === 'number' ? d.progress / 100 : (state === 'generating' ? 0.5 : 0.1);
    return { status: 'running', progress, raw: d };
  }

  // Legacy gpt4o-image: response with successFlag 0/1/2 and result_urls.
  if (model.kieKind === 'gpt4o-image' || model.key === 'kie:gpt4o-image') {
    const url = `${API}/api/v1/gpt4o-image/record-info?taskId=${encodeURIComponent(providerTaskId)}`;
    return parseLegacyPoll(url, apiKey);
  }

  // Legacy flux-kontext: same shape.
  if (model.kieKind === 'flux-kontext') {
    const url = `${API}/api/v1/flux/kontext/record-info?taskId=${encodeURIComponent(providerTaskId)}`;
    return parseLegacyPoll(url, apiKey);
  }

  throw new Error(`kie.ai: polling not implemented for ${model.key}`);
}

async function parseLegacyPoll(url, apiKey) {
  const res = await fetchWithTimeout(url, { headers: authHeaders(apiKey, false) }, TIMEOUT_POLL);
  const body = await readJson(res);
  if (body?.code !== 200) {
    return { status: 'failed', error: body?.msg || body?._raw || 'poll failed' };
  }
  const d = body.data ?? {};
  const flag = d.successFlag;
  const progress = d.progress ? parseFloat(d.progress) : null;
  if (flag === 1) {
    const urls = d.response?.result_urls ?? d.response?.resultUrls ?? [];
    return { status: 'done', progress: 1, outputUrls: urls, raw: d };
  }
  if (flag === 2) {
    return { status: 'failed', error: d.errorMessage || 'Generation failed', raw: d };
  }
  return { status: 'running', progress: progress ?? 0, raw: d };
}

/* ── Test connection ───────────────────────────────────────── */

async function testConnection(apiKey) {
  // Use the real account-credits endpoint as a health check. It's cheap,
  // returns the credit balance, and gives unambiguous 401 on a bad key.
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) throw new Error('API key is empty');
  const res = await fetchWithTimeout(`${API}/api/v1/chat/credit`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${trimmed}` },
  }, TIMEOUT_HEALTH);
  const body = await readJson(res);
  if (res.status === 401 || body?.code === 401) {
    throw new Error('Invalid API key (401)');
  }
  if (!res.ok || (body?.code != null && body.code !== 200)) {
    throw new Error(`kie.ai responded ${res.status}: ${body?.msg || body?._raw || 'unknown'}`);
  }
  const credits = typeof body?.data === 'number' ? body.data : null;
  return {
    ok: true,
    hint: credits != null ? `${credits} credits remaining` : 'reachable',
    credits,
  };
}

/**
 * Return the current credit balance (a single number per kie's API).
 * Returns null if the call fails — caller decides how to display the gap.
 */
async function getCredits(apiKey) {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) return null;
  try {
    const res = await fetchWithTimeout(`${API}/api/v1/chat/credit`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${trimmed}` },
    }, TIMEOUT_HEALTH);
    const body = await readJson(res);
    if (!res.ok || body?.code !== 200) return null;
    return typeof body.data === 'number' ? body.data : null;
  } catch { return null; }
}

module.exports = { uploadSource, submit, pollStatus, testConnection, getCredits };
