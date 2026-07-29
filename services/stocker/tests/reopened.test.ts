import { describe, expect, it } from 'vitest';
import { _test_changed as changed, _test_reopened as reopened } from '../src/scan';
import type { Built, RawFile } from '../src/types';

const record = (closedAt?: string | null): Built => ({
  id:      'trades|bitget|spot|BTCUSDT|2018-09',
  key:     { table: 'trades', venue: 'bitget', market: 'spot', symbol: 'BTCUSDT', month: '2018-09' } as Built['key'],
  inputs:  [{ path: 'a.zip', size: 100 }],
  rows:    10,
  builtAt: '2026-08-01T00:00:00.000Z',
  ...(closedAt === undefined ? {} : { closedAt }),
});

const input = (path: string, size = 100): RawFile => ({ path, size } as RawFile);

/**
 * The collector re-closes a month when something it believed turns out to have
 * been wrong — a symbol universe missing its delisted names, a dataset never
 * collected, a filename shape nobody knew about. The new closing time is how
 * that repair reaches everything downstream without a human tracking which
 * partitions came from where.
 */
describe('reopened', () => {
  it('rebuilds when the month has been closed again since', () => {
    expect(reopened(record('2026-08-01T00:00:00.000Z'), '2026-08-05T12:00:00.000Z')).toBe(true);
  });

  it('leaves a partition alone while the closing time is unchanged', () => {
    expect(reopened(record('2026-08-01T00:00:00.000Z'), '2026-08-01T00:00:00.000Z')).toBe(false);
  });

  /**
   * Every record written before closing times existed carries none. Treating
   * that as "reopened" would rebuild the entire vault once, to prove nothing.
   */
  it('ignores a record from before closing times were published', () => {
    expect(reopened(record(), '2026-08-05T12:00:00.000Z')).toBe(false);
    expect(reopened(record(null), '2026-08-05T12:00:00.000Z')).toBe(false);
  });

  it('ignores a venue that publishes no closing time', () => {
    expect(reopened(record('2026-08-01T00:00:00.000Z'), null)).toBe(false);
  });

  /**
   * The two checks answer different questions and neither replaces the other:
   * `changed` catches files added to a month already built, `reopened` catches a
   * month re-collected around a partition whose own files are untouched — which
   * is what adding *new symbols* does.
   */
  it('is independent of whether this partition\'s own files changed', () => {
    const same = [input('a.zip')];

    expect(changed(record('2026-08-01T00:00:00.000Z'), same)).toBe(false);
    expect(reopened(record('2026-08-01T00:00:00.000Z'), '2026-08-05T00:00:00.000Z')).toBe(true);
  });
});
