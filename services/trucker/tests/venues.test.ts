import { afterEach, describe, expect, it, vi } from 'vitest';
import { VENUE_NAMES, venueFor } from '../src/venues';
import { _test_dateOf as binanceDate, _test_prefixOf } from '../src/venues/binance';
import { binance as binanceVenue } from '../src/venues/binance';
import { bitget, _test_resetCache as bitgetReset } from '../src/venues/bitget';
import { ARCHIVED_FUTURES, ARCHIVED_SPOT } from '../src/venues/bitget.symbols';
import { _test_dateOf as bybitDate } from '../src/venues/bybit';
import { gate, _test_resetCache as gateResetCache } from '../src/venues/gate';
import { htx } from '../src/venues/htx';
import { kucoin } from '../src/venues/kucoin';
import { _test_stemOf as okxStem } from '../src/venues/okx';

describe('venue registry', () => {
  it('registers every implemented venue', () => {
    expect([...VENUE_NAMES].sort()).toEqual(['binance', 'bitget', 'bybit', 'gate', 'htx', 'kucoin', 'okx']);
  });

  it('throws for an unknown venue, naming the ones that exist', () => {
    expect(() => venueFor('mexc')).toThrow(/Unknown venue 'mexc'/);
  });

  it('gives every venue at least one dataset with a stable id', () => {
    for (const name of VENUE_NAMES) {
      const v = venueFor(name);

      expect(v.datasets.length).toBeGreaterThan(0);

      for (const d of v.datasets) {
        expect(d.id).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(d.path).toBeTruthy();
        expect(d.market).toBeTruthy();
      }
    }
  });

  /**
   * The floor replaced a single shared `EARLIEST` that no venue's archive
   * justified. Every value is measured or bisected against its venue, so the
   * test that matters is that one exists and is a real month — a venue added
   * without one silently walks from wherever the next author guessed.
   */
  it('gives every venue an archive floor of its own', () => {
    for (const name of VENUE_NAMES) {
      const { floor } = venueFor(name);

      expect(floor).toMatch(/^\d{4}(0[1-9]|1[0-2])$/);
      expect(floor >= '201401' && floor <= '210001').toBe(true);
    }
  });

  /**
   * `constructsUrls` decides whether the ranges ledger is written and read at
   * all, so mislabelling a venue is what lets months close without anything
   * being asked. Pinned to the measured set: gate has no usable listing, while
   * bitget and okx publish portal index endpoints their adapters do not read
   * yet — the day one of them does, this list is what fails.
   */
  it('marks exactly the venues whose URLs are constructed', () => {
    const constructed = [...VENUE_NAMES].filter(name => venueFor(name).constructsUrls);

    expect(constructed.sort()).toEqual(['bitget', 'gate', 'okx']);
  });

  it('does not settle on one floor for every venue', () => {
    const floors = [...VENUE_NAMES].map(name => venueFor(name).floor);

    expect(new Set(floors).size).toBeGreaterThan(1);
  });

  it('keeps dataset ids unique within a venue', () => {
    for (const name of VENUE_NAMES) {
      const ids = venueFor(name).datasets.map(d => d.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('bitget', () => {
  /**
   * Bitget's CDN answers 403 for a missing key — but only ever with S3's
   * AccessDenied document. A 403 with any other body is a real block, and
   * reading it as absent would let the cursor step past every file it covered.
   */
  it('reads only the AccessDenied 403 as absent', () => {
    expect(bitget.classify!(403, '<Error><Code>AccessDenied</Code></Error>')).toBe('absent');
    expect(bitget.classify!(403, 'Blocked by WAF')).toBeNull();
    expect(bitget.classify!(429, '<Code>AccessDenied</Code>')).toBeNull();
  });

  // A day of trades is split into `_001`, `_002`, … with no index saying how
  // many. The chain is how every part is found without guessing a maximum.
  it('chains trade parts and ends the chain on non-trade files', () => {
    const first = { url: 'https://x/trades/SPBL/BTCUSDT/20250101_001.zip',
      path: 'trades/SPBL/BTCUSDT/20250101_001.zip',
      date: '20250101', symbol: 'BTCUSDT', period: 'daily' as const };

    const second = bitget.continuation!(first);

    expect(second!.path).toBe('trades/SPBL/BTCUSDT/20250101_002.zip');
    expect(second!.date).toBe('20250101');

    const third = bitget.continuation!(second!);

    expect(third!.path).toBe('trades/SPBL/BTCUSDT/20250101_003.zip');

    expect(bitget.continuation!({ ...first, path: 'kline/BTCUSDT/SP/20250101.zip' })).toBeNull();
  });
});

/**
 * The cursor becomes the S3 marker on the flat datasets, so a settled symbol
 * costs one page instead of a walk over its whole history. The stems were read
 * off live listings — a wrong one would silently disable the optimisation.
 */
describe('listing markers', () => {
  const emptyPage = `<?xml version="1.0"?><ListBucketResult>` +
    `<Prefix>p/</Prefix><IsTruncated>false</IsTruncated></ListBucketResult>`;

  const urls: string[] = [];

  const stubFetch = (): void => {
    urls.length = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));

      return { ok: true, status: 200, text: async () => emptyPage };
    }));
  };

  afterEach(() => vi.unstubAllGlobals());

  it('kucoin: marks flat datasets from the cursor, never the nested ones', async () => {
    stubFetch();

    const trades = kucoin.datasets.find(d => d.id === 'spot-trades')!;

    await kucoin.files(trades, 'BTCUSDT', '20260101');

    expect(urls[0]).toContain(
      'marker=data/spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-01-01');

    stubFetch();

    const klines = kucoin.datasets.find(d => d.id === 'spot-klines')!;

    await kucoin.files(klines, 'BTCUSDT', '20260101');

    expect(urls[0]).not.toContain('marker=');
  });

  it('htx: uses the verified filename stems, which differ from the paths', async () => {
    stubFetch();

    const funding = htx.datasets.find(d => d.id === 'futures-fundingRates')!;

    await htx.files(funding, 'BTC-USDT-PERP', '20260101');

    expect(urls[0]).toContain(
      'marker=historical_data/futures/daily/funding-rates/BTC-USDT-PERP/' +
      'BTC-USDT-PERP-fundingRates-2026-01-01');

    stubFetch();

    const book = htx.datasets.find(d => d.id === 'spot-orderbook')!;

    await htx.files(book, 'BTC-USDT', '20260101');

    expect(urls[0]).toContain('BTC-USDT-l2orderbook-400lv-2026-01-01');

    stubFetch();

    const klines = htx.datasets.find(d => d.id === 'spot-klines')!;

    await htx.files(klines, 'BTC-USDT', '20260101');

    expect(urls[0]).not.toContain('marker=');
  });
});

// Period parsing is what the cursor compares, so a wrong parse silently
// re-downloads history or skips it.
describe('period parsing', () => {
  it('binance: reads the date out of a key', () => {
    expect(binanceDate('data/spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-07-24.zip')).toBe('20260724');
    expect(binanceDate('data/spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-07-24.zip.CHECKSUM')).toBe('');
  });

  it('binance: builds the prefix for each market and period', () => {
    expect(_test_prefixOf(
      { id: 'spot-trades', kind: 'trades', market: 'spot', path: 'trades' }, 'daily',
    )).toBe('data/spot/daily/trades/');

    expect(_test_prefixOf(
      { id: 'um-aggTrades', kind: 'trades', market: 'futures/um', path: 'aggTrades' }, 'monthly',
    )).toBe('data/futures/um/monthly/aggTrades/');
  });

  it('binance: reads a monthly key as a month', () => {
    expect(binanceDate('data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2017-08.zip')).toBe('201708');
  });

  // Bybit's three observed filename shapes, all of which appear in live listings.
  it('bybit: handles every filename shape it publishes', () => {
    expect(bybitDate('BTCUSDT2026-07-25.csv.gz')).toBe('20260725');   // perp
    expect(bybitDate('BTCUSDT_2026-07-25.csv.gz')).toBe('20260725');  // spot, daily
    expect(bybitDate('BTCUSDT-2022-11.csv.gz')).toBe('202211');       // spot, early monthly
    expect(bybitDate('logo.svg')).toBe('');
  });

  it('reads a date that is not at the end of the name', () => {
    // The index series suffix the series name after the date. Anchoring on the
    // extension discarded every one of them, so both datasets listed hundreds
    // of files and collected none.
    expect(bybitDate('BTCUSD2019-10-01_premium_index.csv.gz')).toBe('20191001');
    expect(bybitDate('BTCUSD2019-10-01_index_price.csv.gz')).toBe('20191001');
  });

  it('keys a range by its end, so a period settles once fully covered', () => {
    expect(bybitDate('BTCUSDT_15_2023-01-01_2023-01-31.csv.gz')).toBe('20230131');
  });
});

describe('okx dated futures', () => {
  const dataset = (market: string) => ({ id: 'x', kind: 'trades' as const, market, path: 'trades' });

  it('marks a chained symbol, because the unmarked name is a different series', () => {
    // `BTC-USD-trades-…` answers 200 with rows for an instrument literally
    // called BTC-USD, so omitting the marker collects the wrong data silently
    // rather than failing.
    expect(okxStem(dataset('FUTURES'), 'BTC-USD')).toBe('BTC-USD-futureschain');
  });

  it('leaves the symbol of every other market alone', () => {
    expect(okxStem(dataset('SWAP'), 'BTC-USD-SWAP')).toBe('BTC-USD-SWAP');
    expect(okxStem(dataset('SPOT'), 'BTC-USDT')).toBe('BTC-USDT');
  });
});

/**
 * Gate publishes no archive listing, so every month back to the floor is
 * constructed and probed. The listing date is what keeps that affordable: 856
 * of its 867 USDT contracts began after 2019, and under a 2019 ceiling every
 * probe below the listing date is a guaranteed 404.
 */
describe('gate listing floors', () => {
  /**
   * Two endpoints: gate's API for what trades now, and the download portal for
   * the names it no longer lists. `portal` null makes the portal refuse, which
   * must not stop the pass.
   */
  const stub = (payload: unknown, portal: Record<string, string[]> | null = {}): void => {
    gateResetCache();

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('market_symbols')) {
        if (! portal) return { ok: false, status: 403, json: async () => ({}) };

        return { ok: true, status: 200, json: async () => ({ data: portal }) };
      }

      return { ok: true, status: 200, json: async () => payload };
    }));
  };

  const dataset = (id: string) => gate.datasets.find(d => d.id === id)!;

  afterEach(() => { vi.unstubAllGlobals(); gateResetCache(); });

  it('starts a futures symbol at the month it listed, not the archive floor', async () => {
    stub([{ name: 'ZJINNOLIGHT_USDT', launch_time: Date.parse('2025-09-17T00:00:00Z') / 1000 }]);

    const files = await gate.files(dataset('futures_usdt-trades'), 'ZJINNOLIGHT_USDT', null);

    expect(files[0]!.path).toContain('/202509/');
  });

  it('falls back to the archive floor when a market populates no stamp', async () => {
    stub([{ name: 'OLD_USDT' }]);

    const files = await gate.files(dataset('futures_usdt-trades'), 'OLD_USDT', null);

    expect(files[0]!.path).toContain('/201801/');
  });

  /**
   * Gate's two spot stamps disagree often enough to matter — `PEIPEI_USDT`
   * reads 2024-06-14 to buy and 2020-12-07 to sell. Too early only costs
   * probes; too late silently skips data that exists.
   */
  it('takes the earliest stamp a spot pair populates', async () => {
    stub([{
      id:         'PEIPEI_USDT',
      buy_start:  Date.parse('2024-06-14T00:00:00Z') / 1000,
      sell_start: Date.parse('2020-12-07T00:00:00Z') / 1000,
    }]);

    const files = await gate.files(dataset('spot-deals'), 'PEIPEI_USDT', null);

    expect(files[0]!.path).toContain('/202012/');
  });

  it('never starts a book before the book archive itself begins', async () => {
    stub([{ id: 'OLD_USDT', buy_start: Date.parse('2018-03-01T00:00:00Z') / 1000 }]);

    const files = await gate.files(dataset('spot-orderbooks'), 'OLD_USDT', null);

    expect(files[0]!.date).toBe('20210801');
  });

  it('enumerates symbols from the same answer, so a sweep asks once per market', async () => {
    stub([{ name: 'B_USDT' }, { name: 'A_USDT' }]);

    expect(await gate.symbols(dataset('futures_usdt-trades'))).toEqual(['A_USDT', 'B_USDT']);

    // Two endpoints per market: the API for what trades and its listing dates,
    // the portal for the names it has forgotten. Both cached together.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    await gate.files(dataset('futures_usdt-trades'), 'A_USDT', null);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  /**
   * Delisted pairs are absent from the API and their files are still served, so
   * the name is the only thing standing between us and the history.
   */
  it('adds the portal names the API has forgotten, walked from the floor', async () => {
    stub([{ name: 'LIVE_USDT', launch_time: Date.parse('2022-01-01T00:00:00Z') / 1000 }],
      { futures_usdt: ['live_usdt', 'dead_usdt'] });

    expect(await gate.symbols(dataset('futures_usdt-trades'))).toEqual(['DEAD_USDT', 'LIVE_USDT']);

    const files = await gate.files(dataset('futures_usdt-trades'), 'DEAD_USDT', null);

    expect(files[0]!.path).toContain('/201801/');
  });

  /** The live catalogue is already in hand, so a portal failure is not fatal. */
  it('keeps collecting the living when the portal refuses', async () => {
    stub([{ name: 'LIVE_USDT' }], null);

    expect(await gate.symbols(dataset('futures_usdt-trades'))).toEqual(['LIVE_USDT']);
  });
});

