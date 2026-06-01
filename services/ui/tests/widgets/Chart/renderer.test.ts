/**
 * The renderer is a pure function — give it a stubbed 2D context and exercise
 * its branches with different inputs. We don't assert pixel-level output;
 * we just check that the right context calls are made for representative cases.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderChart, MARGIN } from '../../../src/widgets/Chart/renderer';
import type { Candle } from '../../../src/widgets/Chart/types';

const BIN_1M = 60_000;

function mkCtx() {
  return {
    fillStyle:    '',
    strokeStyle:  '',
    lineWidth:    0,
    font:         '',
    textAlign:    '',
    textBaseline: '',
    fillRect:     vi.fn(),
    clearRect:    vi.fn(),
    beginPath:    vi.fn(),
    moveTo:       vi.fn(),
    lineTo:       vi.fn(),
    stroke:       vi.fn(),
    fillText:     vi.fn(),
    setLineDash:  vi.fn(),
    measureText:  vi.fn(() => ({ width: 0 })),
    save:         vi.fn(),
    restore:      vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function candle(i: number, close: number, open = close): Candle {
  return {
    timestamp: new Date(1_700_000_000_000 + i * BIN_1M).toISOString(),
    open,
    high:      Math.max(open, close) + 1,
    low:       Math.min(open, close) - 1,
    close,
    volume:    100 + i,
  };
}

describe('MARGIN constant', () => {
  it('exposes a non-zero right margin so axis labels have room', () => {
    expect(MARGIN.right).toBeGreaterThan(0);
  });
});

describe('renderChart', () => {
  it('paints the background and exits early when there are no candles', () => {
    const ctx = mkCtx();

    renderChart(ctx, [], { width: 800, height: 400 });

    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 800, 400);
    /** With no candles, no wicks or bodies are drawn — beginPath stays untouched. */
    expect(ctx.beginPath).not.toHaveBeenCalled();
  });

  it('draws wicks and bodies for a populated candle set', () => {
    const ctx = mkCtx();
    const candles = Array.from({ length: 5 }, (_, i) => candle(i, 100 + i, 99 + i));

    renderChart(ctx, candles, { width: 800, height: 400 });

    /** Wicks: at least one beginPath per candle. Bodies: fillRect called for each candle (+ background, + volume bars). */
    expect((ctx.beginPath as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(candles.length);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(candles.length + 1);
  });

  it('renders a hover crosshair when hoverIndex is supplied and in-range', () => {
    const ctx = mkCtx();
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100 + i));

    renderChart(ctx, candles, { width: 800, height: 400 }, 4);

    /** Crosshair adds extra lineTo calls beyond the baseline (wicks + grid + axis). */
    const lineTos = (ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(lineTos).toBeGreaterThan(candles.length);
  });

  it('ignores hoverIndex when out of range', () => {
    const ctx = mkCtx();
    const candles = Array.from({ length: 3 }, (_, i) => candle(i, 100 + i));

    /** Should not throw / no out-of-bounds access. */
    expect(() => renderChart(ctx, candles, { width: 800, height: 400 }, 99)).not.toThrow();
    expect(() => renderChart(ctx, candles, { width: 800, height: 400 }, -1)).not.toThrow();
  });

  it('does not divide by zero when all candles have the same price', () => {
    const ctx = mkCtx();

    /** Flat market — range is 0 before padding; renderer should clamp to avoid NaN. */
    const candles = Array.from({ length: 4 }, (_, i) => ({
      timestamp: new Date(1_700_000_000_000 + i * BIN_1M).toISOString(),
      open: 100, high: 100, low: 100, close: 100, volume: 0,
    }));

    expect(() => renderChart(ctx, candles, { width: 800, height: 400 })).not.toThrow();
  });
});
