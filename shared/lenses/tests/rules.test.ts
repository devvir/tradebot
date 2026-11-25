import { describe, expect, it } from 'vitest';
import { letThrough, spansFor } from '../src/rules';
import type { LensRule, PartitionMember } from '../src/types';

/**
 * The two evaluations of a lens's rules — the months of a slice (`spansFor`) and
 * the partitions of a month (`letThrough`) — must tell the same story, or what a
 * lens is described as letting through is not what it lets through.
 */

const partition = (partitionId: number, traits: Partial<PartitionMember>): PartitionMember => ({
  id: partitionId, partitionId, venue: 'binance', market: 'spot', dataset: 'trades', variant: '',
  grain: 'monthly', bundle: 'instrument', month: '202006', ...traits,
});

/** Every one of these partitions is its own slice, at one month: a partition is let through where its slice's spans hold its month. */
const agree = (rules: LensRule[], partitions: PartitionMember[]): void => {
  const spanned = partitions.filter(one => spansFor(one, rules).some(span =>
    (span.from === null || one.month >= span.from) && (span.to === null || one.month <= span.to)));

  const kept = partitions.flatMap(one => letThrough(rules, [one]));

  expect(kept.map(one => one.partitionId)).toEqual(spanned.map(one => one.partitionId));
};

const partitions = [
  partition(1, { market: 'spot',         dataset: 'trades', month: '201912' }),
  partition(2, { market: 'spot',         dataset: 'trades', month: '202006' }),
  partition(3, { market: 'spot',         dataset: 'books',  month: '202006' }),
  partition(4, { market: 'inverse-perp', dataset: 'trades', month: '202006' }),
  partition(5, { market: 'inverse-perp', dataset: 'books',  month: '202106' }),
];

describe('the months and the partitions a lens lets through', () => {
  it('agree where excludes take away from includes', () => {
    agree([
      { effect: 'include', from: '202001' },
      { effect: 'exclude', datasets: [{ dataset: 'books' }], to: '202012' },
      { effect: 'exclude', markets: ['inverse-perp'], from: '202101' },
    ], partitions);
  });

  it('agree whichever order the rules are in', () => {
    agree([
      { effect: 'exclude', markets: ['spot'], datasets: [{ dataset: 'trades' }], to: '201912' },
      { effect: 'include' },
    ], partitions);
  });

  /** An effect that is neither is a rule that says nothing, in both. */
  it('agree on a rule whose effect is neither include nor exclude', () => {
    const rules = [
      { effect: 'include' },
      { effect: 'Exclude', markets: ['inverse-perp'] },
    ] as unknown as LensRule[];

    agree(rules, partitions);
    expect(partitions.flatMap(one => letThrough(rules, [one]))).toHaveLength(partitions.length);
  });
});

/** One month of one dataset, published in the forms given: the siblings `letThrough` chooses among. */
const forms = (...shapes: Array<Pick<PartitionMember, 'grain' | 'bundle'>>): PartitionMember[] =>
  shapes.map((shape, at) => partition(at + 1, shape));

const keptForms = (rules: LensRule[], siblings: PartitionMember[]) =>
  letThrough(rules, siblings).map(one => `${one.bundle}/${one.grain}`);

describe('the forms of a month a rule keeps', () => {
  it('keeps the preferred form alone where it is published', () => {
    const siblings = forms({ bundle: 'instrument', grain: 'monthly' }, { bundle: 'instrument', grain: 'daily' });

    expect(keptForms([{ effect: 'include', grain: { prefer: 'monthly' } }], siblings)).toEqual(['instrument/monthly']);
  });

  it('keeps what is published where the preferred form is not', () => {
    const siblings = forms({ bundle: 'instrument', grain: 'daily' });

    expect(keptForms([{ effect: 'include', grain: { prefer: 'monthly' } }], siblings)).toEqual(['instrument/daily']);
    expect(keptForms([{ effect: 'include', bundle: { prefer: 'market' } }], siblings)).toEqual(['instrument/daily']);
  });

  it('settles the bundle before the grain', () => {
    const siblings = forms({ bundle: 'instrument', grain: 'monthly' }, { bundle: 'market', grain: 'daily' });
    const rules: LensRule[] = [{ effect: 'include', bundle: { prefer: 'instrument' }, grain: { prefer: 'daily' } }];

    expect(keptForms(rules, siblings)).toEqual(['instrument/monthly']);
  });

  it('keeps the preferred grain within the preferred bundle', () => {
    const siblings = forms(
      { bundle: 'instrument', grain: 'monthly' }, { bundle: 'instrument', grain: 'daily' },
      { bundle: 'market',     grain: 'monthly' }, { bundle: 'market',     grain: 'daily' },
    );
    const rules: LensRule[] = [{ effect: 'include', bundle: { prefer: 'market' }, grain: { prefer: 'daily' } }];

    expect(keptForms(rules, siblings)).toEqual(['market/daily']);
  });

  it('adds up what each include keeps', () => {
    const siblings = forms({ bundle: 'instrument', grain: 'monthly' }, { bundle: 'instrument', grain: 'daily' });
    const rules: LensRule[] = [
      { effect: 'include', grain: { prefer: 'monthly' } },
      { effect: 'include', grain: { only: 'daily' } },
    ];

    expect(keptForms(rules, siblings)).toEqual(['instrument/monthly', 'instrument/daily']);
  });
});

describe('an exclude', () => {
  const siblings = forms({ bundle: 'instrument', grain: 'monthly' }, { bundle: 'market', grain: 'monthly' });

  it('takes out what it matches, whatever include kept it, wherever it sits', () => {
    const exclude: LensRule = { effect: 'exclude', bundle: { only: 'market' } };
    const include: LensRule = { effect: 'include' };

    expect(keptForms([include, exclude], siblings)).toEqual(['instrument/monthly']);
    expect(keptForms([exclude, include], siblings)).toEqual(['instrument/monthly']);
  });

  it('takes out a form an include preferred, and does not bring back the one it passed over', () => {
    const rules: LensRule[] = [
      { effect: 'include', bundle: { prefer: 'market' } },
      { effect: 'exclude', bundle: { only: 'market' } },
    ];

    expect(keptForms(rules, siblings)).toEqual([]);
  });

  it('cuts a hole in the months an include spans, whichever comes first', () => {
    const slice   = partition(1, {});
    const include: LensRule = { effect: 'include', from: '202001', to: '202012' };
    const exclude: LensRule = { effect: 'exclude', from: '202004', to: '202006' };
    const spans   = [{ from: '202001', to: '202003' }, { from: '202007', to: '202012' }];

    expect(spansFor(slice, [include, exclude])).toEqual(spans);
    expect(spansFor(slice, [exclude, include])).toEqual(spans);
  });

  it('beats an include it covers whole', () => {
    const slice = partition(1, {});

    expect(spansFor(slice, [{ effect: 'include', from: '202003' }, { effect: 'exclude' }])).toEqual([]);
  });
});
