/**
 * v0.26.31: global History feed.
 *
 * Lists every audit_log row across all entities and all users
 * (standalone admin, server admin, every connected client) newest
 * first. Paginated. Filterable by entity type. Each row is clickable
 * and opens the relevant entity if it still exists.
 *
 * What's the right place for this in the app?
 *   Sidebar under SYSTEM, above Settings. It's a system-level read-
 *   only view — comparable to Settings in mental model but visited
 *   often ("what did my assistant change yesterday?") whereas
 *   Settings is configure-once. Always-available (works even before
 *   any company is created — just shows an empty list).
 *
 * Why not a tab inside an existing page?
 *   - Per-product / per-brand history already lives in the side-
 *     panel "History" button → opens the existing HistoryModal.
 *   - Cross-entity history needs its own page because there's no
 *     single entity context to anchor it to.
 *
 * Data sources:
 *   - window.api.audit.listRecent({ limit, offset, entityType })
 *   - window.api.audit.countRecent({ entityType })
 *   - store: products / brands / categories (for entity-name lookup)
 *   - store: attributionUsers (for user-name lookup)
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Button, EmptyState, Pagination, Select } from '../../components/ui.jsx';
import { HistoryModal } from '../../components/HistoryModal.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

const DEFAULT_PAGE_SIZE = 50;

// Entity-type options in the filter dropdown. 'image' rows are
// children of products — they show up in the global feed because the
// audit_log stores them under entity_type='image', entity_id=<productId>.
// Worth surfacing as its own filter so the user can find "every flip
// or set-main someone did" without the product mutations interleaved.
const ENTITY_TYPE_OPTIONS = [
  { value: '',         label: 'All entity types' },
  { value: 'product',  label: 'Products' },
  { value: 'image',    label: 'Images (add/remove/flip/set-main)' },
  { value: 'brand',    label: 'Brands' },
  { value: 'category', label: 'Categories' },
];

// Human-readable label per action — matches the per-entity HistoryModal
// vocabulary so users see consistent wording wherever they look.
const ACTION_LABELS = {
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  'bulk-update': 'Bulk edited',
  'image:add':       'Added image',
  'image:remove':    'Removed image',
  'image:set-main':  'Set as main image',
  'image:reorder':   'Reordered images',
  'image:promote':   'Promoted AI variant',
  'image:flip':      'Flipped image',
  'template:apply':  'Applied overlay template',
};
function actionLabel(action) { return ACTION_LABELS[action] ?? action; }

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60)  return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30)  return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12)   return `${mo} mo ago`;
  return `${Math.floor(mo / 12)} yr ago`;
}

export function History() {
  const attributionUsers = useAppStore((s) => s.attributionUsers);
  const allProducts = useAppStore((s) => s.allProducts);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const addToast = useAppStore((s) => s.addToast);

  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [entityType, setEntityType] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Per-entity drilldown — clicking the entity cell opens the existing
  // HistoryModal scoped to that product/brand. Keeps the cross-entity
  // overview and the deep-dive on separate surfaces.
  const [entityModal, setEntityModal] = useState(null); // { entityType, entityId, title } | null
  // v0.33.0: bump to force the load effect to re-run (after a clear).
  const [reloadNonce, setReloadNonce] = useState(0);

  // Reset to page 1 when the filter changes.
  useEffect(() => { setPage(0); }, [entityType]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const opts = { limit: pageSize, offset: page * pageSize };
    if (entityType) opts.entityType = entityType;
    Promise.all([
      window.api?.audit.listRecent(opts) ?? Promise.resolve([]),
      window.api?.audit.countRecent(entityType ? { entityType } : {}) ?? Promise.resolve(0),
    ])
      .then(([rows, count]) => {
        if (cancelled) return;
        setEntries(rows);
        setTotal(Number(count) || 0);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        addToast?.(err.message, 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, pageSize, entityType, addToast, reloadNonce]);

  // v0.33.0: clear / retention. days > 0 deletes entries older than that
  // many days; days === 0 wipes the whole log. Runs server-side, so it
  // clears the shared history for every connected Mac.
  async function handleClearHistory(days) {
    const ok = await confirm({
      title: days > 0 ? `Clear history older than ${days} days?` : 'Clear ALL history?',
      message: days > 0
        ? `Permanently deletes every audit-log entry older than ${days} days. Recent activity is kept.`
        : 'Permanently deletes the ENTIRE history log for every company.',
      detail: 'This affects the shared log on the server — every connected Mac. It can\'t be undone.',
      confirmLabel: days > 0 ? `Clear older than ${days}d` : 'Clear everything',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await window.api.audit.clearHistory(days);
      addToast(`Cleared ${res.deleted} history entr${res.deleted === 1 ? 'y' : 'ies'}`, 'success');
      setPage(0);
      setReloadNonce((n) => n + 1);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  // Build lookup indexes once per data slice so each row render is O(1).
  // allProducts is preferred because it spans all companies — the global
  // History feed shows events from any company the user has access to.
  const productById = useMemo(() => {
    const m = new Map();
    for (const p of allProducts ?? []) m.set(p.id, p);
    return m;
  }, [allProducts]);
  const brandById = useMemo(() => {
    const m = new Map();
    for (const b of brands ?? []) m.set(b.id, b);
    return m;
  }, [brands]);
  const categoryById = useMemo(() => {
    const m = new Map();
    for (const c of categories ?? []) m.set(c.id, c);
    return m;
  }, [categories]);

  function entityLabel(entry) {
    const { entityType: et, entityId } = entry;
    if (et === 'product' || et === 'image') {
      const p = productById.get(entityId);
      if (p) return { kind: et === 'image' ? 'image' : 'product', text: p.sku || '(no SKU)', subtitle: p.name || null, productId: p.id };
      return { kind: et === 'image' ? 'image' : 'product', text: '(deleted product)', subtitle: null, productId: null };
    }
    if (et === 'brand') {
      const b = brandById.get(entityId);
      return { kind: 'brand', text: b?.name || '(deleted brand)', subtitle: null };
    }
    if (et === 'category') {
      const c = categoryById.get(entityId);
      return { kind: 'category', text: c?.name || '(deleted category)', subtitle: null };
    }
    return { kind: et, text: String(entityId ?? ''), subtitle: null };
  }

  function userLabel(entry) {
    if (!entry.userId) return 'Server admin';
    return attributionUsers?.[entry.userId] ?? 'Unknown user';
  }

  // Click handler — clicking the entity cell drills into that entity's
  // full per-entity history modal. Same component the side-panel uses
  // so the UX is consistent and no extra UI to build.
  function openEntity(entry) {
    const label = entityLabel(entry);
    if (label.kind === 'product' || label.kind === 'image') {
      // For image events the entity_id is the productId, so the
      // entity modal needs entityType='product' to interleave images.
      setEntityModal({
        entityType: 'product',
        entityId: entry.entityId,
        title: label.text + (label.subtitle ? ` · ${label.subtitle}` : ''),
      });
    } else if (label.kind === 'brand') {
      setEntityModal({ entityType: 'brand', entityId: entry.entityId, title: `Brand · ${label.text}` });
    } else if (label.kind === 'category') {
      setEntityModal({ entityType: 'category', entityId: entry.entityId, title: `Category · ${label.text}` });
    }
  }

  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const pageStart = total === 0 ? 0 : page * pageSize + 1;
  const pageEnd = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="page page--history">
      <PageHeader
        title="History"
        subtitle="Every edit anyone made, across all companies. Audit log is append-only — read here, not editable."
        actions={
          <>
            <Select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              aria-label="Filter by entity type"
            >
              {ENTITY_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
            <Button onClick={() => {
              // Soft refresh — just bump the load by re-setting page.
              const cur = page;
              setPage(-1);
              setTimeout(() => setPage(cur), 0);
            }}>Refresh</Button>
            {/* v0.33.0: retention / clear. Picking an option confirms then
                deletes; the Select snaps back to its placeholder so the
                same option can be re-picked. */}
            <Select
              value=""
              aria-label="Clear history"
              title="Delete old audit-log entries to keep the history (and the database) tidy."
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = '';
                if (v === '') return;
                handleClearHistory(v === 'all' ? 0 : Number(v));
              }}
            >
              <option value="">Clear history…</option>
              <option value="15">Older than 15 days</option>
              <option value="30">Older than 30 days</option>
              <option value="90">Older than 90 days</option>
              <option value="all">Everything</option>
            </Select>
          </>
        }
      />

      {error ? (
        <div className="history-page__error">{error}</div>
      ) : null}

      {!loading && entries.length === 0 ? (
        <EmptyState
          title="No history yet"
          body={entityType ? `No ${ENTITY_TYPE_OPTIONS.find((o) => o.value === entityType)?.label.toLowerCase()} events yet. Try a different filter.` : "Make an edit anywhere in the app — products, brands, images, settings — and it'll show up here."}
        />
      ) : (
        <>
          <div className="history-page__count">
            {loading
              ? 'Loading…'
              : total === 0
                ? '0 events'
                : `Showing ${pageStart}–${pageEnd} of ${total.toLocaleString()} event${total === 1 ? '' : 's'}`}
          </div>

          <div className="history-page__table-wrap">
            <table className="history-page__table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Entity</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const lbl = entityLabel(entry);
                  const drillable = lbl.kind === 'product' || lbl.kind === 'image' || lbl.kind === 'brand' || lbl.kind === 'category';
                  return (
                    <tr key={entry.id}>
                      <td title={new Date(Number(entry.createdAt)).toLocaleString()}>
                        {relativeTime(entry.createdAt)}
                      </td>
                      <td>{userLabel(entry)}</td>
                      <td>
                        {drillable ? (
                          <button
                            type="button"
                            className="history-page__entity-link"
                            onClick={() => openEntity(entry)}
                            title={`Open full history for ${lbl.text}`}
                          >
                            <span className={`history-page__entity-kind history-page__entity-kind--${lbl.kind}`}>
                              {lbl.kind === 'image' ? 'IMG' : lbl.kind.slice(0, 4).toUpperCase()}
                            </span>
                            <span className="history-page__entity-text">
                              {lbl.text}
                              {lbl.subtitle ? <span className="muted"> · {lbl.subtitle}</span> : null}
                            </span>
                          </button>
                        ) : (
                          <span className="history-page__entity-text muted">{lbl.text}</span>
                        )}
                      </td>
                      <td>{actionLabel(entry.action)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {total > 0 ? (
            <Pagination
              total={total}
              pageStart={pageStart - 1}
              pageEnd={pageEnd}
              currentPage={page}
              maxPage={lastPage}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
            />
          ) : null}
        </>
      )}

      {entityModal ? (
        <HistoryModal
          open={!!entityModal}
          onClose={() => setEntityModal(null)}
          entityType={entityModal.entityType}
          entityId={entityModal.entityId}
          title={entityModal.title}
        />
      ) : null}
    </div>
  );
}
