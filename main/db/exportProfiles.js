const crypto = require('node:crypto');
const { getDb } = require('./index');

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    marketplace: row.marketplace,
    width: row.width,
    height: row.height,
    format: row.format,
    quality: row.quality,
    backgroundColor: row.background_color,
    colorProfile: row.color_profile,
    namingPattern: row.naming_pattern,
    outputSubfolder: row.output_subfolder,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list(companyId) {
  if (!companyId) return [];
  return getDb()
    .prepare(`SELECT * FROM export_profiles WHERE company_id = ? ORDER BY created_at ASC`)
    .all(companyId)
    .map(rowToProfile);
}

function get(id) {
  return rowToProfile(
    getDb().prepare(`SELECT * FROM export_profiles WHERE id = ?`).get(id),
  );
}

function create(input) {
  if (!input?.companyId) throw new Error('companyId is required');
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('Profile name is required');

  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO export_profiles (
         id, company_id, name, marketplace, width, height, format, quality,
         background_color, color_profile, naming_pattern, output_subfolder,
         created_at, updated_at
       ) VALUES (
         @id, @companyId, @name, @marketplace, @width, @height, @format, @quality,
         @backgroundColor, @colorProfile, @namingPattern, @outputSubfolder,
         @createdAt, @updatedAt
       )`,
    )
    .run({
      id,
      companyId:       input.companyId,
      name,
      marketplace:     input.marketplace ?? null,
      width:           Math.round(Number(input.width)  || 2000),
      height:          Math.round(Number(input.height) || 2000),
      format:          input.format ?? 'jpg',
      quality:         input.quality == null ? 88 : Math.round(input.quality),
      backgroundColor: input.backgroundColor ?? '#FFFFFF',
      colorProfile:    input.colorProfile ?? 'sRGB',
      namingPattern:   input.namingPattern ?? '{SKU}-{INDEX}',
      outputSubfolder: input.outputSubfolder ?? null,
      createdAt:       ts,
      updatedAt:       ts,
    });
  return get(id);
}

const UPDATABLE = {
  name:            { col: 'name' },
  marketplace:     { col: 'marketplace' },
  width:           { col: 'width',   transform: (v) => Math.round(Number(v) || 0) },
  height:          { col: 'height',  transform: (v) => Math.round(Number(v) || 0) },
  format:          { col: 'format' },
  quality:         { col: 'quality', transform: (v) => v == null ? null : Math.round(Number(v)) },
  backgroundColor: { col: 'background_color' },
  colorProfile:    { col: 'color_profile' },
  namingPattern:   { col: 'naming_pattern' },
  outputSubfolder: { col: 'output_subfolder' },
};

function update(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error('Profile not found');
  const sets = [];
  const params = { id, updatedAt: Date.now() };
  for (const [key, def] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    sets.push(`${def.col} = @${key}`);
    params[key] = def.transform ? def.transform(patch[key]) : patch[key] ?? null;
  }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updatedAt');
  getDb().prepare(`UPDATE export_profiles SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

function remove(id) {
  return getDb().prepare(`DELETE FROM export_profiles WHERE id = ?`).run(id).changes > 0;
}

function duplicate(id) {
  const existing = get(id);
  if (!existing) throw new Error('Profile not found');
  return create({
    ...existing,
    name: `${existing.name} (copy)`,
  });
}

module.exports = { list, get, create, update, remove, duplicate };
