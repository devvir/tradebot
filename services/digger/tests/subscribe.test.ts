import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { makeMongoId } from '@tradebot/utils';
import * as clock from '../src/clock';
import * as snapshots from '../src/snapshots';
import { subscribe, unsubscribe, resubscribe } from '../src/commands/subscribe';
import type { Broker } from '@devvir/service-kit';
import type { Config, MongoDoc, State } from '../src/types';

// ── Setup ─────────────────────────────────────────────────────────────────────

const DB = 'test_digger_subscribe';
const config: Config = {
  workerUuid:         'test-uuid',
  database:           DB,
  bufferLowWatermark: 5_000,
  bufferBatchSize:    1_000,
};

let client: MongoClient;
let publishCalls: Array<{ key: string; body: unknown }> = [];

const stubBroker = (): Broker => {
  const exchange = {
    publish: vi.fn(async (buf: Buffer, key: string) => {
      publishCalls.push({ key, body: JSON.parse(buf.toString()) });
    }),
  };

  return { getExchange: () => exchange } as unknown as Broker;
};

const makeState = (): State => ({
  subscriptions:  new Map(),
  buffers:        new Map(),
  broker:         null,
  isShuttingDown: false,
  isPaused:       false,
  messages:       0,
  lastMessageAt:  null,
});

/** Build a vault-style _id for a calendar day (YYYY-MM-DD) + 0-based slot. */
const makeId = (date: string, slot: number): number =>
  makeMongoId(date, slot + 1);

beforeAll(async () => {
  client = new MongoClient(process.env['DB_URL']!);
  await client.connect();
});

afterAll(async () => {
  await client.db(DB).dropDatabase();
  await client.close();
});

beforeEach(async () => {
  for (const coll of ['trade', 'instrument']) {
    await client.db(DB).collection(coll).deleteMany({});
  }

  clock._test_reset();
  snapshots._test_reset();
  publishCalls = [];
});

// ── subscribe — clock contract ────────────────────────────────────────────────

describe('subscribe — clock not set', () => {
  it('registers the subscription without fetching — buffer idles until set-clock', async () => {
    const state  = makeState();
    const broker = stubBroker();

    await subscribe('trade', state, config, client, broker);

    expect(state.subscriptions.has('trade')).toBe(true);

    const buf = state.buffers.get('trade')!;

    expect(buf.entries.length).toBe(0);
    expect(buf.cursor).toBeNull();
    expect(buf.exhausted).toBe(false);
    expect(publishCalls.length).toBe(0);
  });
});

describe('subscribe — unknown table', () => {
  it('throws 400', async () => {
    const state  = makeState();
    const broker = stubBroker();

    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    await expect(subscribe('nonsense', state, config, client, broker))
      .rejects.toMatchObject({ httpStatus: 400 });
  });
});

// ── subscribe — REST-origin (static partial path) ─────────────────────────────

describe('subscribe — REST-origin trade', () => {
  it('publishes the static partial and starts the buffer at the clock', async () => {
    const start = new Date('2025-01-01T00:00:00.000Z').getTime();

    clock.set(start);

    const state  = makeState();
    const broker = stubBroker();

    await client.db(DB).collection('trade').insertMany([
      { _id: 1, timestamp: '2025-01-01T00:00:00.000Z', symbol: 'XBTUSD', size: 1, price: 50_000 },
      { _id: 2, timestamp: '2025-01-01T00:00:01.000Z', symbol: 'XBTUSD', size: 2, price: 50_001 },
    ]);

    await subscribe('trade', state, config, client, broker);

    // A partial was published with table=trade
    const partial = publishCalls.find(c => c.key === 'trade.partial');

    expect(partial).toBeDefined();
    expect((partial!.body as Record<string, unknown>)['table']).toBe('trade');
    expect((partial!.body as Record<string, unknown>)['action']).toBe('partial');

    // Buffer was initial-filled (entries from the clock onwards)
    const buf = state.buffers.get('trade')!;

    expect(buf.entries.length).toBeGreaterThan(0);
  });

  it('refuses a duplicate subscribe (no-ops without throwing)', async () => {
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    const state  = makeState();
    const broker = stubBroker();

    await subscribe('trade', state, config, client, broker);
    await subscribe('trade', state, config, client, broker);

    expect(state.subscriptions.size).toBe(1);
  });
});

// ── subscribe — WS-origin cold start (backfill path) ──────────────────────────

describe('subscribe — WS-origin instrument with stored partial', () => {
  it('runs backfill, seeds snapshots, publishes a partial built from MongoDB', async () => {
    const day = '2025-01-15';

    await client.db(DB).collection('instrument').insertMany([
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
    ] as unknown as MongoDoc[]);

    clock.set(new Date('2025-01-15T10:00:00.000Z').getTime());

    const state  = makeState();
    const broker = stubBroker();

    await subscribe('instrument', state, config, client, broker);

    const partialPub = publishCalls.find(c => c.key === 'instrument.partial');

    expect(partialPub).toBeDefined();

    const body = partialPub!.body as Record<string, unknown>;

    expect(body['table']).toBe('instrument');
    expect(body['action']).toBe('partial');

    const data = body['data'] as Array<Record<string, unknown>>;

    expect(data).toHaveLength(1);
    expect(data[0]!['lastPrice']).toBe(51_000);
  });
});

// ── unsubscribe / resubscribe ─────────────────────────────────────────────────

describe('unsubscribe', () => {
  it('drops the subscription and buffer', async () => {
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    const state  = makeState();
    const broker = stubBroker();

    await subscribe('trade', state, config, client, broker);
    expect(state.subscriptions.has('trade')).toBe(true);

    unsubscribe('trade', state);

    expect(state.subscriptions.has('trade')).toBe(false);
    expect(state.buffers.has('trade')).toBe(false);
  });
});

describe('resubscribe', () => {
  it('refreshes the buffer without changing the clock', async () => {
    const start = new Date('2025-01-01T00:00:00.000Z').getTime();

    clock.set(start);

    const state  = makeState();
    const broker = stubBroker();

    await subscribe('trade', state, config, client, broker);
    await resubscribe('trade', state, config, client, broker);

    expect(state.subscriptions.has('trade')).toBe(true);
    expect(clock.fetch()).toBe(start);
  });
});
