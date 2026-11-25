import { beforeEach, describe, expect, it } from 'vitest';
import { BUNDLES, GRAINS, problemsWith } from '../src';
import { scratch } from './db';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Whether a definition can be stored.
 *
 * **A definition arrives as whatever somebody sent**, so every malformed shape is
 * answered with a problem placed where it is — and never with an exception, which
 * would answer a form with a failure of the server.
 */

let db: DatabaseSync;

beforeEach(() => {
  db = scratch();
  db.prepare("INSERT INTO venue (name) VALUES ('binance'), ('bybit')").run();
});

const rules = (venue: string, list: unknown): unknown => ({ format: 1, venues: { [venue]: list } });

const one = (rule: unknown): unknown => rules('binance', [rule]);

describe('a definition of the right shape', () => {
  it('has no problems', () => {
    expect(problemsWith(db, one({
      effect: 'include', markets: ['spot'], datasets: [{ dataset: 'klines', variant: '1m' }, { dataset: 'trades' }],
      grain: { prefer: 'monthly' }, bundle: { only: 'market' }, from: '202001', to: '202012',
    }))).toEqual([]);

    expect(problemsWith(db, rules('*', [{ effect: 'exclude' }]))).toEqual([]);
  });

  it('has none where it names no venues', () => {
    expect(problemsWith(db, { format: 1 })).toEqual([]);
    expect(problemsWith(db, { format: 1, venues: {} })).toEqual([]);
  });

  it('has none where it leaves the format out', () => {
    expect(problemsWith(db, { venues: { binance: [{ effect: 'include' }] } })).toEqual([]);
  });

  it('takes every grain and every bundle there is, only or preferred', () => {
    for (const grain of GRAINS)
      expect(problemsWith(db, one({ effect: 'include', grain: { only: grain } }))).toEqual([]);

    for (const bundle of BUNDLES)
      expect(problemsWith(db, one({ effect: 'include', bundle: { prefer: bundle } }))).toEqual([]);
  });
});

describe('a definition that is not one', () => {
  it('refuses one that is not a document', () => {
    for (const definition of [null, 'x', 5, []])
      expect(problemsWith(db, definition)).toMatchObject([{ venue: '', rule: -1 }]);
  });

  it('refuses a format other than the one there is', () => {
    for (const format of [2, 0, '1', null])
      expect(problemsWith(db, { format, venues: {} })).toMatchObject([{ venue: '', rule: -1 }]);

    // The rules are still weighed beside it.
    expect(problemsWith(db, { format: 2, venues: { binance: [{ effect: 'drop' }] } })).toMatchObject([
      { venue: '', rule: -1 },
      { venue: 'binance', rule: 0, field: 'effect' },
    ]);
  });

  it('refuses venues that are not named', () => {
    expect(problemsWith(db, { format: 1, venues: 'x' })).toMatchObject([{ venue: '', rule: -1 }]);
    expect(problemsWith(db, { format: 1, venues: ['binance'] })).toMatchObject([{ venue: '', rule: -1 }]);
  });

  it('refuses a venue whose rules are not a list', () => {
    expect(problemsWith(db, rules('binance', {}))).toMatchObject([{ venue: 'binance', rule: -1 }]);
    expect(problemsWith(db, rules('binance', null))).toMatchObject([{ venue: 'binance', rule: -1 }]);
  });

  it('refuses a rule that is not a document', () => {
    expect(problemsWith(db, rules('binance', [null]))).toMatchObject([{ venue: 'binance', rule: 0 }]);
    expect(problemsWith(db, rules('binance', [{ effect: 'include' }, 'include'])))
      .toMatchObject([{ venue: 'binance', rule: 1 }]);
  });
});

