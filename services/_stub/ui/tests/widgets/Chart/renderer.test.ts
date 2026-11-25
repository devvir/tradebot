/**
 * The renderer is a pure function — give it a recording 2D context and check
 * what it draws: where (price → y, column → x), in which colour, and with
 * which labels.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  renderChart, MARGIN, columnGeometry, columnCenterX, columnAt,
  _test_niceStep as niceStep, _test_formatPrice as formatPrice,
} from '../../../src/widgets/Chart/renderer';
import type { Candle } from '../../../src/widgets/Chart/types';

const BIN_1M = 60_000;
const BIN_1H = 60 * BIN_1M;
const BIN_1D = 24 * BIN_1H;

/** 866 px canvas → an 800 px plot; 80 candles per view → 10 px slots, 8 px bodies. */
const WIDTH  = 800 + MARGIN.left + MARGIN.right;
const HEIGHT = 400;
const DIM    = { width: WIDTH, height: HEIGHT };

const UP      = '#0a9b62';
const DOWN    = '#fe3c3c';
const VOL_UP  = 'rgba(10,155,98,0.45)';
const VOL_DN  = 'rgba(254,60,60,0.45)';

/** One context call, with the fill/stroke style in effect when it was made. */
interface Call {
  op:          string;
  args:        unknown[];
  fillStyle:   string;
  strokeStyle: string;
}

const OPS = [
  'fillRect', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fillText', 'setLineDash', 'save', 'restore',
];

function mkCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
    measureText: vi.fn(() => ({ width: 0 })),
  };

  for (const op of OPS) {
    ctx[op] = vi.fn((...args: unknown[]) => {
      calls.push({ op, args, fillStyle: ctx.fillStyle as string, strokeStyle: ctx.strokeStyle as string });
    });
  }

  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function candle(i: number, close: number, open = close, volume = 100 + i): Candle {
  return {
    timestamp: new Date(1_700_000_000_000 + i * BIN_1M).toISOString(),
    open,
    high:      Math.max(open, close) + 1,
    low:       Math.min(open, close) - 1,
    close,
    volume,
  };
}

const fillRects = (calls: Call[], style: string) =>
  calls.filter(c => c.op === 'fillRect' && c.fillStyle === style).map(c => c.args as number[]);

/** Wicks: moveTo(cx, yHigh) immediately followed by lineTo(cx, yLow), stroked in a candle colour. */
function wicks(calls: Call[]): { x: number; yHigh: number; yLow: number }[] {
  const out: { x: number; yHigh: number; yLow: number }[] = [];

  for (let k = 0; k + 1 < calls.length; k++) {
    const [m, l] = [calls[k], calls[k + 1]];

    if (m.op === 'moveTo' && l.op === 'lineTo' && (m.strokeStyle === UP || m.strokeStyle === DOWN)) {
      out.push({ x: m.args[0] as number, yHigh: m.args[1] as number, yLow: l.args[1] as number });
    }
  }

  return out;
}

/** Text drawn at the price axis (left-aligned just right of the plot). */
const priceLabels = (calls: Call[]) =>
  calls.filter(c => c.op === 'fillText' && c.args[1] === WIDTH - MARGIN.right + 4).map(c => c.args[0] as string);

/** Text drawn on the time axis row. */
const timeLabels = (calls: Call[]) =>
  calls.filter(c => c.op === 'fillText' && c.args[2] === HEIGHT - MARGIN.bottom + 4).map(c => c.args[0] as string);

describe('MARGIN constant', () => {
  it('exposes a non-zero right margin so axis labels have room', () => {
    expect(MARGIN.right).toBeGreaterThan(0);
  });
});

