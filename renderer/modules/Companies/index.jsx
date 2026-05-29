import { useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Badge } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { CompanyForm } from './CompanyForm.jsx';

export function Companies() {
  const companies = useAppStore((s) => s.companies);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const createCompany = useAppStore((s) => s.createCompany);
  const updateCompany = useAppStore((s) => s.updateCompany);
  const removeCompany = useAppStore((s) => s.removeCompany);
  const setActiveCompany = useAppStore((s) => s.setActiveCompany);
  const addToast = useAppStore((s) => s.addToast);

  const [editing, setEditing] = useState(null);

  async function handleSubmit(payload) {
    if (editing && editing.id) {
      const updated = await updateCompany(editing.id, payload);
      addToast(`Saved ${updated.name}`, 'success');
    } else {
      const created = await createCompany(payload);
      addToast(`Created ${created.name}`, 'success');
    }
  }

  async function handleDelete() {
    if (!editing?.id) return;
    const ok = await confirm({
      title: `Delete "${editing.name}"?`,
      message: 'This deletes everything inside this company — products, brands, categories, AI generations, image files on disk.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete company',
    });
    if (!ok) return;
    try {
      await removeCompany(editing.id);
      addToast('Company deleted', 'success');
      setEditing(null);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Company"
        subtitle="A company is a retailer or vendor. Each company has its own brands, products, and images — fully isolated."
        actions={<Button variant="primary" onClick={() => setEditing({})}>+ New company</Button>}
      />

      {companies.length === 0 ? (
        <EmptyState
          title="No companies yet"
          body="Create your first company to start adding brands and products."
          action={<Button variant="primary" onClick={() => setEditing({})}>+ New company</Button>}
        />
      ) : (
        <div className="card-grid">
          {companies.map((c) => {
            const isActive = c.id === activeCompanyId;
            return (
              <div key={c.id} className="entity-card">
                <div className="entity-card__head">
                  <div
                    className="entity-card__swatch entity-card__swatch--lg"
                    style={{ background: c.color || '#1c1c1f' }}
                    aria-hidden
                  />
                  <div className="entity-card__head-text">
                    <div className="entity-card__title">{c.name}</div>
                    {c.sectors.length > 0 ? (
                      <div className="entity-card__sub">{c.sectors.join(' • ')}</div>
                    ) : (
                      <div className="entity-card__sub muted">No sectors set</div>
                    )}
                  </div>
                  {isActive ? <Badge tone="emerald">Active</Badge> : null}
                </div>
                <div className="entity-card__stats">
                  <span>{c.productCount} product{c.productCount === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span>{c.brandCount} brand{c.brandCount === 1 ? '' : 's'}</span>
                </div>
                <div className="entity-card__actions">
                  <Button onClick={() => setEditing(c)}>Edit</Button>
                  {isActive ? null : (
                    <Button onClick={() => setActiveCompany(c.id)}>Set active</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CompanyForm
        open={editing !== null}
        company={editing && editing.id ? editing : null}
        onClose={() => setEditing(null)}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
      />
    </div>
  );
}
