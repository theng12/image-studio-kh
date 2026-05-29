/**
 * Overlay Studio — image template CRUD.
 *
 * Templates are global (no company scoping) so the same layout can be
 * applied across companies and brands. Each template stores its design
 * canvas dimensions plus an `elements` JSON blob — see templateRenderer.js
 * for the element schema.
 *
 * Mutation funcs return the full row so the renderer can refresh local
 * state without a follow-up `get()` call.
 */
const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson } = require('./_util');

function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    canvasWidth: Number(row.canvas_width),
    canvasHeight: Number(row.canvas_height),
    elements: parseJson(row.elements, []),
    // v0.27.0: bulk-inset config { enabled, scale, fillMode, fillColor }.
    // Null/absent for legacy templates → treated as disabled by compose().
    inset: parseJson(row.inset, null),
    thumbnailPath: row.thumbnail_path,
    tags: parseJson(row.tags, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function newId() { return crypto.randomUUID(); }

/** Coerce an inset config to a safe, stored shape (or null = disabled). */
function normalizeInset(v) {
  if (v == null || typeof v !== 'object') return null;
  const scale = Math.max(0.3, Math.min(1, Number(v.scale ?? 0.85) || 0.85));
  const fillMode = v.fillMode === 'blur' ? 'blur' : 'color';
  const fillColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.fillColor || '')
    ? String(v.fillColor)
    : '#FFFFFF';
  return { enabled: !!v.enabled, scale, fillMode, fillColor };
}

function list({ search } = {}) {
  let sql = `SELECT * FROM image_templates`;
  const params = [];
  if (search && search.trim()) {
    sql += ` WHERE name LIKE ? OR description LIKE ? OR tags LIKE ?`;
    const term = `%${search.trim()}%`;
    params.push(term, term, term);
  }
  sql += ` ORDER BY updated_at DESC`;
  return getDb().prepare(sql).all(...params).map(rowToTemplate);
}

function get(id) {
  if (!id) return null;
  const row = getDb().prepare(`SELECT * FROM image_templates WHERE id = ?`).get(id);
  return rowToTemplate(row);
}

function create(input) {
  const name = (input?.name ?? '').trim();
  if (!name) throw new Error('Template name is required');
  const canvasWidth  = Math.max(64, Math.min(8192, Math.round(Number(input?.canvasWidth)  || 2000)));
  const canvasHeight = Math.max(64, Math.min(8192, Math.round(Number(input?.canvasHeight) || 2000)));
  const id = newId();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO image_templates
        (id, name, description, canvas_width, canvas_height, elements, inset, thumbnail_path, tags, created_at, updated_at)
       VALUES
        (@id, @name, @description, @canvasWidth, @canvasHeight, @elements, @inset, @thumbnailPath, @tags, @createdAt, @updatedAt)`,
    )
    .run({
      id,
      name,
      description: input?.description ?? null,
      canvasWidth,
      canvasHeight,
      elements: JSON.stringify(Array.isArray(input?.elements) ? input.elements : []),
      inset: JSON.stringify(normalizeInset(input?.inset)),
      thumbnailPath: input?.thumbnailPath ?? null,
      tags: JSON.stringify(Array.isArray(input?.tags) ? input.tags : []),
      createdAt: ts,
      updatedAt: ts,
    });
  return get(id);
}

const UPDATABLE = {
  name:           { col: 'name',           t: (v) => String(v ?? '').trim() },
  description:    { col: 'description',    t: (v) => (v == null ? null : String(v)) },
  canvasWidth:    { col: 'canvas_width',   t: (v) => Math.max(64, Math.min(8192, Math.round(Number(v) || 2000))) },
  canvasHeight:   { col: 'canvas_height',  t: (v) => Math.max(64, Math.min(8192, Math.round(Number(v) || 2000))) },
  elements:       { col: 'elements',       t: (v) => JSON.stringify(Array.isArray(v) ? v : []) },
  inset:          { col: 'inset',          t: (v) => JSON.stringify(normalizeInset(v)) },
  thumbnailPath:  { col: 'thumbnail_path', t: (v) => (v == null ? null : String(v)) },
  tags:           { col: 'tags',           t: (v) => JSON.stringify(Array.isArray(v) ? v : []) },
};

function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('Template not found');
  const sets = [];
  const params = { id, updatedAt: Date.now() };
  for (const [k, def] of Object.entries(UPDATABLE)) {
    if (!(k in patch)) continue;
    sets.push(`${def.col} = @${k}`);
    params[k] = def.t(patch[k]);
  }
  if (sets.length === 0) return existing;
  sets.push(`updated_at = @updatedAt`);
  getDb().prepare(`UPDATE image_templates SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

function remove(id) {
  return getDb().prepare(`DELETE FROM image_templates WHERE id = ?`).run(id).changes > 0;
}

/**
 * Clone — handy for the "duplicate" affordance in the UI. New template
 * lands at the top of the list (fresh updated_at). Name gets " (copy)"
 * suffix unless the caller overrides via `nameSuffix`.
 */
function duplicate(id, { nameSuffix = ' (copy)' } = {}) {
  const src = get(id);
  if (!src) throw new Error('Template not found');
  return create({
    ...src,
    name: `${src.name}${nameSuffix}`,
    thumbnailPath: null,  // regenerate on first preview render
  });
}

module.exports = { list, get, create, update, remove, duplicate };
