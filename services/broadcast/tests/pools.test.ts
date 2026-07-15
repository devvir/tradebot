import { describe, it, expect } from 'vitest';
import { expandChannels, parseChannel, parsePools } from '../src/pools';

describe('expandChannels', () => {
  it('fans a fan-out channel into one arg per explicit pool', () => {
    expect(expandChannels(['orderBookL2'], ['Primary', 'Secondary']))
      .toEqual(['orderBookL2::Primary', 'orderBookL2::Secondary']);
  });

  it('fans bins too — their default stream is fused Aggregated', () => {
    expect(expandChannels(['tradeBin1m'], ['Primary', 'Secondary']))
      .toEqual(['tradeBin1m::Primary', 'tradeBin1m::Secondary']);
  });

  it('keeps a fan-out channel bare for the default pool', () => {
    expect(expandChannels(['orderBookL2'], ['default'])).toEqual(['orderBookL2']);
  });

  it('emits a non-fanned channel once, regardless of how many pools are requested', () => {
    expect(expandChannels(['liquidation'], ['Primary', 'Secondary'])).toEqual(['liquidation']);
  });

  it('does NOT fan trade/quote — their bare stream already tags each row by pool', () => {
    expect(expandChannels(['trade', 'quote'], ['Primary', 'Secondary']))
      .toEqual(['trade', 'quote']);
  });

  it('does NOT fan instrument — it carries no pool', () => {
    expect(expandChannels(['instrument'], ['Primary', 'Secondary', 'Aggregated']))
      .toEqual(['instrument']);
  });

  it('fans the fan-out channels while emitting the rest once', () => {
    expect(expandChannels(['instrument', 'trade', 'orderBookL2'], ['Primary', 'Secondary']))
      .toEqual(['instrument', 'trade', 'orderBookL2::Primary', 'orderBookL2::Secondary']);
  });

  it('collapses exact duplicates', () => {
    expect(expandChannels(['trade', 'trade'], ['Primary'])).toEqual(['trade']);
  });
});

describe('parseChannel', () => {
  it('extracts the pool from the all-symbol form', () => {
    expect(parseChannel('orderBookL2::Primary')).toEqual({ base: 'orderBookL2', pool: 'Primary' });
  });

  it('returns no pool for a bare channel', () => {
    expect(parseChannel('instrument')).toEqual({ base: 'instrument' });
  });
});

describe('parsePools', () => {
  it('defaults to a single bare subscription when unset', () => {
    expect(parsePools(undefined)).toEqual(['default']);
    expect(parsePools('')).toEqual(['default']);
  });

  it('normalizes a csv of pools case-insensitively', () => {
    expect(parsePools('primary, Secondary ,aggregated'))
      .toEqual(['Primary', 'Secondary', 'Aggregated']);
  });

  it('throws on an unknown pool', () => {
    expect(() => parsePools('primary,bogus')).toThrow(/bogus/);
  });
});
