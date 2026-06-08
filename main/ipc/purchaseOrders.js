/**
 * v0.49.47 — Purchase Orders IPC.
 *
 * One domain file owns POs + lines + components + product cost cache
 * reads. Same `expose` pattern as the rest of main/ipc/* so every
 * channel is automatically client-mode-RPC-able once added to
 * PROXIED_CHANNELS in main/client/index.js.
 */

const purchaseOrders = require('../db/purchaseOrders');
const landedCost = require('../util/landedCost');

function register({ expose }) {
  // Reads
  expose('pos:list',                 ({ companyId, filters } = {}) => purchaseOrders.list(companyId, filters || {}));
  expose('pos:get',                  (id) => purchaseOrders.get(id));
  expose('pos:getDetail',            (id) => purchaseOrders.getDetail(id));
  expose('pos:listForSupplier',      (supplierId) => purchaseOrders.listPosForSupplier(supplierId));
  expose('pos:listForProduct',       (productId) => purchaseOrders.listPosForProduct(productId));
  expose('pos:getProductCost',       (productId) => purchaseOrders.getProductCost(productId));
  // v0.49.48: bulk reads for the Library Cost column + Suppliers spend chip.
  expose('pos:listProductCosts',     (companyId) => purchaseOrders.listProductCosts(companyId));
  expose('pos:supplierSpendRollup',  (companyId) => purchaseOrders.supplierSpendRollup(companyId));

  // Header CRUD
  expose('pos:create',               (input) => purchaseOrders.create(input ?? {}));
  expose('pos:update',               ({ id, patch } = {}) => purchaseOrders.update(id, patch ?? {}));
  expose('pos:setStatus',            ({ id, status } = {}) => purchaseOrders.setStatus(id, status));
  expose('pos:remove',               (id) => purchaseOrders.remove(id));

  // Lines + components
  expose('pos:addLine',              ({ poId, input } = {}) => purchaseOrders.addLine(poId, input ?? {}));
  expose('pos:updateLine',           ({ lineId, patch } = {}) => purchaseOrders.updateLine(lineId, patch ?? {}));
  expose('pos:removeLine',           (lineId) => purchaseOrders.removeLine(lineId));
  expose('pos:addComponent',         ({ poId, input } = {}) => purchaseOrders.addComponent(poId, input ?? {}));
  expose('pos:updateComponent',      ({ componentId, patch } = {}) => purchaseOrders.updateComponent(componentId, patch ?? {}));
  expose('pos:removeComponent',      (componentId) => purchaseOrders.removeComponent(componentId));

  // v0.49.50: TT / payment ledger.
  expose('pos:listPayments',         (poId) => purchaseOrders.listPayments(poId));
  expose('pos:addPayment',           ({ poId, input } = {}) => purchaseOrders.addPayment(poId, input ?? {}));
  expose('pos:updatePayment',        ({ paymentId, patch } = {}) => purchaseOrders.updatePayment(paymentId, patch ?? {}));
  expose('pos:removePayment',        (paymentId) => purchaseOrders.removePayment(paymentId));

  // v0.49.47: pricing helpers exposed so the Cost Calculator + Library
  // can compute suggested retail without a backend round-trip per
  // keystroke. Pure math; no DB access; safe to call from any role.
  expose('costing:suggestedRetail',  ({ landedCostUsd, targetMarginPct } = {}) =>
    landedCost.suggestedRetail(landedCostUsd, targetMarginPct));
  expose('costing:realizedMargin',   ({ landedCostUsd, retailUsd } = {}) =>
    landedCost.realizedMargin(landedCostUsd, retailUsd));
  expose('costing:containerFillPct', ({ containerType, totalVolumeCbm } = {}) =>
    landedCost.containerFillPct(containerType, totalVolumeCbm));
}

module.exports = { register };
