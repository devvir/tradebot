import { describe, it, expect } from 'vitest';
import { createSorter } from '../../../../src/tools/sources/prepare/tasks/sorter';
import type { PreparedMessage } from '../../../../src/tools/sources/prepare/types';

function msg(date: string, ts: string = date): PreparedMessage {
  return {
    rows:      [{ _date_: date, _action_: 'update' }],
    date,
    action:    'update',
    timestamp: ts === date ? null : ts,
    ts:        ts.slice(0, 23),
    tsMs:      Date.parse(ts),
  };
}

function flat(buckets: PreparedMessage[][]): PreparedMessage[] {
  return buckets.flat();
}

describe('createSorter', () => {
  it('sorts within a single bucket', () => {
    const sorter = createSorter(50);

    const evicted = sorter.push([
      msg('2026-01-01T12:00:30.000Z'),
      msg('2026-01-01T12:00:10.000Z'),
      msg('2026-01-01T12:00:20.000Z'),
    ]);

    expect(evicted).toEqual([]);

    const final = flat(sorter.flush());

    expect(final.map(m => m.date)).toEqual([
      '2026-01-01T12:00:10.000Z',
      '2026-01-01T12:00:20.000Z',
      '2026-01-01T12:00:30.000Z',
    ]);
  });

  it('evicts oldest bucket when message count exceeds limit', () => {
    const sorter = createSorter(2);

    sorter.push([msg('2026-01-01T12:00:10.000Z')]);                       // bucket 12:00, total=1
    sorter.push([msg('2026-01-01T12:01:10.000Z')]);                       // bucket 12:01, total=2
    const evicted = sorter.push([msg('2026-01-01T12:02:10.000Z')]);       // bucket 12:02, total=3 → evict 12:00

    expect(flat(evicted).map(m => m.date)).toEqual(['2026-01-01T12:00:10.000Z']);
  });

  it('evicts multiple oldest buckets when a single push pushes far over the limit', () => {
    const sorter = createSorter(2);

    const evicted = sorter.push([
      msg('2026-01-01T12:00:00.000Z'),  // bucket 12:00
      msg('2026-01-01T12:01:00.000Z'),  // bucket 12:01
      msg('2026-01-01T12:02:00.000Z'),  // bucket 12:02
      msg('2026-01-01T12:03:00.000Z'),  // bucket 12:03 → after this, total=4 > 2; evict until ≤ 2
    ]);

    // Evicts 12:00 and 12:01 (the two oldest).
    expect(evicted).toHaveLength(2);
    expect(evicted[0]![0]!.date).toBe('2026-01-01T12:00:00.000Z');
    expect(evicted[1]![0]!.date).toBe('2026-01-01T12:01:00.000Z');
  });

  it('drains remaining buckets in chronological order on flush', () => {
    const sorter = createSorter(50);

    sorter.push([msg('2026-01-01T12:01:00.000Z')]);
    sorter.push([msg('2026-01-01T12:00:00.000Z')]);

    const final = flat(sorter.flush());

    expect(final.map(m => m.date)).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:01:00.000Z',
    ]);
  });

  it('preserves stable order within a bucket on equal sort keys', () => {
    const sorter = createSorter(50);

    // Two messages with the same `ts` and same `_date_` — relative input order must be kept.
    const m1 = msg('2026-01-01T12:00:10.000Z');
    const m2 = msg('2026-01-01T12:00:10.000Z');

    m1.rows[0]!['_seq_'] = 'first';
    m2.rows[0]!['_seq_'] = 'second';

    sorter.push([m1, m2]);

    const final = flat(sorter.flush());

    expect(final.map(m => m.rows[0]!['_seq_'])).toEqual(['first', 'second']);
  });

  it('sorts by ts (timestamped table — exchange time wins over _date_)', () => {
    const sorter = createSorter(50);

    sorter.push([
      // _date_ ordering disagrees with `ts` ordering — `ts` (= timestamp) must win.
      msg('2026-01-01T12:00:30.000Z', '2026-01-01T12:00:01.000Z'),
      msg('2026-01-01T12:00:10.000Z', '2026-01-01T12:00:02.000Z'),
    ]);

    const final = flat(sorter.flush());

    expect(final.map(m => m.ts)).toEqual([
      '2026-01-01T12:00:01.000',
      '2026-01-01T12:00:02.000',
    ]);
  });

  it('returns empty array on flush when no buckets are buffered', () => {
    const sorter = createSorter(50);

    expect(sorter.flush()).toEqual([]);
  });
});
