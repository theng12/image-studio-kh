import { useEffect, useRef, useState } from 'react';
import { elementBox } from './elementDefaults.js';
import { renderBarcodeSVG, formatBarcodeText } from './barcodePreview.js';

/**
 * Editor canvas. Renders the template's elements as absolutely-positioned
 * DOM overlays inside a fixed-aspect-ratio container, on top of an
 * optional backdrop image. Drag-to-move on each element body updates
 * element.x/y; resize handles are deferred to Phase 3 (inspector
 * numeric fields cover that gap for now).
 *
 * Drag math: we keep `el.x` and `el.y` as fractions (0–1) of the design
 * canvas. The canvas DOM is sized to fit the viewport but the *math*
 * stays in fractions so a template designed at 2000×2000 layouts the
 * same way when previewed at 600×600 in the editor.
 */
export function EditorCanvas({
  template,
  selectedId,
  onSelectElement,
  onChangeElement,
  backdropSrc,
  productContext,
  // v0.24.0 (Phase 2): snap state lives in TemplateEditor and is
  // threaded down so the toolbar's Snap toggle can drive it. Default
  // is ON (snap to a 1% grid). Smart guides ALWAYS run when an element
  // is being dragged — they're cheap and visibly useful.
  snapToGrid = true,
  // v0.29.0: outline every element box (safe-zone guide), not just the
  // selected one. Driven by the toolbar's "Bounds" toggle.
  showBounds = false,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ w: 600, h: 600 });
  // Live alignment guides shown during drag. Cleared on pointer-up.
  // Each guide is `{ axis: 'x'|'y', pos: number_in_canvas_px }`.
  const [guides, setGuides] = useState([]);

  // v0.26.2: compute canvas DOM size from the WRAP's available area
  // + template aspect ratio, then apply as inline width/height. Pure-
  // CSS `aspect-ratio + width:100% + max-height:100%` was producing a
  // rectangle for a 2000×2000 template (a 1:1 ratio) because the wrap
  // is wider than tall — width:100% won, max-height clamped the
  // height, and the aspect-ratio constraint silently broke. The
  // canvas WOULD render as a 1600×900 rectangle for a square template.
  //
  // The fit math is the classic "letterbox" choice: take the SMALLER
  // of (wrapW, wrapH * aspect) and (wrapH, wrapW / aspect). Whichever
  // dimension is the limiting one drives the size; the other follows
  // from the aspect ratio. Padding the wrap (24px each side from CSS)
  // is already accounted for via getBoundingClientRect().
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    function recompute() {
      // contentRect of the wrap minus its own padding/border via
      // getBoundingClientRect + computed padding would be more
      // correct, but clientWidth/clientHeight already exclude border
      // and we add padding on the wrap, not on the box-sizing'd inner
      // space. Subtract the meta line height (~22px) + gap so the
      // canvas doesn't push it out.
      const META_RESERVE = 28;
      const availW = wrap.clientWidth  - 48;  // 24px padding each side
      const availH = wrap.clientHeight - 48 - META_RESERVE;
      if (availW <= 0 || availH <= 0) return;
      const aspect = template.canvasWidth / template.canvasHeight;
      let w, h;
      if (availW / availH > aspect) {
        // Wrap is wider than the canvas aspect → height is the limit.
        h = availH;
        w = h * aspect;
      } else {
        // Wrap is taller than the canvas aspect → width is the limit.
        w = availW;
        h = w / aspect;
      }
      setCanvasSize({ w, h });
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [template.canvasWidth, template.canvasHeight]);

  // v0.24.0: arrow-key nudging for the selected element. Pixel-grain
  // movement when no input has focus; Shift = 10x. Bound to the
  // window because the canvas elements themselves don't take focus.
  useEffect(() => {
    if (!selectedId) return undefined;
    function onKey(e) {
      // Skip when the user is typing somewhere.
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.target?.isContentEditable) return;
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = arrows[e.key];
      if (!d) return;
      e.preventDefault();
      const el = template.elements.find((x) => x.id === selectedId);
      if (!el) return;
      const stepPx = e.shiftKey ? 10 : 1;
      const dx = d[0] * stepPx / canvasSize.w;
      const dy = d[1] * stepPx / canvasSize.h;
      const nx = Math.max(0, Math.min(1, (el.x ?? 0) + dx));
      const ny = Math.max(0, Math.min(1, (el.y ?? 0) + dy));
      onChangeElement(selectedId, { x: nx, y: ny });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, template.elements, canvasSize, onChangeElement]);

  // Pointer-down on empty area deselects.
  function onBgPointerDown(e) {
    if (e.target === canvasRef.current) onSelectElement(null);
  }

  // v0.27.0: reflect the template's bulk-inset live. When enabled, the
  // backdrop is shrunk to `scale` of the canvas's shorter side and the
  // margin is filled (solid colour, or a blurred copy of the image) — a
  // WYSIWYG preview of exactly what the overlay run will bake, so the user
  // can see whether the product now clears the logo/SKU safe zones.
  const inset = (template.inset && template.inset.enabled) ? template.inset : null;
  const insetBound = inset
    ? Math.round(Math.min(canvasSize.w, canvasSize.h) * Math.max(0.3, Math.min(1, inset.scale ?? 0.85)))
    : 0;

  return (
    <div ref={wrapRef} className="ovl-canvas-wrap">
      <div
        ref={canvasRef}
        className={`ovl-canvas${snapToGrid ? ' ovl-canvas--gridded' : ''}${showBounds ? ' ovl-canvas--bounds' : ''}`}
        // v0.26.2: explicit pixel size from the JS fit math above.
        // The earlier `aspect-ratio + width:100% + max-height:100%`
        // combo was unreliable in a flex column wider than tall — see
        // the comment on the recompute effect.
        style={{ width: canvasSize.w, height: canvasSize.h }}
        onPointerDown={onBgPointerDown}
      >
        {backdropSrc ? (
          inset ? (
            <div
              className="ovl-canvas__backdrop ovl-canvas__inset"
              style={inset.fillMode === 'color'
                ? { background: inset.fillColor || '#FFFFFF' }
                : undefined}
            >
              {inset.fillMode === 'blur' && (
                <img className="ovl-canvas__inset-blur" src={backdropSrc} alt="" draggable={false} />
              )}
              <img
                className="ovl-canvas__inset-fg"
                src={backdropSrc}
                alt=""
                draggable={false}
                style={{ width: insetBound, height: insetBound }}
              />
            </div>
          ) : (
            <img className="ovl-canvas__backdrop" src={backdropSrc} alt="" draggable={false} />
          )
        ) : (
          <div className="ovl-canvas__backdrop ovl-canvas__backdrop--checker" />
        )}

        {/* Elements */}
        {template.elements.map((el) => (
          <ElementOverlay
            key={el.id}
            element={el}
            canvasW={canvasSize.w}
            canvasH={canvasSize.h}
            selected={el.id === selectedId}
            onSelect={() => onSelectElement(el.id)}
            onChange={(patch) => onChangeElement(el.id, patch)}
            productContext={productContext}
            // Phase 2: hooks for snap + guides.
            snapToGrid={snapToGrid}
            siblings={template.elements.filter((x) => x.id !== el.id)}
            onGuides={setGuides}
          />
        ))}

        {/* v0.24.0: live alignment guides. Rendered on top, but
            pointer-events:none so they don't intercept drag. */}
        {guides.map((g, i) => (
          <div
            key={i}
            className="ovl-canvas__guide"
            style={g.axis === 'x'
              ? { left: g.pos, top: 0, width: 1, height: '100%' }
              : { top: g.pos, left: 0, height: 1, width: '100%' }}
          />
        ))}
      </div>
      <div className="ovl-canvas__meta">
        Design canvas: {template.canvasWidth} × {template.canvasHeight}
      </div>
    </div>
  );
}

