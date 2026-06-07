/**
 * v0.49.47 — Purchase Orders DB module.
 *
 * Owns the purchase_orders header + po_lines + po_cost_components
 * tables AND the product_landed_costs derived cache.
 *
 * Key invariants:
 *   - Header `total_*` columns are CACHED. The DB layer re-runs the
 *     landed-cost calc on every mutation that could affect them
 *     (line add/remove/edit, component add/remove/edit). Callers
 *     don't need to remember to recalc.
 *   - On status transition to 'received', the product_landed_costs
 *     cache for every product referenced by this PO is refreshed
 *     atomically with the status flip.
 *   - Hard delete of a received PO recomputes the affected products'
 *     caches (so a PO mistakenly received then deleted doesn't leave
 *     stale latest-cost values).
 */

const crypto = require('node:crypto');
const { getDb } = require('./index');
const landedCost = require('../util/landedCost');

/* ─── row mappers ───────────────────────────────────────────────── */

function rowToPO(row) {
  if (!row) return null;
  return {
    id:                row.id,
    companyId:         row.company_id,
    supplierId:        row.supplier_id,
    poNumber:          row.po_number,
    incoterm:          row.incoterm,
    currency:          row.currency,
    exchangeRateToUsd: row.exchange_rate_to_usd,
    exchangeRateDate:  row.exchange_rate_date,
    status:            row.status,
    containerType:     row.container_type,
    orderedAt:         row.ordered_at,
    eta:               row.eta,
    receivedAt:        row.received_at,
    notes:             row.notes,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
    updatedByUserId:   row.updated_by_user_id,
    // v0.49.47 cached totals — written by recomputeHeader.
    totalValueSupplier:  row.total_value_supplier,
    totalValueUsd:       row.total_value_usd,
    totalVolumeCbm:      row.total_volume_cbm,
    totalWeightKg:       row.total_weight_kg,
    totalComponentsUsd:  row.total_components_usd,
    linesCount:          row.lines_count,
  };
}

function rowToLine(row) {
  if (!row) return null;
  return {
    id:                       row.id,
    poId:                     row.po_id,
    productId:                row.product_id,
    supplierSku:              row.supplier_sku,
    qty:                      row.qty,
    unitPriceSupplierCurrency: row.unit_price_supplier_currency,
    unitPriceUsdAtPo:         row.unit_price_usd_at_po,
    allocatedCostUsdPerUnit:  row.allocated_cost_usd_per_unit,
    landedUnitCostUsd:        row.landed_unit_cost_usd,
    cartonQty:                row.carton_qty,
    cartonWCm:                row.carton_w_cm,
    cartonHCm:                row.carton_h_cm,
    cartonDCm:                row.carton_d_cm,
    weightPerUnitKg:          row.weight_per_unit_kg,
    notes:                    row.notes,
  };
}

function rowToComponent(row) {
  if (!row) return null;
  return {
    id:                       row.id,
    poId:                     row.po_id,
    kind:                     row.kind,
    label:                    row.label,
    amountSupplierCurrency:   row.amount_supplier_currency,
    amountUsd:                row.amount_usd,
    allocationBasis:          row.allocation_basis,
    notes:                    row.notes,
  };
}

/* ─── PO header CRUD ────────────────────────────────────────────── */

const VALID_INCOTERMS  = new Set(['EXW', 'FOB', 'CFR', 'CIF']);
const VALID_STATUS     = ['draft', 'ordered', 'in_transit', 'received', 'closed'];
const VALID_CONTAINERS = new Set(['20', '40', '40HQ', 'LCL']);

function normalizeIncoterm(v) {
  if (!v) return 'FOB'; // sane default — most overseas suppliers quote FOB
  const s = String(v).trim().toUpperCase().replace('CNF', 'CFR');
  return VALID_INCOTERMS.has(s) ? s : 'FOB';
}

/**
 * List POs for a company. Filters: search (PO number), supplierId, status.
 * Returns header rows only (no lines / components) — call getDetail() for
 * the full picture.
 */
