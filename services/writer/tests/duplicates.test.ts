import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleDuplicates, sampleTimestamp, _resetDuplicatesState } from '../src/duplicates';
import { flushStore } from '../src/batch';
import type { BatchEntry } from '../src/types';

vi.mock('@devvir/service', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/documentId', () => ({
  moveToNextSlot: vi.fn(),
}));

import { moveToNextSlot } from '../src/documentId';

const MAX_RETRIES = 5;
const LIVE_COLLISION_THRESHOLD = 20;
const EXHAUSTION_THRESHOLD = 1000;

const entry = (id: number, retries = 0, redelivered = false): BatchEntry => ({
  document: { _id: id } as any,
  ack: vi.fn(),
  nack: vi.fn(),
  metadata: {
    routingKey: 'writer.trade',
    redelivered,
    exchange: 'writer',
    deliveryTag: 0,
    raw: {} as any,
    properties: {} as any,
    headers: {},
  } as any,
  retries,
});

const db = (collectionName: string, dbName = 'testdb') => ({ collectionName, dbName } as any);

/** Build an _id where Math.floor(_id / 4096) === tsMs */
const idForTs = (tsMs: number) => tsMs * 4096;

/** Warm the sampler with `count` docs, all with the same timestamp */
const warmSampler = (count: number, tsMs: number) => {
  for (let i = 0; i < count; i++) sampleTimestamp(tsMs);
};

