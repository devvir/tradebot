import { describe, it, expect } from 'vitest';
import { expandChannels, parseChannel, parsePools } from '../src/pools';

describe('expandChannels', () => {
  it('fans a poolable channel into one arg per explicit pool', () => {
    expect(expandChannels(['orderBookL2'], ['Primary', 'Secondary']))
      .toEqual(['orderBookL2::Primary', 'orderBookL2::Secondary']);
  });

  it('keeps the channel bare for the default pool', () => {
    expect(expandChannels(['orderBookL2'], ['default'])).toEqual(['orderBookL2']);
  });

  it('emits a non-poolable channel once, regardless of how many pools are requested', () => {
    expect(expandChannels(['liquidation'], ['Primary', 'Secondary'])).toEqual(['liquidation']);
  });

  it('does NOT fan instrument — its pool filter is ignored, so it is subscribed once', () => {
    expect(expandChannels(['instrument'], ['Primary', 'Secondary', 'Aggregated']))
      .toEqual(['instrument']);
  });

  it('fans the partitionable channels while emitting instrument once', () => {
    expect(expandChannels(['instrument', 'orderBookL2'], ['Primary', 'Secondary']))
      .toEqual(['instrument', 'orderBookL2::Primary', 'orderBookL2::Secondary']);
  });

  it('collapses exact duplicates', () => {
    expect(expandChannels(['trade', 'trade'], ['Primary'])).toEqual(['trade::Primary']);
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