/**
 * Bitget's archive reaches back to 2018 under a filename shape no template can
 * build, and the only thing that knows those names is the portal's own
 * undocumented list call. It is used as narrowly as possible: below the shape
 * change, spot only, bounded by the month the walk asked about.
 */
describe('bitget legacy era', () => {
  const rows = (dates: string[], name = (d: string) => `BTCUSDT_SPBL_${d}_001.zip`) =>
    dates.flatMap(date => Array.from({ length: 4 }, () => ({
      dateTimeStr: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      displayName: 'BTC/USDT',
      fileName:    'BTC/USDT.zip',
      fileUrl:     `https://img.bitgetimg.com/online/trades/SPBL/BTCUSDT/${name(date)}`,
    })));

  const calls: { url: string; body: Record<string, unknown> }[] = [];

  const stub = (data: unknown[]): void => {
    bitgetReset();
    calls.length = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });

      if (String(url).includes('api.bitget.com'))
        return { ok: true, status: 200, json: async () => ({
          data: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT',
            openTime: String(Date.parse('2018-07-24T16:40:00Z')) }],
        }) };

      return { ok: true, status: 200, json: async () => ({ code: '200', data }) };
    }));
  };

  const trades = bitget.datasets.find(d => d.id === 'spot-trades')!;
  const index  = () => calls.filter(c => c.url.includes('getPublicDataV2'));

  afterEach(() => { vi.unstubAllGlobals(); bitgetReset(); });

  it('takes the index filenames verbatim, since they cannot be constructed', async () => {
    stub(rows(['20180725']));

    const files = await bitget.files(trades, 'BTCUSDT', null, '20180731');

    expect(files[0]!.url)
      .toBe('https://img.bitgetimg.com/online/trades/SPBL/BTCUSDT/BTCUSDT_SPBL_20180725_001.zip');
    expect(files[0]!.path).toBe('trades/SPBL/BTCUSDT/BTCUSDT_SPBL_20180725_001.zip');
  });

  /** Every file comes back four times; downloading each four times would follow. */
  it('deduplicates the repeated rows', async () => {
    stub(rows(['20180725', '20180727']));

    const files = await bitget.files(trades, 'BTCUSDT', null, '20180731');

    expect(files.map(f => f.date)).toEqual(['20180725', '20180727']);
  });

  /** The index refuses a window wider than a week, so a month is five queries. */
  it('asks in seven-day windows, and only about the month walked', async () => {
    stub([]);

    await bitget.files(trades, 'BTCUSDT', null, '20180731');

    expect(index()).toHaveLength(1);   // 2018-07-25 → 07-31 is one window
    expect(index()[0]!.body).toMatchObject({
      businessLine: 1, businessType: 2, dateType: 1,
      beginTimeStr: '2018-07-25', endTimeStr: '2018-07-31',
    });

    // The symbol asked for leads; the rest of the batch is whoever the walk
    // reaches next, which includes the delisted names the seed supplies.
    expect((index()[0]!.body as { displaySymbol: string[] }).displaySymbol[0]).toBe('BTC/USDT');
  });

  it('splits a month into weekly windows, and asks about no more than that', async () => {
    stub([]);

    await bitget.files(trades, 'BTCUSDT', null, '20180820');

    // August only: July was walked before it, and re-asking costs a request a
    // week to be told what the previous month already answered.
    expect(index()).toHaveLength(3);
    expect(index()[0]!.body).toMatchObject({ beginTimeStr: '2018-08-01' });
    expect(index()[2]!.body).toMatchObject({ endTimeStr: '2018-08-20' });
  });

  /**
   * Above the shape change the URLs are buildable, so the index is not touched
   * at all — the modern era costs exactly what it did before.
   */
  it('never asks the index for dates it can construct', async () => {
    stub([]);

    const files = await bitget.files(trades, 'BTCUSDT', '20250101', '20250103');

    expect(index()).toHaveLength(0);
    expect(files.map(f => f.path)).toEqual([
      'trades/SPBL/BTCUSDT/20250102_001.zip',
      'trades/SPBL/BTCUSDT/20250103_001.zip',
    ]);
  });

  it('never asks the index for a market whose symbol form is unknown', async () => {
    stub([]);

    const futures = bitget.datasets.find(d => d.id === 'umcbl-trades')!;

    await bitget.files(futures, 'BTCUSDT', null, '20180731');

    expect(index()).toHaveLength(0);
  });

  /** A URL outside the CDN root has no home under the venue's directory. */
  it('drops a row it cannot store', async () => {
    stub(rows(['20180725'], () => '../elsewhere.zip')
      .map(r => ({ ...r, fileUrl: 'https://elsewhere.example/x.zip' })));

    expect(await bitget.files(trades, 'BTCUSDT', null, '20180731')).toEqual([]);
  });
});

