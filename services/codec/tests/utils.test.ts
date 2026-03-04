import { describe, it, expect } from 'vitest';
import { encodeTimestamp, decodeTimestamp } from '../src/encoding/utils';

describe('encodeTimestamp / decodeTimestamp', () => {
  it('round-trips a normal in-range timestamp', () => {
    const iso = '2026-03-05T12:00:00.000Z';
    expect(decodeTimestamp(encodeTimestamp(iso).number)).toBe(iso);
  });

  it('encodes out-of-range timestamp as 0 instead of throwing', () => {
    expect(() => encodeTimestamp('2200-02-01T00:00:00.000Z')).not.toThrow();
    expect(encodeTimestamp('2200-02-01T00:00:00.000Z').number).toBe(0);
  });

  it('decodes 0 back to the BitMEX far-future sentinel', () => {
    expect(decodeTimestamp(0)).toBe('2200-02-01T00:00:00.000Z');
  });

  it('round-trips the BitMEX far-future sentinel', () => {
    const sentinel = '2200-02-01T00:00:00.000Z';
    expect(decodeTimestamp(encodeTimestamp(sentinel).number)).toBe(sentinel);
  });
});
