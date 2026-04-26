import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import * as clock from '../src/clock';
import * as snapshots from '../src/snapshots';
import { setClock } from '../src/commands/setClock';
import { subscribe } from '../src/commands/subscribe';
import type { Broker } from '@devvir/service-kit';
import type { Config, State } from '../src/types';

// ── Setup ─────────────────────────────────────────────────────────────────────

const DB = 'test_digger_set_clock';
const config: Config = {
  workerUuid:         'test-uuid',
  database:           DB,
  bufferLowWatermark: 5_000,
  bufferBatchSize:    1_000,
  // No waitIfQueues — drain step is skipped, lets us test the rest in isolation
};

let client: MongoClient;

const stubBroker = (): Broker => {
  const exchange = { publish: vi.fn(async () => {}) };

  return {
    getExchange: () => exchange,
    getUrl:      () => 'amqp://test',
  } as unknown as Broker;
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
  clock._test_reset();
  snapshots._test_reset();
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('setClock — validation', () => {
  it('throws 400 on a non-positive timestamp', async () => {
    const state  = makeState();
    const broker = stubBroker();

    await expect(setClock(0,  state, config, client, broker)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(setClock(-1, state, config, client, broker)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(setClock(NaN, state, config, client, broker)).rejects.toMatchObject({ httpStatus: 400 });
  });
});

// ── Behaviour ────────────────────────────────────────────────────────────────

describe('setClock — moves the clock and resets snapshots', () => {
  it('updates clock.fetch() and clears prior accumulator state', async () => {
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());
    snapshots.feed({
      table:  'instrument',
      action: 'partial',
      data:   [{ symbol: 'XBTUSD', lastPrice: 1 }],
      keys:   ['symbol'],
      types:  { symbol: 'symbol', lastPrice: 'float' },
      filter: {},
    });

    expect(snapshots.buildSnapshot('instrument')).not.toBeNull();

    const state  = makeState();
    const broker = stubBroker();
    const newTs  = new Date('2026-06-01T00:00:00.000Z').getTime();

    await setClock(newTs, state, config, client, broker);

    expect(clock.fetch()).toBe(newTs);
    expect(snapshots.buildSnapshot('instrument')).toBeNull();
  });

  it('returns the stream loop to the unpaused state on success', async () => {
    const state  = makeState();
    const broker = stubBroker();

    await setClock(new Date('2025-01-01T00:00:00.000Z').getTime(), state, config, client, broker);

    expect(state.isPaused).toBe(false);
  });
});

// ── Re-priming subscriptions ─────────────────────────────────────────────────

describe('setClock — re-primes existing subscriptions', () => {
  it('preserves the same set of subscribed tables across the clock change', async () => {
    clock.set(new Date('2025-01-01T00:00:00.000Z').getTime());

    await client.db(DB).collection('trade').insertMany([
      { _id: 1, timestamp: '2025-01-01T00:00:00.000Z', symbol: 'XBTUSD', size: 1, price: 50_000 },
      { _id: 2, timestamp: '2026-06-01T00:00:00.000Z', symbol: 'XBTUSD', size: 2, price: 60_000 },
    ]);

    const state  = makeState();
    const broker = stubBroker();

    await subscribe('trade', state, config, client, broker);
    expect(state.subscriptions.has('trade')).toBe(true);

    await setClock(new Date('2026-06-01T00:00:00.000Z').getTime(), state, config, client, broker);

    expect(state.subscriptions.has('trade')).toBe(true);
    expect(state.buffers.has('trade')).toBe(true);

    // Buffer was rebuilt at the new clock — should contain the 2026 doc
    const entries = state.buffers.get('trade')!.entries;

    expect(entries.length).toBe(1);
    expect(entries[0]!.timestamp).toBe('2026-06-01T00:00:00.000Z');
  });
});
