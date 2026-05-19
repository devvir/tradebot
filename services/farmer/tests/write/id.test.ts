import { describe, it, expect } from 'vitest';
import {
  makeId,
  _test_EPOCH_MS   as EPOCH_MS,
  _test_MS_PER_DAY as MS_PER_DAY,
  _test_SHIFT_39   as SHIFT_39,
  _test_SHIFT_12   as SHIFT_12,
} from '../../src/write/id';

// ── Determinism ───────────────────────────────────────────────────────────────

describe('makeId — determinism', () => {
  it('returns the same id for the same (date, position, reserved)', () => {
    expect(makeId('20240315', 101)).toBe(makeId('20240315', 101));
    expect(makeId('20240315', 101, 7)).toBe(makeId('20240315', 101, 7));
  });

  it('differs across dates', () => {
    expect(makeId('20240315', 1)).not.toBe(makeId('20240316', 1));
  });

  it('differs across positions', () => {
    expect(makeId('20240315', 1)).not.toBe(makeId('20240315', 2));
  });

  it('reserved defaults to 0', () => {
    expect(makeId('20240315', 100)).toBe(makeId('20240315', 100, 0));
  });
});

// ── Bit layout (1-based position translates to 0-based slot internally) ───────

describe('makeId — bit layout', () => {
  it('epoch date + position 1 yields 0 (first slot is zero)', () => {
    expect(makeId('20000101', 1)).toBe(0);
  });

  it('one-day offset multiplies SHIFT_39', () => {
    expect(makeId('20000102', 1)).toBe(SHIFT_39);
  });

  it('position N translates to slot N-1 → (N-1) * SHIFT_12', () => {
    expect(makeId('20000101', 2)).toBe(SHIFT_12);
    expect(makeId('20000101', 8)).toBe(7 * SHIFT_12);
  });

  it('reserved sits in the bottom bits', () => {
    expect(makeId('20000101', 1, 1)).toBe(1);
    expect(makeId('20000101', 1, 4095)).toBe(4095);
  });

  it('composes all three components correctly', () => {
    const expected = 5 * SHIFT_39 + 3 * SHIFT_12 + 9;

    /** date offset 5, position 4 → slot 3, reserved 9. */
    expect(makeId('20000106', 4, 9)).toBe(expected);
  });
});

// ── Date arithmetic ───────────────────────────────────────────────────────────

describe('makeId — date arithmetic', () => {
  it('handles leap year (2000 → 366 days to 2001-01-01)', () => {
    expect(makeId('20010101', 1)).toBe(366 * SHIFT_39);
  });

  it('handles non-leap year (2001 → 365 days to 2002-01-01)', () => {
    expect(makeId('20020101', 1)).toBe((366 + 365) * SHIFT_39);
  });

  it('matches a manually-computed offset for an arbitrary date', () => {
    const date           = '20240315';
    const expectedOffset = (Date.UTC(2024, 2, 15) - EPOCH_MS) / MS_PER_DAY;

    expect(makeId(date, 1)).toBe(expectedOffset * SHIFT_39);
  });
});

// ── Mongo _id stability with legacy 0-based ids ───────────────────────────────

describe('makeId — backward compatibility with legacy 0-based slots', () => {
  it('position 1 maps to the slot the legacy index-0 formula produced', () => {
    /** Legacy formula was `dateOffset * SHIFT_39 + index * SHIFT_12` with index=0
     *  → contributes nothing to the bottom bits. position=1 must do the same so
     *  existing mongo _ids still collide on E11000. */
    const legacy = (Date.UTC(2024, 2, 15) - EPOCH_MS) / MS_PER_DAY * SHIFT_39;

    expect(makeId('20240315', 1)).toBe(legacy);
  });

  it('position N maps to the slot the legacy index-(N-1) formula produced', () => {
    const date  = '20240315';
    const dateO = (Date.UTC(2024, 2, 15) - EPOCH_MS) / MS_PER_DAY;
    /** N = 50: legacy was dateO * SHIFT_39 + 49 * SHIFT_12. */
    const legacy = dateO * SHIFT_39 + 49 * SHIFT_12;

    expect(makeId(date, 50)).toBe(legacy);
  });
});

// ── 53-bit safety ─────────────────────────────────────────────────────────────

describe('makeId — 53-bit safety', () => {
  it('max representable composition equals Number.MAX_SAFE_INTEGER', () => {
    const maxOffset   = (2 ** 14) - 1;
    const maxSlot     = (2 ** 27) - 1;  // position - 1
    const maxReserved = (2 ** 12) - 1;

    const maxId = maxOffset * SHIFT_39 + maxSlot * SHIFT_12 + maxReserved;

    expect(maxId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('typical outputs are safe integers', () => {
    const ids = [
      makeId('20000101', 1),
      makeId('20240315', 5_000_000),
      makeId('20440101', 1, 4095),
    ];

    for (const id of ids) {
      expect(Number.isSafeInteger(id)).toBe(true);
    }
  });
});
