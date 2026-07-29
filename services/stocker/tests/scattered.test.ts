import { describe, expect, it } from 'vitest';
import { grouper } from '../src/group';
import type { RawFile, Series } from '../src/types';

/**
 * The trait under test: a series whose files reach the walk from more than one
 * place, so a partition cannot be closed the moment a different one begins.
 *
 * Bitget is the only venue that needs it. It published klines under two names
 * and serves both, and in the sorted walk **every flat file of every month
 * precedes the first nested one** — so the two halves of one partition are
 * separated by thousands of files belonging to others.
 *
 * The fixtures below are that real order, at small scale.
 */

const klines = (scattered?: boolean): Series => ({
  source: 'trucker', venue: 'bitget', table: 'klines', market: 'perp',
  match: /(?<symbol>x)/, container: 'zip', format: 'xlsx', header: true,
  interval: '1m', project: {}, ts: 'timestamp', scattered,
});

/** `kline/<symbol>/<name>` — flat when `name` carries the product, nested otherwise. */
const fileOf = (series: Series, symbol: string, name: string, month: string): RawFile => ({
  path:      `kline/${symbol}/${name}`,
  absolute:  `/raw/bitget/kline/${symbol}/${name}`,
  series, rawSymbol: symbol, month, interval: '1m',
  size: 1,
});

const feedAll = (groups: ReturnType<typeof grouper>, files: RawFile[]) =>
  [...files.flatMap(f => groups.feed(f)), ...groups.end()];

const everything = () => true;

