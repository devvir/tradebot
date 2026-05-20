import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { makeMongoId, startOfDayMongoId } from '@tradebot/utils';
import { backfillSnapshot, _test_timestampFor, _test_firstIdAfterDay } from '../src/commands/backfill';
import { createBuffer } from '../src/websocket/buffer';
import * as snapshots from '../src/snapshots';
import type { Config, MongoDoc } from '../src/types';

// ── Pure helpers (unit) ───────────────────────────────────────────────────────

describe('timestampFor', () => {
  it('reads from data[0].timestamp when present', () => {
    const ts  = '2025-06-01T12:00:00.000Z';
    const doc = { _id: 0, data: [{ timestamp: ts }] };

    expect(_test_timestampFor(doc)).toBe(new Date(ts).getTime());
  });

  it('falls back to _id-decoded day when no data timestamp', () => {
    const doc = { _id: startOfDayMongoId('2000-01-02'), data: [{}] };

    expect(_test_timestampFor(doc)).toBe(Date.UTC(2000, 0, 2));
  });
});

describe('firstIdAfterDay', () => {
  it('returns the first _id of the day after epochMs', () => {
    const epoch = Date.UTC(2025, 5, 1);

    expect(_test_firstIdAfterDay(epoch)).toBe(startOfDayMongoId('2025-06-02'));
  });

  it('day-aligns regardless of intra-day position', () => {
    const dayStart = Date.UTC(2025, 5, 1, 0, 0, 0);
    const dayEnd   = Date.UTC(2025, 5, 1, 23, 59, 59);

    expect(_test_firstIdAfterDay(dayStart)).toBe(_test_firstIdAfterDay(dayEnd));
  });
});

// ── Integration ───────────────────────────────────────────────────────────────

const DB     = 'test_digger_backfill';
const config: Config = {
  workerUuid:         'test-uuid',
  database:           DB,
  bufferLowWatermark: 5_000,
  bufferBatchSize:    1_000,
};

let client: MongoClient;

beforeAll(async () => {
  client = new MongoClient(process.env['DB_URL']!);
  await client.connect();
});

afterAll(async () => {
  await client.db(DB).dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await client.db(DB).collection('instrument').deleteMany({});
  snapshots._test_reset();
});

/** Build a vault-style _id for a calendar day (YYYY-MM-DD) + 0-based slot. */
const makeId = (date: string, slot: number): number =>
  makeMongoId(date, slot + 1);

describe('backfillSnapshot — no stored partial', () => {
  it('returns false when the collection is empty', async () => {
    const buf = createBuffer('instrument');
    const X   = new Date('2025-01-15T12:00:00.000Z').getTime();

    const ok = await backfillSnapshot('instrument', X, buf, config, client);

    expect(ok).toBe(false);
    expect(snapshots.buildSnapshot('instrument')).toBeNull();
    expect(buf.cursor).toBeNull();
  });
});

describe('backfillSnapshot — partial only, no deltas', () => {
  it('seeds snapshots and sets buffer.cursor', async () => {
    const day = '2025-01-15';
    const partialDoc = {
      _id:    makeId(day, 0),
      action: 'partial',
      data:   [{ symbol: 'XBTUSD', lastPrice: 50_000, timestamp: '2025-01-15T08:00:00.000Z' }],
      keys:   ['symbol'],
      types:  { symbol: 'symbol', lastPrice: 'float', timestamp: 'timestamp' },
      filter: {},
    };

    await client.db(DB).collection('instrument').insertOne(partialDoc as unknown as MongoDoc);

    const buf = createBuffer('instrument');
    const X   = new Date('2025-01-15T12:00:00.000Z').getTime();

    const ok = await backfillSnapshot('instrument', X, buf, config, client);

    expect(ok).toBe(true);
    expect(buf.cursor).toBe(partialDoc._id);

    const view = snapshots.buildSnapshot('instrument');

    expect(view).not.toBeNull();
    expect(view!.data).toHaveLength(1);
    expect((view!.data[0] as Record<string, unknown>)['lastPrice']).toBe(50_000);
  });
});

