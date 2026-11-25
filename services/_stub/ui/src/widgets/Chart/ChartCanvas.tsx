import { useEffect, useRef } from 'react';
import { columnAt, columnGeometry, renderChart } from './renderer';
import type { Candle } from './types';

/** Zoom factor per wheel pixel: factor = exp(deltaY * ZOOM_PER_PIXEL). */
const ZOOM_PER_PIXEL     = 0.002;
/** Largest zoom factor a single wheel event may apply (and its inverse). */
const MAX_ZOOM_PER_EVENT = 1.25;
/** Pixels per wheel delta unit for DOM_DELTA_PIXEL / LINE / PAGE. */
const WHEEL_DELTA_PX     = [1, 16, 400];

interface ChartCanvasProps {
  candles:        Candle[];
  candlesPerView: number;
  onZoom:         (factor: number) => void;
  onPan:          (deltaCandles: number) => void;
  /** Index into `candles` of the column under the pointer, or null when none is. */
  onHover:        (index: number | null) => void;
}

/**
 * Canvas element that renders the chart. Owns the DPR-aware pixel buffer,
 * a ResizeObserver for layout changes, and delegates all drawing to renderer.ts.
 *
 * Gestures:
 *   wheel vertical          → zoom  (onZoom)      — scaled by the wheel delta
 *   wheel horizontal        → pan   (onPan)       — trackpad two-finger swipe
 *   pointer drag (primary)  → pan   (onPan)       — mouse/touch drag
 *   pointer move            → hover (onHover)     — reports the index of the candle under the cursor
 *
 * Candles are laid out by renderer.ts's column geometry (right-anchored slots
 * of plotW / candlesPerView); gestures and hover use the same geometry, so a
 * drag moves the candles exactly as far as the pointer.
 *
 * Pattern: size, candles, candlesPerView, and hover state are stored in refs so
 * draw() and gesture handlers always see fresh values. Hover changes redraw
 * imperatively (no React re-render per pixel of mouse movement). When the
 * candles or the zoom change under a resting pointer, the hovered index is
 * re-resolved from the pointer's last x, so it always names the candle drawn
 * under the crosshair.
 */