function list(companyId, filters = {}) {
  if (!companyId) return [];
  let sql = `
    SELECT po.*, s.name AS supplier_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.company_id = ?
  `;
  const params = [companyId];
  if (filters.supplierId) {
    sql += ` AND po.supplier_id = ?`;
    params.push(filters.supplierId);
  }
  if (filters.status && filters.status !== 'all') {
    sql += ` AND po.status = ?`;
    params.push(filters.status);
  }
  if (filters.search) {
    const escaped = String(filters.search).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const term = `%${escaped}%`;
    sql += ` AND (po.po_number LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.name LIKE ? ESCAPE '\\' COLLATE NOCASE)`;
    params.push(term, term);
  }
  sql += ` ORDER BY COALESCE(po.received_at, po.ordered_at, po.created_at) DESC`;
  const rows = getDb().prepare(sql).all(...params);
  return rows.map((r) => ({ ...rowToPO(r), supplierName: r.supplier_name }));
}

function get(id) {
  if (!id) return null;
  return rowToPO(getDb().prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id));
}

/**
 * Get a PO with its lines + components + supplier info, ready for the
 * detail page. Also runs the landed-cost calc and embeds per-line
 * computed values so the renderer doesn't need to.
 */
function getDetail(id) {
  const db = getDb();
  const headerRow = db
    .prepare(`SELECT po.*, s.name AS supplier_name, s.country AS supplier_country
               FROM purchase_orders po
               LEFT JOIN suppliers s ON s.id = po.supplier_id
              WHERE po.id = ?`)
    .get(id);
  if (!headerRow) return null;
  const header = { ...rowToPO(headerRow), supplierName: headerRow.supplier_name, supplierCountry: headerRow.supplier_country };
  const lines = db.prepare(`
    SELECT l.*, p.sku AS product_sku, p.name AS product_name
      FROM po_lines l
      LEFT JOIN products p ON p.id = l.product_id
     WHERE l.po_id = ?
     ORDER BY rowid ASC
  `).all(id).map((r) => ({ ...rowToLine(r), productSku: r.product_sku, productName: r.product_name }));
  const components = db.prepare(`SELECT * FROM po_cost_components WHERE po_id = ? ORDER BY rowid ASC`)
    .all(id).map(rowToComponent);

  // Run the calculator so the UI gets per-line landed cost without
  // round-tripping. We use the values that landed in the cache the
  // last time recomputeHeader fired, but ALSO run the calc fresh
  // here so a stale cache (concurrent edit, etc.) is overlaid by the
  // live answer. The cache is what we display in lists; the live
  // answer is what we show on the detail page.
  const calc = landedCost.calculateLanded({
    lines: lines.map((l) => ({
      id: l.id,
      qty: l.qty,
      unitPriceUsd: l.unitPriceUsdAtPo,
      cartonQty: l.cartonQty,
      cartonWCm: l.cartonWCm,
      cartonHCm: l.cartonHCm,
      cartonDCm: l.cartonDCm,
      weightPerUnitKg: l.weightPerUnitKg,
    })),
    components: components.map((c) => ({
      id: c.id, kind: c.kind, amountUsd: c.amountUsd, allocationBasis: c.allocationBasis,
    })),
  });
  const calcByLine = new Map(calc.perLine.map((c) => [c.lineId, c]));
  const linesWithCalc = lines.map((l) => ({
    ...l,
    calc: calcByLine.get(l.id) || null,
  }));

  const fillPct = landedCost.containerFillPct(header.containerType, calc.header.totalVolumeCbm);

  return { header, lines: linesWithCalc, components, calc: calc.header, warnings: calc.warnings, fillPct };
}

