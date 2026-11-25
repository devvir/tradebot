import { describe, it, expect } from 'vitest';
import { applyCasts, compileCasts, TABLE_CASTS } from '../../src/data/casts';
import { TABLE_HEADERS } from '../../src/data/headers';

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

  it('reads a zone-less timestamp_D as UTC, keeping all nine fractional digits', () => {
    const result = applyCasts({ timestamp: '2019-01-01D00:00:03.181913000' }, 'trade');
    expect(result['timestamp']).toBe('2019-01-01T00:00:03.181913000Z');
  });

  it('keeps the zone of a timestamp_D that has an offset', () => {
    expect(applyCasts({ timestamp: '2019-01-01D00:00:03+01:00' }, 'trade')['timestamp']).toBe('2019-01-01T00:00:03+01:00');
    expect(applyCasts({ timestamp: '2019-01-01D00:00:03-0500' }, 'trade')['timestamp']).toBe('2019-01-01T00:00:03-0500');
  });

  it('casts compositeIndex numeric fields and leaves its symbols as strings', () => {
    const result = applyCasts({ lastPrice: '23000.5', weight: '0.25', symbol: '.BXBT', reference: 'BSTP' }, 'compositeIndex');
    expect(result).toEqual({ lastPrice: 23000.5, weight: 0.25, symbol: '.BXBT', reference: 'BSTP' });
  });

  it('casts a pseudo-table like its base table', () => {
    const row = { timestamp: '2019-01-01D00:00:03.181913000', symbol: 'XBTUSD', bidSize: '100', bidPrice: '42000.5', pool: '' };
    expect(applyCasts(row, 'quote.secondary')).toEqual(applyCasts(row, 'quote'));
  });

  it('drops empty fields for every table', () => {
    for (const table of [...Object.keys(TABLE_CASTS), 'unknowntable']) {
      const cols = ['symbol', ...Object.keys(TABLE_CASTS[table] ?? {})];
      const raw  = Object.fromEntries(cols.map(col => [col, '']));

      expect(applyCasts(raw, table), table).toEqual({});
    }
  });

  it('returns an empty object for an unknown table with all-empty values', () => {
    const result = applyCasts({ a: '', b: '' }, 'unknowntable');
    expect(result).toEqual({});
  });
});

describe('TABLE_CASTS', () => {
  it('has an entry for every table with a header definition', () => {
    const missing = Object.keys(TABLE_HEADERS).filter(table => ! (table in TABLE_CASTS));
    expect(missing).toEqual([]);
  });
});

describe('compileCasts', () => {
  it('casts fields by column position', () => {
    const toRow = compileCasts('trade', ['timestamp', 'symbol', 'size', 'price']);

    expect(toRow(['2019-01-01D00:00:03.181913000', 'XBTUSD', '100', '30000.5'])).toEqual({
      timestamp: '2019-01-01T00:00:03.181913000Z', symbol: 'XBTUSD', size: 100, price: 30000.5,
    });
  });

  it('reads columns from the given offset', () => {
    const toRow = compileCasts('orderBookL2', ['symbol', 'id', 'size'], 2);

    expect(toRow(['2023-02-01T00:00:00Z', 'insert', 'XBTUSD', '7', '100'])).toEqual({ symbol: 'XBTUSD', id: 7, size: 100 });
  });

  it('drops empty and missing fields and ignores fields beyond the columns', () => {
    const toRow = compileCasts('trade', ['symbol', 'size', 'price']);

    expect(toRow(['XBTUSD', ''])).toEqual({ symbol: 'XBTUSD' });
    expect(toRow(['', '', '', 'extra'])).toEqual({});
  });

  it('gives each row its own object', () => {
    const toRow = compileCasts('trade', ['symbol']);
    const a     = toRow(['XBTUSD']);
    const b     = toRow(['ETHUSD']);

    expect(a).toEqual({ symbol: 'XBTUSD' });
    expect(b).toEqual({ symbol: 'ETHUSD' });
  });
});
