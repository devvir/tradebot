import { logger } from '@devvir/service-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { report } from '../src/scan';
import type { Summary } from '../src/types';

const summary = (over: Partial<Summary> = {}): Summary => ({
  discovered: 0, partitions: 0, built: 0, skipped: 0, pending: 0, failed: 0, rows: 0, ...over,
});

const said = (fn: typeof logger.info): string =>
  vi.mocked(fn).mock.calls.map(call => String(call[1])).join(' | ');

beforeEach(() => vi.clearAllMocks());

/**
 * A sweep that builds nothing is indistinguishable from a stalled one in a log
 * that only reports work, so what a finished sweep means is stated outright.
 */
describe('the end-of-sweep report', () => {
  it('says it is caught up when there is nothing left at all', () => {
    report(summary({ partitions: 120, skipped: 120 }), 30);

    expect(said(logger.info)).toContain('every partition available is built');
    expect(said(logger.info)).toContain('30 minutes');
  });

  /** Waiting on a collector is a different situation with a different fix. */
  it('separates caught up from waiting on the collectors', () => {
    report(summary({ partitions: 120, skipped: 100, pending: 20 }), 30);

    expect(said(logger.info)).toContain('20 partitions waiting');
    expect(said(logger.info)).toContain('collectors have not closed');
  });

  it('reports what it built when it built something', () => {
    report(summary({ built: 3, rows: 42, pending: 1 }), 15);

    expect(said(logger.info)).toContain('Built 3 partitions');
    expect(said(logger.info)).not.toContain('Caught up');
  });

  it('warns rather than claiming progress when a partition failed', () => {
    report(summary({ built: 2, failed: 1 }), 30);

    expect(said(logger.warn)).toContain('1 partition failed');
    expect(said(logger.info)).toBe('');
  });

  it('says one partition, not 1 partitions', () => {
    report(summary({ built: 1 }), 30);

    expect(said(logger.info)).toContain('Built 1 partition —');
  });
});
