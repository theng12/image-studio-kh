/**
 * v0.49.53 — "Watermark external photos".
 *
 * Apply an overlay template to arbitrary image files on disk — no
 * products involved. Pick a template, add photos (files or a whole
 * folder), pick an output folder, and each photo is composed with the
 * overlay and written out (re-encoded to its source format so JPGs stay
 * JPGs). Token-based template elements (SKU / barcode / brand) render
 * empty for external files — this is for logo / text watermark templates.
 *
 * Local-only: the file paths are on this machine's disk, so the caller
 * only shows the entry point in standalone / host mode.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Select } from '../../components/ui.jsx';

export function ExternalWatermarkModal({ open, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [paths, setPaths] = useState([]);        // absolute input file paths
  const [outputFolder, setOutputFolder] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setPaths([]); setOutputFolder(''); setResult(null);
    window.api.templates.list()
      .then((rows) => {
        setTemplates(Array.isArray(rows) ? rows : []);
        if (rows?.length && !templateId) setTemplateId(rows[0].id);
      })
      .catch((err) => addToast(err.message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !running) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  const dedupCount = useMemo(() => new Set(paths).size, [paths]);

  async function addPhotos() {
    try {
      const picked = await window.api.files.pickImageFile({ multiple: true });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      setPaths((prev) => Array.from(new Set([...prev, ...list])));
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function addFolder() {
    try {
      const folder = await window.api.files.pickFolder();
      if (!folder) return;
      const found = await window.api.files.scanImageFiles(folder);
      if (!found || found.length === 0) { addToast('No images found in that folder', 'info'); return; }
      setPaths((prev) => Array.from(new Set([...prev, ...found])));
      addToast(`Added ${found.length} image${found.length === 1 ? '' : 's'} from folder`, 'success');
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function pickOutput() {
    try {
      const f = await window.api.files.pickFolder();
      if (f) setOutputFolder(f);
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function run() {
    if (!templateId) { addToast('Pick a template', 'error'); return; }
    if (dedupCount === 0) { addToast('Add at least one photo', 'error'); return; }
    if (!outputFolder) { addToast('Pick an output folder', 'error'); return; }
    setRunning(true);
    setResult(null);
    try {
      const res = await window.api.templates.applyToExternal({
        templateId, inputPaths: Array.from(new Set(paths)), outputFolder,
      });
      setResult(res);
      const failed = res?.failed?.length ?? 0;
      addToast(
        failed === 0
          ? `Watermarked ${res.done} photo${res.done === 1 ? '' : 's'} → ${outputFolder}`
          : `Done ${res.done}, ${failed} failed`,
        failed === 0 ? 'success' : 'info',
      );
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={() => { if (!running) onClose(); }}>
      <div className="modal modal--md" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>Watermark external photos</h2>
          <button className="modal__close" aria-label="Close (Esc)" title="Close (Esc)" onClick={() => !running && onClose()}>×</button>
        </header>
        <div className="modal__body">
          <p className="muted" style={{ marginTop: 0 }}>
            Apply an overlay template to photos on your disk — no need to add them as products.
            Best with a logo / text watermark template (product fields like SKU stay blank for
            external photos). Outputs keep each photo’s format.
          </p>

          <label className="field">
            <span className="field__label">Template *</span>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.length === 0 ? <option value="">No templates — create one first</option> : null}
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </label>

          <div className="field">
            <span className="field__label">Photos ({dedupCount})</span>
            <div className="ext-wm__row">
              <Button onClick={addPhotos} disabled={running}>Add photos…</Button>
              <Button onClick={addFolder} disabled={running}>Add folder…</Button>
              {dedupCount > 0 && <Button variant="ghost" onClick={() => setPaths([])} disabled={running}>Clear</Button>}
            </div>
            {dedupCount > 0 && (
              <span className="field__hint">{dedupCount} photo{dedupCount === 1 ? '' : 's'} queued.</span>
            )}
          </div>

          <div className="field">
            <span className="field__label">Save watermarked copies to *</span>
            <div className="ext-wm__row">
              <Button onClick={pickOutput} disabled={running}>Pick output folder…</Button>
              <span className="ext-wm__path">{outputFolder || <em className="muted">(no folder picked)</em>}</span>
            </div>
          </div>

          {result && (
            <div className="ext-wm__result">
              Done: {result.done} · Failed: {result.failed?.length ?? 0}.
              {result.done > 0 ? ` Saved to ${result.outputFolder}.` : ''}
            </div>
          )}
        </div>
        <footer className="modal__footer">
          <Button variant="ghost" onClick={() => !running && onClose()}>Close</Button>
          <Button variant="primary" onClick={run} disabled={running || !templateId || dedupCount === 0 || !outputFolder}>
            {running ? 'Applying…' : `Apply to ${dedupCount} photo${dedupCount === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </div>
  );
}
