import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import { useRecentTrades } from '../../../src/widgets/RecentTrades/useRecentTrades';
import { makeFakeBitmex, makeBitmexWrapper, type FakeBitmex } from '../../helpers/fakeBitmex';
import type { Trade } from '../../../src/types';

let fake: FakeBitmex;

beforeEach(() => {
  fake = makeFakeBitmex();
});

const trade = (over: Partial<Trade>): Trade => ({
  timestamp:       '2024-01-01T00:00:00Z',
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

// ── initial fetch ─────────────────────────────────────────────────────────────

describe('useRecentTrades — initial REST page', () => {
  it('fetches the trade table with the symbol and limit, tagged with unique uids', async () => {
    fake.fetchMock.mockResolvedValueOnce([trade({ price: 100 }), trade({ price: 101 })]);

    const { result } = renderHook(() => useRecentTrades(10), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(result.current).toHaveLength(2));

    expect(fake.fetchMock).toHaveBeenCalledWith('trade', 10, { symbol: 'XBTUSD' });

    const uids = result.current.map(t => t.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('survives a failed initial fetch and keeps the WS subscription', async () => {
    fake.fetchMock.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useRecentTrades(5), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    /** State stays empty after a rejected fetch. */
    expect(result.current).toEqual([]);
  });
});

// ── streaming inserts ─────────────────────────────────────────────────────────

describe('useRecentTrades — WS inserts', () => {
  it('prepends incoming inserts newest-first (reversed within the batch)', async () => {
    fake.fetchMock.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useRecentTrades(10), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ price: 1 }),
        trade({ price: 2 }),
        trade({ price: 3 }),
      ]);
    });

    /** Batch arrives oldest-first; we reverse so 3 is newest → head of the list. */
    expect(result.current.map(t => t.trade.price)).toEqual([3, 2, 1]);
  });

  it('caps the list at `limit` entries (FIFO)', async () => {
    fake.fetchMock.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useRecentTrades(3), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ price: 1 }), trade({ price: 2 }), trade({ price: 3 }),
        trade({ price: 4 }), trade({ price: 5 }),
      ]);
    });

    expect(result.current.map(t => t.trade.price)).toEqual([5, 4, 3]);
  });

  it('ignores non-insert actions', async () => {
    fake.fetchMock.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useRecentTrades(10), { wrapper: makeBitmexWrapper(fake) });

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => { fake.emit<Trade>('trade:XBTUSD', 'update', [trade({ price: 99 })]); });
    act(() => { fake.emit<Trade>('trade:XBTUSD', 'delete', [trade({ price: 99 })]); });

    expect(result.current).toEqual([]);
  });
});

// ── REST page and WS inserts together ──────────────────────────────────────────

/** A fetch whose resolution the test controls. */
function pendingFetch(): (page: Trade[]) => Promise<void> {
  let resolve!: (page: Trade[]) => void;
  fake.fetchMock.mockReturnValueOnce(new Promise<Trade[]>(r => { resolve = r; }));

  return async (page) => {
    await act(async () => { resolve(page); });
  };
}

describe('useRecentTrades — REST page racing WS inserts', () => {
  it('keeps inserts that arrive before the REST page, ahead of it', async () => {
    const resolveFetch = pendingFetch();

    const { result } = renderHook(() => useRecentTrades(10), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [trade({ trdMatchID: 'live-1', price: 103 })]);
    });

    /** REST page is newest-first. */
    await resolveFetch([
      trade({ trdMatchID: 'rest-2', price: 102 }),
      trade({ trdMatchID: 'rest-1', price: 101 }),
    ]);

    expect(result.current.map(t => t.trade.trdMatchID)).toEqual(['live-1', 'rest-2', 'rest-1']);
  });

  it('lists a trade present in both the stream and the REST page once', async () => {
    const resolveFetch = pendingFetch();

    const { result } = renderHook(() => useRecentTrades(10), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        trade({ trdMatchID: 'both', price: 102 }),
        trade({ trdMatchID: 'live-1', price: 103 }),
      ]);
    });

    await resolveFetch([
      trade({ trdMatchID: 'both', price: 102 }),
      trade({ trdMatchID: 'rest-1', price: 101 }),
    ]);

    expect(result.current.map(t => t.trade.trdMatchID)).toEqual(['live-1', 'both', 'rest-1']);
  });

  it('caps the merged list at `limit`, dropping the oldest REST trades', async () => {
    const resolveFetch = pendingFetch();

    const { result } = renderHook(() => useRecentTrades(2), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [trade({ trdMatchID: 'live-1' })]);
    });

    await resolveFetch([trade({ trdMatchID: 'rest-2' }), trade({ trdMatchID: 'rest-1' })]);

    expect(result.current.map(t => t.trade.trdMatchID)).toEqual(['live-1', 'rest-2']);
  });

  it('clears the list on symbol change and ignores the old symbol\'s late REST page', async () => {
    const resolveOld = pendingFetch();
    const resolveNew = pendingFetch();

    const { result } = renderHook(
      () => ({ trades: useRecentTrades(10), navigate: useNavigate() }),
      { wrapper: makeBitmexWrapper(fake) },
    );

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [trade({ trdMatchID: 'xbt-live' })]);
    });
    expect(result.current.trades).toHaveLength(1);

    act(() => { result.current.navigate('/ETHUSD'); });

    expect(result.current.trades).toEqual([]);
    expect(fake.fetchMock).toHaveBeenLastCalledWith('trade', 10, { symbol: 'ETHUSD' });

    await resolveOld([trade({ trdMatchID: 'xbt-rest', symbol: 'XBTUSD' })]);
    expect(result.current.trades).toEqual([]);

    await resolveNew([trade({ trdMatchID: 'eth-rest', symbol: 'ETHUSD' })]);
    expect(result.current.trades.map(t => t.trade.trdMatchID)).toEqual(['eth-rest']);
  });
});

// ── unsubscribe on unmount ────────────────────────────────────────────────────

describe('useRecentTrades — lifecycle', () => {
  it('unsubscribes on unmount', () => {
    fake.fetchMock.mockResolvedValueOnce([]);

    const { unmount } = renderHook(() => useRecentTrades(10), { wrapper: makeBitmexWrapper(fake) });

    expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0);

    unmount();

    expect(fake.subscriberCount('trade:XBTUSD')).toBe(0);
  });
});
