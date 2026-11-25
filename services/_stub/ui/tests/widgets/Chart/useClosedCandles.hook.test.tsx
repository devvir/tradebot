import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useClosedCandles } from '../../../src/widgets/Chart/useClosedCandles';
import { useChart } from '../../../src/widgets/Chart/useChart';
import { makeFakeBitmex, makeBitmexWrapper, type FakeBitmex } from '../../helpers/fakeBitmex';
import type { Candle, Timeframe, ViewportState } from '../../../src/widgets/Chart/types';
import type { TradeBin } from '../../../src/types';

const BIN = 60_000;

/** Wall clock: 30 s into a bin. The newest closed 1m bin is LIVE. */
const NOW  = Date.UTC(2024, 0, 10, 12, 0, 30);
const LIVE = Math.floor(NOW / BIN) * BIN;

const CHANNEL = 'tradeBin1m:XBTUSD';

/** cpv 80 → 80 + 2 * ceil(80 * 0.5) = 160 candles per page. */
const PAGE = 160;

let fake:           FakeBitmex;
let latestMs:       number;
let historyStartMs: number;

function bin(ms: number): TradeBin {
  const price = 100 + (ms / BIN) % 50;

  return {
    timestamp: new Date(ms).toISOString(),
    symbol:    'XBTUSD',
    open:      price, high: price + 1, low: price - 1, close: price, volume: 1,
  };
}

/** Fake `trade/bucketed?reverse=true`: up to `count` contiguous bins ending at endTime (or the newest), newest first. */
function restPage(count: number, params: Record<string, string | number>, binMs = BIN): TradeBin[] {
  const requestedEnd = params.endTime !== undefined
    ? Math.floor(Date.parse(String(params.endTime)) / binMs) * binMs
    : latestMs;
  const rows: TradeBin[] = [];

  for (let ms = Math.min(requestedEnd, latestMs); rows.length < count && ms >= historyStartMs; ms -= binMs) {
    rows.push(bin(ms));
  }

  return rows;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!:  (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });

  return { promise, resolve, reject };
}

const live: ViewportState = { candlesPerView: 80, rightAnchor: null };

function anchoredAt(binsBack: number, cpv = 80): ViewportState {
  return { candlesPerView: cpv, rightAnchor: new Date(LIVE - binsBack * BIN) };
}

function msOf(c: Candle): number {
  return Date.parse(c.timestamp);
}

/** Every neighbouring pair is exactly one bin apart. */
function expectContiguous(candles: Candle[], binMs = BIN) {
  for (let i = 1; i < candles.length; i++) {
    expect(msOf(candles[i]) - msOf(candles[i - 1])).toBe(binMs);
  }
}

function renderClosed(initial: ViewportState = live, timeframe: Timeframe = '1m') {
  return renderHook(
    ({ vp, tf }: { vp: ViewportState; tf: Timeframe }) => useClosedCandles('XBTUSD', tf, vp),
    { wrapper: makeBitmexWrapper(fake), initialProps: { vp: initial, tf: timeframe } },
  );
}

