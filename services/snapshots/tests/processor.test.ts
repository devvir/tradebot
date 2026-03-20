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
  if (message.action === 'partial' && message.filter && 'symbol' in message.filter) {
    return { processed: false, reason: 'Received pre-filtered partial (not supported)' };
  }

  db.apply(message);

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

  it('allows partial with no filter', () => {
    const db = createDatabase();
    const tables = new Set<string>();
    const counters: Record<string, number> = {};

    const msg: IncomingMsg = {
      table: 'orderBookL2',
      action: 'partial',
      keys: ['id'],
      types: { id: 'long' },
      data: [{ id: 1, price: 100 }],
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
        data: [{ price: 100 }],
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
