/**
 * AI queue runner. Lives in the main process. Owns:
 *  - Concurrency control per provider
 *  - Polling each running task and updating progress
 *  - Auto-retry (up to 3 attempts, exponential backoff)
 *  - Downloading outputs to <dataDir>/ai-gallery/<sku>/
 *  - Emitting `ai:taskUpdate` events to the renderer so the UI stays live
 *
 * The runner is awakened by ticks (every 2 s) and by `nudge()` from IPC
 * (whenever a new task is enqueued or settings change).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const aiTasks = require('../db/aiTasks');
const aiGallery = require('../db/aiGallery');
const products = require('../db/products');
const { getDataDir } = require('../db');
const { slugify } = require('../util/slug');
const { byKey: modelByKey } = require('./models');
const kie = require('./providers/kie');
const fal = require('./providers/fal');

const TICK_MS = 2000;

let ctx = null;     // { getMainWindow, getConfig }
let timer = null;
let running = false;

/* in-memory per-provider counters of currently in-flight tasks */
const inflightByProvider = { kie: new Set(), fal: new Set() };

function provider(name) {
  return name === 'kie' ? kie : name === 'fal' ? fal : null;
}

// v0.15.1: route AI events through the shared broadcast bus so they
// fan out to WebSocket clients in addition to the local renderer.
const { broadcast } = require('../events');

function emitTaskUpdate(task) {
  broadcast('ai:taskUpdate', task);
}

function emitGalleryAdded(entry) {
  broadcast('ai:galleryAdded', entry);
}

function getCfg() {
  try { return ctx?.getConfig?.() ?? {}; } catch { return {}; }
}

function concurrencyLimit(name) {
  const cfg = getCfg();
  const v = name === 'kie' ? cfg.kieConcurrency : cfg.falConcurrency;
  return Math.max(1, Math.min(10, Number(v) || 3));
}

function apiKeyFor(name) {
  const cfg = getCfg();
  return name === 'kie' ? cfg.kieApiKey : cfg.falApiKey;
}

/* ── Tick loop ─────────────────────────────────────────────── */

async function tick() {
  if (running) return;            // single tick at a time
  running = true;
  let hasWork = false;
  try {
    const pending = aiTasks.listPendingForRunner();
    // Early-exit when nothing is queued or in flight — skip both inner loops.
    // The interval keeps ticking in the background; this just avoids the
    // wasted iterations when there's literally no work for the runner.
    if (pending.length === 0) return;
    hasWork = true;

    // Advance running tasks (poll provider for status).
    for (const t of pending) {
      if (t.status !== 'running') continue;
      if (!inflightByProvider[t.provider]?.has(t.id)) {
        // Resumed after restart — mark as inflight and re-poll.
        inflightByProvider[t.provider]?.add(t.id);
      }
      await pollOne(t);
    }

    // Start queued tasks subject to per-provider concurrency limits.
    for (const t of pending) {
      if (t.status !== 'queued') continue;
      const live = inflightByProvider[t.provider]?.size ?? 0;
      if (live >= concurrencyLimit(t.provider)) continue;
      await startOne(t);
    }
  } catch (err) {
    process.stderr.write(`[ai/queue] tick error: ${err.message}\n`);
  } finally {
    running = false;
  }
  // Hint: nothing observable changes here — the early-exit is purely a
  // micro-perf win. The interval keeps the runner alive for the next nudge.
  void hasWork;
}

/* ── Start one task ────────────────────────────────────────── */

