/**
 * v0.49.47 — PO detail page.
 *
 * Three stacked panels (no tabs):
 *   1. Header form — editable supplier-ish fields + status flow.
 *   2. Line items — table with inline edit + Add Line modal.
 *   3. Cost components — table with inline edit + Add Component modal.
 *   4. Landed cost summary — totals + per-line preview + container fill + warnings.
 *
 * The store of truth is the backend. Every mutation calls a `pos:*`
 * channel, which returns the full re-computed detail snapshot. The
 * renderer just rebinds state to the snapshot. No optimistic UI.
 *
 * Header fields auto-save on blur (200ms debounce per field) — same
 * pattern as the rest of the app, except for status, which is an
 * explicit dropdown click.
 *
 * Why no header Save button (compare CLAUDE.md §6 Workspace exception):
 * the PO header is mostly metadata (supplier, currency, dates). The
 * value-bearing edits happen on line items + components, which use
 * modal forms with explicit Save. So the §6 belt-and-braces concern
 * doesn't apply to the header.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Select, Textarea, Badge, EmptyState } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { STATUS_TONE, STATUS_LABEL } from './index.jsx';

const STATUS_OPTIONS = [
  { value: 'draft',      label: 'Draft' },
  { value: 'ordered',    label: 'Ordered' },
  { value: 'in_transit', label: 'In transit' },
  { value: 'received',   label: 'Received' },
  { value: 'closed',     label: 'Closed' },
];

const ALLOCATION_BASES = [
  { value: 'by_value',      label: 'By value (proportional to line $)' },
  { value: 'by_volume',     label: 'By volume (CBM) — needs carton dims' },
  { value: 'by_weight',     label: 'By weight (kg) — needs unit weight' },
  { value: 'flat_per_line', label: 'Flat per line (split evenly)' },
];

const COMPONENT_KINDS = [
  'freight', 'insurance', 'duty', 'clearance', 'handling', 'inland',
  'inspection', 'discount', 'other',
];

export function PODetail({ poId, onBack }) {
  const addToast = useAppStore((s) => s.addToast);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [addingLine, setAddingLine] = useState(false);
  const [addingComponent, setAddingComponent] = useState(false);
  const [editingLine, setEditingLine] = useState(null);
  const [editingComponent, setEditingComponent] = useState(null);

  const header = detail?.header || null;

  // Load the detail + a product list (for the Add Line picker). The
  // product list is per-company, and the PO header carries the company.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.api.purchaseOrders.getDetail(poId)
      .then(async (d) => {
        if (cancelled) return;
        setDetail(d);
        if (d?.header?.companyId) {
          const list = await window.api.products.list(d.header.companyId, {}).catch(() => []);
          if (!cancelled) setProducts(Array.isArray(list) ? list : []);
        }
      })
      .catch((err) => { if (!cancelled) addToast(`Failed to load PO: ${err.message}`, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [poId, addToast]);

  function applySnapshot(snap) {
    if (!snap) return;
    setDetail(snap);
  }

  async function saveHeaderPatch(patch) {
    try {
      const updated = await window.api.purchaseOrders.update(poId, patch);
      // Header-only update returns a header, not detail. Refetch the
      // full detail to keep lines/components in lockstep with whatever
      // the recompute did to per-line caches.
      const fresh = await window.api.purchaseOrders.getDetail(poId);
      applySnapshot(fresh);
    } catch (err) {
      addToast(`Failed to save: ${err.message}`, 'error');
    }
  }

  async function changeStatus(newStatus) {
    if (!header) return;
    if (newStatus === header.status) return;
    let warnBody = null;
    if (newStatus === 'received') {
      warnBody = 'This will snapshot every line’s landed cost into each product’s cost history. You can roll this back by un-receiving the PO.';
    } else if (header.status === 'received' && newStatus !== 'received') {
      warnBody = 'This PO was already received. Reverting will drop its contribution to each product’s landed-cost cache.';
    }
    if (warnBody) {
      const sure = await confirm({
        title: `Change status to "${STATUS_LABEL(newStatus)}"?`,
        body: warnBody,
        confirmLabel: 'Change status',
      });
      if (!sure) return;
    }
    try {
      await window.api.purchaseOrders.setStatus(poId, newStatus);
      const fresh = await window.api.purchaseOrders.getDetail(poId);
      applySnapshot(fresh);
      addToast(`Status set to ${STATUS_LABEL(newStatus)}`, 'success');
    } catch (err) {
      addToast(`Failed to change status: ${err.message}`, 'error');
    }
  }

  async function addLine(input) {
    try {
      const snap = await window.api.purchaseOrders.addLine(poId, input);
      applySnapshot(snap);
      setAddingLine(false);
      addToast('Line added', 'success');
    } catch (err) {
      addToast(`Failed to add line: ${err.message}`, 'error');
    }
  }
  async function updateLine(lineId, patch) {
    try {
      const snap = await window.api.purchaseOrders.updateLine(lineId, patch);
      applySnapshot(snap);
      setEditingLine(null);
      addToast('Line updated', 'success');
    } catch (err) {
      addToast(`Failed to update line: ${err.message}`, 'error');
    }
  }
  async function removeLine(line) {
    const sure = await confirm({
      title: 'Delete this line?',
      body: `Removes ${line.productSku || line.productName || 'this line'} from the PO. Cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      const snap = await window.api.purchaseOrders.removeLine(line.id);
      applySnapshot(snap);
      addToast('Line removed', 'success');
    } catch (err) {
      addToast(`Failed to remove line: ${err.message}`, 'error');
    }
  }

  async function addComponent(input) {
    try {
      const snap = await window.api.purchaseOrders.addComponent(poId, input);
      applySnapshot(snap);
      setAddingComponent(false);
      addToast('Cost component added', 'success');
    } catch (err) {
      addToast(`Failed to add component: ${err.message}`, 'error');
    }
  }
  async function updateComponent(componentId, patch) {
    try {
      const snap = await window.api.purchaseOrders.updateComponent(componentId, patch);
      applySnapshot(snap);
      setEditingComponent(null);
      addToast('Component updated', 'success');
    } catch (err) {
      addToast(`Failed to update component: ${err.message}`, 'error');
    }
  }
  async function removeComponent(c) {
    const sure = await confirm({
      title: 'Delete this cost component?',
      body: 'Removes the line from the PO’s cost breakdown.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      const snap = await window.api.purchaseOrders.removeComponent(c.id);
      applySnapshot(snap);
      addToast('Component removed', 'success');
    } catch (err) {
      addToast(`Failed to remove component: ${err.message}`, 'error');
    }
  }

  if (loading) return <div className="page page--pos"><div className="muted">Loading…</div></div>;
  if (!detail || !header) {
    return (
      <div className="page page--pos">
        <PageHeader
          title="Purchase order"
          actions={<Button variant="ghost" onClick={onBack}>← Back to list</Button>}
        />
        <EmptyState title="PO not found" body="It may have been deleted." />
      </div>
    );
  }

  const calc = detail.calc || {};
  const fillPct = detail.fillPct;
  const totalLanded = (Number(calc.totalValueUsd) || 0) + (Number(calc.totalComponentsUsd) || 0);

  return (
    <div className="page page--po-detail">
      <PageHeader
        title={`PO ${header.poNumber || '(no number)'}`}
        subtitle={`${header.supplierName || 'Unknown supplier'} • ${header.incoterm} • ${header.currency} → USD @ ${Number(header.exchangeRateToUsd).toFixed(4)}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={STATUS_TONE(header.status)}>{STATUS_LABEL(header.status)}</Badge>
            <Select
              value={header.status}
              onChange={(e) => changeStatus(e.target.value)}
              style={{ minWidth: 140 }}
            >
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
            <Button variant="ghost" onClick={onBack}>← Back to list</Button>
          </div>
        }
      />

      {/* Header — editable inline. */}
      <section className="po-section">
        <h3 className="po-section__title">Header</h3>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">PO number</span>
            <Input
              defaultValue={header.poNumber || ''}
              onBlur={(e) => saveHeaderPatch({ poNumber: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field__label">Currency</span>
            <Select
              defaultValue={header.currency}
              onChange={(e) => saveHeaderPatch({ currency: e.target.value })}
            >
              {['USD','CNY','THB','VND','KHR','EUR','JPY','KRW','INR','IDR','MYR','SGD'].map((c) =>
                <option key={c} value={c}>{c}</option>)}
            </Select>
          </label>
          <label className="field">
            <span className="field__label">FX rate (1 {header.currency} = ? USD)</span>
            <Input
              type="number"
              step="0.0001"
              min="0"
              defaultValue={header.exchangeRateToUsd}
              onBlur={(e) => saveHeaderPatch({
                exchangeRateToUsd: Number(e.target.value) || 0,
                exchangeRateDate: Date.now(),
              })}
            />
            <span className="field__hint">
              Updates re-snapshot every line’s USD unit price on the next mutation.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Incoterm</span>
            <Select
              defaultValue={header.incoterm}
              onChange={(e) => saveHeaderPatch({ incoterm: e.target.value })}
            >
              <option value="EXW">EXW</option>
              <option value="FOB">FOB</option>
              <option value="CFR">CFR / CNF</option>
              <option value="CIF">CIF</option>
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Container</span>
            <Select
              defaultValue={header.containerType || ''}
              onChange={(e) => saveHeaderPatch({ containerType: e.target.value || null })}
            >
              <option value="">— none —</option>
              <option value="20">20' standard (33.2 CBM)</option>
              <option value="40">40' standard (67.7 CBM)</option>
              <option value="40HQ">40' high cube (76.4 CBM)</option>
              <option value="LCL">LCL</option>
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Ordered on</span>
            <Input
              type="date"
              defaultValue={tsToDateInput(header.orderedAt)}
              onBlur={(e) => saveHeaderPatch({ orderedAt: dateInputToTs(e.target.value) })}
            />
          </label>
          <label className="field">
            <span className="field__label">ETA</span>
            <Input
              type="date"
              defaultValue={tsToDateInput(header.eta)}
              onBlur={(e) => saveHeaderPatch({ eta: dateInputToTs(e.target.value) })}
            />
          </label>
          <label className="field field--full">
            <span className="field__label">Notes</span>
            <Textarea
              defaultValue={header.notes || ''}
              onBlur={(e) => saveHeaderPatch({ notes: e.target.value })}
            />
          </label>
        </div>
      </section>

      {/* Line items. */}
      <section className="po-section">
        <header className="po-section__header">
          <h3 className="po-section__title">Line items ({detail.lines.length})</h3>
          <Button variant="primary" onClick={() => setAddingLine(true)}>Add line</Button>
        </header>
        {detail.lines.length === 0 && (
          <EmptyState
            title="No lines yet"
            body="Add the products on this PO with their supplier-currency unit prices."
          />
        )}
        {detail.lines.length > 0 && (
          <div className="pos-table-wrap">
            <table className="pos-table pos-table--lines">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th className="ralign">Qty</th>
                  <th className="ralign">Unit ({header.currency})</th>
                  <th className="ralign">Unit (USD)</th>
                  <th className="ralign">Cartons</th>
                  <th className="ralign">CBM</th>
                  <th className="ralign">+ Alloc / unit</th>
                  <th className="ralign">Landed / unit</th>
                  <th className="ralign">Line total USD</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => {
                  const c = line.calc || {};
                  return (
                    <tr key={line.id}>
                      <td><strong>{line.productSku || '—'}</strong></td>
                      <td>{line.productName || '—'}</td>
                      <td className="ralign">{line.qty}</td>
                      <td className="ralign">{fmtNum(line.unitPriceSupplierCurrency, 4)}</td>
                      <td className="ralign">{fmtUsd(line.unitPriceUsdAtPo, 4)}</td>
                      <td className="ralign">{line.cartonQty ? Math.ceil(line.qty / line.cartonQty) : '—'}</td>
                      <td className="ralign">{c.volumeCbm ? c.volumeCbm.toFixed(3) : '—'}</td>
                      <td className="ralign">{fmtUsd(c.allocatedCostUsdPerUnit, 4)}</td>
                      <td className="ralign"><strong>{fmtUsd(c.landedUnitCostUsd, 4)}</strong></td>
                      <td className="ralign">{fmtUsd((c.landedUnitCostUsd || 0) * (Number(line.qty) || 0))}</td>
                      <td className="ralign">
                        <Button variant="ghost" onClick={() => setEditingLine(line)}>Edit</Button>
                        <Button variant="ghost" onClick={() => removeLine(line)}>×</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cost components. */}
      <section className="po-section">
        <header className="po-section__header">
          <h3 className="po-section__title">Cost components ({detail.components.length})</h3>
          <Button variant="primary" onClick={() => setAddingComponent(true)}>Add cost</Button>
        </header>
        <p className="muted">
          Freight, insurance, duty, clearance, handling — whatever isn’t in the unit
          price. Each gets allocated across line items by value, volume, weight, or flat
          split.
        </p>
        {detail.components.length === 0 && (
          <EmptyState
            title="No cost components yet"
            body="Add the costs that get layered on top of unit prices to get the true landed cost."
          />
        )}
        {detail.components.length > 0 && (
          <div className="pos-table-wrap">
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Label</th>
                  <th className="ralign">Amount ({header.currency})</th>
                  <th className="ralign">Amount (USD)</th>
                  <th>Allocation</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {detail.components.map((c) => (
                  <tr key={c.id}>
                    <td>{c.kind}</td>
                    <td>{c.label || '—'}</td>
                    <td className="ralign">{fmtNum(c.amountSupplierCurrency, 2)}</td>
                    <td className="ralign">{fmtUsd(c.amountUsd)}</td>
                    <td>{ALLOCATION_BASES.find((a) => a.value === c.allocationBasis)?.label || c.allocationBasis}</td>
                    <td className="ralign">
                      <Button variant="ghost" onClick={() => setEditingComponent(c)}>Edit</Button>
                      <Button variant="ghost" onClick={() => removeComponent(c)}>×</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Summary. */}
      <section className="po-section po-summary">
        <h3 className="po-section__title">Landed cost summary</h3>
        <div className="po-summary__grid">
          <SummaryStat label="Goods value (USD)" value={fmtUsd(calc.totalValueUsd)} />
          <SummaryStat label="Cost components (USD)" value={fmtUsd(calc.totalComponentsUsd)} />
          <SummaryStat label="Total landed (USD)" value={fmtUsd(totalLanded)} emphasis />
          <SummaryStat label="Total volume (CBM)" value={(calc.totalVolumeCbm || 0).toFixed(3)} />
          <SummaryStat label="Total weight (kg)" value={(calc.totalWeightKg || 0).toFixed(2)} />
          <SummaryStat
            label={`Container fill (${header.containerType || '—'})`}
            value={fillPct == null ? '—' : `${fillPct.toFixed(1)}%`}
            tone={fillPct == null ? null : fillPct > 100 ? 'rose' : fillPct > 90 ? 'amber' : 'emerald'}
          />
        </div>
        {detail.warnings && detail.warnings.length > 0 && (
          <div className="po-warnings">
            {detail.warnings.map((w, i) => (
              <div key={i} className="po-warning">{w}</div>
            ))}
          </div>
        )}
      </section>

      {addingLine && (
        <LineModal
          mode="create"
          currency={header.currency}
          products={products}
          onCancel={() => setAddingLine(false)}
          onSave={addLine}
        />
      )}
      {editingLine && (
        <LineModal
          mode="edit"
          currency={header.currency}
          line={editingLine}
          products={products}
          onCancel={() => setEditingLine(null)}
          onSave={(patch) => updateLine(editingLine.id, patch)}
        />
      )}
      {addingComponent && (
        <ComponentModal
          mode="create"
          currency={header.currency}
          incoterm={header.incoterm}
          onCancel={() => setAddingComponent(false)}
          onSave={addComponent}
        />
      )}
      {editingComponent && (
        <ComponentModal
          mode="edit"
          currency={header.currency}
          incoterm={header.incoterm}
          component={editingComponent}
          onCancel={() => setEditingComponent(null)}
          onSave={(patch) => updateComponent(editingComponent.id, patch)}
        />
      )}
    </div>
  );
}

function SummaryStat({ label, value, tone, emphasis }) {
  return (
    <div className={`po-stat${emphasis ? ' po-stat--emphasis' : ''}`}>
      <div className="po-stat__label">{label}</div>
      <div className={`po-stat__value${tone ? ` po-stat__value--${tone}` : ''}`}>{value}</div>
    </div>
  );
}

function LineModal({ mode, currency, line, products, onCancel, onSave }) {
  const initial = line || {};
  const [productId, setProductId]   = useState(initial.productId || '');
  const [supplierSku, setSupplierSku] = useState(initial.supplierSku || '');
  const [qty, setQty]               = useState(initial.qty ?? '');
  const [unitPrice, setUnitPrice]   = useState(initial.unitPriceSupplierCurrency ?? '');
  const [cartonQty, setCartonQty]   = useState(initial.cartonQty ?? '');
  const [cartonW, setCartonW]       = useState(initial.cartonWCm ?? '');
  const [cartonH, setCartonH]       = useState(initial.cartonHCm ?? '');
  const [cartonD, setCartonD]       = useState(initial.cartonDCm ?? '');
  const [weightKg, setWeightKg]     = useState(initial.weightPerUnitKg ?? '');
  const [notes, setNotes]           = useState(initial.notes || '');

  // When the user picks a product in create mode, prefill its
  // carton + weight defaults if it has them.
  useEffect(() => {
    if (mode !== 'create' || !productId) return;
    const p = products.find((x) => x.id === productId);
    if (!p) return;
    if (p.cartonQty && !cartonQty)    setCartonQty(p.cartonQty);
    if (p.cartonWCm && !cartonW)      setCartonW(p.cartonWCm);
    if (p.cartonHCm && !cartonH)      setCartonH(p.cartonHCm);
    if (p.cartonDCm && !cartonD)      setCartonD(p.cartonDCm);
    if (p.weightPerUnitKg && !weightKg) setWeightKg(p.weightPerUnitKg);
    if (p.supplierSku && !supplierSku) setSupplierSku(p.supplierSku);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  function submit() {
    const payload = {
      productId,
      supplierSku: supplierSku || null,
      qty: Number(qty) || 0,
      unitPriceSupplierCurrency: Number(unitPrice) || 0,
      cartonQty: cartonQty === '' ? null : Number(cartonQty),
      cartonWCm: cartonW === '' ? null : Number(cartonW),
      cartonHCm: cartonH === '' ? null : Number(cartonH),
      cartonDCm: cartonD === '' ? null : Number(cartonD),
      weightPerUnitKg: weightKg === '' ? null : Number(weightKg),
      notes,
    };
    if (mode === 'edit') {
      // Edit doesn't change productId — only the editable fields.
      delete payload.productId;
    }
    onSave(payload);
  }

  const canSubmit = (mode === 'edit' || productId) && qty !== '' && Number(qty) > 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal--lg" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>{mode === 'create' ? 'Add line item' : 'Edit line item'}</h2>
          <button className="modal__close" aria-label="Close (Esc)" title="Close (Esc)" onClick={onCancel}>×</button>
        </header>
        <div className="modal__body">
          <div className="form-grid">
            {mode === 'create' && (
              <label className="field field--full">
                <span className="field__label">Product *</span>
                <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
                  <option value="">Choose…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} — {p.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className="field">
              <span className="field__label">Supplier SKU</span>
              <Input value={supplierSku} onChange={(e) => setSupplierSku(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Qty *</span>
              <Input type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Unit price ({currency})</span>
              <Input type="number" min="0" step="0.0001" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Units per carton</span>
              <Input type="number" min="0" step="1" value={cartonQty} onChange={(e) => setCartonQty(e.target.value)} />
              <span className="field__hint">Used for CBM allocation + container fill.</span>
            </label>
            <label className="field">
              <span className="field__label">Carton W (cm)</span>
              <Input type="number" min="0" step="0.1" value={cartonW} onChange={(e) => setCartonW(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Carton H (cm)</span>
              <Input type="number" min="0" step="0.1" value={cartonH} onChange={(e) => setCartonH(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Carton D (cm)</span>
              <Input type="number" min="0" step="0.1" value={cartonD} onChange={(e) => setCartonD(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Weight per unit (kg)</span>
              <Input type="number" min="0" step="0.001" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} />
            </label>
            <label className="field field--full">
              <span className="field__label">Notes</span>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
        </div>
        <footer className="modal__footer">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>Save</Button>
        </footer>
      </div>
    </div>
  );
}

// v0.49.49: which component kinds an Incoterm already includes in the
// supplier's unit price (mirrors main/util/landedCost.js INCOTERM_INCLUDED).
// Used for a live warning as the user picks a kind, before they even save.
const INCOTERM_INCLUDES = {
  EXW: [],
  FOB: ['inland'],
  CFR: ['freight'],
  CNF: ['freight'],
  CIF: ['freight', 'insurance'],
};

function ComponentModal({ mode, currency, incoterm, component, onCancel, onSave }) {
  const initial = component || {};
  const [kind, setKind]               = useState(initial.kind || 'freight');
  const [label, setLabel]             = useState(initial.label || '');
  const [amount, setAmount]           = useState(initial.amountSupplierCurrency ?? '');
  const [allocationBasis, setBasis]   = useState(initial.allocationBasis || 'by_value');
  const [notes, setNotes]             = useState(initial.notes || '');

  // Live Incoterm double-count notice for the currently-selected kind.
  const incotermNorm = String(incoterm || '').toUpperCase().replace('CNF', 'CFR');
  const includedKinds = INCOTERM_INCLUDES[incotermNorm] || [];
  const kindConflicts = includedKinds.includes(String(kind).toLowerCase());

  function submit() {
    onSave({
      kind,
      label: label.trim() || null,
      amountSupplierCurrency: Number(amount) || 0,
      allocationBasis,
      notes,
    });
  }
  const canSubmit = kind && amount !== '' && Number(amount) >= 0;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal--md" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>{mode === 'create' ? 'Add cost component' : 'Edit cost component'}</h2>
          <button className="modal__close" aria-label="Close (Esc)" title="Close (Esc)" onClick={onCancel}>×</button>
        </header>
        <div className="modal__body">
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Kind *</span>
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {COMPONENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Amount ({currency}) *</span>
              <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            {kindConflicts && (
              <div className="field field--full po-incoterm-note">
                Heads up — this PO is <strong>{incotermNorm}</strong>, which normally already
                includes <strong>{String(kind).toLowerCase()}</strong> in the supplier&apos;s
                unit price.{' '}
                {incotermNorm === 'FOB'
                  ? 'If this is destination-side inland haulage, it’s fine to add.'
                  : 'Adding it here may double-count the cost.'}
              </div>
            )}
            <label className="field field--full">
              <span className="field__label">Label / description</span>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sea freight Shenzhen→Sihanoukville" />
            </label>
            <label className="field field--full">
              <span className="field__label">Allocation basis *</span>
              <Select value={allocationBasis} onChange={(e) => setBasis(e.target.value)}>
                {ALLOCATION_BASES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </Select>
              <span className="field__hint">
                How this cost gets split across line items. By value is the safe default.
                Volume / weight only work if every line has carton dims or per-unit weight.
              </span>
            </label>
            <label className="field field--full">
              <span className="field__label">Notes</span>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
        </div>
        <footer className="modal__footer">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>Save</Button>
        </footer>
      </div>
    </div>
  );
}

/* ─── utils ─────────────────────────────────────────────────────── */

function fmtUsd(n, decimals = 2) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function fmtNum(n, decimals = 2) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function tsToDateInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
function dateInputToTs(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
