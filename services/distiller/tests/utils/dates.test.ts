import { describe, it, expect, beforeEach } from 'vitest';
import {
  _test_findCandidate as findCandidate,
  _test_customsCache  as customsCache,
  _test_distCache     as distCache,
  _test_reset         as reset,
} from '../../src/utils/dates';

const seedCustoms = (source: string, dates: string[]): void => {
  customsCache.set(source, { dates: new Set(dates), at: Date.now() });
};

const seedDist = (target: string, dates: string[]): void => {
  distCache.set(target, { dates: new Set(dates), at: Date.now() });
};

beforeEach(() => {
  reset();
});

describe('findCandidate', () => {
  it('returns null when no source has any customs-done dates', () => {
    seedCustoms('trade', []);

    expect(findCandidate(['trade'], 'tradeBins')).toBeNull();
  });

  it('returns the oldest customs-done date that is not yet distilled', () => {
    seedCustoms('trade', ['2026-01-01', '2026-01-02', '2026-01-03']);
    seedDist('tradeBins', []);

    expect(findCandidate(['trade'], 'tradeBins')).toBe('2026-01-01');
  });

  it('skips dates already marked done in the distiller cache', () => {
    seedCustoms('trade', ['2026-01-01', '2026-01-02', '2026-01-03']);
    seedDist('tradeBins', ['2026-01-01', '2026-01-02']);

    expect(findCandidate(['trade'], 'tradeBins')).toBe('2026-01-03');
  });

  it('returns null when every customs-done date has been distilled', () => {
    seedCustoms('trade', ['2026-01-01', '2026-01-02']);
    seedDist('tradeBins', ['2026-01-01', '2026-01-02']);

    expect(findCandidate(['trade'], 'tradeBins')).toBeNull();
  });

  it('requires the date to be done in every source for multi-source targets', () => {
    seedCustoms('instrument',     ['2026-01-01', '2026-01-02', '2026-01-03']);
    seedCustoms('liquidation',    ['2026-01-02', '2026-01-03']);
    seedCustoms('settlement',     ['2026-01-03']);
    seedDist('instrumentDaily', []);

    expect(findCandidate(['instrument', 'liquidation', 'settlement'], 'instrumentDaily')).toBe('2026-01-03');
  });

  it('yields immediately without any hold once a date is customs-done', () => {
    // Even when the date is the most recent customs-done entry, there is no
    // wait — customs:`'done'` is the post-MongoDB confirmation, not a publish marker.
    seedCustoms('trade', ['2026-01-01']);
    seedDist('tradeBins', []);

    expect(findCandidate(['trade'], 'tradeBins')).toBe('2026-01-01');
  });
});
