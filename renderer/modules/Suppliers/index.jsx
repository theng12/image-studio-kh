/**
 * v0.49.46: Suppliers — Phase 1 of the costing system.
 *
 * Lean implementation: table list + modal form. Once POs exist
 * (v0.49.47) the supplier row will gain a "PO history" link + a
 * total-spend chip; today it's just contact + currency + Incoterm
 * defaults. Search box filters by name / country (case-insensitive,
 * with escaped LIKE meta-chars server-side). Active / archived
 * filter via a small chip toggle in the header — archived suppliers
 * keep their PO history but stop showing in the create-PO picker.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Modal, Field, Select, EmptyState, Pagination, paginate, Textarea } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

const COMMON_CURRENCIES = ['USD', 'CNY', 'THB', 'VND', 'KHR', 'EUR', 'JPY', 'KRW', 'INR', 'IDR', 'MYR', 'SGD'];
const INCOTERMS = [
  { value: '',    label: '(none — set per PO)' },
  { value: 'EXW', label: 'EXW — ex-works (buyer pays everything from factory gate)' },
  { value: 'FOB', label: 'FOB — free on board (buyer pays from origin port)' },
  { value: 'CFR', label: 'CFR / CNF — cost & freight (supplier covers freight, buyer covers insurance + duty)' },
  { value: 'CIF', label: 'CIF — cost, insurance, freight (supplier covers freight + insurance; buyer covers duty)' },
];

const EMPTY_FORM = {
  name: '',
  country: '',
  defaultCurrency: 'USD',
  defaultIncoterm: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  website: '',
  address: '',
  notes: '',
  status: 'active',
};

export function Suppliers() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  // v0.49.48: jump to the PO list filtered by this supplier.
  const openPurchaseOrdersForSupplier = useAppStore((s) => s.openPurchaseOrdersForSupplier);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // 'active' | 'archived' | 'all'
  const [editing, setEditing] = useState(null); // null = closed, 'new' = create, object = edit
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  // v0.49.48: per-supplier PO spend rollup, keyed by supplierId →
  // { poCount, receivedCount, totalSpendUsd, lastOrderedAt }. Fetched once
  // per company; refreshed when the supplier list reloads.
  const [spend, setSpend] = useState({});

  useEffect(() => {
    if (!activeCompanyId) { setSpend({}); return; }
    window.api.purchaseOrders.supplierSpendRollup(activeCompanyId)
      .then((m) => setSpend(m && typeof m === 'object' ? m : {}))
      .catch(() => setSpend({}));
  }, [activeCompanyId, rows.length]);

  // Fetch whenever the company / status filter / search changes. The
  // search runs server-side (LIKE on name + country), so debounce by
  // 200ms — same pattern v0.49.38 added to Library search to dodge
  // the keystroke-storm + out-of-order-response race on client mode.
  useEffect(() => {
    if (!activeCompanyId) {
      setRows([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(() => {
      window.api.suppliers.list(activeCompanyId, { search, status: statusFilter })
        .then((list) => { setRows(Array.isArray(list) ? list : []); })
        .catch((err) => { addToast(`Failed to load suppliers: ${err.message}`, 'error'); setRows([]); })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [activeCompanyId, search, statusFilter, addToast]);

  const { currentPage, maxPage, pageStart, pageEnd, total } = useMemo(
    () => paginate(rows.length, page, pageSize),
    [rows.length, page, pageSize],
  );
  const visibleRows = useMemo(() => rows.slice(pageStart, pageEnd), [rows, pageStart, pageEnd]);

  async function refresh() {
    if (!activeCompanyId) return;
    try {
      const list = await window.api.suppliers.list(activeCompanyId, { search, status: statusFilter });
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      addToast(`Refresh failed: ${err.message}`, 'error');
    }
  }

  async function handleSave(payload) {
    try {
      if (editing && editing.id) {
        await window.api.suppliers.update(editing.id, payload);
        addToast(`Saved ${payload.name}`, 'success');
      } else {
        await window.api.suppliers.create({ companyId: activeCompanyId, ...payload });
        addToast(`Created ${payload.name}`, 'success');
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleArchive() {
    if (!editing?.id) return;
    const ok = await confirm({
      title: `Archive "${editing.name}"?`,
      message: 'Archived suppliers stop appearing in the create-PO picker and the default supplier list, but their existing purchase order history stays intact. You can unarchive at any time.',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    try {
      await window.api.suppliers.archive(editing.id);
      addToast('Supplier archived', 'info');
      setEditing(null);
      await refresh();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleUnarchive() {
    if (!editing?.id) return;
    try {
      await window.api.suppliers.unarchive(editing.id);
      addToast('Supplier restored', 'success');
      setEditing(null);
      await refresh();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDelete() {
    if (!editing?.id) return;
    // The DB layer refuses delete when POs reference the supplier —
    // surface that as a confirm-then-try flow. If delete is blocked,
    // we offer archive instead.
    const ok = await confirm({
      title: `Delete "${editing.name}" permanently?`,
      message: 'Deleting removes the supplier completely. If any purchase order references this supplier the delete will fail — use Archive instead in that case.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await window.api.suppliers.remove(editing.id);
      addToast('Supplier deleted', 'success');
      setEditing(null);
      await refresh();
    } catch (err) {
      // Common path: DB layer reports the FK-restrict error with the
      // "Archive instead" hint. Show as info, not error.
      addToast(err.message, 'info');
    }
  }

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="Suppliers" subtitle="Pick a company to manage its suppliers." />
        <EmptyState message="No company selected. Choose one from the sidebar above to see its suppliers." />
      </div>
    );
  }

  return (
    <div className="page page--suppliers">
      <PageHeader
        title="Suppliers"
        subtitle="Vendors you buy stock from. Used by Purchase Orders for cost tracking + landed-cost calc."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>+ New supplier</Button>
        }
      />

      <div className="suppliers-toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="search-input"
            placeholder="Search supplier name or country…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>
        <div className="ws-toolbar__group" role="tablist" aria-label="Filter by status">
          {['active', 'archived', 'all'].map((s) => (
            <button
              key={s}
              type="button"
              className={`segment${statusFilter === s ? ' is-active' : ''}`}
              onClick={() => { setStatusFilter(s); setPage(0); }}
            >
              {s === 'active' ? 'Active' : s === 'archived' ? 'Archived' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="muted" style={{ padding: 'var(--s-5)' }}>Loading…</div>
      ) : total === 0 ? (
        <EmptyState
          message={search
            ? `No suppliers match "${search}".`
            : statusFilter === 'archived'
              ? 'No archived suppliers.'
              : 'No suppliers yet. Add your first one — you\'ll be able to attach Purchase Orders to it once v0.49.47 ships.'}
        />
      ) : (
        <>
          <div className="suppliers-table-wrap">
            <table className="suppliers-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Country</th>
                  <th>Currency</th>
                  <th>Default Incoterm</th>
                  <th>Contact</th>
                  <th>Orders</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => setEditing(s)}
                    className={`suppliers-row${s.status === 'archived' ? ' is-archived' : ''}`}
                  >
                    <td><strong>{s.name}</strong></td>
                    <td>{s.country || <span className="muted">—</span>}</td>
                    <td><code>{s.defaultCurrency}</code></td>
                    <td>{s.defaultIncoterm || <span className="muted">—</span>}</td>
                    <td>
                      {s.contactName ? <>{s.contactName}</> : null}
                      {s.contactEmail ? (
                        <>{s.contactName ? <span className="muted"> · </span> : null}<a href={`mailto:${s.contactEmail}`} onClick={(e) => e.stopPropagation()}>{s.contactEmail}</a></>
                      ) : null}
                      {!s.contactName && !s.contactEmail ? <span className="muted">—</span> : null}
                    </td>
                    <td className="suppliers-orders" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const r = spend[s.id];
                        const count = r?.poCount || 0;
                        if (count === 0) return <span className="muted">No orders</span>;
                        return (
                          <button
                            type="button"
                            className="supplier-orders-btn"
                            title={`View ${count} purchase order${count === 1 ? '' : 's'} — ${r.receivedCount} received`}
                            onClick={() => openPurchaseOrdersForSupplier(s.id)}
                          >
                            <span className="supplier-orders-btn__count">{count} PO{count === 1 ? '' : 's'}</span>
                            <span className="supplier-orders-btn__spend">{fmtSpend(r.totalSpendUsd)}</span>
                          </button>
                        );
                      })()}
                    </td>
                    <td>
                      {s.status === 'archived'
                        ? <span className="badge badge--slate">archived</span>
                        : <span className="badge badge--emerald">active</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            total={total}
            pageStart={pageStart}
            pageEnd={pageEnd}
            currentPage={currentPage}
            maxPage={maxPage}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}

      <SupplierFormModal
        open={editing !== null}
        editing={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSave={handleSave}
        onArchive={editing && editing !== 'new' && editing.status === 'active' ? handleArchive : null}
        onUnarchive={editing && editing !== 'new' && editing.status === 'archived' ? handleUnarchive : null}
        onDelete={editing && editing !== 'new' ? handleDelete : null}
      />
    </div>
  );
}

function SupplierFormModal({ open, editing, onClose, onSave, onArchive, onUnarchive, onDelete }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Re-seed the form whenever the modal opens with a different target.
  // Clearing on close too so a future open-as-new starts clean.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name:             editing.name             ?? '',
        country:          editing.country          ?? '',
        defaultCurrency:  editing.defaultCurrency  ?? 'USD',
        defaultIncoterm:  editing.defaultIncoterm  ?? '',
        contactName:      editing.contactName      ?? '',
        contactEmail:     editing.contactEmail     ?? '',
        contactPhone:     editing.contactPhone     ?? '',
        website:          editing.website          ?? '',
        address:          editing.address          ?? '',
        notes:            editing.notes            ?? '',
        status:           editing.status           ?? 'active',
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setSaving(false);
  }, [open, editing]);

  function patch(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target?.value ?? e }));
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        ...form,
        name:             form.name.trim(),
        country:          form.country.trim()       || null,
        defaultIncoterm:  form.defaultIncoterm      || null,
        contactName:      form.contactName.trim()   || null,
        contactEmail:     form.contactEmail.trim()  || null,
        contactPhone:     form.contactPhone.trim()  || null,
        website:          form.website.trim()       || null,
        address:          form.address.trim()       || null,
        notes:            form.notes.trim()         || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title={editing ? `Edit ${editing.name || 'supplier'}` : 'New supplier'}
      footer={
        <>
          {onDelete ? <Button variant="danger" onClick={onDelete} disabled={saving}>Delete</Button> : null}
          {onArchive ? <Button onClick={onArchive} disabled={saving}>Archive</Button> : null}
          {onUnarchive ? <Button onClick={onUnarchive} disabled={saving}>Unarchive</Button> : null}
          <div style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="supplier-form">
        <Field label="Supplier name" required>
          {({ id }) => (
            <Input id={id} value={form.name} onChange={patch('name')} placeholder="e.g. Foshan Ceramic Co." autoFocus />
          )}
        </Field>

        <div className="grid-2">
          <Field label="Country" hint="ISO code or country name — for grouping reports later.">
            {({ id }) => (
              <Input id={id} value={form.country} onChange={patch('country')} placeholder="e.g. CN, China, Thailand" />
            )}
          </Field>
          <Field label="Default currency" hint="Most POs from this supplier will use this currency. Per-PO currency can still be overridden.">
            {({ id }) => (
              <Select id={id} value={form.defaultCurrency} onChange={patch('defaultCurrency')}>
                {COMMON_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <Field label="Default Incoterm" hint="What the supplier covers by default. Most overseas factories quote FOB (you pay freight+insurance+duty); local distributors usually quote EXW. Per-PO Incoterm can still be overridden.">
          {({ id }) => (
            <Select id={id} value={form.defaultIncoterm} onChange={patch('defaultIncoterm')}>
              {INCOTERMS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
        </Field>

        <fieldset className="supplier-form__section">
          <legend>Contact</legend>
          <div className="grid-2">
            <Field label="Contact name">
              {({ id }) => <Input id={id} value={form.contactName} onChange={patch('contactName')} placeholder="e.g. Mr. Chen" />}
            </Field>
            <Field label="Email">
              {({ id }) => <Input id={id} type="email" value={form.contactEmail} onChange={patch('contactEmail')} placeholder="sales@example.com" />}
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Phone">
              {({ id }) => <Input id={id} type="tel" value={form.contactPhone} onChange={patch('contactPhone')} placeholder="+86 …" />}
            </Field>
            <Field label="Website">
              {({ id }) => <Input id={id} type="url" value={form.website} onChange={patch('website')} placeholder="https://…" />}
            </Field>
          </div>
          <Field label="Address" hint="Full ship-from address. Useful for shipment paperwork.">
            {({ id }) => <Textarea id={id} value={form.address} onChange={patch('address')} rows={2} />}
          </Field>
        </fieldset>

        <Field label="Notes" hint="Anything else you want to remember about this supplier — payment terms, MOQ, lead times, contact preferences.">
          {({ id }) => <Textarea id={id} value={form.notes} onChange={patch('notes')} rows={3} />}
        </Field>
      </form>
    </Modal>
  );
}

// v0.49.48: compact USD for the per-supplier spend chip. Rounds to whole
// dollars + uses k/M suffixes so a $1.2M supplier doesn't blow out the
// column width.
function fmtSpend(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000)    return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v).toLocaleString()}`;
}
