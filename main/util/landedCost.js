/**
 * v0.49.47 — landed cost calculator.
 *
 * Pure functions, no DB access — the DB layer reads rows, calls in here,
 * writes results back. Keeps the math testable + self-contained.
 *
 * Inputs (already converted to USD where relevant):
 *
 *   lines: [{
 *     id, qty,
 *     unitPriceUsd,             // unit_price_usd_at_po (snapshot at PO time)
 *     cartonQty,                // optional — units per carton
 *     cartonWCm, cartonHCm, cartonDCm,  // optional — carton outer dims in cm
 *     weightPerUnitKg,          // optional — gross weight per unit
 *   }]
 *
 *   components: [{
 *     id, kind, amountUsd, allocationBasis   // 'by_value' | 'by_volume' | 'by_weight' | 'flat_per_line'
 *   }]
 *
 * Output per line:
 *   { lineId, allocatedCostUsdPerUnit, landedUnitCostUsd, totalLineValueUsd,
 *     volumeCbm, weightKg }
 *
 * Plus header-level totals: totalValueUsd, totalVolumeCbm, totalWeightKg.
 *
 * Allocation falls back to by_value when a component's basis is by_volume
 * but no line has carton dims (returns 0 volume). Same for by_weight when
 * no per-unit weight is set. Surfaced to the user as a "fell back" flag
 * in the result so the PO form can warn.
 */

/** Volume of one carton in cubic centimetres → CBM (cubic metres). */
function cartonCbm(line) {
  const w = Number(line.cartonWCm) || 0;
  const h = Number(line.cartonHCm) || 0;
  const d = Number(line.cartonDCm) || 0;
  if (!w || !h || !d) return 0;
  return (w * h * d) / 1_000_000; // cm³ → m³
}

/** Number of cartons this PO line ships in. Round up — a half-carton
 *  is still a whole carton in the container. */
function cartonsForLine(line) {
  const qty = Number(line.qty) || 0;
  const perCarton = Number(line.cartonQty) || 0;
  if (!qty || !perCarton) return 0;
  return Math.ceil(qty / perCarton);
}

/** Per-line CBM (carton CBM × number of cartons). */
function lineVolumeCbm(line) {
  const c = cartonCbm(line);
  const n = cartonsForLine(line);
  return c * n;
}

/** Per-line weight in kg (qty × per-unit weight). */
function lineWeightKg(line) {
  const qty = Number(line.qty) || 0;
  const wpu = Number(line.weightPerUnitKg) || 0;
  return qty * wpu;
}

/** Per-line USD value before allocations (unit price × qty). */
function lineValueUsd(line) {
  return (Number(line.qty) || 0) * (Number(line.unitPriceUsd) || 0);
}

/**
 * Run a single allocation pass for one cost component.
 * Returns a Map<lineId, share-amount-USD> summing to component.amountUsd
 * (within float rounding). When the basis can't be applied because the
 * total for that basis is zero (e.g. by_volume but no carton dims),
 * silently falls back to by_value. If by_value is also zero (all lines
 * priced at $0 — degenerate), falls back to flat_per_line.
 *
 * Returns { shares: Map, basisUsed }.
 */
function allocateOne(component, linesWithTotals) {
  const amount = Number(component.amountUsd) || 0;
  const lineIds = linesWithTotals.map((l) => l.id);

  function shareBy(key) {
    const totals = linesWithTotals.map((l) => Number(l[key]) || 0);
    const sum = totals.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    const m = new Map();
    for (let i = 0; i < lineIds.length; i += 1) {
      m.set(lineIds[i], (amount * totals[i]) / sum);
    }
    return m;
  }

  function shareFlat() {
    const m = new Map();
    if (lineIds.length === 0) return m;
    const each = amount / lineIds.length;
    for (const id of lineIds) m.set(id, each);
    return m;
  }

  const basis = component.allocationBasis || 'by_value';
  let shares = null;
  let basisUsed = basis;

  if (basis === 'by_value')       shares = shareBy('valueUsd');
  else if (basis === 'by_volume') shares = shareBy('volumeCbm');
  else if (basis === 'by_weight') shares = shareBy('weightKg');
  else if (basis === 'flat_per_line') {
    shares = shareFlat();
  }

  // Fallback chain — silent, with basisUsed tracking which basis
  // actually got applied.
  if (!shares) {
    shares = shareBy('valueUsd');
    basisUsed = 'by_value (fallback from ' + basis + ')';
  }
  if (!shares) {
    shares = shareFlat();
    basisUsed = 'flat_per_line (fallback from ' + basis + ')';
  }

  return { shares, basisUsed };
}

