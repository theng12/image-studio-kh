import { useEffect, useRef, useState } from 'react';

/**
 * v0.22.7: Library table columns — modular.
 *
 * The user picks which columns are visible via the "Columns" toolbar
 * button. SKU and the thumb stay locked-on (the thumb is the primary
 * visual anchor; SKU is the row identifier — hiding either turns the
 * table into a puzzle). Everything else can be toggled off and the
 * choice persists to localStorage.
 *
 * COLUMN_DEFS is the source of truth. The TableView reads it twice:
 * once for the header row, once for each TableRow's cells. Add a new
 * column → add it here, then add a `<th>` and `<td>` block that checks
 * `visibleCols.has(key)` to render it.
 */
export const COLUMN_DEFS = [
  { key: 'brand',    label: 'Brand',          defaultVisible: true,  optional: true },
  { key: 'name',     label: 'Name',           defaultVisible: true,  optional: true },
  { key: 'category', label: 'Category',       defaultVisible: true,  optional: true },
  { key: 'color',    label: 'Color / Finish', defaultVisible: true,  optional: true },
  { key: 'images',   label: 'Images',         defaultVisible: true,  optional: true },
  { key: 'process',  label: 'Process',        defaultVisible: true,  optional: true },
  { key: 'status',   label: 'Status',         defaultVisible: true,  optional: true },
  { key: 'edited',   label: 'Edited',         defaultVisible: true,  optional: true },
];
const COLUMNS_STORAGE_KEY = 'ProductLibrary.visibleColumns';
export function loadVisibleColumns() {
  // localStorage stores a comma-separated list of visible keys. Missing
  // keys fall back to their `defaultVisible`. That way adding a new
  // column in a future release doesn't make the user's existing saved
  // set hide it — they only see the new column off if they actively
  // turned it off.
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) {
      return new Set(COLUMN_DEFS.filter((c) => c.defaultVisible).map((c) => c.key));
    }
    const saved = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
    // Recompose: any column not mentioned at all → use defaultVisible.
    // Any column explicitly in the saved set → on. The persistence write
    // path always writes the FULL list of currently-on keys so this
    // forward-compat fallback only kicks in when a NEW column appears
    // in COLUMN_DEFS that wasn't there at the user's last save.
    const next = new Set();
    for (const c of COLUMN_DEFS) {
      if (saved.has(c.key)) next.add(c.key);
      else if (!raw.includes(c.key) && c.defaultVisible) next.add(c.key);
    }
    return next;
  } catch {
    return new Set(COLUMN_DEFS.filter((c) => c.defaultVisible).map((c) => c.key));
  }
}
export function saveVisibleColumns(set) {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, Array.from(set).join(','));
  } catch {}
}

/**
 * v0.22.7: small toolbar control to toggle Library table columns
 * on/off. Closes on outside click + Esc. Anchor button shows the
 * visible-count so the user can tell at a glance which mode they're
 * in (e.g. "Columns · 5/8").
 *
 * Kept inside this module rather than promoted to a shared component
 * because it's pretty tightly coupled to COLUMN_DEFS at the top of
 * the file. If a second list ever wants the same pattern, it's an
 * easy lift to extract.
 */
export function ColumnsControl({ visibleCols, onToggle, onReset }) {
  const [open, setOpen] = useState(false);
  const popRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      // Close if the click landed outside both the popover and the
      // trigger button. The button has its own onClick toggle so we
      // don't want to instantly re-close after it opens.
      const pop = popRef.current;
      const btn = btnRef.current;
      if (pop && !pop.contains(e.target) && btn && !btn.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visibleCount = visibleCols.size;
  const totalOptional = COLUMN_DEFS.length;

  return (
    <div className="ws-toolbar__group lib-columns">
      <button
        ref={btnRef}
        type="button"
        className={`segment${open ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Choose which columns appear in the table"
      >
        Columns · {visibleCount}/{totalOptional}
      </button>
      {open ? (
        <div ref={popRef} className="lib-columns__pop" role="menu">
          <div className="lib-columns__head">
            <span>Show columns</span>
            <button
              type="button"
              className="lib-columns__reset"
              onClick={() => { onReset(); setOpen(false); }}
              title="Show all default columns"
            >Reset</button>
          </div>
          <ul className="lib-columns__list">
            <li className="lib-columns__item lib-columns__item--locked">
              <label>
                <input type="checkbox" checked disabled />
                <span>SKU + Thumbnail</span>
              </label>
              <span className="lib-columns__lock-note">Always shown</span>
            </li>
            {COLUMN_DEFS.map((c) => (
              <li key={c.key} className="lib-columns__item">
                <label>
                  <input
                    type="checkbox"
                    checked={visibleCols.has(c.key)}
                    onChange={() => onToggle(c.key)}
                  />
                  <span>{c.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
