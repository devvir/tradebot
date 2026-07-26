import { describe, it, expect } from 'vitest';
import { startOfDayMongoId } from '@tradebot/utils';
import { stateRecords } from '../src/rest/state';
import { recentRecords } from '../src/rest/recent';
import type { Librarian } from '../src/librarian';
import type { ReadOpts, StoredDoc } from '../src/types';

// ── In-memory librarian (honours from/before/order/limit + action/timestamp/symbol filter) ──

const matches = (doc: StoredDoc, filter?: Record<string, unknown>): boolean => {
  if (! filter) return true;

  for (const [k, v] of Object.entries(filter)) {
    if (k === 'timestamp' && v && typeof v === 'object') {
      const tv = doc.timestamp as string;
      const r  = v as { $gte?: string; $lte?: string };

      if (r.$gte !== undefined && tv < r.$gte) return false;
      if (r.$lte !== undefined && tv > r.$lte) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }

  return true;
};

const asLib = (docsByTable: Record<string, StoredDoc[]>): Librarian => ({
  async read(table: string, opts: ReadOpts = {}): Promise<StoredDoc[]> {
    let docs = (docsByTable[table] ?? [])
      .filter(d =>
        (opts.from   === undefined || d._id >= opts.from) &&
        (opts.before === undefined || d._id <= opts.before) &&
        matches(d, opts.filter));

    docs = [...docs].sort((a, b) => a._id - b._id);

    if (opts.order === 'desc') docs.reverse();
    if (opts.limit !== undefined) docs = docs.slice(0, opts.limit);

    return docs;
  },
  async latestBefore(table: string, beforeId: number, filter?: Record<string, unknown>): Promise<StoredDoc | null> {
    const docs = await (this as Librarian).read(table, { before: beforeId, order: 'desc', limit: 1, filter });

    return docs[0] ?? null;
  },
} as unknown as Librarian);

const FLOOR = startOfDayMongoId('2019-04-01');
const iso   = (m: number): string => new Date(Date.UTC(2019, 3, 1, 0, m)).toISOString();
const ms    = (m: number): number => Date.UTC(2019, 3, 1, 0, m);

// ── state: reconstruct orderBookL2 at the clock ───────────────────────────────

describe('stateRecords — orderBookL2 reconstruction', () => {
  const book: StoredDoc[] = [
    { _id: FLOOR, table: 'orderBookL2', action: 'partial', timestamp: iso(0),
      keys: ['symbol', 'id', 'side'], types: {}, filter: {},
      data: [
        { symbol: 'XBTUSD', id: 1, side: 'Buy',  size: 10, price: 100 },
        { symbol: 'XBTUSD', id: 2, side: 'Sell', size: 5,  price: 101 },
        { symbol: 'ETHUSD', id: 9, side: 'Buy',  size: 7,  price: 50 },
      ] },
    { _id: FLOOR + 256, table: 'orderBookL2', action: 'update', timestamp: iso(1),
      data: [{ symbol: 'XBTUSD', id: 1, side: 'Buy', size: 20 }] },
    { _id: FLOOR + 512, table: 'orderBookL2', action: 'delete', timestamp: iso(2),
      data: [{ symbol: 'XBTUSD', id: 2, side: 'Sell' }] },
  ];

  it('folds partial + deltas to the clock and filters by symbol', async () => {
    const rows = await stateRecords(asLib({ orderBookL2: book }), 'orderBookL2',
      { symbol: 'XBTUSD', count: 100, start: 0, reverse: false, endTime: ms(5) });

    // partial(2 XBTUSD levels) + update(id1→20) + delete(id2) → one XBTUSD level left, size 20
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'XBTUSD', id: 1, side: 'Buy', size: 20 });
  });

  it('respects depth', async () => {
    const rows = await stateRecords(asLib({ orderBookL2: book }), 'orderBookL2',
      { count: 100, start: 0, reverse: false, endTime: ms(5), depth: 0 });   // full

    // all symbols, all sides (id2 deleted): XBTUSD Buy + ETHUSD Buy = 2
    expect(rows.length).toBe(2);
  });

  it('returns empty when there is no partial', async () => {
    const rows = await stateRecords(asLib({ orderBookL2: [] }), 'orderBookL2',
      { count: 100, start: 0, reverse: false, endTime: ms(5) });

    expect(rows).toEqual([]);
  });
});

// ── recent: last N chat records ───────────────────────────────────────────────

describe('recentRecords — chat', () => {
  const chat: StoredDoc[] = [0, 1, 2, 3].map(m => ({
    _id: FLOOR + m * 256, table: 'chat', action: 'insert', timestamp: iso(m),
    data: [{ id: 100 + m, message: `m${m}` }],
  }));

  it('returns the last `count` messages, newest first', async () => {
    const rows = await recentRecords(asLib({ chat }), 'chat',
      { count: 2, start: 0, reverse: true, endTime: ms(9) });

    expect(rows.map(r => (r as { message: string }).message)).toEqual(['m3', 'm2']);
  });
});