/**
 * Main entry point. Given the PO's lines + cost components, return:
 *
 *   {
 *     perLine: [{ lineId, allocatedCostUsdPerUnit, landedUnitCostUsd,
 *                 totalLineValueUsd, volumeCbm, weightKg, totalAllocatedUsd }],
 *     header: { totalValueUsd, totalVolumeCbm, totalWeightKg,
 *               totalComponentsUsd, totalLandedUsd },
 *     warnings: string[]   // human-readable allocation-fallback notices
 *   }
 */
function calculateLanded({ lines, components }) {
  const linesWithTotals = (lines || []).map((l) => ({
    ...l,
    valueUsd: lineValueUsd(l),
    volumeCbm: lineVolumeCbm(l),
    weightKg: lineWeightKg(l),
  }));

  const totals = {
    totalValueUsd:    sum(linesWithTotals.map((l) => l.valueUsd)),
    totalVolumeCbm:   sum(linesWithTotals.map((l) => l.volumeCbm)),
    totalWeightKg:    sum(linesWithTotals.map((l) => l.weightKg)),
    totalComponentsUsd: sum((components || []).map((c) => Number(c.amountUsd) || 0)),
  };

  const allocatedByLine = new Map(linesWithTotals.map((l) => [l.id, 0]));
  const warnings = [];
  for (const comp of components || []) {
    const { shares, basisUsed } = allocateOne(comp, linesWithTotals);
    for (const [lineId, share] of shares.entries()) {
      allocatedByLine.set(lineId, (allocatedByLine.get(lineId) || 0) + share);
    }
    if (basisUsed.includes('fallback')) {
      warnings.push(
        `Cost component "${comp.kind}" requested ${comp.allocationBasis} ` +
        `but couldn't apply it — used ${basisUsed} instead. ` +
        `${comp.allocationBasis === 'by_volume' ? 'Set carton dims on each line first.' : ''}` +
        `${comp.allocationBasis === 'by_weight' ? 'Set per-unit weight on each line first.' : ''}`,
      );
    }
  }

  const perLine = linesWithTotals.map((l) => {
    const totalAllocatedUsd = allocatedByLine.get(l.id) || 0;
    const allocatedCostUsdPerUnit = (Number(l.qty) || 0) > 0
      ? totalAllocatedUsd / Number(l.qty)
      : 0;
    const landedUnitCostUsd = (Number(l.unitPriceUsd) || 0) + allocatedCostUsdPerUnit;
    return {
      lineId: l.id,
      allocatedCostUsdPerUnit,
      landedUnitCostUsd,
      totalLineValueUsd: l.valueUsd,
      volumeCbm: l.volumeCbm,
      weightKg: l.weightKg,
      totalAllocatedUsd,
    };
  });

  return {
    perLine,
    header: {
      ...totals,
      totalLandedUsd: totals.totalValueUsd + totals.totalComponentsUsd,
    },
    warnings,
  };
}

/** Container CBM capacity by ISO type. Approximate usable interior;
 *  reality varies by container condition + dunnage. These are the
 *  numbers logistics quotes use day-to-day. */
const CONTAINER_CBM = {
  '20':   33.2,
  '40':   67.7,
  '40HQ': 76.4,
  // LCL = less-than-container-load; no fixed capacity, fill is meaningless.
  LCL:    null,
};

/** Percent of container filled by this PO's total CBM. NULL if the
 *  container type doesn't have a fixed capacity (LCL). */
function containerFillPct(containerType, totalVolumeCbm) {
  const cap = CONTAINER_CBM[containerType];
  if (!cap) return null;
  if (!Number(totalVolumeCbm)) return 0;
  return (Number(totalVolumeCbm) / cap) * 100;
}

