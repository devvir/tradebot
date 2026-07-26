import { describe, it, expect } from 'vitest';
import { createTable, BitmexTable } from '@devvir/bitmex-database';
import type { BitmexMessage, TableTypeMap } from '@devvir/bitmex-database';

type OBL2 = TableTypeMap[BitmexTable.OrderBookL2];

const makePartial = (data: OBL2[]): BitmexMessage<OBL2> => ({
  table:  BitmexTable.OrderBookL2,
  action: 'partial',
  keys:   ['symbol', 'id', 'side'],
  types:  {} as any,
  filter: {} as any,
  data,
});

const makeDelta = (action: 'insert' | 'update' | 'delete', data: Partial<OBL2>[]): BitmexMessage<OBL2> => ({
  table:  BitmexTable.OrderBookL2,
  action,
  data:   data as OBL2[],
});

const level = (symbol: string, id: number, side: 'Buy' | 'Sell', price: number, size: number): OBL2 => ({
  symbol, id, side, price, size,
  timestamp:    '2026-01-01T00:00:00.000Z',
  transactTime: '2026-01-01T00:00:00.000Z',
});

/** Mirror of extractTop from orderbook.ts — tested via the table API directly. */
const extractTop = (table: ReturnType<typeof createTable<OBL2>>, symbol: string, n = 10) => {
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];

  for (const lvl of table.view().data) {
    if (lvl.symbol !== symbol) continue;
    if (lvl.side === 'Buy')  bids.push([lvl.price!, lvl.size!]);
    if (lvl.side === 'Sell') asks.push([lvl.price!, lvl.size!]);
  }

  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);

  return { bids: bids.slice(0, n), asks: asks.slice(0, n) };
};

// ── partial seeds the book ────────────────────────────────────────────────────

describe('orderbook — partial seeds the book', () => {
  it('reflects all levels after a partial', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);

    table.apply(makePartial([
      level('XBTUSD', 1, 'Buy',  49900, 10),
      level('XBTUSD', 2, 'Buy',  49800, 5),
      level('XBTUSD', 3, 'Sell', 50100, 8),
      level('XBTUSD', 4, 'Sell', 50200, 3),
    ]));

    const { bids, asks } = extractTop(table, 'XBTUSD');

    expect(bids[0]).toEqual([49900, 10]);
    expect(bids[1]).toEqual([49800, 5]);
    expect(asks[0]).toEqual([50100, 8]);
    expect(asks[1]).toEqual([50200, 3]);
  });

  it('limits to top 10 each side', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);
    const levels: OBL2[] = [];

    for (let i = 1; i <= 15; i++) levels.push(level('XBTUSD', i,      'Buy',  50000 - i * 10, 1));
    for (let i = 1; i <= 15; i++) levels.push(level('XBTUSD', i + 15, 'Sell', 50000 + i * 10, 1));

    table.apply(makePartial(levels));

    const { bids, asks } = extractTop(table, 'XBTUSD');

    expect(bids).toHaveLength(10);
    expect(asks).toHaveLength(10);
    // best bid is highest price
    expect(bids[0]![0]).toBe(49990);
    // best ask is lowest price
    expect(asks[0]![0]).toBe(50010);
  });
});

// ── insert adds a level ───────────────────────────────────────────────────────

describe('orderbook — insert', () => {
  it('new level appears in the book', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);

    table.apply(makePartial([level('XBTUSD', 1, 'Buy', 49900, 10)]));
    table.apply(makeDelta('insert', [level('XBTUSD', 2, 'Buy', 49950, 5)]));

    const { bids } = extractTop(table, 'XBTUSD');

    expect(bids[0]).toEqual([49950, 5]);
    expect(bids[1]).toEqual([49900, 10]);
  });
});

// ── update changes size ───────────────────────────────────────────────────────

describe('orderbook — update', () => {
  it('updates size for an existing level', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);

    table.apply(makePartial([level('XBTUSD', 1, 'Buy', 49900, 10)]));
    table.apply(makeDelta('update', [{ symbol: 'XBTUSD', id: 1, side: 'Buy', size: 99 }]));

    const { bids } = extractTop(table, 'XBTUSD');

    expect(bids[0]).toEqual([49900, 99]);
  });
});

// ── delete removes a level ────────────────────────────────────────────────────

describe('orderbook — delete', () => {
  it('removed level is no longer in the book', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);

    table.apply(makePartial([
      level('XBTUSD', 1, 'Buy', 49900, 10),
      level('XBTUSD', 2, 'Buy', 49800, 5),
    ]));
    table.apply(makeDelta('delete', [{ symbol: 'XBTUSD', id: 1, side: 'Buy' }]));

    const { bids } = extractTop(table, 'XBTUSD');

    expect(bids).toHaveLength(1);
    expect(bids[0]).toEqual([49800, 5]);
  });
});

// ── multiple symbols are isolated ─────────────────────────────────────────────

