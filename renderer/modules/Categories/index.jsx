/**
 * v0.22.13: Categories — full-page management (lifted out of the
 * inline Settings block so the Settings layout stops shifting).
 * v0.22.14: pulled BACK into Settings as a tab — but the body kept
 * its own component so the Settings tab can render the same UI
 * without duplicating logic. The `Categories` export is no longer
 * mounted as a top-level page; `CategoriesBody` is what Settings
 * embeds. Keeping `Categories` around (as a thin wrapper) so any
 * future caller that wants a stand-alone page can still get one
 * with one import — useful for deep-linking later.
 *
 * UI mirrors Brands as closely as possible — inline add-form at the
 * top, paginated list below, click-to-edit-name inline, click ×
 * to delete. No separate edit modal yet (categories are just
 * `{ id, name }` so the modal would have one field — overkill).
 */
import { useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import {
  Button, EmptyState, Input, Pagination, paginate,
} from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

/**
 * Embeddable body — no PageHeader, no outer .page wrapper. Used by
 * Settings → Categories tab in v0.22.14+.
 */
export function CategoriesBody({ autoFocus = false }) {
  const categories = useAppStore((s) => s.categories);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const createCategory = useAppStore((s) => s.createCategory);
  const updateCategory = useAppStore((s) => s.updateCategory);
  const removeCategory = useAppStore((s) => s.removeCategory);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const addToast = useAppStore((s) => s.addToast);

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);

  // v0.22.14: autoFocus is passed straight through to the native
  // <input>'s HTML attribute (Input spreads ...props). React fires
  // it on mount which is exactly when the Settings tab swap mounts
  // CategoriesBody — so switching to the tab puts the cursor right
  // in the add field. The user reported the "+ Add" button looked
  // permanently disabled; autofocusing the input makes it obvious
  // the next step is "type a name".

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  // v0.22.15: pull ALL four values out of paginate(), not just
  // pageStart/pageEnd. The Pagination component needs currentPage
  // + maxPage to render its label and gate the Prev/Next buttons —
  // omitting them (as v0.22.13/.14 did) left those props undefined,
  // which made Next compare `undefined >= undefined` (false), enable
  // the button, and call onPageChange(NaN). NaN then flowed back
  // into the slice and emptied the list.
  const { currentPage, maxPage, pageStart, pageEnd } = useMemo(
    () => paginate(categories.length, page, pageSize),
    [categories.length, page, pageSize],
  );
  const visible = useMemo(
    () => categories.slice(pageStart, pageEnd),
    [categories, pageStart, pageEnd],
  );

  if (!activeCompanyId) {
    // No PageHeader here — caller (Settings tab or stand-alone page)
    // owns the chrome.
    return (
      <EmptyState
        title="Select a company first"
        body="Categories are scoped per company. Pick a company in the sidebar dropdown to manage its category list."
        action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Companies →</Button>}
      />
    );
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createCategory({ name });
      setNewName('');
      addToast(`Added ${name}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(c) {
    setEditingId(c.id);
    setEditingName(c.name);
  }

  async function saveEdit() {
    if (!editingId) return;
    const next = editingName.trim();
    if (!next) { addToast('Name can\'t be empty', 'error'); return; }
    setBusy(true);
    try {
      await updateCategory(editingId, { name: next });
      addToast('Saved', 'success');
      setEditingId(null);
      setEditingName('');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
  }

  async function handleDelete(c) {
    const inUse = (c.productCount ?? 0) > 0;
    const ok = await confirm({
      title: `Delete "${c.name}"?`,
      message: inUse
        ? `${c.productCount} product${c.productCount === 1 ? '' : 's'} reference this category. Their category will be cleared (the products themselves are kept).`
        : 'No products reference this category yet.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete category',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeCategory(c.id);
      addToast(`Deleted ${c.name}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="categories-page">
      <div className="categories-page__add">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="Type a name then press Enter or click + Add"
          disabled={busy}
          autoFocus={autoFocus}
        />
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={busy || !newName.trim()}
          title={newName.trim()
            ? `Create category "${newName.trim()}"`
            : 'Type a name in the input first'}
        >
          + Add category
        </Button>
      </div>
      {/* v0.22.14: tiny inline hint so users don't think the button
          is permanently disabled (we got that feedback). The button
          enables the moment you type. */}
      <p className="categories-page__hint muted">
        Categories group products together. The Library&apos;s sidebar filter
        uses this list. Click any name to rename it inline.
      </p>

        {categories.length === 0 ? (
          <EmptyState
            title="No categories yet"
            body="Categories group products together so the Library sidebar filter is meaningful (e.g. Basin Faucet, Bathtub, Hand Shower Set). Add your first one above."
          />
        ) : (
          <>
            <div className="categories-page__count muted">
              {categories.length} categor{categories.length === 1 ? 'y' : 'ies'}
            </div>
            <ul className="categories-list">
              {visible.map((c) => {
                const isEditing = editingId === c.id;
                return (
                  <li key={c.id} className="categories-list__row">
                    {isEditing ? (
                      <>
                        <Input
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          disabled={busy}
                          autoFocus
                        />
                        <span className="muted">{c.productCount} product{c.productCount === 1 ? '' : 's'}</span>
                        <Button onClick={cancelEdit} disabled={busy}>Cancel</Button>
                        <Button variant="primary" onClick={saveEdit} disabled={busy || !editingName.trim()}>Save</Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="categories-list__name"
                          onClick={() => startEdit(c)}
                          title="Click to rename"
                        >
                          {c.name}
                        </button>
                        <span className="muted">{c.productCount} product{c.productCount === 1 ? '' : 's'}</span>
                        <button
                          type="button"
                          className="row-action"
                          onClick={() => startEdit(c)}
                        >Edit</button>
                        <button
                          type="button"
                          className="row-action row-action--danger"
                          onClick={() => handleDelete(c)}
                          disabled={busy}
                        >Delete</button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            {categories.length > pageSize ? (
              <Pagination
                total={categories.length}
                pageStart={pageStart}
                pageEnd={pageEnd}
                currentPage={currentPage}
                maxPage={maxPage}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
              />
            ) : null}
          </>
        )}
    </section>
  );
}

/**
 * Stand-alone page variant — wraps CategoriesBody with the usual
 * .page chrome + PageHeader. Kept exported so any future code path
 * that wants to deep-link directly to a categories page can; the
 * sidebar nav doesn't currently route to it (Settings tab does).
 */
export function Categories() {
  return (
    <div className="page">
      <PageHeader title="Categories" />
      <CategoriesBody />
    </div>
  );
}