export function ChartCanvas({
  candles, candlesPerView, onZoom, onPan, onHover,
}: ChartCanvasProps) {
  const canvasRef         = useRef<HTMLCanvasElement>(null);
  const candlesRef        = useRef(candles);
  const sizeRef           = useRef({ w: 0, h: 0, dpr: 1 });
  const candlesPerViewRef = useRef(candlesPerView);
  const hoverIdxRef       = useRef<number | null>(null);
  /** Canvas-local x of the hovering pointer, or null when it is not over the canvas. */
  const hoverXRef         = useRef<number | null>(null);
  const zoomAccRef        = useRef(1);
  const onZoomRef         = useRef(onZoom);
  const onPanRef          = useRef(onPan);
  const onHoverRef        = useRef(onHover);

  candlesPerViewRef.current = candlesPerView;
  onZoomRef.current         = onZoom;
  onPanRef.current          = onPan;
  onHoverRef.current        = onHover;

  function draw() {
    const canvas = canvasRef.current;

    if (! canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');

    if (! ctx) {
      return;
    }

    const { w, h, dpr } = sizeRef.current;

    if (w === 0 || h === 0) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderChart(ctx, candlesRef.current, { width: w, height: h }, candlesPerViewRef.current, hoverIdxRef.current);
  }

  function getColumns() {
    return columnGeometry(sizeRef.current.w, candlesRef.current.length, candlesPerViewRef.current);
  }

  /** Pixel width of one candle slot — used to convert gesture pixel deltas to candles. */
  function getStep(): number {
    return getColumns().step;
  }

  /** Candle index under a canvas-local x pixel, or null if no candle is there. */
  function getColumnIdx(xInCanvas: number): number | null {
    return columnAt(getColumns(), xInCanvas);
  }

  /** Point the hover at the candle under canvas-local x; reports and redraws on change. */
  function setHover(x: number | null) {
    hoverXRef.current = x;

    const idx = x !== null ? getColumnIdx(x) : null;

    if (idx === hoverIdxRef.current) {
      return false;
    }

    hoverIdxRef.current = idx;
    onHoverRef.current(idx);

    return true;
  }

  useEffect(() => {
    candlesRef.current = candles;

    /** Candles or zoom changed; re-resolve the hovered column under the resting pointer. */
    if (hoverXRef.current !== null) {
      setHover(hoverXRef.current);
    }

    draw();
  });

  useEffect(() => {
    const canvas = canvasRef.current;

    if (! canvas) {
      return;
    }

    const container = canvas.parentElement;

    if (! container) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;

      if (w === 0 || h === 0) {
        return;
      }

      const dpr = window.devicePixelRatio ?? 1;

      sizeRef.current     = { w, h, dpr };
      canvas.width        = w * dpr;
      canvas.height       = h * dpr;
      canvas.style.width  = `${w}px`;
      canvas.style.height = `${h}px`;

      draw();
    });

    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (! canvas) {
      return;
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();

      /** Horizontal wheel → pan; vertical wheel → zoom. */
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        onPanRef.current(-e.deltaX / getStep());
      } else {
        zoomBy(e.deltaY * (WHEEL_DELTA_PX[e.deltaMode] ?? 1));
      }
    }

    /**
     * Accumulate wheel zoom until it changes candlesPerView by at least one
     * candle, so a stream of small trackpad deltas still zooms smoothly.
     */
    function zoomBy(deltaPx: number) {
      const factor = Math.min(
        MAX_ZOOM_PER_EVENT,
        Math.max(1 / MAX_ZOOM_PER_EVENT, Math.exp(deltaPx * ZOOM_PER_PIXEL)),
      );

      zoomAccRef.current *= factor;

      const cpv = candlesPerViewRef.current;

      if (Math.round(cpv * zoomAccRef.current) !== cpv) {
        onZoomRef.current(zoomAccRef.current);
        zoomAccRef.current = 1;
      }
    }

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) {
        return;
      }

      canvas!.setPointerCapture(e.pointerId);

      let lastX = e.clientX;

      function onMove(me: PointerEvent) {
        const dx = me.clientX - lastX;
        lastX = me.clientX;

        /** Drag right → view earlier data → rightAnchor moves back in time. */
        onPanRef.current(-dx / getStep());
      }

      function onUp(ue: PointerEvent) {
        canvas!.releasePointerCapture(ue.pointerId);
        canvas!.removeEventListener('pointermove', onMove);
        canvas!.removeEventListener('pointerup',   onUp);
        canvas!.removeEventListener('pointercancel', onUp);
      }

      canvas!.addEventListener('pointermove', onMove);
      canvas!.addEventListener('pointerup',   onUp);
      canvas!.addEventListener('pointercancel', onUp);
    }

    function onPointerMoveHover(e: PointerEvent) {
      /** Skip while dragging — those moves are for panning, not hovering. */
      if (e.buttons !== 0) {
        return;
      }

      const rect = canvas!.getBoundingClientRect();

      if (setHover(e.clientX - rect.left)) {
        draw();
      }
    }

    function onPointerLeave() {
      if (setHover(null)) {
        draw();
      }
    }

    canvas.addEventListener('wheel',        onWheel, { passive: false });
    canvas.addEventListener('pointerdown',  onPointerDown);
    canvas.addEventListener('pointermove',  onPointerMoveHover);
    canvas.addEventListener('pointerleave', onPointerLeave);

    return () => {
      canvas.removeEventListener('wheel',        onWheel);
      canvas.removeEventListener('pointerdown',  onPointerDown);
      canvas.removeEventListener('pointermove',  onPointerMoveHover);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="chart__canvas" />;
}
