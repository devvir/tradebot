import { describe, it, expect } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import { startOfDayMongoId } from '@tradebot/utils';
import { buildRouter } from '../src/server';
import { streamAfter, partialBefore } from '../src/ws';
import { seekId } from '../src/ws/seek';
import { restRecords } from '../src/rest';
import type { Librarian } from '../src/librarian';
import type { ReadOpts, StoredDoc } from '../src/types';

// ── In-memory librarian honouring from/before/order/limit/filter ──────────────

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

class FakeLibrarian {
  constructor(private readonly tables: Record<string, StoredDoc[]>) {}

  async read(table: string, opts: ReadOpts = {}): Promise<StoredDoc[]> {
    let docs = (this.tables[table] ?? [])
      .filter(d =>
        (opts.from   === undefined || d._id >= opts.from) &&
        (opts.before === undefined || d._id <= opts.before) &&
        matches(d, opts.filter));

    docs = [...docs].sort((a, b) => a._id - b._id);

    if (opts.order === 'desc') docs.reverse();
    if (opts.limit !== undefined) docs = docs.slice(0, opts.limit);

    return docs;
  }

  async latestBefore(table: string, beforeId: number, filter?: Record<string, unknown>): Promise<StoredDoc | null> {
    const docs = await this.read(table, { before: beforeId, order: 'desc', limit: 1, filter });

    return docs[0] ?? null;
  }
}

const asLib = (f: FakeLibrarian): Librarian => f as unknown as Librarian;

// ── Fixtures: a day of 2019-04-01, _id day-encoded ────────────────────────────

const FLOOR = startOfDayMongoId('2019-04-01');
const iso   = (h: number, m: number, s = 0): string => new Date(Date.UTC(2019, 3, 1, h, m, s)).toISOString();
const ms    = (h: number, m: number, s = 0): number => Date.UTC(2019, 3, 1, h, m, s);

/** trade: one record per minute for two hours. */
const trades: StoredDoc[] = Array.from({ length: 120 }, (_, i) => ({
  _id:       FLOOR + i * 256,
  timestamp: iso(Math.floor(i / 60), i % 60),
  symbol:    'XBTUSD',
  side:      'Buy',
  size:      i,
  price:     100 + i,
}));

/** orderBookL2: a partial at the top of each hour, an update each minute between. */
const book: StoredDoc[] = Array.from({ length: 120 }, (_, i) => ({
  _id:       FLOOR + i * 256,
  table:     'orderBookL2',
  action:    i % 60 === 0 ? 'partial' : 'update',
  timestamp: iso(Math.floor(i / 60), i % 60),
  ...(i % 60 === 0 ? { keys: ['symbol', 'id', 'side'], types: { symbol: 'symbol' }, filter: {} } : {}),
  data:      [{ symbol: 'XBTUSD', id: 1, side: 'Buy', size: i }],
}));

const lib = asLib(new FakeLibrarian({ trade: trades, orderBookL2: book }));

// ── seekId ────────────────────────────────────────────────────────────────────

describe('seekId', () => {
  it('finds the first _id at-or-after a mid-day timestamp', async () => {
    const id = await seekId(lib, 'trade', ms(1, 30));   // minute 90

    expect(id).toBe(FLOOR + 90 * 256);
  });

  it('returns the next-day floor when the time is after the last record', async () => {
    const id = await seekId(lib, 'trade', ms(23, 59));

    expect(id).toBe(startOfDayMongoId('2019-04-02'));
  });
});

// ── streamAfter ───────────────────────────────────────────────────────────────

describe('streamAfter', () => {
  it('republishes message-table docs and advances the cursor', async () => {
    const res = await streamAfter(lib, 'orderBookL2', FLOOR, 10);

    expect(res.messages).toHaveLength(10);
    expect(res.messages[0]!.msg.action).toBe('partial');
    expect(res.messages[1]!.msg.action).toBe('update');
    expect(res.exhausted).toBe(false);
    expect(res.cursor).toBe(FLOOR + 9 * 256 + 1);
  });

  it('wraps + groups trade records; full batch holds back the trailing group', async () => {
    const res = await streamAfter(lib, 'trade', FLOOR, 10);

    // 10 distinct-minute trades, full batch → trailing minute held back → 9 inserts
    expect(res.messages).toHaveLength(9);
    expect(res.messages.every(m => m.msg.action === 'insert')).toBe(true);
    expect(res.exhausted).toBe(false);
  });

  it('exhausts when the batch is not full', async () => {
    const res = await streamAfter(lib, 'trade', FLOOR + 118 * 256, 10);

    expect(res.exhausted).toBe(true);
    expect(res.messages.length).toBeGreaterThan(0);
  });

  it('serves order-book tables empty', async () => {
    const res = await streamAfter(lib, 'orderBook10', FLOOR, 10);

    expect(res).toEqual({ messages: [], cursor: null, exhausted: true });
  });
});