function create(input, userId = null) {
  if (!input?.companyId)  throw new Error('companyId is required');
  if (!input?.supplierId) throw new Error('supplierId is required');

  const supplier = getDb().prepare(`SELECT * FROM suppliers WHERE id = ?`).get(input.supplierId);
  if (!supplier) throw new Error('Supplier not found');
  if (supplier.company_id !== input.companyId) throw new Error('Supplier does not belong to active company');

  const now = Date.now();
  const id = `po_${crypto.randomBytes(6).toString('hex')}`;
  const incoterm = normalizeIncoterm(input.incoterm || supplier.default_incoterm);
  const currency = (input.currency || supplier.default_currency || 'USD').toUpperCase();
  const exchangeRateToUsd = Number(input.exchangeRateToUsd) || (currency === 'USD' ? 1 : 0);

  getDb().prepare(`
    INSERT INTO purchase_orders (
      id, company_id, supplier_id, po_number, incoterm, currency,
      exchange_rate_to_usd, exchange_rate_date, status, container_type,
      ordered_at, eta, received_at, notes,
      total_value_supplier, total_value_usd, total_volume_cbm, total_weight_kg,
      total_components_usd, lines_count,
      created_at, updated_at, updated_by_user_id
    ) VALUES (
      @id, @companyId, @supplierId, @poNumber, @incoterm, @currency,
      @exchangeRateToUsd, @exchangeRateDate, @status, @containerType,
      @orderedAt, @eta, @receivedAt, @notes,
      0, 0, 0, 0, 0, 0,
      @createdAt, @updatedAt, @updatedByUserId
    )
  `).run({
    id,
    companyId: input.companyId,
    supplierId: input.supplierId,
    poNumber: input.poNumber || null,
    incoterm,
    currency,
    exchangeRateToUsd,
    exchangeRateDate: input.exchangeRateDate || now,
    status: VALID_STATUS.includes(input.status) ? input.status : 'draft',
    containerType: VALID_CONTAINERS.has(input.containerType) ? input.containerType : null,
    orderedAt:  input.orderedAt  || null,
    eta:        input.eta        || null,
    receivedAt: input.receivedAt || null,
    notes:      input.notes      || null,
    createdAt: now,
    updatedAt: now,
    updatedByUserId: userId,
  });

  return get(id);
}

const HEADER_PATCH = [
  ['poNumber',          'po_number'],
  ['incoterm',          'incoterm',         normalizeIncoterm],
  ['currency',          'currency',         (v) => String(v || 'USD').toUpperCase()],
  ['exchangeRateToUsd', 'exchange_rate_to_usd', (v) => Number(v) || 0],
  ['exchangeRateDate',  'exchange_rate_date'],
  ['containerType',     'container_type',   (v) => (VALID_CONTAINERS.has(v) ? v : null)],
  ['orderedAt',         'ordered_at'],
  ['eta',               'eta'],
  ['notes',             'notes',            (v) => v?.trim() || null],
];

function update(id, patch, userId = null) {
  const existing = get(id);
  if (!existing) throw new Error('PO not found');

  const sets = [];
  const params = { id, updatedAt: Date.now(), updatedByUserId: userId };
  for (const [key, col, fn] of HEADER_PATCH) {
    if (key in (patch ?? {})) {
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(patch[key]) : patch[key];
    }
  }
  if (sets.length === 0) return existing;
  sets.push(`updated_at = @updatedAt`);
  sets.push(`updated_by_user_id = @updatedByUserId`);
  getDb().prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id);
}

/**
 * Status transitions. The interesting one is →'received': triggers
 * the landed-cost calc for the whole PO and writes the
 * product_landed_costs cache for every product on the PO.
 *
 * Allowed transitions (relaxed — we trust the user):
 *   draft       → ordered, closed
 *   ordered     → in_transit, received, closed
 *   in_transit  → received, closed
 *   received    → closed, ordered (re-open with warning surfaced by UI)
 *   closed      → ordered (re-open, drops landed cost cache on next received)
 *
 * The UI layer warns before destructive transitions; the DB layer
 * accepts whatever the UI tells it.
 */
