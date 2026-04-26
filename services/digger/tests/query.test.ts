import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { queryRecords, querySnapshot } from '../src/rest/query';
import type { Config } from '../src/types';

vi.mock('../src/snapshots', () => ({
  buildSnapshot: vi.fn(),
}));

import * as snapshots from '../src/snapshots';

// ── Shared setup ──────────────────────────────────────────────────────────────

const DB     = 'test_digger_query';
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
  await client.db(DB).collection('trade').deleteMany({});
  vi.mocked(snapshots.buildSnapshot).mockReset();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const insertTrades = async (rows: Array<{ ts: string; sym: string; price: number }>) => {
  const docs = rows.map((r, i) => ({
    _id:       i + 1,
    timestamp: r.ts,
    symbol:    r.sym,
    price:     r.price,
  }));

  await client.db(DB).collection('trade').insertMany(docs);
};

const baseParams = {
  count:   100,
  start:   0,
  reverse: false,
};

// ── queryRecords ──────────────────────────────────────────────────────────────

describe('queryRecords — basic fetch', () => {
  it('returns all docs when no filter is applied', async () => {
    await insertTrades([
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 50_000 },
      { ts: '2025-01-01T00:00:01.000Z', sym: 'ETHUSD', price: 3_000 },
    ]);

    const results = await queryRecords('trade', baseParams, config, client);

    expect(results).toHaveLength(2);
  });

  it('strips _id from results', async () => {
    await insertTrades([{ ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 50_000 }]);

    const results = await queryRecords('trade', baseParams, config, client);

    expect((results[0] as Record<string, unknown>)['_id']).toBeUndefined();
  });
});

describe('queryRecords — symbol filter', () => {
  it('filters by symbol', async () => {
    await insertTrades([
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 50_000 },
      { ts: '2025-01-01T00:00:01.000Z', sym: 'ETHUSD', price: 3_000 },
    ]);

    const results = await queryRecords(
      'trade',
      { ...baseParams, symbol: 'XBTUSD' },
      config,
      client,
    );

    expect(results).toHaveLength(1);
    expect((results[0] as Record<string, unknown>)['symbol']).toBe('XBTUSD');
  });
});

describe('queryRecords — timestamp range', () => {
  it('filters by startTime', async () => {
    await insertTrades([
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 1 },
      { ts: '2025-01-02T00:00:00.000Z', sym: 'XBTUSD', price: 2 },
      { ts: '2025-01-03T00:00:00.000Z', sym: 'XBTUSD', price: 3 },
    ]);

    const results = await queryRecords(
      'trade',
      { ...baseParams, startTime: new Date('2025-01-02T00:00:00.000Z').getTime() },
      config,
      client,
    );

    expect(results).toHaveLength(2);
  });

  it('filters by endTime', async () => {
    await insertTrades([
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 1 },
      { ts: '2025-01-02T00:00:00.000Z', sym: 'XBTUSD', price: 2 },
      { ts: '2025-01-03T00:00:00.000Z', sym: 'XBTUSD', price: 3 },
    ]);

    const results = await queryRecords(
      'trade',
      { ...baseParams, endTime: new Date('2025-01-02T00:00:00.000Z').getTime() },
      config,
      client,
    );

    expect(results).toHaveLength(2);
  });
});

describe('queryRecords — ordering', () => {
  it('returns docs in ascending timestamp order by default', async () => {
    await insertTrades([
      { ts: '2025-01-03T00:00:00.000Z', sym: 'XBTUSD', price: 3 },
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 1 },
      { ts: '2025-01-02T00:00:00.000Z', sym: 'XBTUSD', price: 2 },
    ]);

    const results = (await queryRecords('trade', baseParams, config, client)) as Array<Record<string, unknown>>;

    expect(results[0]!['price']).toBe(1);
    expect(results[1]!['price']).toBe(2);
    expect(results[2]!['price']).toBe(3);
  });

  it('returns docs in descending order when reverse=true', async () => {
    await insertTrades([
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 1 },
      { ts: '2025-01-02T00:00:00.000Z', sym: 'XBTUSD', price: 2 },
    ]);

    const results = (await queryRecords(
      'trade',
      { ...baseParams, reverse: true },
      config,
      client,
    )) as Array<Record<string, unknown>>;

    expect(results[0]!['price']).toBe(2);
    expect(results[1]!['price']).toBe(1);
  });
});

