/**
 * v0.49.47 — tests for the landed-cost calculator.
 *
 * Pure math, no DB. Covers the four allocation bases, the fallback
 * chain when a basis can't be applied, container fill %, and the
 * margin-of-retail formula. These regressions would silently corrupt
 * every PO if they slipped through, so this file is the safety net.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const lc = require('../main/util/landedCost');

const LINE_A = { id: 'a', qty: 100, unitPriceUsd: 10, cartonQty: 10, cartonWCm: 30, cartonHCm: 20, cartonDCm: 20, weightPerUnitKg: 0.5 };
const LINE_B = { id: 'b', qty: 50,  unitPriceUsd: 20, cartonQty: 5,  cartonWCm: 40, cartonHCm: 30, cartonDCm: 20, weightPerUnitKg: 1.0 };

test('calculateLanded — empty input returns zero totals', () => {
  const r = lc.calculateLanded({ lines: [], components: [] });
  assert.equal(r.perLine.length, 0);
  assert.equal(r.header.totalValueUsd, 0);
  assert.equal(r.header.totalComponentsUsd, 0);
  assert.equal(r.header.totalLandedUsd, 0);
  assert.equal(r.warnings.length, 0);
});

test('calculateLanded — no components: landed unit = unit price', () => {
  const r = lc.calculateLanded({ lines: [LINE_A, LINE_B], components: [] });
  const a = r.perLine.find((p) => p.lineId === 'a');
  const b = r.perLine.find((p) => p.lineId === 'b');
  assert.equal(a.allocatedCostUsdPerUnit, 0);
  assert.equal(a.landedUnitCostUsd, 10);
  assert.equal(b.landedUnitCostUsd, 20);
  assert.equal(r.header.totalValueUsd, 100 * 10 + 50 * 20); // 2000
});

test('calculateLanded — by_value allocation splits proportionally to line $', () => {
  // 1000 USD of goods on line A, 1000 on line B → 50/50 split.
  const freight = { id: 'c1', kind: 'freight', amountUsd: 200, allocationBasis: 'by_value' };
  const r = lc.calculateLanded({ lines: [LINE_A, LINE_B], components: [freight] });
  const a = r.perLine.find((p) => p.lineId === 'a');
  const b = r.perLine.find((p) => p.lineId === 'b');
  // A gets $100 of the freight → $1/unit over 100 units.
  assert.equal(a.totalAllocatedUsd, 100);
  assert.equal(a.allocatedCostUsdPerUnit, 1);
  assert.equal(a.landedUnitCostUsd, 11);
  // B gets $100 too → $2/unit over 50 units.
  assert.equal(b.totalAllocatedUsd, 100);
  assert.equal(b.allocatedCostUsdPerUnit, 2);
  assert.equal(b.landedUnitCostUsd, 22);
  assert.equal(r.warnings.length, 0);
});

test('calculateLanded — by_volume allocation uses carton CBM, not unit count', () => {
  // A: 10 cartons * 0.012 m³ = 0.12 CBM
  // B: 10 cartons * 0.024 m³ = 0.24 CBM
  // Ratio 1:2 → split 100 USD 1:2.
  const duty = { id: 'c2', kind: 'duty', amountUsd: 300, allocationBasis: 'by_volume' };
  const r = lc.calculateLanded({ lines: [LINE_A, LINE_B], components: [duty] });
  const a = r.perLine.find((p) => p.lineId === 'a');
  const b = r.perLine.find((p) => p.lineId === 'b');
  assert.ok(Math.abs(a.totalAllocatedUsd - 100) < 0.001);
  assert.ok(Math.abs(b.totalAllocatedUsd - 200) < 0.001);
  assert.equal(r.warnings.length, 0);
});

test('calculateLanded — by_weight allocation uses qty × weightPerUnit', () => {
  // A: 100 * 0.5 = 50 kg
  // B: 50  * 1.0 = 50 kg
  // 50/50 split.
  const ins = { id: 'c3', kind: 'insurance', amountUsd: 100, allocationBasis: 'by_weight' };
  const r = lc.calculateLanded({ lines: [LINE_A, LINE_B], components: [ins] });
  const a = r.perLine.find((p) => p.lineId === 'a');
  const b = r.perLine.find((p) => p.lineId === 'b');
  assert.ok(Math.abs(a.totalAllocatedUsd - 50) < 0.001);
  assert.ok(Math.abs(b.totalAllocatedUsd - 50) < 0.001);
});

test('calculateLanded — flat_per_line splits evenly across lines', () => {
  const handling = { id: 'c4', kind: 'handling', amountUsd: 80, allocationBasis: 'flat_per_line' };
  const r = lc.calculateLanded({ lines: [LINE_A, LINE_B], components: [handling] });
  const a = r.perLine.find((p) => p.lineId === 'a');
  const b = r.perLine.find((p) => p.lineId === 'b');
  assert.equal(a.totalAllocatedUsd, 40);
  assert.equal(b.totalAllocatedUsd, 40);
});

test('calculateLanded — by_volume falls back to by_value when no line has dims', () => {
  // Strip carton dims so by_volume can't apply.
  const noCartonA = { ...LINE_A, cartonWCm: 0, cartonHCm: 0, cartonDCm: 0 };
  const noCartonB = { ...LINE_B, cartonWCm: 0, cartonHCm: 0, cartonDCm: 0 };
  const c = { id: 'c5', kind: 'freight', amountUsd: 100, allocationBasis: 'by_volume' };
  const r = lc.calculateLanded({ lines: [noCartonA, noCartonB], components: [c] });
  // Without dims, total CBM is 0 → fall back to by_value (1000 vs 1000 → 50/50).
  const a = r.perLine.find((p) => p.lineId === 'a');
  const b = r.perLine.find((p) => p.lineId === 'b');
  assert.equal(a.totalAllocatedUsd, 50);
  assert.equal(b.totalAllocatedUsd, 50);
  assert.ok(r.warnings.length >= 1, 'should surface a warning when basis falls back');
  assert.match(r.warnings[0], /by_volume/);
});

test('calculateLanded — by_weight falls back to by_value when no line has weight', () => {
  const noWtA = { ...LINE_A, weightPerUnitKg: 0 };
  const noWtB = { ...LINE_B, weightPerUnitKg: 0 };
  const c = { id: 'c6', kind: 'freight', amountUsd: 100, allocationBasis: 'by_weight' };
  const r = lc.calculateLanded({ lines: [noWtA, noWtB], components: [c] });
  assert.ok(r.warnings.length >= 1);
  assert.match(r.warnings[0], /by_weight/);
});

test('calculateLanded — multiple components stack', () => {
  const components = [
    { id: 'f', kind: 'freight',   amountUsd: 200, allocationBasis: 'by_value' }, // 100/100
    { id: 'd', kind: 'duty',      amountUsd: 100, allocationBasis: 'by_value' }, //  50/50
  ];
  const r = lc.calculateLanded({ lines: [LINE_A, LINE_B], components });
  const a = r.perLine.find((p) => p.lineId === 'a');
  assert.equal(a.totalAllocatedUsd, 150); // 100 freight + 50 duty
  assert.equal(a.allocatedCostUsdPerUnit, 1.5);
  assert.equal(a.landedUnitCostUsd, 11.5);
  assert.equal(r.header.totalComponentsUsd, 300);
});

test('containerFillPct — 20\' / 40\' / 40HQ / LCL', () => {
  // Half-full 40HQ.
  assert.ok(Math.abs(lc.containerFillPct('40HQ', 38.2) - 50) < 0.5);
  // 20' fully packed.
  assert.ok(Math.abs(lc.containerFillPct('20', 33.2) - 100) < 0.5);
  // LCL — no capacity defined, return null.
  assert.equal(lc.containerFillPct('LCL', 10), null);
  // Unknown container → null.
  assert.equal(lc.containerFillPct('weird', 10), null);
  // Zero volume.
  assert.equal(lc.containerFillPct('40', 0), 0);
});

test('suggestedRetail — margin-of-retail formula (not markup)', () => {
  // 40% margin on $10 cost → retail $16.67 (cost / 0.6).
  assert.ok(Math.abs(lc.suggestedRetail(10, 40) - 16.6666667) < 0.001);
  // 0% margin → retail = cost.
  assert.equal(lc.suggestedRetail(10, 0), 10);
  // 100% margin → Infinity (selling for free is not pricing).
  assert.equal(lc.suggestedRetail(10, 100), Infinity);
  // Zero cost → 0.
  assert.equal(lc.suggestedRetail(0, 40), 0);
});

test('realizedMargin — inverse of suggestedRetail', () => {
  // Cost $10, retail $20 → 50% margin.
  assert.equal(lc.realizedMargin(10, 20), 50);
  // Cost $10, retail $10 → 0% margin.
  assert.equal(lc.realizedMargin(10, 10), 0);
  // Cost $10, retail $0 → 0% (degenerate, but no NaN).
  assert.equal(lc.realizedMargin(10, 0), 0);
});

test('round-trip — suggestedRetail then realizedMargin matches input', () => {
  for (const m of [10, 20, 30, 40, 50, 60, 75]) {
    const r = lc.suggestedRetail(15, m);
    const recovered = lc.realizedMargin(15, r);
    assert.ok(Math.abs(recovered - m) < 0.0001, `margin ${m}% did not round-trip`);
  }
});

test('incotermComponentWarnings — CIF flags freight + insurance', () => {
  const comps = [
    { kind: 'freight', label: 'Sea freight' },
    { kind: 'insurance', label: 'Marine insurance' },
    { kind: 'duty', label: 'Import duty' },
  ];
  const w = lc.incotermComponentWarnings('CIF', comps);
  assert.equal(w.length, 2); // freight + insurance flagged; duty is legit
  assert.ok(w.some((s) => s.toLowerCase().includes('freight')));
  assert.ok(w.some((s) => s.toLowerCase().includes('insurance')));
});

test('incotermComponentWarnings — CFR flags freight only', () => {
  const comps = [
    { kind: 'freight', label: 'Freight' },
    { kind: 'insurance', label: 'Insurance' },
  ];
  const w = lc.incotermComponentWarnings('CFR', comps);
  assert.equal(w.length, 1);
  assert.ok(w[0].toLowerCase().includes('freight'));
});

test('incotermComponentWarnings — CNF alias behaves like CFR', () => {
  const w = lc.incotermComponentWarnings('CNF', [{ kind: 'freight' }]);
  assert.equal(w.length, 1);
  // The label should normalise to CFR.
  assert.ok(w[0].includes('CFR'));
});

test('incotermComponentWarnings — EXW flags nothing (buyer pays all)', () => {
  const comps = [{ kind: 'freight' }, { kind: 'insurance' }, { kind: 'inland' }, { kind: 'duty' }];
  assert.deepEqual(lc.incotermComponentWarnings('EXW', comps), []);
});

test('incotermComponentWarnings — FOB flags inland (soft) but not freight', () => {
  const comps = [{ kind: 'freight' }, { kind: 'inland' }];
  const w = lc.incotermComponentWarnings('FOB', comps);
  assert.equal(w.length, 1);
  assert.ok(w[0].toLowerCase().includes('inland'));
});

test('incotermComponentWarnings — empty/unknown incoterm → no warnings', () => {
  assert.deepEqual(lc.incotermComponentWarnings('', [{ kind: 'freight' }]), []);
  assert.deepEqual(lc.incotermComponentWarnings(null, [{ kind: 'freight' }]), []);
  assert.deepEqual(lc.incotermComponentWarnings('WEIRD', [{ kind: 'freight' }]), []);
});

test('incotermComponentWarnings — case-insensitive kind match', () => {
  const w = lc.incotermComponentWarnings('cif', [{ kind: 'FREIGHT' }]);
  assert.equal(w.length, 1);
});

/* ─── v0.49.50: payment / TT ledger summary ─────────────────────── */

