import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatFor, formatOf } from '../src/formats';
import { parseKey } from '../src/keys';
import { selectFor } from '../src/schema/project';
import { extrasOf, seriesFor } from '../src/schema/series';
import { rootOf } from '../src/schema/tables';

/**
 * Order books, venue by venue, against the first records of files each venue
 * served. Every one becomes the same thing: a row a level, saying what it does
 * to the book.
 */

const DIR = join(__dirname, 'fixtures');

let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(':memory:')).connect();
});

afterAll(() => {
  conn?.closeSync?.();
});

type Row = Record<string, unknown>;

/** A fixture's rows as the build would write them, in the order it writes them. */
const rowsOf = async (key: string, fixture: string): Promise<Row[]> => {
  const series   = seriesFor(parseKey(key)!)!;
  const relation = formatFor(await formatOf(series.format, join(DIR, fixture))).relation([join(DIR, fixture)], series);
  const extra    = series.instrument ? [`CAST(${series.instrument} AS VARCHAR) AS _instrument`] : [];
  const reader   = await conn.runAndReadAll(
    `SELECT ${series.repeatsRows ? 'DISTINCT ' : ''}* FROM (${selectFor(series, relation, extra)}) ` +
    `WHERE ts IS NOT NULL ORDER BY ts, sequence, side, price`);
  const names    = reader.columnNames();

  return reader.getRows().map(row => Object.fromEntries(names.map((name, at) =>
    [name, typeof row[at] === 'bigint' ? Number(row[at]) : row[at]])));
};

const OKX_SPOT   = 'okx/spot/books,5000,incremental/A/AUDF-USDT/202606/okx|spot|books,5000,incremental|AUDF-USDT|20260601.tar.gz';
const OKX_PADDED = 'okx/spot/books,400,incremental/M/MCO-USDT/202303/okx|spot|books,400,incremental|MCO-USDT|20230301.tar.gz';
const OKX_CHAIN  = 'okx/future/books,5000,incremental/T/TRX-USD_UM_XPERP/202606/okx|future|books,5000,incremental|TRX-USD_UM_XPERP|20260601.tar.gz';
const HTX_PERP   = 'htx/perp/books,150,incremental/O/ORCA-USDT/202606/htx|perp|books,150,incremental|ORCA-USDT|20260601.tar.gz';
const BYBIT      = 'bybit/perp/books,200,incremental/X/XAUTUSDT-19JUN26/202606/bybit|perp|books,200,incremental|XAUTUSDT-19JUN26|20260601.data.zip';
const GATE_SPOT  = 'gate/spot/books,full,incremental/B/BTC_USDT/202108/gate|spot|books,full,incremental|BTC_USDT|20210801.part00.csv.gz';
const GATE_PERP  = 'gate/perp/books,full,incremental/B/BTC_USD/202606/gate|perp|books,full,incremental|BTC_USD|20260601.part21.csv.gz';
const GATE_FUT   = 'gate/future/books,full,incremental/B/BTC_USDT_20260626/202606/gate|future|books,full,incremental|BTC_USDT_20260626|20260601.part21.csv.gz';
const GATE_SLICE = 'gate/spot/books,20,snapshot/E/ETH_USDT/202606/gate|spot|books,20,snapshot|ETH_USDT|20260601.part20.gz';
const GATE_OLD   = 'gate/spot/books,20,snapshot/B/BTC_USDT/202108/gate|spot|books,20,snapshot|BTC_USDT|20210801.part09.gz';
const GATE_USDT  = 'gate/perp/books,20,snapshot/E/ETH_USDT/202606/gate|perp|books,20,snapshot|ETH_USDT|20260601.part20.gz';
const KUCOIN     = 'kucoin/spot/books,50,snapshot/B/BTC-USDT/202607/kucoin|spot|books,50,snapshot|BTC-USDT|20260729.zip';
const KUCOIN_FUT = 'kucoin/perp/books,50,snapshot/X/XBTUSDTM/202607/kucoin|perp|books,50,snapshot|XBTUSDTM|20260729.zip';
const BITGET     = 'bitget/spot/books,500,snapshot/G/GHOUSDT/202606/bitget|spot|books,500,snapshot|GHOUSDT|202606.zip';
const BITGET_DAY = 'bitget/spot/books,500,snapshot/G/GHOUSDT/202606/bitget|spot|books,500,snapshot|GHOUSDT|20260601.zip';

