import { describe, it, expect } from 'vitest';
import { makeMongoId, parseMongoId, startOfDayMongoId } from '../src/mongoIds';

const EPOCH_MS   = Date.UTC(2000, 0, 1);
const MS_PER_DAY = 86_400_000;
const SHIFT_38   = 274_877_906_944;  // 2^38
const SHIFT_8    = 256;              // 2^8

// ── makeMongoId — determinism ─────────────────────────────────────────────────

describe('makeMongoId — determinism', () => {
  it('returns the same id for the same (date, position, reserved)', () => {
    expect(makeMongoId('20240315', 101)).toBe(makeMongoId('20240315', 101));
    expect(makeMongoId('20240315', 101, 7)).toBe(makeMongoId('20240315', 101, 7));
  });

  it('differs across dates', () => {
    expect(makeMongoId('20240315', 1)).not.toBe(makeMongoId('20240316', 1));
  });

  it('differs across positions', () => {
    expect(makeMongoId('20240315', 1)).not.toBe(makeMongoId('20240315', 2));
  });

  it('reserved defaults to 0', () => {
    expect(makeMongoId('20240315', 100)).toBe(makeMongoId('20240315', 100, 0));
  });
});

// ── makeMongoId — date format ─────────────────────────────────────────────────

describe('makeMongoId — date format', () => {
  it('accepts YYYYMMDD', () => {
    expect(() => makeMongoId('20240315', 1)).not.toThrow();
  });

  it('accepts YYYY-MM-DD', () => {
    expect(makeMongoId('2024-03-15', 1)).toBe(makeMongoId('20240315', 1));
  });
});

// ── makeMongoId — bit layout ──────────────────────────────────────────────────

describe('makeMongoId — bit layout', () => {
  it('epoch date + position 1 yields 0 (first slot is zero)', () => {
    expect(makeMongoId('20000101', 1)).toBe(0);
  });

  it('one-day offset multiplies SHIFT_38', () => {
    expect(makeMongoId('20000102', 1)).toBe(SHIFT_38);
  });

  it('position N stores slot N-1 → (N-1) * SHIFT_8', () => {
    expect(makeMongoId('20000101', 2)).toBe(SHIFT_8);
    expect(makeMongoId('20000101', 8)).toBe(7 * SHIFT_8);
  });

  it('reserved sits in the bottom 8 bits', () => {
    expect(makeMongoId('20000101', 1, 1)).toBe(1);
    expect(makeMongoId('20000101', 1, 255)).toBe(255);
  });

  it('composes all three components correctly', () => {
    const expected = 5 * SHIFT_38 + 3 * SHIFT_8 + 9;

    /** dateOffset=5, position=4 → slot=3, reserved=9 */
    expect(makeMongoId('20000106', 4, 9)).toBe(expected);
  });
});

// ── makeMongoId — date arithmetic ─────────────────────────────────────────────

describe('makeMongoId — date arithmetic', () => {
  it('handles leap year (2000 → 366 days to 2001-01-01)', () => {
    expect(makeMongoId('20010101', 1)).toBe(366 * SHIFT_38);
  });

  it('handles non-leap year (2001 → 365 days to 2002-01-01)', () => {
    expect(makeMongoId('20020101', 1)).toBe((366 + 365) * SHIFT_38);
  });

  it('matches a manually-computed offset for an arbitrary date', () => {
    const expectedOffset = (Date.UTC(2024, 2, 15) - EPOCH_MS) / MS_PER_DAY;

    expect(makeMongoId('20240315', 1)).toBe(expectedOffset * SHIFT_38);
  });
});

// ── makeMongoId — overflow validation ─────────────────────────────────────────

describe('makeMongoId — overflow validation', () => {
  it('throws when date offset exceeds 15 bits', () => {
    /** 2000-01-01 + 32768 days ≈ 2089-09-01 — just past the 15-bit limit */
    expect(() => makeMongoId('20891001', 1)).toThrow(RangeError);
  });

  it('does not throw at the max safe date offset (2^15 − 1 days = ~2089)', () => {
    const maxOffset = (2 ** 15) - 1;
    const ms        = EPOCH_MS + maxOffset * MS_PER_DAY;
    const d         = new Date(ms);
    const ymd       = d.toISOString().slice(0, 10).replace(/-/g, '');

    expect(() => makeMongoId(ymd, 1)).not.toThrow();
  });

  it('throws when position exceeds 30-bit slot capacity', () => {
    const maxPosition = (2 ** 30) + 1;  // one beyond the limit

    expect(() => makeMongoId('20240101', maxPosition)).toThrow(RangeError);
  });

  it('does not throw at the max valid position (2^30)', () => {
    expect(() => makeMongoId('20240101', 2 ** 30)).not.toThrow();
  });

  it('throws when reserved exceeds 8 bits', () => {
    expect(() => makeMongoId('20240101', 1, 256)).toThrow(RangeError);
  });

  it('does not throw at the max reserved value (255)', () => {
    expect(() => makeMongoId('20240101', 1, 255)).not.toThrow();
  });

  it('throws when position is 0 (must be 1-based)', () => {
    expect(() => makeMongoId('20240101', 0)).toThrow(RangeError);
  });

  it('throws when reserved is negative', () => {
    expect(() => makeMongoId('20240101', 1, -1)).toThrow(RangeError);
  });
});

