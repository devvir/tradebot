import { describe, it, expect } from 'vitest';
import { isoToMs, msToIso } from '../../../src/tools/data/time';

// ── isoToMs ─────────────────────────────────────────────────────────────────

describe('isoToMs', () => {
  it('matches Date.parse on canonical ISO', () => {
    expect(isoToMs('2026-01-01T00:00:00.000')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(isoToMs('2026-06-15T12:34:56.789')).toBe(Date.parse('2026-06-15T12:34:56.789Z'));
  });

  it('ignores a trailing Z', () => {
    expect(isoToMs('2026-06-15T12:34:56.789Z')).toBe(Date.parse('2026-06-15T12:34:56.789Z'));
  });

  it('treats a missing milliseconds component as .000', () => {
    expect(isoToMs('2026-06-15T12:34:56Z')).toBe(Date.parse('2026-06-15T12:34:56.000Z'));
  });
});

// ── msToIso ─────────────────────────────────────────────────────────────────

describe('msToIso', () => {
  it('is the inverse of isoToMs (23-char form)', () => {
    const iso = '2026-06-15T12:34:56.789';

    expect(msToIso(isoToMs(iso))).toBe(iso);
  });
});