async function startOne(task) {
  // v0.26.11: be lenient about the `task.model` field. The catalog's
  // primary key is `<provider>:<modelName>` (e.g. `kie:gpt-image-2-image-to-image`)
  // and all writers should store the full key. But the v0.22.0 bulk-from-
  // Library path used to strip the prefix and persist only the tail,
  // leaving older queue rows that fail forever on retry. So we first try
  // the field as-is, then try the prefixed form if a provider is set.
  let model = modelByKey(task.model);
  if (!model && task.provider && !String(task.model || '').includes(':')) {
    model = modelByKey(`${task.provider}:${task.model}`);
  }
  if (!model) {
    aiTasks.update(task.id, { status: 'failed', errorMessage: `Unknown model ${task.model}`, completedAt: Date.now() });
    emitTaskUpdate(aiTasks.get(task.id));
    return;
  }

  const apiKey = apiKeyFor(task.provider);
  if (!apiKey) {
    aiTasks.update(task.id, { status: 'failed', errorMessage: `${task.provider} API key not configured`, completedAt: Date.now() });
    emitTaskUpdate(aiTasks.get(task.id));
    return;
  }

  // Reserve the concurrency slot synchronously, *then* persist the running
  // state. The two need to be paired: if the DB write throws (file lock,
  // etc.) we have to release the slot or it leaks forever and starves the
  // provider — every subsequent tick would see live=limit and refuse to
  // start any new task.
  inflightByProvider[task.provider]?.add(task.id);
  try {
    aiTasks.update(task.id, {
      status: 'running',
      attempts: (task.attempts ?? 0) + 1,
      startedAt: task.startedAt ?? Date.now(),
      errorMessage: null,
    });
  } catch (err) {
    inflightByProvider[task.provider]?.delete(task.id);
    process.stderr.write(`[ai/queue] failed to mark task ${task.id} running: ${err.message}\n`);
    return;
  }
  emitTaskUpdate(aiTasks.get(task.id));

  try {
    // 1. Upload source image (if any) once per task — reuse on retries.
    let sourceUrl = task.providerSourceUrl;
    if (model.supportsSource && task.sourceImagePath && !sourceUrl) {
      const srcAbs = absForRelative(task.sourceImagePath);
      if (!srcAbs) throw new Error(`Source image missing on disk: ${task.sourceImagePath}`);
      // v0.49.16: pass the model so the provider can opt out of the inline-
      // data-URL shortcut for endpoints that require fetchable HTTPS URLs
      // (notably fal-ai/gpt-image-2/edit-image).
      const up = await provider(task.provider).uploadSource(apiKey, { absPath: srcAbs, model });
      sourceUrl = up.url;
      aiTasks.update(task.id, { providerSourceUrl: sourceUrl });
    }

    // 2. Submit to provider.
    const { providerTaskId } = await provider(task.provider).submit(apiKey, {
      model,
      prompt: task.prompt,
      sourceUrl,
      options: task.options ?? {},
    });
    aiTasks.update(task.id, { providerTaskId, progress: 0.05 });
    emitTaskUpdate(aiTasks.get(task.id));
  } catch (err) {
    inflightByProvider[task.provider]?.delete(task.id);
    handleFailure(task, err.message);
  }
}

/* ── Poll one task ─────────────────────────────────────────── */

async function pollOne(task) {
  const model = modelByKey(task.model);
  const apiKey = apiKeyFor(task.provider);
  if (!model || !apiKey || !task.providerTaskId) return;

  try {
    const res = await provider(task.provider).pollStatus(apiKey, {
      providerTaskId: task.providerTaskId,
      model,
    });
    if (res.status === 'running') {
      if (typeof res.progress === 'number' && Math.abs((task.progress ?? 0) - res.progress) > 0.01) {
        aiTasks.update(task.id, { progress: res.progress });
        emitTaskUpdate(aiTasks.get(task.id));
      }
      return;
    }
    if (res.status === 'done') {
      await onDone(task, res.outputUrls ?? []);
      return;
    }
    if (res.status === 'failed') {
      inflightByProvider[task.provider]?.delete(task.id);
      handleFailure(task, res.error || 'Provider returned failure');
    }
  } catch (err) {
    inflightByProvider[task.provider]?.delete(task.id);
    handleFailure(task, err.message);
  }
}

/* ── Done: download outputs, file in gallery ──────────────── */