describe('books that are an image and the changes since', () => {
  it('reads okx: a snapshot, then levels set — gone at size zero', async () => {
    const rows = await rowsOf(OKX_SPOT, 'okx.spot-books.ndjson');

    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({
      ts: 1_780_272_000_008_000, action: 'snapshot', side: 'ask', price: 0.7189, size: 50000, orderCount: 1,
      sequence: null, _instrument: 'AUDF-USDT',
    });
    expect(rows[1]).toMatchObject({ action: 'snapshot', side: 'bid', price: 0.7186 });
    expect(rows[2]).toMatchObject({ ts: 1_780_272_031_008_000, action: 'set', side: 'ask', price: 0.7189, size: 0, orderCount: 0 });
  });

  /** An image is filled out to its depth with levels of price 0, which are not levels. */
  it('drops the padding okx fills an image out with', async () => {
    const rows = await rowsOf(OKX_PADDED, 'okx.spot-books-padded.ndjson');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(800);

    for (const row of rows) expect(Number(row['price'])).toBeGreaterThan(0);
  });

  it('names each record\'s own instrument, a chain\'s file holding several', async () => {
    const rows = await rowsOf(OKX_CHAIN, 'okx.future-books.ndjson');

    expect(new Set(rows.map(row => row['_instrument']))).toEqual(new Set(['TRX-USD_UM_XPERP-310523']));
    expect(rows[0]).toMatchObject({ action: 'set' });
  });

  /** HTX: okx's record with a level of two values and the time in microseconds. */
  it('reads htx, which counts no orders', async () => {
    const rows = await rowsOf(HTX_PERP, 'htx.perp-books.ndjson');

    expect(rows[0]).toMatchObject({ ts: 1_780_243_200_031_000, action: 'snapshot', orderCount: null });
    expect(rows.at(-1)).toMatchObject({ action: 'set' });
    expect(rows.some(row => row['side'] === 'ask' && row['price'] === 1.458 && row['size'] === 755)).toBe(true);
    expect(seriesFor(parseKey(HTX_PERP)!)!.spill).toBe('back');
  });

  it('reads bybit: a snapshot, then deltas, ordered by its cross sequence', async () => {
    const rows = await rowsOf(BYBIT, 'bybit.linear-books.ndjson');

    expect(rows[0]).toMatchObject({ ts: 1_780_272_001_020_000, action: 'snapshot', sequence: 13_314_825_492 });
    expect(rows.some(row => row['action'] === 'set' && row['side'] === 'bid' && row['price'] === 4518.3 && row['size'] === 0
      && row['sequence'] === 13_314_891_223)).toBe(true);
  });
});

describe('gate\'s books of level changes', () => {
  /** `1` is the asks and `2` the bids; `make` adds to a level and `take` takes from it. */
  it('reads spot, which names the side', async () => {
    const rows = await rowsOf(GATE_SPOT, 'gate.spot-books-changes.csv');

    expect(rows.map(row => [row['action'], row['side'], row['price'], row['sequence']])).toEqual([
      ['set', 'ask', 41473.32, 4_217_320_522], ['set', 'bid', 0.01, 4_217_320_522], ['set', 'bid', 0.02, 4_217_320_522],
      ['make', 'ask', 41578.93, 4_217_320_523], ['take', 'ask', 41473.32, 4_217_320_524],
      ['make', 'ask', 42827.9, 4_217_320_525], ['take', 'ask', 41473.32, 4_217_320_526],
    ]);
    expect(rows[3]).toMatchObject({ ts: 1_627_776_000_200_000, size: 0.0024 });
  });

  /** A negative size is an ask, and the size stored is what it measures. */
  it('reads futures, which sign the size', async () => {
    const rows = await rowsOf(GATE_PERP, 'gate.futures-books-changes.csv');

    expect(rows.map(row => [row['action'], row['side'], row['price'], row['size']])).toEqual([
      ['set', 'ask', 71269.3, 801], ['set', 'ask', 71278.4, 102], ['set', 'bid', 3600.6, 5], ['set', 'bid', 3800.6, 5],
      ['take', 'ask', 71566.6, 250000], ['take', 'bid', 71035.4, 250000],
      ['make', 'ask', 72375.7, 250000], ['make', 'bid', 70326.1, 250000],
    ]);
    expect(seriesFor(parseKey(GATE_FUT)!)!.table).toBe('orderBook');
  });
});

