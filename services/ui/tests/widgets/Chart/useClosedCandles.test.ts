import { describe, it, expect } from 'vitest';
import {
  _test_toCandle           as toCandle,
  _test_mergeCandles       as mergeCandles,
  _test_computeNeededFetch as computeNeededFetch,
  _test_trimBuffer         as trimBuffer,
} from '../../../src/widgets/Chart/useClosedCandles';
import type { Candle, ViewportState } from '../../../src/widgets/Chart/types';

const BIN_1M = 60_000;

function candle(idx: number, base = 1_700_000_000_000): Candle {
  return {
    timestamp: new Date(base + idx * BIN_1M).toISOString(),
    open:      100, high: 101, low: 99, close: 100, volume: 1,
  };
}

// ── toCandle ──────────────────────────────────────────────────────────────────

describe('toCandle', () => {
  it('maps a TradeBin straight to a Candle', () => {
    const out = toCandle({
      timestamp: '2024-01-01T00:00:00Z',
      symbol:    'XBTUSD',
      open:      10, high: 12, low: 9, close: 11, volume: 7,
    });

    expect(out).toEqual({ timestamp: '2024-01-01T00:00:00Z', open: 10, high: 12, low: 9, close: 11, volume: 7 });
  });

  it('defaults missing numeric fields to 0', () => {
    const out = toCandle({ timestamp: '2024-01-01T00:00:00Z', symbol: 'XBTUSD' });

    expect(out).toEqual({ timestamp: '2024-01-01T00:00:00Z', open: 0, high: 0, low: 0, close: 0, volume: 0 });
  });
});

// ── mergeCandles ──────────────────────────────────────────────────────────────

describe('mergeCandles', () => {
  it('returns the other array when one side is empty', () => {
    const c = [candle(0), candle(1)];

    expect(mergeCandles([], c)).toBe(c);
    expect(mergeCandles(c, [])).toBe(c);
  });

  it('merges and sorts by timestamp ascending', () => {
    const a = [candle(2), candle(0)];
    const b = [candle(3), candle(1)];

    const out = mergeCandles(a, b);

    expect(out.map(c => c.timestamp)).toEqual(out.map(c => c.timestamp).slice().sort());
    expect(out).toHaveLength(4);
  });

  it('overwrites collisions with the second argument (later wins)', () => {
    const a = [{ ...candle(0), close: 1 }];
    const b = [{ ...candle(0), close: 999 }];

    expect(mergeCandles(a, b)[0].close).toBe(999);
  });
});

// ── computeNeededFetch ────────────────────────────────────────────────────────

describe('computeNeededFetch', () => {
  const viewport: ViewportState = { candlesPerView: 20, rightAnchor: null };

  it('asks for a full window (view + 2×buffer) when buffer is empty', () => {
    const need = computeNeededFetch([], viewport, BIN_1M);

    expect(need).not.toBeNull();
    /** 20 + 2 * ceil(20 * 0.5) = 40. */
    expect(need!.count).toBe(40);
    expect(need!.endTime).toBeNull();
  });

  it('returns null when the buffer already covers the visible range (live)', () => {
    /** 200 contiguous candles around "now" — well wider than 20 + buffer. */
    const ms = Date.now();
    const buf = Array.from({ length: 200 }, (_, i) => candle(i, ms - 100 * BIN_1M));

    expect(computeNeededFetch(buf, viewport, BIN_1M)).toBeNull();
  });

  it('asks for the left side when the buffer is short on history', () => {
    /** Only a tiny recent slice, but viewport is anchored far in the past. */
    const ms = Date.now();
    const buf = [candle(0, ms - BIN_1M), candle(1, ms - BIN_1M)];
    const anchored: ViewportState = { candlesPerView: 20, rightAnchor: new Date(ms - 100 * BIN_1M) };

    const need = computeNeededFetch(buf, anchored, BIN_1M);

    expect(need).not.toBeNull();
    expect(need!.endTime).not.toBeNull();
  });
});

// ── trimBuffer ────────────────────────────────────────────────────────────────

describe('trimBuffer', () => {
  it('returns the buffer unchanged when small enough', () => {
    const buf = Array.from({ length: 50 }, (_, i) => candle(i));
    const viewport: ViewportState = { candlesPerView: 20, rightAnchor: null };

    expect(trimBuffer(buf, viewport, BIN_1M)).toBe(buf);
  });

  it('trims candles outside the configured buffer window when oversized', () => {
    /** Configure a tight view so trimming kicks in. */
    const viewport: ViewportState = { candlesPerView: 20, rightAnchor: null };

    /** Build many more candles than the 200 floor (200) so trimming engages. */
    const buf = Array.from({ length: 300 }, (_, i) => candle(i));

    const out = trimBuffer(buf, viewport, BIN_1M);

    expect(out.length).toBeLessThan(buf.length);

    /** The latest candles should always survive trimming (the right edge anchor). */
    expect(out[out.length - 1]).toEqual(buf[buf.length - 1]);
  });
});