describe('orderbook — multiple symbols', () => {
  it('extractTop only returns levels for the requested symbol', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);

    table.apply(makePartial([
      level('XBTUSD', 1, 'Buy',  49900, 10),
      level('LTCUSD', 2, 'Buy',  200,   50),
      level('LTCUSD', 3, 'Sell', 210,   30),
    ]));

    const xbt = extractTop(table, 'XBTUSD');
    const ltc = extractTop(table, 'LTCUSD');

    expect(xbt.bids).toHaveLength(1);
    expect(xbt.asks).toHaveLength(0);
    expect(ltc.bids).toHaveLength(1);
    expect(ltc.asks).toHaveLength(1);
  });
});

// ── top10Changed ─────────────────────────────────────────────────────────────

describe('top10Changed', () => {
  const changed = (
    prev: { bids: [number, number][]; asks: [number, number][] } | undefined,
    next: { bids: [number, number][]; asks: [number, number][] },
  ): boolean => {
    if (! prev) return true;
    if (prev.bids.length !== next.bids.length || prev.asks.length !== next.asks.length) return true;

    for (let i = 0; i < next.bids.length; i++) {
      if (prev.bids[i]![0] !== next.bids[i]![0] || prev.bids[i]![1] !== next.bids[i]![1]) return true;
    }

    for (let i = 0; i < next.asks.length; i++) {
      if (prev.asks[i]![0] !== next.asks[i]![0] || prev.asks[i]![1] !== next.asks[i]![1]) return true;
    }

    return false;
  };

  it('returns true when prev is undefined', () => {
    expect(changed(undefined, { bids: [[100, 1]], asks: [] })).toBe(true);
  });

  it('returns false when identical', () => {
    const snap = { bids: [[100, 1]] as [number, number][], asks: [[101, 2]] as [number, number][] };
    expect(changed(snap, { bids: [[100, 1]], asks: [[101, 2]] })).toBe(false);
  });

  it('returns true when a price changes', () => {
    const prev = { bids: [[100, 1]] as [number, number][], asks: [] };
    const next = { bids: [[99,  1]] as [number, number][], asks: [] };
    expect(changed(prev, next)).toBe(true);
  });

  it('returns true when a size changes', () => {
    const prev = { bids: [[100, 1]] as [number, number][], asks: [] };
    const next = { bids: [[100, 5]] as [number, number][], asks: [] };
    expect(changed(prev, next)).toBe(true);
  });

  it('returns true when length changes', () => {
    const prev = { bids: [[100, 1], [99, 1]] as [number, number][], asks: [] };
    const next = { bids: [[100, 1]] as [number, number][], asks: [] };
    expect(changed(prev, next)).toBe(true);
  });
});

// ── top-N depth slicing ───────────────────────────────────────────────────────

describe('orderbook — top-N depth', () => {
  it('top-10 returns 10 levels when 30 are present', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);
    const levels: OBL2[] = [];

    for (let i = 1; i <= 30; i++) levels.push(level('XBTUSD', i,      'Buy',  50000 - i * 10, 1));
    for (let i = 1; i <= 30; i++) levels.push(level('XBTUSD', i + 30, 'Sell', 50000 + i * 10, 1));

    table.apply(makePartial(levels));

    const top10 = extractTop(table, 'XBTUSD', 10);
    expect(top10.bids).toHaveLength(10);
    expect(top10.asks).toHaveLength(10);
    expect(top10.bids[0]![0]).toBe(49990); // best bid
    expect(top10.asks[0]![0]).toBe(50010); // best ask
  });

  it('top-25 returns 25 levels when 30 are present', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);
    const levels: OBL2[] = [];

    for (let i = 1; i <= 30; i++) levels.push(level('XBTUSD', i,      'Buy',  50000 - i * 10, 1));
    for (let i = 1; i <= 30; i++) levels.push(level('XBTUSD', i + 30, 'Sell', 50000 + i * 10, 1));

    table.apply(makePartial(levels));

    const top25 = extractTop(table, 'XBTUSD', 25);
    expect(top25.bids).toHaveLength(25);
    expect(top25.asks).toHaveLength(25);
    expect(top25.bids[0]![0]).toBe(49990);  // best bid same
    expect(top25.bids[24]![0]).toBe(49750); // 25th bid
    expect(top25.asks[24]![0]).toBe(50250); // 25th ask
  });

  it('top-25 includes levels 11-25 that top-10 excludes', () => {
    const table = createTable<OBL2>(BitmexTable.OrderBookL2);
    const levels: OBL2[] = [];

    for (let i = 1; i <= 30; i++) levels.push(level('XBTUSD', i, 'Buy', 50000 - i * 10, i));

    table.apply(makePartial(levels));

    const top10 = extractTop(table, 'XBTUSD', 10);
    const top25 = extractTop(table, 'XBTUSD', 25);

    // Level 11 is in top25 but not top10
    expect(top10.bids.some(([p]) => p === 49890)).toBe(false);
    expect(top25.bids.some(([p]) => p === 49890)).toBe(true);
  });
});
