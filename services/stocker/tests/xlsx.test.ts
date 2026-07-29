import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { xlsx } from '../src/formats/xlsx';
import { seriesFor } from '../src/schema/series';
import { selectFor } from '../src/schema/project';

/**
 * Bitget publishes klines and depth as Excel inside the zip, one sheet per day,
 * so a month is thirty-odd sheets that must read as one relation.
 *
 * Sheets are generated here rather than committed: `read_xlsx` is the thing
 * under test, DuckDB can write the format, and a binary fixture would say
 * nothing about why it looks the way it does.
 */

let dir: string;
let instance: DuckDBInstance;
let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

/** One day of depth, shaped exactly as bitget publishes it. */
const sheet = async (name: string, rows: [number, number, number][]): Promise<string> => {
  const path   = join(dir, name);
  const values = rows
    .map(([ts, bid, ask]) => `(${ts}, ${ask}, ${bid}, 10.5, 20.5)`)
    .join(', ');

  await conn.run(
    `COPY (SELECT * FROM (VALUES ${values})
       AS t(timestamp, ask_price, bid_price, ask_volume, bid_volume))
     TO '${path}' (FORMAT xlsx, HEADER true)`,
  );

  return path;
};

beforeAll(async () => {
  dir      = await mkdtemp(join(tmpdir(), 'xlsx-'));
  instance = await DuckDBInstance.create(':memory:');
  conn     = await instance.connect();

  await conn.run('INSTALL excel');
  await conn.run('LOAD excel');
});

afterAll(async () => {
  conn?.closeSync?.();
  await rm(dir, { recursive: true, force: true });
});

const series = () => seriesFor('bitget', 'depth/CETUSUSDT/1/20240903.zip')!.series;

const rowsOf = async (paths: string[]): Promise<Record<string, unknown>[]> => {
  const reader = await conn.runAndReadAll(
    `SELECT * FROM (${selectFor(series(), xlsx.relation(paths, series()))}) ` +
    `WHERE ts IS NOT NULL ORDER BY ts`);
  const names = reader.columnNames();

  return reader.getRows().map(row => Object.fromEntries(names.map((n, i) => [n, row[i]])));
};

describe('reading a month of spreadsheets', () => {
  /**
   * The bug this exists for: the reader took a single path and threw on
   * anything else, so every bitget depth month of more than one day failed to
   * build — `xlsx expects one sheet file, got 31`.
   */
  it('reads every sheet of a month, not just one', async () => {
    const a = await sheet('20240903.xlsx', [[1725292804000, 1.4, 1.5], [1725292805000, 1.41, 1.51]]);
    const b = await sheet('20240904.xlsx', [[1725379204000, 1.6, 1.7]]);

    const rows = await rowsOf([a, b]);

    expect(rows).toHaveLength(3);
    expect(rows.map(r => Number(r.bidPrice))).toEqual([1.4, 1.41, 1.6]);
  });

  it('still reads a month that really is one sheet', async () => {
    const only = await sheet('20241001.xlsx', [[1727740804000, 2.4, 2.5]]);

    expect(await rowsOf([only])).toHaveLength(1);
  });

  /**
   * A glob would have been the tempting fix. DuckDB accepts one and then reads
   * a single match with no error — silently dropping the rest of the month —
   * which is why the union is built path by path.
   */
  it('unions by name, so a reordered header cannot transpose columns', async () => {
    const normal = await sheet('20240905.xlsx', [[1725465604000, 3.4, 3.5]]);
    const other  = join(dir, '20240906.xlsx');

    // Same columns, published in a different order.
    await conn.run(
      `COPY (SELECT * FROM (VALUES (9.9, 8.8, 1725552004000, 7.7, 6.6))
         AS t(bid_price, ask_price, timestamp, bid_volume, ask_volume))
       TO '${other}' (FORMAT xlsx, HEADER true)`,
    );

    const rows = await rowsOf([normal, other]);

    expect(rows).toHaveLength(2);
    expect(rows.map(r => Number(r.bidPrice))).toEqual([3.4, 9.9]);
    expect(rows.map(r => Number(r.askPrice))).toEqual([3.5, 8.8]);
  });

  it('refuses an empty file list rather than building an empty partition', () => {
    expect(() => xlsx.relation([], series())).toThrow(/at least one/);
  });

  /**
   * Bitget's `-999999` means "no quote". Comparing the raw VARCHAR against that
   * integer literal makes DuckDB coerce the column to INT32, which throws on a
   * value past 2^31 or with a decimal point — both of which are real: volumes
   * of `2656014739` and `3596970534.21` failed whole months this way. The
   * sentinel must be matched *after* the cast, not before.
   */
  it('nulls the sentinel without choking on large or fractional volumes', async () => {
    const path   = join(dir, '20241102.xlsx');
    const values = [
      // ts, ask_price, bid_price, ask_volume, bid_volume
      '(1730505604000, 1.5, 1.4, 10.5, 2656014739)',
      '(1730505605000, 1.6, 1.5, 11.5, 3596970534.21)',
      '(1730505606000, -999999, -999999, -999999, -999999)',
    ].join(', ');

    await conn.run(
      `COPY (SELECT * FROM (VALUES ${values})
         AS t(timestamp, ask_price, bid_price, ask_volume, bid_volume))
       TO '${path}' (FORMAT xlsx, HEADER true)`,
    );

    const rows = await rowsOf([path]);

    expect(rows).toHaveLength(3);
    expect(rows.map(r => (r.bidSize === null ? null : Number(r.bidSize))))
      .toEqual([2656014739, 3596970534.21, null]);

    // The sentinel row keeps its timestamp — it is a row that says "no quote",
    // not a row to discard.
    expect(rows[2]!.bidPrice).toBeNull();
    expect(rows[2]!.askPrice).toBeNull();
    expect(Number(rows[2]!.ts)).toBeGreaterThan(0);
  });
});
