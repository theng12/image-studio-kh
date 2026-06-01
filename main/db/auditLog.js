/**
 * v0.22.6: audit_log — durable, queryable history of every mutation.
 *
 * Why a separate table (not just trusting the `updated_*` columns)?
 * The existing `updated_by_user_id` + `updated_at` only tell you who
 * touched a row LAST. The user asked for an "audit trail" — i.e. who
 * did what, when, going back through the row's whole life. That can't
 * be reconstructed from current-state columns alone, so we accumulate
 * an immutable per-event log.
 *
 * Shape (defined in main/db/index.js):
 *   id          PK
 *   entity_type 'product' | 'brand' | 'category' | 'image' | 'company' | …
 *   entity_id   product/brand/category id, OR product_id for image events
 *               (so a product's History modal also catches image-grid edits)
 *   user_id     caller's user id, or NULL for server-admin / standalone
 *   action      short verb: 'create' | 'update' | 'delete' | 'bulk-update' |
 *               'image:add' | 'image:remove' | 'image:set-main' | 'image:reorder'
 *   before_json JSON of changed keys' old values (updates) OR full snapshot (deletes)
 *   after_json  JSON of changed keys' new values (updates) OR full snapshot (creates)
 *   created_at  epoch ms
 *
 * The `before`/`after` payloads are deliberately tiny for updates: ONLY
 * the keys that actually changed. A 30-field product edit where the user
 * just retitled one field stores one key on each side. That keeps the
 * SQLite file from growing pathologically on heavy editing days.
 *
 * No retention policy yet. SQLite handles tens of millions of rows fine
 * — at ~150 bytes per audit row, 1M edits is ~150MB. If we ever need a
 * retention sweep, do it from a background job at app boot.
 */

const { getDb } = require('./index');
const { parseJson, getCallerUserId } = require('./_util');

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    userId: row.user_id,
    action: row.action,
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    createdAt: row.created_at,
  };
}

/**
 * Diff two flat objects and return ONLY the keys whose values differ.
 * Returns `{ before, after }` — `before` carries the old values for the
 * changed keys, `after` the new. Returns null if no keys changed (caller
 * uses that to skip logging a no-op update).
 *
 * - Compares with strict equality after JSON-normalizing nested values,
 *   so `{ prices: { retail: 10 } }` vs `{ prices: { retail: 10 } }` is
 *   treated as unchanged.
 * - `before` is the row as it existed BEFORE the patch was applied;
 *   `patch` is whatever keys the caller passed. We diff only the keys
 *   in `patch` to avoid recording unrelated drift (timestamps etc.).
 */
function diffPatch(before, patch) {
  if (!patch || typeof patch !== 'object') return null;
  const b = {};
  const a = {};
  let changed = false;
  for (const key of Object.keys(patch)) {
    // Skip computed / housekeeping fields that the caller may include
    // but that aren't user-meaningful for the audit log.
    if (key === 'updatedAt' || key === 'updatedByUserId' || key === 'expectedUpdatedAt') continue;
    const beforeVal = before?.[key];
    const afterVal = patch[key];
    const sameByValue =
      beforeVal === afterVal ||
      JSON.stringify(beforeVal ?? null) === JSON.stringify(afterVal ?? null);
    if (sameByValue) continue;
    b[key] = beforeVal ?? null;
    a[key] = afterVal;
    changed = true;
  }
  return changed ? { before: b, after: a } : null;
}

/**
 * Write one log entry. Caller passes the user id explicitly when known
 * (e.g. queueRunner calls happen outside an RPC, so getCallerUserId()
 * returns null but the originating user is stored on the task). Most
 * call sites can omit it and we'll fall back to getCallerUserId().
 *
 * Safe to call inside an existing better-sqlite3 transaction — the
 * single-row INSERT is fast and the surrounding txn keeps it atomic
 * with the actual mutation.
 *
 * Returns the auto-incremented id of the new row.
 */
function log({ entityType, entityId, action, before, after, userId }) {
  if (!entityType || !action) {
    // Audit logging shouldn't break the calling write; just bail.
    return null;
  }
  const db = getDb();
  const uid = userId !== undefined ? userId : getCallerUserId();
  try {
    const info = db
      .prepare(`
        INSERT INTO audit_log (entity_type, entity_id, user_id, action, before_json, after_json, created_at)
        VALUES (@entityType, @entityId, @userId, @action, @beforeJson, @afterJson, @createdAt)
      `)
      .run({
        entityType,
        entityId: entityId ?? null,
        userId: uid ?? null,
        action,
        beforeJson: before == null ? null : JSON.stringify(before),
        afterJson: after == null ? null : JSON.stringify(after),
        createdAt: Date.now(),
      });
    return info?.lastInsertRowid ?? null;
  } catch (err) {
    process.stderr.write(`[audit] log failed (${entityType}/${action}): ${err.message}\n`);
    return null;
  }
}

/**
 * Convenience wrapper for the update case — diffs before/patch and
 * only logs if there's a real change. Used by db/products.update etc.
 * so the per-table caller stays compact.
 */
function logUpdate({ entityType, entityId, beforeRow, patch, userId }) {
  const d = diffPatch(beforeRow, patch);
  if (!d) return null;
  return log({
    entityType,
    entityId,
    action: 'update',
    before: d.before,
    after: d.after,
    userId,
  });
}