test('summarizePayments — no payments → unpaid, full outstanding', () => {
  const s = lc.summarizePayments({ owedSupplier: 10000, payments: [] });
  assert.equal(s.status, 'unpaid');
  assert.equal(s.paidSupplier, 0);
  assert.equal(s.outstandingSupplier, 10000);
  assert.equal(s.pct, 0);
});

test('summarizePayments — a deposit under the total → deposit_paid', () => {
  const s = lc.summarizePayments({
    owedSupplier: 10000,
    payments: [{ kind: 'deposit', amountSupplierCurrency: 3000, amountUsd: 3000, status: 'paid' }],
  });
  assert.equal(s.status, 'deposit_paid');
  assert.equal(s.paidSupplier, 3000);
  assert.equal(s.outstandingSupplier, 7000);
  assert.ok(Math.abs(s.pct - 30) < 0.001);
});

test('summarizePayments — a non-deposit partial → partially_paid', () => {
  const s = lc.summarizePayments({
    owedSupplier: 10000,
    payments: [{ kind: 'partial', amountSupplierCurrency: 4000, amountUsd: 4000, status: 'paid' }],
  });
  assert.equal(s.status, 'partially_paid');
});

test('summarizePayments — deposit + balance covering the total → paid_in_full', () => {
  const s = lc.summarizePayments({
    owedSupplier: 10000,
    payments: [
      { kind: 'deposit', amountSupplierCurrency: 3000, amountUsd: 3000, status: 'paid' },
      { kind: 'balance', amountSupplierCurrency: 7000, amountUsd: 7050, status: 'confirmed' },
    ],
  });
  assert.equal(s.status, 'paid_in_full');
  assert.equal(s.paidSupplier, 10000);
  assert.equal(s.outstandingSupplier, 0);
  // USD totals reflect the actual (per-payment-rate) amounts.
  assert.equal(s.paidUsd, 10050);
});

