import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { csv } from '../src/formats/csv';
import { parseKey } from '../src/keys';
import { selectFor } from '../src/schema/project';
import { seriesFor } from '../src/schema/series';
import { fieldsOf } from '../src/schema/tables';
import type { Series } from '../src/types';

/**
 * The mapping, run against real files.
 *
 * Every other test here checks that the map is well *formed*; this one checks
 * that it is *right*, which is a different question and the one that matters.
 * A wrong column name, a swapped pair, a timestamp read in the wrong unit —
 * none of those are visible in the shape of the map, and all of them were
 * present in it before these fixtures existed.
 *
 * Each fixture is the head of a genuine archive file, decoded and kept
 * verbatim. `manifest.json` records the catalog key each stands for, so the
 * series is resolved exactly as a sweep resolves it rather than being named
 * here.
 */

interface Fixture {
  fixture: string;
  key:     string;
}

const DIR      = join(__dirname, 'fixtures');
const FIXTURES = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Fixture[];

/** 2015-01-01 and 2035-01-01 in microseconds, matching the build's guard. */
const EARLIEST = 1_420_070_400_000_000;
const LATEST   = 2_051_222_400_000_000;

let instance: DuckDBInstance;
let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  conn     = await instance.connect();
});

afterAll(async () => {
  conn?.closeSync?.();
});

const resolve = (fixture: Fixture): Series | null => seriesFor(parseKey(fixture.key)!);

const named = (name: string): Fixture => FIXTURES.find(f => f.fixture === name)!;

/** Read one fixture through the real relation expression and projection. */
const rowsOf = async (
  series:  Series,
  fixture: string,
  limit    = 20,
): Promise<Record<string, unknown>[]> => {
  const relation = csv.relation([join(DIR, fixture)], series);
  const sql      = `SELECT * FROM (${selectFor(series, relation)}) ` +
    `WHERE ts IS NOT NULL LIMIT ${limit}`;

  const reader = await conn.runAndReadAll(sql);
  const names  = reader.columnNames();

  return reader.getRows().map(row =>
    Object.fromEntries(names.map((name, i) => [name, row[i]])));
};

/** Fixtures this file can drive end to end: mapped, and stored as CSV. */
const mapped = FIXTURES.filter(f => resolve(f)?.format === 'csv');

const label = (f: Fixture): string => f.fixture.replace(/\.csv$/, '');

