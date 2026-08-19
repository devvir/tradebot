import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { grainOf, keyOf } from '../src/catalog/series';
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

/** One venue's `pattern.csv`, or nothing where it seeds no shapes. */
const patternsOf = (venue: string): Record<string, string>[] => {
  let text: string;

  try {
    text = readFileSync(join(SEEDS, venue, 'pattern.csv'), 'utf8');
  } catch {
    return [];
  }

  const [head, ...lines] = text.trim().split('\n');
  const names = head!.split(',');

  return lines.map(line => Object.fromEntries(fields(line).map((v, i) => [names[i]!, v])));
};

/** The same quoting rule `seed.ts` reads these with. */
const fields = (line: string): string[] => {
  const out: string[] = [];

  let value = '', quoted = false;

  for (const char of line) {
    if (char === '"') { quoted = ! quoted; continue; }

    if (char === ',' && ! quoted) { out.push(value); value = ''; continue; }

    value += char;
  }

  out.push(value);

  return out;
};

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
          } as unknown as Publishing;

          const key = keyOf(series, at, adapter.slotsFor);

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
