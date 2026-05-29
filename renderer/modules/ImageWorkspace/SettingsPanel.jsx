import { Button, Input, Select } from '../../components/ui.jsx';
import { Section } from '../../components/Section.jsx';
import { FILL_SWATCHES, MARKETPLACE_PRESETS, WATERMARK_CORNERS, getPreset } from '../../lib/presets.js';
import { useAppStore } from '../../store/index.js';

export function SettingsPanel({
  settings,
  onChange,
  onApplyThis,
  onApplyAll,
  onSave,
  saveStatus,
  totalImages,
  processing,
  hasImage,
  watermarkSrc,
  onUploadWatermark,
  fillPreview,
  onToggleFillPreview,
}) {
  // Engine selector lives in store-backed config so the Workspace, Settings
  // page, and any future caller all read the same value. Changing it here
  // writes through to settings.json and refreshes the store mirror.
  const appConfig = useAppStore((s) => s.appConfig);
  const refreshAppConfig = useAppStore((s) => s.refreshAppConfig);
  const addToast = useAppStore((s) => s.addToast);
  const setActiveModule = useAppStore((s) => s.setActiveModule);

  async function setEngine(value) {
    try {
      await window.api.settings.setOne('bgRemovalEngine', value);
      await refreshAppConfig();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }
  const wm = settings.watermark;

  function patch(part) {
    onChange({ ...settings, ...part });
  }

  function patchWatermark(part) {
    onChange({ ...settings, watermark: { ...wm, ...part } });
  }

  function applyPreset(presetId) {
    const p = getPreset(presetId);
    onChange({
      ...settings,
      presetId: p.id,
      canvasWidth: p.width,
      canvasHeight: p.height,
      colorProfile: p.colorProfile,
    });
  }

  return (
    <aside className="ws-panel" aria-label="Processing settings">
      <div className="ws-panel__scroll">
        <Section title="Background">
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.removeBackground}
              onChange={(e) => patch({ removeBackground: e.target.checked })}
            />
            <span>Remove background</span>
          </label>

          {/* Engine picker — only visible when bg removal is on. 'Local' is
              the bundled @imgly WASM (downloads once, runs offline). 'remove.bg'
              hits the paid cloud API and requires a key configured in Settings. */}
          {settings.removeBackground ? (
            <div className="ws-bg-engine">
              <div className="ws-bg-engine__row">
                <span className="ws-bg-engine__label">Engine</span>
                <div className="ws-toolbar__group">
                  <button
                    type="button"
                    className={`segment${appConfig.bgRemovalEngine !== 'removebg' ? ' is-active' : ''}`}
                    onClick={() => setEngine('local')}
                    title="Bundled @imgly WASM — first run downloads a ~80MB model, then offline forever"
                  >Local</button>
                  <button
                    type="button"
                    className={`segment${appConfig.bgRemovalEngine === 'removebg' ? ' is-active' : ''}`}
                    onClick={() => setEngine('removebg')}
                    title="remove.bg cloud API — needs a key from Settings"
                  >remove.bg</button>
                </div>
              </div>
              {appConfig.bgRemovalEngine === 'removebg' && !appConfig.removeBgApiKey ? (
                <p className="ws-bg-engine__hint ws-bg-engine__hint--warn">
                  No remove.bg API key set.{' '}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setActiveModule('settings')}
                  >Open Settings</button>
                  {' '}to add one.
                </p>
              ) : (
                <p className="ws-bg-engine__hint">
                  {appConfig.bgRemovalEngine === 'removebg'
                    ? 'Cloud API — ~1s per image. Counts against your remove.bg plan.'
                    : 'Local WASM — first run downloads a ~80MB model (then offline). Pre-download from Settings to avoid the wait.'}
                </p>
              )}
            </div>
          ) : null}

          <div className="swatch-row">
            {FILL_SWATCHES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`swatch${settings.backgroundColor === s.value ? ' is-active' : ''}`}
                style={{ background: s.value }}
                onClick={() => patch({ backgroundColor: s.value })}
                title={s.label}
                aria-label={s.label}
              />
            ))}
            <label className="swatch swatch--custom" title="Custom color">
              <input
                type="color"
                value={settings.backgroundColor}
                onChange={(e) => patch({ backgroundColor: e.target.value })}
                aria-label="Custom background color"
              />
            </label>
          </div>

          <label className="toggle toggle--inline">
            <input
              type="checkbox"
              checked={fillPreview}
              onChange={(e) => onToggleFillPreview(e.target.checked)}
            />
            <span>Fill preview on canvas</span>
          </label>
          <p className="ws-hint">Toggle to see the fill color behind the product.</p>
        </Section>

        <Section title="Canvas &amp; Size">
          <div className="preset-row">
            {MARKETPLACE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`preset-chip${settings.presetId === p.id ? ' is-active' : ''}`}
                onClick={() => applyPreset(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="grid-2">
            <label className="micro-field">
              <span>Width</span>
              <Input
                type="number"
                value={settings.canvasWidth}
                onChange={(e) => patch({ canvasWidth: Number(e.target.value) || 0, presetId: 'custom' })}
                min="64"
                max="8192"
              />
            </label>
            <label className="micro-field">
              <span>Height</span>
              <Input
                type="number"
                value={settings.canvasHeight}
                onChange={(e) => patch({ canvasHeight: Number(e.target.value) || 0, presetId: 'custom' })}
                min="64"
                max="8192"
              />
            </label>
          </div>

          <label className="slider-field">
            <div className="slider-field__head">
              <span>Product fill</span>
              <span className="slider-field__value">{settings.productFillPct}%</span>
            </div>
            <input
              type="range"
              min="50"
              max="100"
              step="1"
              value={settings.productFillPct}
              onChange={(e) => patch({ productFillPct: Number(e.target.value) })}
            />
          </label>
        </Section>

        <Section title="Orient">
          {/* Rotation in 90° steps. Lossless when baked by Sharp because
              we're using multiples of 90 (no resampling needed). */}
          <div className="rotate-row">
            <div className="ws-toolbar__group">
              <button
                type="button"
                className="segment"
                onClick={() => patch({ rotation: ((settings.rotation ?? 0) - 90 + 360) % 360 })}
                title="Rotate 90° left"
              >
                <RotateGlyph direction="left" /> 90° left
              </button>
              <button
                type="button"
                className="segment"
                onClick={() => patch({ rotation: ((settings.rotation ?? 0) + 90) % 360 })}
                title="Rotate 90° right"
              >
                <RotateGlyph direction="right" /> 90° right
              </button>
              <button
                type="button"
                className={`segment${(settings.rotation ?? 0) === 0 ? ' is-active' : ''}`}
                onClick={() => patch({ rotation: 0 })}
                title="Reset to original orientation"
              >
                Reset
              </button>
            </div>
            <span className="muted rotate-row__value">
              {(((settings.rotation ?? 0) % 360) + 360) % 360}°
            </span>
          </div>
        </Section>

        <Section title="Enhance">
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.autoAdjust}
              onChange={(e) => patch({ autoAdjust: e.target.checked })}
            />
            <span>Auto-adjust</span>
          </label>

          <SliderField
            label="Brightness"
            value={settings.brightness}
            min={-100}
            max={100}
            onChange={(v) => patch({ brightness: v })}
          />
          <SliderField
            label="Contrast"
            value={settings.contrast}
            min={-100}
            max={100}
            onChange={(v) => patch({ contrast: v })}
          />

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.shadow}
              onChange={(e) => patch({ shadow: e.target.checked })}
            />
            <span>Add shadow</span>
          </label>
          <p className="ws-hint">Shadow only renders when background removal is on.</p>
        </Section>

        <Section title="Watermark" defaultOpen={false}>
          <label className="toggle">
            <input
              type="checkbox"
              checked={wm.enabled}
              onChange={(e) => patchWatermark({ enabled: e.target.checked })}
            />
            <span>Show watermark</span>
          </label>

          {wm.enabled ? (
            <>
              <div className="watermark-upload">
                {watermarkSrc ? (
                  <div className="watermark-preview">
                    <img src={watermarkSrc} alt="Watermark preview" />
                  </div>
                ) : (
                  <div className="watermark-preview is-empty">No logo yet</div>
                )}
                <Button onClick={onUploadWatermark}>
                  {wm.relativePath ? 'Replace logo…' : 'Choose logo…'}
                </Button>
              </div>

              <div className="micro-field">
                <span>Corner</span>
                <div className="corner-picker">
                  {WATERMARK_CORNERS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className={`corner-btn corner-btn--${c.value}${wm.corner === c.value ? ' is-active' : ''}`}
                      onClick={() => patchWatermark({ corner: c.value })}
                      title={c.label}
                      aria-label={c.label}
                    />
                  ))}
                </div>
              </div>

              <SliderField
                label="Opacity"
                value={Math.round(wm.opacity * 100)}
                min={10}
                max={100}
                suffix="%"
                onChange={(v) => patchWatermark({ opacity: v / 100 })}
              />
            </>
          ) : null}
        </Section>
      </div>

      <div className="ws-panel__actions">
        {/* Save: persists the current settings (rotation, crop, watermark,
            etc.) without running the processing pipeline. Auto-save also
            does this on a 500ms debounce, but the explicit button is the
            user's "commit now and don't worry about timing" affordance. */}
        <Button
          onClick={onSave}
          disabled={!hasImage || saveStatus?.state === 'saving'}
          title="Save settings without re-processing (auto-save also runs in the background)"
        >
          {saveStatus?.state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        <Button
          onClick={onApplyThis}
          disabled={!hasImage || processing}
          variant="primary"
        >
          {processing ? 'Processing…' : 'Apply to this image'}
        </Button>
        <Button
          onClick={onApplyAll}
          disabled={!hasImage || processing || totalImages < 1}
        >
          Apply to all {totalImages > 0 ? `(${totalImages})` : ''}
        </Button>
        <p className="ws-hint ws-hint--center">
          Save persists settings only. Apply runs the processing pipeline (bg removal, canvas composition, watermark).
        </p>
      </div>
    </aside>
  );
}

function RotateGlyph({ direction = 'right' }) {
  // 14×14 curved-arrow glyph. Drawn once and mirrored for left vs right.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      style={{ marginRight: 4, transform: direction === 'left' ? 'scaleX(-1)' : 'none' }}
    >
      <path d="M3 7a4 4 0 1 1 1.2 2.85" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 4.5V7h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SliderField({ label, value, min, max, suffix = '', onChange }) {
  return (
    <label className="slider-field">
      <div className="slider-field__head">
        <span>{label}</span>
        <span className="slider-field__value">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step="1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
