import { describe, it, expect } from 'vitest';
import { reconstruct, UnknownTableError, type WsMessage } from '../../src/process/reconstruct';
import type { BitmexTable } from '@tradebot/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DATE = '2024-06-15T12:34:56.789Z';

const tradeRow = (overrides: Record<string, unknown> = {}) => ({
  symbol:     'XBTUSD',
  price:      29_500.5,
  size:       100,
  side:       'Buy',
  timestamp:  DATE,
  trdMatchID: '550e8400-e29b-41d4-a716-446655440000',
  ...overrides,
});

const orderRow = (overrides: Record<string, unknown> = {}) => ({
  orderID:   '550e8400-e29b-41d4-a716-446655440000',
  symbol:    'XBTUSD',
  side:      'Buy',
  ordStatus: 'New',
  timestamp: DATE,
  ...overrides,
});

const msg = (action: string, data: Record<string, unknown>[], date = DATE): WsMessage => ({
  action,
  date,
  data,
});

// ── Empty data drop ───────────────────────────────────────────────────────────

describe('reconstruct — empty data', () => {
  it('returns null for empty data (any action)', () => {
    expect(reconstruct('trade', msg('insert', []))).toBeNull();
    expect(reconstruct('orderBookL2', msg('partial', []))).toBeNull();
    expect(reconstruct('chat', msg('insert', []))).toBeNull();
  });
});

// ── Unknown table → throws ────────────────────────────────────────────────────

describe('reconstruct — unknown table', () => {
  it('throws UnknownTableError when the table has no spec', () => {
    expect(() =>
      reconstruct('nonexistent_table_xyz' as BitmexTable, msg('insert', [tradeRow()])),
    ).toThrow(UnknownTableError);
  });

  it('the error carries the offending table name', () => {
    try {
      reconstruct('foo_bar' as BitmexTable, msg('insert', [tradeRow()]));
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownTableError);
      expect((err as UnknownTableError).table).toBe('foo_bar');
    }
  });
});

// ── Action: partial — adds keys/types/filter ──────────────────────────────────

describe('reconstruct — partial action', () => {
  it('adds keys, types, and empty filter for a bare partial', () => {
    const result = reconstruct('order', msg('partial', [orderRow()]));

    expect(result).not.toBeNull();
    expect(result!.action).toBe('partial');
    expect(result!.keys).toBeDefined();
    expect(result!.keys!.length).toBeGreaterThan(0);
    expect(result!.types).toBeDefined();
    expect(result!.filter).toEqual({});
  });

  it('decodes "partial:<symbol>" into action=partial with symbol filter', () => {
    const result = reconstruct('orderBookL2', msg('partial:XBTUSD', [{
      symbol: 'XBTUSD', id: 1, side: 'Buy', size: 100, price: 29_500, timestamp: DATE,
    }]));

    expect(result!.action).toBe('partial');
    expect(result!.filter).toEqual({ symbol: 'XBTUSD' });
    expect(result!.keys).toBeDefined();
    expect(result!.types).toBeDefined();
  });
});

// ── Action: insert/update/delete — no metadata ────────────────────────────────

describe('reconstruct — non-partial actions', () => {
  it.each(['insert', 'update', 'delete'])('omits keys/types/filter on %s', (action) => {
    const result = reconstruct('trade', msg(action, [tradeRow()]));

    expect(result!.action).toBe(action);
    expect(result!.keys).toBeUndefined();
    expect(result!.types).toBeUndefined();
    expect(result!.filter).toBeUndefined();
  });

  it('preserves data fields verbatim', () => {
    const rows   = [tradeRow({ price: 100, size: 1 }), tradeRow({ price: 200, size: 2 })];
    const result = reconstruct('trade', msg('insert', rows));

    expect(result!.data).toHaveLength(2);
    expect(result!.data[0]).toMatchObject({ price: 100, size: 1 });
    expect(result!.data[1]).toMatchObject({ price: 200, size: 2 });
  });
});

// ── Timestamp resolution ──────────────────────────────────────────────────────

describe('reconstruct — timestamp resolution', () => {
  it('uses data[0].timestamp for tables that declare a timestamp field', () => {
    const result = reconstruct('orderBookL2', msg('insert', [{
      symbol: 'XBTUSD', id: 1, side: 'Buy', size: 100, price: 29_500, timestamp: DATE,
    }]));

    expect(result!.timestamp).toBe(DATE);
  });

  it('falls back to message.date when the table has no timestamp field', () => {
    const result = reconstruct('liquidation', msg(
      'insert',
      [{ orderID: 'abc', symbol: 'XBTUSD', side: 'Buy', price: 100, leavesQty: 1 }],
      DATE,
    ));

    expect(result!.timestamp).toBe(DATE);
  });
});

// ── chat table — extra keys/filterKey ─────────────────────────────────────────

describe('reconstruct — chat table', () => {
  it('adds keys=[id] and filterKey=channelID on every action', () => {
    const row = { id: 1, channelID: 1, message: 'hi', date: DATE };

    for (const action of ['partial', 'insert', 'update', 'delete']) {
      const result = reconstruct('chat', msg(action, [row]));

      expect(result!.keys).toEqual(['id']);
      expect(result!.filterKey).toBe('channelID');
    }
  });
});

// ── orderBookL2 legacy backfill ───────────────────────────────────────────────

describe('reconstruct — orderBookL2 legacy backfill', () => {
  const obRow = (overrides: Record<string, unknown> = {}) => ({
    symbol: 'XBTUSD', id: 8_799_000_000, side: 'Sell', size: 100, price: 10_000,
    ...overrides,
  });

  it('fills timestamp, transactTime, and pool from message.date when missing', () => {
    const result = reconstruct('orderBookL2', msg('insert', [obRow()], '2019-06-01T00:00:00.000Z'));

    expect(result!.data[0]).toMatchObject({
      timestamp:    '2019-06-01T00:00:00.000Z',
      transactTime: '2019-06-01T00:00:00.000Z',
      pool:         'Primary',
    });
  });

  it('does not overwrite existing timestamp / transactTime / pool', () => {
    const row = obRow({
      timestamp:    '2021-01-01T12:00:00.000Z',
      transactTime: '2021-01-01T11:59:59.000Z',
      pool:         'Backup',
    });
    const result = reconstruct('orderBookL2', msg('insert', [row], '2021-06-01T00:00:00.000Z'));

    expect(result!.data[0]).toMatchObject({
      timestamp:    '2021-01-01T12:00:00.000Z',
      transactTime: '2021-01-01T11:59:59.000Z',
      pool:         'Backup',
    });
  });

  it('does not apply backfill to other tables', () => {
    const row    = { symbol: 'XBTUSD', markPrice: 10_000 };
    const result = reconstruct('instrument', msg('partial', [row], '2019-06-01T00:00:00.000Z'));

    expect(result!.data[0]).not.toHaveProperty('transactTime');
    expect(result!.data[0]).not.toHaveProperty('pool');
  });
});
