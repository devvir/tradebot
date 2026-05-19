import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registry } from '@devvir/service-kit';
import { Task, type StopSignal } from '../../src/orchestration/task';
import { _test_PREFIX as PREFIX, _test_resetClient as resetClient } from '../../src/orchestration/progress';
import type { RedisClient } from '../../src/types';

// ── Mock redis through the registry (progress.ts pulls it from there) ─────────

const makeRedis = () => ({
  get:  vi.fn().mockResolvedValue(null),
  set:  vi.fn().mockResolvedValue('OK'),
  mGet: vi.fn().mockResolvedValue([]),
  scanIterator: vi.fn(() => (async function* () { /* empty */ })()),
} as unknown as RedisClient & { set: ReturnType<typeof vi.fn> });

const installRedis = (redis: RedisClient): void => {
  vi.mocked(registry.get).mockReturnValue({
    providers: { get: vi.fn(() => redis) },
  } as never);
};

const key = (table: string, date: string): string => `${PREFIX}:${table}:${date}`;

const TICK_MS = 1_000;
const TABLE   = 'trade';
const DATE    = '20240315';

let redis: ReturnType<typeof makeRedis>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(registry.get).mockReset();
  resetClient();

  redis = makeRedis();
  installRedis(redis);
});

afterEach(() => {
  vi.useRealTimers();
});

const make = (overrides: Partial<{
  table: string; date: string; skip: number; stopSignal: StopSignal;
  onComplete: (t: Task) => void;
}> = {}): Task =>
  new Task({
    table:      (overrides.table ?? TABLE) as never,
    date:       overrides.date  ?? DATE,
    skip:       overrides.skip  ?? 0,
    intervalMs: TICK_MS,
    stopSignal: overrides.stopSignal ?? { triggered: false },
    onComplete: overrides.onComplete,
  });

/**
 * Simulate "positions `from..to` admitted and confirmed by mongo, in order."
 * Mirrors what the infer/assemble + flush pipeline does to a real Task.
 */
const advanceWrites = (task: Task, from: number, to: number): void => {
  for (let p = from; p <= to; p++) {
    task.admit();
    task.noteDisposed(p, true);
  }
};

// ── Construction ──────────────────────────────────────────────────────────────

describe('Task — construction', () => {
  it('exposes table, date, type, startTime, messages=skip, totalMessages=null', () => {
    const before = Date.now();
    const task   = make({ skip: 0 });
    const after  = Date.now();

    expect(task.table).toBe('trade');
    expect(task.date).toBe(DATE);
    expect(task.type).toBe('rest');
    expect(task.messages).toBe(0);
    expect(task.totalMessages).toBeNull();
    expect(task.startTime).toBeGreaterThanOrEqual(before);
    expect(task.startTime).toBeLessThanOrEqual(after);
  });

  it('initializes messages = skip for a resuming task', () => {
    expect(make({ skip: 100 }).messages).toBe(100);
  });

  it('marks WS tables with type=ws', () => {
    expect(make({ table: 'orderBookL2' }).type).toBe('ws');
  });

  it('marks non-WS tables with type=rest', () => {
    expect(make({ table: 'trade' }).type).toBe('rest');
  });
});

// ── noteDisposed / position witness ───────────────────────────────────────────

describe('Task — noteDisposed', () => {
  it('advances messages as positions are disposed in order', () => {
    const task = make();

    advanceWrites(task, 1, 5);
    expect(task.messages).toBe(5);

    advanceWrites(task, 6, 10);
    expect(task.messages).toBe(10);
  });

  it('queues out-of-order disposals and advances when the gap fills', () => {
    const task = make();

    /** Admit 1..5; confirm 3, 5 first, then 1, 4, 2 — frontier rolls only when contiguous. */
    for (let p = 1; p <= 5; p++) task.admit();

    task.noteDisposed(3, true);
    expect(task.messages).toBe(0);

    task.noteDisposed(5, true);
    expect(task.messages).toBe(0);

    task.noteDisposed(1, true);
    expect(task.messages).toBe(1);

    task.noteDisposed(4, true);
    expect(task.messages).toBe(1);

    task.noteDisposed(2, true);
    expect(task.messages).toBe(5);
  });

  it('treats drops (viaWrite=false) the same as confirms for frontier purposes', () => {
    const task = make();

    /** Position 1 dropped; 2 admitted+confirmed; 3 dropped. Frontier should reach 3. */
    task.noteDisposed(1, false);
    expect(task.messages).toBe(1);

    task.admit();
    task.noteDisposed(2, true);
    expect(task.messages).toBe(2);

    task.noteDisposed(3, false);
    expect(task.messages).toBe(3);
  });

  it('admit/noteDisposed pairs keep pending balanced', () => {
    const task = make();

    task.admit();
    task.admit();
    expect(task.pending).toBe(2);

    task.noteDisposed(1, true);
    expect(task.pending).toBe(1);

    task.noteDisposed(2, true);
    expect(task.pending).toBe(0);
  });
});

