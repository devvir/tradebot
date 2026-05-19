import { describe, it, expect, beforeEach } from 'vitest';
import {
  _test_findCandidate as findCandidate,
  _test_sourceCache   as sourceCache,
  _test_distCache     as distCache,
  _test_reset         as reset,
} from '../../src/utils/dates';

const seedSource = (source: string, dates: string[]): void => {
  sourceCache.set(source, { dates: new Set(dates), at: Date.now() });
};

const seedDist = (target: string, dates: string[]): void => {
  distCache.set(target, { dates: new Set(dates), at: Date.now() });
};

beforeEach(() => {
  reset();
});

describe('findCandidate', () => {
  it('returns null when no source has any done dates', () => {
    seedSource('trade', []);

    expect(findCandidate(['trade'], 'tradeBins')).toBeNull();
  });

  it('returns the oldest done date that is not yet distilled', () => {
    seedSource('trade', ['2026-01-01', '2026-01-02', '2026-01-03']);
    seedDist('tradeBins', []);

    expect(findCandidate(['trade'], 'tradeBins')).toBe('2026-01-01');
  });

  it('skips dates already marked done in the distiller cache', () => {
    seedSource('trade', ['2026-01-01', '2026-01-02', '2026-01-03']);
    seedDist('tradeBins', ['2026-01-01', '2026-01-02']);

    expect(findCandidate(['trade'], 'tradeBins')).toBe('2026-01-03');
  });

  it('returns null when every done date has been distilled', () => {
    seedSource('trade', ['2026-01-01', '2026-01-02']);
    seedDist('tradeBins', ['2026-01-01', '2026-01-02']);

    expect(findCandidate(['trade'], 'tradeBins')).toBeNull();
  });

  it('requires the date to be done in every source for multi-source targets', () => {
    seedSource('instrument',  ['2026-01-01', '2026-01-02', '2026-01-03']);
    seedSource('liquidation', ['2026-01-02', '2026-01-03']);
    seedSource('settlement',  ['2026-01-03']);
    seedDist('instrumentDaily', []);

    expect(findCandidate(['instrument', 'liquidation', 'settlement'], 'instrumentDaily')).toBe('2026-01-03');
  });

  it('yields immediately without any hold once a date is done', () => {
    // The `done` marker is the post-MongoDB confirmation, not a publish marker —
    // there is no waiting period even for the most recent entry.
    seedSource('trade', ['2026-01-01']);
    seedDist('tradeBins', []);

    expect(findCandidate(['trade'], 'tradeBins')).toBe('2026-01-01');
  });
});
