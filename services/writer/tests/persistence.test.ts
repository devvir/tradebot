import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import createManager from '../src/manager';
import { flushStore } from '../src/batch';
import { MongoBulkWriteError } from 'mongodb';
import type { ConsumerEvent } from '../src/types';
import type { Config } from '../src/types';

vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/semaphore', () => ({
  paused: vi.fn(() => false),
  pause: vi.fn(),
}));

const config: Config = {
  mongodbUrl: 'mongodb://localhost:27017',
  rabbitmqUrl: 'amqp://localhost:5672',
  prefetch: 100,
  flushIntervalMs: 60_000,
};

const delivery = (redelivered = false, headers: Record<string, unknown> = { 'x-bitmex-published-at': 1741046301208 }): ConsumerEvent => ({
  metadata: {
    routingKey: 'writer.trade',
    redelivered,
    exchange: 'writer',
    deliveryTag: 1,
    raw: {} as any,
    properties: {} as any,
    headers,
  },
  ack: vi.fn(),
  nack: vi.fn(),
  original: {} as any,
});

let mockCollection: { insertMany: ReturnType<typeof vi.fn> };
let mockMongo: any;

beforeEach(() => {
  flushStore();
  mockCollection = { insertMany: vi.fn().mockResolvedValue({}) };
  mockMongo = {
    db: vi.fn().mockReturnValue({ collection: vi.fn().mockReturnValue(mockCollection) }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── enqueue ───────────────────────────────────────────────────────────────────

describe('enqueue', () => {
  it('adds a valid document to the batch', () => {
    const d = delivery();
    createManager(config, mockMongo).enqueue({ table: 'trade', action: 'insert', price: 100 }, d);
    const [batch] = flushStore();
    expect(batch?.collection).toBe('trade');
    expect(batch?.entries[0].document.price).toBe(100);
  });

  it('strips table and action from the stored document', () => {
    const d = delivery();
    createManager(config, mockMongo).enqueue({ table: 'trade', action: 'insert' }, d);
    const [batch] = flushStore();
    expect((batch.entries[0].document as any).table).toBeUndefined();
    expect((batch.entries[0].document as any).action).toBeUndefined();
  });

  it('acks and skips invalid messages (no table or action)', () => {
    const d = delivery();
    createManager(config, mockMongo).enqueue({ price: 100 }, d);
    expect(d.ack).toHaveBeenCalled();
    expect(flushStore()).toHaveLength(0);
  });

  it('uses x-writer-database header as database name', () => {
    const d = delivery(false, { 'x-bitmex-published-at': 1741046301208, 'x-writer-database': 'mydb' });
    createManager(config, mockMongo).enqueue({ table: 'trade', action: 'insert' }, d);
    const [batch] = flushStore();
    expect(batch.database).toBe('mydb');
  });

  it('defaults database to tradebot', () => {
    const d = delivery();
    createManager(config, mockMongo).enqueue({ table: 'trade', action: 'insert' }, d);
    const [batch] = flushStore();
    expect(batch.database).toBe('tradebot');
  });

  it('preserves an existing numeric _id', () => {
    const d = delivery();
    createManager(config, mockMongo).enqueue({ table: 'trade', action: 'insert', _id: 42 }, d);
    const [batch] = flushStore();
    expect(batch.entries[0].document._id).toBe(42);
  });

  it('generates a numeric _id when absent', () => {
    const d = delivery();
    createManager(config, mockMongo).enqueue({ table: 'trade', action: 'insert' }, d);
    const [batch] = flushStore();
    expect(typeof batch.entries[0].document._id).toBe('number');
  });
});

// ── flush ─────────────────────────────────────────────────────────────────────

describe('flush', () => {
  it('calls insertMany with all documents in the batch', async () => {
    const manager = createManager(config, mockMongo);
    const d1 = delivery();
    const d2 = delivery();
    manager.enqueue({ table: 'trade', action: 'insert', price: 100 }, d1);
    manager.enqueue({ table: 'trade', action: 'insert', price: 200 }, d2);
    await manager.flush();
    expect(mockCollection.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ price: 100 }),
        expect.objectContaining({ price: 200 }),
      ]),
      { ordered: false },
    );
  });

  it('acks all entries on success', async () => {
    const manager = createManager(config, mockMongo);
    const d1 = delivery();
    const d2 = delivery();
    manager.enqueue({ table: 'trade', action: 'insert' }, d1);
    manager.enqueue({ table: 'trade', action: 'insert' }, d2);
    await manager.flush();
    expect(d1.ack).toHaveBeenCalled();
    expect(d2.ack).toHaveBeenCalled();
  });

  it('nacks all entries with requeue on unexpected errors', async () => {
    mockCollection.insertMany.mockRejectedValueOnce(new Error('Connection lost'));
    const manager = createManager(config, mockMongo);
    const d = delivery(false);
    manager.enqueue({ table: 'trade', action: 'insert' }, d);
    await manager.flush();
    expect(d.nack).toHaveBeenCalledWith(true);
  });

  it('acks successful entries on partial MongoBulkWriteError', async () => {
    const err = Object.create(MongoBulkWriteError.prototype) as MongoBulkWriteError;
    Object.defineProperty(err, 'writeErrors', { value: [{ index: 1, code: 999 }] });
    mockCollection.insertMany.mockRejectedValueOnce(err);

    const manager = createManager(config, mockMongo);
    const d0 = delivery();
    const d1 = delivery();
    manager.enqueue({ table: 'trade', action: 'insert', _id: 1 }, d0);
    manager.enqueue({ table: 'trade', action: 'insert', _id: 2 }, d1);
    await manager.flush();

    expect(d0.ack).toHaveBeenCalled();          // index 0: success
    expect(d1.nack).toHaveBeenCalledWith(true);  // index 1: first attempt → requeue
  });

  it('dead-letters redelivered entries on non-duplicate MongoBulkWriteError', async () => {
    const err = Object.create(MongoBulkWriteError.prototype) as MongoBulkWriteError;
    Object.defineProperty(err, 'writeErrors', { value: [{ index: 0, code: 999 }] });
    mockCollection.insertMany.mockRejectedValueOnce(err);

    const manager = createManager(config, mockMongo);
    const d = delivery(true); // redelivered
    manager.enqueue({ table: 'trade', action: 'insert', _id: 1 }, d);
    await manager.flush();

    expect(d.nack).toHaveBeenCalledWith(false); // dead-letter
  });

  it('requeues duplicate-key (11000) entries into the batch for retry', async () => {
    const err = Object.create(MongoBulkWriteError.prototype) as MongoBulkWriteError;
    Object.defineProperty(err, 'writeErrors', { value: [{ index: 0, code: 11000 }] });
    mockCollection.insertMany.mockRejectedValueOnce(err);

    const manager = createManager(config, mockMongo);
    const d = delivery();
    manager.enqueue({ table: 'trade', action: 'insert', _id: 1 }, d);
    await manager.flush();

    // Not immediately acked or nacked — entry is retried via handleDuplicates
    expect(d.ack).not.toHaveBeenCalled();
    expect(d.nack).not.toHaveBeenCalled();

    // The entry is back in the batch with a new _id and incremented retries
    const [batch] = flushStore();
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].retries).toBe(1);
    expect(batch.entries[0].document._id).not.toBe(1);
  });
});
