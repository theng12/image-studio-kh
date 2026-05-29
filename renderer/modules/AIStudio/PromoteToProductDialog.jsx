import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Field, Input, Modal, Select } from '../../components/ui.jsx';

/**
 * Modal for attaching a bulk gallery result to a product.
 *
 * Two modes via tab:
 *   - Existing product: searchable list of the active company's products.
 *   - New product:      SKU + Name + Brand + Category — backend creates it
 *                       on the fly via `ai:promoteGalleryToProduct`'s
 *                       newProduct payload.
 *
 * In either case, on success the gallery row's product_id is set, the
 * image bytes are imported into that product's image list, and the row
 * disappears from the bulk gallery (which only lists product_id IS NULL).
 */
export function PromoteToProductDialog({ entry, onClose, onPromoted, onError }) {
  // v0.11.3: filter-agnostic list so we can attach a bulk result to ANY
  // product in the active company, regardless of the Library's filters.
  const products = useAppStore((s) => s.allProducts);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  const [tab, setTab] = useState('existing'); // 'existing' | 'new'
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef(null);

  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newBrandId, setNewBrandId] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');

  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const base = terms.length
      ? products.filter((p) => {
          const hay = `${p.sku ?? ''} ${p.name ?? ''}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
      : products;
    return base.slice(0, 200);
  }, [products, search]);

  useEffect(() => {
    if (filtered.length > 0 && !selectedId) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  function onSearchKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => {
        const next = Math.min(filtered.length - 1, i + 1);
        const row = filtered[next];
        if (row) setSelectedId(row.id);
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => {
        const next = Math.max(0, i - 1);
        const row = filtered[next];
        if (row) setSelectedId(row.id);
        return next;
      });
    } else if (e.key === 'Enter' && selectedId) {
      e.preventDefault();
      handleConfirm();
    }
  }

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      if (tab === 'existing') {
        if (!selectedId) {
          onError?.('Pick a product first.');
          setBusy(false);
          return;
        }
        await window.api.ai.promoteGallery({ galleryId: entry.id, targetProductId: selectedId });
      } else {
        if (!newSku.trim()) {
          onError?.('SKU is required.');
          setBusy(false);
          return;
        }
        await window.api.ai.promoteGallery({
          galleryId: entry.id,
          newProduct: {
            sku: newSku.trim(),
            name: newName.trim() || null,
            brandId: newBrandId || null,
            categoryId: newCategoryId || null,
          },
        });
        // Refresh the product list so the new one is visible everywhere.
        refreshProducts?.();
      }
      onPromoted?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy} onClick={handleConfirm}>
        {busy ? 'Promoting…' : 'Promote'}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title="Promote to product" footer={footer}>
      <div className="ai-promote">
        <div className="ai-promote__preview">
          <img
            src={`app-image://local/${encodeURIComponent(entry.filepath)}`}
            alt=""
          />
        </div>
        <div className="ai-promote__tabs ws-toolbar__group">
          <button
            type="button"
            className={`segment${tab === 'existing' ? ' is-active' : ''}`}
            onClick={() => setTab('existing')}
          >Existing product</button>
          <button
            type="button"
            className={`segment${tab === 'new' ? ' is-active' : ''}`}
            onClick={() => setTab('new')}
          >New product</button>
        </div>

        {tab === 'existing' ? (
          <>
            <Field label="Search">
              {({ id }) => (
                <Input
                  id={id}
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={onSearchKey}
                  placeholder="SKU or name…"
                />
              )}
            </Field>
            <div className="ai-promote__list" ref={listRef} role="listbox">
              {filtered.length === 0 ? (
                <div className="muted ai-promote__empty">No products match.</div>
              ) : filtered.map((p, idx) => (
                <button
                  key={p.id}
                  type="button"
                  data-idx={idx}
                  className={`ai-promote__row${p.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => { setSelectedId(p.id); setActiveIdx(idx); }}
                  role="option"
                  aria-selected={p.id === selectedId}
                >
                  <span className="ai-promote__row-sku">{p.sku}</span>
                  {p.name ? <span className="ai-promote__row-name">{p.name}</span> : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <Field label="SKU" required>
              {({ id }) => (
                <Input
                  id={id}
                  autoFocus
                  value={newSku}
                  onChange={(e) => setNewSku(e.target.value)}
                  placeholder="e.g. AI-RESULT-001"
                />
              )}
            </Field>
            <Field label="Name">
              {({ id }) => (
                <Input id={id} value={newName} onChange={(e) => setNewName(e.target.value)} />
              )}
            </Field>
            <Field label="Brand">
              {({ id }) => (
                <Select id={id} value={newBrandId} onChange={(e) => setNewBrandId(e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Category">
              {({ id }) => (
                <Select id={id} value={newCategoryId} onChange={(e) => setNewCategoryId(e.target.value)}>
                  <option value="">— Uncategorized —</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