async function onDone(task, outputUrls) {
  // Empty outputs after a "success" poll is a provider-side weirdness that
  // would otherwise vanish silently. Surface it as a Failed task so the user
  // sees something actionable instead of "Done" with nothing in the gallery.
  if (!Array.isArray(outputUrls) || outputUrls.length === 0) {
    inflightByProvider[task.provider]?.delete(task.id);
    aiTasks.update(task.id, {
      status: 'failed',
      errorMessage: 'Provider reported success but returned no image URLs. Check the provider dashboard (kie.ai/logs or fal.ai) for the actual output, then Retry.',
      completedAt: Date.now(),
    });
    emitTaskUpdate(aiTasks.get(task.id));
    return;
  }

  try {
    const product = task.productId ? products.get(task.productId) : null;
    // For per-product tasks, outputs land in `ai-gallery/<sku>/`. For
    // bulk-mode tasks (no productId), they go in `ai-gallery/_bulk/<yyyymmdd>/`
    // so the dir is browseable in Finder, scoped by date, and clearly
    // separate from per-product results. v0.11.0.
    let relativeDir;
    if (product) {
      const skuSlug = slugify(product.sku || 'unassigned', 'unassigned');
      relativeDir = `ai-gallery/${skuSlug}`;
    } else {
      const d = new Date();
      const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      relativeDir = `ai-gallery/_bulk/${yyyymmdd}`;
    }
    const galleryDir = path.join(getDataDir(), relativeDir);
    await fs.promises.mkdir(galleryDir, { recursive: true });

    /* v0.11.5: bulk-mode output naming + optional external export.
       - Naming: when the task has a sourceImagePath (always true for bulk
         mode), derive the output basename from the source file so the
         user can match results to inputs at a glance. Per-product mode
         keeps the existing `<task.id>-<n>.<ext>` naming since the source
         filename there is a content-addressed asset (`<sku>.jpg`), not
         a meaningful user-chosen name.
       - exportDir: if `task.options.exportDir` is an absolute path, also
         write a copy of each output there. The internal gallery copy
         remains so favorite/promote/preview still work; the external
         copy is purely a user-facing convenience. Failures to write to
         exportDir are non-fatal (logged but don't fail the task). */
    const exportDir = (!product && typeof task.options?.exportDir === 'string' && path.isAbsolute(task.options.exportDir))
      ? task.options.exportDir
      : null;
    if (exportDir) {
      try { await fs.promises.mkdir(exportDir, { recursive: true }); }
      catch (err) { process.stderr.write(`[ai/queue] mkdir exportDir failed: ${err.message}\n`); }
    }

    // Pre-compute the source basename for bulk tasks. `sourceImagePath` is
    // a relative path like `ai-source/cat.jpg`; we want `cat`.
    const sourceBasename = (!product && task.sourceImagePath)
      ? path.basename(task.sourceImagePath, path.extname(task.sourceImagePath))
      : null;

    // v0.26.40: bounded by TIMEOUT_DOWNLOAD (60s) so a hung CDN
    // doesn't freeze the runner mid-fan-out. Image bytes can be many
    // MB so we use the most generous ceiling — but it's still
    // bounded, unlike the bare fetch this replaced.
    const { fetchWithTimeout, TIMEOUT_DOWNLOAD } = require('./_fetchTimeouts');
    let i = 0;
    for (const url of outputUrls) {
      i += 1;
      try {
        const res = await fetchWithTimeout(url, {}, TIMEOUT_DOWNLOAD);
        if (!res.ok) throw new Error(`download ${url} failed (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = guessExt(res.headers.get('content-type'), url);

        // Pick a non-colliding filename inside galleryDir.
        let name;
        if (sourceBasename) {
          // Bulk: prefer `<sourceBasename>.ext`, then `-2`, `-3`, ... for
          // collisions (re-running the same image, multi-variant returns).
          const suffix = outputUrls.length > 1 ? `-${i}` : '';
          name = `${sourceBasename}${suffix}${ext}`;
          let n = 2;
          while (fs.existsSync(path.join(galleryDir, name))) {
            name = `${sourceBasename}${suffix}-${n}${ext}`;
            n += 1;
            if (n > 9999) break; // sanity bound
          }
        } else {
          name = `${task.id}-${i}${ext}`;
        }

        const abs = path.join(galleryDir, name);
        await fs.promises.writeFile(abs, buf);
        const relative = `${relativeDir}/${name}`;
        const entry = aiGallery.create({
          taskId: task.id,
          productId: task.productId ?? null,
          companyId: task.companyId,
          filepath: relative,
          prompt: task.prompt,
          provider: task.provider,
          model: task.model,
        });
        emitGalleryAdded(entry);

        // v0.22.0: auto-promote first successful variant. Set when
        // the task was created via `ai:queueBulkForProducts` with
        // `autoPromoteAsMain: true`. We promote only the FIRST
        // output of each task so multi-variant runs don't keep
        // stomping the main image — the rest stay in the gallery
        // as alternates the user can flip to later.
        //
        // v0.26.12: the gate used to read `i === 0` — DEAD CODE.
        // `i` is incremented at the top of the for-loop above
        // (`i += 1` runs before this block), so it's 1 on the
        // first iteration and never 0. The gate was unreachable
        // from v0.22.0 → v0.26.11, which is why bulk-from-Library
        // tasks never replaced the product's main image even with
        // the checkbox ticked. Fix: check `i === 1` to match the
        // 1-indexed counter the loop now uses (also used by the
        // `-1, -2, -3` filename suffixes for multi-variant runs).
        //
        // Guarded:
        //   - must have a productId (no orphan auto-promotes)
        //   - i must be 1 (first variant only)
        //   - failures are logged + swallowed so a broken promote
        //     doesn't crash the whole queue runner; the gallery
        //     entry is already recorded so the user can promote
        //     manually if needed.
        // v0.26.22: two distinct auto-attach modes. `autoPromoteAsMain`
        // (existing): add to product AND move to position 0 — original
        // demotes to position 1. `autoAddToProduct` (new): add to
        // product at the END of the image list, original images
        // untouched. Promote-as-main implies add, so we check it
        // first; if it's off we fall through to the add-only path.
        // Both share the gallery-link / recompute / touch / broadcast
        // tail because the user-visible side effects are the same.
        const wantPromote = !!task.options?.autoPromoteAsMain;
        const wantAdd     = wantPromote || !!task.options?.autoAddToProduct;
        // v0.48.0: split the gate. Promote-as-main MUST be first-variant-only
        // so multi-variant runs don't repeatedly stomp the main image. Plain
        // auto-add wants ALL variants saved as images on the product — every
        // alternate becomes a real image the user can keep, set as main, or
        // delete from the regular gallery. The mobile AI flow uses pure
        // auto-add, which is why this gate matters now.
        const variantEligible = wantPromote ? (i === 1) : true;
        if (variantEligible && wantAdd && task.productId) {
          try {
            const productImages = require('../db/productImages');
            const products = require('../db/products');
            const { image: addedImage } = await productImages.addFromSource(task.productId, abs, {
              originalFilepath: abs,
            });
            const relativePath = addedImage?.filepath;
            if (wantPromote && relativePath) {
              productImages.setMain(task.productId, relativePath);
            }
            aiGallery.markPromoted(entry.id);
            products.recomputeProcessStatus(task.productId);
            // v0.26.21: bump product.updated_at so the Library grid +
            // table thumbs cache-bust. Without this the grid kept
            // showing the OLD main image's pixels (browser cache) until
            // a second mutation forced updated_at to change. Same fix
            // pattern as v0.22.8's images:setMainImage IPC.
            products.touchUpdated(task.productId);
            const events = require('../events');
            events.broadcast('catalog:changed', { kind: 'images', op: wantPromote ? 'promote' : 'add', id: task.productId });
            events.broadcast('catalog:changed', { kind: 'aiGallery', op: 'promote', id: entry.id, productId: task.productId });
          } catch (err) {
            process.stderr.write(`[ai/queue] auto-${wantPromote ? 'promote' : 'add'} failed for task ${task.id}: ${err.message}\n`);
          }
        }

        // Best-effort copy to the user's export folder. Same filename
        // rules as the gallery copy, with its own collision suffix.
        if (exportDir) {
          try {
            let externalName = name;
            let n = 2;
            while (fs.existsSync(path.join(exportDir, externalName))) {
              const parsed = path.parse(name);
              externalName = `${parsed.name}-${n}${parsed.ext}`;
              n += 1;
              if (n > 9999) break;
            }
            await fs.promises.copyFile(abs, path.join(exportDir, externalName));
          } catch (err) {
            process.stderr.write(`[ai/queue] export copy failed for ${name}: ${err.message}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`[ai/queue] download failed for task ${task.id}: ${err.message}\n`);
      }
    }

    inflightByProvider[task.provider]?.delete(task.id);
    aiTasks.update(task.id, {
      status: 'done',
      progress: 1,
      completedAt: Date.now(),
      errorMessage: null,
    });
    emitTaskUpdate(aiTasks.get(task.id));
  } catch (err) {
    inflightByProvider[task.provider]?.delete(task.id);
    handleFailure(task, err.message);
  }
}

