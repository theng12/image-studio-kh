const crypto = require('node:crypto');
const { getDb } = require('./index');

function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    body: row.body,
    isFavorite: !!row.is_favorite,
    useCount: row.use_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list(companyId) {
  if (!companyId) return [];
  return getDb()
    .prepare(
      `SELECT * FROM ai_prompt_templates
       WHERE company_id = ?
       ORDER BY is_favorite DESC, use_count DESC, name COLLATE NOCASE`,
    )
    .all(companyId)
    .map(rowToTemplate);
}

function get(id) {
  return rowToTemplate(getDb().prepare(`SELECT * FROM ai_prompt_templates WHERE id = ?`).get(id));
}

function create({ companyId, name, body, isFavorite }) {
  if (!companyId) throw new Error('companyId is required');
  const trimmedName = (name ?? '').trim();
  const trimmedBody = (body ?? '').trim();
  if (!trimmedName) throw new Error('Template name is required');
  if (!trimmedBody) throw new Error('Template body is required');

  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO ai_prompt_templates (id, company_id, name, body, is_favorite, use_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(id, companyId, trimmedName, trimmedBody, isFavorite ? 1 : 0, ts, ts);
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('Template not found');
  const sets = [];
  const params = { id, updatedAt: Date.now() };
  if ('name' in patch && patch.name?.trim()) { sets.push('name = @name'); params.name = patch.name.trim(); }
  if ('body' in patch && patch.body?.trim()) { sets.push('body = @body'); params.body = patch.body.trim(); }
  if ('isFavorite' in patch) { sets.push('is_favorite = @fav'); params.fav = patch.isFavorite ? 1 : 0; }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updatedAt');
  getDb().prepare(`UPDATE ai_prompt_templates SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

function bumpUseCount(id) {
  getDb()
    .prepare(`UPDATE ai_prompt_templates SET use_count = use_count + 1 WHERE id = ?`)
    .run(id);
}

function remove(id) {
  return getDb().prepare(`DELETE FROM ai_prompt_templates WHERE id = ?`).run(id).changes > 0;
}

module.exports = { list, get, create, update, remove, bumpUseCount };
