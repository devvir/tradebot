import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { startOfDayMongoId } from '@tradebot/utils';
import * as clock from '../src/clock';
import { initialFill, triggerFetch, _test_buildFilter } from '../src/websocket/fetcher';
import { createBuffer } from '../src/websocket/buffer';
import type { Config } from '../src/types';

// ── buildFilter (unit) ────────────────────────────────────────────────────────

beforeEach(() => { clock._test_reset(); });

describe('buildFilter — cursor paging (all origins)', () => {
  it('uses cursor filter when cursor is set, ignoring origin', () => {
    const buf = { ...createBuffer('trade'), cursor: 999 };

    expect(_test_buildFilter(buf, 'rest')).toEqual({ _id: { $gt: 999 } });
    expect(_test_buildFilter(buf, 'ws')).toEqual({ _id: { $gt: 999 } });
  });
});

describe('buildFilter — first fetch, rest-origin', () => {
  it('filters by timestamp >= clock', () => {
    const seek = new Date('2025-01-01T00:00:00.000Z').getTime();

    clock.set(seek);

    const buf    = createBuffer('trade');
    const filter = _test_buildFilter(buf, 'rest');

    expect(filter).toEqual({ timestamp: { $gte: new Date(seek).toISOString() } });
  });
});

describe('buildFilter — first fetch, ws-origin', () => {
  it('uses minId derived from the calendar day of the clock', () => {
    const seek        = new Date('2025-01-15T12:30:00.000Z').getTime();
    const expectedMin = startOfDayMongoId('2025-01-15');

    clock.set(seek);

    const buf    = createBuffer('instrument');
    const filter = _test_buildFilter(buf, 'ws');

    expect(filter).toEqual({ _id: { $gte: expectedMin } });
  });

  it('day-aligns the minId — same result for any time within the same day', () => {
    const dayStart = new Date('2025-03-10T00:00:00.000Z').getTime();
    const dayMid   = new Date('2025-03-10T12:00:00.000Z').getTime();
    const dayEnd   = new Date('2025-03-10T23:59:59.999Z').getTime();
    const buf      = createBuffer('instrument');

    clock.set(dayStart);
    const filterStart = _test_buildFilter(buf, 'ws');

    clock.set(dayMid);
    const filterMid   = _test_buildFilter(buf, 'ws');

    clock.set(dayEnd);
    const filterEnd   = _test_buildFilter(buf, 'ws');

    expect(filterStart).toEqual(filterMid);
    expect(filterMid).toEqual(filterEnd);
  });
});

describe('buildFilter — clock unset', () => {
  it('throws when cursor is null and clock is null', () => {
    const buf = createBuffer('trade');

    expect(() => _test_buildFilter(buf, 'rest')).toThrow(/clock not set/i);
  });
});

// ── initialFill (integration) ─────────────────────────────────────────────────

const DB     = 'test_digger_fetcher';
const config: Config = {
  workerUuid:         'test-uuid',
  database:           DB,
  bufferLowWatermark: 5_000,
  bufferBatchSize:    10,
};

let client: MongoClient;
let idSeq = 0;

beforeAll(async () => {
  client = new MongoClient(process.env['DB_URL']!);
  await client.connect();
});

afterAll(async () => {
  await client.db(DB).dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await client.db(DB).collection('trade').deleteMany({});
  idSeq = 0;
});

const insertTrades = async (count: number, baseTs = '2025-01-01T00:00:00.000Z') => {
  const base = new Date(baseTs).getTime();
  const docs = Array.from({ length: count }, (_, i) => ({
    _id:       ++idSeq,
    timestamp: new Date(base + i * 1_000).toISOString(),
    symbol:    'XBTUSD',
    size:      100,
  }));

  await client.db(DB).collection('trade').insertMany(docs);

  return docs;
};

describe('initialFill', () => {
  it('loads documents into the buffer', async () => {
    await insertTrades(5);
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    const buf = createBuffer('trade');

    await initialFill(buf, config, client);

    expect(buf.entries).toHaveLength(5);
    expect(buf.isFetching).toBe(false);
  });

  it('sets cursor to the last fetched _id', async () => {
    await insertTrades(3);
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    const buf = createBuffer('trade');

    await initialFill(buf, config, client);

    expect(buf.cursor).toBe(3);
  });

  it('marks exhausted when fewer docs than batchSize are returned', async () => {
    await insertTrades(4); // batchSize is 10
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    const buf = createBuffer('trade');

    await initialFill(buf, config, client);

    expect(buf.exhausted).toBe(true);
  });

  it('does not mark exhausted when exactly batchSize docs returned', async () => {
    await insertTrades(10); // exactly batchSize
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    const buf = createBuffer('trade');

    await initialFill(buf, config, client);

    expect(buf.exhausted).toBe(false);
  });

  it('seeks to the clock — earlier docs are not returned', async () => {
    await insertTrades(3, '2025-01-01T00:00:00.000Z');
    await insertTrades(3, '2025-01-02T00:00:00.000Z');

    clock.set(new Date('2025-01-02T00:00:00.000Z').getTime());

    const buf = createBuffer('trade');

    await initialFill(buf, config, client);

    expect(buf.entries).toHaveLength(3);
    expect(buf.entries[0]!.timestamp).toMatch(/^2025-01-02/);
  });

  it('returns empty buffer when no docs match the clock seek', async () => {
    await insertTrades(3, '2025-01-01T00:00:00.000Z');
    clock.set(new Date('2025-06-01T00:00:00.000Z').getTime());

    const buf = createBuffer('trade');

    await initialFill(buf, config, client);

    expect(buf.entries).toHaveLength(0);
    expect(buf.exhausted).toBe(true);
  });

  it('pages forward from cursor when cursor is pre-seeded (backfill simulated)', async () => {
    await insertTrades(5);
    // Pretend backfill consumed _id 1, 2 — cursor seeded at 2
    const buf = createBuffer('trade');

    buf.cursor = 2;

    await initialFill(buf, config, client);

    expect(buf.entries.map(e => e._id)).toEqual([3, 4, 5]);
  });
});

describe('triggerFetch', () => {
  it('does nothing when isFetching is already true', async () => {
    await insertTrades(3);
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    const buf = createBuffer('trade');

    buf.isFetching = true;

    triggerFetch(buf, config, client);

    expect(buf.isFetching).toBe(true);
    expect(buf.entries).toHaveLength(0);
  });
});
