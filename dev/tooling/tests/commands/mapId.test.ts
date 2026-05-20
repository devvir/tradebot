import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  encodeDate,
  register,
  _test_normaliseDate,
  _test_isDateLike,
  _test_ID_THRESHOLD,
} from '../../src/commands/mapId';

const SHIFT_38 = 274_877_906_944;

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
    expect(_test_ID_THRESHOLD).toBeLessThan(1 * SHIFT_38);
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

  it('produces a multiple of SHIFT_38 (position and reserved are 0)', () => {
    expect(encodeDate('2029-06-15') % SHIFT_38).toBe(0);
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