describe('a scattered series', () => {
  const series = klines(true);

  /**
   * The bug this trait exists for. Without it each half closed on the other's
   * arrival, the second build silently replaced the first, and every sweep
   * flagged the half that was missing as newly added and rebuilt for ever.
   */
  it('gathers both halves of a partition into one group', () => {
    const done = feedAll(grouper(everything), [
      // Every flat file first, in name order, months interleaved.
      fileOf(series, 'ADAUSDT', 'ADAUSDT_UMCBL_1min_20200819.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'ADAUSDT_UMCBL_1min_20200902.zip', '2020-09'),
      fileOf(series, 'ADAUSDT', 'ADAUSDT_UMCBL_1min_20200820.zip', '2020-08'),
      // Then the nested directory, far away in the walk.
      fileOf(series, 'ADAUSDT', 'UMCBL/20200824.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'UMCBL/20200905.zip', '2020-09'),
    ]);

    expect(done.map(g => [g.id, g.inputs.length]).sort()).toEqual([
      ['klines|bitget|perp|ADAUSDT|1m|2020-08', 3],
      ['klines|bitget|perp|ADAUSDT|1m|2020-09', 2],
    ]);
  });

  it('closes everything gathered when the walk leaves the symbol', () => {
    const done = feedAll(grouper(everything), [
      fileOf(series, 'ADAUSDT', 'ADAUSDT_UMCBL_1min_20200819.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'UMCBL/20200824.zip', '2020-08'),
      fileOf(series, 'BNBUSDT', 'BNBUSDT_UMCBL_1min_20190802.zip', '2019-08'),
    ]);

    // The first symbol is handed over before the second is finished, so memory
    // is bounded by one symbol rather than by the venue.
    expect(done.map(g => g.id)).toEqual([
      'klines|bitget|perp|ADAUSDT|1m|2020-08',
      'klines|bitget|perp|BNBUSDT|1m|2019-08',
    ]);
  });

  it('keeps both markets of one symbol, which share a directory', () => {
    const spot = { ...klines(true), market: 'spot' } as Series;
    const done = feedAll(grouper(everything), [
      fileOf(spot,   'ADAUSDT', 'ADAUSDT_SP_1min_20200819.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'ADAUSDT_UMCBL_1min_20200819.zip', '2020-08'),
      fileOf(spot,   'ADAUSDT', 'SP/20200824.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'UMCBL/20200824.zip', '2020-08'),
    ]);

    expect(done.map(g => [g.id, g.inputs.length]).sort()).toEqual([
      ['klines|bitget|perp|ADAUSDT|1m|2020-08', 2],
      ['klines|bitget|spot|ADAUSDT|1m|2020-08', 2],
    ]);
  });
});

describe('a partition assembled from two places', () => {
  /**
   * A series that is scattered and does not say so used to produce the same
   * partition twice and let the second overwrite the first — silent, and only
   * visible later as a partition holding half its rows.
   */
  it('is marked contested rather than built', () => {
    const series = klines();                    // scattered NOT declared

    const done = feedAll(grouper(everything), [
      fileOf(series, 'ADAUSDT', 'ADAUSDT_UMCBL_1min_20200819.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'ADAUSDT_UMCBL_1min_20200902.zip', '2020-09'),
      fileOf(series, 'ADAUSDT', 'UMCBL/20200824.zip', '2020-08'),
    ]);

    const august = done.filter(g => g.id.endsWith('2020-08'));

    expect(august).toHaveLength(2);
    expect(august[0]!.contested).toBeUndefined();
    expect(august[1]!.contested).toBe(true);
  });

  /**
   * The reason the rule is stated as "assembled exactly once" rather than as
   * anything about folders: a venue that publishes a month both monthly and
   * daily, collected both ways, lands two renderings on one partition. Merging
   * them would count every row twice.
   */
  it('covers a month collected in two renderings, naming neither', () => {
    const trades: Series = {
      source: 'trucker', venue: 'binance', table: 'trades', market: 'spot',
      match: /(?<symbol>x)/, container: 'zip', format: 'csv', header: false,
      project: {}, ts: 'rawTs',
    };

    const at = (path: string): RawFile => ({
      path, absolute: `/raw/binance/${path}`,
      series: trades, rawSymbol: 'BTCUSDT', month: '2026-06', size: 1,
    });

    const other = (path: string): RawFile => ({
      ...at(path), rawSymbol: 'ETHUSDT',
    });

    const done = feedAll(grouper(everything), [
      at('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-06-01.zip'),
      at('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-06-02.zip'),
      // Every daily file of every symbol precedes the first monthly one, so
      // other partitions always sit between a month's two renderings.
      other('spot/daily/trades/ETHUSDT/ETHUSDT-trades-2026-06-01.zip'),
      at('spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2026-06.zip'),
    ]);

    const btc = done.filter(group => group.key.symbol === 'BTCUSDT');

    expect(btc.map(group => group.contested)).toEqual([undefined, true]);
  });

  /**
   * **The limit of the rule, pinned so it is not mistaken for a guarantee.**
   *
   * Nothing separates the two renderings when a dataset has one symbol, so they
   * arrive consecutively, never close a group between them, and merge — every
   * row counted twice with nothing said. Catching that needs the series to name
   * which rendering a path is, rather than the grouper inferring it from order.
   */
  it('does NOT catch two renderings that arrive with nothing in between', () => {
    const trades: Series = {
      source: 'trucker', venue: 'binance', table: 'trades', market: 'spot',
      match: /(?<symbol>x)/, container: 'zip', format: 'csv', header: false,
      project: {}, ts: 'rawTs',
    };

    const at = (path: string): RawFile => ({
      path, absolute: `/raw/binance/${path}`,
      series: trades, rawSymbol: 'BTCUSDT', month: '2026-06', size: 1,
    });

    const done = feedAll(grouper(everything), [
      at('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-06-01.zip'),
      at('spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2026-06.zip'),
    ]);

    expect(done).toHaveLength(1);
    expect(done[0]!.contested).toBeUndefined();
    expect(done[0]!.inputs).toHaveLength(2);
  });

  it('says nothing about a series whose files are contiguous', () => {
    const series = klines();
    const done   = feedAll(grouper(everything), [
      fileOf(series, 'ADAUSDT', 'UMCBL/20200824.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'UMCBL/20200825.zip', '2020-08'),
      fileOf(series, 'ADAUSDT', 'UMCBL/20200905.zip', '2020-09'),
    ]);

    expect(done.map(g => [g.id, g.inputs.length])).toEqual([
      ['klines|bitget|perp|ADAUSDT|1m|2020-08', 2],
      ['klines|bitget|perp|ADAUSDT|1m|2020-09', 1],
    ]);
  });
});
