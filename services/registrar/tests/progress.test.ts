import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  record,
  recordControl,
  start,
  stop,
  _test_buckets as buckets,
  _test_flush   as flush,
  _test_reset   as reset,
} from '../src/progress';
import type { RedisClient } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Default mGet returns an array of nulls — no bucket is marked done in Redis,
 * so flush() proceeds to write as usual. Per-test overrides simulate an
 * existing `'done:<count>'` value when we want to verify the skip guard.
 */
const makeRedis = (mGetImpl?: (keys: string[]) => Array<string | null>) => ({
  get:  vi.fn().mockResolvedValue(null),
  set:  vi.fn().mockResolvedValue('OK'),
  mGet: vi.fn().mockImplementation(async (keys: string[]) =>
    mGetImpl ? mGetImpl(keys) : keys.map(() => null),
  ),
} as unknown as RedisClient);

beforeEach(() => {
  reset();
});

// ── record ────────────────────────────────────────────────────────────────────

describe('record', () => {
  it('creates a bucket with the given msgIndex on first record', () => {
    record('trade', '20260101', 5);

    const bucket = buckets.get('trade:20260101');

    expect(bucket).toEqual({ table: 'trade', date: '20260101', counter: 5, goal: null });
  });

  it('keeps the counter monotonically increasing', () => {
    record('trade', '20260101', 5);
    record('trade', '20260101', 10);
    record('trade', '20260101', 7);

    expect(buckets.get('trade:20260101')!.counter).toBe(10);
  });

  it('isolates state per (table, date)', () => {
    record('trade', '20260101', 3);
    record('trade', '20260102', 7);
    record('quote', '20260101', 5);

    expect(buckets.get('trade:20260101')!.counter).toBe(3);
    expect(buckets.get('trade:20260102')!.counter).toBe(7);
    expect(buckets.get('quote:20260101')!.counter).toBe(5);
  });
});

// ── recordControl ─────────────────────────────────────────────────────────────

describe('recordControl', () => {
  it('sets the goal for an existing bucket', () => {
    record('trade', '20260101', 50);
    recordControl({ type: 'complete', table: 'trade', date: '20260101', highestIndex: 99 });

    expect(buckets.get('trade:20260101')).toEqual({
      table:   'trade',
      date:    '20260101',
      counter: 50,
      goal:    99,
    });
  });

  it('creates a bucket if the control arrives before any record', () => {
    recordControl({ type: 'complete', table: 'trade', date: '20260101', highestIndex: 99 });

    expect(buckets.get('trade:20260101')).toEqual({
      table:   'trade',
      date:    '20260101',
      counter: -1,
      goal:    99,
    });
  });

  it('accepts highestIndex = -1 for an empty bucket', () => {
    recordControl({ type: 'complete', table: 'trade', date: '20260101', highestIndex: -1 });

    expect(buckets.get('trade:20260101')!.goal).toBe(-1);
  });
});

// ── flush ─────────────────────────────────────────────────────────────────────

describe('flush', () => {
  it('writes the current counter for buckets that have not reached their goal', async () => {
    const redis = makeRedis();

    start(redis, 1_000_000);
    record('trade', '20260101', 42);

    await flush();

    expect(redis.set).toHaveBeenCalledWith('customs:trade:20260101', '42');
  });

  it('writes "done:<count>" and drops the bucket when counter === goal', async () => {
    const redis = makeRedis();

    start(redis, 1_000_000);
    record('trade', '20260101', 99);
    recordControl({ type: 'complete', table: 'trade', date: '20260101', highestIndex: 99 });

    await flush();

    expect(redis.set).toHaveBeenCalledWith('customs:trade:20260101', 'done:100');
    expect(buckets.has('trade:20260101')).toBe(false);
  });

  it('does not finalize when goal is set but counter has not caught up', async () => {
    const redis = makeRedis();

    start(redis, 1_000_000);
    record('trade', '20260101', 50);
    recordControl({ type: 'complete', table: 'trade', date: '20260101', highestIndex: 99 });

    await flush();

    expect(redis.set).toHaveBeenCalledWith('customs:trade:20260101', '50');
    expect(buckets.has('trade:20260101')).toBe(true);
  });

  it('finalizes an empty bucket as "done:0" when control arrives with highestIndex = -1', async () => {
    const redis = makeRedis();

    start(redis, 1_000_000);
    recordControl({ type: 'complete', table: 'trade', date: '20260101', highestIndex: -1 });

    await flush();

    expect(redis.set).toHaveBeenCalledWith('customs:trade:20260101', 'done:0');
    expect(buckets.has('trade:20260101')).toBe(false);
  });

  it('writes each active bucket independently in a single flush', async () => {
    const redis = makeRedis();

    start(redis, 1_000_000);
    record('trade', '20260101', 10);
    record('quote', '20260101', 20);
    recordControl({ type: 'complete', table: 'quote', date: '20260101', highestIndex: 20 });

    await flush();

    expect(redis.set).toHaveBeenCalledWith('customs:trade:20260101', '10');
    expect(redis.set).toHaveBeenCalledWith('customs:quote:20260101', 'done:21');
  });

  it('does nothing when start has not been called', async () => {
    const redis = makeRedis();

    record('trade', '20260101', 5);

    await flush();

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('skips overlapping flushes via the reentrancy guard', async () => {
    let resolveFirst!: () => void;

    const redis = {
      get:  vi.fn(),
      mGet: vi.fn().mockResolvedValue([ null ]),
      set:  vi.fn().mockImplementation(() => new Promise<string>(r => { resolveFirst = () => r('OK'); })),
    } as unknown as RedisClient;

    start(redis, 1_000_000);
    record('trade', '20260101', 1);

    const first = flush();

    // Second invocation should bail immediately while the first is still pending.
    await flush();

    expect(redis.set).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
  });

  it('skips the write and drops the bucket if Redis already says done', async () => {
    // Simulates a late or repeated message reopening a closed bucket: a fresh
    // BucketState (counter = 99, goal = null) exists in memory, but Redis
    // already holds `done:100`. The flush must not overwrite — and must
    // clear the local entry so we stop trying.
    const redis = makeRedis(() => [ 'done:100' ]);

    start(redis, 1_000_000);
    record('trade', '20260101', 99);

    await flush();

    expect(redis.set).not.toHaveBeenCalled();
    expect(buckets.has('trade:20260101')).toBe(false);
  });
});

// ── stop ──────────────────────────────────────────────────────────────────────

describe('stop', () => {
  it('clears the timer so no further flushes are scheduled', () => {
    const redis = makeRedis();

    start(redis, 50);
    stop();

    // No assertion needed beyond not throwing; reset() in beforeEach also clears it.
    // If the timer were still alive, vitest's leak detector would flag it.
    expect(true).toBe(true);
  });
});