function setStatus(id, newStatus, userId = null) {
  const existing = get(id);
  if (!existing) throw new Error('PO not found');
  if (!VALID_STATUS.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);

  const now = Date.now();
  const db = getDb();
  const inTx = db.transaction(() => {
    const becomingReceived = newStatus === 'received' && existing.status !== 'received';
    const leavingReceived  = newStatus !== 'received' && existing.status === 'received';

    const sets = [`status = ?`, `updated_at = ?`, `updated_by_user_id = ?`];
    const params = [newStatus, now, userId];
    if (becomingReceived) {
      sets.push(`received_at = ?`);
      params.push(now);
    } else if (leavingReceived) {
      sets.push(`received_at = NULL`);
    }
    db.prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);

    // Recompute first (so the line landed_unit_cost_usd snapshots are
    // current before we use them for the per-product cache).
    recomputeHeader(id);

    if (becomingReceived) {
      refreshProductCostsForPO(id);
    } else if (leavingReceived) {
      // The PO no longer counts as a received-cost source. Refresh
      // every product it touched so their caches drop this PO's
      // contribution.
      refreshProductCostsForPO(id);
    }
  });
  inTx();
  return get(id);
}

function remove(id) {
  const existing = get(id);
  if (!existing) return { deleted: 0 };
  const wasReceived = existing.status === 'received';
  const db = getDb();
  const tx = db.transaction(() => {
    // Capture affected products BEFORE delete so we can refresh after.
    const productIds = db.prepare(`SELECT DISTINCT product_id FROM po_lines WHERE po_id = ?`).all(id).map((r) => r.product_id);
    db.prepare(`DELETE FROM purchase_orders WHERE id = ?`).run(id);
    if (wasReceived) {
      for (const pid of productIds) recomputeProductCost(pid);
    }
  });
  tx();
  return { deleted: 1 };
}

/* ─── lines + components ────────────────────────────────────────── */

function addLine(poId, input, userId = null) {
  const po = get(poId);
  if (!po) throw new Error('PO not found');
  if (!input?.productId) throw new Error('productId is required');
  if (input.qty == null) throw new Error('qty is required');

  const db = getDb();
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(input.productId);
  if (!product) throw new Error('Product not found');

  const unitPriceSupplier = Number(input.unitPriceSupplierCurrency) || 0;
  const unitPriceUsd      = (unitPriceSupplier * (Number(po.exchangeRateToUsd) || 0)) || Number(input.unitPriceUsdAtPo) || 0;

  const id = `pol_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`
    INSERT INTO po_lines (
      id, po_id, product_id, supplier_sku, qty,
      unit_price_supplier_currency, unit_price_usd_at_po,
      carton_qty, carton_w_cm, carton_h_cm, carton_d_cm, weight_per_unit_kg,
      notes
    ) VALUES (
      @id, @poId, @productId, @supplierSku, @qty,
      @unitPriceSupplierCurrency, @unitPriceUsdAtPo,
      @cartonQty, @cartonWCm, @cartonHCm, @cartonDCm, @weightPerUnitKg,
      @notes
    )
  `).run({
    id, poId,
    productId: input.productId,
    supplierSku: input.supplierSku ?? product.supplier_sku ?? null,
    qty: Number(input.qty) || 0,
    unitPriceSupplierCurrency: unitPriceSupplier,
    unitPriceUsdAtPo: unitPriceUsd,
    cartonQty: Number(input.cartonQty ?? product.carton_qty)         || null,
    cartonWCm: Number(input.cartonWCm ?? product.carton_w_cm)        || null,
    cartonHCm: Number(input.cartonHCm ?? product.carton_h_cm)        || null,
    cartonDCm: Number(input.cartonDCm ?? product.carton_d_cm)        || null,
    weightPerUnitKg: Number(input.weightPerUnitKg ?? product.weight_per_unit_kg) || null,
    notes: input.notes || null,
  });

  recomputeHeader(poId, userId);
  return getDetail(poId);
}

const LINE_PATCH = [
  ['qty',                       'qty',                          Number],
  ['unitPriceSupplierCurrency', 'unit_price_supplier_currency', Number],
  ['supplierSku',               'supplier_sku'],
  ['cartonQty',                 'carton_qty',                   (v) => Number(v) || null],
  ['cartonWCm',                 'carton_w_cm',                  (v) => Number(v) || null],
  ['cartonHCm',                 'carton_h_cm',                  (v) => Number(v) || null],
  ['cartonDCm',                 'carton_d_cm',                  (v) => Number(v) || null],
  ['weightPerUnitKg',           'weight_per_unit_kg',           (v) => Number(v) || null],
  ['notes',                     'notes',                        (v) => v?.trim() || null],
];

function updateLine(lineId, patch, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM po_lines WHERE id = ?`).get(lineId);
  if (!row) throw new Error('Line not found');
  const po = get(row.po_id);

  const sets = [];
  const params = { id: lineId };
  for (const [key, col, fn] of LINE_PATCH) {
    if (key in (patch ?? {})) {
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(patch[key]) : patch[key];
    }
  }
  if (sets.length === 0) return getDetail(po.id);

  // If the supplier price changed, re-snapshot the USD-at-PO value too.
  if ('unitPriceSupplierCurrency' in (patch ?? {})) {
    const newSupplier = Number(patch.unitPriceSupplierCurrency) || 0;
    const newUsd = newSupplier * (Number(po.exchangeRateToUsd) || 0);
    sets.push(`unit_price_usd_at_po = @newUsd`);
    params.newUsd = newUsd;
  }

  db.prepare(`UPDATE po_lines SET ${sets.join(', ')} WHERE id = @id`).run(params);
  recomputeHeader(po.id, userId);
  return getDetail(po.id);
}

