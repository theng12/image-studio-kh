import { useState } from 'react';
import { Button, Modal } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

const RULES = [
  ['Filename = SKU', '"abc-123.jpg" → main image of product with SKU "abc-123". Case-insensitive.'],
  ['Numeric suffix → gallery position', '"abc-123-1.jpg", "abc-123-2.jpg" attach in that order. -, _, or space work as separators.'],
  ['Per-SKU subfolder', 'A folder named "abc-123/" attaches all its images to that SKU. "main.jpg" / "primary" / "cover" become the main; "1.jpg", "2.jpg" set the order.'],
  ['Duplicates are skipped', 'Every image is hashed by content. Same file imported twice is stored once.'],
  ['Up to 5 levels deep', 'Hidden folders (starting with ".") are skipped.'],
  ['Existing images stay', 'Matched images join the start of the product\'s image list. Manually-added images that didn\'t match this run stay at the end.'],
  ['Max 50 images per product', 'Extras for a single SKU are skipped and reported in the results.'],
];

export function AutoMatchModal({ open, onClose }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const addToast = useAppStore((s) => s.addToast);

  const [step, setStep] = useState('intro'); // 'intro' | 'running' | 'results'
  const [stats, setStats] = useState(null);
  const [folder, setFolder] = useState(null);

  function handleClose() {
    setStep('intro');
    setStats(null);
    setFolder(null);
    onClose();
  }

  async function handleChooseFolder() {
    try {
      const picked = await window.api.files.pickFolder();
      if (!picked) return;
      setFolder(picked);
      setStep('running');
      const result = await window.api.images.autoMatchBySku(activeCompanyId, picked);
      setStats(result);
      setStep('results');
      await Promise.all([refreshProducts(), refreshDashboard()]);
    } catch (err) {
      addToast(err.message, 'error');
      setStep('intro');
    }
  }

  const footer =
    step === 'intro' ? (
      <>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="primary" onClick={handleChooseFolder}>Choose folder…</Button>
      </>
    ) : step === 'results' ? (
      <Button variant="primary" onClick={handleClose}>Done</Button>
    ) : null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Auto-match images"
      footer={footer}
      closeOnBackdrop={step !== 'running'}
    >
      {step === 'intro' ? (
        <>
          <p className="ws-hint">Pick a folder; we'll scan for image files and try to match them to your existing SKUs.</p>
          <h3 className="automatch__heading">Matching rules</h3>
          <ol className="automatch__rules">
            {RULES.map(([title, body], i) => (
              <li key={i}>
                <strong>{title}.</strong> {body}
              </li>
            ))}
          </ol>
        </>
      ) : step === 'running' ? (
        <div className="automatch__running">
          <div className="ws-canvas__spinner" style={{ borderTopColor: 'var(--c-text)', borderColor: 'rgba(20,20,28,0.15)' }} />
          <div>Scanning <code>{folder}</code>…</div>
        </div>
      ) : stats ? (
        <>
          <div className="automatch__stats">
            <Stat label="Image files scanned"    value={stats.scannedFiles} />
            <Stat label="SKUs matched"           value={`${stats.matchedSkus} / ${stats.totalProducts}`} />
            <Stat label="Images imported"        value={stats.imagesImported}  tone="emerald" />
            <Stat label="Duplicates skipped"     value={stats.imagesSkippedDup} />
            <Stat label="Products updated"       value={stats.productsTouched} />
            <Stat label="Unmatched files"        value={stats.unmatchedFiles} />
            {stats.imagesSkippedCap > 0 ? (
              <Stat label="Over the 50-image cap" value={stats.imagesSkippedCap} tone="amber" />
            ) : null}
          </div>
          {stats.unmatchedFiles > 0 ? (
            <p className="automatch__warn">
              {stats.unmatchedFiles} file{stats.unmatchedFiles === 1 ? '' : 's'} didn't match any SKU.
              Common reasons: the filename doesn't include the SKU, the file is in a subfolder
              whose name isn't a SKU, or that SKU doesn't exist in this company yet.
              {stats.unmatchedExtCounts && Object.keys(stats.unmatchedExtCounts).length > 0 ? (
                <span className="automatch__ext-breakdown">
                  {' '}By extension:{' '}
                  {Object.entries(stats.unmatchedExtCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([ext, n]) => `${n} ${ext}`)
                    .join(' · ')}
                </span>
              ) : null}
            </p>
          ) : null}

          {/* Two diagnostic lists so the user can act on what's missing
              without checking every product by hand. */}
          {Array.isArray(stats.unmatchedSamples) && stats.unmatchedSamples.length > 0 ? (
            <DiagnosticList
              title={`Unmatched files (${stats.unmatchedFiles}${stats.unmatchedSamplesCapped ? `, showing first ${stats.unmatchedSamples.length}` : ''})`}
              hint="Files in the source folder that didn't match any SKU. Paths shown relative to the folder you picked. Copy all → paste into a text editor to triage."
              items={stats.unmatchedSamples}
              mono
            />
          ) : null}
          {Array.isArray(stats.productsStillEmpty) && stats.productsStillEmpty.length > 0 ? (
            <DiagnosticList
              title={`Products still without any images (${stats.productsStillEmpty.length}${stats.productsStillEmptyCapped ? '+' : ''})`}
              hint="These SKUs exist in this company but have zero images attached, even after this run."
              items={stats.productsStillEmpty.map((p) => p.name ? `${p.sku} — ${p.name}` : p.sku)}
            />
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`automatch__stat${tone ? ` automatch__stat--${tone}` : ''}`}>
      <div className="automatch__stat-label">{label}</div>
      <div className="automatch__stat-value">{value}</div>
    </div>
  );
}

/**
 * Collapsible list of diagnostic strings (unmatched filenames, SKUs still
 * missing images, etc.). Starts collapsed so the modal stays compact; the
 * user opens it when they want to drill in. The Copy button stuffs the
 * whole list into the clipboard for triage in a text editor.
 */
function DiagnosticList({ title, hint, items, mono = false }) {
  const [open, setOpen] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(items.join('\n'));
      addToast(`Copied ${items.length} line${items.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      addToast(err.message || 'Copy failed', 'error');
    }
  }

  return (
    <details
      className="automatch__diag"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="automatch__diag-summary">
        <span>{title}</span>
        <span className="automatch__diag-actions">
          <button
            type="button"
            className="row-action"
            onClick={(e) => { e.preventDefault(); copyAll(); }}
          >Copy all</button>
        </span>
      </summary>
      {hint ? <p className="automatch__diag-hint">{hint}</p> : null}
      <ul className={`automatch__diag-list${mono ? ' automatch__diag-list--mono' : ''}`}>
        {items.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </details>
  );
}