/**
 * v0.23.0 (Phase 1 of canvas refactor):
 *
 * Each selected element now gets 8 resize handles (nw/n/ne/e/se/s/sw/w)
 * plus a rotation handle. The old "single corner handle opposite the
 * anchor" behaviour is gone — every edge / corner is now grabbable.
 *
 * How resize math works under the anchor system:
 *
 *   The element keeps its (x, y, width, height, anchor) shape. (x, y)
 *   is the canvas-fraction position of the anchor point, NOT the
 *   bounding box's top-left. Width/height are bounding-box dimensions
 *   in canvas fractions.
 *
 *   When you grab handle H, we capture the current pixel bounding box
 *   AND figure out which edges H controls (e.g. NW = top+left edges;
 *   E = right edge only). On pointer move, edges NOT controlled by H
 *   stay locked in their pixel positions; edges controlled by H move
 *   with the mouse. We then derive the new (x, y, width, height) by
 *   working backwards from the new bounding box + the anchor offset:
 *
 *     anchorOffsetX = 0 / 0.5 / 1 (left/center/right anchor column)
 *     newX_frac     = (newBboxLeft + newBboxW * anchorOffsetX) / canvasW
 *     newWidth_frac = newBboxW / canvasW
 *
 *   ...and symmetric for Y. This keeps the anchor SEMANTICALLY in the
 *   same spot relative to the element's content (e.g. a TR-anchored
 *   element still has (x, y) at its top-right corner after a NW drag),
 *   which is what the server-side renderer expects.
 *
 * Rotation handle: a small round handle 28px above the top-center
 * resize handle. Drag-to-rotate. Holding Shift snaps to 15° increments
 * (Figma convention). Rotation is stored in `element.rotation`
 * (degrees, normalised to (-180, 180]) and applied via CSS
 * `transform: rotate(...)` on the element wrapper. The server-side
 * renderer applies the same rotation via `sharp().rotate()` so the
 * baked output matches the editor preview.
 */