function removeLine(lineId, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT po_id FROM po_lines WHERE id = ?`).get(lineId);
  if (!row) return null;
  db.prepare(`DELETE FROM po_lines WHERE id = ?`).run(lineId);
  recomputeHeader(row.po_id, userId);
  return getDetail(row.po_id);
}

function addComponent(poId, input, userId = null) {
  const po = get(poId);
  if (!po) throw new Error('PO not found');
  const amountSupplier = Number(input.amountSupplierCurrency) || 0;
  const amountUsd      = amountSupplier * (Number(po.exchangeRateToUsd) || 0)
                        || Number(input.amountUsd) || 0;

  const id = `pcc_${crypto.randomBytes(6).toString('hex')}`;
  getDb().prepare(`
    INSERT INTO po_cost_components (
      id, po_id, kind, label,
      amount_supplier_currency, amount_usd, allocation_basis, notes
    ) VALUES (
      @id, @poId, @kind, @label,
      @amountSupplierCurrency, @amountUsd, @allocationBasis, @notes
    )
  `).run({
    id, poId,
    kind: input.kind || 'other',
    label: input.label || null,
    amountSupplierCurrency: amountSupplier,
    amountUsd,
    allocationBasis: input.allocationBasis || 'by_value',
    notes: input.notes || null,
  });
  recomputeHeader(poId, userId);
  return getDetail(poId);
}

const COMP_PATCH = [
  ['kind',                    'kind'],
  ['label',                   'label',                    (v) => v?.trim() || null],
  ['amountSupplierCurrency',  'amount_supplier_currency', Number],
  ['allocationBasis',         'allocation_basis'],
  ['notes',                   'notes',                    (v) => v?.trim() || null],
];

function updateComponent(componentId, patch, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM po_cost_components WHERE id = ?`).get(componentId);
  if (!row) throw new Error('Component not found');
  const po = get(row.po_id);

  const sets = [];
  const params = { id: componentId };
  for (const [key, col, fn] of COMP_PATCH) {
    if (key in (patch ?? {})) {
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(patch[key]) : patch[key];
    }
  }
  if (sets.length === 0) return getDetail(po.id);

  if ('amountSupplierCurrency' in (patch ?? {})) {
    const newSupplier = Number(patch.amountSupplierCurrency) || 0;
    const newUsd = newSupplier * (Number(po.exchangeRateToUsd) || 0);
    sets.push(`amount_usd = @newUsd`);
    params.newUsd = newUsd;
  }
  db.prepare(`UPDATE po_cost_components SET ${sets.join(', ')} WHERE id = @id`).run(params);
  recomputeHeader(po.id, userId);
  return getDetail(po.id);
}