describe('a rule that is not one', () => {
  it('refuses an effect that is neither include nor exclude', () => {
    expect(problemsWith(db, one({ effect: 'maybe' }))).toMatchObject([{ rule: 0, field: 'effect' }]);
    expect(problemsWith(db, one({ effect: 'Exclude' }))).toMatchObject([{ field: 'effect' }]);
    expect(problemsWith(db, one({}))).toMatchObject([{ field: 'effect' }]);
  });

  it('refuses markets that are not a list of names', () => {
    expect(problemsWith(db, one({ effect: 'include', markets: 5 }))).toMatchObject([{ field: 'markets' }]);

    // A string would be matched by substring: 'inverse-perp' would let 'perp' through.
    expect(problemsWith(db, one({ effect: 'include', markets: 'perp' }))).toMatchObject([{ field: 'markets' }]);
    expect(problemsWith(db, one({ effect: 'include', markets: ['spot', 3] }))).toMatchObject([{ field: 'markets' }]);
  });

  it('refuses datasets that are not a list of datasets', () => {
    expect(problemsWith(db, one({ effect: 'include', datasets: 'trades' }))).toMatchObject([{ field: 'datasets' }]);
    expect(problemsWith(db, one({ effect: 'include', datasets: ['trades'] }))).toMatchObject([{ field: 'datasets' }]);
    expect(problemsWith(db, one({ effect: 'include', datasets: [{}] }))).toMatchObject([{ field: 'datasets' }]);
    expect(problemsWith(db, one({ effect: 'include', datasets: [{ dataset: 'klines', variant: 1 }] })))
      .toMatchObject([{ field: 'datasets' }]);
    expect(problemsWith(db, one({ effect: 'include', datasets: [{ dataset: 'klines', grain: 'daily' }] })))
      .toMatchObject([{ field: 'datasets' }]);
  });

  it('refuses a grain or a bundle not written as only or prefer', () => {
    expect(problemsWith(db, one({ effect: 'include', grain: 'monthly' }))).toMatchObject([{ field: 'grain' }]);
    expect(problemsWith(db, one({ effect: 'include', grain: { only: 'monthly', prefer: 'daily' } })))
      .toMatchObject([{ field: 'grain' }]);
    expect(problemsWith(db, one({ effect: 'include', bundle: {} }))).toMatchObject([{ field: 'bundle' }]);
    expect(problemsWith(db, one({ effect: 'include', bundle: null }))).toMatchObject([{ field: 'bundle' }]);
    expect(problemsWith(db, one({ effect: 'include', grain: { only: 5 } }))).toMatchObject([{ field: 'grain' }]);
    expect(problemsWith(db, one({ effect: 'include', bundle: { prefer: ['market'] } }))).toMatchObject([{ field: 'bundle' }]);
  });

  /** A number would pass a pattern by being turned into a string, and then could not be read as a month. */
  it('refuses a bound that is not a string', () => {
    expect(problemsWith(db, one({ effect: 'include', from: 202003 }))).toMatchObject([{ field: 'from' }]);
    expect(problemsWith(db, one({ effect: 'include', to: 202003 }))).toMatchObject([{ field: 'to' }]);
    expect(problemsWith(db, one({ effect: 'include', to: null }))).toMatchObject([{ field: 'to' }]);
  });

  it('refuses a part no rule has', () => {
    expect(problemsWith(db, one({ effect: 'include', variants: ['1m'] })))
      .toMatchObject([{ rule: 0, message: expect.stringContaining("'variants'") }]);
  });

  it('places each problem at its rule, and weighs the rules beside it as usual', () => {
    expect(problemsWith(db, rules('binance', [
      { effect: 'include', markets: 'perp' },
      { effect: 'include', from: '202013' },
      { effect: 'include' },
    ]))).toMatchObject([
      { venue: 'binance', rule: 0, field: 'markets' },
      { venue: 'binance', rule: 1, field: 'from' },
    ]);
  });
});

describe('a rule of the right shape', () => {
  it('still has what it says weighed', () => {
    expect(problemsWith(db, one({ effect: 'include', grain: { only: 'weekly' } }))).toMatchObject([{ field: 'grain' }]);
    expect(problemsWith(db, one({ effect: 'exclude', bundle: { prefer: 'market' } }))).toMatchObject([{ field: 'bundle' }]);
    expect(problemsWith(db, one({ effect: 'include', from: '202101', to: '202012' }))).toMatchObject([{ field: 'to' }]);
    expect(problemsWith(db, rules('nowhere', [{ effect: 'include' }]))).toMatchObject([{ venue: 'nowhere', rule: -1 }]);
  });
});

describe('whatever is sent', () => {
  /** Every malformed shape a sender can make, each at the depth it goes wrong at. */
  const malformed: unknown[] = [
    undefined, null, 'junk', 12, true, [], [1],
    { format: 'one' },
    { format: 1, venues: 'binance' },
    { format: 1, venues: [1] },
    { format: 1, venues: { binance: 'abc' } },
    { format: 1, venues: { binance: { rules: [null] } } },
    rules('binance', [null]),
    rules('binance', [[]]),
    rules('binance', ['include']),
    rules('*', [{ effect: 'drop' }]),
    one({ effect: 'include', markets: 'spotx' }),
    one({ effect: 'include', markets: [null] }),
    one({ effect: 'include', datasets: 'klines' }),
    one({ effect: 'include', datasets: [null] }),
    one({ effect: 'include', datasets: [{ dataset: 5 }] }),
    one({ effect: 'include', datasets: [{ dataset: 'klines', variant: null }] }),
    one({ effect: 'include', grain: 'daily' }),
    one({ effect: 'include', grain: { only: null } }),
    one({ effect: 'include', grain: { only: { prefer: 'daily' } } }),
    one({ effect: 'include', bundle: [] }),
    one({ effect: 'include', from: 202001 }),
    one({ effect: 'include', from: ['202001'] }),
    one({ effect: 'include', to: { month: '202001' } }),
    one({ effect: 'include', from: '2020-01' }),
    one({ effect: 'include', note: 'x' }),
  ];

  it('is answered with problems, never with an exception', () => {
    for (const definition of malformed) {
      let problems: unknown;

      expect(() => { problems = problemsWith(db, definition); }, JSON.stringify(definition)).not.toThrow();
      expect(problems, JSON.stringify(definition)).not.toEqual([]);
    }
  });
});