function ElementOverlay({ element, canvasW, canvasH, selected, onSelect, onChange, productContext, snapToGrid, siblings, onGuides }) {
  const filledContent = (element.type === 'text' || element.type === 'barcode')
    ? fillTokens(element.content ?? '', productContext)
    : null;
  const box = elementBox(element, canvasW, canvasH, filledContent);
  const dragState = useRef(null);
  const rotation = Number(element.rotation ?? 0);
  // v0.26.0: layer flags. `visible: false` greys the element in the
  // editor (still selectable so the inspector can flip it back on);
  // `locked: true` no-ops the drag/resize/rotate handlers but still
  // allows selection so the inspector's Lock toggle is reachable.
  const isHidden = element.visible === false;
  const isLocked = element.locked === true;

  /**
   * Convert a new pixel bounding box back into (x, y, width, height)
   * fractions, respecting the element's anchor. The anchor offset is
   * 0 for left-edge anchors, 0.5 for center anchors, 1 for right-edge
   * anchors (and analogous for Y).
   */
  function bboxToProps(newLeft, newTop, newWidth, newHeight, anchor) {
    const ax = anchor === 'tl' || anchor === 'bl' || anchor === 'lc' ? 0
             : anchor === 'tc' || anchor === 'bc' || anchor === 'c'  ? 0.5
             : 1;
    const ay = anchor === 'tl' || anchor === 'tr' || anchor === 'tc' ? 0
             : anchor === 'lc' || anchor === 'rc' || anchor === 'c'  ? 0.5
             : 1;
    return {
      x: (newLeft + newWidth  * ax) / canvasW,
      y: (newTop  + newHeight * ay) / canvasH,
      width:  newWidth  / canvasW,
      height: newHeight / canvasH,
    };
  }

  // v0.26.3: ALL pointer capture lives on the element WRAPPER, not
  // on the resize handles / rotation knob. Why: when the handle had
  // capture and onPointerMove was bound to both the handle AND the
  // wrapper, React's synthetic event bubble fired the wrapper's
  // onPointerMove a SECOND time. The second invocation had
  // `e.currentTarget = wrapper`, so `wrapper.parentElement.parentElement`
  // was one DOM level above the canvas — coordinate math used the
  // wrong reference rect, and the resize "drifted" in skewed
  // directions. Pre-v0.26.3 was buggy under any 8-handle drag.
  //
  // Fix: handles' onPointerDown sets capture on the wrapper, the
  // wrapper owns ALL move/up handlers, and there's exactly one
  // canvasEl resolution (wrapper.parentElement → canvas) regardless
  // of which sub-element started the drag.
  function onBodyPointerDown(e) {
    e.stopPropagation();
    onSelect();
    if (!canvasW) return;
    if (isLocked) return;
    const wrapper = e.currentTarget;
    wrapper.setPointerCapture(e.pointerId);
    const canvasRect = wrapper.parentElement.getBoundingClientRect();
    const mouseFracX = (e.clientX - canvasRect.left) / canvasRect.width;
    const mouseFracY = (e.clientY - canvasRect.top)  / canvasRect.height;
    dragState.current = {
      mode: 'move',
      grabOffsetX: mouseFracX - (element.x ?? 0),
      grabOffsetY: mouseFracY - (element.y ?? 0),
    };
  }

  /**
   * Generic 8-handle resize. `dir` is one of nw/n/ne/e/se/s/sw/w and
   * tells us which edges the handle controls. Capture goes on the
   * wrapper (one DOM level up from the handle) so the wrapper's
   * onPointerMove is the single handler — no double-fire.
   */
  function onResizePointerDown(dir, e) {
    e.stopPropagation();
    e.preventDefault();
    if (!canvasW) return;
    const wrapper = e.currentTarget.parentElement;
    wrapper.setPointerCapture(e.pointerId);
    const canvasRect = wrapper.parentElement.getBoundingClientRect();
    dragState.current = {
      mode: 'resize',
      dir,
      anchor: element.anchor,
      startMouseX: e.clientX - canvasRect.left,
      startMouseY: e.clientY - canvasRect.top,
      startLeft: box.left,
      startTop: box.top,
      startWidth: box.width,
      startHeight: box.height,
    };
  }

  /**
   * Rotation handle drag. Same wrapper-owned capture as resize.
   */
  function onRotatePointerDown(e) {
    e.stopPropagation();
    e.preventDefault();
    if (!canvasW) return;
    const wrapper = e.currentTarget.parentElement;
    wrapper.setPointerCapture(e.pointerId);
    const canvasRect = wrapper.parentElement.getBoundingClientRect();
    dragState.current = {
      mode: 'rotate',
      centerX: box.left + box.width  / 2,
      centerY: box.top  + box.height / 2,
      startAngle: angleFromCenter(
        e.clientX - canvasRect.left,
        e.clientY - canvasRect.top,
        box.left + box.width  / 2,
        box.top  + box.height / 2,
      ),
      initialRotation: rotation,
    };
  }

  function onPointerMove(e) {
    const st = dragState.current;
    if (!st) return;
    // Single resolution path: currentTarget is ALWAYS the wrapper now
    // (capture is on the wrapper for every drag mode), so the canvas
    // is always one parent up. No more mode-dependent traversal.
    const canvasRect = e.currentTarget.parentElement.getBoundingClientRect();
    const mouseX = e.clientX - canvasRect.left;
    const mouseY = e.clientY - canvasRect.top;

    if (st.mode === 'move') {
      const mouseFracX = mouseX / canvasRect.width;
      const mouseFracY = mouseY / canvasRect.height;
      let nx = Math.max(0, Math.min(1, mouseFracX - st.grabOffsetX));
      let ny = Math.max(0, Math.min(1, mouseFracY - st.grabOffsetY));
      // v0.24.0: snap + smart guides. Predicate snap on the move's
      // resulting bounding box so the *visible* edges align, not the
      // anchor point. We compute the new bbox in canvas-pixel coords,
      // apply snap, then convert back to (x, y) fractions.
      if ((snapToGrid || (siblings && siblings.length)) && canvasW && canvasH) {
        const liveBbox = anchorToBbox(nx, ny, box.width, box.height, element.anchor, canvasW, canvasH);
        const { bbox: snappedBbox, guides: newGuides } = applySnap(liveBbox, siblings || [], canvasW, canvasH, snapToGrid);
        const back = bboxToAnchor(snappedBbox.left, snappedBbox.top, box.width, box.height, element.anchor, canvasW, canvasH);
        nx = back.x; ny = back.y;
        onGuides?.(newGuides);
      }
      onChange({ x: nx, y: ny });
      return;
    }

    if (st.mode === 'resize') {
      // Edge-control map. Each handle controls a subset of edges.
      const ctrl = HANDLE_EDGES[st.dir];
      let newLeft = st.startLeft;
      let newTop = st.startTop;
      let newRight = st.startLeft + st.startWidth;
      let newBottom = st.startTop + st.startHeight;
      const dx = mouseX - st.startMouseX;
      const dy = mouseY - st.startMouseY;
      if (ctrl.top)    newTop    = st.startTop + dy;
      if (ctrl.bottom) newBottom = st.startTop + st.startHeight + dy;
      if (ctrl.left)   newLeft   = st.startLeft + dx;
      if (ctrl.right)  newRight  = st.startLeft + st.startWidth + dx;
      // Clamp: don't let edges cross. If the user drags past the
      // opposite edge, freeze at a 1px sliver — flipping the element
      // would invert the anchor semantics confusingly.
      const MIN = 4;
      if (newRight - newLeft < MIN) {
        if (ctrl.left)  newLeft  = newRight - MIN;
        if (ctrl.right) newRight = newLeft  + MIN;
      }
      if (newBottom - newTop < MIN) {
        if (ctrl.top)    newTop    = newBottom - MIN;
        if (ctrl.bottom) newBottom = newTop    + MIN;
      }
      const w = newRight - newLeft;
      const h = newBottom - newTop;
      const next = bboxToProps(newLeft, newTop, w, h, st.anchor);
      onChange(next);
      return;
    }

    if (st.mode === 'rotate') {
      const ang = angleFromCenter(mouseX, mouseY, st.centerX, st.centerY);
      let delta = ang - st.startAngle;
      let next = st.initialRotation + delta;
      // Shift snaps to 15° increments — matches Figma / Sketch.
      if (e.shiftKey) {
        next = Math.round(next / 15) * 15;
      }
      // Normalise to (-180, 180].
      next = ((next + 180) % 360 + 360) % 360 - 180;
      onChange({ rotation: next });
    }
  }

  function onPointerUp(e) {
    dragState.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
    // v0.24.0: drop any live alignment guides as soon as the drag ends.
    onGuides?.([]);
  }

  return (
    <div
      className={`ovl-element${selected ? ' is-selected' : ''}${isHidden ? ' is-hidden' : ''}${isLocked ? ' is-locked' : ''}`}
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        // v0.23.0: rotation applied here. transform-origin defaults to
        // 50% 50% (the element's visual center), which matches the
        // server-side renderer's rotation pivot.
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
      }}
      onPointerDown={onBodyPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <ElementContent element={element} box={box} productContext={productContext} canvasW={canvasW} filledContent={filledContent} />
      {selected && !isLocked ? (
        <>
          <div className="ovl-element__anchor-dot" data-anchor={element.anchor} />
          {/* v0.26.3: handles only need onPointerDown — the wrapper
              owns capture + move + up, so we don't bind those here.
              Binding them caused a synthetic-event-bubble double-fire
              that made resize drift in skewed directions. */}
          {HANDLE_DIRS.map((dir) => (
            <ResizeHandle
              key={dir}
              dir={dir}
              onPointerDown={(e) => onResizePointerDown(dir, e)}
            />
          ))}
          {/* Rotation handle (stick + knob) above the top-center
              resize handle. Drag to rotate; Shift snaps to 15°.
              onPointerDown only — wrapper owns the rest. */}
          <div className="ovl-element__rot-stick" />
          <div
            className="ovl-element__rot-knob"
            onPointerDown={onRotatePointerDown}
            title={`Rotate (Shift = snap to 15°). Current: ${Math.round(rotation)}°`}
          />
        </>
      ) : selected && isLocked ? (
        // Locked: still show a thin selected outline + an anchor dot,
        // but no draggable handles. Lets the user see the selection
        // (so the inspector can unlock it) without inviting a drag.
        <div className="ovl-element__anchor-dot" data-anchor={element.anchor} />
      ) : null}
    </div>
  );
}

