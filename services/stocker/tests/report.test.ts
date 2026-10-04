import { logger } from '@devvir/service-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { report } from '../src/scan';
import type { Summary } from '../src/types';

const summary = (over: Partial<Summary> = {}): Summary => ({
  considered: 0, current: 0, built: 0, empty: 0, waiting: 0, missing: 0,
  unmapped: 0, failed: 0, rows: 0, files: 0, stopped: false, ...over,
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
    report(summary({ considered: 120, current: 120 }), 30);

    expect(said(logger.info)).toContain('every partition in scope is stocked');
    expect(said(logger.info)).toContain('30 minutes');
  });

  /** Waiting on downloads is a different situation with a different fix. */
  it('separates caught up from waiting on downloads or the disk', () => {
    report(summary({ considered: 120, current: 100, waiting: 15, missing: 5 }), 30);

    expect(said(logger.info)).toContain('15 partitions still downloading');
    expect(said(logger.info)).toContain('5 not on disk as catalogued');
  });

  it('reports what it stocked when it stocked something', () => {
    report(summary({ built: 3, rows: 42, waiting: 1 }), 15);

    expect(said(logger.info)).toContain('Stocked 3 partitions');
    expect(said(logger.info)).not.toContain('Caught up');
  });

  it('warns rather than claiming progress when a partition failed', () => {
    report(summary({ built: 2, failed: 1 }), 30);

    expect(said(logger.warn)).toContain('1 partition failed');
    expect(said(logger.info)).toBe('');
  });

  it('warns when it stopped for want of space', () => {
    report(summary({ built: 2, stopped: true }), 30);

    expect(said(logger.warn)).toContain('want of space');
  });

  it('says one partition, not 1 partitions', () => {
    report(summary({ built: 1 }), 30);

    expect(said(logger.info)).toContain('Stocked 1 partition —');
  });
});
