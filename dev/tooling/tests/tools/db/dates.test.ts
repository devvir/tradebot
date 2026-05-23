import { describe, it, expect } from 'vitest';
import { startOfDayMongoId } from '@tradebot/utils';
import { isDateLike, normaliseDate, parseDateRange } from '../../../src/tools/db/utils/dates';

// ─── isDateLike ────────────────────────────────────────────────────────────────

describe('isDateLike', () => {
  it('accepts YYYY', () => {
    expect(isDateLike('2029')).toBe(true);
  });

  it('accepts YYYY-MM', () => {
    expect(isDateLike('2029-06')).toBe(true);
  });

  it('accepts YYYY-MM-DD', () => {
    expect(isDateLike('2029-01-01')).toBe(true);
  });

  it('accepts YYYYMMDD (numeric date without dashes)', () => {
    expect(isDateLike('20190901')).toBe(true);
  });

  it('accepts YYYYMM', () => {
    expect(isDateLike('202906')).toBe(true);
  });

  it('rejects alphabetic input', () => {
    expect(isDateLike('foo')).toBe(false);
  });

  it('rejects mixed alphanumeric', () => {
    expect(isDateLike('2029-abc')).toBe(false);
  });

  it('rejects month 00', () => {
    expect(isDateLike('202900')).toBe(false);
  });

  it('rejects month 13', () => {
    expect(isDateLike('202913')).toBe(false);
  });

  it('rejects day 00', () => {
    expect(isDateLike('20290100')).toBe(false);
  });

  it('rejects day 32', () => {
    expect(isDateLike('20290132')).toBe(false);
  });

  it('rejects a 9-digit number', () => {
    expect(isDateLike('202901011')).toBe(false);
  });
});

// ─── normaliseDate ─────────────────────────────────────────────────────────────

describe('normaliseDate', () => {
  it('leaves a full YYYYMMDD unchanged', () => {
    expect(normaliseDate('20290101')).toBe('20290101');
  });

  it('strips dashes from ISO format', () => {
    expect(normaliseDate('2029-01-01')).toBe('20290101');
  });

  it('pads missing day to 01', () => {
    expect(normaliseDate('2029-03')).toBe('20290301');
  });

  it('pads missing month and day to 01', () => {
    expect(normaliseDate('2029')).toBe('20290101');
  });
});

// ─── parseDateRange ────────────────────────────────────────────────────────────

describe('parseDateRange', () => {
  it('YYYY → entire calendar year', () => {
    const r = parseDateRange('2026');
    expect(r.label).toBe('2026');
    expect(r.key).toBe('2026');
    expect(r.startId).toBe(startOfDayMongoId('20260101'));
    expect(r.endId).toBe(startOfDayMongoId('20270101'));
  });

  it('YYYYMM → entire calendar month', () => {
    const r = parseDateRange('202504');
    expect(r.label).toBe('2025-04');
    expect(r.key).toBe('202504');
    expect(r.startId).toBe(startOfDayMongoId('20250401'));
    expect(r.endId).toBe(startOfDayMongoId('20250501'));
  });

  it('YYYY-MM with dash → same as YYYYMM', () => {
    const dashed = parseDateRange('2024-03');
    const compact = parseDateRange('202403');
    expect(dashed.startId).toBe(compact.startId);
    expect(dashed.endId).toBe(compact.endId);
    expect(dashed.label).toBe('2024-03');
    expect(dashed.key).toBe('202403');
  });

  it('YYYYMMDD → single day', () => {
    const r = parseDateRange('20240315');
    expect(r.label).toBe('2024-03-15');
    expect(r.key).toBe('20240315');
    expect(r.startId).toBe(startOfDayMongoId('20240315'));
    expect(r.endId).toBe(startOfDayMongoId('20240316'));
  });

  it('YYYY-MM-DD with dashes → same as YYYYMMDD', () => {
    const dashed = parseDateRange('2024-03-15');
    const compact = parseDateRange('20240315');
    expect(dashed.startId).toBe(compact.startId);
    expect(dashed.endId).toBe(compact.endId);
  });

  it('YYYYMM December rolls into next year', () => {
    const r = parseDateRange('202412');
    expect(r.startId).toBe(startOfDayMongoId('20241201'));
    expect(r.endId).toBe(startOfDayMongoId('20250101'));
  });

  it('YYYYMMDD end-of-month rolls into next month', () => {
    const r = parseDateRange('20240131');
    expect(r.endId).toBe(startOfDayMongoId('20240201'));
  });

  it('throws on invalid input', () => {
    expect(() => parseDateRange('foo')).toThrow();
  });
});