/** Resize-handle directions, in render order. */
const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Per-direction edge control map: which edges of the bounding box
 *  this handle moves when dragged. */
const HANDLE_EDGES = {
  nw: { top: true,  left: true                },
  n:  { top: true                             },
  ne: { top: true,  right: true               },
  e:  {             right: true               },
  se: { bottom: true, right: true             },
  s:  { bottom: true                          },
  sw: { bottom: true, left: true              },
  w:  {             left: true                },
};

/** Resize handle. Positioned absolutely on the element wrapper edges.
 *  v0.26.3: only `onPointerDown` is needed — the wrapper handles all
 *  pointermove/up via pointer capture set on the wrapper itself. See
 *  the long comment on onBodyPointerDown above for why. */
function ResizeHandle({ dir, onPointerDown }) {
  const style = {};
  if (dir.includes('n')) style.top = -5;
  if (dir.includes('s')) style.bottom = -5;
  if (dir.includes('w')) style.left = -5;
  if (dir.includes('e')) style.right = -5;
  if (dir === 'n' || dir === 's') { style.left = '50%'; style.transform = 'translateX(-50%)'; }
  if (dir === 'w' || dir === 'e') { style.top  = '50%'; style.transform = 'translateY(-50%)'; }
  const cursor = (dir === 'nw' || dir === 'se') ? 'nwse-resize'
              : (dir === 'ne' || dir === 'sw') ? 'nesw-resize'
              : (dir === 'n'  || dir === 's')  ? 'ns-resize'
                                                : 'ew-resize';
  return (
    <div
      className="ovl-element__resize"
      data-dir={dir}
      style={{ ...style, cursor }}
      onPointerDown={onPointerDown}
    />
  );
}

