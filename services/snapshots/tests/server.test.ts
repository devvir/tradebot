import { describe, it, expect } from 'vitest';
import { createDatabase } from '@devvir/bitmex-database';
import type { BitmexTable, Database } from '@devvir/bitmex-database';

// ── Inline the server response logic for unit testing ─────────────────────────

const buildResponse = (
  db: Database,
  tables: Set<string>,
  counters: Record<string, number>,
  table: string,
  symbol?: string
) => {
  if (!tables.has(table)) {
    return { status: 404, body: { error: `No snapshot for table '${table}'` } };
  }

  const view = db.view(table as BitmexTable);
  const snapshot = db.snapshot(table as BitmexTable);

  const filterBySymbol = symbol && 'symbol' in view.types;

  const data = filterBySymbol
    ? snapshot.filter((item: unknown) => (item as Record<string, unknown>)['symbol'] === symbol)
    : snapshot;

  return {
    status: 200,
    body: {
      table: view.table,
      keys: view.keys,
      types: view.types,
      data,
      counter: counters[table] ?? 0,
      filter: filterBySymbol ? { symbol } : {},
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
      data: [{ id: 1, side: 'Buy' }],
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