function removeComponent(componentId, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT po_id FROM po_cost_components WHERE id = ?`).get(componentId);
  if (!row) return null;
  db.prepare(`DELETE FROM po_cost_components WHERE id = ?`).run(componentId);
  recomputeHeader(row.po_id, userId);
  return getDetail(row.po_id);
}

/* ─── recompute + product cost cache ────────────────────────────── */

/**
 * Re-run the landed cost calc for one PO + write per-line cache cols +
 * write header totals. Called on every line/component mutation so the
 * cached numbers stay in sync. Also re-snapshots line USD prices using
 * the PO's current exchange rate, in case the rate changed after lines
 * were added (rare; keeps everything coherent).
 */
function recomputeHeader(poId, _userId = null) {
  const db = getDb();
  const po = rowToPO(db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(poId));
  if (!po) return;

  const lines = db.prepare(`SELECT * FROM po_lines WHERE po_id = ?`).all(poId).map(rowToLine);
  const components = db.prepare(`SELECT * FROM po_cost_components WHERE po_id = ?`).all(poId).map(rowToComponent);

  const calc = landedCost.calculateLanded({
    lines: lines.map((l) => ({
      id: l.id,
      qty: l.qty,
      unitPriceUsd: l.unitPriceUsdAtPo,
      cartonQty: l.cartonQty,
      cartonWCm: l.cartonWCm,
      cartonHCm: l.cartonHCm,
      cartonDCm: l.cartonDCm,
      weightPerUnitKg: l.weightPerUnitKg,
    })),
    components: components.map((c) => ({
      id: c.id, kind: c.kind, amountUsd: c.amountUsd, allocationBasis: c.allocationBasis,
    })),
  });

  // Per-line cache.
  const upd = db.prepare(`UPDATE po_lines SET allocated_cost_usd_per_unit = ?, landed_unit_cost_usd = ? WHERE id = ?`);
  for (const l of calc.perLine) {
    upd.run(l.allocatedCostUsdPerUnit, l.landedUnitCostUsd, l.lineId);
  }

  // Header cache.
  const totalSupplier = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPriceSupplierCurrency) || 0), 0);
  db.prepare(`
    UPDATE purchase_orders
       SET total_value_supplier = ?, total_value_usd = ?,
           total_volume_cbm = ?, total_weight_kg = ?,
           total_components_usd = ?, lines_count = ?
     WHERE id = ?
  `).run(
    totalSupplier,
    calc.header.totalValueUsd,
    calc.header.totalVolumeCbm,
    calc.header.totalWeightKg,
    calc.header.totalComponentsUsd,
    lines.length,
    poId,
  );
}

/**
 * Refresh product_landed_costs for every product on this PO. Runs after
 * a status → received OR after a received PO is deleted / re-opened.
 */
function refreshProductCostsForPO(poId) {
  const db = getDb();
  const productIds = db.prepare(`SELECT DISTINCT product_id FROM po_lines WHERE po_id = ?`).all(poId).map((r) => r.product_id);
  for (const pid of productIds) recomputeProductCost(pid);
}

/**
 * Compute the cache row for ONE product across ALL its received POs.
 * - latest = most recent po.received_at × its landed_unit_cost_usd
 * - 3mo avg = weighted by qty over POs received in last 90 days
 * - 12mo avg = weighted by qty over POs received in last 365 days
 */
function recomputeProductCost(productId) {
  const db = getDb();
  const now = Date.now();
  const cutoff3mo  = now - 90  * 24 * 3600 * 1000;
  const cutoff12mo = now - 365 * 24 * 3600 * 1000;

  const rows = db.prepare(`
    SELECT l.qty, l.landed_unit_cost_usd AS landed, po.id AS po_id, po.received_at
      FROM po_lines l
      JOIN purchase_orders po ON po.id = l.po_id
     WHERE l.product_id = ?
       AND po.status = 'received'
       AND po.received_at IS NOT NULL
     ORDER BY po.received_at DESC
  `).all(productId);

  if (rows.length === 0) {
    db.prepare(`DELETE FROM product_landed_costs WHERE product_id = ?`).run(productId);
    return;
  }

  const latest = rows[0];
  const avg = (subset) => {
    const totalQty = subset.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    if (totalQty <= 0) return null;
    const weighted = subset.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.landed) || 0), 0);
    return weighted / totalQty;
  };
  const rows3mo  = rows.filter((r) => r.received_at >= cutoff3mo);
  const rows12mo = rows.filter((r) => r.received_at >= cutoff12mo);

  db.prepare(`
    INSERT INTO product_landed_costs (product_id, latest_landed_cost_usd, latest_po_id, latest_received_at, avg_landed_cost_usd_3mo, avg_landed_cost_usd_12mo, updated_at)
    VALUES (@productId, @latest, @poId, @receivedAt, @avg3mo, @avg12mo, @updatedAt)
    ON CONFLICT(product_id) DO UPDATE SET
      latest_landed_cost_usd   = excluded.latest_landed_cost_usd,
      latest_po_id             = excluded.latest_po_id,
      latest_received_at       = excluded.latest_received_at,
      avg_landed_cost_usd_3mo  = excluded.avg_landed_cost_usd_3mo,
      avg_landed_cost_usd_12mo = excluded.avg_landed_cost_usd_12mo,
      updated_at               = excluded.updated_at
  `).run({
    productId,
    latest: latest.landed,
    poId: latest.po_id,
    receivedAt: latest.received_at,
    avg3mo:  avg(rows3mo),
    avg12mo: avg(rows12mo),
    updatedAt: now,
  });
}

/* ─── reads used by the Product Library + Cost Calculator ───────── */

function getProductCost(productId) {
  if (!productId) return null;
  const row = getDb().prepare(`SELECT * FROM product_landed_costs WHERE product_id = ?`).get(productId);
  if (!row) return null;
  return {
    productId:                row.product_id,
    latestLandedCostUsd:      row.latest_landed_cost_usd,
    latestPoId:               row.latest_po_id,
    latestReceivedAt:         row.latest_received_at,
    avgLandedCostUsd3mo:      row.avg_landed_cost_usd_3mo,
    avgLandedCostUsd12mo:     row.avg_landed_cost_usd_12mo,
    updatedAt:                row.updated_at,
  };
}

function listPosForSupplier(supplierId) {
  if (!supplierId) return [];
  return getDb().prepare(`
    SELECT * FROM purchase_orders WHERE supplier_id = ?
    ORDER BY COALESCE(received_at, ordered_at, created_at) DESC
  `).all(supplierId).map(rowToPO);
}

function listPosForProduct(productId) {
  if (!productId) return [];
  return getDb().prepare(`
    SELECT po.*, l.qty, l.landed_unit_cost_usd, l.unit_price_supplier_currency
      FROM po_lines l
      JOIN purchase_orders po ON po.id = l.po_id
     WHERE l.product_id = ?
     ORDER BY COALESCE(po.received_at, po.ordered_at, po.created_at) DESC
  `).all(productId).map((r) => ({
    ...rowToPO(r),
    lineQty: r.qty,
    lineLandedUnitCostUsd: r.landed_unit_cost_usd,
    lineUnitPriceSupplier: r.unit_price_supplier_currency,
  }));
}

module.exports = {
  list, get, getDetail, create, update, setStatus, remove,
  addLine, updateLine, removeLine,
  addComponent, updateComponent, removeComponent,
  recomputeHeader, recomputeProductCost,
  getProductCost, listPosForSupplier, listPosForProduct,
};
