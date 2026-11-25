import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { grainOf, keyOf } from '../src/catalog/series';
import { WIDTH } from '../src/dates';
import { parseCsv } from '../src/database/migrations/seeds/seed';
import { adaptersFor } from '../src/venues';
import type { Grain, Publishing } from '../src/types';

/**
 * A seed and the adapter that consumes it are two halves of one contract, and
 * nothing was asserting it.
 *
 * **A key whose date the adapter cannot read is discarded before it reaches
 * `wip`** — no row, no warning, nothing in `unreadable`. So a shape seeded with
 * a stamp `dateOf` does not match generates its whole keyspace, has every key
 * thrown away, and reports an archive that holds nothing. That is what happened
 * to bitget's four monthly trees: 11,903 series, 0 files, and no symptom
 * anywhere except the absence itself.
 *
 * These run over the shipped CSVs rather than over fixtures, because the point
 * is to fail when somebody adds a pattern — which is the moment nobody is
 * thinking about `dateOf`.
 */

const SEEDS = join(__dirname, '../src/database/migrations/seeds');

/** One of a venue's seed files, read as the loader reads it, or nothing where it has none. */
const tableOf = (venue: string, table: string): Record<string, string>[] => {
  const path = join(SEEDS, venue, `${table}.csv`);

  return existsSync(path) ? parseCsv(readFileSync(path, 'utf8'), `${venue}/${table}.csv`) : [];
};

/** One venue's `pattern.csv`, or nothing where it seeds no shapes. */
const patternsOf = (venue: string): Record<string, string>[] => tableOf(venue, 'pattern');

/** A stamp of the width each grain writes. */
const STAMP: Record<Grain, string> = {
  monthly:  '202606',
  daily:    '20260601',
  hourly:   '2026060107',
  minutely: '202606010730',
};

const seeded = adaptersFor([]).filter(one => patternsOf(one.name).length > 0);

describe('every seeded pattern round-trips through its adapter', () => {
  it('has a venue to check, or this file asserts nothing', () => {
    expect(seeded.length).toBeGreaterThan(0);
  });

  for (const adapter of seeded)
    describe(adapter.name, () => {
      for (const row of patternsOf(adapter.name))
        it(`${row.market} ${row.dataset} ${row.pattern}`, () => {
          const grain = grainOf(row.pattern!);
          const at    = STAMP[grain];

          const series = {
            pattern:   row.pattern!,
            symbol:    'BTCUSDT',
            urlSymbol: null,
            first:     null,
          } as unknown as Publishing;

          /**
           * A pattern published in parts is never keyed without one, so the
           * round-trip asks the adapter for the period's opening part exactly as
           * generation does.
           */
          const opening = row.pattern!.includes('{PART}')
            ? adapter.expandParts?.({ series, date: at, lastPartFound: null, nextPart: '' })
            : null;

          const first = opening === null || opening === undefined ? ''
                      : (Array.isArray(opening.parts) ? opening.parts[0]! : opening.parts);

          expect(! row.pattern!.includes('{PART}') || first !== '',
                 'a parted pattern whose adapter offers no part').toBe(true);

          const key = keyOf(series, at, adapter.slotsFor, first);

          /** A slot left unfilled means the pattern wants something no seed states. */
          expect(key, 'a slot nothing filled').not.toMatch(/\{[A-Z]/);

          /**
           * **The whole point.** `dateOf` is what places a key in a period, and a
           * key it cannot read is silently dropped — so every shape a seed ships
           * must produce a key its venue can read the date back out of.
           */
          expect(adapter.dateOf?.(key) ?? null, `dateOf could not read ${key}`).toBe(at);
        });
    });
});

/**
 * **A bound is a stamp at its series' grain.** A `floor` or `last` of another
 * width is read as some other period — an eight-digit floor on a monthly shape
 * steps back to a month that does not exist.
 */
describe('every seeded series states its bounds at its pattern\'s grain', () => {
  const venues = readdirSync(SEEDS, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(SEEDS, entry.name, 'series.csv')))
    .map(entry => entry.name);

  it('has a venue to check, or this block asserts nothing', () => {
    expect(venues.length).toBeGreaterThan(0);
  });

  for (const venue of venues)
    it(venue, () => {
      const grains = new Map(patternsOf(venue).map(row => [row.virtual_id!, grainOf(row.pattern!)]));

      const wrong = tableOf(venue, 'series').flatMap(row => {
        const width = WIDTH[grains.get(row.pattern_id!)!];

        return (['floor', 'last'] as const)
          .filter(column => row[column] && row[column]!.length !== width)
          .map(column => `${row.pattern_id} ${row.symbol} ${column}=${row[column]}`);
      });

      expect(wrong).toEqual([]);
    });
});