beforeEach(() => {
  flushStore();
  _resetDuplicatesState();
  vi.mocked(moveToNextSlot).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Requeue behaviour ─────────────────────────────────────────────────────────

describe('handleDuplicates — requeue behaviour', () => {
  it('requeues entries below MAX_RETRIES with a modified _id', () => {
    const e = entry(1000, 0);
    handleDuplicates(db('trade'), [e]);
    const [batch] = flushStore();
    expect(batch).toBeDefined();
    expect(batch.entries[0].document._id).not.toBe(1000);
  });

  it('increments the retries count when requeuing', () => {
    const e = entry(1000, 2);
    handleDuplicates(db('trade'), [e]);
    const [batch] = flushStore();
    expect(batch.entries[0].retries).toBe(3);
  });

  it('routes requeued entries to the correct collection', () => {
    const e = entry(1000, 0);
    handleDuplicates(db('orderBookL2'), [e]);
    const [batch] = flushStore();
    expect(batch.collection).toBe('orderBookL2');
  });

  it('routes requeued entries to the correct database and collection', () => {
    const e = entry(1000, 0);
    handleDuplicates(db('trade', 'mydb'), [e]);
    const [batch] = flushStore();
    expect(batch.database).toBe('mydb');
    expect(batch.collection).toBe('trade');
  });

  it('assigns distinct _id offsets to multiple entries in the same batch', () => {
    const e0 = entry(1000, 0);
    const e1 = entry(1000, 0);
    handleDuplicates(db('trade'), [e0, e1]);
    const [batch] = flushStore();
    expect(batch.entries).toHaveLength(2);
    expect(batch.entries[0].document._id).not.toBe(batch.entries[1].document._id);
  });

  it('nacks with requeue=true on first delivery when retries exhausted', () => {
    const e = entry(1000, MAX_RETRIES, false);
    handleDuplicates(db('trade'), [e]);
    expect(e.nack).toHaveBeenCalledWith(true);
    expect(flushStore()).toHaveLength(0);
  });

  it('nacks with requeue=false (dead-letter) on redelivery when retries exhausted', () => {
    const e = entry(1000, MAX_RETRIES, true);
    handleDuplicates(db('trade'), [e]);
    expect(e.nack).toHaveBeenCalledWith(false);
    expect(flushStore()).toHaveLength(0);
  });

  it('handles a mix of re-queued and exhausted entries', () => {
    const young = entry(1000, 0);
    const old = entry(2000, MAX_RETRIES);
    handleDuplicates(db('trade'), [young, old]);
    const batches = flushStore();
    expect(batches).toHaveLength(1);
    expect(batches[0].entries).toHaveLength(1);
    expect(old.nack).toHaveBeenCalled();
  });
});

// ── Trigger 1: stream-relative timestamp ──────────────────────────────────────

describe('Trigger 1 — live collision via stream timestamp', () => {
  it('does not fire before SAMPLE_SIZE docs have been sampled', () => {
    const now = Date.now();
    warmSampler(999, now); // one short of threshold

    const futureId = idForTs(now + 10_000);
    for (let i = 0; i < LIVE_COLLISION_THRESHOLD; i++) {
      handleDuplicates(db('trade'), [entry(futureId, 0, false)]);
      flushStore();
    }

    expect(moveToNextSlot).not.toHaveBeenCalled();
  });

  it('fires after SAMPLE_SIZE samples when future-ts entries accumulate', () => {
    const now = Date.now();
    warmSampler(1000, now);

    const futureId = idForTs(now + 10_000);
    for (let i = 0; i < LIVE_COLLISION_THRESHOLD - 1; i++) {
      handleDuplicates(db('trade'), [entry(futureId, 0, false)]);
      flushStore();
    }
    expect(moveToNextSlot).not.toHaveBeenCalled(); // one short

    handleDuplicates(db('trade'), [entry(futureId, 0, false)]);
    expect(moveToNextSlot).toHaveBeenCalledTimes(1);
  });

  it('does not fire for entries with timestamps at or before streamPresent', () => {
    const now = Date.now();
    warmSampler(1000, now);

    const presentId = idForTs(now); // ts === streamPresent, not strictly greater
    for (let i = 0; i < LIVE_COLLISION_THRESHOLD + 5; i++) {
      handleDuplicates(db('trade'), [entry(presentId, 0, false)]);
      flushStore();
    }

    expect(moveToNextSlot).not.toHaveBeenCalled();
  });

  it('does not fire for retries > 0 even with a future timestamp', () => {
    const now = Date.now();
    warmSampler(1000, now);

    const futureId = idForTs(now + 10_000);
    for (let i = 0; i < LIVE_COLLISION_THRESHOLD + 5; i++) {
      handleDuplicates(db('trade'), [entry(futureId, 1, false)]); // retries=1
      flushStore();
    }

    expect(moveToNextSlot).not.toHaveBeenCalled();
  });

  it('does not fire for redelivered entries even with a future timestamp', () => {
    const now = Date.now();
    warmSampler(1000, now);

    const futureId = idForTs(now + 10_000);
    for (let i = 0; i < LIVE_COLLISION_THRESHOLD + 5; i++) {
      handleDuplicates(db('trade'), [entry(futureId, 0, true)]); // redelivered
      flushStore();
    }

    expect(moveToNextSlot).not.toHaveBeenCalled();
  });

  it('resets the counter after switching and requires another full run', () => {
    const now = Date.now();
    warmSampler(1000, now);

    const futureId = idForTs(now + 10_000);

    for (let i = 0; i < LIVE_COLLISION_THRESHOLD; i++) {
      handleDuplicates(db('trade'), [entry(futureId, 0, false)]);
      flushStore();
    }
    expect(moveToNextSlot).toHaveBeenCalledTimes(1);

    for (let i = 0; i < LIVE_COLLISION_THRESHOLD - 1; i++) {
      handleDuplicates(db('trade'), [entry(futureId, 0, false)]);
      flushStore();
    }
    expect(moveToNextSlot).toHaveBeenCalledTimes(1); // not yet

    handleDuplicates(db('trade'), [entry(futureId, 0, false)]);
    expect(moveToNextSlot).toHaveBeenCalledTimes(2);
  });
});

// ── Trigger 2: exhaustion fallback ────────────────────────────────────────────

describe('Trigger 2 — exhaustion fallback', () => {
  it('does not fire before EXHAUSTION_THRESHOLD batches with dead-lettered entries', () => {
    for (let i = 0; i < EXHAUSTION_THRESHOLD; i++) {
      handleDuplicates(db('trade'), [entry(1000, MAX_RETRIES)]);
    }

    expect(moveToNextSlot).not.toHaveBeenCalled();
  });

  it('fires after EXHAUSTION_THRESHOLD + 1 batches with dead-lettered entries', () => {
    for (let i = 0; i < EXHAUSTION_THRESHOLD + 1; i++) {
      handleDuplicates(db('trade'), [entry(1000, MAX_RETRIES)]);
    }

    expect(moveToNextSlot).toHaveBeenCalledTimes(1);
  });

  it('fires independently of Trigger 1 (no sampling needed)', () => {
    // No sampleTimestamp calls — Trigger 1 never activates
    for (let i = 0; i < EXHAUSTION_THRESHOLD + 1; i++) {
      handleDuplicates(db('trade'), [entry(1000, MAX_RETRIES)]);
    }

    expect(moveToNextSlot).toHaveBeenCalledTimes(1);
  });

  it('resets the counter after firing and requires another full run', () => {
    for (let i = 0; i < EXHAUSTION_THRESHOLD + 1; i++) {
      handleDuplicates(db('trade'), [entry(1000, MAX_RETRIES)]);
    }
    expect(moveToNextSlot).toHaveBeenCalledTimes(1);

    for (let i = 0; i < EXHAUSTION_THRESHOLD; i++) {
      handleDuplicates(db('trade'), [entry(1000, MAX_RETRIES)]);
    }
    expect(moveToNextSlot).toHaveBeenCalledTimes(1); // not yet

    handleDuplicates(db('trade'), [entry(1000, MAX_RETRIES)]);
    expect(moveToNextSlot).toHaveBeenCalledTimes(2);
  });
});
