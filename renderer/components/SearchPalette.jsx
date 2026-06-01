/**
 * v0.18.2: global search palette (Cmd+K).
 *
 * Opens via the Cmd/Ctrl+K shortcut wired in App.jsx. Searches
 * across products (SKU, name, color/finish — v0.49.37 narrowed from
 * the original sku+name+barcode+secondary_code+description+color set;
 * a barcode hit looks identical to a name hit in the dropdown, so
 * users couldn't tell why a row was matching), brands (name), and
 * categories (name) for the active company. Live results as you type
 * with a 150ms debounce so we don't hammer the server on every keystroke.
 *
 * Keyboard model:
 *   - ↑ / ↓ — move the highlight
 *   - Enter — open the highlighted result
 *   - Esc   — close the palette
 *   - Tab   — closes (matches Spotlight / Raycast)
 *
 * Click also opens. Picking a result:
 *   - product  → open Library, set side-panel to that product
 *   - brand    → open Brands page
 *   - category → open Library with that category filtered
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/index.js';

const DEBOUNCE_MS = 150;

function kindBadge(kind) {
  switch (kind) {
    case 'product':  return 'Product';
    case 'brand':    return 'Brand';
    case 'category': return 'Category';
    default:         return kind || '';
  }
}

export function SearchPalette({ open, onClose }) {
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const setActiveProductId = useAppStore((s) => s.setActiveProductId);
  const setCategoryFilter = useAppStore((s) => s.toggleCategoryFilter);
  const clearCategoryFilter = useAppStore((s) => s.clearCategoryFilter);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Reset state every time the palette opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setHighlight(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const hits = await window.api.search.global(q, 30);
        // Only commit if the query hasn't changed since we issued
        // the search — guards against an out-of-order resolve that
        // would otherwise stomp newer results with older ones.
        if (query.trim() === q) {
          setResults(Array.isArray(hits) ? hits : []);
          setHighlight(0);
        }
      } catch (_err) {
        // Search failures are non-fatal; just show no results.
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [query, open]);

  function openResult(r) {
    if (!r) return;
    onClose?.();
    if (r.kind === 'product') {
      setActiveModule('library');
      setActiveProductId(r.productId);
    } else if (r.kind === 'brand') {
      setActiveModule('brands');
      // No brand-id deep-link yet — just jumping to the Brands page.
    } else if (r.kind === 'category') {
      setActiveModule('library');
      // Apply the category as a filter so the Library narrows to it.
      // Clear any existing category filter first to avoid stacking.
      clearCategoryFilter?.();
      setCategoryFilter?.(r.id);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      onClose?.();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(results.length - 1, h + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      openResult(results[highlight]);
      return;
    }
  }

  if (!open) return null;
  const showResults = query.trim().length > 0;

  return (
    <div className="palette-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose?.();
    }}>
      <div className="palette" role="dialog" aria-label="Search palette">
        <div className="palette__input-wrap">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            placeholder={activeCompanyId ? 'Search SKUs, products, brands, categories…' : 'Pick a company first'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!activeCompanyId}
          />
          {searching ? <span className="palette__hint">searching…</span> : null}
        </div>

        {showResults ? (
          <div className="palette__results">
            {results.length === 0 && !searching ? (
              <div className="palette__empty">No matches for &ldquo;{query}&rdquo;.</div>
            ) : (
              <ul role="listbox">
                {results.map((r, i) => (
                  <li
                    key={`${r.kind}:${r.id}`}
                    role="option"
                    aria-selected={i === highlight}
                    className={`palette__row${i === highlight ? ' is-active' : ''}`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => openResult(r)}
                  >
                    <span className="palette__kind">{kindBadge(r.kind)}</span>
                    <span className="palette__label">{r.label}</span>
                    {r.sublabel ? <span className="palette__sub">{r.sublabel}</span> : null}
                    {r.extra ? <span className="palette__extra">{r.extra}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="palette__hint-row">
            Type to search · ↑↓ navigate · Enter to open · Esc to close
          </div>
        )}
      </div>
    </div>
  );
}