/**
 * Suggested retail price from landed cost + target margin.
 * Target margin is a PERCENT of retail (not markup-over-cost):
 *   retail × (1 - margin/100) = cost   →   retail = cost / (1 - margin/100)
 *
 * Most catalog retailers think in margin% (i.e. how much of each sale is
 * profit), not markup% (how much over cost the price is). 40% margin
 * means $1 of every $1 sold is profit, NOT cost × 1.4.
 */
function suggestedRetail(landedCostUsd, targetMarginPct) {
  const cost = Number(landedCostUsd) || 0;
  const m = Number(targetMarginPct) || 0;
  if (cost <= 0) return 0;
  if (m >= 100) return Infinity; // 100% margin = sell for free... wrong.
  if (m <= 0)   return cost;
  return cost / (1 - m / 100);
}

/** Inverse — given a retail price and a landed cost, what's the margin %? */
function realizedMargin(landedCostUsd, retailUsd) {
  const cost = Number(landedCostUsd) || 0;
  const r = Number(retailUsd) || 0;
  if (r <= 0) return 0;
  return ((r - cost) / r) * 100;
}

function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }

/**
 * Which cost-component kinds an Incoterm already bakes into the unit
 * price the supplier quoted. Adding a component of one of these kinds is
 * (usually) double-counting — the buyer would pay for it twice.
 *
 *   EXW — ex-works: buyer pays EVERYTHING from the factory gate. Nothing
 *         is included, so no component is a double-count.
 *   FOB — free on board: seller covers origin-side costs up to loading at
 *         the origin port (origin inland haulage + export clearance).
 *         Sea freight, insurance, duty are the buyer's. We only flag
 *         'inland' here, and gently — "inland" could mean destination
 *         haulage, which IS the buyer's, so this is a soft notice.
 *   CFR / CNF — cost & freight: seller covers freight to the destination
 *         port. Adding a 'freight' component double-counts.
 *   CIF — cost, insurance, freight: seller covers freight AND insurance.
 *         Adding 'freight' or 'insurance' double-counts.
 *
 * The returned warnings are advisory — the calc never blocks. The user
 * might legitimately add a destination-side freight leg on a CFR PO, so
 * we phrase it as "may already be included", not "is wrong".
 */
const INCOTERM_INCLUDED = {
  EXW: [],
  FOB: ['inland'],
  CFR: ['freight'],
  CIF: ['freight', 'insurance'],
};

const INCOTERM_LABEL = {
  EXW: 'EXW (ex-works)',
  FOB: 'FOB (free on board)',
  CFR: 'CFR / CNF (cost & freight)',
  CIF: 'CIF (cost, insurance, freight)',
};

/**
 * Given a PO's Incoterm + its cost components, return human-readable
 * notices for any component whose kind the Incoterm likely already
 * includes in the supplier's unit price. Returns string[] (possibly
 * empty). Normalises the CNF alias to CFR.
 */
function incotermComponentWarnings(incoterm, components) {
  const norm = String(incoterm || '').trim().toUpperCase().replace('CNF', 'CFR');
  const included = INCOTERM_INCLUDED[norm];
  if (!included || included.length === 0) return [];
  const label = INCOTERM_LABEL[norm] || norm;
  const warnings = [];
  for (const c of components || []) {
    const kind = String(c?.kind || '').trim().toLowerCase();
    if (included.includes(kind)) {
      const soft = norm === 'FOB'; // FOB 'inland' is genuinely ambiguous
      warnings.push(
        `This PO is ${label} — ${kind} ${soft ? 'at origin may already be' : 'is normally already'} ` +
        `covered by the supplier's unit price. ` +
        `Check the "${c.label || kind}" cost line${soft ? ' (if it\'s destination-side haulage, ignore this).' : ' so you don\'t double-count it.'}`,
      );
    }
  }
  return warnings;
}

module.exports = {
  calculateLanded,
  containerFillPct,
  suggestedRetail,
  realizedMargin,
  incotermComponentWarnings,
  // exported for tests / advanced callers
  _internals: {
    cartonCbm, cartonsForLine, lineVolumeCbm, lineWeightKg, lineValueUsd,
    allocateOne, CONTAINER_CBM, INCOTERM_INCLUDED,
  },
};
