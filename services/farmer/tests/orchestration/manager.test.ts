import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _test_buildPending    as buildPending,
  _test_pickTable       as pickTable,
  _test_trackCompletion as trackCompletion,
  _test_seedInFlight    as seedInFlight,
  _test_resetManager    as resetManager,
  releaseTask,
} from '../../src/orchestration/manager';
import { Task } from '../../src/orchestration/task';
import type { Entry } from '../../src/orchestration/progress';
import type { BitmexTable } from '@tradebot/types';

// ── buildPending: vault ∖ done, with skip from progress ───────────────────────

describe('buildPending', () => {
  it('returns an empty map when vault list is empty', () => {
    expect(buildPending([], [])).toEqual(new Map());
  });

  it('marks fresh buckets with skip = 0', () => {
    const out = buildPending(
      [{ table: 'trade' as BitmexTable, date: '20240315' }],
      [],
    );

    expect(out.get('trade')).toEqual([{ date: '20240315', skip: 0 }]);
  });

  it('marks resumed buckets with skip = progress.messages', () => {
    const out = buildPending(
      [{ table: 'trade' as BitmexTable, date: '20240315' }],
      [{ table: 'trade', date: '20240315', state: 'pending', messages: 99 }] as Entry[],
    );

    expect(out.get('trade')).toEqual([{ date: '20240315', skip: 99 }]);
  });

  it('excludes done buckets from the pending list', () => {
    const out = buildPending(
      [
        { table: 'trade' as BitmexTable, date: '20240315' },
        { table: 'trade' as BitmexTable, date: '20240316' },
      ],
      [{ table: 'trade', date: '20240315', state: 'done', messages: 1_000 }] as Entry[],
    );

    expect(out.get('trade')).toEqual([{ date: '20240316', skip: 0 }]);
  });

  it('groups by table and sorts dates ascending within each table', () => {
    const out = buildPending(
      [
        { table: 'trade'       as BitmexTable, date: '20240316' },
        { table: 'orderBookL2' as BitmexTable, date: '20240315' },
        { table: 'trade'       as BitmexTable, date: '20240315' },
        { table: 'orderBookL2' as BitmexTable, date: '20240317' },
      ],
      [],
    );

    expect(out.get('trade')!.map(p => p.date)).toEqual(['20240315', '20240316']);
    expect(out.get('orderBookL2')!.map(p => p.date)).toEqual(['20240315', '20240317']);
  });
});

// ── in-flight filter: avoid double-handing the same bucket on refresh ─────────

describe('buildPending — in-flight filter', () => {
  beforeEach(() => resetManager());

  it('excludes buckets that are currently in-flight', () => {
    /** Simulate `nextTask` having handed out `trade/20240315`. */
    seedInFlight('trade' as BitmexTable, '20240315');

    const out = buildPending(
      [
        { table: 'trade' as BitmexTable, date: '20240315' },
        { table: 'trade' as BitmexTable, date: '20240316' },
      ],
      /** Redis says the in-flight bucket is partial; without the in-flight
       *  filter it would be added back to pending. */
      [{ table: 'trade', date: '20240315', state: 'pending', messages: 100 }] as Entry[],
    );

    expect(out.get('trade')).toEqual([{ date: '20240316', skip: 0 }]);
  });

  it('admits the bucket back into pending after releaseTask', () => {
    seedInFlight('trade' as BitmexTable, '20240315');

    /** Manually shape a Task-like object — releaseTask only reads table+date. */
    const fakeTask = { table: 'trade' as BitmexTable, date: '20240315' } as Task;

    releaseTask(fakeTask);

    const out = buildPending(
      [{ table: 'trade' as BitmexTable, date: '20240315' }],
      [{ table: 'trade', date: '20240315', state: 'pending', messages: 100 }] as Entry[],
    );

    expect(out.get('trade')).toEqual([{ date: '20240315', skip: 100 }]);
  });
});

// ── pickTable: weighted random by 1/avgTime ───────────────────────────────────

describe('pickTable', () => {
  beforeEach(() => resetManager());

  it('returns the only table when there is exactly one option', () => {
    expect(pickTable(['trade' as BitmexTable])).toBe('trade');
  });

  it('is roughly uniform when no stats exist', () => {
    const tables = ['a', 'b'] as unknown as BitmexTable[];
    let aCount = 0;

    for (let i = 0; i < 1_000; i++) if (pickTable(tables) === 'a') aCount++;

    /** Uniform → expected 500, allow ±200 for randomness. */
    expect(aCount).toBeGreaterThan(300);
    expect(aCount).toBeLessThan(700);
  });
});

describe('pickTable with stats — weighted by 1/avgTime^0.2', () => {
  beforeEach(() => resetManager());

  /**
   * Synthesize a "completed" task with a known elapsed time. trackCompletion
   * uses `Date.now() - task.startTime`; we lie about startTime to seed
   * arbitrary measurements.
   */
  const fakeCompleted = (table: string, elapsedMs: number): Task => ({
    table,
    startTime: Date.now() - elapsedMs,
  } as unknown as Task);

  it('favors faster tables when stats are seeded', () => {
    trackCompletion(fakeCompleted('fast', 1_000));    /** 1 second  */
    trackCompletion(fakeCompleted('slow', 3_600_000)); /** 1 hour    */

    let fastCount = 0;

    for (let i = 0; i < 1_000; i++) {
      if (pickTable(['fast' as BitmexTable, 'slow' as BitmexTable]) === 'fast') fastCount++;
    }

    /**
     * With exponent 0.2:
     *   weights = 1/1000^0.2 = 0.251, 1/3600000^0.2 = 0.049
     *   ratio ≈ 5.1×  →  fast prob ≈ 83.6%
     * Expect ~836 over 1000 trials; thresholds give a comfortable margin for noise.
     */
    expect(fastCount).toBeGreaterThan(750);
    expect(fastCount).toBeLessThan(900);
  });

  it('treats unknown tables as the fastest known (optimistic)', () => {
    /** Only 'slow' has stats; 'unknown' has none and should match slowest weight. */
    trackCompletion(fakeCompleted('slow', 10_000));

    let unknownCount = 0;

    for (let i = 0; i < 1_000; i++) {
      if (pickTable(['slow' as BitmexTable, 'unknown' as BitmexTable]) === 'unknown') unknownCount++;
    }

    /** Equal weights (1/10000 each) → ~uniform. */
    expect(unknownCount).toBeGreaterThan(300);
    expect(unknownCount).toBeLessThan(700);
  });
});
