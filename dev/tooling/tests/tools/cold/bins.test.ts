import { describe, expect, it } from 'vitest';
import { binsOf } from '../../../src/tools/cold/bins';
import type { CatalogPartition } from '../../../src/tools/cold/types';

const GB = 1024 ** 3;

const partition = (dataset: string, gb: number): CatalogPartition => ({
  venue: 'gate', market: 'spot', dataset, variant: '', grain: 'daily', bundle: 'instrument',
  month: '202001', files: 1, bytes: gb * GB, version: 'v',
});

const shape = (bins: ReturnType<typeof binsOf>): string[][] =>
  bins.map(bin => bin.partitions.map(one => one.dataset));

/**
 * A tar holds whole partitions and nothing less, so the cap is where a clean
 * cut is looked for and never a limit on any one of them.
 */
describe('dividing a venue-month into tars', () => {
  it('puts a partition heavier than the cap in a tar of its own, whatever it weighs', () => {
    const bins = binsOf([partition('books', 50), partition('trades', 1)], 5 * GB);

    expect(shape(bins)).toEqual([['books'], ['trades']]);
    expect(bins[0]!.bytes).toBe(50 * GB);
  });

  it('fills each tar to about the cap with the rest, heaviest first', () => {
    const bins = binsOf([
      partition('a', 3), partition('b', 3), partition('c', 2), partition('d', 1), partition('e', 1),
    ], 5 * GB);

    expect(shape(bins)).toEqual([['a', 'c'], ['b', 'd', 'e']]);
    expect(bins.every(bin => bin.bytes <= 5 * GB)).toBe(true);
  });

  it('never divides a partition, and loses none', () => {
    const all  = Array.from({ length: 40 }, (_, at) => partition(`d${at}`, (at % 7) + 0.5));
    const bins = binsOf(all, 5 * GB);

    expect(bins.flatMap(bin => bin.partitions).map(one => one.dataset).sort())
      .toEqual(all.map(one => one.dataset).sort());
  });

  /** A plan interrupted and made again has to come out the same. */
  it('divides the same partitions the same way in any order', () => {
    const all = [partition('a', 2), partition('b', 2), partition('c', 2), partition('d', 4)];

    expect(shape(binsOf([...all].reverse(), 5 * GB))).toEqual(shape(binsOf(all, 5 * GB)));
  });
});
