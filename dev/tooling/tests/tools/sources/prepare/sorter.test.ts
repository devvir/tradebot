import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BoundedQueue, createSorter, createSourceActor } from '../../../../src/tools/sources/prepare/tasks/sorter';
import { _test_setColumns, _test_clearColumns } from '../../../../src/tools/sources/tables';
import type { PreparedMessage, ReadIssue } from '../../../../src/tools/sources/prepare/types';

const COLUMNS = ['_date_', '_action_', 'timestamp', 'symbol', 'price'];

function msg(date: string, ts: string = date): PreparedMessage {
  return {
    rows:      [{ _date_: date, _action_: 'update' }],
    date,
    action:    'update',
    timestamp: ts === date ? '' : ts,
    ts:        ts.slice(0, 23),
    tsMs:      Date.parse(ts),
  };
}

function flat(buckets: PreparedMessage[][]): PreparedMessage[] {
  return buckets.flat();
}

// ── createSorter ─────────────────────────────────────────────────────────────

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

  it('uses ts + date compound sort key (timestamped table — timestamp wins)', () => {
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

  it('breaks ts ties by _date_ (reception time)', () => {
    const sorter = createSorter(50);

    // Same exchange timestamp; different reception times. `_date_` is the tiebreaker.
    const a = msg('2026-01-01T12:00:30.000Z', '2026-01-01T12:00:00.000Z'); // late reception
    const b = msg('2026-01-01T12:00:10.000Z', '2026-01-01T12:00:00.000Z'); // early reception

    sorter.push([a, b]);

    const final = flat(sorter.flush());

    // b has earlier _date_ (10Z < 30Z) → comes first
    expect(final.map(m => m.date)).toEqual([
      '2026-01-01T12:00:10.000Z',
      '2026-01-01T12:00:30.000Z',
    ]);
  });

  it('returns empty array on flush when no buckets are buffered', () => {
    const sorter = createSorter(50);

    expect(sorter.flush()).toEqual([]);
  });
});

// ── BoundedQueue ─────────────────────────────────────────────────────────────

describe('BoundedQueue', () => {
  it('passes single items through when below capacity', async () => {
    const q = new BoundedQueue<number>(10);

    await q.push(1);
    await q.push(2);
    q.close();

    expect(await q.take()).toBe(1);
    expect(await q.take()).toBe(2);
    expect(await q.take()).toBeNull();
  });

  it('blocks the producer when at capacity', async () => {
    const q = new BoundedQueue<number>(2);

    await q.push(1);
    await q.push(2);

    let pushResolved = false;
    const pushPromise = q.push(3).then(() => { pushResolved = true; });

    // Yield once — push should still be blocked.
    await new Promise(r => setImmediate(r));
    expect(pushResolved).toBe(false);

    expect(await q.take()).toBe(1);

    await pushPromise;
    expect(pushResolved).toBe(true);

    expect(await q.take()).toBe(2);
    expect(await q.take()).toBe(3);
  });

  it('blocks the consumer when empty until close()', async () => {
    const q = new BoundedQueue<number>(10);

    let result: number | null | 'pending' = 'pending';
    const takePromise = q.take().then(v => { result = v; });

    await new Promise(r => setImmediate(r));
    expect(result).toBe('pending');

    q.close();
    await takePromise;

    expect(result).toBeNull();
  });

  it('respects sizeOf for capacity tracking', async () => {
    const q = new BoundedQueue<number[]>(5, arr => arr.length);

    await q.push([1, 1, 1]); // size 3
    await q.push([2, 2]);    // size 5 — at capacity

    let pushResolved = false;
    const pushPromise = q.push([3]).then(() => { pushResolved = true; });

    await new Promise(r => setImmediate(r));
    expect(pushResolved).toBe(false);

    await q.take(); // drops size to 2

    await pushPromise;
    expect(pushResolved).toBe(true);
  });

  it('fail() causes subsequent take() to throw', async () => {
    const q = new BoundedQueue<number>(10);

    q.fail(new Error('boom'));

    await expect(q.take()).rejects.toThrow('boom');
  });

  it('fail() wakes a pending take() with the error', async () => {
    const q = new BoundedQueue<number>(10);

    const takePromise = q.take();

    q.fail(new Error('boom'));

    await expect(takePromise).rejects.toThrow('boom');
  });
});

// ── createSourceActor (end-to-end) ───────────────────────────────────────────

describe('createSourceActor', () => {
  // 'orderBookL2' → fixedPartials=false, has timestamp column
  beforeAll(() => { _test_setColumns('orderBookL2', COLUMNS); });
  afterAll(()  => { _test_clearColumns('orderBookL2'); });

  function writeGz(content: string): string {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'source-actor-'));
    const file = path.join(dir, 'in.csv.gz');

    fs.writeFileSync(file, zlib.gzipSync(content));

    return file;
  }

  async function collect(gen: AsyncGenerator<PreparedMessage[]>): Promise<PreparedMessage[]> {
    const out: PreparedMessage[] = [];

    for await (const batch of gen) {
      out.push(...batch);
    }

    return out;
  }

  it('reads, sorts, and yields messages', async () => {
    // Out-of-order rows — should come out sorted.
    const file = writeGz([
      COLUMNS.join(','),
      '2026-01-01T12:00:30.000Z,update,2026-01-01T12:00:30.000Z,XBT,103',
      '2026-01-01T12:00:10.000Z,update,2026-01-01T12:00:10.000Z,XBT,101',
      '2026-01-01T12:00:20.000Z,update,2026-01-01T12:00:20.000Z,XBT,102',
    ].join('\n') + '\n');

    const issues: ReadIssue[] = [];
    const all = await collect(createSourceActor('orderBookL2', file, i => issues.push(i)));

    expect(issues).toEqual([]);
    expect(all.map(m => m.ts)).toEqual([
      '2026-01-01T12:00:10.000',
      '2026-01-01T12:00:20.000',
      '2026-01-01T12:00:30.000',
    ]);
  });

  it('yields evicted buckets in order across minute boundaries', async () => {
    // Two minutes of data, in-order, plenty under sort threshold — flush
    // delivers them in chronological key order.
    const lines = [COLUMNS.join(',')];

    for (let m = 0; m < 2; m++) {
      for (let s = 0; s < 5; s++) {
        const t = `2026-01-01T12:0${m}:0${s}.000Z`;

        lines.push(`${t},update,${t},XBT,${m * 10 + s}`);
      }
    }

    const file = writeGz(lines.join('\n') + '\n');
    const all = await collect(createSourceActor('orderBookL2', file, () => {}));

    expect(all).toHaveLength(10);
    expect(all[0]!.ts).toBe('2026-01-01T12:00:00.000');
    expect(all[9]!.ts).toBe('2026-01-01T12:01:04.000');
  });
});
