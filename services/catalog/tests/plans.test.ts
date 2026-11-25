import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scratch } from './fixture';
import { _test_statements as statements } from '../src/listings/listing';
import type { Scratch } from './types';

/**
 * How SQLite plans the listing's page queries on prospector's schema: what a
 * page reads is decided here, and a plan that reads more is still correct, so
 * only the plan can say it.
 */

let catalog: Scratch;

beforeEach(() => { catalog = scratch(); });
afterEach(() => catalog.close());

/** The steps of a statement's plan, as SQLite words them. */
const planOf = (sql: string): string[] =>
  (catalog.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(one => one.detail);

describe('a listing page', () => {
  const pages = (): [string, string[]][] =>
    Object.entries(statements(catalog.db)).map(([name, statement]) => [name, planOf(statement.sourceSQL)]);

  it('walks the series in prefix order from where the page starts, to where the prefix ends', () => {
    for (const [name, plan] of pages())
      expect([name, plan[0]]).toEqual([name, 'SEARCH s USING INDEX series_prefix (prefix>? AND prefix<?)']);
  });

  /** Unfiltered, the cursor's date is the only lower bound, so this is where the seek shows. */
  it('seeks each series\' files by date, past what is behind the cursor', () => {
    expect(planOf(statements(catalog.db)['all:any']!.sourceSQL))
      .toContain('SEARCH f USING INDEX file_series (series_id=? AND date>?)');
  });

  it('reads files through an index on series and date, the owed through the index of what is owed', () => {
    for (const [name, plan] of pages()) {
      const index = name.endsWith(':pending') ? 'file_pending' : 'file_series';

      expect([name, plan.some(step => step.startsWith(`SEARCH f USING INDEX ${index} (series_id=? AND date>?`))])
        .toEqual([name, true]);
    }
  });
});
