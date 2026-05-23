import { describe, it, expect } from 'vitest';
import { encodeDate, _test_ID_THRESHOLD } from '../../../src/tools/db/id';

const SHIFT_38 = 274_877_906_944;

// ─── encodeDate ────────────────────────────────────────────────────────────────

describe('encodeDate', () => {
  it('encodes epoch date to 0', () => {
    expect(encodeDate('2000-01-01')).toBe(0);
  });

  it('encodes a partial year, defaulting to Jan 1', () => {
    expect(encodeDate('2029')).toBe(encodeDate('2029-01-01'));
  });

  it('encodes a partial month, defaulting to day 1', () => {
    expect(encodeDate('2029-03')).toBe(encodeDate('2029-03-01'));
  });

  it('encodes YYYYMMDD without dashes', () => {
    expect(encodeDate('20190901')).toBe(encodeDate('2019-09-01'));
  });

  it('produces a multiple of SHIFT_38 (position and reserved are 0)', () => {
    expect(encodeDate('2029-06-15') % SHIFT_38).toBe(0);
  });
});

// ─── threshold separates YYYYMMDD values from real ids ─────────────────────────

describe('ID_THRESHOLD', () => {
  it('is above the max YYYYMMDD value (20991231)', () => {
    expect(_test_ID_THRESHOLD).toBeGreaterThan(20_991_231);
  });

  it('is below the minimum real id (day 1 after epoch)', () => {
    expect(_test_ID_THRESHOLD).toBeLessThan(1 * SHIFT_38);
  });
});
