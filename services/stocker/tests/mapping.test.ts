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

  /** And the coin-margined ones lack the quote turnover. */
  it('reads htx\'s older inverse contract trades without a quote leg', async () => {
    const [row] = await rowsOf(resolve(named('htx.old-perp-trades-inverse.csv'))!, 'htx.old-perp-trades-inverse.csv', 1);

    expect(Number(row!.size)).toBe(9);
    expect(Number(row!.baseSize)).toBeCloseTo(7949.1256, 4);
    expect(row!.quoteSize).toBeNull();
    expect(row!.side).toBe('buy');
  });
});