/**
 * Futures are a second catalogue to the index, with its own symbol spelling and
 * its own floor — and one path quirk that made a whole dataset look dead.
 */
describe('bitget futures', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  const stub = (rows: unknown[]): void => {
    bitgetReset();
    calls.length = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });

      if (String(url).includes('api.bitget.com'))
        return { ok: true, status: 200, json: async () => ({
          data: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT',
            openTime: String(Date.parse('2019-01-01T00:00:00Z')) },
          { symbol: 'BTCUSD', baseCoin: 'BTC', quoteCoin: 'USD',
            openTime: String(Date.parse('2019-01-01T00:00:00Z')) }],
        }) };

      return { ok: true, status: 200, json: async () => ({ code: '200', data: rows }) };
    }));
  };

  const row = (url: string, who = 'BTCUSDT') => ({
    dateTimeStr: '2022-06-01', displayName: who, fileName: 'x.zip',
    fileUrl: `https://img.bitgetimg.com/online/${url}`,
  });

  const index = () => calls.filter(c => c.url.includes('getPublicDataV2'));
  const of    = (id: string) => bitget.datasets.find(d => d.id === id)!;

  afterEach(() => { vi.unstubAllGlobals(); bitgetReset(); });

  /** Spot answers to `BTC/USDT`, futures to `BTCUSDT`; the wrong one returns nothing. */
  it('asks the futures catalogue by its own symbol spelling', async () => {
    stub([]);

    await bitget.files(of('umcbl-trades'), 'BTCUSDT', null, '20220607');

    expect(index()[0]!.body).toMatchObject({ businessLine: 2 });
    expect((index()[0]!.body as { displaySymbol: string[] }).displaySymbol[0]).toBe('BTCUSDT');

    stub([]);

    await bitget.files(of('spot-trades'), 'BTCUSDT', null, '20220607');

    expect(index()[0]!.body).toMatchObject({ businessLine: 1 });
    expect((index()[0]!.body as { displaySymbol: string[] }).displaySymbol[0]).toBe('BTC/USDT');
  });

  /**
   * One futures query answers for both margin types, so the reply is filtered
   * by what each key says it is — otherwise a coin-margined file is stored in
   * the USDT tree and read as USDT data for ever.
   */
  it('keeps only the rows whose path belongs to the dataset asked about', async () => {
    stub([
      row('trades/UMCBL/BTCUSDT/BTCUSDT_UMCBL_20220601_001.zip'),
      row('trades/DMCBL/BTCUSD/BTCUSD_DMCBL_20220601_001.zip', 'BTCUSDT'),
    ]);

    const files = await bitget.files(of('umcbl-trades'), 'BTCUSDT', null, '20220607');

    expect(files.map(f => f.path)).toEqual(['trades/UMCBL/BTCUSDT/BTCUSDT_UMCBL_20220601_001.zip']);
  });

  /**
   * Coin-margined klines live under the `UMCBL` token — `kline/BTCUSD/UMCBL/…`
   * serves 200 where the `DMCBL` spelling answers 403. Probing the obvious path
   * is why this dataset read as "publishes nothing" across 55 probes.
   */
  it('files coin-margined klines under the UMCBL token, where they actually live', async () => {
    stub([]);

    const files = await bitget.files(of('dmcbl-klines'), 'BTCUSD', '20250601', '20250602');

    expect(files.map(f => f.path)).toEqual(['kline/BTCUSD/UMCBL/20250602.zip']);
  });

  it('still separates the two margin types for trades, which do use their own token', async () => {
    stub([]);

    const files = await bitget.files(of('dmcbl-trades'), 'BTCUSD', '20250601', '20250602');

    expect(files.map(f => f.path)).toEqual(['trades/DMCBL/BTCUSD/20250602_001.zip']);
  });

  /** Futures publish from 2019, so windows below that are never asked for. */
  it('does not ask the index below the futures floor', async () => {
    stub([]);

    await bitget.files(of('umcbl-klines'), 'BTCUSDT', null, '20190131');

    expect(index()).toHaveLength(0);
  });
});

