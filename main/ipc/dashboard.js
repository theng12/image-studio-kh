/**
 * v0.21.0: dashboard:* IPC handlers, extracted from ipc.js.
 *
 * Pure reads. All three channels are exposed (callable from clients
 * via RPC). The handlers just forward to db/dashboard helpers —
 * the SQL aggregations live there.
 */

const dashboard = require('../db/dashboard');

function register({ expose }) {
  // v0.14.4: portable to clients.
  expose('dashboard:stats',          (companyId) => dashboard.statsFor(companyId));
  expose('dashboard:recentBrands',   ({ companyId, limit } = {}) => dashboard.recentBrands(companyId, limit ?? 5));
  expose('dashboard:recentProducts', ({ companyId, limit } = {}) => dashboard.recentProducts(companyId, limit ?? 8));
  // v0.35.0: catalog-completeness counts for the "needs attention" panel.
  expose('dashboard:completeness',   (companyId) => dashboard.completenessFor(companyId));
}

module.exports = { register };
