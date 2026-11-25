import { describe, expect, it } from 'vitest';
import { groupBy } from '../../../src/tools/cold/shared/group';

describe('grouping by a key', () => {
  it('keeps the groups in the order their keys first came, and each group in the order its items came', () => {
    const groups = groupBy(['b1', 'a1', 'b2', 'c1', 'a2'], one => one[0]!);

    expect([...groups]).toEqual([['b', ['b1', 'b2']], ['a', ['a1', 'a2']], ['c', ['c1']]]);
  });

  it('leaves out an item whose key is null', () => {
    const groups = groupBy([1, 2, 3, 4, 5], n => (n % 2 === 0 ? null : 'odd'));

    expect([...groups]).toEqual([['odd', [1, 3, 5]]]);
  });

  it('takes any iterable', () => {
    expect(groupBy(new Set(['x', 'y']), () => 0).get(0)).toEqual(['x', 'y']);
  });

  /** A partition is every instrument of a dataset for a month: hundreds of thousands of files in one group. */
  it('groups hundreds of thousands of items under one key', () => {
    const items  = Array.from({ length: 200_000 }, (_, at) => ({ at }));
    const groups = groupBy(items, () => 'one');

    expect(groups.get('one')).toHaveLength(200_000);
    expect(groups.get('one')![199_999]).toBe(items[199_999]);
  }, 30_000);
});
