import { memo, useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui.jsx';

/**
 * Memoized thumbnail tile that lazy-loads its preview via IPC. Renderer
 * can't access arbitrary file:// paths, so we ask the main process to
 * sharp-thumb it and hand back a small data: URL. Memoized on `abs` so
 * adding/removing other tiles doesn't re-fetch every preview.
 */
const Thumb = memo(function Thumb({ abs }) {
  const [src, setSrc] = useState(null);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.api.files.readImageThumb(abs)
      .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
      .catch(() => { if (!cancelled) setErrored(true); });
    return () => { cancelled = true; };
  }, [abs]);
  if (errored) return <div className="ai-bulk-source__tile-err" aria-hidden>—</div>;
  if (!src) return <div className="ai-bulk-source__tile-skel" aria-hidden />;
  return <img src={src} alt="" />;
});

/**
 * Bulk source picker for AI Studio's Bulk tab.
 *
 * Three input methods, all collapsed into a single `files` array of
 * absolute paths:
 *   - Pick a folder → recursive scan via `ai.scanBulkFolder` IPC.
 *   - Pick individual files via the multi-select file dialog.
 *   - Drag-and-drop files / a folder onto the panel.
 *
 * The parent owns the queue button — this component reports its file list
 * through `onFilesChange` and that's it. Keeps responsibilities clean:
 * AIStudio knows about the model/prompt; BulkSourcePanel only knows about
 * sources.
 */
export function BulkSourcePanel({ files, onFilesChange, onError, exportDir, onExportDirChange }) {
  const [scanning, setScanning] = useState(false);
  const [isOver, setIsOver] = useState(false);

  async function handlePickExportDir() {
    try {
      const folderPath = await window.api.files.pickFolder();
      if (!folderPath) return;
      onExportDirChange?.(folderPath);
    } catch (err) {
      onError?.(err.message);
    }
  }

  const addPaths = useCallback((newPaths) => {
    if (!newPaths?.length) return;
    onFilesChange((curr) => {
      const seen = new Set(curr.map((f) => f.abs));
      const merged = [...curr];
      for (const p of newPaths) {
        if (!seen.has(p.abs)) {
          merged.push(p);
          seen.add(p.abs);
        }
      }
      return merged;
    });
  }, [onFilesChange]);

  async function handlePickFolder() {
    try {
      const folderPath = await window.api.files.pickFolder();
      if (!folderPath) return;
      setScanning(true);
      const found = await window.api.ai.scanBulkFolder(folderPath);
      if (found.length === 0) {
        onError?.('No images found in the selected folder.');
      } else {
        addPaths(found);
      }
    } catch (err) {
      onError?.(err.message);
    } finally {
      setScanning(false);
    }
  }

  async function handlePickFiles() {
    try {
      const picked = await window.api.files.pickImageFile({ multiple: true });
      if (!picked) return;
      const arr = Array.isArray(picked) ? picked : [picked];
      addPaths(arr.map((abs) => ({ abs, rel: abs, name: abs.split('/').pop() || abs, size: 0 })));
    } catch (err) {
      onError?.(err.message);
    }
  }

  /* Drag-drop. Electron exposes a native filesystem path on File objects via
     `.path`. For folders, we feed the path through scanBulkFolder so the
     recursive behavior matches the folder-button case. */
  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(true);
  }
  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
  }
  async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    const imagePaths = [];
    for (const f of dropped) {
      if (!f.path) continue; // browser-only File without disk path; skip
      // Heuristic: if no extension AND it's clearly a folder, scan it.
      const looksLikeFolder = !/\.\w{2,5}$/.test(f.name);
      if (looksLikeFolder) {
        try {
          const found = await window.api.ai.scanBulkFolder(f.path);
          imagePaths.push(...found);
        } catch {/* fall through */}
      } else if (/\.(jpe?g|png|webp)$/i.test(f.name)) {
        imagePaths.push({ abs: f.path, rel: f.path, name: f.name, size: f.size ?? 0 });
      }
    }
    if (imagePaths.length === 0) {
      onError?.('No image files found in the dropped items.');
      return;
    }
    addPaths(imagePaths);
  }

  function removeAt(idx) {
    onFilesChange((curr) => curr.filter((_, i) => i !== idx));
  }
  function clearAll() {
    onFilesChange(() => []);
  }

  return (
    <div
      className={`ai-bulk-source${isOver ? ' is-over' : ''}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="ai-bulk-source__head">
        <div>
          <div className="ai-bulk-source__title">Source images</div>
          <div className="ai-bulk-source__sub">
            {files.length === 0
              ? 'Pick a folder, choose files, or drag images here.'
              : `${files.length} image${files.length === 1 ? '' : 's'} ready to queue.`}
          </div>
        </div>
        <div className="ai-bulk-source__actions">
          <Button onClick={handlePickFolder} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Pick folder…'}
          </Button>
          <Button onClick={handlePickFiles}>Pick files…</Button>
          {files.length > 0 ? (
            <Button variant="ghost" onClick={clearAll}>Clear</Button>
          ) : null}
        </div>
      </div>

      {/* v0.11.5: optional external export folder. When set, the runner
          also copies each result to this folder using the source image's
          basename, so users can match outputs back to their inputs at a
          glance and skip the export-by-tile workflow on the bulk gallery. */}
      <div className="ai-bulk-source__export">
        <div className="ai-bulk-source__export-label">Export to folder</div>
        <div className="ai-bulk-source__export-row">
          {exportDir ? (
            <code className="ai-bulk-source__export-path" title={exportDir}>{exportDir}</code>
          ) : (
            <span className="muted ai-bulk-source__export-empty">
              Not set — results stay in the internal bulk gallery only.
            </span>
          )}
          <div className="ai-bulk-source__export-actions">
            <Button onClick={handlePickExportDir}>
              {exportDir ? 'Change…' : 'Pick folder…'}
            </Button>
            {exportDir ? (
              <Button variant="ghost" onClick={() => onExportDirChange?.(null)}>Clear</Button>
            ) : null}
          </div>
        </div>
        <p className="ai-bulk-source__export-hint">
          Each result is also saved here using the input file&apos;s name (e.g. <code>cat.jpg</code> → <code>cat.png</code>). Internal gallery copies are kept as well, so you can still favorite / promote results in AI Studio.
        </p>
      </div>

      {files.length === 0 ? (
        <div className="ai-bulk-source__dropzone" aria-hidden>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M3 16l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="8" cy="9" r="1.5" fill="currentColor" />
          </svg>
          <div className="ai-bulk-source__dropzone-label">Drop images or a folder here</div>
          <div className="ai-bulk-source__dropzone-hint">Recursive scan, up to 5 levels deep — jpg, png, webp.</div>
        </div>
      ) : (
        <div className="ai-bulk-source__grid">
          {files.map((f, i) => (
            <div key={`${f.abs}-${i}`} className="ai-bulk-source__tile" title={f.rel || f.abs}>
              <Thumb abs={f.abs} />
              <button
                type="button"
                className="ai-bulk-source__tile-remove"
                aria-label="Remove"
                title="Remove"
                onClick={() => removeAt(i)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <div className="ai-bulk-source__tile-name">{f.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
