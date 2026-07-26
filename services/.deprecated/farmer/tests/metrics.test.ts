import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import {
  recordRead,
  recordWrite,
  recordReadPause,
  recordReadResume,
  logMetrics,
  _test_HOUR_MINUTES as HOUR_MINUTES,
  _test_reset       as reset,
} from '../src/metrics';
import { createBoundedBuffer } from '../src/buffer';

const infoSpy = logger.info as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  reset();
  infoSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── recordRead / recordWrite ──────────────────────────────────────────────────

describe('recordRead / recordWrite — running totals', () => {
  it('accumulates totalRead across calls', () => {
    recordRead();
    recordRead(5);
    recordRead(10);

    logMetrics();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ totalRead: 16 }),
      expect.any(String),
    );
  });

  it('accumulates totalWritten across calls', () => {
    recordWrite(100);
    recordWrite(50);

    logMetrics();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ totalWritten: 150 }),
      expect.any(String),
    );
  });
});

// ── Rates ─────────────────────────────────────────────────────────────────────

describe('rates — basic timing', () => {
  it('writeRate divides totalWritten by elapsed seconds', () => {
    recordWrite(1_000);
    vi.advanceTimersByTime(1_000);

    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ writeRate: 1_000 }),
      expect.any(String),
    );
  });

  it('readRateActive equals totalRead / activeMs (no pauses)', () => {
    recordRead(500);
    vi.advanceTimersByTime(1_000);

    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ readRateActive: 500 }),
      expect.any(String),
    );
  });

  it('reports zero rate when no time has elapsed', () => {
    /** No time advance — uptimeMs == 0. */
    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ readRateActive: 0, writeRate: 0 }),
      expect.any(String),
    );
  });
});

// ── Pause / resume ────────────────────────────────────────────────────────────

describe('pause / resume — active read time excludes paused intervals', () => {
  it('readRateActive ignores paused time', () => {
    recordRead(500);
    vi.advanceTimersByTime(500);

    recordReadPause();
    vi.advanceTimersByTime(2_000); /** 2s paused */
    recordReadResume();

    recordRead(500);
    vi.advanceTimersByTime(500);

    /** activeMs = 500 + 500 = 1000ms; totalRead = 1000 → 1000 items/s */
    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ readRateActive: 1_000 }),
      expect.any(String),
    );
  });

  it('writeRate uses wall-clock uptime (includes paused time)', () => {
    recordWrite(1_000);

    recordReadPause();
    vi.advanceTimersByTime(1_000);
    recordReadResume();

    /** uptime = 1000ms; writeRate = 1000/1 = 1000 */
    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ writeRate: 1_000 }),
      expect.any(String),
    );
  });

  it('pausedPct reflects fraction of uptime spent paused', () => {
    recordReadPause();
    vi.advanceTimersByTime(500);
    recordReadResume();
    vi.advanceTimersByTime(500);

    /** 500ms paused out of 1000ms uptime → 50% */
    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pausedPct: 50 }),
      expect.any(String),
    );
  });

  it('counts an in-progress pause toward pausedPct at log time', () => {
    recordReadPause();
    vi.advanceTimersByTime(500);

    /** Still paused — half the uptime so far. */
    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pausedPct: 100 }),
      expect.any(String),
    );
  });

  it('a resume without a prior pause is a no-op', () => {
    recordReadResume();

    recordRead(100);
    vi.advanceTimersByTime(1_000);

    logMetrics();

    /** activeMs == uptime since nothing was ever paused. */
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pausedPct: 0, readRateActive: 100 }),
      expect.any(String),
    );
  });

  it('successive pauses without resume are idempotent (single pause start)', () => {
    recordReadPause();
    vi.advanceTimersByTime(500);
    recordReadPause();  /** Should be ignored. */
    vi.advanceTimersByTime(500);
    recordReadResume();

    /** Total paused = 1000ms, not 500ms. */
    vi.advanceTimersByTime(1_000); /** 1s more active */

    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pausedPct: 50 }),
      expect.any(String),
    );
  });
});

// ── Rolling hourly buckets ────────────────────────────────────────────────────

describe('hourly rates — rolling 60-minute window', () => {
  it('hourlyReadRate equals lifetime rate within the first hour', () => {
    recordRead(60); /** one per minute */

    vi.advanceTimersByTime(60_000);

    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hourlyReadRate: 1 }), /** 60 items / 60s */
      expect.any(String),
    );
  });

  it('ages out reads beyond the rolling window', () => {
    recordRead(1_000);

    /** Advance well past HOUR_MINUTES so the bucket holding our 1000 reads
     *  gets overwritten when the minute hand wraps. */
    vi.advanceTimersByTime((HOUR_MINUTES + 5) * 60_000);

    /** A fresh read after the window has wrapped. */
    recordRead(60);

    /** Window remains capped at HOUR_MINUTES * 60_000 = 3600s. */
    logMetrics();

    /** Hourly count = just the fresh 60; rate = 60/3600 = 0.0166... → 0 after round1 */
    const call = infoSpy.mock.calls.at(-1)!;

    expect(call[0]).toMatchObject({ totalRead: 1_060 });
    expect((call[0] as { hourlyReadRate: number }).hourlyReadRate).toBeLessThan(1);
  });
});

