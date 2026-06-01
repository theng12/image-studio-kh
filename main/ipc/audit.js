/**
 * v0.22.6: audit:* IPC handlers — read-only feed for the
 * History modal in the side panel.
 *
 * Only two channels for now:
 *   - audit:listForEntity({ entityType, entityId, limit }) — newest
 *     first, includes image events when entityType === 'product'.
 *   - audit:countForEntity({ entityType, entityId }) — total count
 *     for the "showing N of M" footer.
 *
 * Both are exposed (callable by clients) so the History modal works
 * the same in client mode. No write endpoints — the audit log is
 * append-only via the per-table modules; an "edit history" feature
 * would defeat the purpose of an audit trail.
 */

const auditLog = require('../db/auditLog');

function register({ expose }) {
  expose('audit:listForEntity', ({ entityType, entityId, limit } = {}) => {
    if (!entityType || !entityId) return [];
    return auditLog.listForEntity(entityType, entityId, Number(limit) || 200);
  });

  expose('audit:countForEntity', ({ entityType, entityId } = {}) => {
    if (!entityType || !entityId) return 0;
    return auditLog.countForEntity(entityType, entityId);
  });

  /**
   * v0.26.31: global feed — every audit_log row across all entities,
   * across all users (server admin, client #1, client #2…), newest
   * first. Backing the dedicated History sidebar page added in the
   * same release. Filters by entityType + userId; renderer paginates.
   * Same read-only contract as the per-entity channels.
   */
  expose('audit:listRecent', ({ limit, offset, entityType, userId } = {}) => {
    return auditLog.listRecent({ limit, offset, entityType, userId });
  });
  expose('audit:countRecent', ({ entityType, userId } = {}) => {
    return auditLog.countRecent({ entityType, userId });
  });

  // v0.33.0: history retention. stats() backs the "X events · oldest N
  // days ago" line; clearHistory deletes rows older than `days` (or ALL
  // when days <= 0). Runs server-side, so a client clearing history clears
  // the shared log for everyone — same as any other write.
  expose('audit:historyStats', () => auditLog.stats());
  expose('audit:clearHistory', ({ days } = {}) => auditLog.clearOlderThan(days));
}

module.exports = { register };
