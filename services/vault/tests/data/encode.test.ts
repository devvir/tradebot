import { describe, it, expect } from 'vitest';
import { encode } from '../../src/data/encode';
import { TABLE_HEADERS } from '../../src/data/headers';

describe('encode — REST row', () => {
  it('serialises a single row in TABLE_HEADERS column order', () => {
    const lines = encode('funding', { timestamp: '2024-01-01', symbol: 'XBTUSD', fundingInterval: '8h', fundingRate: 0.0001, fundingRateDaily: 0.0003 });
    expect(lines).toEqual(['2024-01-01,XBTUSD,8h,0.0001,0.0003']);
  });

  it('emits empty fields for missing columns', () => {
    const lines = encode('funding', { symbol: 'XBTUSD' });
    expect(lines).toEqual([',XBTUSD,,,']);
  });

  it('throws when no header definition exists for the table', () => {
    expect(() => encode('unknownTable', { foo: 'bar' })).toThrow(/No header definition/);
  });
});

describe('encode — WS message', () => {
  it('first line carries _date_/_action_; continuation lines leave them empty', () => {
    const msg = {
      action: 'insert',
      date:   '2024-01-01T00:00:00Z',
      data:   [
        { symbol: 'XBTUSD', id: 1, side: 'Buy',  size: 100, price: 50000 },
        { symbol: 'XBTUSD', id: 2, side: 'Sell', size: 200, price: 50001 },
      ],
    };

    const lines = encode('orderBookL2', msg);
    expect(lines).toHaveLength(2);

    const cols = TABLE_HEADERS['orderBookL2']!;
    const dateIdx   = cols.indexOf('_date_');
    const actionIdx = cols.indexOf('_action_');

    expect(lines[0]!.split(',')[dateIdx]).toBe('2024-01-01T00:00:00Z');
    expect(lines[0]!.split(',')[actionIdx]).toBe('insert');
    expect(lines[1]!.split(',')[dateIdx]).toBe('');
    expect(lines[1]!.split(',')[actionIdx]).toBe('');
  });

  it('emits a single line with metadata for an empty data array', () => {
    const lines = encode('orderBookL2', { action: 'partial', date: '2024-01-01T00:00:00Z', data: [] });
    expect(lines).toHaveLength(1);

    const cols = TABLE_HEADERS['orderBookL2']!;
    const parts = lines[0]!.split(',');
    expect(parts[cols.indexOf('_date_')]).toBe('2024-01-01T00:00:00Z');
    expect(parts[cols.indexOf('_action_')]).toBe('partial');
    expect(parts[cols.indexOf('symbol')]).toBe('');
  });

  it('falls back to wall-clock for missing message date', () => {
    const before = Date.now();
    const lines  = encode('orderBookL2', { action: 'insert', data: [{ symbol: 'XBTUSD', id: 1 }] } as never);
    const after  = Date.now();

    const cols = TABLE_HEADERS['orderBookL2']!;
    const date = lines[0]!.split(',')[cols.indexOf('_date_')]!;
    const ts   = Date.parse(date);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('JSON-stringifies non-primitive values inline (chat.guild)', () => {
    const lines = encode('chat', {
      action: 'insert',
      date:   '2024-01-01T00:00:00Z',
      data:   [{ id: 1, message: 'hi', user: 'alice', guild: { name: 'A&B' } }],
    });

    expect(lines[0]).toContain('"{""name"":""A&B""}"');
  });
});

describe('encode — dispatch', () => {
  it('treats objects without an action field as REST rows', () => {
    const lines = encode('funding', { timestamp: 't', symbol: 'X' });
    expect(lines).toHaveLength(1);
  });

  it('treats objects with action but no array data as REST rows', () => {
    // The route layer rejects malformed messages before reaching encode, but
    // encode itself should not crash on a row that happens to have an `action`
    // field if `data` is missing/non-array — it falls through to rowToCsv.
    const lines = encode('funding', { action: 'something', timestamp: 't' } as never);
    expect(lines).toHaveLength(1);
  });
});
