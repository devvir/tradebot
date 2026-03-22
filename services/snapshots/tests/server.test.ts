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

// ── Private table helpers (inlined for unit testing) ─────────────────────────

const buildPrivateResponse = async (
  privateDBs:     Map<string, Database>,
  privateTables:  Map<string, Set<string>>,
  privateCounters: Map<string, Record<string, number>>,
  table:          string,
  account:        string | undefined,
  symbol:         string | undefined,
  accountExists:  (id: string) => Promise<boolean>,
) => {
  if (! account) {
    return { status: 400, body: { error: `Table '${table}' requires an account parameter` } };
  }

  const accountDB     = privateDBs.get(account);
  const accountTables = privateTables.get(account);

  if (! accountDB || ! accountTables?.has(table)) {
    if (await accountExists(account)) {
      return { status: 503, body: { error: `No snapshot yet for table '${table}' (account '${account}')` } };
    }

    return { status: 403, body: { error: `Unknown account: '${account}'` } };
  }

  const accountCounters = privateCounters.get(account)!;
  const view            = accountDB.view(table as BitmexTable);
  const snapshot        = accountDB.snapshot(table as BitmexTable);

  const filterBySymbol = symbol && 'symbol' in view.types;

  const data = filterBySymbol
    ? snapshot.filter((item: unknown) => (item as Record<string, unknown>)['symbol'] === symbol)
    : snapshot;

  const filter: Record<string, string> = { account };

  if (filterBySymbol) filter['symbol'] = symbol!;

  return {
    status: 200,
    body: {
      table:   view.table,
      keys:    view.keys,
      types:   view.types,
      data,
      counter: accountCounters[table] ?? 0,
      filter,
    },
  };
};

// ── Private table — missing account param ────────────────────────────────────

describe('server — private table missing ?account= → 400', () => {
  it('returns 400 when account param is absent', async () => {
    const privateDBs      = new Map<string, Database>();
    const privateTables   = new Map<string, Set<string>>();
    const privateCounters = new Map<string, Record<string, number>>();

    const res = await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'order', undefined, undefined,
      async () => false,
    );

    expect(res.status).toBe(400);
  });
});

// ── Private table — account not in store, bouncer says unknown ───────────────

describe('server — private table unknown account → 403', () => {
  it('returns 403 when bouncer says account is unknown', async () => {
    const privateDBs      = new Map<string, Database>();
    const privateTables   = new Map<string, Set<string>>();
    const privateCounters = new Map<string, Record<string, number>>();

    const res = await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'order', 'ghost-account', undefined,
      async () => false,
    );

    expect(res.status).toBe(403);
  });
});

// ── Private table — account known but data not ready ─────────────────────────

describe('server — private table known account, no data yet → 503', () => {
  it('returns 503 when account is valid but snapshot not yet received', async () => {
    const privateDBs      = new Map<string, Database>();
    const privateTables   = new Map<string, Set<string>>();
    const privateCounters = new Map<string, Record<string, number>>();

    const res = await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'order', 'bitmex-testnet', undefined,
      async () => true,
    );

    expect(res.status).toBe(503);
  });
});

// ── Private table — happy path ────────────────────────────────────────────────

describe('server — private table happy path', () => {
  const makePrivateState = (accountId: string, tableFixture: string, data: unknown[]) => {
    const db = createDatabase();

    db.apply({
      table:  tableFixture,
      action: 'partial',
      keys:   ['orderID'],
      types:  { orderID: 'guid', account: 'long', symbol: 'symbol' },
      data:   data as Record<string, unknown>[],
    });

    const privateDBs      = new Map<string, Database>([[accountId, db]]);
    const privateTables   = new Map<string, Set<string>>([[accountId, new Set([tableFixture])]]);
    const privateCounters = new Map<string, Record<string, number>>([[accountId, { [tableFixture]: 7 }]]);

    return { privateDBs, privateTables, privateCounters };
  };

  it('returns 200 with account in filter', async () => {
    const { privateDBs, privateTables, privateCounters } =
      makePrivateState('bitmex-testnet', 'order', []);

    const res = await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'order', 'bitmex-testnet', undefined,
      async () => { throw new Error('bouncer should not be called'); },
    );

    expect(res.status).toBe(200);
    expect((res.body as { filter: Record<string, string> }).filter.account).toBe('bitmex-testnet');
    expect((res.body as { filter: Record<string, string> }).filter.symbol).toBeUndefined();
  });

  it('includes counter in response', async () => {
    const { privateDBs, privateTables, privateCounters } =
      makePrivateState('bitmex-testnet', 'order', []);

    const res = await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'order', 'bitmex-testnet', undefined,
      async () => { throw new Error('bouncer should not be called'); },
    );

    expect(res.status).toBe(200);
    expect((res.body as { counter: number }).counter).toBe(7);
  });

  it('does not call bouncer on happy path', async () => {
    const { privateDBs, privateTables, privateCounters } =
      makePrivateState('bitmex-testnet', 'order', []);

    let bouncerCalled = false;

    await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'order', 'bitmex-testnet', undefined,
      async () => { bouncerCalled = true; return true; },
    );

    expect(bouncerCalled).toBe(false);
  });
});

// ── Private table — symbol filter ─────────────────────────────────────────────

describe('server — private table symbol filter', () => {
  it('filters rows by symbol for tables with a symbol field', async () => {
    const db = createDatabase();

    db.apply({
      table:  'order',
      action: 'partial',
      keys:   ['orderID'],
      types:  { orderID: 'guid', account: 'long', symbol: 'symbol' },
      data:   [
        { orderID: 'a', account: 1, symbol: 'XBTUSD' },
        { orderID: 'b', account: 1, symbol: 'ETHUSD' },
      ],
    });

    const privateDBs      = new Map<string, Database>([['acct', db]]);
    const privateTables   = new Map<string, Set<string>>([['acct', new Set(['order'])]]);
    const privateCounters = new Map<string, Record<string, number>>([['acct', {}]]);

    const res = await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'order', 'acct', 'XBTUSD',
      async () => { throw new Error('should not call bouncer'); },
    );

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    expect((res.body as { filter: Record<string, string> }).filter).toEqual({ account: 'acct', symbol: 'XBTUSD' });
  });

  it('does not filter by symbol for tables without a symbol field', async () => {
    const db = createDatabase();

    db.apply({
      table:  'margin',
      action: 'partial',
      keys:   ['account', 'currency'],
      types:  { account: 'long', currency: 'symbol', amount: 'long' },
      data:   [
        { account: 1, currency: 'XBt', amount: 1000 },
        { account: 1, currency: 'USDt', amount: 500 },
      ],
    });

    const privateDBs      = new Map<string, Database>([['acct', db]]);
    const privateTables   = new Map<string, Set<string>>([['acct', new Set(['margin'])]]);
    const privateCounters = new Map<string, Record<string, number>>([['acct', {}]]);

    const res = await buildPrivateResponse(
      privateDBs, privateTables, privateCounters,
      'margin', 'acct', 'XBTUSD',
      async () => { throw new Error('should not call bouncer'); },
    );

    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(2);
    expect((res.body as { filter: Record<string, string> }).filter).toEqual({ account: 'acct' });
  });
});
