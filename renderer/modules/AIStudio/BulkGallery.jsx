import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Pagination } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { PromoteToProductDialog } from './PromoteToProductDialog.jsx';

/**
 * Gallery section for AI Studio's Bulk tab.
 *
 * Lists every gallery row in the active company where product_id IS NULL —
 * i.e. results from bulk runs that haven't been attached to a product yet.
 *
 * Per-row actions:
 *  - Favorite toggle (same store as per-product gallery rows)
 *  - Export… → main-process Save dialog, writes the result anywhere on disk
 *  - Promote to product… → opens a dialog to pick / create a product
 *  - Delete (also unlinks the file on disk)
 *
 * Auto-refreshes on `ai:galleryAdded` events so newly-completed bulk tasks
 * show up immediately while the queue is still running.
 */
export function BulkGallery({ refreshKey, addToast }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const pageSize = 24;
  const [loading, setLoading] = useState(false);
  const [promoting, setPromoting] = useState(null); // gallery entry being promoted

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.api.ai.listBulkGallery({ limit: pageSize, offset: page * pageSize });
      setRows(res.rows || []);
      setTotal(res.total || 0);
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [page, addToast]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Live updates: when a new gallery row is created, refresh if it belongs
  // to bulk (no product). We don't get the row's productId from the event
  // payload guarantee, so just refresh on any add — cheap enough.
  useEffect(() => {
    const unsub = window.api.ai.onGalleryAdded?.(() => {
      // Only refresh page 0; if user is browsing deeper pages, the new
      // item is older relative to their view anyway.
      if (page === 0) load();
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [load, page]);

  async function handleFavorite(entry) {
    try {
      await window.api.ai.favoriteGallery(entry.id, !entry.isFavorite);
      setRows((curr) => curr.map((r) => r.id === entry.id ? { ...r, isFavorite: !r.isFavorite } : r));
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }
  async function handleExport(entry) {
    try {
      const dest = await window.api.ai.exportBulkImage(entry.id);
      if (dest) addToast?.(`Exported to ${dest}`, 'success');
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }
  async function handleDelete(entry) {
    const ok = await confirm({
      title: 'Delete this result?',
      message: 'The image will be removed from the bulk gallery and from disk.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await window.api.ai.removeGallery(entry.id);
      addToast?.('Deleted', 'success');
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }

  const pageStart = page * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, total);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <section className="ai-card ai-card--gallery">
      <h3 className="ai-card__title">Bulk gallery <span className="ai-card__title-count">{total}</span></h3>
      {loading && rows.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No bulk results yet"
          body="Queue some images above. Finished results show up here, ready to favorite, export, or promote to a product."
        />
      ) : (
        <>
          <div className="ai-bulk-gallery">
            {rows.map((entry) => (
              <div key={entry.id} className="ai-bulk-gallery__tile">
                <div className="ai-bulk-gallery__thumb">
                  <img
                    src={`app-image://local/${encodeURIComponent(entry.filepath)}`}
                    alt=""
                    loading="lazy"
                  />
                  {entry.isFavorite ? (
                    <span className="ai-bulk-gallery__fav-flag" aria-label="Favorite" title="Favorite">★</span>
                  ) : null}
                </div>
                <div className="ai-bulk-gallery__body">
                  <div className="ai-bulk-gallery__meta">
                    <Badge tone="slate">{entry.model}</Badge>
                  </div>
                  {entry.prompt ? (
                    <div className="ai-bulk-gallery__prompt" title={entry.prompt}>{entry.prompt}</div>
                  ) : null}
                  <div className="ai-bulk-gallery__actions">
                    <button
                      type="button"
                      className={`ai-bulk-gallery__icon-btn${entry.isFavorite ? ' is-active' : ''}`}
                      onClick={() => handleFavorite(entry)}
                      title={entry.isFavorite ? 'Unfavorite' : 'Favorite'}
                    >★</button>
                    <Button onClick={() => handleExport(entry)}>Export…</Button>
                    <Button variant="primary" onClick={() => setPromoting(entry)}>Promote…</Button>
                    <button
                      type="button"
                      className="ai-bulk-gallery__icon-btn ai-bulk-gallery__icon-btn--danger"
                      onClick={() => handleDelete(entry)}
                      title="Delete"
                    >×</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {total > pageSize ? (
            <Pagination
              total={total}
              pageStart={pageStart}
              pageEnd={pageEnd}
              currentPage={page}
              maxPage={maxPage}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={() => {/* fixed for bulk gallery */}}
              pageSizeOptions={[pageSize]}
            />
          ) : null}
        </>
      )}

      {promoting ? (
        <PromoteToProductDialog
          entry={promoting}
          onClose={() => setPromoting(null)}
          onPromoted={() => {
            setPromoting(null);
            load();
            addToast?.('Promoted to product', 'success');
          }}
          onError={(msg) => addToast?.(msg, 'error')}
        />
      ) : null}
    </section>
  );
}
