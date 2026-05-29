/**
 * v0.17.1: ProgressOverlay — bottom-right floating widget that shows
 * any in-flight bulk operation. Operations come through
 * `window.api.events.onProgress`; the store routes them into
 * `progressOps` keyed by id. We render one row per active op.
 *
 * Designed to be glanceable, not interactive: no dismiss button (the
 * operation finishes itself), no clicks. If we ever need cancel, the
 * row gets an X button that fires a `progress:cancel` event with the
 * id back to main.
 */
import { useAppStore } from '../store/index.js';

function kindLabel(kind) {
  switch (kind) {
    case 'auto-match':    return 'Auto-matching by SKU';
    case 'bulk-export':   return 'Exporting';
    case 'bulk-queue':    return 'Queueing AI batch';
    case 'export-run':    return 'Running export';
    case 'spreadsheet':   return 'Importing spreadsheet';
    case 'overlay-apply': return 'Applying overlay template'; // v0.26.18
    default:              return kind || 'Working';
  }
}

export function ProgressOverlay() {
  const progressOps = useAppStore((s) => s.progressOps);
  const ids = Object.keys(progressOps || {});
  if (ids.length === 0) return null;

  return (
    <div className="progress-overlay" role="status" aria-live="polite">
      {ids.map((id) => {
        const op = progressOps[id];
        const pct = op?.total > 0
          ? Math.min(100, Math.round((op.done / op.total) * 100))
          : null;
        return (
          <div key={id} className="progress-overlay__row">
            <div className="progress-overlay__head">
              <span className="progress-overlay__title">{kindLabel(op.kind)}</span>
              <span className="progress-overlay__count">
                {op.total > 0 ? `${op.done} / ${op.total}` : `${op.done ?? 0}`}
              </span>
            </div>
            {op.label ? (
              <div className="progress-overlay__label" title={op.label}>{op.label}</div>
            ) : null}
            <div className="progress-overlay__bar">
              <div
                className={`progress-overlay__bar-fill${pct == null ? ' is-indeterminate' : ''}`}
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
            {op.phase ? (
              <div className="progress-overlay__phase">{op.phase}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
