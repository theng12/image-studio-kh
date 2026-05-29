import { useEffect, useRef, useState } from 'react';
import { ANCHORS, BARCODE_FORMATS, IMAGE_SOURCES, TOKENS } from './elementDefaults.js';
import { Field, Input, Select, Textarea } from '../../components/ui.jsx';

/**
 * v0.26.17: NumberInput — a controlled number input that doesn't
 * fight the user while they're typing. Background:
 *
 * Plain `<Input type="number" value={x} onChange={...Number(e.target.value)} />`
 * has a frustrating bug for any field with a clamp or a parse step.
 * The moment the user clears the value to retype it, the empty string
 * parses to NaN (or `Number(...)||0` to 0), the clamp kicks in (often
 * to a non-empty floor like 8 for font-size), the parent re-renders
 * with the clamped value, and the input snaps back. The user can't
 * type "120" because clearing the field first shows "8", then "81",
 * then "812" — gets clamped to 400 — wrong.
 *
 * This component:
 *   - holds a local STRING buffer so the input shows whatever you
 *     typed, including empty
 *   - commits on blur, Enter, or arrow-key step
 *   - Esc reverts to the last-committed value
 *   - resyncs from the external `value` prop only when the user is
 *     NOT actively editing (so canvas drag / undo can still update
 *     the input when nothing's typed)
 *   - lets the caller hand in a `clamp` function for parse-time
 *     bounds, and an optional `format` for display normalisation
 *     (e.g. rounding for the displayed percent in FracField)
 */