/** Let pending fetch promises and the pages they trigger settle. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  fake           = makeFakeBitmex();
  latestMs       = LIVE;
  historyStartMs = LIVE - 10_000 * BIN;

  fake.fetchMock.mockImplementation(async (_table: string, count: number, params: Record<string, string | number>) =>
    restPage(count, params));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── initial load ──────────────────────────────────────────────────────────────

describe('useClosedCandles — initial load', () => {
  it('loads the newest page (no endTime) sized view + 2×margin and records the live tail', async () => {
    const { result } = renderClosed();

    await waitFor(() => expect(result.current.candles).toHaveLength(PAGE));
    await settle();

    expect(fake.fetchMock).toHaveBeenCalledTimes(1);
    expect(fake.fetchMock).toHaveBeenCalledWith('trade/bucketed', PAGE, { symbol: 'XBTUSD', binSize: '1m' });
    expect(msOf(result.current.candles[PAGE - 1])).toBe(LIVE);
    expect(result.current.liveTailMs).toBe(LIVE);
    expectContiguous(result.current.candles);
  });
});

// ── tradeBin inserts at the live edge ─────────────────────────────────────────

describe('useClosedCandles — tradeBin inserts while the buffer reaches the live edge', () => {
  async function loaded() {
    const hook = renderClosed();
    await waitFor(() => expect(hook.result.current.candles).toHaveLength(PAGE));
    await settle();

    return hook;
  }

  it('appends a contiguous insert and advances the live tail', async () => {
    const { result } = await loaded();

    act(() => fake.emit(CHANNEL, 'insert', [bin(LIVE + BIN)]));

    expect(msOf(result.current.candles[result.current.candles.length - 1])).toBe(LIVE + BIN);
    expect(result.current.candles).toHaveLength(PAGE + 1);
    expect(result.current.liveTailMs).toBe(LIVE + BIN);
    expect(fake.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a duplicate of the tail', async () => {
    const { result } = await loaded();
    const before = result.current.candles;

    act(() => fake.emit(CHANNEL, 'insert', [bin(LIVE)]));
    await settle();

    expect(result.current.candles).toBe(before);
    expect(fake.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sorts an unsorted multi-row insert before validating it', async () => {
    const { result } = await loaded();

    act(() => fake.emit(CHANNEL, 'insert', [bin(LIVE + 2 * BIN), bin(LIVE + BIN)]));

    expect(result.current.candles.slice(-3).map(msOf)).toEqual([LIVE, LIVE + BIN, LIVE + 2 * BIN]);
    expect(result.current.liveTailMs).toBe(LIVE + 2 * BIN);
    expect(fake.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wipes the buffer on a gap and reloads it with exactly one fetch', async () => {
    const { result } = await loaded();
    const page = deferred<TradeBin[]>();

    latestMs = LIVE + 3 * BIN;
    vi.setSystemTime(NOW + 3 * BIN);
    fake.fetchMock.mockImplementationOnce(() => page.promise);

    act(() => fake.emit(CHANNEL, 'insert', [bin(LIVE + 3 * BIN)]));

    expect(result.current.candles).toEqual([]);
    expect(fake.fetchMock).toHaveBeenCalledTimes(2);
    expect(fake.fetchMock.mock.calls[1][2]).not.toHaveProperty('endTime');

    await act(async () => page.resolve(restPage(PAGE, {})));
    await settle();

    expect(fake.fetchMock).toHaveBeenCalledTimes(2);
    expect(msOf(result.current.candles[result.current.candles.length - 1])).toBe(LIVE + 3 * BIN);
    expectContiguous(result.current.candles);
  });
});

// ── tradeBin inserts while browsing history ───────────────────────────────────

describe('useClosedCandles — tradeBin inserts while the buffer holds history', () => {
  /** Live load, then pan back far enough that the buffer is trimmed away from the live edge. */
  async function trimmedHistory() {
    const hook = renderClosed();
    await waitFor(() => expect(hook.result.current.candles).toHaveLength(PAGE));

    hook.rerender({ vp: anchoredAt(100), tf: '1m' });
    await settle();
    hook.rerender({ vp: anchoredAt(250), tf: '1m' });
    await settle();

    return hook;
  }

  it('leaves a trimmed buffer untouched and only advances the live tail', async () => {
    const { result } = await trimmedHistory();
    const before     = result.current.candles;
    const fetches    = fake.fetchMock.mock.calls.length;

    /** Trimmed: the tail is far behind the live edge. */
    expect(msOf(before[before.length - 1])).toBeLessThan(LIVE - 200 * BIN);

    latestMs = LIVE + BIN;
    act(() => fake.emit(CHANNEL, 'insert', [bin(LIVE + BIN)]));
    await settle();

    expect(result.current.candles).toBe(before);
    expect(result.current.liveTailMs).toBe(LIVE + BIN);
    expect(fake.fetchMock).toHaveBeenCalledTimes(fetches);
  });

  it('survives several inserts in a row without reloading', async () => {
    const { result } = await trimmedHistory();
    const before     = result.current.candles;
    const fetches    = fake.fetchMock.mock.calls.length;

    for (let i = 1; i <= 3; i++) {
      latestMs = LIVE + i * BIN;
      act(() => fake.emit(CHANNEL, 'insert', [bin(LIVE + i * BIN)]));
    }
    await settle();

    expect(result.current.candles).toBe(before);
    expect(fake.fetchMock).toHaveBeenCalledTimes(fetches);
  });

  it('going live replaces the stale buffer with the newest page, leaving no hole', async () => {
    const { result, rerender } = await trimmedHistory();

    latestMs = LIVE + 2 * BIN;
    vi.setSystemTime(NOW + 2 * BIN);
    act(() => fake.emit(CHANNEL, 'insert', [bin(LIVE + BIN), bin(LIVE + 2 * BIN)]));
    const fetches = fake.fetchMock.mock.calls.length;

    rerender({ vp: live, tf: '1m' });
    await settle();

    expect(fake.fetchMock.mock.calls[fetches]).toEqual(['trade/bucketed', PAGE, { symbol: 'XBTUSD', binSize: '1m' }]);
    expect(msOf(result.current.candles[result.current.candles.length - 1])).toBe(LIVE + 2 * BIN);
    expectContiguous(result.current.candles);
  });
});

