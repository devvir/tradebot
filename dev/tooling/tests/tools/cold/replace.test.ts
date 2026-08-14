import { describe, expect, it } from 'vitest';
import { _test_compare as compare } from '../../../src/tools/cold/push';

/**
 * Overwriting an object in cold storage is a delete and an add in one step, so
 * it carries the risk of a delete. These decide whether it is safe.
 */
const held = (over: Record<string, [number, number]>) =>
  new Map(Object.entries(over).map(([path, [bytes, mtime]]) => [path, { bytes, mtime }]));

describe('what a replacement would do to the object it lands on', () => {
  it('sees an addition as adding nothing lost', () => {
    const { lost, moved, added } = compare(
      held({ a: [10, 1] }),
      held({ a: [10, 1], b: [20, 2] }));

    expect({ lost, moved, added }).toEqual({ lost: [], moved: [], added: ['b'] });
  });

  it('sees a removal', () => {
    expect(compare(held({ a: [10, 1], b: [20, 2] }), held({ a: [10, 1] })).lost).toEqual(['b']);
  });

  it('sees a file rewritten in place, by size or by time', () => {
    expect(compare(held({ a: [10, 1] }), held({ a: [11, 1] })).moved).toEqual(['a']);
    expect(compare(held({ a: [10, 1] }), held({ a: [10, 2] })).moved).toEqual(['a']);
  });

  /**
   * A smaller tar is not evidence of loss and a larger one is not evidence of
   * safety — files get repacked and redistributed between bins. Only membership
   * answers the question.
   */
  it('judges membership rather than size', () => {
    const shrunk = compare(held({ a: [1000, 1] }), held({ a: [1000, 1], b: [1, 2] }));

    expect(shrunk.lost).toEqual([]);

    const grown = compare(held({ a: [1, 1] }), held({ b: [9999, 2] }));

    expect(grown.lost).toEqual(['a']);
  });

  it('reports identical contents as nothing at all', () => {
    const { lost, moved, added } = compare(held({ a: [10, 1] }), held({ a: [10, 1] }));

    expect([...lost, ...moved, ...added]).toEqual([]);
  });
});
