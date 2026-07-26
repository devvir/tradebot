import { describe, it, expect } from 'vitest';
import { _test_computeVisible as computeVisible } from '../../../src/widgets/Chart/useChart';
import type { Candle, ViewportState } from '../../../src/widgets/Chart/types';

const BIN_1M = 60_000;

function candle(idx: number, base = 1_700_000_000_000): Candle {
  return {
    timestamp: new Date(base + idx * BIN_1M).toISOString(),
    open:      100, high: 101, low: 99, close: 100, volume: 1,
  };
}

const closed = Array.from({ length: 100 }, (_, i) => candle(i));

const live: ViewportState     = { candlesPerView: 10, rightAnchor: null };
const anchored: ViewportState = { candlesPerView: 10, rightAnchor: new Date(closed[50].timestamp) };

// ── live mode ─────────────────────────────────────────────────────────────────

describe('computeVisible — live (rightAnchor = null)', () => {
  it('returns the last N closed candles when there is no running bin', () => {
    const out = computeVisible(closed, live, null);

    expect(out).toEqual(closed.slice(-10));
  });

  it('appends the running bin and reserves one slot for it', () => {
    const running = candle(101);

    const out = computeVisible(closed, live, running);

    expect(out).toHaveLength(10);
    expect(out[out.length - 1]).toBe(running);
    expect(out.slice(0, -1)).toEqual(closed.slice(-9));
  });

  it('returns just the running bin when the closed buffer is empty', () => {
    const running = candle(0);

    const out = computeVisible([], live, running);

    expect(out).toEqual([running]);
  });

  it('returns an empty array when neither closed nor running is available', () => {
    expect(computeVisible([], live, null)).toEqual([]);
  });
});

// ── anchored mode ─────────────────────────────────────────────────────────────

describe('computeVisible — anchored', () => {
  it('slices N candles ending at the rightAnchor', () => {
    const out = computeVisible(closed, anchored, null);

    expect(out).toHaveLength(10);
    expect(out[out.length - 1]).toEqual(closed[50]);
    expect(out[0]).toEqual(closed[41]);
  });

  it('ignores the running bin when anchored to history', () => {
    const running = candle(101);
    const out     = computeVisible(closed, anchored, running);

    expect(out).not.toContain(running);
    expect(out[out.length - 1]).toEqual(closed[50]);
  });

  it('returns an empty slice when the anchor predates all candles', () => {
    const tooEarly: ViewportState = { candlesPerView: 10, rightAnchor: new Date(0) };

    expect(computeVisible(closed, tooEarly, null)).toEqual([]);
  });

  it('clips the left edge to 0 when anchor is near the start', () => {
    const earlyAnchor: ViewportState = { candlesPerView: 10, rightAnchor: new Date(closed[3].timestamp) };

    const out = computeVisible(closed, earlyAnchor, null);

    expect(out).toEqual(closed.slice(0, 4));
  });
});
