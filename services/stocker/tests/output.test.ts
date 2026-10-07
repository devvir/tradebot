import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csv } from '../src/formats/csv';
import { parseKey } from '../src/keys';
import { selectFor } from '../src/schema/project';
import { seriesFor } from '../src/schema/series';
import { versionsOf } from '../src/versions';
import type { Series } from '../src/types';

/**
 * What is written of each fixture, held against a record of it.
 *
 * A partition is stocked again only when a version says its output changed —
 * see `versions.ts` — and a version is bumped by hand. This is what notices the
 * hand that did not: each fixture is read through its entry of the map, and a
 * digest of the columns, their types and the rows is compared with the one
 * recorded beside the versions it was made under.
 *
 * - **The digest moved and the versions did not**: what is written changed and
 *   nothing says so. Bump the level that covers the change, then record.
 * - **The versions moved**: record what is written now.
 *
 * `STOCKER_RECORD_OUTPUT=1` records — a fixture that has no record, and one
 * whose versions moved. It never records over a digest whose versions did not.
 *
 * Covers what the map reads as a table. It says nothing of the order a build
 * writes rows in, which is the build's and not the map's.
 */

interface Fixture {
  fixture: string;
  key:     string;
}

interface Recorded {
  versions: string;
  digest:   string;
}

const DIR       = join(__dirname, 'fixtures');
const RECORD    = join(DIR, 'output.json');
const FIXTURES  = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Fixture[];
const RECORDED  = (existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : {}) as Record<string, Recorded>;
const RECORDING = process.env['STOCKER_RECORD_OUTPUT'] === '1';

const fresh: Record<string, Recorded> = {};

let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(':memory:')).connect();
});

afterAll(() => {
  conn?.closeSync?.();

  if (! RECORDING || Object.keys(fresh).length === 0) return;

  const all = { ...RECORDED, ...fresh };

  writeFileSync(RECORD, `${JSON.stringify(Object.fromEntries(Object.keys(all).sort().map(name => [name, all[name]])), null, 2)}\n`);
});

const resolve = (fixture: Fixture): Series | null => seriesFor(parseKey(fixture.key)!);

/** `YYYY-MM`, off the month folder of a catalog key. */
const monthOf = (key: string): string => key.replace(/^.*\/(\d{4})(\d{2})\/[^/]+$/, '$1-$2');

/** The columns, their types and every row a fixture is written as, as one digest. */
const digestOf = async (series: Series, fixture: string): Promise<string> => {
  const reader = await conn.runAndReadAll(`SELECT * FROM (${selectFor(series, csv.relation([join(DIR, fixture)], series))})`);

  const shape = reader.columnNames().map((name, at) => [name, String(reader.columnTypes()[at])]);
  const rows  = JSON.stringify(reader.getRows(), (_key, value: unknown) => typeof value === 'bigint' ? `${value}n` : value);

  return createHash('sha256').update(JSON.stringify(shape)).update(rows).digest('hex').slice(0, 16);
};

const mapped = FIXTURES.filter(f => ['csv', 'xlsx'].includes(resolve(f)?.format ?? ''));

describe('what is written of each fixture', () => {
  it.each(mapped.map(f => [f.fixture, f] as const))('%s — is what was recorded, or a version says it changed', async (name, fixture) => {
    const series = resolve(fixture)!;

    const now: Recorded = {
      versions: versionsOf(series.table, [series], monthOf(fixture.key)).join(' '),
      digest:   await digestOf(series, name),
    };

    const was = RECORDED[name];

    if (RECORDING && (! was || was.versions !== now.versions)) {
      fresh[name] = now;

      return;
    }

    expect(was, 'no record of this fixture — run the tests once with STOCKER_RECORD_OUTPUT=1').toBeDefined();

    if (was!.versions === now.versions)
      expect(now.digest, 'what is written changed and no version says so — bump the level that covers it (versions.ts, or the series), then record').toBe(was!.digest);
    else
      expect(now, 'a version moved — record what is written now with STOCKER_RECORD_OUTPUT=1').toEqual(was);
  });
});