// ── partialBefore ─────────────────────────────────────────────────────────────

describe('partialBefore', () => {
  it('returns the latest stored partial before X for a message table', async () => {
    const res = await partialBefore(lib, 'orderBookL2', ms(1, 30));   // between the 01:00 partial and 02:00

    expect(res.partial!.action).toBe('partial');
    expect(res.partial!.keys).toEqual(['symbol', 'id', 'side']);
    // the 01:00 partial sits at minute 60; cursor pages deltas after it
    expect(res.cursor).toBe(FLOOR + 60 * 256 + 1);
  });

  it('returns a static schema partial + seek cursor for a flat table', async () => {
    const res = await partialBefore(lib, 'trade', ms(1, 30));

    expect(res.partial!.action).toBe('partial');
    expect(res.partial!.data).toEqual([]);
    expect(res.cursor).toBe(FLOOR + 90 * 256);
  });

  it('returns an empty partial and no cursor for order books', async () => {
    const res = await partialBefore(lib, 'orderBook10', ms(1, 30));

    expect(res.partial!.data).toEqual([]);
    expect(res.cursor).toBeNull();
  });
});

// ── restRecords ───────────────────────────────────────────────────────────────

describe('restRecords', () => {
  it('returns ascending records in a time window, _id stripped', async () => {
    const recs = await restRecords(lib, 'trade', {
      symbol: 'XBTUSD', count: 5, start: 0, reverse: false, startTime: ms(0, 10), endTime: ms(0, 20),
    });

    expect(recs).toHaveLength(5);
    expect((recs[0] as { timestamp: string }).timestamp).toBe(iso(0, 10));
    expect('_id' in recs[0]!).toBe(false);
  });

  it('reverses (newest first) and honours count', async () => {
    const recs = await restRecords(lib, 'trade', {
      count: 3, start: 0, reverse: true, endTime: ms(1, 0),
    });

    expect(recs).toHaveLength(3);
    expect((recs[0] as { timestamp: string }).timestamp).toBe(iso(1, 0));
    expect((recs[1] as { timestamp: string }).timestamp).toBe(iso(0, 59));
  });

  it('applies start (skip) and column projection', async () => {
    const recs = await restRecords(lib, 'trade', {
      count: 2, start: 2, reverse: false, startTime: ms(0, 0), columns: ['price'],
    });

    expect(recs).toEqual([{ price: 102 }, { price: 103 }]);
  });
});

// ── HTTP routes ───────────────────────────────────────────────────────────────

const makeApp = (): Application => express().use(buildRouter(lib));

describe('HTTP routes', () => {
  it('GET /health → 200', async () => {
    const res = await request(makeApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /ws/:table → page of messages', async () => {
    const res = await request(makeApp()).get('/ws/orderBookL2').query({ after: FLOOR, limit: 5 });

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(5);
  });

  it('GET /ws/:table/partial → partial + cursor', async () => {
    const res = await request(makeApp()).get('/ws/trade/partial').query({ before: ms(1, 30) });

    expect(res.status).toBe(200);
    expect(res.body.partial.action).toBe('partial');
    expect(res.body.cursor).toBe(FLOOR + 90 * 256);
  });

  it('GET /rest/:table → records', async () => {
    const res = await request(makeApp()).get('/rest/trade').query({ count: 3, reverse: 'true', endTime: ms(1, 0) });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('404 for an unknown table', async () => {
    expect((await request(makeApp()).get('/ws/nope').query({ after: 0 })).status).toBe(404);
  });

  it('404 for a table with no BitMEX REST endpoint', async () => {
    expect((await request(makeApp()).get('/rest/connected')).status).toBe(404);
  });

  it('400 when /ws/:table is missing the cursor', async () => {
    expect((await request(makeApp()).get('/ws/trade')).status).toBe(400);
  });
});
