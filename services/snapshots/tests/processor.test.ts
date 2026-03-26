import { describe, it, expect } from 'vitest';
import { createDatabase } from '@devvir/bitmex-database';
import type { BitmexMessage, Database } from '@devvir/bitmex-database';

// ── Inline the processor logic for unit testing ───────────────────────────────

type IncomingMsg = BitmexMessage & { filter?: Record<string, unknown> };

const processMessage = (
  db: Database,
  tables: Set<string>,
  counters: Record<string, number>,
  message: IncomingMsg,
  counter: number
): { processed: false; reason: string } | { processed: true } => {
  if (message.action === 'partial' && message.filter && Object.keys(message.filter).length > 0) {
    return { processed: false, reason: 'Received pre-filtered partial (not supported)' };
  }

  db.apply(message, true);

  counters[message.table] = counter;

  if (message.action === 'partial') {
    tables.add(message.table);
  }

  return { processed: true };
};

// ── Filter validation ─────────────────────────────────────────────────────────

describe('processor — filter validation', () => {
  it('rejects pre-filtered partial with symbol filter', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    const msg: IncomingMsg = {
      table: 'orderBookL2',
      action: 'partial',
      keys: ['id'],
      types: { id: 'long' },
      data: [{ id: 1, price: 100 }],
      filter: { symbol: 'XBTUSD' },
    };

    const result = processMessage(db, tables, counters, msg, 1);

    expect(result.processed).toBe(false);
    expect((result as { processed: false; reason: string }).reason).toMatch(/pre-filtered/);
    expect(tables.has('orderBookL2')).toBe(false);
  });

  it('rejects pre-filtered partial with account filter', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    const msg: IncomingMsg = {
      table: 'order',
      action: 'partial',
      keys: ['orderID'],
      types: { orderID: 'guid', account: 'long' },
      data: [],
      filter: { account: 425857 },
    };

    const result = processMessage(db, tables, counters, msg, 1);

    expect(result.processed).toBe(false);
    expect(tables.has('order')).toBe(false);
  });

  it('allows partial with no filter', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    const msg: IncomingMsg = {
      table: 'orderBookL2',
      action: 'partial',
      keys: ['id'],
      types: { id: 'long' },
      data: [{ id: 1, price: 100, symbol: 'XBTUSD', side: 'Buy' }],
    };

    const result = processMessage(db, tables, counters, msg, 1);

    expect(result.processed).toBe(true);
    expect(tables.has('orderBookL2')).toBe(true);
  });

  it('allows partial with empty filter', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    const msg: IncomingMsg = {
      table: 'instrument',
      action: 'partial',
      keys: ['symbol'],
      types: { symbol: 'symbol' },
      data: [],
      filter: {},
    };

    const result = processMessage(db, tables, counters, msg, 1);

    expect(result.processed).toBe(true);
  });
});

// ── Counter tracking ──────────────────────────────────────────────────────────

describe('processor — counter tracking', () => {
  it('records counter from partial', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'trade',
        action: 'partial',
        keys: [],
        types: {},
        data: [],
      },
      42
    );

    expect(counters['trade']).toBe(42);
  });

  it('updates counter with each subsequent delta', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'trade',
        action: 'partial',
        keys: [],
        types: {},
        data: [],
      },
      1
    );

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'trade',
        action: 'insert',
        data: [{ price: 100, symbol: 'XBTUSD', side: 'Buy', timestamp: '2024-01-01T00:00:00.000Z', trdMatchID: 'abc123' }],
      },
      7
    );

    expect(counters['trade']).toBe(7);
  });

  it('tracks counters independently per table', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'trade',
        action: 'partial',
        keys: [],
        types: {},
        data: [],
      },
      10
    );

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'instrument',
        action: 'partial',
        keys: ['symbol'],
        types: { symbol: 'symbol' },
        data: [],
      },
      99
    );

    expect(counters['trade']).toBe(10);
    expect(counters['instrument']).toBe(99);
  });
});

// ── Table registration ────────────────────────────────────────────────────────

describe('processor — table registration', () => {
  it('registers table on first partial', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    expect(tables.has('orderBookL2')).toBe(false);

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [],
      },
      1
    );

    expect(tables.has('orderBookL2')).toBe(true);
  });

  it('does not register table on delta', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [],
      },
      1
    );

    processMessage(
      db,
      tables,
      counters,
      {
        table: 'trade',
        action: 'insert',
        data: [],
      },
      2
    );

    expect(tables.has('trade')).toBe(false);
  });
});

// ── Insert-only table behaviour (wsPartialMode=true) ───────────────────────────────

describe('processor — insert-only tables (wsPartialMode=true)', () => {
  it('keeps one entry per symbol — latest wins', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    processMessage(db, tables, counters, {
      table: 'trade', action: 'partial', keys: [], types: { symbol: 'symbol', price: 'double' },
      data: [{ symbol: 'XBTUSD', timestamp: '2024-01-01T00:00:00.000Z', side: 'Buy', trdMatchID: 'a', price: 100 }],
    }, 1);

    processMessage(db, tables, counters, {
      table: 'trade', action: 'insert',
      data: [{ symbol: 'XBTUSD', timestamp: '2024-01-01T00:00:01.000Z', side: 'Buy', trdMatchID: 'b', price: 200 }],
    }, 2);

    const snapshot = db.snapshot('trade' as import('@devvir/bitmex-database').BitmexTable);
    expect(snapshot).toHaveLength(1);
    expect((snapshot[0] as Record<string, unknown>).price).toBe(200);
  });

  it('keeps separate entries for different symbols', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    processMessage(db, tables, counters, {
      table: 'trade', action: 'partial', keys: [], types: { symbol: 'symbol', price: 'double' },
      data: [{ symbol: 'XBTUSD', timestamp: '2024-01-01T00:00:00.000Z', side: 'Buy', trdMatchID: 'a', price: 100 }],
    }, 1);

    processMessage(db, tables, counters, {
      table: 'trade', action: 'insert',
      data: [{ symbol: 'ETHUSD', timestamp: '2024-01-01T00:00:01.000Z', side: 'Buy', trdMatchID: 'b', price: 50 }],
    }, 2);

    const snapshot = db.snapshot('trade' as import('@devvir/bitmex-database').BitmexTable);
    expect(snapshot).toHaveLength(2);
  });

  it('keeps a single entry for tables with no symbol field', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    processMessage(db, tables, counters, {
      table: 'connected', action: 'partial', keys: [], types: { users: 'int32' },
      data: [{ users: 10 }],
    }, 1);

    processMessage(db, tables, counters, {
      table: 'connected', action: 'insert',
      data: [{ users: 20 }],
    }, 2);

    processMessage(db, tables, counters, {
      table: 'connected', action: 'insert',
      data: [{ users: 30 }],
    }, 3);

    const snapshot = db.snapshot('connected' as import('@devvir/bitmex-database').BitmexTable);
    expect(snapshot).toHaveLength(1);
    expect((snapshot[0] as Record<string, unknown>).users).toBe(30);
  });
});
