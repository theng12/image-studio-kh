/**
 * v0.49.46: suppliers IPC — Phase 1 of the costing system.
 *
 * Single domain file because Phase 1 only owns the suppliers table.
 * When POs land in v0.49.47 they'll get their own ipc/purchaseOrders.js
 * — splitting now so this file doesn't balloon. Same `expose` pattern
 * the other domains use, so every channel is automatically RPC-
 * available to client Macs once added to PROXIED_CHANNELS.
 */

const suppliers = require('../db/suppliers');

function register({ expose }) {
  // Read paths — safe for any authenticated client. The renderer
  // gates the OPERATIONS sidebar entries via util/permissions.js so
  // photographer / viewer users don't see this data even though the
  // IPC itself accepts their calls (defence in depth — the server-side
  // ACL still drops their writes).
  expose('suppliers:list', ({ companyId, filters } = {}) =>
    suppliers.list(companyId, filters || {}));

  expose('suppliers:get', (id) => suppliers.get(id));

  // Mutation paths — server-side ACL in util/permissions.js rejects
  // these from photographer / viewer tokens. The renderer-side gate is
  // belt; this is braces.
  expose('suppliers:create',    (input) => suppliers.create(input ?? {}));
  expose('suppliers:update',    ({ id, patch } = {}) => suppliers.update(id, patch ?? {}));
  expose('suppliers:archive',   (id) => suppliers.archive(id));
  expose('suppliers:unarchive', (id) => suppliers.unarchive(id));
  expose('suppliers:remove',    (id) => suppliers.remove(id));
}

module.exports = { register };
