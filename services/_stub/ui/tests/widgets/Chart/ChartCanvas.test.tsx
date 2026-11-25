import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ChartCanvas } from '../../../src/widgets/Chart/ChartCanvas';
import { MARGIN } from '../../../src/widgets/Chart/renderer';
import type { Candle } from '../../../src/widgets/Chart/types';
import { installCanvasHarness, pointer, wheel as dispatchWheel, type CanvasHarness } from '../../helpers/canvasHarness';

/** 866 px wide canvas → an 800 px plot. */
const PLOT_W     = 800;
const WIDTH      = PLOT_W + MARGIN.left + MARGIN.right;
const HEIGHT     = 400;
const PLOT_RIGHT = MARGIN.left + PLOT_W;
const DPR        = 2;

let harness: CanvasHarness;

beforeEach(() => {
  harness = installCanvasHarness({ width: WIDTH, height: HEIGHT, dpr: DPR });
});

afterEach(() => {
  harness.restore();
});

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    open: 100, high: 101, low: 99, close: 100, volume: 1,
  }));
}

function mount(list: Candle[] = [], candlesPerView = 80) {
  const onZoom  = vi.fn();
  const onPan   = vi.fn();
  const onHover = vi.fn();

  const ui = (l: Candle[], cpv: number) => (
    <div>
      <ChartCanvas candles={l} candlesPerView={cpv} onZoom={onZoom} onPan={onPan} onHover={onHover} />
    </div>
  );

  const { container, rerender } = render(ui(list, candlesPerView));

  const canvas = container.querySelector('canvas')!;

  return {
    canvas, onZoom, onPan, onHover,
    wheel:    (init: WheelEventInit) => dispatchWheel(canvas, init),
    rerender: (l: Candle[], cpv = candlesPerView) => rerender(ui(l, cpv)),
  };
}

/** Centre x of candle `i` of `n` at `cpv` candles per view (right-anchored slots). */
function centerOf(i: number, n: number, cpv = 80): number {
  const step = PLOT_W / cpv;

  return PLOT_RIGHT - (n - i) * step + step / 2;
}

// ── resize ────────────────────────────────────────────────────────────────────

describe('ChartCanvas — resize', () => {
  it('sizes the pixel buffer for the device pixel ratio and draws in logical pixels', () => {
    const { canvas } = mount(candles(5));

    expect(canvas.width).toBe(WIDTH * DPR);
    expect(canvas.height).toBe(HEIGHT * DPR);
    expect(canvas.style.width).toBe(`${WIDTH}px`);
    expect(harness.ctx.setTransform).toHaveBeenCalledWith(DPR, 0, 0, DPR, 0, 0);
    /** renderChart paints the background over the logical size. */
    expect(harness.ctx.fillRect).toHaveBeenCalledWith(0, 0, WIDTH, HEIGHT);
  });
});

// ── wheel ─────────────────────────────────────────────────────────────────────

describe('ChartCanvas — wheel zoom', () => {
  it('scales the zoom factor with the wheel delta', () => {
    const { onZoom, wheel } = mount();

    const e = wheel({ deltaY: 100 });

    expect(e.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(Math.exp(0.2));

    wheel({ deltaY: -50 });

    expect(onZoom.mock.calls[1][0]).toBeCloseTo(Math.exp(-0.1));
  });

  it('clamps the factor a single event may apply', () => {
    const { onZoom, wheel } = mount();

    wheel({ deltaY: 5_000 });
    wheel({ deltaY: -5_000 });

    expect(onZoom.mock.calls[0][0]).toBeCloseTo(1.25);
    expect(onZoom.mock.calls[1][0]).toBeCloseTo(1 / 1.25);
  });

  it('accumulates small deltas until they change the view by a candle', () => {
    const { onZoom, wheel } = mount();

    /** 80 * exp(3 * 0.002) ≈ 80.48 — not yet a whole candle. */
    wheel({ deltaY: 1 });
    wheel({ deltaY: 1 });
    wheel({ deltaY: 1 });

    expect(onZoom).not.toHaveBeenCalled();

    /** 80 * exp(4 * 0.002) ≈ 80.64 → 81. */
    wheel({ deltaY: 1 });

    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(Math.exp(0.008));
  });

  it('converts line-mode deltas to pixels', () => {
    const { onZoom, wheel } = mount();

    wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE });

    expect(onZoom.mock.calls[0][0]).toBeCloseTo(Math.exp(3 * 16 * 0.002));
  });
});

describe('ChartCanvas — wheel pan', () => {
  it('pans by the horizontal delta in candle slots when it dominates', () => {
    const { onPan, onZoom, wheel } = mount(candles(20), 80);

    const e = wheel({ deltaX: 30, deltaY: 5 });

    expect(e.defaultPrevented).toBe(true);
    /** 800 px / 80 candles = 10 px per slot. */
    expect(onPan).toHaveBeenCalledWith(-3);
    expect(onZoom).not.toHaveBeenCalled();
  });
});

// ── drag ──────────────────────────────────────────────────────────────────────

