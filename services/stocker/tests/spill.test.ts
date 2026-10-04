import { describe, expect, it } from 'vitest';
import { parseKey } from '../src/keys';
import { _test_groupsOf as groupsOf } from '../src/scan';
import { clipFor, reachOf } from '../src/spill';
import type { DiskFile, Series, Spill } from '../src/types';

/**
 * Bitget's buckets cut at 16:00 UTC, so the file dated the 1st of a month opens
 * at 16:00 on the last day of the previous one. A month is built from its own
 * files plus the next month's first bucket, and clipped to its own bounds.
 */

const seriesOf = (spill?: Spill): Series => ({
  venue: 'bitget', market: 'spot', dataset: 'trades', table: 'trades',
  format: 'csv', header: true, project: {}, ts: 't', spill,
});

const disk = (symbol: string, date: string): DiskFile => ({
  absolute: `/archives/${symbol}/${date}`,
  file: parseKey(`bitget/spot/trades/B/${symbol}/${date.slice(0, 6)}/bitget|spot|trades|${symbol}|${date}.part001.zip`)!,
  size: 1,
  mtimeMs: 0,
});

describe('what a spilling month reaches into', () => {
  it('reaches into nothing when the buckets match UTC', () => {
    expect(reachOf(undefined)).toEqual([]);
  });

  it('reaches into the next month\'s first bucket when spilling back', () => {
    expect(reachOf('back')).toEqual([{ by: 1, side: 'first' }]);
  });

  it('reaches into the previous month\'s last bucket when spilling forward', () => {
    expect(reachOf('forward')).toEqual([{ by: -1, side: 'last' }]);
  });

  it('reaches both ways when spilling both', () => {
    expect(reachOf('both')).toHaveLength(2);
  });
});

describe('clipFor', () => {
  it('is inert for an aligned series', () => {
    expect(clipFor(seriesOf(), '2025-01')).toBe('');
  });

  it('bounds a spilling series to exactly its month, in microseconds', () => {
    expect(clipFor(seriesOf('back'), '2025-01')).toBe(` AND ts >= ${Date.UTC(2025, 0, 1) * 1000}` +
      ` AND ts < ${Date.UTC(2025, 1, 1) * 1000}`);
  });
});

describe('handing a neighbour\'s edge to the instruments that need it', () => {
  it('adds each instrument its own share of the neighbour\'s first bucket', () => {
    const groups = groupsOf(
      [disk('BTCUSDT', '20241230'), disk('BTCUSDT', '20241231'), disk('ETHUSDT', '20241231')],
      [disk('BTCUSDT', '20250101'), disk('ETHUSDT', '20250101')],
    );

    expect(groups.map(g => [g.symbol, g.inputs.map(i => i.file.date)])).toEqual([
      ['BTCUSDT', ['20241230', '20241231', '20250101']],
      ['ETHUSDT', ['20241231', '20250101']],
    ]);
  });

  /** An instrument that only appears next month has nothing of this month to complete. */
  it('drops a neighbour\'s file for an instrument this month does not hold', () => {
    const groups = groupsOf([disk('BTCUSDT', '20241231')], [disk('NEWUSDT', '20250101')]);

    expect(groups.map(g => g.symbol)).toEqual(['BTCUSDT']);
  });
});