/**
 * The index charges per week asked about, so the question has to be narrowed to
 * the month being settled. Without a lower bound a symbol that has collected
 * nothing yet is asked about its entire history again on every month walked.
 */
describe('bitget index windows stay bounded', () => {
  const calls: Record<string, unknown>[] = [];

  const stub = (): void => {
    bitgetReset();
    calls.length = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('api.bitget.com'))
        return { ok: true, status: 200, json: async () => ({
          data: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT',
            openTime: String(Date.parse('2018-07-24T16:40:00Z')) }],
        }) };

      calls.push(JSON.parse(init!.body!));

      return { ok: true, status: 200, json: async () => ({ code: '200', data: [] }) };
    }));
  };

  afterEach(() => { vi.unstubAllGlobals(); bitgetReset(); });

  it('asks only about the month being walked, not back to the floor', async () => {
    stub();

    const trades = bitget.datasets.find(d => d.id === 'spot-trades')!;

    await bitget.files(trades, 'BTCUSDT', null, '20220630');

    expect(calls).toHaveLength(5);                       // 30 days, seven at a time
    expect(calls[0]).toMatchObject({ beginTimeStr: '2022-06-01' });
    expect(calls[4]).toMatchObject({ endTimeStr: '2022-06-30' });
  });

  it('still starts at the symbol floor for the first month of the archive', async () => {
    stub();

    const trades = bitget.datasets.find(d => d.id === 'spot-trades')!;

    await bitget.files(trades, 'BTCUSDT', null, '20180731');

    expect(calls[0]).toMatchObject({ beginTimeStr: '2018-07-25' });
  });
});

