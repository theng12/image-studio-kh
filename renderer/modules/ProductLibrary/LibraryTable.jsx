import { memo } from 'react';
import { Badge } from '../../components/ui.jsx';
import { CompactAttribution } from '../../components/Attribution.jsx';
import { appImageSrc } from '../../lib/imageUrl.js';
import { PROCESS_STATUS_OPTIONS, STATUS_OPTIONS, findOption } from './libraryConstants.js';

export function TableView({
  rows, brandsById, categoriesById, onOpen, onProcess, onPreview, sort, onSort,
  selectedProductId, selectedIds, onToggleSelected, onToggleAllVisible,
  // v0.22.7: which optional columns to render. Header + body both
  // consult this; SKU + thumb + select + actions are not in the set
  // (they're locked-on).
  visibleCols,
}) {
  // v0.18.1: header checkbox state — checked when ALL visible rows
  // are in the selection set, indeterminate when some are.
  const visibleIds = rows.map((p) => p.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds?.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selectedIds?.has(id));
  const show = (key) => !visibleCols || visibleCols.has(key);
  return (
    <div className="lib-table-wrap">
      <table className="lib-table">
        <thead>
          <tr>
            <th className="col-select">
              {selectedIds ? (
                <input
                  type="checkbox"
                  aria-label={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                  checked={allVisibleSelected}
                  ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                  onChange={() => onToggleAllVisible?.(!allVisibleSelected)}
                />
              ) : null}
            </th>
            <th className="col-thumb"></th>
            <SortHeader sortKey="sku"      label="SKU"            sort={sort} onSort={onSort} />
            {show('brand')    ? <SortHeader sortKey="brand"    label="Brand"          sort={sort} onSort={onSort} /> : null}
            {show('name')     ? <SortHeader sortKey="name"     label="Name"           sort={sort} onSort={onSort} /> : null}
            {show('category') ? <SortHeader sortKey="category" label="Category"       sort={sort} onSort={onSort} /> : null}
            {show('color')    ? <SortHeader sortKey="color"    label="Color / Finish" sort={sort} onSort={onSort} /> : null}
            {show('images')   ? <SortHeader sortKey="images"   label="Images"         sort={sort} onSort={onSort} numeric /> : null}
            {show('process')  ? <th>Process</th> : null}
            {show('status')   ? <th>Status</th> : null}
            {/* v0.22.5: "Edited" column surfaces the per-row attribution
                (relative time + editor name) right in the list, so you
                don't have to open the side panel to see who last touched
                a row. v0.22.7 made this column user-toggleable. */}
            {show('edited')   ? <SortHeader sortKey="updated" label="Edited" sort={sort} onSort={onSort} /> : null}
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <TableRow
              key={p.id}
              product={p}
              brand={p.brandId ? brandsById.get(p.brandId) : null}
              category={p.categoryId ? categoriesById.get(p.categoryId) : null}
              onOpen={onOpen}
              onProcess={onProcess}
              onPreview={onPreview}
              selected={p.id === selectedProductId}
              checked={selectedIds?.has(p.id) ?? false}
              onToggleCheck={onToggleSelected}
              visibleCols={visibleCols}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Sortable column header. Click toggles direction; clicking a different
 * column starts in 'asc' (text) or 'desc' (numeric) — that policy lives in
 * the store's setProductSort.
 */
function SortHeader({ sortKey, label, sort, onSort, numeric = false }) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <th
      className={`lib-th-sort${active ? ' is-active' : ''}${numeric ? ' col-num' : ''}`}
      onClick={() => onSort(sortKey)}
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      <span className="lib-th-sort__arrow" aria-hidden>
        {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
      </span>
    </th>
  );
}

/**
 * Memoized table row. React.memo with the default shallow-prop compare is
 * enough here because:
 *   - `product`, `brand`, `category` are immutable per render of the parent;
 *   - `onOpen` / `onProcess` are stable via useCallback in the parent.
 * The result: filter typing and page-change re-renders the parent without
 * re-rendering every row.
 */
const TableRow = memo(function TableRow({
  product: p, brand, category, onOpen, onProcess, onPreview, selected,
  checked, onToggleCheck,
  // v0.22.7: respect the column picker. When undefined we fall back to
  // "show all" so TableRow stays usable for any caller that hasn't
  // adopted the picker yet (none today, but easy to keep symmetric).
  visibleCols,
}) {
  const proc = findOption(PROCESS_STATUS_OPTIONS, p.processStatus);
  const stat = findOption(STATUS_OPTIONS, p.status);
  const hasImage = !!p.mainImagePath;
  const show = (key) => !visibleCols || visibleCols.has(key);
  return (
    <tr
      className={`lib-row${selected ? ' is-selected' : ''}${checked ? ' is-checked' : ''}`}
      onClick={() => onOpen(p)}
      aria-selected={selected || undefined}
    >
      <td className="col-select" onClick={(e) => e.stopPropagation()}>
        {onToggleCheck ? (
          <input
            type="checkbox"
            aria-label={`Select ${p.sku}`}
            checked={!!checked}
            onChange={() => onToggleCheck(p.id)}
          />
        ) : null}
      </td>
      <td
        className={`col-thumb${hasImage ? ' col-thumb--clickable' : ''}`}
        onClick={hasImage ? (e) => { e.stopPropagation(); onPreview(p); } : undefined}
        title={hasImage ? 'Preview images' : undefined}
      >
        {hasImage ? (
          // v0.22.8: ?v=<updatedAt> cache-busts after image deletes /
          // reorders / set-main. The path `<sku>-001.jpg` stays the
          // same but the bytes inside change when the user makes a
          // different image the main one; without the version stamp
          // the table thumb shows stale pixels.
          <img src={appImageSrc(p.mainImagePath, p.updatedAt)} alt="" />
        ) : (
          <div className="thumb-placeholder" aria-hidden>·</div>
        )}
      </td>
      <td className="col-sku">{p.sku}</td>
      {show('brand')    ? <td>{brand?.name ?? <span className="muted">—</span>}</td> : null}
      {show('name')     ? <td>{p.name ?? <span className="muted">—</span>}</td> : null}
      {show('category') ? <td>{category?.name ?? <span className="muted">—</span>}</td> : null}
      {show('color')    ? <td>{p.colorFinish ?? <span className="muted">—</span>}</td> : null}
      {show('images')   ? <td className="col-num">{p.imageCount}/50</td> : null}
      {show('process')  ? <td>{proc ? <Badge tone={proc.tone}>{proc.label}</Badge> : null}</td> : null}
      {show('status')   ? <td>{stat ? <Badge tone={stat.tone}>{stat.label}</Badge> : null}</td> : null}
      {show('edited') ? (
        <td className="col-edited">
          <CompactAttribution updatedAt={p.updatedAt} updatedByUserId={p.updatedByUserId} />
        </td>
      ) : null}
      <td className="col-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="row-action"
          title="Process in Image Workspace"
          onClick={() => onProcess(p)}
        >Process →</button>
      </td>
    </tr>
  );
});