/** Returns angle in degrees from (cx, cy) to (x, y). 0 = "right", 90 =
 *  "down" (matches DOM coords; positive Y goes down). We then OFFSET
 *  by +90 in the rotation-knob start angle so 0° rotation = knob
 *  pointing straight up, which is the natural "no rotation" state. */
function angleFromCenter(x, y, cx, cy) {
  return Math.atan2(y - cy, x - cx) * 180 / Math.PI + 90;
}

/* ── v0.24.0: snap + smart guides ─────────────────────────────────
 *
 * The snap pipeline runs ONLY during a move drag (not during resize —
 * resize handles already give per-edge control and snapping there
 * would fight the user's fine adjustments).
 *
 * Two snap sources, applied in order:
 *
 *   1. **Smart guides**: compare the dragged element's 6 edge/center
 *      positions (left/center/right/top/middle/bottom) against the
 *      same 6 for EVERY other element. If any pair is within
 *      SNAP_THRESHOLD_PX, snap and emit a guide line.
 *
 *   2. **Grid snap**: if `snapToGrid` is true and smart guides didn't
 *      already lock the axis, snap the bounding-box left/top to the
 *      nearest GRID_PX increment.
 *
 * Smart guides win over grid because aligning to a real element is
 * always more useful than aligning to an arbitrary grid line.
 */
