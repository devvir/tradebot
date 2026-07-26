import { describe, it, expect } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import { startOfDayMongoId } from '@tradebot/utils';
import { buildRouter } from '../src/server';
import { restRecords } from '../src/rest';
import { seekId } from '../src/ws/seek';
import type { Librarian } from '../src/librarian';
import type { ReadOpts, StoredDoc } from '../src/types';

// ── Minimal librarians ────────────────────────────────────────────────────────

const throwingLib = (): Librarian => ({
  async read(): Promise<StoredDoc[]> { throw new Error('librarian down'); },
  async latestBefore(): Promise<StoredDoc | null> { throw new Error('librarian down'); },
}) as unknown as Librarian;

const FLOOR = startOfDayMongoId('2019-04-01');
const iso   = (h: number, m: number): string => new Date(Date.UTC(2019, 3, 1, h, m)).toISOString();

const trades: StoredDoc[] = Array.from({ length: 120 }, (_, i) => ({
  _id: FLOOR + i * 256, timestamp: iso(Math.floor(i / 60), i % 60), symbol: 'XBTUSD', price: 100 + i,
}));

const arrayLib = (docs: StoredDoc[]): Librarian => ({
  async read(_t: string, o: ReadOpts = {}): Promise<StoredDoc[]> {
    let out = docs.filter(d =>
      (o.from === undefined || d._id >= o.from) && (o.before === undefined || d._id <= o.before));

    if (o.order === 'desc') out = [...out].reverse();
    if (o.limit !== undefined) out = out.slice(0, o.limit);

    return out;
  },
  async latestBefore(): Promise<StoredDoc | null> { return null; },
}) as unknown as Librarian;

// ── Error path ────────────────────────────────────────────────────────────────

describe('error handling', () => {
  const app = (): Application => express().use(buildRouter(throwingLib()));

  it('returns 500 when librarian fails on /ws', async () => {
    const res = await request(app()).get('/ws/trade').query({ after: 0 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('librarian down');
  });

  it('returns 500 when librarian fails on /rest', async () => {
    const res = await request(app()).get('/rest/trade').query({ startTime: Date.UTC(2019, 3, 1) });

    expect(res.status).toBe(500);
  });
});

// ── REST with no time filters (last N) ────────────────────────────────────────

describe('restRecords — no time bounds', () => {
  it('reverse with no startTime/endTime returns the last N records', async () => {
    const recs = await restRecords(arrayLib(trades), 'trade', { count: 3, start: 0, reverse: true });

    expect(recs.map(r => (r as { price: number }).price)).toEqual([219, 218, 217]);
  });
});

// ── seek edges ────────────────────────────────────────────────────────────────

describe('seekId — edges', () => {
  it('returns a lower-bound cursor for a time before all data (stream then finds the first record)', async () => {
    const id = await seekId(arrayLib(trades), 'trade', Date.UTC(2018, 0, 1));   // long before

    // not necessarily an exact _id, but ≤ the first real record so a forward
    // stream from it yields that record (and nothing earlier exists).
    expect(id).toBeLessThanOrEqual(FLOOR);
  });
});