describe('backfillSnapshot — partial + deltas up to X', () => {
  it('applies deltas and stops at X', async () => {
    const day = '2025-01-15';
    const docs = [
      {
        _id:    makeId(day, 0),
        action: 'partial',
        data:   [{ symbol: 'XBTUSD', lastPrice: 50_000, timestamp: '2025-01-15T06:00:00.000Z' }],
        keys:   ['symbol'],
        types:  { symbol: 'symbol', lastPrice: 'float', timestamp: 'timestamp' },
        filter: {},
      },
      {
        _id:    makeId(day, 1),
        action: 'update',
        data:   [{ symbol: 'XBTUSD', lastPrice: 51_000, timestamp: '2025-01-15T08:00:00.000Z' }],
      },
      {
        _id:    makeId(day, 2),
        action: 'update',
        data:   [{ symbol: 'XBTUSD', lastPrice: 52_000, timestamp: '2025-01-15T11:00:00.000Z' }],
      },
      {
        _id:    makeId(day, 3),
        action: 'update',
        data:   [{ symbol: 'XBTUSD', lastPrice: 99_999, timestamp: '2025-01-15T14:00:00.000Z' }],
      },
    ];

    await client.db(DB).collection('instrument').insertMany(docs as unknown as MongoDoc[]);

    const buf = createBuffer('instrument');
    const X   = new Date('2025-01-15T12:00:00.000Z').getTime();

    const ok = await backfillSnapshot('instrument', X, buf, config, client);

    expect(ok).toBe(true);

    const view = snapshots.buildSnapshot('instrument');

    expect((view!.data[0] as Record<string, unknown>)['lastPrice']).toBe(52_000);
    expect(buf.cursor).toBe(makeId(day, 2));
  });
});

describe('backfillSnapshot — picks the latest partial before X', () => {
  it('skips later partials and uses the most recent one ≤ X', async () => {
    const day = '2025-01-15';
    const docs = [
      {
        _id:    makeId(day, 0),
        action: 'partial',
        data:   [{ symbol: 'XBTUSD', lastPrice: 40_000, timestamp: '2025-01-15T01:00:00.000Z' }],
        keys:   ['symbol'],
        types:  { symbol: 'symbol', lastPrice: 'float', timestamp: 'timestamp' },
        filter: {},
      },
      {
        _id:    makeId(day, 5),
        action: 'partial',
        data:   [{ symbol: 'XBTUSD', lastPrice: 50_000, timestamp: '2025-01-15T05:00:00.000Z' }],
        keys:   ['symbol'],
        types:  { symbol: 'symbol', lastPrice: 'float', timestamp: 'timestamp' },
        filter: {},
      },
      {
        _id:    makeId(day, 10),
        action: 'partial',
        data:   [{ symbol: 'XBTUSD', lastPrice: 99_999, timestamp: '2025-01-15T20:00:00.000Z' }],
        keys:   ['symbol'],
        types:  { symbol: 'symbol', lastPrice: 'float', timestamp: 'timestamp' },
        filter: {},
      },
    ];

    await client.db(DB).collection('instrument').insertMany(docs as unknown as MongoDoc[]);

    const buf = createBuffer('instrument');
    const X   = new Date('2025-01-15T12:00:00.000Z').getTime();

    const ok = await backfillSnapshot('instrument', X, buf, config, client);

    expect(ok).toBe(true);
    // Most recent partial ≤ X is at index 5 (timestamp 05:00)
    expect(buf.cursor).toBe(makeId(day, 5));

    const view = snapshots.buildSnapshot('instrument');

    expect((view!.data[0] as Record<string, unknown>)['lastPrice']).toBe(50_000);
  });
});