// ── Full-pipeline scenario: reader active 1/5 of wall-clock time ──────────────

describe('full scenario — reader active 1/5 of the time', () => {
  /**
   * Simulate 5 cycles of (1s active reading at 40k/s, then 4s paused).
   * Total: 25s uptime, 5s active, 20s paused, 200k items read.
   *
   * Expected:
   *   readRateActive  = 200_000 / 5s    = 40_000 items/s   (active rate)
   *   writeRate       = 0                                  (no writes in this scenario)
   *   pausedPct       = 20s / 25s * 100 = 80%
   */
  it('reports the active-burst rate, not the wall-clock rate', () => {
    for (let i = 0; i < 5; i++) {
      recordRead(40_000);
      vi.advanceTimersByTime(1_000);

      recordReadPause();
      vi.advanceTimersByTime(4_000);
      recordReadResume();
    }

    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        totalRead:      200_000,
        readRateActive: 40_000,
        pausedPct:      80,
      }),
      expect.any(String),
    );
  });

  it('reports correct pausedPct when the final cycle ends mid-pause', () => {
    /** 5s active reading 40k items, then 20s paused — logMetrics fires while still paused. */
    recordRead(40_000);
    vi.advanceTimersByTime(5_000);

    recordReadPause();
    vi.advanceTimersByTime(20_000);

    /** Still paused at log time — currentPaused should be included. */
    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        totalRead:      40_000,
        readRateActive: 8_000, /** 40_000 / 5s active */
        pausedPct:      80,    /** 20s paused / 25s uptime */
      }),
      expect.any(String),
    );
  });
});

// ── Integration: real BoundedBuffer drives the metrics via onPause/onResume ──

describe('buffer integration — onPause/onResume actually update the metrics', () => {
  it('records pause time when push blocks at highWater and resumes at lowWater', async () => {
    const buf = createBoundedBuffer<number>({
      highWater: 3,
      lowWater:  1,
      onPause:   recordReadPause,
      onResume:  recordReadResume,
    });

    /** Fill to highWater (no time advance — all pushes succeed synchronously). */
    await buf.push(1); recordRead();
    await buf.push(2); recordRead();
    await buf.push(3); recordRead();

    /** 4th push parks — onPause should fire here. */
    const parked = buf.push(4);

    /** Yield once so the parked push reaches its await. */
    await Promise.resolve();

    /** 1s elapses while paused. */
    vi.advanceTimersByTime(1_000);

    /** Drain to lowWater. wakePushers fires onResume → parked push completes. */
    await buf.pop(2);
    await parked;
    recordRead();

    /** 1s elapses active. */
    vi.advanceTimersByTime(1_000);

    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        totalRead: 4,
        pausedPct: 50, /** 1s paused / 2s uptime */
      }),
      expect.any(String),
    );
  });

  it('accumulates pause time across multiple block/drain cycles', async () => {
    const buf = createBoundedBuffer<number>({
      highWater: 2,
      lowWater:  1,
      onPause:   recordReadPause,
      onResume:  recordReadResume,
    });

    /** Cycle 1: prime to highWater, park, wait 1s paused, drain. */
    await buf.push(1); recordRead();
    await buf.push(2); recordRead();

    const parked1 = buf.push(3);

    await Promise.resolve();
    vi.advanceTimersByTime(1_000);

    await buf.pop(1); /** items: [2] → resume, parked1 wakes and pushes 3. items: [2, 3]. */
    await parked1;
    recordRead();

    /** 500ms active between cycles. */
    vi.advanceTimersByTime(500);

    /** Cycle 2: park again (items already at highWater), wait 2s paused, drain. */
    const parked2 = buf.push(4);

    await Promise.resolve();
    vi.advanceTimersByTime(2_000);

    await buf.pop(1); /** items: [3] → resume, parked2 pushes 4. items: [3, 4]. */
    await parked2;
    recordRead();

    /** 500ms more active. Total uptime 4s, paused 3s, active 1s. */
    vi.advanceTimersByTime(500);

    logMetrics();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        totalRead: 4,
        pausedPct: 75, /** 3s paused / 4s uptime */
      }),
      expect.any(String),
    );
  });
});
