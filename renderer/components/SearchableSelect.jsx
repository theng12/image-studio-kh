/**
 * v0.22.19: searchable single-select combobox.
 *
 * Drop-in replacement for native <Select> when the option list is long
 * enough that scrolling through it is painful. Built specifically for
 * the Category field on ProductForm (71 categories at last count) but
 * fully generic — any caller passing `options`, `value`, `onChange`,
 * and the two getter functions can use it.
 *
 * Why a custom combobox and not a 3rd-party library:
 *   - One field needs it today; the rest of the app's native selects
 *     are short enough to stay native.
 *   - Bundle weight: zero new deps.
 *   - Matches the existing visual language of `.input` / `.btn` —
 *     a library would clash with the rest of the form.
 *
 * Keyboard:
 *   - Click the trigger or hit Space/Enter while focused → open
 *   - Type in the search input filters the list
 *   - ↑/↓ moves the highlight; Enter selects; Esc closes
 *   - Tab while open closes (committing whatever's highlighted? no —
 *     just closes, treats the current value as final)
 *
 * Click-outside closes the popover. The popover floats below the
 * trigger via absolute positioning relative to a wrapping <div>.
 *
 * Empty option:
 *   When `emptyLabel` is set (e.g. "— Uncategorized —"), the first
 *   row in the list is a clear/null option that calls onChange with
 *   `emptyValue` (default null). Users can pick "no category" without
 *   needing a separate Clear button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export function SearchableSelect({
  id,
  value,
  options,
  onChange,
  getLabel = (o) => o?.label ?? '',
  getValue = (o) => o?.value ?? '',
  getSecondary,            // optional second-line text per row (e.g. "8 products")
  placeholder = 'Select…',
  emptyLabel,              // when set, prepend a "clear" row with this label
  emptyValue = '',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Currently selected option for the trigger label.
  const selected = useMemo(
    () => options.find((o) => getValue(o) === value) ?? null,
    [options, value, getValue],
  );

  // Filtered options. Case-insensitive substring match against the
  // label. We do NOT search secondary text — keeps "type to find by
  // name" mental model consistent.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => getLabel(o).toLowerCase().includes(q));
  }, [options, query, getLabel]);

  // Full row list including the optional empty row. Highlight index
  // is into THIS array.
  const rows = useMemo(() => {
    const out = [];
    if (emptyLabel != null) out.push({ __empty: true, label: emptyLabel });
    for (const o of filtered) out.push(o);
    return out;
  }, [filtered, emptyLabel]);

  // Keep highlight in range when filtered list shrinks.
  useEffect(() => {
    if (highlight >= rows.length) setHighlight(Math.max(0, rows.length - 1));
  }, [rows.length, highlight]);

  // When the popover opens: reset search, focus input, highlight the
  // current selection (so ↑/↓ feels natural from where you are).
  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    const initialIdx = (() => {
      if (selected) {
        const idx = filtered.indexOf(selected);
        return idx >= 0 ? idx + (emptyLabel != null ? 1 : 0) : 0;
      }
      return 0;
    })();
    setHighlight(initialIdx);
    const t = setTimeout(() => inputRef.current?.focus?.(), 0);
    return () => clearTimeout(t);
    // We intentionally don't depend on `filtered` here — only on
    // open. Filtering after open is handled by the highlight-clamp
    // effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Click-outside closes.
  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Scroll the highlighted row into view when it changes (so ↓ at
  // the bottom of the visible window scrolls).
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-row-idx="${highlight}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, open]);

  function commit(row) {
    if (!row) return;
    if (row.__empty) onChange?.(emptyValue);
    else onChange?.(getValue(row));
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(rows.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(rows[highlight]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);   // don't prevent default — let focus move on
    }
  }

  const triggerLabel = selected ? getLabel(selected) : (emptyLabel ?? placeholder);

  return (
    <div ref={rootRef} className={`sselect${open ? ' is-open' : ''}`}>
      <button
        type="button"
        id={id}
        className={`sselect__trigger${!selected ? ' is-empty' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="sselect__trigger-label">{triggerLabel}</span>
        <svg
          className="sselect__chevron"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
        >
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="sselect__pop" role="listbox">
          <div className="sselect__search">
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search…"
              className="sselect__search-input"
              aria-label="Filter list"
            />
          </div>
          <ul ref={listRef} className="sselect__list">
            {rows.length === 0 ? (
              <li className="sselect__empty muted">No matches</li>
            ) : (
              rows.map((row, idx) => {
                const isEmptyRow = !!row.__empty;
                const isSelected = isEmptyRow
                  ? (value == null || value === '' || value === emptyValue)
                  : getValue(row) === value;
                return (
                  <li
                    key={isEmptyRow ? '__empty' : (getValue(row) ?? idx)}
                    data-row-idx={idx}
                    className={`sselect__row${idx === highlight ? ' is-highlight' : ''}${isSelected ? ' is-selected' : ''}${isEmptyRow ? ' sselect__row--empty' : ''}`}
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseDown={(e) => { e.preventDefault(); commit(row); }}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <span className="sselect__row-label">
                      {isEmptyRow ? row.label : getLabel(row)}
                    </span>
                    {!isEmptyRow && getSecondary ? (
                      <span className="sselect__row-secondary muted">{getSecondary(row)}</span>
                    ) : null}
                    {isSelected ? (
                      <svg className="sselect__row-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M2.5 6.5l2.5 2.5L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
