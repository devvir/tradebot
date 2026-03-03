// Pending Review
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { persistBatch, resolveTarget, parseDocument } from '../src/persistence';
import { MongoError } from 'mongodb';
import type { Config } from '../src/types';
import type { Batch } from '../src/types';
import type { ConsumerEvent } from '@devvir/rabbitmq';

const defaultConfig: Config = {
  mongodbUrl: 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin',
  rabbitmqUrl: 'amqp://guest:guest@rabbitmq:5672',
  dbArchive: 'tradebot_archive',
  dbCollect: 'tradebot_collect',
  prefetch: 100,
  insertBatchSize: 1,
  flushIntervalMs: 60_000,
};

/** Drain all pending microtasks so async operations complete. */
const drain = () => new Promise<void>(resolve => setImmediate(resolve));

/** Build a ConsumerEvent for testing. */
const makeEvent = (routingKey: string, content: unknown, redelivered = false): ConsumerEvent => ({
  metadata: {
    routingKey,
    redelivered,
    exchange: 'writer',
    deliveryTag: 1,
    raw: {} as any,
    properties: {} as any,
  },
  ack: vi.fn(),
  nack: vi.fn(),
  original: {
    content: typeof content === 'string'
      ? Buffer.from(content)
      : Buffer.from(JSON.stringify(content)),
    fields: { routingKey, redelivered } as any,
    properties: { headers: {} } as any,
  } as any,
});

describe('resolveTarget', () => {
  it('should resolve archive routing key to dbArchive', () => {
    const target = resolveTarget('archive.orderBookL2', defaultConfig);
    expect(target).toEqual({ database: 'tradebot_archive', collection: 'orderBookL2' });
  });

  it('should resolve collect routing key to dbCollect', () => {
    const target = resolveTarget('collect.trade', defaultConfig);
    expect(target).toEqual({ database: 'tradebot_collect', collection: 'trade' });
  });

  it('should resolve custom routing key to explicit database and collection', () => {
    const target = resolveTarget('custom.mydb.mycol', defaultConfig);
    expect(target).toEqual({ database: 'mydb', collection: 'mycol' });
  });

  it('should use configured dbArchive value', () => {
    const config = { ...defaultConfig, dbArchive: 'custom_archive' };
    const target = resolveTarget('archive.quote', config);
    expect(target).toEqual({ database: 'custom_archive', collection: 'quote' });
  });

  it('should use configured dbCollect value', () => {
    const config = { ...defaultConfig, dbCollect: 'custom_collect' };
    const target = resolveTarget('collect.instrument', config);
    expect(target).toEqual({ database: 'custom_collect', collection: 'instrument' });
  });

  it('should return null for unknown prefix', () => {
    expect(resolveTarget('unknown.trade', defaultConfig)).toBeNull();
  });

  it('should return null for routing key with no dots', () => {
    expect(resolveTarget('archive', defaultConfig)).toBeNull();
  });

  it('should return null for empty routing key', () => {
    expect(resolveTarget('', defaultConfig)).toBeNull();
  });

  it('should use first segment after prefix for archive regardless of extra dots', () => {
    expect(resolveTarget('archive.a.b', defaultConfig)).toEqual({ database: 'tradebot_archive', collection: 'a' });
  });

  it('should use first segment after prefix for collect regardless of extra dots', () => {
    expect(resolveTarget('collect.a.b', defaultConfig)).toEqual({ database: 'tradebot_collect', collection: 'a' });
  });

  it('should require at least two segments for custom', () => {
    expect(resolveTarget('custom.onlyone', defaultConfig)).toBeNull();
    expect(resolveTarget('custom.a.b.c', defaultConfig)).toEqual({ database: 'a', collection: 'b' });
  });
});

describe('parseDocument', () => {
  it('should parse JSON content from event', () => {
    const event = makeEvent('archive.trade', { price: 100 });
    const doc = parseDocument(event);
    expect(doc).toEqual({ price: 100 });
  });

  it('should throw on malformed JSON', () => {
    const event = makeEvent('archive.trade', '{bad json}');
    expect(() => parseDocument(event)).toThrow();
  });

  it('should revive serialized Buffers back to Buffer instances', () => {
    const serializedBuffer = { type: 'Buffer', data: [1, 2, 3] };
    const event = makeEvent('archive.trade', { payload: serializedBuffer });
    const doc = parseDocument(event);
    expect(Buffer.isBuffer(doc.payload)).toBe(true);
    expect(doc.payload).toEqual(Buffer.from([1, 2, 3]));
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
      event: makeEvent(e.routingKey, e.doc, e.redelivered ?? false),
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
    expect(batch.entries[0].event.ack).toHaveBeenCalled();
    expect(batch.entries[1].event.ack).toHaveBeenCalled();
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
    expect(batch.entries[0].event.ack).toHaveBeenCalled();
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

    expect(batch.entries[0].event.nack).toHaveBeenCalledWith(true);
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

    expect(batch.entries[0].event.nack).toHaveBeenCalledWith(false);
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

    expect(batch.entries[0].event.ack).toHaveBeenCalled();
    expect(batch.entries[0].event.nack).not.toHaveBeenCalled();
  });
});