/**
 * The kline family nests an interval below the symbol, where a symbol-level
 * marker sorts past every interval directory and skips the lot. Each interval
 * is therefore marked in its own right — the difference between one page and
 * the ~87 a binance kline symbol takes unmarked.
 */
describe('nested listings are marked per interval', () => {
  const urls: string[] = [];

  const page = (body: string) =>
    `<?xml version="1.0"?><ListBucketResult><Prefix>p/</Prefix>` +
    `<IsTruncated>false</IsTruncated>${body}</ListBucketResult>`;

  const stubFetch = (intervals: string[]): void => {
    urls.length = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));

      const body = String(url).includes('delimiter=/')
        ? intervals.map(i => `<CommonPrefixes><Prefix>${prefixFor(url)}${i}/</Prefix></CommonPrefixes>`).join('')
        : '';

      return { ok: true, status: 200, text: async () => page(body) };
    }));
  };

  const prefixFor = (url: string) => String(url).replace(/.*[?&]prefix=([^&]*).*/, '$1');

  afterEach(() => vi.unstubAllGlobals());

  it('binance: asks which intervals exist, then marks each from the cursor', async () => {
    stubFetch(['1h', '4h']);

    const klines = binanceVenue.datasets.find(d => d.id === 'spot-klines')!;

    await binanceVenue.files(klines, 'BTCUSDT', '20260101');

    const marked = urls.filter(u => u.includes('marker='));

    expect(urls.some(u => u.includes('delimiter=/'))).toBe(true);
    expect(marked).toHaveLength(2);
    expect(marked[0]).toContain('marker=data/spot/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-01-01');
    expect(marked[1]).toContain('marker=data/spot/daily/klines/BTCUSDT/4h/BTCUSDT-4h-2026-01-01');
  });

  /** Flat datasets keep the single symbol-level marker they always had. */
  it('binance: leaves the flat datasets marking the symbol itself', async () => {
    stubFetch([]);

    const trades = binanceVenue.datasets.find(d => d.id === 'spot-trades')!;

    await binanceVenue.files(trades, 'BTCUSDT', '20260101');

    expect(urls.some(u => u.includes('delimiter=/'))).toBe(false);
    expect(urls.some(u => u.includes('marker=data/spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-01-01')))
      .toBe(true);
  });

  it('kucoin: marks its verified kline shape, and lists the rest per interval unmarked', async () => {
    stubFetch(['1d']);

    await kucoin.files(kucoin.datasets.find(d => d.id === 'spot-klines')!, 'BTCUSDT', '20260101');

    expect(urls.some(u => u.includes('marker=data/spot/daily/klines/BTCUSDT/1d/BTCUSDT-1d-2026-01-01')))
      .toBe(true);

    stubFetch(['1d']);

    await kucoin.files(kucoin.datasets.find(d => d.id === 'futures-mark')!, 'XBTUSDTM', '20260101');

    // The mark family's filename shape was never read off a listing, so the
    // interval is listed whole rather than marked from a guess.
    expect(urls.some(u => u.includes('marker='))).toBe(false);
    expect(urls.filter(u => ! u.includes('delimiter=/'))).toHaveLength(1);
  });

  /** A venue that adds an interval must be picked up without a code change. */
  it('reads the intervals from the venue rather than a declared list', async () => {
    stubFetch(['1h', '4h', '8h']);

    const klines = binanceVenue.datasets.find(d => d.id === 'spot-klines')!;

    await binanceVenue.files(klines, 'BTCUSDT', '20260101');

    expect(urls.filter(u => u.includes('marker='))).toHaveLength(3);
  });
});

