import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csv } from '../src/formats/csv';
import { seriesFor } from '../src/schema/series';

/**
 * A positional map is a claim about what each column *is*, so it only holds
 * while the width matches.
 *
 * Gate is why this guard exists: for 2021-07 it served truncated copies of its
 * **spot** files at the futures URL — 85 symbols — and spot carries an extra
 * column (`ts, id, price, size, side` against the futures `ts, id, price,
 * signed size`). The first four columns still parsed, so 65 partitions were
 * built with the spot size where the signed futures size belongs, and every
 * trade in them came out `buy` because the side is derived from that sign.
 */

let dir: string;
let instance: DuckDBInstance;
let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

const file = (name: string, rows: string[]): string => {
  const path = join(dir, name);

  execFileSync('bash', ['-c',
    `printf '%s\\n' ${rows.map(r => JSON.stringify(r)).join(' ')} | gzip > ${JSON.stringify(path)}`]);

  return path;
};

/** Gate futures trades: headerless, four declared columns. */
const series = () =>
  seriesFor('gate', 'futures_usdt/trades/202107/FIDA_USDT-202107.csv.gz')!.series;

const wider = async (paths: string[]): Promise<string[]> => {
  const query = csv.overflow!(paths, series());

  if (! query) return [];

  return (await conn.runAndReadAll(query)).getRows().map(row => String(row[0]));
};

beforeAll(async () => {
  dir      = await mkdtemp(join(tmpdir(), 'width-'));
  instance = await DuckDBInstance.create(':memory:');
  conn     = await instance.connect();
});

afterAll(async () => {
  conn?.closeSync?.();
  await rm(dir, { recursive: true, force: true });
});

describe('files wider than the series describes', () => {
  const futures = ['1627775996.068627, 3487060, 21.739700, 2',
                   '1627775995.127478, 3487059, 21.733300, -5'];
  const spot    = ['1627775982.133299, 1389302462, 1.985000, 2.063000, 2',
                   '1627775885.090530, 1389295735, 1.981000, 8.470000, 2'];

  it('passes a file of exactly the declared width', async () => {
    expect(await wider([file('futures.csv.gz', futures)])).toEqual([]);
  });

  it('flags a file carrying an extra column', async () => {
    const path = file('spot.csv.gz', spot);

    expect(await wider([path])).toEqual([path]);
  });

  it('names the offender out of a mixed month', async () => {
    const good = file('good.csv.gz', futures);
    const bad  = file('bad.csv.gz', spot);

    expect(await wider([good, bad])).toEqual([bad]);
  });

  /**
   * The asymmetry that makes the guard safe: `null_padding` exists precisely so
   * a file written before a column was appended still reads, and those files
   * are *short*. Only extra columns mean "this is not that file".
   */
  it('accepts a file that is short, which is what null_padding is for', async () => {
    const short = file('short.csv.gz', ['1627775996.068627, 3487060, 21.739700']);

    expect(await wider([short])).toEqual([]);
  });

  it('does not ask the question of a header-mapped series', () => {
    const headed = seriesFor('bybit', 'trading/BTCUSDT/BTCUSDT2024-01-01.csv.gz')!.series;

    expect(headed.header).toBe(true);
    expect(csv.overflow!(['x.csv.gz'], headed)).toBeNull();
  });
});
