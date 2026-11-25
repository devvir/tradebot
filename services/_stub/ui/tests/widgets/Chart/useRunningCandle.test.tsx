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

  it('skips trades at or before the running bin start', async () => {
    const { result } = renderHook(() => useRunningCandle('XBTUSD', seed, BIN_1M), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ timestamp: new Date(seedEndMs - 1).toISOString(), price: 200 }),
        trade({ timestamp: new Date(seedEndMs).toISOString(),     price: 300 }),
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

// ── rollover into the next bin ────────────────────────────────────────────────

describe('useRunningCandle — rollover', () => {
  function mountWithSeed() {
    return renderHook(
      ({ s }: { s: Candle | null }) => useRunningCandle('XBTUSD', s, BIN_1M),
      {
        wrapper:      makeBitmexWrapper(fake),
        initialProps: { s: seed as Candle | null },
      },
    );
  }

  it('a trade after the running bin closes opens the next bin at the last price, with that trade', async () => {
    const { result } = mountWithSeed();

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ price: 98, size: 4 }),
        trade({ timestamp: new Date(seedNextEnd + 1_000).toISOString(), price: 101, size: 2 }),
      ]);
    });

    act(() => { flushFrame(); });

    expect(result.current).toEqual({
      timestamp: new Date(seedNextEnd + BIN_1M).toISOString(),
      open:      98, close: 101, high: 101, low: 98, volume: 2,
    });
  });

  it('skips bins without trades: a trade several bins later lands in its own bin', async () => {
    const { result } = mountWithSeed();

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ timestamp: new Date(seedNextEnd + 2 * BIN_1M + 5_000).toISOString(), price: 90, size: 3 }),
      ]);
    });

    act(() => { flushFrame(); });

    expect(result.current?.timestamp).toBe(new Date(seedNextEnd + 3 * BIN_1M).toISOString());
    expect(result.current?.volume).toBe(3);
  });

  it('keeps the rolled-over bin\'s trades when the just-closed bin arrives as the new seed', async () => {
    const { result, rerender } = mountWithSeed();

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ timestamp: new Date(seedNextEnd + 1_000).toISOString(), price: 101, size: 2 }),
      ]);
    });

    act(() => { flushFrame(); });

    /** The venue publishes the bin that closed at seedNextEnd. */
    rerender({ s: { timestamp: new Date(seedNextEnd).toISOString(), open: 95, high: 99, low: 94, close: 97, volume: 8 } });

    expect(result.current).toEqual({
      timestamp: new Date(seedNextEnd + BIN_1M).toISOString(),
      open:      97, close: 101, high: 101, low: 97, volume: 2,
    });

    /** A seed older than the running bin (e.g. a late re-publish) changes nothing. */
    rerender({ s: seed });

    expect(result.current?.timestamp).toBe(new Date(seedNextEnd + BIN_1M).toISOString());
    expect(result.current?.volume).toBe(2);
  });

  it('starts a fresh bin when the seed moves past the running bin', async () => {
    const { result, rerender } = mountWithSeed();

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => { fake.emit<Trade>('trade:XBTUSD', 'insert', [trade({ price: 110, size: 5 })]); });
    act(() => { flushFrame(); });

    rerender({ s: { timestamp: new Date(seedNextEnd).toISOString(), open: 95, high: 110, low: 95, close: 110, volume: 5 } });

    expect(result.current).toEqual({
      timestamp: new Date(seedNextEnd + BIN_1M).toISOString(),
      open:      110, close: 110, high: 110, low: 110, volume: 0,
    });
  });

  it('reseeds on a bin-size change even when the new seed is older than the running bin', async () => {
    const { result, rerender } = renderHook(
      ({ binMs }: { binMs: number }) => useRunningCandle('XBTUSD', seed, binMs),
      { wrapper: makeBitmexWrapper(fake), initialProps: { binMs: 5 * BIN_1M } },
    );

    expect(result.current?.timestamp).toBe(new Date(seedEndMs + 5 * BIN_1M).toISOString());

    rerender({ binMs: BIN_1M });

    expect(result.current?.timestamp).toBe(new Date(seedNextEnd).toISOString());
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