describe('ChartCanvas — drag to pan', () => {
  it('pans by the pointer delta in candle slots and captures the pointer', () => {
    const { canvas, onPan } = mount(candles(20), 80);

    pointer(canvas, 'pointerdown', { button: 0, buttons: 1, clientX: 400, pointerId: 7 });

    expect(harness.setPointerCapture).toHaveBeenCalledWith(7);

    pointer(canvas, 'pointermove', { buttons: 1, clientX: 420, pointerId: 7 });
    pointer(canvas, 'pointermove', { buttons: 1, clientX: 415, pointerId: 7 });

    expect(onPan.mock.calls.map(c => c[0])).toEqual([-2, 0.5]);
  });

  it('moves candles exactly as far as the pointer, even when the view is not full', () => {
    const n = 20;
    const { canvas, onPan, onHover } = mount(candles(n), 80);

    /** Hover candle 10, then drag one slot (10 px) right: the view moves back one candle. */
    pointer(canvas, 'pointermove', { buttons: 0, clientX: centerOf(10, n) });
    expect(onHover).toHaveBeenLastCalledWith(10);

    pointer(canvas, 'pointerdown', { button: 0, buttons: 1, clientX: centerOf(10, n) });
    pointer(canvas, 'pointermove', { buttons: 1, clientX: centerOf(11, n) });

    expect(onPan).toHaveBeenLastCalledWith(-1);
  });

  it('stops panning after pointerup and releases the capture', () => {
    const { canvas, onPan } = mount(candles(20), 80);

    pointer(canvas, 'pointerdown', { button: 0, buttons: 1, clientX: 400 });
    pointer(canvas, 'pointerup',   { button: 0, buttons: 0, clientX: 400 });

    expect(harness.releasePointerCapture).toHaveBeenCalledWith(1);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: 500 });

    expect(onPan).not.toHaveBeenCalled();
  });

  it('stops panning after pointercancel', () => {
    const { canvas, onPan } = mount(candles(20), 80);

    pointer(canvas, 'pointerdown',   { button: 0, buttons: 1, clientX: 400 });
    pointer(canvas, 'pointercancel', { buttons: 0, clientX: 400 });
    pointer(canvas, 'pointermove',   { buttons: 1, clientX: 500 });

    expect(onPan).not.toHaveBeenCalled();
  });

  it('ignores non-primary buttons', () => {
    const { canvas, onPan } = mount(candles(20), 80);

    pointer(canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 400 });
    pointer(canvas, 'pointermove', { buttons: 2, clientX: 500 });

    expect(harness.setPointerCapture).not.toHaveBeenCalled();
    expect(onPan).not.toHaveBeenCalled();
  });
});

// ── hover ─────────────────────────────────────────────────────────────────────

describe('ChartCanvas — hover', () => {
  it('reports the index of the candle under the pointer, right-anchored', () => {
    const n = 20;
    const { canvas, onHover } = mount(candles(n), 80);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: centerOf(3, n) });
    expect(onHover).toHaveBeenLastCalledWith(3);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: PLOT_RIGHT - 1 });
    expect(onHover).toHaveBeenLastCalledWith(n - 1);
  });

  it('reports null over the price axis and over empty slots left of the data', () => {
    const n = 20;
    const { canvas, onHover } = mount(candles(n), 80);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: centerOf(5, n) });
    pointer(canvas, 'pointermove', { buttons: 0, clientX: PLOT_RIGHT + 20 });
    expect(onHover).toHaveBeenLastCalledWith(null);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: centerOf(5, n) });
    pointer(canvas, 'pointermove', { buttons: 0, clientX: MARGIN.left + 50 });
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('reports each column change once, not every pixel', () => {
    const n = 20;
    const { canvas, onHover } = mount(candles(n), 80);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: centerOf(3, n) });
    pointer(canvas, 'pointermove', { buttons: 0, clientX: centerOf(3, n) + 1 });

    expect(onHover).toHaveBeenCalledTimes(1);
  });

  it('clears on pointerleave', () => {
    const n = 20;
    const { canvas, onHover } = mount(candles(n), 80);

    pointer(canvas, 'pointermove',  { buttons: 0, clientX: centerOf(3, n) });
    pointer(canvas, 'pointerleave', { buttons: 0 });

    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('does not hover while a button is held', () => {
    const { canvas, onHover } = mount(candles(20), 80);

    pointer(canvas, 'pointermove', { buttons: 1, clientX: 700 });

    expect(onHover).not.toHaveBeenCalled();
  });

  it('clears when the candles move out from under a resting pointer', () => {
    const { canvas, onHover, rerender } = mount(candles(20), 80);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: centerOf(2, 20) });
    expect(onHover).toHaveBeenLastCalledWith(2);

    /** Ten candles fill only the rightmost ten slots; the pointer is over an empty one. */
    rerender(candles(10));

    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('follows the candle under a resting pointer when a candle is appended', () => {
    const { canvas, onHover, rerender } = mount(candles(1), 80);

    pointer(canvas, 'pointermove', { buttons: 0, clientX: PLOT_RIGHT - 1 });
    expect(onHover).toHaveBeenLastCalledWith(0);

    rerender(candles(2));

    expect(onHover).toHaveBeenLastCalledWith(1);
  });

  it('re-resolves the hovered candle when the zoom changes', () => {
    const { canvas, onHover, rerender } = mount(candles(40), 80);

    /** At 80 per view, x = PLOT_RIGHT - 105 is 10 slots from the right: candle 29. */
    pointer(canvas, 'pointermove', { buttons: 0, clientX: PLOT_RIGHT - 105 });
    expect(onHover).toHaveBeenLastCalledWith(29);

    /** At 40 per view slots are 20 px: 5 slots from the right, candle 34. */
    rerender(candles(40), 40);

    expect(onHover).toHaveBeenLastCalledWith(34);
  });
});
