import { useEffect } from 'react';
import { Modal } from './ui.jsx';

/**
 * Lightweight router modal: when the user clicks "Process →" on a Library
 * row or side panel, ask where they want to go. v0.26.16: three
 * destinations now — Image Workspace (crop/watermark/bg removal),
 * AI Studio (image-to-image), Overlay Studio (template-based composite).
 *
 * Keyboard shortcuts: `W` → Workspace, `A` → AI Studio, `O` → Overlay
 * Studio, Esc cancels (via the shared Modal).
 */
export function ProcessDestinationModal({ open, product, onClose, onPickWorkspace, onPickAiStudio, onPickOverlay }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      // Match against the unmodified key, ignore key events fired from form
      // inputs (no inputs in this modal today, but future-proofing).
      if (e.target.matches?.('input, textarea, select')) return;
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        onPickWorkspace?.();
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        onPickAiStudio?.();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        onPickOverlay?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onPickWorkspace, onPickAiStudio, onPickOverlay]);

  if (!open) return null;

  const title = product?.sku
    ? `Process ${product.sku}`
    : 'Process product';

  return (
    <Modal open onClose={onClose} title={title}>
      <p className="process-dest__lead">
        Where would you like to take this product next?
      </p>
      <div className="process-dest__grid">
        <button
          type="button"
          className="process-dest__card"
          onClick={onPickWorkspace}
          autoFocus
        >
          <svg className="process-dest__icon" width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
            {/* crop frame icon */}
            <path d="M6 2v16a2 2 0 0 0 2 2h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M2 6h16a2 2 0 0 1 2 2v14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <div className="process-dest__label">Image Workspace</div>
          <div className="process-dest__sub">
            Crop, rotate, watermark, background removal.
          </div>
          <kbd className="process-dest__kbd">W</kbd>
        </button>

        <button
          type="button"
          className="process-dest__card"
          onClick={onPickAiStudio}
        >
          <svg className="process-dest__icon" width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
            {/* sparkles icon */}
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M19 15l.7 1.9L21.6 17.6l-1.9.7L19 20l-.7-1.7L16.4 17.6l1.9-.7L19 15z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <div className="process-dest__label">AI Studio</div>
          <div className="process-dest__sub">
            Image-to-image generation with the product&apos;s images as source.
          </div>
          <kbd className="process-dest__kbd">A</kbd>
        </button>

        {/* v0.26.16: third destination — Overlay Studio. Opens the
            apply-template modal pre-targeted at this product. Only
            rendered when the caller wires onPickOverlay (Library
            does; future surfaces can opt in or skip). */}
        {onPickOverlay ? (
          <button
            type="button"
            className="process-dest__card"
            onClick={onPickOverlay}
          >
            <svg className="process-dest__icon" width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
              {/* stacked-frames icon — represents overlay-on-image */}
              <rect x="4" y="4" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
              <rect x="8" y="8" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.6" fill="#fff" />
            </svg>
            <div className="process-dest__label">Overlay Studio</div>
            <div className="process-dest__sub">
              Composite a template (text, barcode, frame) onto this product&apos;s main image.
            </div>
            <kbd className="process-dest__kbd">O</kbd>
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
