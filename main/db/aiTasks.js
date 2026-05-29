const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson } = require('./_util');

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    productId: row.product_id,
    sourceImagePath: row.source_image_path,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    options: parseJson(row.raw_options, {}),
    status: row.status,
    progress: row.progress ?? 0,
    attempts: row.attempts ?? 0,
    providerTaskId: row.provider_task_id,
    providerSourceUrl: row.provider_source_url,
    errorMessage: row.error_message,
    costEstimate: row.cost_estimate,
    galleryCount: row.gallery_count ?? 0,
    promotedCount: row.promoted_count ?? 0,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function create(input) {
  if (!input?.companyId) throw new Error('companyId is required');
  if (!input?.provider) throw new Error('provider is required');
  if (!input?.model) throw new Error('model is required');
  if (!input?.prompt) throw new Error('prompt is required');

  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO ai_tasks (
        id, company_id, product_id, source_image_path, provider, model, prompt,
        raw_options, status, progress, attempts, cost_estimate, created_at
      ) VALUES (
        @id, @companyId, @productId, @sourceImagePath, @provider, @model, @prompt,
        @rawOptions, @status, 0, 0, @costEstimate, @createdAt
      )`,
    )
    .run({
      id,
      companyId:       input.companyId,
      productId:       input.productId ?? null,
      sourceImagePath: input.sourceImagePath ?? null,
      provider:        input.provider,
      model:           input.model,
      prompt:          input.prompt,
      rawOptions:      JSON.stringify(input.options ?? {}),
      status:          input.status ?? 'queued',
      costEstimate:    input.costEstimate ?? null,
      createdAt:       ts,
    });
  return get(id);
}

// `promoted_count` is a subset of `gallery_count` — how many of the
// generated images have been pushed onto the parent product (vs still
// living only in the AI gallery). Surfaced in the queue UI so the user
// can see at a glance which tasks they've already triaged.
const WITH_GALLERY_COUNT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM ai_gallery g WHERE g.task_id = t.id) AS gallery_count,
    (SELECT COUNT(*) FROM ai_gallery g WHERE g.task_id = t.id AND g.promoted_to_product = 1) AS promoted_count
  FROM ai_tasks t
`;

function get(id) {
  return rowToTask(getDb().prepare(`${WITH_GALLERY_COUNT} WHERE t.id = ?`).get(id));
}

const UPDATABLE = {
  status:             { col: 'status' },
  progress:           { col: 'progress', t: (v) => Number(v) || 0 },
  attempts:           { col: 'attempts', t: (v) => Math.max(0, Math.round(Number(v) || 0)) },
  providerTaskId:     { col: 'provider_task_id' },
  providerSourceUrl:  { col: 'provider_source_url' },
  errorMessage:       { col: 'error_message' },
  startedAt:          { col: 'started_at' },
  completedAt:        { col: 'completed_at' },
};

function update(id, patch) {
  const sets = [];
  const params = { id };
  for (const [k, def] of Object.entries(UPDATABLE)) {
    if (!(k in patch)) continue;
    sets.push(`${def.col} = @${k}`);
    params[k] = def.t ? def.t(patch[k]) : (patch[k] ?? null);
  }
  if (sets.length === 0) return get(id);
  getDb().prepare(`UPDATE ai_tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

function listByCompany(companyId, { limit = 200, statuses } = {}) {
  if (!companyId) return [];
  let sql = `${WITH_GALLERY_COUNT} WHERE t.company_id = ?`;
  const params = [companyId];
  if (Array.isArray(statuses) && statuses.length > 0) {
    sql += ` AND t.status IN (${statuses.map(() => '?').join(', ')})`;
    params.push(...statuses);
  }
  sql += ` ORDER BY t.created_at DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params).map(rowToTask);
}

function listPendingForRunner() {
  return getDb()
    .prepare(
      `${WITH_GALLERY_COUNT}
       WHERE t.status IN ('queued', 'running')
       ORDER BY t.created_at ASC`,
    )
    .all()
    .map(rowToTask);
}

function remove(id) {
  return getDb().prepare(`DELETE FROM ai_tasks WHERE id = ?`).run(id).changes > 0;
}

module.exports = { create, get, update, listByCompany, listPendingForRunner, remove };