/**
 * Per-entity history feed for the side panel. Newest first. The
 * default limit is 200 — generous enough for a product's full life
 * in normal use, small enough to keep the modal snappy.
 *
 * Image events live under `entity_type='image', entity_id=<product_id>`
 * so a product's history modal naturally surfaces them via the same
 * query (no UNION needed) — that's why we use product_id (not the
 * product_images.id) as the entity_id for image events.
 */
function listForEntity(entityType, entityId, limit = 200) {
  if (!entityType || !entityId) return [];
  const db = getDb();
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 200), 1000);
  // For products, also pull image events (entity_type='image',
  // entity_id=<productId>) interleaved by created_at so the modal
  // shows one timeline.
  let rows;
  if (entityType === 'product') {
    rows = db
      .prepare(`
        SELECT * FROM audit_log
         WHERE (entity_type = 'product' AND entity_id = @id)
            OR (entity_type = 'image'   AND entity_id = @id)
         ORDER BY created_at DESC
         LIMIT @limit
      `)
      .all({ id: entityId, limit: cappedLimit });
  } else {
    rows = db
      .prepare(`
        SELECT * FROM audit_log
         WHERE entity_type = @type AND entity_id = @id
         ORDER BY created_at DESC
         LIMIT @limit
      `)
      .all({ type: entityType, id: entityId, limit: cappedLimit });
  }
  return rows.map(rowToEntry);
}

/**
 * Best-effort total count for a per-entity history modal that wants
 * to say "2 of 142 events shown". For products this includes the
 * interleaved image events the same way listForEntity does.
 */
function countForEntity(entityType, entityId) {
  if (!entityType || !entityId) return 0;
  const db = getDb();
  let row;
  if (entityType === 'product') {
    row = db
      .prepare(`
        SELECT COUNT(*) AS n FROM audit_log
         WHERE (entity_type = 'product' AND entity_id = @id)
            OR (entity_type = 'image'   AND entity_id = @id)
      `)
      .get({ id: entityId });
  } else {
    row = db
      .prepare(`
        SELECT COUNT(*) AS n FROM audit_log
         WHERE entity_type = @type AND entity_id = @id
      `)
      .get({ type: entityType, id: entityId });
  }
  return Number(row?.n ?? 0);
}

/**
 * v0.26.31: global history feed. Returns the newest events across the
 * entire audit_log, optionally filtered by entity type and/or user.
 * Used by the new dedicated History page in the sidebar.
 *
 * Caps:
 *   - limit clamped to 1–500 (a single page; the renderer paginates)
 *   - offset accepts arbitrary values for "show me page N"
 *
 * Filters:
 *   - entityType: 'product' | 'brand' | 'category' | 'image' | null
 *     (null = no filter). 'product' here is exact match; if the caller
 *     wants the same product-+-image interleave behaviour the per-entity
 *     view uses, they pass 'product' AND the renderer can fold image
 *     rows that share the same entity_id.
 *   - userId: arbitrary user id string, or null for "any user including
 *     server admin (null user_id)".
 *
 * Index used: idx_audit_log_created_at_desc — see db/index.js. Plenty
 * fast even on a 100k-row table because every query is "DESC ORDER BY
 * indexed column".
 */
function listRecent({ limit = 100, offset = 0, entityType = null, userId = null } = {}) {
  const db = getDb();
  const cappedLimit  = Math.min(Math.max(1, Number(limit)  || 100), 500);
  const cappedOffset = Math.max(0, Number(offset) || 0);
  const wheres = [];
  const params = { limit: cappedLimit, offset: cappedOffset };
  if (entityType) { wheres.push('entity_type = @entityType'); params.entityType = entityType; }
  if (userId)     { wheres.push('user_id = @userId');         params.userId = userId; }
  const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  const rows = db
    .prepare(`
      SELECT * FROM audit_log
      ${whereSql}
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `)
    .all(params);
  return rows.map(rowToEntry);
}

/**
 * Total count for the global history feed. Used by the History page
 * to render "Showing 1–50 of 12,847" pagination labels.
 */
function countRecent({ entityType = null, userId = null } = {}) {
  const db = getDb();
  const wheres = [];
  const params = {};
  if (entityType) { wheres.push('entity_type = @entityType'); params.entityType = entityType; }
  if (userId)     { wheres.push('user_id = @userId');         params.userId = userId; }
  const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`)
    .get(params);
  return Number(row?.n ?? 0);
}

/**
 * v0.33.0: total count + age span of the whole audit_log, for the
 * History page's "X events, oldest N days ago" line + to gate the clear
 * button. Cheap (COUNT + MIN/MAX on the created_at index).
 */
function stats() {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM audit_log')
    .get();
  return {
    total: Number(row?.n ?? 0),
    oldest: row?.oldest ?? null,
    newest: row?.newest ?? null,
  };
}

/**
 * v0.33.0: retention sweep / manual clear. Deletes audit_log rows older
 * than `days` (e.g. 15 / 30 / 90). `days <= 0` (or non-numeric) clears the
 * ENTIRE log. Returns the number of rows removed.
 *
 * Note: SQLite doesn't shrink the DB file on DELETE — the freed pages are
 * reused by future writes. That's fine for a log table; we don't VACUUM
 * (it would lock the DB and isn't worth the stall on a shared server).
 */
function clearOlderThan(days) {
  const db = getDb();
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) {
    const info = db.prepare('DELETE FROM audit_log').run();
    return { deleted: info.changes };
  }
  const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
  const info = db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
  return { deleted: info.changes };
}

module.exports = {
  log,
  logUpdate,
  diffPatch,
  listForEntity,
  countForEntity,
  listRecent,
  countRecent,
  stats,
  clearOlderThan,
};