describe('the map against real files', () => {
  it('resolves the datasets it claims, and only those', () => {
    const unmapped = FIXTURES.filter(f => resolve(f) === null).map(label);

    // What is left out is left out for one reason only: order books are an
    // event log with a shape of their own — nested arrays of levels per row,
    // rather than one row per fact — and are the last table to build.
    expect(unmapped.sort()).toEqual([
      'gate.futures_btc-orderbooks',
      'gate.futures_usdt-orderbooks',
      'gate.spot-orderbooks',
      'kucoin.futures-orderbooklv50',
      'kucoin.spot-orderbooklv50',
    ]);

    expect(mapped.length).toBeGreaterThanOrEqual(60);
  });

  /**
   * The check that a well-formedness test cannot make: every projected
   * expression has to bind against the columns the venue actually publishes.
   * A renamed column fails here and nowhere else.
   */
  it.each(mapped.map(f => [label(f), f] as const))(
    '%s — every projected column binds and yields rows',
    async (_name, fixture) => {
      const series = resolve(fixture)!;
      const rows   = await rowsOf(series, fixture.fixture);

      expect(rows.length).toBeGreaterThan(0);

      // Every canonical column but margin, which the writer adds per instrument.
      expect(Object.keys(rows[0]!))
        .toEqual(fieldsOf(series.table).map(f => f.name).filter(name => name !== 'margin'));
    },
  );

  /**
   * Timestamps are inferred rather than declared, so this is what proves the
   * inference right for each venue — including the ones that changed precision
   * mid-history, where a declared unit would be wrong for half the archive.
   */
  it.each(mapped.map(f => [label(f), f] as const))(
    '%s — timestamps land in a plausible range',
    async (_name, fixture) => {
      const rows = await rowsOf(resolve(fixture)!, fixture.fixture);

      for (const row of rows) {
        const ts = Number(row.ts);

        expect(ts, `${label(fixture)} ts=${ts}`).toBeGreaterThanOrEqual(EARLIEST);
        expect(ts).toBeLessThanOrEqual(LATEST);
      }
    },
  );

  /**
   * Side is derived, not passed through — from a column, from Binance's
   * `is_buyer_maker`, or from the sign of Gate's size — so it must come out
   * lowercase and never as anything else.
   */
  it.each(mapped.filter(f => resolve(f)!.table === 'trades').map(f => [label(f), f] as const))(
    '%s — side is normalised to buy or sell',
    async (_name, fixture) => {
      const rows  = await rowsOf(resolve(fixture)!, fixture.fixture);
      const sides = new Set(rows.map(r => r.side).filter(s => s !== null));

      expect(sides.size).toBeGreaterThan(0);

      for (const side of sides) expect(['buy', 'sell']).toContain(side);
    },
  );

  /** A price that parsed as NULL means the column mapping missed. */
  it.each(mapped.filter(f => resolve(f)!.project.price).map(f => [label(f), f] as const))(
    '%s — price is a positive number',
    async (_name, fixture) => {
      const rows = await rowsOf(resolve(fixture)!, fixture.fixture);

      for (const row of rows) expect(Number(row.price)).toBeGreaterThan(0);
    },
  );

  /**
   * A venue's own tooling leaks into its archives: OKX candlesticks carry the
   * literal string `None` in `vol_ccy`/`vol_quote` for the eras it did not
   * populate them. The row must survive with a NULL in that column.
   */
  it('keeps a row whose value cannot be parsed, with NULL in its place', async () => {
    const rows        = await rowsOf(resolve(named('okx.spot-candlesticks.csv'))!, 'okx.spot-candlesticks.csv', 1000);
    const unparseable = rows.filter(r => r.quoteVolume === null);

    expect(unparseable.length).toBeGreaterThan(0);

    for (const row of unparseable) {
      expect(row.close).not.toBeNull();
      expect(row.volume).not.toBeNull();
      expect(Number(row.ts)).toBeGreaterThan(EARLIEST);
    }
  });
});

describe('shapes that changed mid-history', () => {
  /**
   * Binance futures files grew a header between 2021-01 and 2022-07. Read
   * positionally, the header line becomes a row whose timestamp is the text
   * `time` — unparseable, hence NULL, hence dropped.
   */
  it('drops a header row that a positional reader would otherwise keep', async () => {
    const series   = resolve(named('binance.um-trades.csv'))!;
    const relation = csv.relation([join(DIR, 'binance.um-trades.csv')], series);

    const all  = await conn.runAndReadAll(`SELECT count(*) FROM ${relation}`);
    const kept = await conn.runAndReadAll(
      `SELECT count(*) FROM (${selectFor(series, relation)}) WHERE ts IS NOT NULL`);

    // The fixture is a headed file, so exactly one row is the header.
    expect(Number(all.getRows()[0]![0]) - Number(kept.getRows()[0]![0])).toBe(1);
  });

  /** Bybit added `RPI` to perpetual trades in 2025-04; mapping by name ignores it. */
  it('is unaffected by a column appended to a headed file', () => {
    const series = resolve(named('bybit.perp-trades.csv'))!;

    expect(Object.values(series.project)).not.toContain('RPI');
    expect(series.header).toBe(true);
  });
});