/**
 * A query costs the same whether it names one symbol or five, and the 7-day cap
 * is fixed — so batching is the only lever on the backfill's request count.
 * One symbol per call is ~1.1M requests for bitget's history; five is ~220k.
 */
describe('bitget batches its index queries', () => {
  const asked: string[][] = [];

  const stub = (rows: (sym: string) => unknown[] = () => []): void => {
    bitgetReset();
    asked.length = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('api.bitget.com'))
        return { ok: true, status: 200, json: async () => ({
          data: ['ZZZZAUSDT', 'ZZZZBUSDT', 'ZZZZCUSDT', 'ZZZZDUSDT', 'ZZZZEUSDT', 'ZZZZFUSDT'].map(symbol => ({
            symbol, baseCoin: symbol.replace('USDT', ''), quoteCoin: 'USDT',
            openTime: String(Date.parse('2019-01-01T00:00:00Z')),
          })),
        }) };

      const body = JSON.parse(init!.body!) as { displaySymbol: string[] };

      asked.push(body.displaySymbol);

      return { ok: true, status: 200,
        json: async () => ({ code: '200', data: body.displaySymbol.flatMap(rows) }) };
    }));
  };

  const trades = () => bitget.datasets.find(d => d.id === 'spot-trades')!;

  afterEach(() => { vi.unstubAllGlobals(); bitgetReset(); });

  it('names five symbols per call — the one asked for, plus the four coming next', async () => {
    stub();

    await bitget.files(trades(), 'ZZZZAUSDT', null, '20220607');

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(['ZZZZA/USDT', 'ZZZZB/USDT', 'ZZZZC/USDT', 'ZZZZD/USDT', 'ZZZZE/USDT']);
  });

  /** The next four symbols the walk reaches are already answered. */
  it('asks nothing more for the symbols that came in the same batch', async () => {
    stub();

    for (const symbol of ['ZZZZAUSDT', 'ZZZZBUSDT', 'ZZZZCUSDT', 'ZZZZDUSDT', 'ZZZZEUSDT'])
      await bitget.files(trades(), symbol, null, '20220607');

    expect(asked).toHaveLength(1);
  });

  it('keeps each symbol only its own rows', async () => {
    stub(sym => [{
      dateTimeStr: '2022-06-01', displayName: sym, fileName: 'x.zip',
      fileUrl: `https://img.bitgetimg.com/online/trades/SPBL/${sym.replace('/', '')}/x_001.zip`,
    }]);

    const a = await bitget.files(trades(), 'ZZZZAUSDT', null, '20220607');
    const b = await bitget.files(trades(), 'ZZZZBUSDT', null, '20220607');

    expect(a.map(f => f.path)).toEqual(['trades/SPBL/ZZZZAUSDT/x_001.zip']);
    expect(b.map(f => f.path)).toEqual(['trades/SPBL/ZZZZBUSDT/x_001.zip']);
  });

  /** A symbol the reply never mentions has nothing, and is not asked again. */
  it('remembers that a symbol returned nothing', async () => {
    stub();

    await bitget.files(trades(), 'ZZZZAUSDT', null, '20220607');
    await bitget.files(trades(), 'ZZZZCUSDT', null, '20220607');

    expect(asked).toHaveLength(1);
  });
});