test('summarizePayments — overpay → overpaid', () => {
  const s = lc.summarizePayments({
    owedSupplier: 10000,
    payments: [{ kind: 'final', amountSupplierCurrency: 11000, amountUsd: 11000, status: 'paid' }],
  });
  assert.equal(s.status, 'overpaid');
});

test('summarizePayments — planned payments do NOT count toward paid', () => {
  const s = lc.summarizePayments({
    owedSupplier: 10000,
    payments: [
      { kind: 'deposit', amountSupplierCurrency: 3000, amountUsd: 3000, status: 'paid' },
      { kind: 'balance', amountSupplierCurrency: 7000, amountUsd: 7000, status: 'planned' },
    ],
  });
  assert.equal(s.status, 'deposit_paid'); // only the deposit is actually paid
  assert.equal(s.paidSupplier, 3000);
  assert.equal(s.plannedCount, 1);
});

test('summarizePayments — TT fees: all summed; in-landed only from paid/confirmed', () => {
  const s = lc.summarizePayments({
    owedSupplier: 10000,
    payments: [
      { kind: 'deposit', amountSupplierCurrency: 3000, amountUsd: 3000, status: 'paid',    ttFeeUsd: 25, ttFeeInLanded: true },
      { kind: 'balance', amountSupplierCurrency: 7000, amountUsd: 7000, status: 'planned', ttFeeUsd: 30, ttFeeInLanded: true },
      { kind: 'partial', amountSupplierCurrency: 0,    amountUsd: 0,    status: 'paid',    ttFeeUsd: 15, ttFeeInLanded: false },
    ],
  });
  assert.equal(s.ttFeesUsd, 70);          // 25 + 30 + 15, all recorded fees
  assert.equal(s.ttFeesInLandedUsd, 25);  // only the paid in-landed one (planned excluded, non-landed excluded)
});

test('summarizePayments — owed 0 but money out → overpaid (not a crash)', () => {
  const s = lc.summarizePayments({
    owedSupplier: 0,
    payments: [{ kind: 'deposit', amountSupplierCurrency: 500, amountUsd: 500, status: 'paid' }],
  });
  assert.equal(s.status, 'overpaid');
});

test('calculateLanded — degenerate: zero-priced lines do not crash on by_value', () => {
  // All lines at $0 → by_value can't allocate → flat fallback.
  const freeLineA = { ...LINE_A, unitPriceUsd: 0 };
  const freeLineB = { ...LINE_B, unitPriceUsd: 0 };
  const c = { id: 'f', kind: 'freight', amountUsd: 100, allocationBasis: 'by_value' };
  const r = lc.calculateLanded({ lines: [freeLineA, freeLineB], components: [c] });
  // Should fall back to flat_per_line → $50 each.
  const a = r.perLine.find((p) => p.lineId === 'a');
  const b = r.perLine.find((p) => p.lineId === 'b');
  assert.equal(a.totalAllocatedUsd, 50);
  assert.equal(b.totalAllocatedUsd, 50);
});
