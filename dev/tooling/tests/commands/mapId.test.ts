import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  encodeDate,
  decodeId,
  register,
  _test_normaliseDate,
  _test_isDateLike,
  _test_dateToOffset,
  _test_offsetToIso,
  _test_ID_THRESHOLD,
} from '../../src/commands/mapId.js';

const SHIFT_39 = 549_755_813_888;
const SHIFT_12 = 4_096;

// ─── normaliseDate ─────────────────────────────────────────────────────────────

describe('normaliseDate', () => {
  it('leaves a full YYYYMMDD unchanged', () => {
    expect(_test_normaliseDate('20290101')).toBe('20290101');
  });

  it('strips dashes from ISO format', () => {
    expect(_test_normaliseDate('2029-01-01')).toBe('20290101');
  });

  it('pads missing day to 01', () => {
    expect(_test_normaliseDate('2029-03')).toBe('20290301');
  });

  it('pads missing month and day to 01', () => {
    expect(_test_normaliseDate('2029')).toBe('20290101');
  });
});

// ─── isDateLike ────────────────────────────────────────────────────────────────

describe('isDateLike', () => {
  it('accepts YYYY', () => {
    expect(_test_isDateLike('2029')).toBe(true);
  });

  it('accepts YYYY-MM', () => {
    expect(_test_isDateLike('2029-06')).toBe(true);
  });

  it('accepts YYYY-MM-DD', () => {
    expect(_test_isDateLike('2029-01-01')).toBe(true);
  });

  it('accepts YYYYMMDD (numeric date without dashes)', () => {
    expect(_test_isDateLike('20190901')).toBe(true);
  });

  it('accepts YYYYMM', () => {
    expect(_test_isDateLike('202906')).toBe(true);
  });

  it('rejects alphabetic input', () => {
    expect(_test_isDateLike('foo')).toBe(false);
  });

  it('rejects mixed alphanumeric', () => {
    expect(_test_isDateLike('2029-abc')).toBe(false);
  });

  it('rejects month 00', () => {
    expect(_test_isDateLike('202900')).toBe(false);
  });

  it('rejects month 13', () => {
    expect(_test_isDateLike('202913')).toBe(false);
  });

  it('rejects day 00', () => {
    expect(_test_isDateLike('20290100')).toBe(false);
  });

  it('rejects day 32', () => {
    expect(_test_isDateLike('20290132')).toBe(false);
  });

  it('rejects a 9-digit number (not a date, not an id above threshold)', () => {
    expect(_test_isDateLike('202901011')).toBe(false);
  });
});

// ─── threshold separates YYYYMMDD values from real ids ────────────────────────

describe('ID_THRESHOLD', () => {
  it('is above the max YYYYMMDD value (20991231)', () => {
    expect(_test_ID_THRESHOLD).toBeGreaterThan(20_991_231);
  });

  it('is below the minimum real id (day 1 after epoch)', () => {
    expect(_test_ID_THRESHOLD).toBeLessThan(1 * SHIFT_39);
  });
});

// ─── dateToOffset / offsetToIso round-trip ─────────────────────────────────────

describe('dateToOffset / offsetToIso', () => {
  it('epoch date 2000-01-01 has offset 0', () => {
    expect(_test_dateToOffset('20000101')).toBe(0);
  });

  it('round-trips a known date', () => {
    const offset = _test_dateToOffset('20290101');
    expect(_test_offsetToIso(offset)).toBe('2029-01-01');
  });

  it('round-trips the first day after epoch', () => {
    expect(_test_offsetToIso(_test_dateToOffset('20000102'))).toBe('2000-01-02');
  });
});

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

  it('produces a multiple of SHIFT_39 (position and reserved are 0)', () => {
    const id = encodeDate('2029-06-15');
    expect(id % SHIFT_39).toBe(0);
  });

  it('is consistent with the registrar id layout', () => {
    const offset = _test_dateToOffset('20291231');
    expect(encodeDate('20291231')).toBe(offset * SHIFT_39);
  });
});

// ─── decodeId ──────────────────────────────────────────────────────────────────

describe('decodeId', () => {
  it('decodes epoch id 0', () => {
    const { date, position, reserved } = decodeId(0);
    expect(date).toBe('2000-01-01');
    expect(position).toBe(0);
    expect(reserved).toBe(0);
  });

  it('decodes a pure date id (position=0, reserved=0)', () => {
    const id = encodeDate('2029-01-01');
    const { date, position, reserved } = decodeId(id);
    expect(date).toBe('2029-01-01');
    expect(position).toBe(0);
    expect(reserved).toBe(0);
  });

  it('decodes position correctly', () => {
    const base = encodeDate('2029-01-01');
    const id   = base + 42 * SHIFT_12;
    expect(decodeId(id).position).toBe(42);
  });

  it('decodes reserved correctly', () => {
    const base = encodeDate('2029-01-01');
    const id   = base + 7;
    expect(decodeId(id).reserved).toBe(7);
  });

  it('round-trips encodeDate through decodeId', () => {
    const original = '2025-08-22';
    const id       = encodeDate(original);
    expect(decodeId(id).date).toBe(original);
  });

  it('handles Number.MAX_SAFE_INTEGER boundary', () => {
    expect(() => decodeId(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});

// ─── command registration ──────────────────────────────────────────────────────

describe('mapId command', () => {
  it('registers with name=mapId', () => {
    const program = new Command();
    register(program);
    expect(program.commands.find(c => c.name() === 'mapId')).toBeDefined();
  });

  it('accepts a single <value> argument', () => {
    const program = new Command();
    register(program);
    const cmd = program.commands.find(c => c.name() === 'mapId')!;
    expect(cmd.registeredArguments.length).toBe(1);
  });
});