describe('books that are an image a tick', () => {
  /** A row an image: when it was taken, its sequence, and each side as the venue sent it. */
  const imagesOf = async (key: string, fixture: string): Promise<Row[]> => {
    const series   = seriesFor(parseKey(key)!)!;
    const relation = formatFor(await formatOf(series.format, join(DIR, fixture))).relation([join(DIR, fixture)], series);
    const reader   = await conn.runAndReadAll(
      `SELECT ts, sequence, len(asks) AS asks, asks[1][1] AS askPrice, asks[1][2] AS askSize, ` +
      `len(bids) AS bids, bids[1][1] AS bidPrice, bids[1][2] AS bidSize, typeof(asks) AS kind ` +
      `FROM (SELECT ${series.repeatsRows ? 'DISTINCT ' : ''}* FROM (${selectFor(series, relation)})) ` +
      `WHERE ts IS NOT NULL ORDER BY ts, sequence`);
    const names    = reader.columnNames();

    return reader.getRows().map(row => Object.fromEntries(names.map((name, at) =>
      [name, typeof row[at] === 'bigint' ? Number(row[at]) : row[at]])));
  };

  it('are a table of their own, a row a message', () => {
    for (const key of [GATE_SLICE, GATE_USDT, KUCOIN, KUCOIN_FUT, BITGET, BITGET_DAY])
      expect(seriesFor(parseKey(key)!)!.table).toBe('orderBookSnapshot');

    for (const key of [OKX_SPOT, HTX_PERP, BYBIT, GATE_SPOT, GATE_PERP])
      expect(seriesFor(parseKey(key)!)!.table).toBe('orderBook');
  });

  it('reads gate\'s spot images', async () => {
    const rows = await imagesOf(GATE_SLICE, 'gate.spot-books-slice.ndjson');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ts: 1_780_343_999_931_000, sequence: 26_808_803_387, asks: 20, bids: 20,
      askPrice: 2004.22, askSize: 0.653, kind: 'DOUBLE[][]',
    });
  });

  /** The early files stamp seconds with a fraction where the later ones stamp milliseconds. */
  it('reads the time of an early image, which is in seconds', async () => {
    const rows = await imagesOf(GATE_OLD, 'gate.spot-books-slice-seconds.ndjson');

    expect(rows[0]).toMatchObject({ ts: 1_627_808_401_603_536, sequence: 4_220_519_569 });
  });

  /** Futures write a level as `{p, s}`; stored, it is `[price, size]` like any other. */
  it('reads gate\'s futures images', async () => {
    const rows = await imagesOf(GATE_USDT, 'gate.usdt-books-slice.ndjson');

    expect(rows[0]).toMatchObject({
      ts: 1_780_344_002_013_000, sequence: 98_077_993_731, askPrice: 2003.67, askSize: 5088, kind: 'DOUBLE[][]',
    });
  });

  /** JSON a line under a one-word header, which is not a row; a line written twice is one image. */
  it('reads kucoin, spot and futures', async () => {
    const spot    = await imagesOf(KUCOIN, 'kucoin.spot-orderbooklv50.csv');
    const futures = await imagesOf(KUCOIN_FUT, 'kucoin.futures-orderbooklv50.csv');

    expect(spot).toHaveLength(13);
    expect(spot.find(row => row['ts'] === 1_785_283_200_307_000))
      .toMatchObject({ sequence: null, asks: 50, bids: 50, askPrice: 63922.7, askSize: 0.33658639 });
    expect(futures.find(row => row['sequence'] === 1_746_076_505_900))
      .toMatchObject({ askPrice: 63925.9, askSize: 486 });
  });

  /** The two sides are JSON text in a cell each. */
  it('reads bitget, a sheet by day and text by month', async () => {
    const rows = await imagesOf(BITGET, 'bitget.spot-books-month.csv');

    expect(seriesFor(parseKey(BITGET)!)).toBe(seriesFor(parseKey(BITGET_DAY)!));
    expect(rows[0]).toMatchObject({
      ts: 1_780_324_977_000_000, askPrice: 1.0082, askSize: 0.7161, bidPrice: 0.9905, bidSize: 105.6462,
    });
  });
});

describe('where a book sits in the vault', () => {
  it('says how deep it is and in which mode', () => {
    const okx    = seriesFor(parseKey(OKX_SPOT)!)!;
    const bitget = seriesFor(parseKey(BITGET)!)!;

    expect(extrasOf(okx, '5000,incremental')).toEqual({ depth: '5000', mode: 'incremental' });
    expect(extrasOf(okx, 'full,incremental')).toEqual({ depth: 'full', mode: 'incremental' });
    expect(extrasOf(bitget, '500,snapshot')).toEqual({ depth: '500', mode: 'snapshot' });
  });

  /** Two kinds of book are two tables of one dataset: the mode in the path is what tells their files apart. */
  it('keeps both kinds under the one dataset name', () => {
    expect(rootOf('orderBookSnapshot')).toBe('orderBook');
    expect(rootOf('orderBook')).toBe('orderBook');
    expect(rootOf('trades')).toBe('trades');
  });
});