// ── Periodic tick writes via markProgress ────────────────────────────────────

describe('Task — periodic tick', () => {
  it('writes current messages on each interval', async () => {
    const task = make();

    advanceWrites(task, 1, 42);

    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(redis.set).toHaveBeenCalledWith(key(TABLE, DATE), '42');
  });

  it('skips the tick when stopSignal is triggered', async () => {
    const stop = { triggered: false };
    const task = make({ stopSignal: stop });

    advanceWrites(task, 1, 42);
    stop.triggered = true;

    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(redis.set).not.toHaveBeenCalled();
  });
});

// ── Done detection + onComplete ───────────────────────────────────────────────

describe('Task — done detection', () => {
  it('does not finalize until setTotalMessages is called', async () => {
    const task = make();

    advanceWrites(task, 1, 99);
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(redis.set).toHaveBeenCalledWith(key(TABLE, DATE), '99');
    expect(redis.set).not.toHaveBeenCalledWith(key(TABLE, DATE), expect.stringContaining('done'));
  });

  it('finalizes when the frontier catches totalMessages with pending==0', async () => {
    const task = make();

    task.setTotalMessages(100);
    advanceWrites(task, 1, 100);
    await Promise.resolve();

    expect(redis.set).toHaveBeenCalledWith(key(TABLE, DATE), 'done:100');
  });

  it('finalizes when totalMessages is set after frontier reached', async () => {
    const task = make();

    advanceWrites(task, 1, 100);
    task.setTotalMessages(100);
    await Promise.resolve();

    expect(redis.set).toHaveBeenCalledWith(key(TABLE, DATE), 'done:100');
  });

  it('does not finalize while pending>0 even when frontier matches totalMessages', async () => {
    /** Disposed out of order: position 5 dropped, but 1..4 still in flight. */
    const task = make();

    for (let p = 1; p <= 5; p++) task.admit();

    task.noteDisposed(5, true);
    task.setTotalMessages(5);

    await Promise.resolve();

    expect(redis.set).not.toHaveBeenCalledWith(key(TABLE, DATE), expect.stringContaining('done'));

    /** Now confirm the rest in order — frontier catches up, finalize fires. */
    task.noteDisposed(1, true);
    task.noteDisposed(2, true);
    task.noteDisposed(3, true);
    task.noteDisposed(4, true);

    await Promise.resolve();

    expect(redis.set).toHaveBeenCalledWith(key(TABLE, DATE), 'done:5');
  });

  it('handles empty file: setTotalMessages(0) finalizes as done:0', async () => {
    const task = make();

    task.setTotalMessages(0);
    await Promise.resolve();

    expect(redis.set).toHaveBeenCalledWith(key(TABLE, DATE), 'done:0');
  });

  it('finalizes a resumed task (skip>0) once writes catch up to totalMessages', async () => {
    const task = make({ skip: 50 });

    task.setTotalMessages(100);
    advanceWrites(task, 51, 100);
    await Promise.resolve();

    expect(redis.set).toHaveBeenCalledWith(key(TABLE, DATE), 'done:100');
  });

  it('stops ticking after finalization', async () => {
    const task = make();

    task.setTotalMessages(10);
    advanceWrites(task, 1, 10);
    await Promise.resolve();

    redis.set.mockClear();

    await vi.advanceTimersByTimeAsync(TICK_MS * 2);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('invokes onComplete with the task on finish', async () => {
    const onComplete = vi.fn();
    const task       = make({ onComplete });

    task.setTotalMessages(5);
    advanceWrites(task, 1, 5);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]![0]).toBe(task);
  });
});