describe('what the numbers mean', () => {
  /** One row for the trades an order filled at a price: the size is their sum, and the id the aggregate's. */
  it('reads binance aggregated trades by position, with the leg each market gives', async () => {
    const spot = await rowsOf(resolve(named('binance.spot-aggTrades.csv'))!, 'binance.spot-aggTrades.csv');

    expect(spot[0]).toMatchObject({ tradeId: '47487584', price: 6197.92, size: 0.006453, baseSize: 0.006453, side: 'buy' });
    expect(spot[1]).toMatchObject({ tradeId: '47487585', side: 'sell' });

    const linear = await rowsOf(resolve(named('binance.um-aggTrades.csv'))!, 'binance.um-aggTrades.csv');

    expect(linear[0]).toMatchObject({ tradeId: '191966988', price: 19722.09, size: 0.002, baseSize: 0.002 });

    // Coin-margined: the size is a contract count, and neither leg is published.
    const inverse = await rowsOf(resolve(named('binance.cm-aggTrades.csv'))!, 'binance.cm-aggTrades.csv');

    expect(inverse[0]).toMatchObject({ tradeId: '1099246', price: 0.6644, size: 4, baseSize: null });
  });

  /** Fractional seconds, to the microsecond and no further from the truth. */
  it('reads fractional-second epochs exactly', async () => {
    const [gate]  = await rowsOf(resolve(named('gate.spot-deals.csv'))!, 'gate.spot-deals.csv', 1);
    const [bybit] = await rowsOf(resolve(named('bybit.perp-trades.csv'))!, 'bybit.perp-trades.csv', 1);

    expect(String(gate!.ts)).toBe('1780272000487203');
    expect(String(bybit!.ts)).toBe('1785283200063500');
  });

  /** Coin-margined binance: `qty` is contracts, the fourth column the base coin. */
  it('reads binance COIN-M trades\' fourth column as the base leg', async () => {
    const [row] = await rowsOf(resolve(named('binance.cm-trades.csv'))!, 'binance.cm-trades.csv', 1);

    expect(Number(row!.size)).toBe(2);
    expect(Number(row!.baseSize)).toBeCloseTo(0.00313258, 8);
    expect(row!.quoteSize).toBeNull();
  });

  /**
   * The MT4 datetimes are UTC+3: the bar labelled 2024-11-01 00:00 opened at
   * 2024-10-31 21:00 UTC.
   */
  it('moves bybit\'s MT4 bars from UTC+3 to UTC', async () => {
    const [row] = await rowsOf(resolve(named('bybit.mt4-klines.csv'))!, 'bybit.mt4-klines.csv', 1);

    expect(Number(row!.ts)).toBe(Date.UTC(2024, 9, 31, 21) * 1000);
  });

  /** HTX's older spot klines: `vol` is the quote, `amount` the base. */
  it('reads htx\'s older spot kline volumes the right way round', async () => {
    const [row] = await rowsOf(resolve(named('htx.old-spot-klines.csv'))!, 'htx.old-spot-klines.csv', 1);

    expect(Number(row!.volume)).toBeCloseTo(868.8658, 4);
    expect(Number(row!.quoteVolume)).toBeCloseTo(44492.252453, 6);

    // Open, close, high, low as written: 51.32, 51.34, 51.34, 51.02.
    expect(Number(row!.open)).toBe(51.32);
    expect(Number(row!.close)).toBe(51.34);
    expect(Number(row!.low)).toBe(51.02);
  });

  /** HTX's older linear contract trades carry all three: contracts, base, quote. */
  it('reads htx\'s older linear contract trades with every leg', async () => {
    const [row] = await rowsOf(resolve(named('htx.old-perp-trades-linear.csv'))!, 'htx.old-perp-trades-linear.csv', 1);

    expect(Number(row!.size)).toBe(9);
    expect(Number(row!.baseSize)).toBeCloseTo(0.009, 6);
    expect(Number(row!.quoteSize)).toBeCloseTo(173.9889, 4);
    expect(row!.side).toBe('sell');
  });

  /** Options are the linear contract shape: contracts, base, and the premium paid as the quote leg. */
  it('reads htx\'s option trades as linear contracts', async () => {
    const [row] = await rowsOf(resolve(named('htx.old-option-trades.csv'))!, 'htx.old-option-trades.csv', 1);

    expect(Number(row!.price)).toBeCloseTo(3504.23, 2);
    expect(Number(row!.size)).toBe(8);
    expect(Number(row!.baseSize)).toBeCloseTo(0.008, 6);
    expect(Number(row!.quoteSize)).toBeCloseTo(28.03384, 5);
    expect(row!.side).toBe('sell');
  });

  /** Stored as published: this minute's two trades are 8 + 12 contracts, and the bar says 40. */
  it('reads htx\'s option klines with the contract count as volume', async () => {
    const [row] = await rowsOf(resolve(named('htx.old-option-klines.csv'))!, 'htx.old-option-klines.csv', 1);

    expect(Number(row!.open)).toBeCloseTo(3504.23, 2);
    expect(Number(row!.close)).toBeCloseTo(3504.22, 2);
    expect(Number(row!.high)).toBeCloseTo(3504.23, 2);
    expect(Number(row!.low)).toBeCloseTo(3504.22, 2);
    expect(Number(row!.volume)).toBe(40);
  });

  /** Some of the older dated-futures mark files carry a header and some do not; both read by position. */
  it('reads htx\'s dated-futures mark price with a header line or without', async () => {
    const headed = await rowsOf(resolve(named('htx.old-future-markKlines-headed.csv'))!, 'htx.old-future-markKlines-headed.csv');
    const bare   = await rowsOf(resolve(named('htx.old-future-markKlines.csv'))!, 'htx.old-future-markKlines.csv');

    // Three bars each: the header line is not one.
    expect(headed).toHaveLength(3);
    expect(headed[0]).toMatchObject({ open: 1.33618, close: 1.33607, high: 1.33618, low: 1.33607 });
    expect(bare).toHaveLength(3);
    expect(bare[1]).toMatchObject({ open: 30912.5, close: 30910.8, high: 30912.8, low: 30907.7 });
  });

  it('reads htx\'s later dated-futures mark price by name', async () => {
    const [row] = await rowsOf(resolve(named('htx.future-markKlines.csv'))!, 'htx.future-markKlines.csv', 1);

    expect(row).toMatchObject({ open: 65882.35, high: 65907.37, low: 65874.9, close: 65907.37 });
  });

  /** A chain's file names each row's own instrument, and the price is the premium in the coin. */
  it('reads okx\'s option trades, with the later files\' extra column or without', async () => {
    const [early] = await rowsOf(resolve(named('okx.option-trades.csv'))!, 'okx.option-trades.csv', 1);
    const [late]  = await rowsOf(resolve(named('okx.option-trades-source.csv'))!, 'okx.option-trades-source.csv', 1);

    expect(early).toMatchObject({ tradeId: '1', price: 0.0015, size: 500, side: 'buy' });
    expect(late).toMatchObject({ tradeId: '149', price: 0.0002, size: 565, side: 'sell' });
  });

  /** The earliest option bars spell an absent volume `None`. */
  it('reads okx\'s option klines, a volume spelled None as none', async () => {
    const [early] = await rowsOf(resolve(named('okx.option-klines-none.csv'))!, 'okx.option-klines-none.csv', 1);
    const [late]  = await rowsOf(resolve(named('okx.option-klines.csv'))!, 'okx.option-klines.csv', 1);

    expect(early).toMatchObject({ open: 0.002, high: 0.002, low: 0.002, close: 0.002, quoteVolume: null });
    expect(Number(early!.volume)).toBe(0);
    expect(late).toMatchObject({ open: 0.0002, close: 0.0002 });
    expect(Number(late!.quoteVolume)).toBe(0);
  });

  /** The side is spelled `direction`; which leg `amount` measures is not settled, so neither is filled. */
  it('reads bybit\'s option trades', async () => {
    const [row] = await rowsOf(resolve(named('bybit.option-trades.csv'))!, 'bybit.option-trades.csv', 1);

    expect(row).toMatchObject({
      tradeId: '8e65661a-79a1-5254-b8c7-743a2f250ae2', price: 315, size: 0.05, side: 'buy',
      baseSize: null, quoteSize: null,
    });
  });

  /** Five columns and no volume: close, high, low, open after the stamp. */
  it('reads gate\'s tradfi candles', async () => {
    const [first, second] = await rowsOf(resolve(named('gate.tradfi-candlesticks.csv'))!, 'gate.tradfi-candlesticks.csv', 2);

    expect(first).toMatchObject({ open: 186.91, high: 187.99, low: 186.56, close: 187.76, volume: null });
    // A bar opens where the one before it closed.
    expect(second!.open).toBe(first!.close);
  });

  /** And the coin-margined ones lack the quote turnover. */
  it('reads htx\'s older inverse contract trades without a quote leg', async () => {
    const [row] = await rowsOf(resolve(named('htx.old-perp-trades-inverse.csv'))!, 'htx.old-perp-trades-inverse.csv', 1);

    expect(Number(row!.size)).toBe(9);
    expect(Number(row!.baseSize)).toBeCloseTo(7949.1256, 4);
    expect(row!.quoteSize).toBeNull();
    expect(row!.side).toBe('buy');
  });
});
