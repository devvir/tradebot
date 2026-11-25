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