// ── pagination ────────────────────────────────────────────────────────────────

describe('useClosedCandles — pagination', () => {
  it('keeps paging after a jump until the viewport window is filled', async () => {
    const { result, rerender } = renderClosed();
    await waitFor(() => expect(result.current.candles).toHaveLength(PAGE));

    /** Window for anchor LIVE-300: [LIVE-420, LIVE-260] — well left of the buffer. */
    rerender({ vp: anchoredAt(300), tf: '1m' });
    await settle();

    const ms = result.current.candles.map(msOf);

    expect(ms[0]).toBeLessThanOrEqual(LIVE - 419 * BIN);
    expect(ms[ms.length - 1]).toBeGreaterThanOrEqual(LIVE - 260 * BIN);
    expectContiguous(result.current.candles);
  });

  it('issues every page one viewport change needs, not just the first', async () => {
    const { result, rerender } = renderClosed();
    await waitFor(() => expect(result.current.candles).toHaveLength(PAGE));

    rerender({ vp: anchoredAt(300), tf: '1m' });
    await settle();

    /** Zoom out around the same anchor: the 600-candle window [LIVE-750, LIVE-150] grows past both buffer ends. */
    rerender({ vp: anchoredAt(300, 300), tf: '1m' });
    await settle();

    const ms = result.current.candles.map(msOf);

    expect(ms[0]).toBeLessThanOrEqual(LIVE - 749 * BIN);
    expect(ms[ms.length - 1]).toBeGreaterThanOrEqual(LIVE - 151 * BIN);
    expectContiguous(result.current.candles);
  });

  it('stops paging at the start of history (short page)', async () => {
    historyStartMs = LIVE - 200 * BIN;

    const { result, rerender } = renderClosed();
    await waitFor(() => expect(result.current.candles).toHaveLength(PAGE));

    rerender({ vp: anchoredAt(150), tf: '1m' });
    await settle();

    const fetches = fake.fetchMock.mock.calls.length;
    expect(msOf(result.current.candles[0])).toBe(historyStartMs);

    /** Further viewport changes over the same exhausted history issue nothing new. */
    for (let i = 0; i < 5; i++) {
      rerender({ vp: anchoredAt(150 + i * 0.1), tf: '1m' });
    }
    await settle();

    expect(fake.fetchMock.mock.calls.length).toBeLessThanOrEqual(fetches + 1);
  });
});

// ── in-flight request ─────────────────────────────────────────────────────────

