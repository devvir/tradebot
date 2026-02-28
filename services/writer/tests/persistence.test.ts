// Pending Review
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startConsuming, resolveTarget } from '../src/persistence';
import { MongoError, BSON, Binary } from 'mongodb';
import { CONSUMER_QUEUES } from '../src/types';
import type { Config } from '../src/types';

vi.mock('amqplib');

const defaultConfig: Config = {
  mongodbUrl: 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin',
  rabbitmqUrl: 'amqp://guest:guest@rabbitmq:5672',
  dbArchive: 'tradebot_archive',
  dbCollect: 'tradebot_collect',
  batchSize: 100,
};

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

describe('Message persistence', () => {
  let mockChannel: any;
  let mockDb: any;
  let mockCollection: any;
  let mockClient: any;

  beforeEach(() => {
    mockCollection = {
      insertOne: vi.fn().mockResolvedValue({ insertedCount: 1 }),
    };

    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    };

    mockClient = {
      db: vi.fn().mockReturnValue(mockDb),
    };

    mockChannel = {
      assertQueue: vi.fn().mockResolvedValue({}),
      prefetch: vi.fn().mockResolvedValue({}),
      consume: vi.fn((_queue: string, callback: any) => {
        if (! mockChannel._callbacks) mockChannel._callbacks = {};
        mockChannel._callbacks[_queue] = callback;
      }),
      ack: vi.fn(),
      nack: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Helper: start consuming and return the consume callback for a specific queue. */
  const setup = async (config = defaultConfig) => {
    const onStoreMsg = vi.fn();
    await startConsuming(mockChannel, mockClient, config, onStoreMsg);

    return {
      onStoreMsg,
      callback: (queue: string) => mockChannel._callbacks[queue],
    };
  };

  /** Build a minimal AMQP message with a routing key. */
  const msg = (routingKey: string, content: unknown, contentType?: string) => ({
    content: typeof content === 'string'
      ? Buffer.from(content)
      : Buffer.isBuffer(content) ? content : Buffer.from(JSON.stringify(content)),
    fields: { routingKey },
    properties: { contentType, headers: {} },
  });

  describe('startConsuming', () => {
    it('should set prefetch once for the channel', async () => {
      await setup();
      expect(mockChannel.prefetch).toHaveBeenCalledWith(100);
      expect(mockChannel.prefetch).toHaveBeenCalledTimes(1);
    });

    it('should consume from all three queues', async () => {
      await setup();

      for (const q of Object.values(CONSUMER_QUEUES)) {
        expect(mockChannel.consume).toHaveBeenCalledWith(q, expect.any(Function));
      }
    });

    it('should handle null message gracefully', async () => {
      const { callback } = await setup();

      await callback(CONSUMER_QUEUES.archive)(null);

      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });
  });

  describe('archive queue routing', () => {
    it('should store in dbArchive with collection from routing key', async () => {
      const { callback } = await setup();

      await callback(CONSUMER_QUEUES.archive)(msg('archive.orderBookL2', { price: 100 }));

      expect(mockClient.db).toHaveBeenCalledWith('tradebot_archive');
      expect(mockDb.collection).toHaveBeenCalledWith('orderBookL2');
      expect(mockCollection.insertOne).toHaveBeenCalledWith({ price: 100 });
      expect(mockChannel.ack).toHaveBeenCalled();
    });
  });

  describe('collect queue routing', () => {
    it('should store in dbCollect with collection from routing key', async () => {
      const { callback } = await setup();

      await callback(CONSUMER_QUEUES.collect)(msg('collect.trade', { side: 'Buy' }));

      expect(mockClient.db).toHaveBeenCalledWith('tradebot_collect');
      expect(mockDb.collection).toHaveBeenCalledWith('trade');
      expect(mockCollection.insertOne).toHaveBeenCalledWith({ side: 'Buy' });
      expect(mockChannel.ack).toHaveBeenCalled();
    });
  });

  describe('custom queue routing', () => {
    it('should store in custom database and collection from routing key', async () => {
      const { callback } = await setup();

      await callback(CONSUMER_QUEUES.custom)(msg('custom.mydb.mycol', { value: 42 }));

      expect(mockClient.db).toHaveBeenCalledWith('mydb');
      expect(mockDb.collection).toHaveBeenCalledWith('mycol');
      expect(mockCollection.insertOne).toHaveBeenCalledWith({ value: 42 });
      expect(mockChannel.ack).toHaveBeenCalled();
    });
  });

  describe('document creation', () => {
    it('should parse JSON content by default', async () => {
      const { callback } = await setup();

      await callback(CONSUMER_QUEUES.archive)(msg('archive.quote', { value: 100 }));

      const doc = mockCollection.insertOne.mock.calls[0][0];
      expect(doc).toEqual({ value: 100 });
    });

    it('should parse JSON when contentType is application/json', async () => {
      const { callback } = await setup();

      await callback(CONSUMER_QUEUES.archive)(msg('archive.quote', { value: 100 }, 'application/json'));

      const doc = mockCollection.insertOne.mock.calls[0][0];
      expect(doc).toEqual({ value: 100 });
    });

    it('should deserialize BSON content preserving binary fields', async () => {
      const { callback } = await setup();
      const payload = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
      const bsonBuffer = Buffer.from(BSON.serialize({ _id: 12345, b: payload }));

      await callback(CONSUMER_QUEUES.archive)(msg('archive.encoded', bsonBuffer, 'application/bson'));

      const doc = mockCollection.insertOne.mock.calls[0][0];
      expect(doc._id).toBe(12345);
      expect(doc.b).toBeInstanceOf(Binary);
      expect(Buffer.from(doc.b.buffer)).toEqual(payload);
    });
  });

  describe('error handling', () => {
    it('should nack without requeue when routing key is unresolvable', async () => {
      const { callback } = await setup();
      const m = msg('bad', { v: 1 });

      await callback(CONSUMER_QUEUES.archive)(m);

      expect(mockChannel.nack).toHaveBeenCalledWith(m, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should ack duplicate key errors (11000) as idempotent', async () => {
      const { callback } = await setup();
      const error = Object.create(MongoError.prototype);
      error.code = 11000;
      mockCollection.insertOne.mockRejectedValueOnce(error);

      const m = msg('archive.trade', { _id: 'dup' });
      await callback(CONSUMER_QUEUES.archive)(m);

      expect(mockChannel.ack).toHaveBeenCalledWith(m);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should nack MongoError with requeue', async () => {
      const { callback } = await setup();
      const error = Object.create(MongoError.prototype);
      error.code = 999;
      mockCollection.insertOne.mockRejectedValueOnce(error);

      const m = msg('archive.trade', { v: 1 });
      await callback(CONSUMER_QUEUES.archive)(m);

      expect(mockChannel.nack).toHaveBeenCalledWith(m, false, true);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should nack malformed JSON without requeue', async () => {
      const { callback } = await setup();
      const m = msg('archive.trade', '{bad json}');

      await callback(CONSUMER_QUEUES.archive)(m);

      expect(mockChannel.nack).toHaveBeenCalledWith(m, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should nack non-Mongo errors without requeue', async () => {
      const { callback } = await setup();
      mockCollection.insertOne.mockRejectedValueOnce(new Error('Unexpected'));

      const m = msg('archive.trade', { v: 1 });
      await callback(CONSUMER_QUEUES.archive)(m);

      expect(mockChannel.nack).toHaveBeenCalledWith(m, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should call onStoreMsg on successful insert', async () => {
      const { callback, onStoreMsg } = await setup();

      await callback(CONSUMER_QUEUES.collect)(msg('collect.trade', { v: 1 }));

      expect(onStoreMsg).toHaveBeenCalled();
    });

    it('should call onStoreMsg on duplicate key', async () => {
      const { callback, onStoreMsg } = await setup();
      const error = Object.create(MongoError.prototype);
      error.code = 11000;
      mockCollection.insertOne.mockRejectedValueOnce(error);

      await callback(CONSUMER_QUEUES.collect)(msg('collect.trade', { _id: 'dup' }));

      expect(onStoreMsg).toHaveBeenCalled();
    });

    it('should not call onStoreMsg on error', async () => {
      const { callback, onStoreMsg } = await setup();
      const error = Object.create(MongoError.prototype);
      error.code = 999;
      mockCollection.insertOne.mockRejectedValueOnce(error);

      await callback(CONSUMER_QUEUES.collect)(msg('collect.trade', { v: 1 }));

      expect(onStoreMsg).not.toHaveBeenCalled();
    });
  });
});

