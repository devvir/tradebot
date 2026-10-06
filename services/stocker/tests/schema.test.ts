import { describe, expect, it } from 'vitest';
import { parseKey } from '../src/keys';
import { marginOf } from '../src/schema/margin';
import { SERIES, extrasOf, seriesFor, seriesOf } from '../src/schema/series';
import { _test_fractionCols, _test_integralCols, _test_microsOf, _test_projectionFor as projectionFor, selectFor } from '../src/schema/project';
import { fieldsOf } from '../src/schema/tables';
import type { ArchiveFile, Series } from '../src/types';

/** A catalog file, as its key names it. */
const file = (key: string): ArchiveFile => {
  const parsed = parseKey(key);

  if (! parsed) throw new Error(`not a key: ${key}`);

  return parsed;
};

describe('the series map', () => {
  /**
   * **Which levels a dataset carries is a property of the table, not of the
   * venue.** Funding always carries its kind, so a venue publishing only
   * realised funding still files it under `kind=realised`.
   */
  it('gives every funding series a kind, from the catalog variant', () => {
    const funding = SERIES.filter(series => series.table === 'funding');

    expect(funding.length).toBeGreaterThan(0);

    for (const series of funding) {
      expect(series.variant, `${series.venue} funding has no variant`).toBeTruthy();
      expect(extrasOf(series, series.variant!).kind).toBe(series.variant);
    }
  });

  /** An attribute lives in the file or in the path, never both. */
  it('never projects a path attribute as a column as well', () => {
    for (const series of SERIES)
      expect(Object.keys(series.project), `${series.venue} ${series.table}`)
        .not.toContain('kind');

    expect(fieldsOf('funding').map(f => f.name)).not.toContain('kind');
  });

  it('resolves a catalog key to a series, and its variant to the path levels', () => {
    const trades = seriesFor(file('binance/spot/trades/B/BTCUSDT/202606/binance|spot|trades|BTCUSDT|202606.zip'));

    expect(trades?.table).toBe('trades');
    // Every trade as it happened, said outright; a venue's aggregation of them is another slice.
    expect(extrasOf(trades!, '')).toEqual({ aggregated: 'false' });
    expect(extrasOf(trades!, 'aggregated')).toEqual({ aggregated: 'true' });

    const klines = seriesFor(file('htx/spot/klines,5m/_/4-USDT/202606/htx|spot|klines,5m|4-USDT|20260608.zip'));

    expect(klines?.table).toBe('klines');
    expect(extrasOf(klines!, '5m')).toEqual({ interval: '5m' });
  });

  /** `ticks` is a stream of point values, not a bar length. */
  it('gives tick datasets no interval', () => {
    const mark = seriesFor(file('gate/perp/markPrice,ticks/B/BTC_USDT/202001/gate|perp|markPrice,ticks|BTC_USDT|202001.csv.gz'));

    expect(mark?.table).toBe('markPrice');
    expect(extrasOf(mark!, 'ticks')).toEqual({});
  });

  /** A venue's aggregation of its trades is trades too, of another kind: its own series, and its own place in the vault. */
  it('reads aggregated trades as a slice of their own', () => {
    const aggregated = seriesFor(file('binance/spot/trades,aggregated/B/BTCUSDT/202607/binance|spot|trades,aggregated|BTCUSDT|20260725.zip'));

    expect(aggregated?.table).toBe('trades');
    expect(extrasOf(aggregated!, 'aggregated')).toEqual({ aggregated: 'true' });
  });

  /** What is not mapped is left alone, never guessed at. */
  it('returns null for a dataset it does not read', () => {
    expect(seriesFor(file('okx/spot/books,400,incremental/B/BTC-USDT/202607/okx|spot|books,400,incremental|BTC-USDT|20260725.tar.gz')))
      .toBeNull();
  });

  /** A headerless file has no other way to know what its columns are. */
  it('declares columns for every headerless series', () => {
    for (const series of SERIES) {
      if (series.header) continue;

      expect(series.columns, `${series.venue}/${series.table}/${series.market}`).toBeDefined();
      expect(series.columns!.length).toBeGreaterThan(0);
    }
  });

  /** The ts column must be one stocker can actually find in the relation. */
  it('names a ts column that the headerless column list contains', () => {
    for (const series of SERIES) {
      if (series.header || ! series.columns) continue;

      const names = series.columns.map(c => c.as).filter(Boolean);

      expect(names, `${series.venue}/${series.table}/${series.market}`).toContain(series.ts);
    }
  });

  /**
   * Two entries claiming one file would read it two ways depending on their
   * order. For every dataset, every margining and both sides of every era, at
   * most one entry may answer.
   */
  it('never lets two entries claim the same file', () => {
    for (const series of SERIES) {
      for (const month of ['2020-06', '2026-01', '2026-02', '2026-07']) {
        for (const margin of ['linear', 'inverse', null]) {
          const claims = seriesOf({ ...series, variant: series.variant === '*' ? '1m' : series.variant ?? '' })
            .filter(one =>
              (! one.margin || one.margin === margin) &&
              (! one.from  || month >= one.from) &&
              (! one.until || month <  one.until));

          expect(claims.length, `${series.venue}/${series.market}/${series.dataset} ${month} ${margin}`)
            .toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('formats chosen inside one dataset', () => {
  /**
   * Binance's USDⓈ-M and COIN-M trades share a partition and a position for
   * their fourth column, which is the quote on one and the base on the other.
   * The instrument's margining is what picks the reading.
   */
  it('reads binance perpetual trades by the instrument\'s margining', () => {
    const linear  = seriesFor(file('binance/perp/trades/B/BTCUSDT/202001/binance|perp|trades|BTCUSDT|20200101.zip'));
    const inverse = seriesFor(file('binance/perp/trades/B/BTCUSD_PERP/202001/binance|perp|trades|BTCUSD_PERP|20200101.zip'));

    expect(linear?.project.quoteSize).toBe('quoteQty');
    expect(inverse?.project.baseSize).toBe('baseQty');
    expect(inverse?.project.quoteSize).toBeUndefined();
  });

  /** HTX's exports are cut flat at 2026-02-01: headerless before, headed from it. */
  it('reads htx by era', () => {
    const before = seriesFor(file('htx/spot/trades/B/BTC-USDT/202601/htx|spot|trades|BTC-USDT|20260131.zip'));
    const after  = seriesFor(file('htx/spot/trades/B/BTC-USDT/202602/htx|spot|trades|BTC-USDT|20260201.zip'));

    expect(before?.header).toBe(false);
    expect(after?.header).toBe(true);
  });

  /** Coin-margined htx contract trades lack the quote turnover the linear ones carry. */
  it('reads htx contract trades of the older era by margining', () => {
    const inverse = seriesFor(file('htx/perp/trades/A/AKRO-USD/202010/htx|perp|trades|AKRO-USD|20201004.zip'));
    const linear  = seriesFor(file('htx/perp/trades/A/AKRO-USDT/202010/htx|perp|trades|AKRO-USDT|20201004.zip'));

    expect(inverse?.columns).toHaveLength(6);
    expect(linear?.columns).toHaveLength(7);
  });
});

describe('venues whose buckets do not cut at UTC midnight', () => {
  /** bitget, okx and htx cut at 16:00 UTC; bybit's MT4 files are UTC+3 months. */
  it('declares a back spill for every bitget, okx and htx series, and for bybit\'s MT4 klines', () => {
    for (const series of SERIES.filter(one => ['bitget', 'okx', 'htx'].includes(one.venue)))
      expect(series.spill, `${series.venue} ${series.market} ${series.dataset}`).toBe('back');

    const mt4 = SERIES.find(one => one.venue === 'bybit' && one.dataset === 'klines');

    expect(mt4).toMatchObject({ spill: 'back', utcOffsetHours: 3 });
  });
});

describe('margining', () => {
  it.each([
    ['binance', 'BTCUSD_PERP', 'inverse'], ['binance', 'BTCUSD_230331', 'inverse'],
    ['binance', 'BTCUSDT', 'linear'], ['binance', 'BTCUSDT_230630', 'linear'],
    ['bybit', 'BTCUSD', 'inverse'], ['bybit', 'BTCUSDZ22', 'inverse'],
    ['bybit', 'BTCUSDT', 'linear'], ['bybit', 'BTCPERP', 'linear'],
    ['gate', 'BTC_USD', 'inverse'], ['gate', 'BTC_USDT', 'linear'], ['gate', 'ADA_USDT_20240301', 'linear'],
    ['kucoin', 'XBTUSDM', 'inverse'], ['kucoin', 'XBTUSDTM', 'linear'], ['kucoin', 'XBTUSDCM', 'linear'],
    ['okx', 'BTC-USD-SWAP', 'inverse'], ['okx', 'BTC-USD', 'inverse'], ['okx', 'BTC-USD-250328', 'inverse'],
    ['okx', 'BTC-USDT-SWAP', 'linear'], ['okx', 'BTC-USD_UM', 'linear'], ['okx', 'AAPL-USD_UM_XPERP', 'linear'],
    ['htx', 'BTC-USD', 'inverse'], ['htx', 'BTC-USD-260529', 'inverse'], ['htx', 'BTC-USDT', 'linear'],
    ['bitget', 'BTCUSD', 'inverse'], ['bitget', 'BTCUSD_CM', 'inverse'], ['bitget', 'BTCCMZ26', 'inverse'],
    ['bitget', 'BTCUSDT', 'linear'], ['bitget', 'ACTUSDC', 'linear'], ['bitget', 'AAVEPERP', 'linear'],
  ] as const)('%s %s is %s', (venue, symbol, margin) => {
    expect(marginOf(venue, 'perp', symbol)).toBe(margin);
  });

  it('gives spot and options none', () => {
    expect(marginOf('binance', 'spot', 'BTCUSD_PERP')).toBeNull();
    expect(marginOf('okx', 'option', 'BTC-USD-250328-50000-C')).toBeNull();
  });
});

describe('projection into the canonical schema', () => {
  const make = (over: Partial<Series>): Series => ({
    venue: 'v', market: 'spot', dataset: 'trades', table: 'trades',
    format: 'csv', header: true, project: {}, ts: 'time', ...over,
  });

  /**
   * Every series emits the table's full column list in the table's order — all
   * but `margin`, which the writer fills per instrument.
   */
  it('emits every canonical column but margin, in order, whatever the venue publishes', () => {
    const sql   = projectionFor(make({ project: { price: 'p' } }));
    const names = fieldsOf('trades').map(f => f.name).filter(name => name !== 'margin');

    for (const name of names) expect(sql).toContain(` AS ${name}`);

    expect(sql).not.toContain(' AS margin');

    const order = names.map(name => sql.indexOf(` AS ${name}`));

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('fills a field the venue does not publish with a typed NULL', () => {
    const sql = projectionFor(make({ project: { price: 'p' } }));

    expect(sql).toContain('CAST(p AS DOUBLE) AS price');
    expect(sql).toContain('CAST(NULL AS VARCHAR) AS side');
  });

  /** A venue writing local datetimes has them moved to UTC by its declared offset. */
  it('moves a declared zone to UTC', () => {
    expect(projectionFor(make({ utcOffsetHours: 3 }))).toContain('- 10800000000');
    expect(projectionFor(make({}))).not.toContain('10800000000');
  });
});

describe('timestamp conversion', () => {
  /**
   * The unit is read from the value, so the expression carries no unit of its
   * own — it must branch on magnitude and must not name one.
   */
  it('decides the unit from the value rather than from a declaration', () => {
    const sql = _test_microsOf();

    expect(sql).toContain('< 100000000000 ');
    expect(sql).toContain('< 100000000000000 ');
    expect(sql).toContain('< 100000000000000000 ');
  });

  /**
   * An epoch in microseconds is a 16-digit integer, right at the edge of what a
   * DOUBLE holds exactly, and DECIMAL is exact but ruinously slow. Fractional
   * values are split into two integers instead.
   */
  it('parses fractional values as integers, never DOUBLE or DECIMAL', () => {
    expect(_test_fractionCols()).toContain('split_part');
    expect(_test_fractionCols()).not.toContain('DECIMAL');
    expect(_test_microsOf()).not.toContain('AS DOUBLE');
    expect(_test_microsOf()).not.toContain('DECIMAL');
  });

  /**
   * DuckDB's VARCHAR→BIGINT cast **rounds** fractional text rather than
   * failing, so the integer fast path must be gated on the text being integral.
   */
  it('takes the integer path only for integral text', () => {
    expect(_test_integralCols('raw')).toContain(`strpos`);
    expect(_test_integralCols('raw')).toContain(`'.'`);
  });

  /** Text that is not a time at all must land as NULL, not as an error. */
  it('falls back to datetime parsing, then to NULL', () => {
    const sql = _test_microsOf();

    expect(sql).toContain('try_strptime');
    expect(_test_integralCols('raw')).toContain('TRY_CAST');
  });

  /**
   * The parse columns the CASE reads must actually be provided by the wrapped
   * relation `selectFor` builds — the two halves only work together.
   */
  it('wraps the relation so every parse column the CASE reads exists', () => {
    const series: Series = {
      venue: 'v', market: 'spot', dataset: 'trades', table: 'trades',
      format: 'csv', header: true, project: {}, ts: 'time',
    };

    const sql = selectFor(series, 'read_csv([\'f\'])', ['x AS _instrument']);

    for (const col of ['_tsText', '_tsInt', '_tsWhole', '_tsFrac'])
      expect(sql).toContain(`AS ${col}`);

    expect(sql).toContain('x AS _instrument');
  });
});
