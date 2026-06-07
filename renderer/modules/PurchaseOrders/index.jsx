/**
 * v0.49.47 — Purchase Orders module.
 *
 * Phase 2 of the costing system. A PO has a header (supplier, currency,
 * exchange rate, container type, status, dates), a list of line items
 * (product + qty + supplier-currency unit price + carton info), and a
 * list of cost components (freight, insurance, duty, etc. with an
 * allocation basis). The backend recomputes landed cost on every edit
 * and caches per-product latest/3mo/12mo costs once the PO is received.
 *
 * UX shape: list page ↔ detail page swap inside the module via local
 * state — no router change. The list shows status pill + supplier +
 * dates + total USD. Clicking opens the detail. The detail has tabs
 * for Lines / Cost components / Summary, but on a desktop screen they
 * stack into a single scrollable page rather than tabs — there's
 * enough screen space and the user wants to see the landed-cost
 * summary update as they edit lines.
 *
 * Status flow: draft → ordered → in_transit → received → closed.
 * Status pills are color-coded; clicking the pill opens a small menu
 * with the legal next states. Going to "received" snapshots landed
 * cost into product_landed_costs (handled by the DB layer); the UI
 * just calls setStatus + toasts on success.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Pagination, paginate, Badge, Select, Input } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { PODetail } from './PODetail.jsx';

const STATUS_FILTERS = [
  { value: 'all',        label: 'All' },
  { value: 'draft',      label: 'Draft' },
  { value: 'ordered',    label: 'Ordered' },
  { value: 'in_transit', label: 'In transit' },
  { value: 'received',   label: 'Received' },
  { value: 'closed',     label: 'Closed' },
];

export function STATUS_TONE(status) {
  switch (status) {
    case 'draft':      return 'slate';
    case 'ordered':    return 'sky';
    case 'in_transit': return 'amber';
    case 'received':   return 'emerald';
    case 'closed':     return 'slate';
    default:           return 'slate';
  }
}

export function STATUS_LABEL(status) {
  switch (status) {
    case 'draft':      return 'Draft';
    case 'ordered':    return 'Ordered';
    case 'in_transit': return 'In transit';
    case 'received':   return 'Received';
    case 'closed':     return 'Closed';
    default:           return status || '—';
  }
}

export function PurchaseOrders() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  // v0.49.48: pending cross-module navigation (from Library Cost column
  // or Suppliers "Orders" button). Consumed once on mount.
  const pendingPoId = useAppStore((s) => s.pendingPoId);
  const pendingPoSupplierId = useAppStore((s) => s.pendingPoSupplierId);
  const clearPendingPoNav = useAppStore((s) => s.clearPendingPoNav);

  const [rows, setRows] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [supplierFilter, setSupplierFilter] = useState(pendingPoSupplierId || '');
  const [statusFilter, setStatusFilter] = useState('all');
  const [openPoId, setOpenPoId] = useState(pendingPoId || null); // null = list view; id = detail
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // Consume the pending-nav intent exactly once, then clear it so a later
  // manual return to this module doesn't re-trigger the jump.
  useEffect(() => {
    if (pendingPoId || pendingPoSupplierId) clearPendingPoNav();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeCompanyId) { setSuppliers([]); return; }
    window.api.suppliers.list(activeCompanyId, { status: 'all' })
      .then((list) => setSuppliers(Array.isArray(list) ? list : []))
      .catch(() => setSuppliers([]));
  }, [activeCompanyId]);

  // 200ms debounce same as Suppliers — keeps client mode quiet on fast
  // typists.
  useEffect(() => {
    if (!activeCompanyId) { setRows([]); setLoading(false); return undefined; }
    setLoading(true);
    const t = setTimeout(() => {
      window.api.purchaseOrders.list(activeCompanyId, {
        search,
        supplierId: supplierFilter || undefined,
        status: statusFilter,
      })
        .then((list) => setRows(Array.isArray(list) ? list : []))
        .catch((err) => { addToast(`Failed to load POs: ${err.message}`, 'error'); setRows([]); })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [activeCompanyId, search, supplierFilter, statusFilter, addToast]);

  const { currentPage, maxPage, pageStart, pageEnd, total } = useMemo(
    () => paginate(rows.length, page, pageSize),
    [rows.length, page, pageSize],
  );
  const visibleRows = useMemo(() => rows.slice(pageStart, pageEnd), [rows, pageStart, pageEnd]);

  function refreshList() {
    if (!activeCompanyId) return;
    window.api.purchaseOrders.list(activeCompanyId, {
      search, supplierId: supplierFilter || undefined, status: statusFilter,
    }).then((list) => setRows(Array.isArray(list) ? list : []))
      .catch(() => { /* surfaced separately */ });
  }

  async function handleCreate(payload) {
    try {
      const created = await window.api.purchaseOrders.create({
        companyId: activeCompanyId,
        ...payload,
      });
      addToast('Purchase order created', 'success');
      setCreating(false);
      setOpenPoId(created.id);
      refreshList();
    } catch (err) {
      addToast(`Failed to create PO: ${err.message}`, 'error');
    }
  }

  async function handleRemove(po) {
    const sure = await confirm({
      title: `Delete PO ${po.poNumber || '(no number)'}?`,
      body: po.status === 'received'
        ? 'This PO is already received — deleting it will roll back its contribution to landed cost for every product it touched. This cannot be undone.'
        : 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      await window.api.purchaseOrders.remove(po.id);
      addToast('PO deleted', 'success');
      refreshList();
    } catch (err) {
      addToast(`Failed to delete PO: ${err.message}`, 'error');
    }
  }

  // Detail mode renders entirely inside PODetail.
  if (openPoId) {
    return (
      <PODetail
        poId={openPoId}
        onBack={() => { setOpenPoId(null); refreshList(); }}
        suppliers={suppliers}
      />
    );
  }

  return (
    <div className="page page--pos">
      <PageHeader
        title="Purchase Orders"
        subtitle="Track orders from overseas suppliers + their landed cost."
        actions={
          <Button
            variant="primary"
            disabled={!activeCompanyId || suppliers.length === 0}
            onClick={() => setCreating(true)}
          >
            New purchase order
          </Button>
        }
      />

      {!activeCompanyId && (
        <EmptyState
          title="No company selected"
          body="Pick a company from the sidebar to start tracking purchase orders."
        />
      )}
      {activeCompanyId && suppliers.length === 0 && (
        <EmptyState
          title="Add a supplier first"
          body="POs are tied to a supplier — head to the Suppliers page and create one before recording a purchase order."
        />
      )}
      {activeCompanyId && suppliers.length > 0 && (
        <>
          <div className="pos-toolbar">
            <Input
              placeholder="Search by PO number or supplier name…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
            <Select
              value={supplierFilter}
              onChange={(e) => { setSupplierFilter(e.target.value); setPage(0); }}
            >
              <option value="">All suppliers</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
            >
              {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          </div>

          {loading && <div className="muted">Loading…</div>}
          {!loading && rows.length === 0 && (
            <EmptyState
              title="No purchase orders yet"
              body="Click 'New purchase order' to record your first one."
            />
          )}
          {!loading && rows.length > 0 && (
            <div className="pos-table-wrap">
              <table className="pos-table">
                <thead>
                  <tr>
                    <th>PO #</th>
                    <th>Supplier</th>
                    <th>Status</th>
                    <th>Incoterm</th>
                    <th>Currency</th>
                    <th className="ralign">Lines</th>
                    <th className="ralign">Total USD</th>
                    <th>Ordered</th>
                    <th>Received</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((po) => (
                    <tr
                      key={po.id}
                      className="pos-row"
                      onClick={() => setOpenPoId(po.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td><strong>{po.poNumber || '(no number)'}</strong></td>
                      <td>{po.supplierName || '—'}</td>
                      <td><Badge tone={STATUS_TONE(po.status)}>{STATUS_LABEL(po.status)}</Badge></td>
                      <td>{po.incoterm || '—'}</td>
                      <td>{po.currency || '—'}</td>
                      <td className="ralign">{po.linesCount || 0}</td>
                      <td className="ralign">{fmtUsd(po.totalValueUsd + (po.totalComponentsUsd || 0))}</td>
                      <td>{fmtDate(po.orderedAt)}</td>
                      <td>{fmtDate(po.receivedAt)}</td>
                      <td className="ralign" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" onClick={() => handleRemove(po)}>Delete</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && rows.length > 0 && (
            <Pagination
              currentPage={currentPage}
              maxPage={maxPage}
              pageSize={pageSize}
              total={total}
              pageStart={pageStart}
              pageEnd={pageEnd}
              onPage={setPage}
              onPageSize={(n) => { setPageSize(n); setPage(0); }}
            />
          )}
        </>
      )}

      {creating && (
        <NewPOModal
          suppliers={suppliers}
          onCancel={() => setCreating(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

/**
 * Slim create-PO modal — supplier, optional PO number, currency,
 * exchange rate, container type, incoterm. Everything else (lines,
 * components, status flow) happens on the detail page.
 */
function NewPOModal({ suppliers, onCancel, onCreate }) {
  // Default to the first supplier so the currency / incoterm prefills
  // are sensible without the user having to pick again.
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id || '');
  const supplier = suppliers.find((s) => s.id === supplierId) || null;
  const [poNumber, setPoNumber] = useState('');
  const [currency, setCurrency] = useState(supplier?.defaultCurrency || 'USD');
  const [incoterm, setIncoterm] = useState(supplier?.defaultIncoterm || 'FOB');
  const [exchangeRateToUsd, setExchangeRateToUsd] = useState(currency === 'USD' ? 1 : '');
  const [containerType, setContainerType] = useState('40HQ');
  const [orderedAt, setOrderedAt] = useState(new Date().toISOString().slice(0, 10));

  // Re-prefill currency/incoterm when supplier changes.
  useEffect(() => {
    if (!supplier) return;
    setCurrency(supplier.defaultCurrency || 'USD');
    setIncoterm(supplier.defaultIncoterm || 'FOB');
    if ((supplier.defaultCurrency || 'USD') === 'USD') setExchangeRateToUsd(1);
  }, [supplier]);

  function submit() {
    onCreate({
      supplierId,
      poNumber: poNumber.trim() || null,
      currency,
      exchangeRateToUsd: Number(exchangeRateToUsd) || (currency === 'USD' ? 1 : 0),
      exchangeRateDate: Date.now(),
      incoterm,
      containerType,
      orderedAt: orderedAt ? new Date(orderedAt).getTime() : null,
      status: 'draft',
    });
  }

  const canSubmit = supplierId && (currency === 'USD' ? true : Number(exchangeRateToUsd) > 0);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal--md" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>New purchase order</h2>
          <button className="modal__close" aria-label="Close (Esc)" title="Close (Esc)" onClick={onCancel}>×</button>
        </header>
        <div className="modal__body">
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Supplier *</span>
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Choose…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </label>
            <label className="field">
              <span className="field__label">PO number</span>
              <Input
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="e.g. PO-2026-001"
              />
            </label>
            <label className="field">
              <span className="field__label">Currency</span>
              <Select value={currency} onChange={(e) => {
                const v = e.target.value;
                setCurrency(v);
                if (v === 'USD') setExchangeRateToUsd(1);
                else if (exchangeRateToUsd === 1) setExchangeRateToUsd('');
              }}>
                {['USD','CNY','THB','VND','KHR','EUR','JPY','KRW','INR','IDR','MYR','SGD'].map((c) =>
                  <option key={c} value={c}>{c}</option>)}
              </Select>
            </label>
            <label className="field">
              <span className="field__label">
                Exchange rate (1 {currency} = ? USD)
              </span>
              <Input
                type="number"
                step="0.0001"
                min="0"
                value={exchangeRateToUsd}
                disabled={currency === 'USD'}
                onChange={(e) => setExchangeRateToUsd(e.target.value)}
                placeholder={currency === 'USD' ? '1.0000' : 'e.g. 0.14 for THB→USD'}
              />
              <span className="field__hint">
                Locks the FX rate for this PO. All landed-cost numbers convert to USD using this rate.
              </span>
            </label>
            <label className="field">
              <span className="field__label">Incoterm</span>
              <Select value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
                <option value="EXW">EXW — ex-works</option>
                <option value="FOB">FOB — free on board</option>
                <option value="CFR">CFR / CNF — cost & freight</option>
                <option value="CIF">CIF — cost, insurance, freight</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Container</span>
              <Select value={containerType} onChange={(e) => setContainerType(e.target.value)}>
                <option value="20">20' standard (33.2 CBM)</option>
                <option value="40">40' standard (67.7 CBM)</option>
                <option value="40HQ">40' high cube (76.4 CBM)</option>
                <option value="LCL">LCL — less than container load</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Ordered on</span>
              <Input
                type="date"
                value={orderedAt}
                onChange={(e) => setOrderedAt(e.target.value)}
              />
            </label>
          </div>
        </div>
        <footer className="modal__footer">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>Create</Button>
        </footer>
      </div>
    </div>
  );
}

function fmtUsd(n) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}
