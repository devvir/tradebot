import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { persistBatch, parseDocument } from '../src/persistence';
import { MongoError } from 'mongodb';
import type { Config } from '../src/types';
import type { Batch } from '../src/types';
import type { ConsumerEvent } from '@devvir/rabbitmq';

const defaultConfig: Config = {
  mongodbUrl: 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin',
  rabbitmqUrl: 'amqp://guest:guest@rabbitmq:5672',
  prefetch: 100,
  flushIntervalMs: 60_000,
};

const DEFAULT_HEADERS = {
  'x-bitmex-published-at': '2026-03-04T01:51:41.208Z',
};

/** Build a ConsumerEvent for testing. */
const createDelivery = (
  routingKey: string,
  content: unknown,
  redelivered = false,
  headers: Record<string, string> = DEFAULT_HEADERS,
): ConsumerEvent => ({
  metadata: {
    routingKey,
    redelivered,
    exchange: 'writer',
    deliveryTag: 1,
    raw: {} as any,
    properties: {} as any,
    headers,
  },
  ack: vi.fn(),
  nack: vi.fn(),
  original: {
    content: typeof content === 'string'
      ? Buffer.from(content)
      : Buffer.from(JSON.stringify(content)),
    fields: { routingKey, redelivered } as any,
    properties: { headers } as any,
  } as any,
});