/**
 * Gate's quirks, each of which cost real data or real time to find. A future
 * reader who thinks any of these looks arbitrary should read the test name
 * before removing it.
 */
describe('gate nuances', () => {
  const stubGate = (payload: unknown, portal: Record<string, string[]> = {}): void => {
    gateResetCache();

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('tradfi-api'))
        return { ok: true, status: 200,
          json: async () => ({ data: { list: [{ symbol: 'XAUUSD' }, { symbol: 'NAS100' }] } }) };

      if (String(url).includes('market_symbols'))
        return { ok: true, status: 200, json: async () => ({ data: portal }) };

      return { ok: true, status: 200, json: async () => payload };
    }));
  };

  const of = (id: string) => gate.datasets.find(d => d.id === id)!;

  afterEach(() => { vi.unstubAllGlobals(); gateResetCache(); });

  /**
   * For one month gate served the **spot** file at the futures URL for 85
   * symbols. Read with the futures map it parses fine and every trade reads as
   * a buy, which is how 65 partitions were silently built from it.
   *
   * The files were deleted once by hand; that cleanup survives only while this
   * filter exists, because clearing trucker's ledgers re-walks the month and
   * gate still serves the same bytes.
   */
  it('never offers the 2021-07 futures files that are really spot data', async () => {
    stubGate([{ name: 'ACH_USDT', launch_time: Date.parse('2020-01-01T00:00:00Z') / 1000 }]);

    const files  = await gate.files(of('futures_usdt-trades'), 'ACH_USDT', '20210630', '20210930');
    const months = files.map(f => f.date.slice(0, 6));

    expect(months).not.toContain('202107');
    expect(months).toContain('202108');
  });

  it('excludes only that month, that dataset, those symbols', async () => {
    stubGate([{ name: 'BTC_USDT', launch_time: Date.parse('2019-01-01T00:00:00Z') / 1000 }]);

    // BTC_USDT is not one of the 85.
    const trades = await gate.files(of('futures_usdt-trades'), 'BTC_USDT', '20210630', '20210930');

    expect(trades.map(f => f.date.slice(0, 6))).toContain('202107');

    stubGate([{ name: 'ACH_USDT', launch_time: Date.parse('2020-01-01T00:00:00Z') / 1000 }]);

    // Klines of an excluded symbol are untouched — only its trades were wrong.
    const klines = await gate.files(of('futures_usdt-candlesticks_1h'), 'ACH_USDT', '20210630', '20210930');

    expect(klines.map(f => f.date.slice(0, 6))).toContain('202107');
  });

  /**
   * Spot's 30s, 1m and 5m are generated **per day**; everything else per month.
   * A monthly URL for a daily interval answers NoSuchKey — which is why spot
   * candlesticks were twice concluded not to exist at all.
   */
  it('builds daily files for spot 30s/1m/5m and monthly for the rest', async () => {
    stubGate([{ id: 'BTC_USDT', buy_start: Date.parse('2019-01-01T00:00:00Z') / 1000 }]);

    const daily = await gate.files(of('spot-candlesticks_1m'), 'BTC_USDT', '20260630', '20260702');

    expect(daily[0]!.path).toBe('spot/candlesticks_1m/202607/BTC_USDT-20260701.csv.gz');
    expect(daily[0]!.period).toBe('daily');

    const monthly = await gate.files(of('spot-candlesticks_1h'), 'BTC_USDT', '20240630', '20240831');

    expect(monthly[0]!.path).toBe('spot/candlesticks_1h/202407/BTC_USDT-202407.csv.gz');
    expect(monthly[0]!.period).toBe('monthly');
  });

  /** TradFi has its own catalogue, its own floor, and candlesticks only. */
  it('gives TradFi its own symbols and its own 2024 floor', async () => {
    stubGate([]);

    expect(await gate.symbols(of('tradfi-candlesticks_1h'))).toEqual(['NAS100', 'XAUUSD']);

    const files = await gate.files(of('tradfi-candlesticks_1h'), 'XAUUSD', null, '20240331');

    // 2023 is 404 at every month tried; the crypto floor of 2018 would burn
    // six years of probes on dates that cannot exist.
    expect(files[0]!.path).toBe('tradfi/candlesticks_1h/202401/XAUUSD-202401.csv.gz');
  });

  it('publishes nothing but candlesticks for TradFi', () => {
    const tradfi = gate.datasets.filter(d => d.market === 'tradfi');

    expect(tradfi.length).toBeGreaterThan(0);
    expect(tradfi.every(d => d.kind === 'klines')).toBe(true);
  });
});

