import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import {
  recordDoc,
  recordDropped,
  recordGaps,
  recordSymbols,
  logMetrics,
  _test_reset   as reset,
  _test_advance as advance,
} from '../../../src/distillers/instrument/record';

const infoSpy = logger.info as ReturnType<typeof vi.fn>;

const lastCallWith = (msg: string): Record<string, unknown> | undefined =>
  infoSpy.mock.calls.filter(c => c[1] === msg).at(-1)?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  reset();
  infoSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Counters ────────────────────────────────────────────────────────────────

describe('recordDoc — real vs synthetic totals', () => {
  it('separates real and synthetic counts', () => {
    recordDoc(true,  '2026-01-01');
    recordDoc(true,  '2026-01-01');
    recordDoc(false, '2026-01-01');

    logMetrics();

    expect(lastCallWith('Instrument progress')).toMatchObject({ lifetimeReal: 2, lifetimeSynth: 1 });
  });

  it('reports the synthetic share', () => {
    recordDoc(true,  '2026-01-01');
    recordDoc(false, '2026-01-01');
    recordDoc(false, '2026-01-01');
    recordDoc(false, '2026-01-01');

    logMetrics();

    expect(lastCallWith('Instrument progress')).toMatchObject({ lifetimeSynthPct: 75 });
  });
});

// ── Rates ───────────────────────────────────────────────────────────────────

describe('rates — lifetime and rolling window', () => {
  it('real60mRate divides the rolling-window total by its elapsed seconds', () => {
    recordDoc(true, '2026-01-01');
    for (let i = 0; i < 999; i++) recordDoc(true, '2026-01-01');

    vi.advanceTimersByTime(1_000);

    logMetrics();

    expect(lastCallWith('Instrument progress')).toMatchObject({ real60mRate: 1_000 });
  });

  it('suppresses the tick while idle, resumes when work returns', () => {
    recordDoc(true, '2026-01-01');

    logMetrics();                       // prints — total moved
    logMetrics();                       // suppressed — nothing written since
    logMetrics();                       // still suppressed

    expect(infoSpy.mock.calls.filter(c => c[1] === 'Instrument progress')).toHaveLength(1);

    recordDoc(false, '2026-01-01');     // work resumes
    logMetrics();                       // prints again

    expect(infoSpy.mock.calls.filter(c => c[1] === 'Instrument progress')).toHaveLength(2);
  });

  it('ages writes out of the rolling 60-minute window', () => {
    for (let i = 0; i < 1_000; i++) recordDoc(true, '2026-01-01');

    /** Advance past the window so the bucket is overwritten on wrap. */
    for (let i = 0; i < 65; i++) advance();

    logMetrics();

    const m = lastCallWith('Instrument progress')!;

    expect(m.lifetimeReal).toBe(1_000);
    expect(m.real60mRate as number).toBe(0);
  });
});

// ── Day boundary ──────────────────────────────────────────────────────────────

describe('day rollover — daily summary flush', () => {
  it('flushes the finished day when a new date arrives', () => {
    recordGaps('2026-01-01', 2, 90_000);
    recordDoc(true,  '2026-01-01');
    recordDoc(false, '2026-01-01');
    recordDropped('2026-01-01');
    recordSymbols('2026-01-01', 42);

    vi.advanceTimersByTime(2_000);

    /** First doc of the next day triggers the flush of 2026-01-01. */
    recordDoc(true, '2026-01-02');

    expect(lastCallWith('Day distilled')).toMatchObject({
      day:        '2026-01-01',
      real:       1,
      synth:      1,
      dropped:    1,
      synthPct:   50,
      lossPct:    50,
      gapMin:     1.5,
      symbols:    42,
      elapsedSec: 2,
    });
  });

  it('warns once when a day sheds too many out-of-order rows', () => {
    const warnSpy = logger.warn as ReturnType<typeof vi.fn>;

    warnSpy.mockClear();

    for (let i = 0; i < 1_001; i++) recordDropped('2026-01-01');
    recordDoc(true, '2026-01-02'); // rolls over → flushes 2026-01-01

    const warns = warnSpy.mock.calls.filter(c => c[1] === 'Instrument distiller: high out-of-order real-row loss');

    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toMatchObject({ day: '2026-01-01', dropped: 1_001 });
  });

  it('announces each new day exactly once', () => {
    recordDoc(true, '2026-01-01');
    recordDoc(true, '2026-01-01');
    recordGaps('2026-01-01', 0, 0);

    const starts = infoSpy.mock.calls.filter(c => c[0] === 'Distilling 2026-01-01 instrument');

    expect(starts).toHaveLength(1);
  });
});