describe('parseDocument', () => {
  it('generates numeric _id and strips table/action before storing', () => {
    const delivery = createDelivery('archive.trade', { table: 'trade', action: 'insert', price: 100 });
    const { document, collection } = parseDocument(delivery);
    expect(typeof document._id).toBe('number');
    expect(collection).toBe('trade');
    expect(document.price).toBe(100);
    expect(document.table).toBeUndefined();
    expect(document.action).toBeUndefined();
  });

  it('uses x-bitmex-published-at header for _id timestamp when present', () => {
    const delivery = createDelivery('archive.trade', { table: 'trade', action: 'insert' }, false, {
      'x-bitmex-published-at': '2026-03-04T00:00:00.000Z',
    });
    const { document } = parseDocument(delivery);
    expect(typeof document._id).toBe('number');
  });

  it('falls back to current time when x-bitmex-published-at header is absent', () => {
    const delivery = createDelivery('archive.trade', { table: 'trade', action: 'insert' }, false, {});
    const { document } = parseDocument(delivery);
    expect(typeof document._id).toBe('number');
  });

  it('preserves existing doc._id and skips generation', () => {
    const delivery = createDelivery('archive.trade', { table: 'trade', action: 'insert', _id: 99999 });
    const { document } = parseDocument(delivery);
    expect(document._id).toBe(99999);
  });

  it('throws on malformed JSON', () => {
    const delivery = createDelivery('archive.trade', '{bad json}');
    expect(() => parseDocument(delivery)).toThrow();
  });

  it('throws if doc.table is missing', () => {
    const delivery = createDelivery('archive.trade', { action: 'insert', price: 100 });
    expect(() => parseDocument(delivery)).toThrow(/doc\.table/);
  });

  it('throws if doc.action is missing and no _id', () => {
    const delivery = createDelivery('archive.trade', { table: 'trade', price: 100 });
    expect(() => parseDocument(delivery)).toThrow(/doc\.action/);
  });

  it('throws if doc.action is not a valid BitMEX action', () => {
    const delivery = createDelivery('archive.trade', { table: 'trade', action: 'badaction' });
    expect(() => parseDocument(delivery)).toThrow(/doc\.action/);
  });

  it('revives serialized Buffers back to Buffer instances', () => {
    const delivery = createDelivery('archive.trade', {
      table: 'trade',
      action: 'insert',
      payload: { type: 'Buffer', data: [1, 2, 3] },
    });
    const { document } = parseDocument(delivery);
    expect(Buffer.isBuffer(document.payload)).toBe(true);
    expect(document.payload).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('persistBatch', () => {
  let mockCollection: any;
  let mockDb: any;
  let mockMongo: any;

  beforeEach(() => {
    mockCollection = {
      insertMany: vi.fn().mockResolvedValue({ insertedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ insertedId: 'ok' }),
    };

    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    };

    mockMongo = {
      db: vi.fn().mockReturnValue(mockDb),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const makeBatch = (database: string, collection: string, entries: Array<{ routingKey: string; doc: Record<string, unknown>; redelivered?: boolean }>): Batch => ({
    database,
    collection,
    entries: entries.map(e => ({
      delivery: createDelivery(e.routingKey, e.doc, e.redelivered ?? false),
      document: e.doc,
    })),
  });

  it('should insertMany with ordered:false and ack all entries', async () => {
    const batch = makeBatch('tradebot_archive', 'orderBookL2', [
      { routingKey: 'archive.orderBookL2', doc: { price: 100 } },
      { routingKey: 'archive.orderBookL2', doc: { price: 200 } },
    ]);
    const onStoreMsg = vi.fn();

    await persistBatch(mockMongo, batch, 'writer.archive', onStoreMsg);

    expect(mockMongo.db).toHaveBeenCalledWith('tradebot_archive');
    expect(mockDb.collection).toHaveBeenCalledWith('orderBookL2');
    expect(mockCollection.insertMany).toHaveBeenCalledWith(
      [{ price: 100 }, { price: 200 }],
      { ordered: false },
    );
    expect(batch.entries[0].delivery.ack).toHaveBeenCalled();
    expect(batch.entries[1].delivery.ack).toHaveBeenCalled();
    expect(onStoreMsg).toHaveBeenCalledTimes(2);
  });

  it('should call onStoreMsg for each acked entry', async () => {
    const batch = makeBatch('db', 'col', [
      { routingKey: 'collect.trade', doc: { v: 1 } },
    ]);
    const onStoreMsg = vi.fn();

    await persistBatch(mockMongo, batch, 'writer.collect', onStoreMsg);

    expect(onStoreMsg).toHaveBeenCalledTimes(1);
  });

  it('should delegate to error handler on insertMany failure', async () => {
    const error = new Error('Connection timeout');
    mockCollection.insertMany.mockRejectedValueOnce(error);

    const batch = makeBatch('db', 'col', [
      { routingKey: 'collect.trade', doc: { v: 1 } },
    ]);
    const onStoreMsg = vi.fn();

    await persistBatch(mockMongo, batch, 'writer.collect', onStoreMsg);

    // insertOne fallback (from error handler) succeeds by default
    expect(mockCollection.insertOne).toHaveBeenCalledWith({ v: 1 });
    expect(batch.entries[0].delivery.ack).toHaveBeenCalled();
  });

  it('should requeue first-attempt messages when persistence fails entirely', async () => {
    const error = Object.assign(Object.create(MongoError.prototype), { code: 999 });
    mockCollection.insertMany.mockRejectedValueOnce(error);
    mockCollection.insertOne.mockRejectedValueOnce(error);

    const batch = makeBatch('db', 'col', [
      { routingKey: 'collect.trade', doc: { v: 1 }, redelivered: false },
    ]);
    const onStoreMsg = vi.fn();

    await persistBatch(mockMongo, batch, 'writer.collect', onStoreMsg);

    expect(batch.entries[0].delivery.nack).toHaveBeenCalledWith(true);
    expect(onStoreMsg).not.toHaveBeenCalled();
  });

  it('should dead-letter redelivered messages when persistence fails entirely', async () => {
    const error = new Error('Persistent failure');
    mockCollection.insertMany.mockRejectedValueOnce(error);
    mockCollection.insertOne.mockRejectedValueOnce(error);

    const batch = makeBatch('db', 'col', [
      { routingKey: 'collect.trade', doc: { v: 1 }, redelivered: true },
    ]);
    const onStoreMsg = vi.fn();

    await persistBatch(mockMongo, batch, 'writer.collect', onStoreMsg);

    expect(batch.entries[0].delivery.nack).toHaveBeenCalledWith(false);
    expect(onStoreMsg).not.toHaveBeenCalled();
  });

  it('should ack on duplicate key error via insertOne fallback', async () => {
    const error = Object.assign(Object.create(MongoError.prototype), { code: 11000 });
    mockCollection.insertMany.mockRejectedValueOnce(error);

    const batch = makeBatch('db', 'col', [
      { routingKey: 'archive.trade', doc: { _id: 'dup' } },
    ]);
    const onStoreMsg = vi.fn();

    await persistBatch(mockMongo, batch, 'writer.archive', onStoreMsg);

    expect(batch.entries[0].delivery.ack).toHaveBeenCalled();
    expect(batch.entries[0].delivery.nack).not.toHaveBeenCalled();
  });
});
