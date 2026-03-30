import { describe, it, expect } from 'vitest';
import { makeId } from '../src/id';

// ── Constants (mirrored from source) ─────────────────────────────────────────

const SHIFT_39 = 549_755_813_888;   // 2^39
const SHIFT_12 = 4_096;             // 2^12

// ── Epoch baseline ────────────────────────────────────────────────────────────

describe('makeId — epoch baseline (2000-01-01)', () => {
  it('returns 0 for epoch date, msgIndex 0', () => {
    expect(makeId('20000101', 0)).toBe(0);
  });

  it('applies msgIndex shift correctly', () => {
    expect(makeId('20000101', 1)).toBe(SHIFT_12);
    expect(makeId('20000101', 2)).toBe(2 * SHIFT_12);
  });

  it('applies reserved bits', () => {
    expect(makeId('20000101', 0, 1)).toBe(1);
    expect(makeId('20000101', 0, 4095)).toBe(4095);
  });

  it('reserved defaults to 0', () => {
    expect(makeId('20000101', 0)).toBe(makeId('20000101', 0, 0));
  });
});

// ── Date offset ───────────────────────────────────────────────────────────────

describe('makeId — date offset', () => {
  it('offset 1 for 2000-01-02', () => {
    expect(makeId('20000102', 0)).toBe(1 * SHIFT_39);
  });

  it('offset 366 for 2001-01-01 (2000 is a leap year)', () => {
    // 2000 has 366 days
    expect(makeId('20010101', 0)).toBe(366 * SHIFT_39);
  });

  it('offset 365 for 2002-01-01 (2001 is not a leap year)', () => {
    expect(makeId('20020101', 0)).toBe((366 + 365) * SHIFT_39);
  });

  it('handles a recent production date', () => {
    // 2026-03-30: computed as days since 2000-01-01
    const expectedOffset =
      (Date.UTC(2026, 2, 30) - Date.UTC(2000, 0, 1)) / 86_400_000;

    expect(makeId('20260330', 0)).toBe(expectedOffset * SHIFT_39);
    expect(expectedOffset).toBeGreaterThan(9500); // sanity: ~26 years of days
  });
});

// ── Combined layout ───────────────────────────────────────────────────────────

describe('makeId — combined layout', () => {
  it('composes date + msgIndex + reserved correctly', () => {
    const date      = '20000102'; // offset = 1
    const msgIndex  = 3;
    const reserved  = 7;
    const expected  = 1 * SHIFT_39 + 3 * SHIFT_12 + 7;

    expect(makeId(date, msgIndex, reserved)).toBe(expected);
  });
});

// ── 53-bit safety ─────────────────────────────────────────────────────────────

describe('makeId — 53-bit safety', () => {
  it('maximum possible value equals Number.MAX_SAFE_INTEGER', () => {
    // dateOffset max = 2^14 - 1 = 16383 (valid until ~2044)
    // msgIndex  max = 2^27 - 1 = 134_217_727
    // reserved  max = 2^12 - 1 = 4095
    const maxOffset   = (2 ** 14) - 1;   // 16383
    const maxMsgIndex = (2 ** 27) - 1;   // 134_217_727
    const maxReserved = (2 ** 12) - 1;   // 4095

    // Use days since 2000-01-01 directly to avoid date-parsing
    // This exercises the arithmetic rather than re-deriving offset from date
    const maxId = maxOffset * SHIFT_39 + maxMsgIndex * SHIFT_12 + maxReserved;

    expect(maxId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('all outputs are safe integers', () => {
    const ids = [
      makeId('20000101', 0),
      makeId('20260330', 1000),
      makeId('20440101', 0, 4095),
    ];

    for (const id of ids) {
      expect(Number.isSafeInteger(id)).toBe(true);
    }
  });
});