describe('renderChart', () => {
  it('paints the background and exits early when there are no candles', () => {
    const { ctx, calls } = mkCtx();

    renderChart(ctx, [], DIM, 80, BIN_1M);

    expect(calls).toEqual([{ op: 'fillRect', args: [0, 0, WIDTH, HEIGHT], fillStyle: '#080808', strokeStyle: '' }]);
  });

  it('fills up bodies green and down bodies red, centred on their columns', () => {
    const { ctx, calls } = mkCtx();
    const candles = [candle(0, 101, 100), candle(1, 99, 100), candle(2, 102, 101)];
    const g       = columnGeometry(WIDTH, candles.length, 80);

    renderChart(ctx, candles, DIM, 80, BIN_1M);

    /** Body: halfW = floor((step - 1) / 2) = 4 either side of the centre. */
    expect(fillRects(calls, UP).map(r => [r[0], r[2]])).toEqual([
      [columnCenterX(g, 0) - 4, 8],
      [columnCenterX(g, 2) - 4, 8],
    ]);
    expect(fillRects(calls, DOWN).map(r => [r[0], r[2]])).toEqual([[columnCenterX(g, 1) - 4, 8]]);
  });

  it('maps higher prices to smaller y, with the range padded inside the price pane', () => {
    const { ctx, calls } = mkCtx();
    const candles = [candle(0, 100), candle(1, 120), candle(2, 90)];

    renderChart(ctx, candles, DIM, 80, BIN_1M);

    const w        = wicks(calls);
    const priceBot = MARGIN.top + Math.round((HEIGHT - MARGIN.top - MARGIN.bottom) * 0.82);

    expect(w).toHaveLength(3);
    /** Candle 1 has the highest high, candle 2 the lowest low. */
    expect(w[1].yHigh).toBe(Math.min(...w.map(x => x.yHigh)));
    expect(w[2].yLow).toBe(Math.max(...w.map(x => x.yLow)));
    expect(w[1].yHigh).toBeLessThan(w[2].yLow);
    expect(w[1].yHigh).toBeGreaterThan(MARGIN.top);
    expect(w[2].yLow).toBeLessThan(priceBot);
    /** Every wick runs from its high down to its low. */
    for (const x of w) expect(x.yHigh).toBeLessThan(x.yLow);
  });

  it('scales volume bars so the largest fills the volume pane, bottom-aligned', () => {
    const { ctx, calls } = mkCtx();
    const candles = [candle(0, 101, 100, 200), candle(1, 99, 100, 100)];

    renderChart(ctx, candles, DIM, 80, BIN_1M);

    /** plot 370 px → price pane round(370 * 0.82) = 303, 4 px gap, volume pane 63. */
    const volBot = HEIGHT - MARGIN.bottom;
    const [up]   = fillRects(calls, VOL_UP);
    const [down] = fillRects(calls, VOL_DN);

    expect(up[3]).toBe(63);
    expect(up[1] + up[3]).toBe(volBot);
    expect(down[3]).toBe(31.5);
    expect(down[1] + down[3]).toBe(volBot);
  });

  it('draws a dashed crosshair through the hovered candle and nothing else extra', () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100 + i));
    const g       = columnGeometry(WIDTH, candles.length, 80);

    const base  = mkCtx();
    const hover = mkCtx();

    renderChart(base.ctx,  candles, DIM, 80, BIN_1M, null);
    renderChart(hover.ctx, candles, DIM, 80, BIN_1M, 4);

    expect(base.calls.some(c => c.op === 'setLineDash')).toBe(false);

    const dashAt = hover.calls.findIndex(c => c.op === 'setLineDash');
    const x      = Math.round(columnCenterX(g, 4)) + 0.5;

    expect(hover.calls.filter(c => c.op === 'setLineDash').map(c => c.args)).toEqual([[[4, 4]]]);
    expect(hover.calls.slice(dashAt + 1).map(c => [c.op, ...c.args])).toEqual([
      ['beginPath'],
      ['moveTo', x, MARGIN.top],
      ['lineTo', x, HEIGHT - MARGIN.bottom],
      ['stroke'],
      ['restore'],
    ]);
    /** The rest of the drawing is unchanged: save + setLineDash + the five calls above. */
    expect(hover.calls.length - base.calls.length).toBe(7);
  });

  it('draws no crosshair when hoverIndex is out of range', () => {
    const candles = Array.from({ length: 3 }, (_, i) => candle(i, 100 + i));

    for (const idx of [99, -1]) {
      const { ctx, calls } = mkCtx();

      renderChart(ctx, candles, DIM, 80, BIN_1M, idx);

      expect(calls.some(c => c.op === 'setLineDash')).toBe(false);
    }
  });

  it('draws finite geometry when all candles have the same price', () => {
    const { ctx, calls } = mkCtx();

    /** Flat market — range is 0 before padding; renderer must not produce NaN. */
    const candles = Array.from({ length: 4 }, (_, i) => ({
      timestamp: new Date(1_700_000_000_000 + i * BIN_1M).toISOString(),
      open: 100, high: 100, low: 100, close: 100, volume: 0,
    }));

    renderChart(ctx, candles, DIM, 80, BIN_1M);

    const numbers = calls.flatMap(c => c.args).filter((a): a is number => typeof a === 'number');

    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(wicks(calls)).toHaveLength(4);
  });

  it('gives price labels enough decimals to stay distinct on a narrow range', () => {
    const { ctx, calls } = mkCtx();
    /** 68940.5 … 68941.5 → padded range 1.1 → step 0.2. */
    const candles = [
      { timestamp: '2026-11-24T00:01:00.000Z', open: 68941, high: 68941.5, low: 68940.5, close: 68941, volume: 1 },
    ];

    renderChart(ctx, candles, DIM, 80, BIN_1M);

    const labels = priceLabels(calls);

    expect(labels).toEqual(['68,940.6', '68,940.8', '68,941.0', '68,941.2', '68,941.4']);
  });

  it('labels the time axis with bin open times', () => {
    const { ctx, calls } = mkCtx();
    /** A daily candle stamped 2026-11-24T00:00Z covers Nov 23. */
    const daily = [{ timestamp: '2026-11-24T00:00:00.000Z', open: 1, high: 2, low: 0, close: 1, volume: 1 }];

    renderChart(ctx, daily, DIM, 80, BIN_1D);

    expect(timeLabels(calls)).toEqual(['Nov 23']);
  });

  it('shows the date for the hourly candle that opens at midnight', () => {
    const { ctx, calls } = mkCtx();
    /** Close times 00:00 and 01:00 → open times 23:00 and 00:00. One label per 60 px at 1 candle per view. */
    const hourly = ['2026-11-24T00:00:00.000Z', '2026-11-24T01:00:00.000Z'].map(timestamp => ({
      timestamp, open: 1, high: 2, low: 0, close: 1, volume: 1,
    }));

    renderChart(ctx, hourly, DIM, 2, BIN_1H);

    expect(timeLabels(calls)).toEqual(['23:00', 'Nov 24']);
  });
});

