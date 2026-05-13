import { describe, it, expect } from 'vitest';
import { buildRanges } from '../../../../src/tools/sources/status/range';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** attr = single character so equality is string ===. */
function build(opts: {
  fromDay:  string;
  toDay:    string;
  attrFor:  (day: string) => string;
  filled?:  Set<string>;
}) {
  return buildRanges<string>({
    fromDay:  opts.fromDay,
    toDay:    opts.toDay,
    attrFor:  opts.attrFor,
    isFilled: d => opts.filled?.has(d) ?? false,
    equal:    (a, b) => a === b,
  });
}

// ── Basic collapsing ──────────────────────────────────────────────────────────

describe('buildRanges — basic', () => {
  it('returns [] when fromDay > toDay', () => {
    const ranges = build({ fromDay: '20260102', toDay: '20260101', attrFor: () => 'A' });

    expect(ranges).toEqual([]);
  });

  it('single day produces one range', () => {
    const ranges = build({ fromDay: '20260101', toDay: '20260101', attrFor: () => 'A' });

    expect(ranges).toEqual([{ start: '20260101', end: '20260101', attr: 'A' }]);
  });

  it('consecutive same-attr days collapse into one range', () => {
    const ranges = build({ fromDay: '20260101', toDay: '20260103', attrFor: () => 'A' });

    expect(ranges).toEqual([{ start: '20260101', end: '20260103', attr: 'A' }]);
  });

  it('attr change splits ranges at the change boundary', () => {
    const attrs: Record<string, string> = {
      '20260101': 'A',
      '20260102': 'A',
      '20260103': 'B',
      '20260104': 'B',
    };
    const ranges = build({ fromDay: '20260101', toDay: '20260104', attrFor: d => attrs[d]! });

    expect(ranges).toEqual([
      { start: '20260101', end: '20260102', attr: 'A' },
      { start: '20260103', end: '20260104', attr: 'B' },
    ]);
  });

  it('every day a different attr → one range per day', () => {
    const attrs: Record<string, string> = {
      '20260101': 'A',
      '20260102': 'B',
      '20260103': 'C',
    };
    const ranges = build({ fromDay: '20260101', toDay: '20260103', attrFor: d => attrs[d]! });

    expect(ranges.map(r => r.attr)).toEqual(['A', 'B', 'C']);
  });
});

// ── Filled days ───────────────────────────────────────────────────────────────

describe('buildRanges — filled days', () => {
  it('filled day inside a range does not split it', () => {
    const filled = new Set(['20260102']);
    const ranges = build({ fromDay: '20260101', toDay: '20260103', attrFor: () => 'A', filled });

    expect(ranges).toEqual([{ start: '20260101', end: '20260103', attr: 'A' }]);
  });

  it('filled day between two different-attr spans does not cause a merge', () => {
    const filled = new Set(['20260102']);
    const attrs: Record<string, string> = { '20260101': 'A', '20260103': 'B' };
    const ranges = build({ fromDay: '20260101', toDay: '20260103', attrFor: d => attrs[d] ?? 'X', filled });

    expect(ranges).toEqual([
      { start: '20260101', end: '20260101', attr: 'A' },
      { start: '20260103', end: '20260103', attr: 'B' },
    ]);
  });

  it('filled day at the start is skipped — first real day opens the range', () => {
    const filled = new Set(['20260101']);
    const ranges = build({ fromDay: '20260101', toDay: '20260103', attrFor: () => 'A', filled });

    expect(ranges).toEqual([{ start: '20260102', end: '20260103', attr: 'A' }]);
  });

  it('filled days at the end extend the last range', () => {
    const filled = new Set(['20260103']);
    const ranges = build({ fromDay: '20260101', toDay: '20260103', attrFor: () => 'A', filled });

    expect(ranges).toEqual([{ start: '20260101', end: '20260102', attr: 'A' }]);
  });

  it('all days filled → []', () => {
    const filled = new Set(['20260101', '20260102', '20260103']);
    const ranges = build({ fromDay: '20260101', toDay: '20260103', attrFor: () => 'A', filled });

    expect(ranges).toEqual([]);
  });

  it('multiple filled days inside a range — end moves to last real day', () => {
    const filled = new Set(['20260102', '20260103', '20260104']);
    const ranges = build({ fromDay: '20260101', toDay: '20260105', attrFor: () => 'A', filled });

    expect(ranges).toEqual([{ start: '20260101', end: '20260105', attr: 'A' }]);
  });
});

// ── Month / year boundary crossing ───────────────────────────────────────────

describe('buildRanges — date arithmetic', () => {
  it('crosses month boundary correctly', () => {
    const ranges = build({ fromDay: '20260130', toDay: '20260201', attrFor: () => 'A' });

    expect(ranges).toEqual([{ start: '20260130', end: '20260201', attr: 'A' }]);
  });

  it('crosses year boundary correctly', () => {
    const ranges = build({ fromDay: '20251231', toDay: '20260101', attrFor: () => 'A' });

    expect(ranges).toEqual([{ start: '20251231', end: '20260101', attr: 'A' }]);
  });
});