const SNAP_THRESHOLD_PX = 5;
const GRID_PX = 8;

/** Convert (x, y) anchor-frac + width/height in CANVAS PIXELS to a
 *  bounding box {left, top, width, height} in canvas pixels. */
function anchorToBbox(xFrac, yFrac, widthPx, heightPx, anchor, canvasW, canvasH) {
  const ax = xFrac * canvasW;
  const ay = yFrac * canvasH;
  const offX = anchor === 'tl' || anchor === 'bl' || anchor === 'lc' ? 0
             : anchor === 'tc' || anchor === 'bc' || anchor === 'c'  ? 0.5
             : 1;
  const offY = anchor === 'tl' || anchor === 'tr' || anchor === 'tc' ? 0
             : anchor === 'lc' || anchor === 'rc' || anchor === 'c'  ? 0.5
             : 1;
  return {
    left: ax - widthPx * offX,
    top:  ay - heightPx * offY,
    width:  widthPx,
    height: heightPx,
  };
}

/** Inverse of anchorToBbox — given a bbox left/top, derive the anchor
 *  fraction position. */
function bboxToAnchor(left, top, widthPx, heightPx, anchor, canvasW, canvasH) {
  const offX = anchor === 'tl' || anchor === 'bl' || anchor === 'lc' ? 0
             : anchor === 'tc' || anchor === 'bc' || anchor === 'c'  ? 0.5
             : 1;
  const offY = anchor === 'tl' || anchor === 'tr' || anchor === 'tc' ? 0
             : anchor === 'lc' || anchor === 'rc' || anchor === 'c'  ? 0.5
             : 1;
  return {
    x: (left + widthPx * offX)  / canvasW,
    y: (top  + heightPx * offY) / canvasH,
  };
}

/** Given a dragged bbox + sibling elements, return a snapped bbox and
 *  the alignment guides to display. */