describe('queryRecords — count and start', () => {
  it('limits results by count', async () => {
    await insertTrades([
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 1 },
      { ts: '2025-01-02T00:00:00.000Z', sym: 'XBTUSD', price: 2 },
      { ts: '2025-01-03T00:00:00.000Z', sym: 'XBTUSD', price: 3 },
    ]);

    const results = await queryRecords('trade', { ...baseParams, count: 2 }, config, client);

    expect(results).toHaveLength(2);
  });

  it('skips docs according to start', async () => {
    await insertTrades([
      { ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 1 },
      { ts: '2025-01-02T00:00:00.000Z', sym: 'XBTUSD', price: 2 },
      { ts: '2025-01-03T00:00:00.000Z', sym: 'XBTUSD', price: 3 },
    ]);

    const results = (await queryRecords(
      'trade',
      { ...baseParams, start: 1 },
      config,
      client,
    )) as Array<Record<string, unknown>>;

    expect(results).toHaveLength(2);
    expect(results[0]!['price']).toBe(2);
  });
});

describe('queryRecords — columns projection', () => {
  it('projects only the requested columns', async () => {
    await insertTrades([{ ts: '2025-01-01T00:00:00.000Z', sym: 'XBTUSD', price: 50_000 }]);

    const results = (await queryRecords(
      'trade',
      { ...baseParams, columns: ['timestamp', 'symbol'] },
      config,
      client,
    )) as Array<Record<string, unknown>>;

    expect(results[0]).toHaveProperty('timestamp');
    expect(results[0]).toHaveProperty('symbol');
    expect(results[0]).not.toHaveProperty('price');
  });
});

// ── querySnapshot ─────────────────────────────────────────────────────────────

describe('querySnapshot — no snapshot available', () => {
  it('returns empty array when accumulator is cold', () => {
    vi.mocked(snapshots.buildSnapshot).mockReturnValue(null);

    const results = querySnapshot('instrument', baseParams);

    expect(results).toEqual([]);
  });
});

describe('querySnapshot — with snapshot data', () => {
  const makeSnapshot = (data: unknown[]) => ({
    table:  'instrument' as const,
    action: 'partial' as const,
    data,
    keys:   ['symbol'],
    types:  { symbol: 'symbol' as const },
    filter: {},
  });

  it('returns all snapshot data with no filter', () => {
    vi.mocked(snapshots.buildSnapshot).mockReturnValue(
      makeSnapshot([{ symbol: 'XBTUSD' }, { symbol: 'ETHUSD' }]),
    );

    const results = querySnapshot('instrument', baseParams);

    expect(results).toHaveLength(2);
  });

  it('filters by symbol when provided', () => {
    vi.mocked(snapshots.buildSnapshot).mockReturnValue(
      makeSnapshot([{ symbol: 'XBTUSD' }, { symbol: 'ETHUSD' }]),
    );

    const results = querySnapshot('instrument', { ...baseParams, symbol: 'XBTUSD' });

    expect(results).toHaveLength(1);
    expect((results[0] as Record<string, unknown>)['symbol']).toBe('XBTUSD');
  });

  it('reverses the data when reverse=true', () => {
    vi.mocked(snapshots.buildSnapshot).mockReturnValue(
      makeSnapshot([{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }]),
    );

    const results = (querySnapshot('instrument', { ...baseParams, reverse: true })) as Array<Record<string, unknown>>;

    expect(results[0]!['symbol']).toBe('C');
    expect(results[2]!['symbol']).toBe('A');
  });

  it('applies start offset', () => {
    vi.mocked(snapshots.buildSnapshot).mockReturnValue(
      makeSnapshot([{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }]),
    );

    const results = (querySnapshot('instrument', { ...baseParams, start: 1 })) as Array<Record<string, unknown>>;

    expect(results).toHaveLength(2);
    expect(results[0]!['symbol']).toBe('B');
  });

  it('applies count limit', () => {
    vi.mocked(snapshots.buildSnapshot).mockReturnValue(
      makeSnapshot([{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }]),
    );

    const results = querySnapshot('instrument', { ...baseParams, count: 2 });

    expect(results).toHaveLength(2);
  });

  it('projects columns when specified', () => {
    vi.mocked(snapshots.buildSnapshot).mockReturnValue(
      makeSnapshot([{ symbol: 'XBTUSD', lastPrice: 50_000, state: 'Open' }]),
    );

    const results = (querySnapshot('instrument', { ...baseParams, columns: ['symbol', 'lastPrice'] })) as Array<Record<string, unknown>>;

    expect(results[0]).toHaveProperty('symbol');
    expect(results[0]).toHaveProperty('lastPrice');
    expect(results[0]).not.toHaveProperty('state');
  });
});
