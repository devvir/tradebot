import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatFor } from '../src/formats';
import { parseKey } from '../src/keys';
import { selectFor } from '../src/schema/project';
import { extrasOf, seriesFor } from '../src/schema/series';

/**
 * Gate's files named by the moment they hold: plain text, a line an
 * instrument, no extension and no time inside. Both fixtures are the first
 * lines of the files gate served for 2026-06-01 00:00 UTC, under the names the
 * catalog gives them.
 */

const DIR = join(__dirname, 'fixtures');

const INDEX  = 'gate/spot/indexPrice,ticks/@/202606/gate|spot|indexPrice,ticks|@|202606.part1780272000';
const TICKER = 'gate/option/optionTicker,ticks/@/202606/gate|option|optionTicker,ticks|@|202606.part1780272000';

let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(':memory:')).connect();
});

afterAll(() => {
  conn?.closeSync?.();
});

const rowsOf = async (key: string, fixture: string): Promise<Record<string, unknown>[]> => {
  const series   = seriesFor(parseKey(key)!)!;
  const relation = formatFor(series.format).relation([join(DIR, fixture)], series);
  const reader   = await conn.runAndReadAll(
    `SELECT * FROM (${selectFor(series, relation, [`CAST(${series.instrument} AS VARCHAR) AS _instrument`])})`);
  const names    = reader.columnNames();

  return reader.getRows().map(row => Object.fromEntries(names.map((name, at) => [name, row[at]])));
};

describe('files named by the moment they hold', () => {
  it('are files of the catalog though they have no extension', () => {
    expect(parseKey(INDEX)).toMatchObject({
      venue: 'gate', dataset: 'indexPrice', variant: 'ticks', bundle: 'market',
      grain: 'monthly', part: '1780272000', container: 'plain',
    });
  });

  /** A line that begins with a blank still reads as its instrument and its price. */
  it('reads the spot index, the time from the name', async () => {
    const rows = await rowsOf(INDEX, 'gate.spot-index.part1780272000');

    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ _instrument: 'DOGE_USD1', price: 0.1003325 });
    expect(rows[1]).toMatchObject({ _instrument: '0G_USDT', price: 0.419 });

    for (const row of rows) expect(Number(row['ts'])).toBe(1_780_272_000_000_000);
  });

  /** Thirteen unnamed values: the mark, the two sides of the quote, the greeks. */
  it('reads the option ticker', async () => {
    const rows = await rowsOf(TICKER, 'gate.options-ticker.part1780272000');
    const call = rows.find(row => row['option'] === 'BTC_USDT-20260603-80000-C')!;
    const put  = rows.find(row => row['option'] === 'BTC_USDT-20260603-80000-P')!;

    // Filed under the underlying, the contract named beside it.
    expect(new Set(rows.map(row => row['_instrument']))).toEqual(new Set(['BTC_USDT']));

    expect(call).toMatchObject({
      markPrice: 9.2, markIv: 0.4491, bidSize: 701, bidPrice: 4, bidIv: 0.4069,
      askSize: 200, askPrice: 17, askIv: 0.4875, delta: 0.01039, gamma: 0.00001, theta: -15.60348, vega: 1.62129,
    });
    expect(put).toMatchObject({ markPrice: 6430.4, bidPrice: 6162, askPrice: 6478, delta: -0.9896 });
    expect(Number(call['ts'])).toBe(1_780_272_000_000_000);

    // Every row's quote brackets its mark, which is what told the columns apart.
    for (const row of rows)
      expect(Number(row['bidPrice'])).toBeLessThanOrEqual(Number(row['askPrice']));
  });

  it('says a line holding more than the series names is wider than it', async () => {
    const series = seriesFor(parseKey(INDEX)!)!;
    const format = formatFor(series.format);
    const reader = await conn.runAndReadAll(
      format.overflow!([join(DIR, 'gate.options-ticker.part1780272000')], series)!);

    expect(reader.getRows()).toHaveLength(1);
  });

  /** Ticks carry no interval; an option's bars do. */
  it('gives ticks no interval level and bars one', () => {
    const ticker = seriesFor(parseKey(TICKER)!)!;
    const hourly = seriesFor(parseKey(
      'binance/option/optionSummary,1h/B/BNBUSDT/202305/binance|option|optionSummary,1h|BNBUSDT|20230518.zip')!)!;

    expect(extrasOf(ticker, 'ticks')).toEqual({});
    expect(extrasOf(hourly, '1h')).toEqual({ interval: '1h' });
  });
});
