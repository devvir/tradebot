import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csv } from '../src/formats/csv';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { Series } from '../src/types';

/**
 * A CSV whose rows are narrower than its own header cannot be parsed at all —
 * DuckDB finds no delimiter that gives every line the same field count and
 * falls back to one column per line. The build then fails naming a column that
 * is visibly present in the file.
 *
 * KuCoin's futures `1d` klines are the real case: `time,open,high,low,close,
 * volume` declared, five fields written, on every row of every file of every
 * symbol.
 */
describe('a file that will not parse into columns', () => {
  let conn: DuckDBConnection;
  let dir:  string;

  const series = (over: Partial<Series> = {}): Series => ({
    source: 'trucker', venue: 'kucoin', table: 'klines', market: 'perp',
    match: /(?<symbol>x)/, container: 'none', format: 'csv', header: true,
    project: {}, ts: 'time', ...over,
  });

  const write = (name: string, body: string): string => {
    const path = join(dir, name);

    writeFileSync(path, body);

    return path;
  };

  beforeAll(async () => {
    conn = await (await DuckDBInstance.create(':memory:')).connect();
    dir  = mkdtempSync(join(tmpdir(), 'stocker-malformed-'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const offenders = async (paths: string[], s: Series): Promise<string[]> => {
    const query = csv.malformed!(paths, s);

    if (! query) return [];

    return (await conn.runAndReadAll(query)).getRows().map(row => String(row[0]));
  };

  it('names a file whose rows are short of its header', async () => {
    const bad = write('bad.csv',
      'time,open,high,low,close,volume\n1672531200000,0.38,0.39,0.37,0.38\n');

    expect(await offenders([bad], series())).toEqual([bad]);
  });

  it('says nothing about a well-formed file', async () => {
    const good = write('good.csv',
      'time,open,high,low,close,volume\n1,2,3,4,5,6\n2,3,4,5,6,7\n');

    expect(await offenders([good], series())).toEqual([]);
  });

  /** The point is to name the offender, not to condemn the whole partition. */
  it('picks the offender out of a set of good files', async () => {
    const a   = write('a.csv', 'time,open\n1,2\n2,3\n');
    const bad = write('b.csv', 'time,open,high\n1,2\n2,3\n');
    const c   = write('c.csv', 'time,open\n3,4\n4,5\n');

    expect(await offenders([a, bad, c], series())).toEqual([bad]);
  });

  /**
   * A venue that appends a column later is ordinary evolution — each file is
   * self-consistent, so each parses, and neither is malformed.
   */
  it('accepts files that disagree with each other but not with themselves', async () => {
    const older = write('older.csv', 'time,open\n1,2\n2,3\n');
    const newer = write('newer.csv', 'time,open,volume\n1,2,3\n2,3,4\n');

    expect(await offenders([older, newer], series())).toEqual([]);
  });

  /**
   * A positional read declares its own names and pads short rows deliberately,
   * so it parses whatever it is handed and the question never arises.
   */
  it('does not apply to positional reads', () => {
    expect(csv.malformed!(['x.csv'], series({ header: false }))).toBeNull();
  });
});
