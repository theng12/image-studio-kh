/**
 * v0.21.0: search:* IPC handler, extracted from ipc.js.
 *
 * One channel: `search:global` runs a case-insensitive LIKE query
 * across products / brands / categories for the active company.
 * Backs the Cmd+K palette shipped in v0.18.2.
 */

const companies = require('../db/companies');

function register({ expose }) {
  expose('search:global', ({ query, limit } = {}) => {
    const companyId = companies.getActiveId();
    if (!companyId) return [];
    const { globalSearch } = require('../db/search');
    return globalSearch(companyId, query, Math.min(limit ?? 30, 100));
  });
}

module.exports = { register };
