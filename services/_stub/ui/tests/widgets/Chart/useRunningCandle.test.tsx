import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRunningCandle } from '../../../src/widgets/Chart/useRunningCandle';
import { makeFakeBitmex, makeBitmexWrapper, type FakeBitmex } from '../../helpers/fakeBitmex';
import type { Candle } from '../../../src/widgets/Chart/types';
import type { Trade } from '../../../src/types';

const BIN_1M = 60_000;

let fake:    FakeBitmex;
let rafCb:   FrameRequestCallback | null;
let rafId:   number;

beforeEach(() => {
  fake  = makeFakeBitmex();
  rafCb = null;
  rafId = 0;

  /** Hand-driven rAF — `flushFrame()` runs the queued callback synchronously. */
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCb = cb;
    return ++rafId;
  });

  vi.stubGlobal('cancelAnimationFrame', () => { rafCb = null; });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushFrame() {
  const cb = rafCb;
  rafCb = null;
  cb?.(performance.now());
}

const seed: Candle = {
  /** Bin closes at 00:01:00Z — the running bin runs from 00:01:00Z to 00:02:00Z. */
  timestamp: '2024-01-01T00:01:00Z',
  open:      90, high: 100, low: 85, close: 95, volume: 5,
};

const seedEndMs   = new Date(seed.timestamp).getTime();
const seedNextEnd = seedEndMs + BIN_1M;

const trade = (over: Partial<Trade>): Trade => ({
  timestamp:       new Date(seedEndMs + 30_000).toISOString(),  /** inside the running bin */
  symbol:          'XBTUSD',
  side:            'Buy',
  size:            1,
  price:           100,
  tickDirection:   'PlusTick',
  trdMatchID:      'm',
  grossValue:      1,
  homeNotional:    1,
  foreignNotional: 1,
  ...over,
});

// ── seeding ───────────────────────────────────────────────────────────────────

describe('useRunningCandle — seeding', () => {
  it('seeds the running bin from the previous candle close (OHLC continuity)', () => {
    const { result } = renderHook(() => useRunningCandle('XBTUSD', seed, BIN_1M), { wrapper: makeBitmexWrapper(fake) });

    /** Bin timestamp = previous bin end + binMs; OHLC all start at prev.close. */
    expect(result.current).toEqual({
      timestamp: new Date(seedNextEnd).toISOString(),
      open:      95, close: 95, high: 95, low: 95, volume: 0,
    });
  });

  it('clears the running bin when seed becomes null', () => {
    const { result, rerender } = renderHook(
      ({ s }: { s: Candle | null }) => useRunningCandle('XBTUSD', s, BIN_1M),
      {
        wrapper:      makeBitmexWrapper(fake),
        initialProps: { s: seed as Candle | null },
      },
    );

    expect(result.current).not.toBeNull();

    rerender({ s: null });

    expect(result.current).toBeNull();
  });
});

// ── trade absorption ──────────────────────────────────────────────────────────

describe('useRunningCandle — trade absorption', () => {
  it('updates close, expands high/low, and accumulates volume from trades in the bin window', async () => {
    const { result } = renderHook(() => useRunningCandle('XBTUSD', seed, BIN_1M), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ price: 110, size: 2 }),
        trade({ price:  80, size: 3 }),
        trade({ price: 105, size: 1 }),
      ]);
    });

    /** Throttle through rAF. */
    act(() => { flushFrame(); });

    expect(result.current?.high).toBe(110);
    expect(result.current?.low).toBe(80);
    expect(result.current?.close).toBe(105);  /** last trade in batch */
    expect(result.current?.volume).toBe(6);
    expect(result.current?.open).toBe(95);   /** unchanged from seed */
  });

  it('skips trades outside the bin window (older than start, or after end)', async () => {
    const { result } = renderHook(() => useRunningCandle('XBTUSD', seed, BIN_1M), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        /** Before bin start (= seedEndMs). */
        trade({ timestamp: new Date(seedEndMs - 1).toISOString(), price: 200 }),
        /** After bin end. */
        trade({ timestamp: new Date(seedNextEnd + 1).toISOString(), price: 300 }),
      ]);
    });

    act(() => { flushFrame(); });

    /** Snapshot unchanged from seed. */
    expect(result.current).toEqual({
      timestamp: new Date(seedNextEnd).toISOString(),
      open:      95, close: 95, high: 95, low: 95, volume: 0,
    });
  });

  it('ignores non-insert actions on the trade channel', async () => {
    const { result } = renderHook(() => useRunningCandle('XBTUSD', seed, BIN_1M), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => { fake.emit<Trade>('trade:XBTUSD', 'partial', [trade({ price: 999 })]); });

    act(() => { flushFrame(); });

    expect(result.current?.volume).toBe(0);
  });
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe('useRunningCandle — lifecycle', () => {
  it('unsubscribes from the trade channel on unmount', () => {
    const { unmount } = renderHook(() => useRunningCandle('XBTUSD', seed, BIN_1M), { wrapper: makeBitmexWrapper(fake) });

    expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0);

    unmount();

    expect(fake.subscriberCount('trade:XBTUSD')).toBe(0);
  });
});