/* ── Failure ─────────────────────────────────────────────────
 * No automatic retries. The user kicks recovery off explicitly via Repair.
 */

function handleFailure(task, message) {
  const current = aiTasks.get(task.id);
  if (!current) return;
  aiTasks.update(task.id, {
    status: 'failed',
    errorMessage: message,
    completedAt: Date.now(),
  });
  emitTaskUpdate(aiTasks.get(task.id));
}

/* ── Utilities ─────────────────────────────────────────────── */

function absForRelative(relative) {
  if (!relative) return null;
  const root = getDataDir();
  let abs;
  if (relative.startsWith('processed/') || relative.startsWith('ai-gallery/')) {
    abs = path.join(root, relative);
  } else {
    abs = path.join(root, 'assets', relative);
  }
  return fs.existsSync(abs) ? abs : null;
}

function guessExt(contentType, url) {
  if (contentType?.includes('jpeg')) return '.jpg';
  if (contentType?.includes('png'))  return '.png';
  if (contentType?.includes('webp')) return '.webp';
  const m = url.match(/\.(jpe?g|png|webp)(\?|$)/i);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return '.png';
}

/* ── Public API ────────────────────────────────────────────── */

function start(_ctx) {
  ctx = _ctx;
  if (timer) clearInterval(timer);
  // Boot sweep: any tasks left in 'running' without a provider task id were
  // interrupted (process killed mid-submit). Mark them failed so Repair has
  // a clear place to start from. Tasks with provider_task_id stay 'running'
  // and the tick loop will re-poll them.
  interruptStaleTasks();
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 100);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function nudge() {
  setTimeout(tick, 50);
}