describe('useClosedCandles — single in-flight request', () => {
  it('keeps one request in flight across many viewport changes, then applies it and follows up at most once', async () => {
    const { result, rerender } = renderClosed();
    await waitFor(() => expect(result.current.candles).toHaveLength(PAGE));
    await settle();

    const page = deferred<TradeBin[]>();
    let pendingArgs: [number, Record<string, string | number>] | null = null;

    fake.fetchMock.mockImplementationOnce((_t: string, count: number, params: Record<string, string | number>) => {
      pendingArgs = [count, params];

      return page.promise;
    });

    /** 50 drag steps past the buffer's left edge. */
    for (let i = 0; i < 50; i++) {
      rerender({ vp: anchoredAt(100 + i), tf: '1m' });
    }
    await settle();

    expect(fake.fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => page.resolve(restPage(pendingArgs![0], pendingArgs![1])));
    await settle();

    expect(fake.fetchMock.mock.calls.length).toBeLessThanOrEqual(3);

    /** The response was applied, not discarded: the final window is covered. */
    expect(msOf(result.current.candles[0])).toBeLessThanOrEqual(LIVE - 268 * BIN);
    expectContiguous(result.current.candles);
  });

  it('logs a failed fetch and leaves the buffer unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result, rerender } = renderClosed();
    await waitFor(() => expect(result.current.candles).toHaveLength(PAGE));

    const before = result.current.candles;
    fake.fetchMock.mockRejectedValueOnce(new Error('boom'));

    rerender({ vp: anchoredAt(100), tf: '1m' });
    await settle();

    expect(warn).toHaveBeenCalledWith('useClosedCandles: fetch failed', expect.any(Error));
    expect(result.current.candles).toBe(before);
  });
});

// ── series identity ───────────────────────────────────────────────────────────

describe('useClosedCandles — timeframe change', () => {
  it('empties the buffer, moves the tradeBin subscription and discards the old in-flight page', async () => {
    const oldPage = deferred<TradeBin[]>();
    fake.fetchMock.mockImplementationOnce(() => oldPage.promise);

    const { result, rerender } = renderClosed();

    expect(fake.subscriberCount(CHANNEL)).toBe(1);

    const binMs5 = 5 * BIN;
    fake.fetchMock.mockImplementation(async (_t: string, count: number, params: Record<string, string | number>) =>
      restPage(count, params, binMs5));
    latestMs = Math.floor(NOW / binMs5) * binMs5;

    rerender({ vp: live, tf: '5m' });

    expect(result.current.candles).toEqual([]);
    expect(result.current.liveTailMs).toBeNull();
    expect(fake.subscriberCount(CHANNEL)).toBe(0);
    expect(fake.subscriberCount('tradeBin5m:XBTUSD')).toBe(1);

    await waitFor(() => expect(result.current.candles).toHaveLength(PAGE));

    /** The 1m page that was in flight lands after the switch and is ignored. */
    await act(async () => oldPage.resolve(restPage(PAGE, {})));
    await settle();

    expectContiguous(result.current.candles, binMs5);
    expect(fake.fetchMock.mock.calls[fake.fetchMock.mock.calls.length - 1][2]).toEqual({ symbol: 'XBTUSD', binSize: '5m' });
  });
});

// ── useChart: pan uses the live tail ──────────────────────────────────────────

describe('useChart — panning over a trimmed buffer', () => {
  it('a forward pan that stays behind the live tail stays anchored', async () => {
    const { result } = renderHook(() => useChart('1m'), { wrapper: makeBitmexWrapper(fake) });
    await waitFor(() => expect(result.current.candles.length).toBeGreaterThan(0));

    act(() => result.current.onPan(-100));
    await settle();
    act(() => result.current.onPan(-150));
    await settle();

    /** Buffer is trimmed around LIVE-250: its tail is ~40 bins after the anchor. */
    act(() => result.current.onPan(50));

    expect(result.current.viewport.rightAnchor?.getTime()).toBe(LIVE - 200 * BIN);
  });

  it('panning forward past the live tail goes live', async () => {
    const { result } = renderHook(() => useChart('1m'), { wrapper: makeBitmexWrapper(fake) });
    await waitFor(() => expect(result.current.candles.length).toBeGreaterThan(0));

    act(() => result.current.onPan(-30));
    act(() => result.current.onPan(30));

    expect(result.current.viewport.rightAnchor).toBeNull();
  });
});
