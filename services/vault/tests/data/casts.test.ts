import { describe, it, expect } from 'vitest';
import { applyCasts } from '../../src/data/casts';

describe('applyCasts', () => {
  it('passes string fields through unchanged', () => {
    const result = applyCasts({ symbol: 'XBTUSD', side: 'Buy' }, 'trade');
    expect(result).toMatchObject({ symbol: 'XBTUSD', side: 'Buy' });
  });

  it('drops empty string fields by default', () => {
    const result = applyCasts({ symbol: 'XBTUSD', foreignNotional: '' }, 'trade');
    expect(result).not.toHaveProperty('foreignNotional');
  });

  it('casts number fields', () => {
    const result = applyCasts({ size: '100', price: '30000.5' }, 'trade');
    expect(result['size']).toBe(100);
    expect(result['price']).toBe(30000.5);
  });

  it('casts boolean fields', () => {
    // instrument: isInverse is boolean; position: isOpen is boolean
    const instrument = applyCasts({ isInverse: 'false' }, 'instrument');
    const position   = applyCasts({ isOpen: 'true' }, 'position');
    expect(instrument['isInverse']).toBe(false);
    expect(position['isOpen']).toBe(true);
  });

  it('parses json fields', () => {
    const result = applyCasts({ bids: '[[29000,100]]', asks: '[[29100,50]]' }, 'orderBook10');
    expect(result['bids']).toEqual([[29000, 100]]);
    expect(result['asks']).toEqual([[29100, 50]]);
  });

  it('falls back to raw string on invalid JSON', () => {
    const result = applyCasts({ bids: 'not-json' }, 'orderBook10');
    expect(result['bids']).toBe('not-json');
  });

  it('converts timestamp_D fields (D→T)', () => {
    const result = applyCasts({ timestamp: '2023-02-01D00:00:00.000Z' }, 'quote');
    expect(result['timestamp']).toBe('2023-02-01T00:00:00.000Z');
  });

  it('returns an empty object for an unknown table with all-empty values', () => {
    const result = applyCasts({ a: '', b: '' }, 'unknowntable');
    expect(result).toEqual({});
  });
});