/**
 * Bitget's delisted symbols exist only in the seed: no version of its
 * instruments API lists them, while their files are still served. The seed is
 * versioned code precisely because it cannot be rebuilt from anything trucker
 * holds — losing it loses history that no request can ask for again.
 */
describe('bitget seeded symbols', () => {
  const stub = (): void => {
    bitgetReset();

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('api.bitget.com'))
        return { ok: true, status: 200, json: async () => ({
          data: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT',
            openTime: String(Date.parse('2020-01-01T00:00:00Z')) }],
        }) };

      return { ok: true, status: 200, json: async () => ({ code: '200', data: [] }) };
    }));
  };

  afterEach(() => { vi.unstubAllGlobals(); bitgetReset(); });

  it('offers names the API has forgotten, alongside the ones it still lists', async () => {
    stub();

    const symbols = await bitget.symbols(bitget.datasets.find(d => d.id === 'spot-trades')!);

    // `BARUSDT` is delisted: absent from the v2 and v3 instruments endpoints,
    // still served by the CDN, and present in the seed.
    expect(symbols).toContain('BARUSDT');
    expect(symbols).toContain('BTCUSDT');
    // The stub's API answers with one symbol, so everything else is the seed.
    expect(symbols.length).toBeGreaterThanOrEqual(ARCHIVED_SPOT.length);
  });

  it('keeps the seed big enough to be the real catalogue, not a stub', () => {
    // A seed emptied by a bad regeneration would still typecheck and still
    // pass every other test — it would just quietly stop collecting the dead.
    expect(ARCHIVED_SPOT.length).toBeGreaterThan(1500);
    expect(ARCHIVED_FUTURES.length).toBeGreaterThan(1000);
    expect(ARCHIVED_SPOT).toContain('BAR/USDT');
  });
});