function NumberInput({
  value,
  onCommit,
  clamp,
  format,
  ...inputProps
}) {
  const fmt = format ?? ((n) => (n == null ? '' : String(n)));
  const [draft, setDraft] = useState(() => fmt(value));
  const dirty = useRef(false);

  // Resync only when the user isn't editing — otherwise we'd squash
  // their in-progress text every time the parent re-renders.
  // v0.26.41 (audit pass): `fmt` is omitted from deps on purpose.
  // It's a closure over the `format` prop, recreated on every render
  // (`format ?? ((n) => …)`). Adding it would cause the effect to
  // re-fire on every parent render → setDraft → re-render → new fmt
  // → re-fire forever. The dirty.current guard handles the
  // "user is typing" case independently; only `value` changing
  // should trigger a re-sync.
  useEffect(() => {
    if (dirty.current) return;
    setDraft(fmt(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit() {
    dirty.current = false;
    const raw = draft.trim();
    if (raw === '' || raw === '-' || raw === '.') {
      // Empty / partial input → revert to last committed.
      setDraft(fmt(value));
      return;
    }
    let parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setDraft(fmt(value));
      return;
    }
    if (clamp) parsed = clamp(parsed);
    // Reflect the clamped value back so the user sees what they
    // actually committed (e.g. typed 9999 → field shows 400).
    setDraft(fmt(parsed));
    if (parsed !== value) onCommit(parsed);
  }

  function handleKey(e) {
    if (e.key === 'Enter')   { e.preventDefault(); e.currentTarget.blur(); }
    if (e.key === 'Escape')  {
      e.preventDefault();
      dirty.current = false;
      setDraft(fmt(value));
      e.currentTarget.blur();
    }
  }

  return (
    <Input
      {...inputProps}
      type="number"
      value={draft}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={handleKey}
    />
  );
}

/**
 * Property inspector for the selected element. Switches form based on
 * element.type. Everything that touches `element` goes through
 * `onChange(patch)` — the editor owns the source-of-truth template.
 *
 * Numeric inputs that represent fractions accept percentages (0–100) for
 * readability and convert to 0–1 fractions on the way out.
 */
export function Inspector({ element, onChange, onDelete }) {
  if (!element) {
    return (
      <div className="ovl-inspector ovl-inspector--empty">
        <p className="muted">Select an element to edit its properties, or click ＋ above to add a new one.</p>
      </div>
    );
  }

  function patchEl(part) { onChange({ ...element, ...part }); }
  function patchFont(part) { onChange({ ...element, font: { ...(element.font ?? {}), ...part } }); }
  function patchBg(part)   { onChange({ ...element, bg:   { ...(element.bg   ?? {}), ...part } }); }

  return (
    <div className="ovl-inspector">
      <div className="ovl-inspector__head">
        <div className="ovl-inspector__type">{labelForType(element.type)}</div>
        {/* v0.26.0 (Phase 4): eye / lock toggles. Inline with the
            type label + delete button so they're always visible at
            the top of the inspector, no scrolling. */}
        <button
          type="button"
          className={`row-action${element.visible === false ? ' is-active' : ''}`}
          // Toggle: hidden → visible, anything else → hidden.
          // `element.visible === false` is true when explicitly hidden;
          // both `true` and `undefined` (default) count as visible.
          onClick={() => patchEl({ visible: element.visible === false })}
          title={element.visible === false ? 'Show element (currently hidden)' : 'Hide element'}
          aria-pressed={element.visible === false}
        >{element.visible === false ? 'Hidden ●' : '👁 Hide'}</button>
        <button
          type="button"
          className={`row-action${element.locked === true ? ' is-active' : ''}`}
          onClick={() => patchEl({ locked: !(element.locked === true) })}
          title={element.locked === true ? 'Unlock element' : 'Lock element (prevents drag / resize / rotate)'}
          aria-pressed={element.locked === true}
        >{element.locked === true ? '🔒 Locked' : '🔓 Lock'}</button>
        <button
          type="button"
          className="row-action"
          onClick={onDelete}
          title="Delete element"
          aria-label="Delete element"
        >Delete</button>
      </div>

      <Section title="Position">
        <div className="grid-2">
          <FracField label="X" value={element.x} onChange={(v) => patchEl({ x: v })} />
          <FracField label="Y" value={element.y} onChange={(v) => patchEl({ y: v })} />
        </div>
        <AnchorPicker value={element.anchor} onChange={(v) => patchEl({ anchor: v })} />
        {/* v0.23.0: rotation control. Stored as degrees in (-180, 180].
            The canvas rotation handle is the primary affordance; this
            input is for precision — type exactly 45° instead of trying
            to drag-snap it. Reset button zeros rotation in one click. */}
        <Field label="Rotation (°)">
          {({ id }) => (
            <div className="field__row">
              <NumberInput
                id={id}
                step="1"
                min="-180"
                max="180"
                value={Math.round(element.rotation ?? 0)}
                clamp={(v) => ((v + 180) % 360 + 360) % 360 - 180}
                onCommit={(v) => patchEl({ rotation: v })}
              />
              <button
                type="button"
                className="field__inline-btn"
                onClick={() => patchEl({ rotation: 0 })}
                title="Reset rotation to 0°"
                disabled={(element.rotation ?? 0) === 0}
              >↺</button>
            </div>
          )}
        </Field>
      </Section>

      {element.type !== 'text' ? (
        <Section title="Size">
          <div className="grid-2">
            <FracField label="Width" value={element.width} onChange={(v) => patchEl({ width: v })} />
            <FracField label="Height" value={element.height} onChange={(v) => patchEl({ height: v })} />
          </div>
        </Section>
      ) : null}

      {element.type === 'text' ? (
        <TextProps element={element} patchEl={patchEl} patchFont={patchFont} patchBg={patchBg} />
      ) : null}
      {element.type === 'barcode' ? (
        <BarcodeProps element={element} patchEl={patchEl} patchBg={patchBg} />
      ) : null}
      {element.type === 'image' ? (
        <ImageProps element={element} patchEl={patchEl} />
      ) : null}
    </div>
  );
}

function labelForType(t) {
  if (t === 'text')    return 'Text element';
  if (t === 'barcode') return 'Barcode element';
  if (t === 'image')   return 'Image element';
  return t;
}

function Section({ title, children }) {
  return (
    <div className="ovl-inspector__section">
      <div className="ovl-inspector__section-title">{title}</div>
      <div className="ovl-inspector__section-body">{children}</div>
    </div>
  );
}

/** Percent ↔ fraction binding. Stored 0–1, edited 0–100. */
function FracField({ label, value, onChange, suffix = '%' }) {
  // Display is rounded to 1 decimal place; underlying value stays
  // full-precision 0..1 fraction. NumberInput holds the edited
  // percent in its local buffer so the user can clear + retype
  // without snapping.
  const pct = Math.round((Number(value) || 0) * 1000) / 10;
  return (
    <Field label={label}>
      {({ id }) => (
        <div className="ovl-suffix-input">
          <NumberInput
            id={id}
            step="0.1"
            min="0"
            max="100"
            value={pct}
            clamp={(v) => Math.max(0, Math.min(100, v))}
            onCommit={(v) => onChange(v / 100)}
          />
          <span className="ovl-suffix-input__suffix">{suffix}</span>
        </div>
      )}
    </Field>
  );
}

function AnchorPicker({ value, onChange }) {
  return (
    <div className="ovl-anchor-grid" role="radiogroup" aria-label="Anchor">
      {ANCHORS.map(([k, label]) => (
        <button
          key={k}
          type="button"
          className={`ovl-anchor-cell${value === k ? ' is-active' : ''}`}
          onClick={() => onChange(k)}
          title={label}
          aria-pressed={value === k}
        >
          <span aria-hidden>●</span>
        </button>
      ))}
    </div>
  );
}

/** Re-usable content field with a chip-row of available tokens. Clicking
 *  a chip appends the token to the textarea so users don't have to remember
 *  the exact spelling. */
function TokenContentField({ value, onChange, multiline = false }) {
  function appendToken(tok) {
    onChange((value ?? '') + tok);
  }
  return (
    <Field label="Content" hint="Mix literal text and tokens. Tokens fill from each product at apply time.">
      {({ id }) => (
        <>
          {multiline ? (
            <Textarea
              id={id}
              rows={2}
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <Input
              id={id}
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
          <div className="ovl-token-chips">
            {TOKENS.map((tok) => (
              <button
                key={tok}
                type="button"
                className="ovl-token-chip"
                onClick={() => appendToken(tok)}
              >{tok}</button>
            ))}
          </div>
        </>
      )}
    </Field>
  );
}

/* ── Per-type property panels ──────────────────────────────────── */

function TextProps({ element, patchEl, patchFont, patchBg }) {
  return (
    <>
      <Section title="Text">
        <TokenContentField value={element.content} onChange={(v) => patchEl({ content: v })} multiline />
        <Field label="Align">
          {({ id }) => (
            <Select id={id} value={element.align ?? 'left'} onChange={(e) => patchEl({ align: e.target.value })}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </Select>
          )}
        </Field>
      </Section>

      <Section title="Font">
        <Field label="Font family">
          {({ id }) => (
            <Input
              id={id}
              value={element.font?.family ?? ''}
              onChange={(e) => patchFont({ family: e.target.value })}
              placeholder="Inter, Helvetica Neue, Arial, sans-serif"
            />
          )}
        </Field>
        <div className="grid-2">
          <Field label="Size">
            {({ id }) => (
              <NumberInput
                id={id}
                min="8"
                max="400"
                value={element.font?.size ?? 48}
                clamp={(v) => Math.max(8, Math.min(400, Math.round(v)))}
                onCommit={(v) => patchFont({ size: v })}
              />
            )}
          </Field>
          <Field label="Color">
            {({ id }) => (
              <Input id={id} type="color" value={element.font?.color ?? '#111111'} onChange={(e) => patchFont({ color: e.target.value })} />
            )}
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Weight">
            {({ id }) => (
              <Select id={id} value={element.font?.weight ?? 'normal'} onChange={(e) => patchFont({ weight: e.target.value })}>
                <option value="normal">Regular</option>
                <option value="bold">Bold</option>
                <option value="100">Thin</option>
                <option value="300">Light</option>
                <option value="500">Medium</option>
                <option value="700">Bold</option>
                <option value="900">Black</option>
              </Select>
            )}
          </Field>
          <Field label="Style">
            {({ id }) => (
              <Select id={id} value={element.font?.italic ? 'italic' : 'normal'} onChange={(e) => patchFont({ italic: e.target.value === 'italic' })}>
                <option value="normal">Regular</option>
                <option value="italic">Italic</option>
              </Select>
            )}
          </Field>
        </div>
      </Section>

      <BgSection element={element} patchBg={patchBg} />
    </>
  );
}

function BarcodeProps({ element, patchEl, patchBg }) {
  return (
    <>
      <Section title="Barcode">
        <TokenContentField value={element.content} onChange={(v) => patchEl({ content: v })} />
        <Field label="Format" hint="EAN-13 needs 12 digits; UPC-A needs 11 digits. Code 128 accepts anything alphanumeric.">
          {({ id }) => (
            <Select id={id} value={element.format ?? 'code128'} onChange={(e) => patchEl({ format: e.target.value })}>
              {BARCODE_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          )}
        </Field>
        <label className="toggle">
          <input
            type="checkbox"
            checked={element.showText !== false}
            onChange={(e) => patchEl({ showText: e.target.checked })}
          />
          <span>Include human-readable text below barcode</span>
        </label>
      </Section>

      <BgSection element={element} patchBg={patchBg} />
    </>
  );
}

function ImageProps({ element, patchEl }) {
  return (
    <Section title="Source">
      <Field label="Image source" hint="Picks the actual file at apply time, based on each product's data.">
        {({ id }) => (
          <Select id={id} value={element.source ?? 'brand-icon'} onChange={(e) => patchEl({ source: e.target.value })}>
            {IMAGE_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Opacity">
        {({ id }) => (
          <Input
            id={id}
            type="range"
            min="0"
            max="100"
            step="1"
            value={Math.round((element.opacity ?? 1) * 100)}
            onChange={(e) => patchEl({ opacity: Math.max(0, Math.min(1, Number(e.target.value) / 100)) })}
          />
        )}
      </Field>
    </Section>
  );
}

function BgSection({ element, patchBg }) {
  const bg = element.bg ?? {};
  const hasBg = !!bg.color;
  return (
    <Section title="Caption band / background (optional)">
      <p className="ws-hint" style={{ marginTop: 0 }}>
        Add a semi-opaque band behind this {element.type === 'barcode' ? 'barcode' : 'text'} so it stays readable
        over a busy photo. Set a colour + lower the opacity for a frosted band; add padding to extend it past the text.
      </p>
      {!hasBg && (
        <button
          type="button"
          className="field__inline-btn"
          style={{ marginBottom: 8 }}
          onClick={() => patchBg({ color: '#000000', opacity: 0.55, padding: 24, radius: 8 })}
        >+ Add caption band</button>
      )}
      <div className="grid-2">
        <Field label="Color">
          {({ id }) => (
            <Input id={id} type="color" value={bg.color ?? '#ffffff'} onChange={(e) => patchBg({ color: e.target.value })} />
          )}
        </Field>
        <Field label="Opacity">
          {({ id }) => (
            <Input
              id={id}
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round((bg.opacity ?? 1) * 100)}
              onChange={(e) => patchBg({ opacity: Math.max(0, Math.min(1, Number(e.target.value) / 100)) })}
            />
          )}
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Padding">
          {({ id }) => (
            <NumberInput
              id={id}
              min="0"
              max="200"
              value={bg.padding ?? 0}
              clamp={(v) => Math.max(0, Math.min(200, Math.round(v)))}
              onCommit={(v) => patchBg({ padding: v })}
            />
          )}
        </Field>
        <Field label="Corner radius">
          {({ id }) => (
            <NumberInput
              id={id}
              min="0"
              max="200"
              value={bg.radius ?? 0}
              clamp={(v) => Math.max(0, Math.min(200, Math.round(v)))}
              onCommit={(v) => patchBg({ radius: v })}
            />
          )}
        </Field>
      </div>
    </Section>
  );
}
