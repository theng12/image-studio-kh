import { useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Pagination, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { parseConflictError, showConflict } from '../../components/ConflictModal.jsx';
import { BrandForm } from './BrandForm.jsx';

export function Brands() {
  const brands = useAppStore((s) => s.brands);
  const brandsLoading = useAppStore((s) => s.brandsLoading);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const createBrand = useAppStore((s) => s.createBrand);
  const updateBrand = useAppStore((s) => s.updateBrand);
  const removeBrand = useAppStore((s) => s.removeBrand);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const addToast = useAppStore((s) => s.addToast);

  const [editing, setEditing] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const refreshBrands = useAppStore((s) => s.refreshBrands);

  const { currentPage, maxPage, pageStart, pageEnd } = useMemo(
    () => paginate(brands.length, page, pageSize),
    [brands.length, page, pageSize],
  );
  const visibleBrands = useMemo(() => brands.slice(pageStart, pageEnd), [brands, pageStart, pageEnd]);

  async function handleSubmit(payload) {
    if (editing && editing.id) {
      // v0.26.26: optimistic-concurrency on brand edits — same pattern
      // the ProductForm uses (v0.17.2 + the parse fix in v0.26.9). Pass
      // the row's `updatedAt` snapshot from when the form opened as
      // `expectedUpdatedAt`; if it changed server-side in the meantime,
      // brands.update throws `CONFLICT|<json>` which parseConflictError
      // surfaces as the shared refresh/overwrite/cancel modal instead
      // of a raw error toast.
      try {
        const updated = await updateBrand(editing.id, {
          ...payload,
          expectedUpdatedAt: editing.updatedAt,
        });
        addToast(`Saved ${updated.name}`, 'success');
      } catch (err) {
        const conflict = parseConflictError(err);
        if (!conflict) throw err;
        const choice = await showConflict(conflict);
        if (choice === 'refresh') {
          // Pull the latest brand row from the server so the form
          // reflects the conflicting state. The user can then re-edit
          // on top of fresh data.
          await refreshBrands?.();
          addToast('Form refreshed with the latest data', 'info');
        } else if (choice === 'overwrite') {
          const updated = await updateBrand(editing.id, payload);
          addToast(`Overwrote ${updated.name}`, 'success');
        }
        // 'cancel' → leave form unchanged, no further action.
      }
    } else {
      const created = await createBrand(payload);
      addToast(`Created ${created.name}`, 'success');
    }
  }

  async function handleDelete() {
    if (!editing?.id) return;
    const ok = await confirm({
      title: `Delete "${editing.name}"?`,
      message: 'Products in this brand stay, but their brand will be cleared.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete brand',
    });
    if (!ok) return;
    try {
      await removeBrand(editing.id);
      addToast('Brand deleted', 'success');
      setEditing(null);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="Brands" />
        <EmptyState
          title="No company selected"
          body="Create or select a company before managing brands."
          action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Company</Button>}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Brands"
        subtitle="A company can carry one or many brands. Brands have an optional icon shown on product cards and exports."
        actions={<Button variant="primary" onClick={() => setEditing({})}>+ New brand</Button>}
      />

      {brandsLoading && brands.length === 0 ? (
        <div className="page-loading">
          <div className="page-loading__spinner" aria-hidden="true" />
          <div className="page-loading__label">Loading brands…</div>
        </div>
      ) : brands.length === 0 ? (
        <EmptyState
          title="No brands yet"
          body="Brands group products and can carry their own icon for catalogs and exports."
          action={<Button variant="primary" onClick={() => setEditing({})}>+ New brand</Button>}
        />
      ) : (
        <>
        <div className="card-grid">
          {visibleBrands.map((b) => {
            const iconSrc = b.icon ? `app-image://local/${encodeURIComponent(b.icon)}` : null;
            const initials = b.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
            return (
              <div key={b.id} className="entity-card">
                <div className="entity-card__head">
                  <div
                    className={`brand-icon-preview brand-icon-preview--card${iconSrc ? ' has-icon' : ''}`}
                    style={iconSrc ? undefined : { background: b.color || '#1c1c1f' }}
                  >
                    {iconSrc ? <img src={iconSrc} alt="" /> : <span>{initials}</span>}
                  </div>
                  <div className="entity-card__head-text">
                    <div className="entity-card__title">{b.name}</div>
                    <div className="entity-card__sub">
                      {b.productCount} product{b.productCount === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
                <div className="entity-card__actions">
                  <Button onClick={() => setEditing(b)}>Edit</Button>
                </div>
              </div>
            );
          })}
        </div>
        <Pagination
          total={brands.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          currentPage={currentPage}
          maxPage={maxPage}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
        />
        </>
      )}

      <BrandForm
        open={editing !== null}
        brand={editing && editing.id ? editing : null}
        onClose={() => setEditing(null)}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
      />
    </div>
  );
}
