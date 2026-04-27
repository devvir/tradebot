import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchSymbols } from '../src/utils/symbols';

const BASE_URL = 'https://www.bitmex.com/api/v1';

const makeResponse = (data: unknown, ok = true, status = 200): Response => {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
  } as unknown as Response;
};

describe('fetchSymbols', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('separates index symbols (starting with ".") from the rest', async () => {
    const instruments = [
      { symbol: 'XBTUSD',   state: 'Open'    },
      { symbol: '.BXBT',    state: 'Settled' },
      { symbol: '.BETHXBT', state: 'Open'    },
      { symbol: 'ETHUSD',   state: 'Open'    },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(instruments));

    const result = await fetchSymbols(BASE_URL);

    expect(result.indices).toEqual(['.BXBT', '.BETHXBT']);
  });

  it('reports inactive (non-Open) symbols in a separate set', async () => {
    const instruments = [
      { symbol: 'XBTUSD',        state: 'Open'     },
      { symbol: 'OLDINSTR',      state: 'Unlisted' },
      { symbol: 'SETTLEDINSTR',  state: 'Settled'  },
      { symbol: '.BXBT',         state: 'Open'     },
      { symbol: '.OLDIDX',       state: 'Unlisted' },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(instruments));

    const result = await fetchSymbols(BASE_URL);

    expect(result.inactive).toBeInstanceOf(Set);
    expect(result.inactive.has('OLDINSTR')).toBe(true);
    expect(result.inactive.has('SETTLEDINSTR')).toBe(true);
    expect(result.inactive.has('.OLDIDX')).toBe(true);
    expect(result.inactive.has('XBTUSD')).toBe(false);
    expect(result.inactive.has('.BXBT')).toBe(false);
  });

  it('calls the correct endpoint URL', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse([]));

    await fetchSymbols(BASE_URL);

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/instrument?count=1000&start=0&columns=symbol,state&reverse=false`
    );
  });

  it('paginates until a partial page is returned', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ symbol: `SYM${i}`, state: 'Open' }));
    const page2 = [{ symbol: 'LAST', state: 'Open' }];

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(makeResponse(page1))
      .mockResolvedValueOnce(makeResponse(page2));

    await fetchSymbols(BASE_URL);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${BASE_URL}/instrument?count=1000&start=1000&columns=symbol,state&reverse=false`
    );
  });
});