// ── makeMongoId — 53-bit safety ───────────────────────────────────────────────

describe('makeMongoId — 53-bit safety', () => {
  it('max representable composition equals Number.MAX_SAFE_INTEGER', () => {
    const maxOffset   = (2 ** 15) - 1;
    const maxPosition = (2 ** 30);       // slot = 2^30 - 1
    const maxReserved = (2 ** 8)  - 1;

    const ms  = EPOCH_MS + maxOffset * MS_PER_DAY;
    const ymd = new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
    const id  = makeMongoId(ymd, maxPosition, maxReserved);

    expect(id).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('typical outputs are safe integers', () => {
    const ids = [
      makeMongoId('20000101', 1),
      makeMongoId('20240315', 5_000_000),
      makeMongoId('20440101', 1, 255),
    ];

    for (const id of ids) {
      expect(Number.isSafeInteger(id)).toBe(true);
    }
  });
});

// ── parseMongoId ──────────────────────────────────────────────────────────────

describe('parseMongoId', () => {
  it('decodes epoch id 0 — first record of the epoch day', () => {
    const { date, position, reserved } = parseMongoId(0);

    expect(date).toBe('2000-01-01');
    expect(position).toBe(1);
    expect(reserved).toBe(0);
  });

  it('decodes position correctly (1-based)', () => {
    const id = makeMongoId('20290101', 1) + 42 * SHIFT_8;

    expect(parseMongoId(id).position).toBe(43);  // slot 42 → position 43
  });

  it('decodes reserved correctly', () => {
    const id = makeMongoId('20290101', 1) + 7;

    expect(parseMongoId(id).reserved).toBe(7);
  });

  it('returns date as YYYY-MM-DD', () => {
    expect(parseMongoId(makeMongoId('20260101', 1)).date).toBe('2026-01-01');
  });
});

// ── makeMongoId + parseMongoId — round-trip ───────────────────────────────────

describe('makeMongoId / parseMongoId — round-trip', () => {
  it('round-trips date, position, and reserved', () => {
    const cases: [string, number, number][] = [
      ['20000101', 1,    0],
      ['20240315', 1000, 0],
      ['20260308', 50,   7],
      ['20440101', 1,    255],
    ];

    for (const [date, position, reserved] of cases) {
      const id = makeMongoId(date, position, reserved);
      const decoded = parseMongoId(id);

      expect(decoded.date).toBe(date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8));
      expect(decoded.position).toBe(position);
      expect(decoded.reserved).toBe(reserved);
    }
  });
});

// ── startOfDayMongoId ─────────────────────────────────────────────────────────

describe('startOfDayMongoId', () => {
  it('returns 0 for epoch date', () => {
    expect(startOfDayMongoId('20000101')).toBe(0);
  });

  it('equals makeMongoId(date, 1) — same as first record of the day', () => {
    expect(startOfDayMongoId('20240315')).toBe(makeMongoId('20240315', 1));
  });

  it('accepts YYYYMMDD', () => {
    expect(startOfDayMongoId('20290101')).toBe((Date.UTC(2029, 0, 1) - EPOCH_MS) / MS_PER_DAY * SHIFT_38);
  });

  it('accepts YYYY-MM-DD', () => {
    expect(startOfDayMongoId('2029-01-01')).toBe(startOfDayMongoId('20290101'));
  });

  it('accepts ISO timestamp — strips time component', () => {
    expect(startOfDayMongoId('2029-01-01T12:00:00')).toBe(startOfDayMongoId('20290101'));
    expect(startOfDayMongoId('20290101T00:00:00')).toBe(startOfDayMongoId('20290101'));
  });

  it('consecutive days produce SHIFT_38-spaced ids', () => {
    const d1 = startOfDayMongoId('20260315');
    const d2 = startOfDayMongoId('20260316');

    expect(d2 - d1).toBe(SHIFT_38);
  });

  it('is a multiple of SHIFT_38', () => {
    expect(startOfDayMongoId('20290615') % SHIFT_38).toBe(0);
  });
});

// ── Range query semantics ─────────────────────────────────────────────────────

describe('range query semantics', () => {
  it('$gte startOfDayMongoId(d) includes the first record of day d', () => {
    const first = makeMongoId('20260315', 1);

    expect(first).toBeGreaterThanOrEqual(startOfDayMongoId('20260315'));
  });

  it('$lt startOfDayMongoId(d+1) excludes the first record of d+1', () => {
    const firstOfNext = makeMongoId('20260316', 1);

    expect(firstOfNext).not.toBeLessThan(startOfDayMongoId('20260316'));
  });

  it('any record on day d is inside [startOfDay(d), startOfDay(d+1))', () => {
    const lo  = startOfDayMongoId('20260315');
    const hi  = startOfDayMongoId('20260316');
    const ids = [
      makeMongoId('20260315', 1),
      makeMongoId('20260315', 1_000_000, 128),
      makeMongoId('20260315', 2 ** 30, 255),
    ];

    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(lo);
      expect(id).toBeLessThan(hi);
    }
  });
});