function applySnap(bbox, siblings, canvasW, canvasH, snapToGrid) {
  const guides = [];
  let { left, top } = bbox;
  const { width, height } = bbox;

  // Edges of the dragged element to test for alignment.
  const myL = left;
  const myR = left + width;
  const myCX = left + width / 2;
  const myT = top;
  const myB = top + height;
  const myCY = top + height / 2;

  // Find best smart-guide snap per axis.
  let bestX = null;  // { delta, line }
  let bestY = null;
  for (const sib of siblings) {
    const sBox = anchorToBbox(
      sib.x ?? 0,
      sib.y ?? 0,
      (sib.width  ?? 0) * canvasW,
      (sib.height ?? 0) * canvasH,
      sib.anchor || 'tl',
      canvasW, canvasH,
    );
    const sLines = [
      { axis: 'x', pos: sBox.left,                target: 'left'   },
      { axis: 'x', pos: sBox.left + sBox.width,   target: 'right'  },
      { axis: 'x', pos: sBox.left + sBox.width/2, target: 'center' },
      { axis: 'y', pos: sBox.top,                 target: 'top'    },
      { axis: 'y', pos: sBox.top + sBox.height,   target: 'bottom' },
      { axis: 'y', pos: sBox.top + sBox.height/2, target: 'middle' },
    ];
    for (const sl of sLines) {
      const myCandidates = sl.axis === 'x' ? [myL, myR, myCX] : [myT, myB, myCY];
      const offsets =     sl.axis === 'x' ? [0, -width, -width / 2] : [0, -height, -height / 2];
      for (let i = 0; i < myCandidates.length; i++) {
        const d = sl.pos - myCandidates[i];
        if (Math.abs(d) <= SNAP_THRESHOLD_PX) {
          // delta to apply to (left or top), plus a guide line.
          const adj = offsets[i] - (myCandidates[i] - (sl.axis === 'x' ? left : top));
          const candidate = { delta: sl.pos + adj - (sl.axis === 'x' ? left : top), line: { axis: sl.axis, pos: sl.pos } };
          // Simpler: just snap so that my edge aligns to sl.pos.
          // Compute delta along the axis: how much to move the bbox.
          let move = 0;
          if (sl.axis === 'x') {
            if (i === 0) move = sl.pos - myL;
            if (i === 1) move = sl.pos - myR;
            if (i === 2) move = sl.pos - myCX;
            if (!bestX || Math.abs(move) < Math.abs(bestX.delta)) {
              bestX = { delta: move, line: { axis: 'x', pos: sl.pos } };
            }
          } else {
            if (i === 0) move = sl.pos - myT;
            if (i === 1) move = sl.pos - myB;
            if (i === 2) move = sl.pos - myCY;
            if (!bestY || Math.abs(move) < Math.abs(bestY.delta)) {
              bestY = { delta: move, line: { axis: 'y', pos: sl.pos } };
            }
          }
          void candidate; // intentionally unused — kept for future "multi-snap" logic
        }
      }
    }
  }

  if (bestX) { left += bestX.delta; guides.push(bestX.line); }
  if (bestY) { top  += bestY.delta; guides.push(bestY.line); }

  // Grid snap if no smart guide claimed the axis.
  if (snapToGrid) {
    if (!bestX) left = Math.round(left / GRID_PX) * GRID_PX;
    if (!bestY) top  = Math.round(top  / GRID_PX) * GRID_PX;
  }

  // Clamp inside canvas.
  left = Math.max(0, Math.min(canvasW - width,  left));
  top  = Math.max(0, Math.min(canvasH - height, top));

  return { bbox: { left, top, width, height }, guides };
}

/** Live preview of the element's content. Matches the main-process renderer
 *  visually within reason — text uses inline CSS for the bg pill + font,
 *  barcode is generated client-side via bwip-js, image is rendered through
 *  the existing app-image protocol when a real product source is picked. */
