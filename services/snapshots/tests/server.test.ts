import { describe, it, expect } from 'vitest';
import { createDatabase } from '@devvir/bitmex-database';
import type { BitmexTable, Database } from '@devvir/bitmex-database';

// ── Inline the server response logic for unit testing ─────────────────────────

const buildResponse = (
  db:       Database,
  tables:   Set<string>,
  counters: Record<string, number>,
  table:    string,
  symbol?:  string,
  account?: string,
) => {
  if (! tables.has(table)) {
    return { status: 404, body: { error: `No snapshot for table '${table}'` } };
  }

  const view = db.view(table as BitmexTable);
  let   data = db.snapshot(table as BitmexTable);

  if (symbol  && 'symbol'  in view.types) data = data.filter(r => (r as Record<string, unknown>).symbol  === symbol);
  if (account && 'account' in view.types) data = data.filter(r => (r as Record<string, unknown>).account === Number(account));

  if (table === 'trade') data = data.slice(-1000);
  if (table === 'quote') data = data.slice(-100);

  const filter: Record<string, string> = {};

  if (symbol)  filter.symbol  = symbol;
  if (account) filter.account = account;

  return {
    status: 200,
    body: {
      table:   view.table,
      keys:    view.keys,
      types:   view.types,
      data,
      counter: counters[table] ?? 0,
      filter,
    },
  };
};

// ── 404 for unknown table ─────────────────────────────────────────────────────

describe('server — 404 for unknown table', () => {
  it('returns 404 when table has never received a partial', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    const res = buildResponse(db, tables, counters, 'orderBookL2');

    expect(res.status).toBe(404);
  });

  it('returns 200 after partial received', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'orderBookL2',
      action: 'partial',
      keys: ['id'],
      types: { id: 'long' },
      data: [],
    });
    tables.add('orderBookL2');

    const res = buildResponse(db, tables, counters, 'orderBookL2');

    expect(res.status).toBe(200);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe('server — response shape', () => {
  it('includes table metadata and data', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'orderBookL2',
      action: 'partial',
      keys: ['id'],
      types: { id: 'long', side: 'symbol' },
      data: [{ id: 1, symbol: 'XBTUSD', side: 'Buy' }],
    });
    tables.add('orderBookL2');
    counters['orderBookL2'] = 5;

    const res = buildResponse(db, tables, counters, 'orderBookL2');

    expect(res.status).toBe(200);
    expect(res.body.table).toBe('orderBookL2');
    expect(res.body.keys).toEqual(['id']);
    expect(res.body.counter).toBe(5);
    expect(res.body.data).toHaveLength(1);
  });
});

// ── Symbol filtering ──────────────────────────────────────────────────────────

describe('server — symbol filtering', () => {
  it('filters rows by symbol when ?symbol= is provided', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'instrument',
      action: 'partial',
      keys: ['symbol'],
      types: { symbol: 'symbol' },
      data: [
        { symbol: 'XBTUSD', price: 100 },
        { symbol: 'ETHUSD', price: 50 },
      ],
    });
    tables.add('instrument');

    const res = buildResponse(db, tables, counters, 'instrument', 'XBTUSD');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    expect((res.body as { data: { symbol: string }[] }).data[0].symbol).toBe('XBTUSD');
  });

  it('returns all rows when no symbol filter', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'instrument',
      action: 'partial',
      keys: ['symbol'],
      types: { symbol: 'symbol' },
      data: [
        { symbol: 'XBTUSD', price: 100 },
        { symbol: 'ETHUSD', price: 50 },
      ],
    });
    tables.add('instrument');

    const res = buildResponse(db, tables, counters, 'instrument');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(2);
  });

  it('does not filter by symbol on tables with no symbol field', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'connected',
      action: 'partial',
      keys: ['id'],
      types: { id: 'integer' },
      data: [{ id: 1, users: 5, bots: 2 }],
    });
    tables.add('connected');

    // passes symbol= but table has no symbol field — should not filter
    const res = buildResponse(db, tables, counters, 'connected', 'XBTUSD');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(1);
  });
});

// ── Account filtering ─────────────────────────────────────────────────────────

describe('server — account filtering', () => {
  it('filters rows by account when ?account= is provided', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'order',
      action: 'partial',
      keys: ['orderID'],
      types: { orderID: 'guid', account: 'long', symbol: 'symbol' },
      data: [
        { orderID: 'a', account: 1, symbol: 'XBTUSD' },
        { orderID: 'b', account: 2, symbol: 'XBTUSD' },
      ],
    });
    tables.add('order');
    counters['order'] = 7;

    const res = buildResponse(db, tables, counters, 'order', undefined, '1');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    expect((res.body as { data: { account: number }[] }).data[0].account).toBe(1);
    expect((res.body as { counter: number }).counter).toBe(7);
    expect((res.body as { filter: Record<string, string> }).filter).toEqual({ account: '1' });
  });

  it('returns all rows when no account filter', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'order',
      action: 'partial',
      keys: ['orderID'],
      types: { orderID: 'guid', account: 'long', symbol: 'symbol' },
      data: [
        { orderID: 'a', account: 1, symbol: 'XBTUSD' },
        { orderID: 'b', account: 2, symbol: 'XBTUSD' },
      ],
    });
    tables.add('order');

    const res = buildResponse(db, tables, counters, 'order');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(2);
  });

  it('does not filter by account on tables with no account field', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'instrument',
      action: 'partial',
      keys: ['symbol'],
      types: { symbol: 'symbol' },
      data: [
        { symbol: 'XBTUSD', price: 100 },
        { symbol: 'ETHUSD', price: 50 },
      ],
    });
    tables.add('instrument');

    // passes account= but table has no account field — should not filter
    const res = buildResponse(db, tables, counters, 'instrument', undefined, '425857');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(2);
  });
});

// ── Combined account + symbol filtering ───────────────────────────────────────

describe('server — combined account + symbol filtering', () => {
  it('filters by both account and symbol independently', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'order',
      action: 'partial',
      keys: ['orderID'],
      types: { orderID: 'guid', account: 'long', symbol: 'symbol' },
      data: [
        { orderID: 'a', account: 1, symbol: 'XBTUSD' },
        { orderID: 'b', account: 1, symbol: 'ETHUSD' },
        { orderID: 'c', account: 2, symbol: 'XBTUSD' },
      ],
    });
    tables.add('order');

    const res = buildResponse(db, tables, counters, 'order', 'XBTUSD', '1');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    expect((res.body as { data: { account: number; symbol: string }[] }).data[0]).toMatchObject({ account: 1, symbol: 'XBTUSD' });
    expect((res.body as { filter: Record<string, string> }).filter).toEqual({ symbol: 'XBTUSD', account: '1' });
  });

  it('account-only filter returns all symbols for that account', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    db.apply({
      table: 'order',
      action: 'partial',
      keys: ['orderID'],
      types: { orderID: 'guid', account: 'long', symbol: 'symbol' },
      data: [
        { orderID: 'a', account: 1, symbol: 'XBTUSD' },
        { orderID: 'b', account: 1, symbol: 'ETHUSD' },
        { orderID: 'c', account: 2, symbol: 'XBTUSD' },
      ],
    });
    tables.add('order');

    const res = buildResponse(db, tables, counters, 'order', undefined, '1');

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(2);
    expect((res.body as { filter: Record<string, string> }).filter).toEqual({ account: '1' });
  });
});
