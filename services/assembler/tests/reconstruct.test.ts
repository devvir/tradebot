import { describe, it, expect, vi } from 'vitest';
import { reconstruct } from '../src/reconstruct';
import type { WsMessage } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DATE = '2024-01-01T00:00:00.000Z';

const tradeRow = (overrides: Record<string, unknown> = {}) => ({
  symbol:     'XBTUSD',
  price:      29500.5,
  size:       100,
  side:       'Buy',
  timestamp:  '2024-01-01T00:00:00.000Z',
  trdMatchID: '550e8400-e29b-41d4-a716-446655440000',
  ...overrides,
});

// order table has keys: ['orderID'] — good for partial tests
const orderRow = (overrides: Record<string, unknown> = {}) => ({
  orderID:   '550e8400-e29b-41d4-a716-446655440000',
  symbol:    'XBTUSD',
  side:      'Buy',
  ordStatus: 'New',
  timestamp: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const msg = (action: string, data: Record<string, unknown>[], date = DATE): WsMessage => ({
  action,
  date,
  data,
});

// ── partial action ────────────────────────────────────────────────────────────

describe('reconstruct — partial', () => {
  it('returns message with keys, types, and empty filter for unfiltered partial', () => {
    const result = reconstruct('order', msg('partial', [orderRow()]));

    expect(result).not.toBeNull();
    expect(result!.action).toBe('partial');
    expect(result!.keys).toBeDefined();
    expect(Array.isArray(result!.keys)).toBe(true);
    expect(result!.keys!.length).toBeGreaterThan(0);
    expect(result!.types).toBeDefined();
    expect(result!.filter).toEqual({});
  });

  it('decodes partial:<symbol> into action=partial with symbol filter', () => {
    const result = reconstruct('orderBookL2', msg('partial:XBTUSD', [{
      symbol: 'XBTUSD', id: 1, side: 'Buy', size: 100, price: 29500,
      timestamp: '2024-01-01T00:00:00.000Z',
    }]));

    expect(result).not.toBeNull();
    expect(result!.action).toBe('partial');
    expect(result!.filter).toEqual({ symbol: 'XBTUSD' });
    expect(result!.keys).toBeDefined();
    expect(result!.types).toBeDefined();
  });

  it('preserves data fields verbatim', () => {
    const result = reconstruct('order', msg('partial', [orderRow()]));

    expect(result!.data[0]).toMatchObject({
      orderID:   '550e8400-e29b-41d4-a716-446655440000',
      symbol:    'XBTUSD',
      side:      'Buy',
      ordStatus: 'New',
    });
  });
});

// ── insert action ─────────────────────────────────────────────────────────────

describe('reconstruct — insert', () => {
  it('returns message without keys/types/filter', () => {
    const result = reconstruct('trade', msg('insert', [tradeRow()]));

    expect(result).not.toBeNull();
    expect(result!.action).toBe('insert');
    expect(result!.keys).toBeUndefined();
    expect(result!.types).toBeUndefined();
    expect(result!.filter).toBeUndefined();
  });

  it('handles multiple rows', () => {
    const rows = [
      tradeRow({ price: 100, size: 1 }),
      tradeRow({ price: 200, size: 2 }),
    ];

    const result = reconstruct('trade', msg('insert', rows));

    expect(result!.data).toHaveLength(2);
    expect(result!.data[0]).toMatchObject({ price: 100, size: 1 });
    expect(result!.data[1]).toMatchObject({ price: 200, size: 2 });
  });
});

// ── update / delete actions ───────────────────────────────────────────────────

describe('reconstruct — update', () => {
  it('returns message without metadata', () => {
    const result = reconstruct('trade', msg('update', [tradeRow()]));

    expect(result!.action).toBe('update');
    expect(result!.keys).toBeUndefined();
  });
});

describe('reconstruct — delete', () => {
  it('returns message without metadata', () => {
    const result = reconstruct('trade', msg('delete', [tradeRow({ size: '' })]));

    expect(result!.action).toBe('delete');
    expect(result!.keys).toBeUndefined();
  });
});

// ── timestamp field ───────────────────────────────────────────────────────────

describe('reconstruct — timestamp', () => {
  it('uses data row timestamp for tables that have a timestamp field', () => {
    const result = reconstruct('orderBookL2', msg('insert', [
      {
        symbol:    'XBTUSD',
        id:        1234,
        side:      'Buy',
        size:      100,
        price:     29500,
        timestamp: '2024-06-15T12:34:56.789Z',
      },
    ]));

    expect(result!.timestamp).toBe('2024-06-15T12:34:56.789Z');
  });

  it('falls back to message date for tables without a timestamp field', () => {
    const result = reconstruct('liquidation', msg(
      'insert',
      [{ orderID: 'abc', symbol: 'XBTUSD', side: 'Buy', price: 100, leavesQty: 1 }],
      '2024-06-15T00:00:00.000Z',
    ));

    expect(result!.timestamp).toBe('2024-06-15T00:00:00.000Z');
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe('reconstruct — edge cases', () => {
  it('returns null for empty data array', () => {
    expect(reconstruct('trade', msg('insert', []))).toBeNull();
  });

  it('returns null and logs a warning for unknown table', async () => {
    const { logger } = vi.mocked(await import('@devvir/service-kit'));
    const warnSpy    = vi.spyOn(logger, 'warn');

    const result = reconstruct('nonexistent_table_xyz', msg('insert', [tradeRow()]));

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'nonexistent_table_xyz' }),
      expect.stringContaining('No table spec'),
    );
  });

  it('uses orderBook10 table spec (array-of-pairs type)', () => {
    const row = {
      symbol: 'XBTUSD',
      bids:   [[29500, 10]],
      asks:   [[29501, 5]],
    };

    const result = reconstruct('orderBook10', msg('partial', [row]));

    expect(result).not.toBeNull();
    expect(result!.data[0]).toMatchObject({
      symbol: 'XBTUSD',
      bids:   [[29500, 10]],
      asks:   [[29501, 5]],
    });
  });
});
