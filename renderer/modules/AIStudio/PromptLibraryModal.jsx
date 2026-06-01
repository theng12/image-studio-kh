/**
 * v0.39.0: PromptLibraryModal — browse the built-in AI prompt library.
 *
 * Lists the curated presets (renderer/lib/promptLibrary.js) grouped by
 * purpose, with a search filter. Two actions per preset:
 *   - "Use"  → fills the caller's prompt box (onUse(body)) and closes.
 *   - "Save" → adopts it as a normal custom preset via ai:createPrompt, so
 *              it then shows in the Templates list (favorite / edit / delete).
 *
 * Reusable: AI Studio passes onUse = setAiPrompt; the bulk-AI modal passes
 * onUse = setPromptText. Both pass the active companyId so Save can persist.
 */

import { useMemo, useState } from 'react';
import { Modal, Button } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { PROMPT_LIBRARY, PROMPT_CATEGORIES } from '../../lib/promptLibrary.js';

export function PromptLibraryModal({ open, onClose, onUse, companyId, onSaved }) {
  const addToast = useAppStore((s) => s.addToast);
  const [query, setQuery] = useState('');
  const [savingId, setSavingId] = useState(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PROMPT_LIBRARY;
    return PROMPT_LIBRARY.filter(
      (p) => p.label.toLowerCase().includes(q)
        || p.body.toLowerCase().includes(q)
        || p.category.toLowerCase().includes(q),
    );
  }, [query]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const cat of PROMPT_CATEGORIES) map.set(cat, []);
    for (const p of filtered) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category).push(p);
    }
    return Array.from(map.entries()).filter(([, items]) => items.length > 0);
  }, [filtered]);

  function handleUse(p) {
    onUse?.(p.body);
    addToast(`Loaded "${p.label}" into the prompt`, 'info');
    onClose?.();
  }

  async function handleSave(p) {
    if (!companyId) { addToast('Select a company first', 'error'); return; }
    setSavingId(p.id);
    try {
      await window.api.ai.createPrompt({ companyId, name: p.label, body: p.body });
      addToast(`Saved "${p.label}" to your presets`, 'success');
      onSaved?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSavingId(null);
    }
  }

  if (!open) return null;

  return (
    <Modal open={open} title="Prompt library" onClose={onClose} size="xxl">
      <div className="promptlib">
        <p className="promptlib__intro">
          Ready-made prompts for common image jobs. <strong>Use</strong> drops one
          straight into the prompt box; <strong>Save</strong> adds it to your own
          presets so you can favourite, rename, or edit it. Tokens like
          <code>{' {name} '}</code> / <code>{' {color} '}</code> fill from the selected product.
        </p>

        <input
          className="promptlib__search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the library…"
          aria-label="Search prompt library"
        />

        <div className="promptlib__groups">
          {grouped.length === 0 ? (
            <p className="muted">No prompts match “{query}”.</p>
          ) : grouped.map(([cat, items]) => (
            <section key={cat} className="promptlib__group">
              <h4 className="promptlib__cat">{cat}</h4>
              {items.map((p) => (
                <div key={p.id} className="promptlib__row">
                  <div className="promptlib__text">
                    <div className="promptlib__label">{p.label}</div>
                    <div className="promptlib__body">{p.body}</div>
                  </div>
                  <div className="promptlib__actions">
                    <Button onClick={() => handleUse(p)}>Use</Button>
                    <Button
                      onClick={() => handleSave(p)}
                      disabled={savingId === p.id || !companyId}
                    >
                      {savingId === p.id ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>

        <footer className="promptlib__footer">
          <div style={{ flex: 1 }} />
          <Button onClick={onClose}>Close</Button>
        </footer>
      </div>
    </Modal>
  );
}
