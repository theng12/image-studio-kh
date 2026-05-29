import { useMemo, useState } from 'react';
import { Badge, Button, Pagination, paginate } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

/**
 * Overlay Studio — template list view.
 *
 * Defaults to a card grid; search + pagination follow the same pattern as
 * the Library and Export Center. Each card shows name, size, element
 * count, and tags, plus Edit / Duplicate / Delete actions.
 *
 * Templates are app-global so no per-company scoping here. The "Apply to
 * products" CTA (Phase 3) will live on individual cards once the batch
 * runner ships — leaving a placeholder for now.
 */
export function TemplateList({ templates, activeCompanyId, onOpen, onDuplicate, onDelete }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return templates;
    return templates.filter((t) => {
      const hay = `${t.name ?? ''} ${t.description ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase();
      return terms.every((q) => hay.includes(q));
    });
  }, [templates, search]);

  const pager = useMemo(
    () => paginate(filtered.length, page, pageSize),
    [filtered.length, page, pageSize],
  );
  const visible = filtered.slice(pager.pageStart, pager.pageEnd);

  async function handleDelete(t) {
    const ok = await confirm({
      title: `Delete "${t.name}"?`,
      message: 'The template is removed from this app, but already-rendered overlay images on disk are kept.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete template',
    });
    if (ok) onDelete(t.id);
  }

  return (
    <div className="ovl-list">
      <div className="ovl-list__toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            className="search-input"
            placeholder="Search by name, description, or tag…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            spellCheck={false}
          />
        </div>
        <span className="muted">{filtered.length} template{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="ovl-list__empty">No templates match “{search}”.</div>
      ) : (
        <>
          <div className="ovl-list__grid">
            {visible.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onOpen={() => onOpen(t.id)}
                onDuplicate={() => onDuplicate(t.id)}
                onDelete={() => handleDelete(t)}
                disabledApply={!activeCompanyId}
              />
            ))}
          </div>
          <Pagination
            total={filtered.length}
            pageStart={pager.pageStart}
            pageEnd={pager.pageEnd}
            currentPage={pager.currentPage}
            maxPage={pager.maxPage}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
          />
        </>
      )}
    </div>
  );
}

function TemplateCard({ template, onOpen, onDuplicate, onDelete, disabledApply }) {
  const elementCount = Array.isArray(template.elements) ? template.elements.length : 0;
  const typeCounts = (template.elements ?? []).reduce((acc, el) => {
    acc[el.type] = (acc[el.type] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="ovl-card">
      <button
        type="button"
        className="ovl-card__preview"
        onClick={onOpen}
        title="Edit template"
        style={{ aspectRatio: `${template.canvasWidth} / ${template.canvasHeight}` }}
      >
        {/* Phase 2 doesn't ship a real thumbnail yet — Phase 3 will cache
            one on first render. For now, an element-type summary badge
            layer hints at what's inside. */}
        <div className="ovl-card__preview-hint">
          {elementCount === 0 ? (
            <span className="muted">No elements yet</span>
          ) : (
            <>
              {typeCounts.text     ? <Badge tone="slate">{typeCounts.text} text</Badge>     : null}
              {typeCounts.barcode  ? <Badge tone="slate">{typeCounts.barcode} barcode</Badge>  : null}
              {typeCounts.image    ? <Badge tone="slate">{typeCounts.image} image</Badge>   : null}
            </>
          )}
        </div>
      </button>
      <div className="ovl-card__body">
        <div className="ovl-card__name">{template.name}</div>
        <div className="ovl-card__meta">
          {template.canvasWidth} × {template.canvasHeight}
          {' · '}
          {elementCount} element{elementCount === 1 ? '' : 's'}
        </div>
        {Array.isArray(template.tags) && template.tags.length > 0 ? (
          <div className="ovl-card__tags">
            {template.tags.map((tag) => <span key={tag} className="ovl-card__tag">{tag}</span>)}
          </div>
        ) : null}
      </div>
      <div className="ovl-card__actions">
        <Button onClick={onOpen}>Edit</Button>
        <Button onClick={onDuplicate}>Duplicate</Button>
        <Button
          disabled={disabledApply}
          title={disabledApply ? 'Pick a company first' : 'Apply to products (Phase 3)'}
        >Apply…</Button>
        <button
          type="button"
          className="row-action ovl-card__delete"
          onClick={onDelete}
          title="Delete"
          aria-label="Delete template"
        >×</button>
      </div>
    </div>
  );
}
