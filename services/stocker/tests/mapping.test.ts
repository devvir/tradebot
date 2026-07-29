import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { csv } from '../src/formats/csv';
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
 * Each fixture is the head of a genuine archive file, decoded from the venue
 * and kept verbatim. `manifest.json` records the path each came from, so the
 * series is resolved exactly as the walk resolves it in production rather than
 * being named here.
 */

interface Fixture {
  venue:   string;
  dataset: string;
  rawPath: string;
  fixture: string;
}

const DIR       = join(__dirname, 'fixtures');
const FIXTURES  = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Fixture[];

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

/**
 * Fixtures this file can drive end to end: mapped, and stored as CSV.
 *
 * Bitget's klines and depth are mapped but arrive as an XLSX nested inside the
 * zip, so they need the spreadsheet reader rather than this one and are covered
 * by their own fixture below.
 */
const mapped = FIXTURES.filter(f => {
  const resolved = seriesFor(f.venue, f.rawPath);

  return resolved !== null && resolved.series.format === 'csv';
});

describe('the map against real files', () => {
  it('resolves the datasets it claims, and only those', () => {
    const unmapped = FIXTURES.filter(f => seriesFor(f.venue, f.rawPath) === null)
      .map(f => `${f.venue}/${f.dataset}`);

    // What is left out is left out for one reason only: order books are an
    // event log with a shape of their own — nested arrays of levels per row,
    // rather than one row per fact — and are the last table to build.
    expect(unmapped.sort()).toEqual([
      'gate/futures_btc-orderbooks',
      'gate/futures_usdt-orderbooks',
      'gate/spot-orderbooks',
      'kucoin/futures-orderbooklv50',
      'kucoin/spot-orderbooklv50',
    ]);

    expect(mapped.length).toBeGreaterThanOrEqual(60);
  });

  /**
   * The check that a well-formedness test cannot make: every projected
   * expression has to bind against the columns the venue actually publishes.
   * A renamed column fails here and nowhere else.
   */
  it.each(mapped.map(f => [`${f.venue}/${f.dataset}`, f] as const))(
    '%s — every projected column binds and yields rows',
    async (_name, fixture) => {
      const resolved = seriesFor(fixture.venue, fixture.rawPath)!;
      const rows     = await rowsOf(resolved.series, fixture.fixture);

      expect(rows.length).toBeGreaterThan(0);

      // Every canonical column of the table is present, in the table's order.
      expect(Object.keys(rows[0]!)).toEqual(fieldsOf(resolved.series.table).map(f => f.name));
    },
  );

  /**
   * A venue's own tooling leaks into its archives: OKX candlesticks carry the
   * literal string `None` in `vol_ccy`/`vol_quote` for the eras it did not
   * populate them, on every row of the file. Under a strict cast that is a
   * failed month, and 4,678 OKX kline partitions failed on one sweep for
   * exactly this. The row must survive with a NULL in that column.
   */
  it('keeps a row whose value cannot be parsed, with NULL in its place', async () => {
    const resolved = seriesFor('okx', 'candlesticks/monthly/202201/NMR-USDT-candlesticks-2022-01.zip')!;
    const rows     = await rowsOf(resolved.series, 'okx.spot-candlesticks.csv', 1000);

    const unparseable = rows.filter(r => r.quoteVolume === null);

    expect(unparseable.length).toBeGreaterThan(0);

    // NULL only where the venue wrote nothing usable — the rest of the row is
    // intact, which is the whole point of not failing the build.
    for (const row of unparseable) {
      expect(row.close).not.toBeNull();
      expect(row.volume).not.toBeNull();
      expect(Number(row.ts)).toBeGreaterThan(EARLIEST);
    }
  });

  /**
   * Timestamps are inferred rather than declared, so this is what proves the
   * inference right for each venue — including the ones that changed precision
   * mid-history, where a declared unit would be wrong for half the archive.
   */
  it.each(mapped.map(f => [`${f.venue}/${f.dataset}`, f] as const))(
    '%s — timestamps land in a plausible range',
    async (_name, fixture) => {
      const resolved = seriesFor(fixture.venue, fixture.rawPath)!;
      const rows     = await rowsOf(resolved.series, fixture.fixture);

      for (const row of rows) {
        const ts = Number(row.ts);

        expect(ts, `${fixture.venue}/${fixture.dataset} ts=${ts}`)
          .toBeGreaterThanOrEqual(EARLIEST);
        expect(ts).toBeLessThanOrEqual(LATEST);
      }
    },
  );

  /**
   * Side is derived, not passed through — from a column, from Binance's
   * `is_buyer_maker`, or from the sign of Gate's size — so it must come out
   * lowercase and never as anything else.
   */
  it.each(mapped.filter(f => seriesFor(f.venue, f.rawPath)!.series.table === 'trades')
    .map(f => [`${f.venue}/${f.dataset}`, f] as const))(
    '%s — side is normalised to buy or sell',
    async (_name, fixture) => {
      const resolved = seriesFor(fixture.venue, fixture.rawPath)!;
      const rows     = await rowsOf(resolved.series, fixture.fixture);
      const sides    = new Set(rows.map(r => r.side).filter(s => s !== null));

      expect([...sides].sort()).not.toContain('Buy');

      for (const side of sides) expect(['buy', 'sell']).toContain(side);
    },
  );

  /** A price that parsed as NULL means the column mapping missed. */
  it.each(mapped.filter(f => fieldsOf(seriesFor(f.venue, f.rawPath)!.series.table)
    .some(x => x.name === 'price') && seriesFor(f.venue, f.rawPath)!.series.project.price)
    .map(f => [`${f.venue}/${f.dataset}`, f] as const))(
    '%s — price is a positive number',
    async (_name, fixture) => {
      const resolved = seriesFor(fixture.venue, fixture.rawPath)!;
      const rows     = await rowsOf(resolved.series, fixture.fixture);

      for (const row of rows) expect(Number(row.price)).toBeGreaterThan(0);
    },
  );
});

describe('shapes that changed mid-history', () => {
  /**
   * Binance futures files grew a header between 2021-01 and 2022-07. Read
   * positionally, the header line becomes a row whose timestamp is the text
   * `id` — unparseable, hence NULL, hence dropped. This is what lets one entry
   * span both eras with no boundary date written down.
   */
  it('drops a header row that a positional reader would otherwise keep', async () => {
    const resolved = seriesFor('binance', 'futures/um/daily/trades/BTCUSDT/x-trades-2026-07-29.zip')!;
    const relation = csv.relation([join(DIR, 'binance.um-trades.csv')], resolved.series);

    const all = await conn.runAndReadAll(`SELECT count(*) FROM ${relation}`);
    const kept = await conn.runAndReadAll(
      `SELECT count(*) FROM (${selectFor(resolved.series, relation)}) WHERE ts IS NOT NULL`);

    // The fixture is a headed file, so exactly one row is the header.
    expect(Number(all.getRows()[0]![0]) - Number(kept.getRows()[0]![0])).toBe(1);
  });

  /**
   * Bybit added `RPI` to perpetual trades in 2025-04. Mapping by name is what
   * makes an appended column a non-event.
   */
  it('is unaffected by a column appended to a headed file', () => {
    const resolved = seriesFor('bybit', 'trading/BTCUSDT/BTCUSDT2026-07-29.csv.gz')!;

    expect(Object.values(resolved.series.project)).not.toContain('RPI');
    expect(resolved.series.header).toBe(true);
  });
});