function interruptStaleTasks() {
  try {
    const all = aiTasks.listPendingForRunner();
    const now = Date.now();
    for (const t of all) {
      if (t.status === 'running' && !t.providerTaskId) {
        aiTasks.update(t.id, {
          status: 'failed',
          errorMessage: 'Interrupted before the provider received it. Click Repair to retry, or Queue fresh to start over.',
          completedAt: now,
        });
        emitTaskUpdate(aiTasks.get(t.id));
      }
    }
  } catch (err) {
    process.stderr.write(`[ai/queue] interruptStaleTasks error: ${err.message}\n`);
  }
}

/**
 * Repair: try to recover the result from the provider. Used for tasks that
 * ended up failed, cancelled, or Done-without-gallery. Behavior:
 *   - If we have a providerTaskId, mark the task running and let the tick
 *     loop poll the provider. If the provider returns success with image
 *     URLs we download them; if it returns no URLs / expired / not-found we
 *     mark failed with a clearer "result unavailable" message so the user
 *     knows to Queue fresh.
 *   - If there's no providerTaskId, just re-queue: the task never reached
 *     the provider, so a fresh submission is the only path.
 */
function repair(taskId) {
  const t = aiTasks.get(taskId);
  if (!t) return null;
  inflightByProvider[t.provider]?.delete(t.id);

  if (t.providerTaskId) {
    aiTasks.update(taskId, {
      status: 'running',
      errorMessage: null,
      progress: 0.1,
    });
    inflightByProvider[t.provider]?.add(t.id);
  } else {
    aiTasks.update(taskId, {
      status: 'queued',
      progress: 0,
      errorMessage: null,
    });
  }
  emitTaskUpdate(aiTasks.get(taskId));
  nudge();
  return aiTasks.get(taskId);
}

/**
 * Queue fresh: clone the task as a brand-new queued task. Used when Repair
 * has determined the original result is gone (expired / not-found).
 */
function queueFresh(taskId) {
  const t = aiTasks.get(taskId);
  if (!t) return null;
  const fresh = aiTasks.create({
    companyId: t.companyId,
    productId: t.productId,
    sourceImagePath: t.sourceImagePath,
    provider: t.provider,
    model: t.model,
    prompt: t.prompt,
    options: t.options,
    status: 'queued',
    costEstimate: t.costEstimate,
  });
  emitTaskUpdate(fresh);
  nudge();
  return fresh;
}

function cancel(taskId) {
  const t = aiTasks.get(taskId);
  if (!t) return null;
  inflightByProvider[t.provider]?.delete(t.id);
  aiTasks.update(taskId, { status: 'cancelled', completedAt: Date.now() });
  emitTaskUpdate(aiTasks.get(taskId));
  return aiTasks.get(taskId);
}

module.exports = { start, stop, nudge, repair, queueFresh, cancel };