describe('niceStep', () => {
  it('rounds range / ticks to 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(1.1, 5)).toBeCloseTo(0.2, 12);
    expect(niceStep(1000, 5)).toBe(200);
    expect(niceStep(25, 5)).toBe(5);
    expect(niceStep(37, 5)).toBe(10);
    expect(niceStep(0.006, 5)).toBeCloseTo(0.001, 12);
  });
});

describe('formatPrice', () => {
  it('prints just enough decimals to tell labels one step apart', () => {
    expect(formatPrice(68_941.2, 0.2)).toBe('68,941.2');
    expect(formatPrice(68_941.200000001, 0.2)).toBe('68,941.2');
    expect(formatPrice(68_940, 5)).toBe('68,940');
    expect(formatPrice(0.51234, 0.0005)).toBe('0.5123');
    expect(formatPrice(0.05, 0.05)).toBe('0.05');
  });

  it('caps the decimals at eight', () => {
    expect(formatPrice(1e-10, 1e-10)).toBe('0.00000000');
  });
});

describe('column geometry', () => {
  const PLOT_RIGHT = MARGIN.left + 800;

  it('sizes slots by candlesPerView and anchors the newest candle at the right edge', () => {
    const g    = columnGeometry(WIDTH, 20, 80);
    const step = 800 / 80;

    expect(g.step).toBe(step);
    expect(columnCenterX(g, 19)).toBe(PLOT_RIGHT - step / 2);
    expect(columnCenterX(g, 0)).toBe(PLOT_RIGHT - 20 * step + step / 2);
  });

  it('never lays out more candles than fit in the plot', () => {
    const g = columnGeometry(WIDTH, 100, 80);

    expect(g.step).toBe(8);
    expect(columnCenterX(g, 0)).toBe(MARGIN.left + 4);
  });

  it('maps x back to the candle whose slot contains it', () => {
    const g = columnGeometry(WIDTH, 20, 80);

    expect(columnAt(g, PLOT_RIGHT - 1)).toBe(19);
    expect(columnAt(g, columnCenterX(g, 3))).toBe(3);
    /** Empty slots left of the oldest candle, and the price axis, hold no candle. */
    expect(columnAt(g, PLOT_RIGHT - 20 * 10 - 1)).toBeNull();
    expect(columnAt(g, PLOT_RIGHT)).toBeNull();
    expect(columnAt(g, PLOT_RIGHT + 30)).toBeNull();
  });

  it('draws the last of 20 candles at 80 per view one half-slot left of the plot edge', () => {
    const { ctx, calls } = mkCtx();
    const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100 + i));

    renderChart(ctx, candles, { width: WIDTH, height: 400 }, 80, BIN_1M);

    /** Wicks are drawn moveTo(cx, yHigh) → lineTo(cx, yLow); the last wick is at the rightmost centre. */
    const xs = calls.filter(c => c.op === 'moveTo').map(c => c.args[0] as number);

    expect(xs).toContain(PLOT_RIGHT - 5);
    expect(Math.max(...xs.filter(x => x < PLOT_RIGHT))).toBe(PLOT_RIGHT - 5);
  });
});