function ElementContent({ element, box, productContext, canvasW, filledContent }) {
  if (element.type === 'text') {
    // Use the caller-provided token-filled content so this matches the box
    // sizing computed by elementBox() — keeps the bg pill and the text
    // perfectly synchronized.
    const filled = filledContent ?? fillTokens(element.content ?? '', productContext);
    const fontPx = (element.font?.size ?? 48) * (canvasW / 2000);
    const padding = (element.bg?.padding ?? 0) * (canvasW / 2000);
    const radius  = (element.bg?.radius  ?? 0) * (canvasW / 2000);
    const align = element.align ?? 'left';
    const bgColor = element.bg?.color ?? null;
    return (
      <div
        className="ovl-element__text"
        style={{
          padding: `${padding}px`,
          background: bgColor ? hexWithOpacity(bgColor, element.bg?.opacity ?? 1) : 'transparent',
          borderRadius: `${radius}px`,
          fontFamily: element.font?.family ?? 'Inter, sans-serif',
          fontSize: `${fontPx}px`,
          fontWeight: element.font?.weight ?? 'normal',
          fontStyle: element.font?.italic ? 'italic' : 'normal',
          color: element.font?.color ?? '#000',
          textAlign: align,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
          // No overflow:hidden so a too-narrow explicit width still shows
          // the user what their text looks like. They can fix it via the
          // inspector or resize handle.
          whiteSpace: 'nowrap',
        }}
      >
        {filled || <span style={{ opacity: 0.4 }}>{element.content || '(empty)'}</span>}
      </div>
    );
  }

  if (element.type === 'barcode') {
    const content = filledContent ?? fillTokens(element.content ?? '', productContext);
    const format = element.format ?? 'code128';
    const svg = renderBarcodeSVG(content, format, { showText: element.showText !== false });
    const showText = element.showText !== false;
    const humanText = showText ? formatBarcodeText(content, format) : '';
    const padding = (element.bg?.padding ?? 0) * (canvasW / 2000);
    const radius  = (element.bg?.radius  ?? 0) * (canvasW / 2000);
    const bgColor = element.bg?.color ?? '#fff';
    // v0.26.4: bars take ~78% of vertical space when text is shown,
    // text takes ~22%. When text is off, bars take 100%. The flex
    // column lets the user shrink the element box freely (Height
    // inspector now works correctly because the SVG inside the bars
    // wrapper has preserveAspectRatio="none" — see barcodePreview.js).
    return (
      <div
        className="ovl-element__barcode"
        style={{
          padding: `${padding}px`,
          background: bgColor ? hexWithOpacity(bgColor, element.bg?.opacity ?? 1) : 'transparent',
          borderRadius: `${radius}px`,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          justifyContent: 'center',
          gap: 0,
        }}
      >
        <div
          className="ovl-element__barcode-bars"
          style={{ flex: showText ? '1 1 78%' : '1 1 100%', minHeight: 0 }}
          // bwip-js SVG is trusted — we wrote the input + format.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {showText ? (
          <div
            className="ovl-element__barcode-text"
            style={{
              flex: '0 0 auto',
              textAlign: 'center',
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              // Scale font from a 2000px design canvas so the editor
              // preview matches the bake; clamp to a readable minimum.
              fontSize: `${Math.max(8, 18 * (canvasW / 2000))}px`,
              letterSpacing: '0.04em',
              color: '#000',
              lineHeight: 1.1,
              paddingTop: 2,
              userSelect: 'none',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {humanText}
          </div>
        ) : null}
      </div>
    );
  }

  if (element.type === 'image') {
    const src = resolveImageSrc(element.source, productContext);
    return (
      <div
        className="ovl-element__image"
        style={{ width: '100%', height: '100%', opacity: element.opacity ?? 1 }}
      >
        {src ? (
          <img src={src} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <div className="ovl-element__image-placeholder">
            <span className="muted" style={{ fontSize: 11 }}>
              {element.source ?? 'image'}
            </span>
          </div>
        )}
      </div>
    );
  }

  return null;
}

/* ── helpers ──────────────────────────────────────────────────── */

function fillTokens(template, ctx) {
  if (template == null || ctx == null) return String(template ?? '');
  return String(template)
    .replace(/\{sku\}/gi,              ctx.sku ?? '')
    .replace(/\{name\}/gi,             ctx.name ?? '')
    .replace(/\{brand\}/gi,            ctx.brand ?? '')
    .replace(/\{barcode\}/gi,          ctx.barcode ?? '')
    .replace(/\{color\}/gi,            ctx.colorFinish ?? ctx.color ?? '')
    .replace(/\{category\}/gi,         ctx.category ?? '')
    .replace(/\{description\}/gi,      ctx.description ?? '')
    .replace(/\{price_retail\}/gi,     ctx.priceRetail != null ? String(ctx.priceRetail) : '')
    .replace(/\{price_wholesale\}/gi,  ctx.priceWholesale != null ? String(ctx.priceWholesale) : '')
    .replace(/\{date\}/gi,             new Date().toLocaleDateString())
    .replace(/\{date_short\}/gi,       new Date().toISOString().slice(0, 10));
}

function hexWithOpacity(hex, opacity) {
  if (opacity >= 1) return hex;
  const m = /^#([0-9a-f]{6})$/i.exec(hex) || /^#([0-9a-f]{3})$/i.exec(hex);
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function resolveImageSrc(source, ctx) {
  if (!source || !ctx) return null;
  if (source === 'brand-icon' && ctx.brandIcon) {
    return `app-image://local/${encodeURIComponent(ctx.brandIcon)}`;
  }
  if (source.startsWith('product-image:')) {
    const idx = Number(source.split(':')[1] ?? 0);
    const img = ctx.productImages?.[idx];
    if (img?.filepath) return `app-image://local/${encodeURIComponent(img.filepath)}`;
  }
  if (source.startsWith('asset:')) {
    const rel = source.slice('asset:'.length);
    if (rel) return `app-image://local/${encodeURIComponent(rel)}`;
  }
  return null;
}
