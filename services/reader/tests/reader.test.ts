// Pending Review
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import { RabbitMQ } from '@devvir/service-kit';
import {
  collectionStates,
  processCollection,
  collectionsStateToPersisted,
  restoreCollectionStatesFromPersisted,
} from '../src/poller';
import {
  getCollectionsToProcess,
  getPersistedPollingState,
  updatePersistedPollingState,
} from '../src/persistence';
import { loadPollingState, savePollingState } from '../src/state';

// Ports are discovered dynamically — globalSetup writes them after Docker assigns random ones
const { mongoPort, rabbitPort } = JSON.parse(
  readFileSync(resolve(__dirname, '.ports.json'), 'utf8'),
);

const mongoUrl = `mongodb://root:root@localhost:${mongoPort}/test_reader?authSource=admin`;
const rabbitUrl = `amqp://guest:guest@localhost:${rabbitPort}`;

describe('Reader Service', () => {
  let mongoClient: MongoClient;
  let db: Db;
  let broker: RabbitMQ.Broker;
  const originalEnv = process.env;

  beforeAll(async () => {
    mongoClient = new MongoClient(mongoUrl);
    await mongoClient.connect();
    db = mongoClient.db();

    broker = await RabbitMQ.keepAlive(rabbitUrl);

    await db.collection('_reader_state').deleteMany({});
  });

  afterAll(async () => {
    await broker?.disconnect();
    await mongoClient?.close();
    process.env = originalEnv;
  });

  // ── Config Validation ──────────────────────────────────────────────────────

  describe('Config Validation', () => {
    const valid = {
      QUEUE_URL: 'amqp://localhost:5672',
      DB_URL: 'mongodb://localhost:27017/test',
      READER_DATABASE: 'test_reader',
      READER_POLL_INTERVAL_MS: '3000',
    };

    beforeEach(() => { process.env = { ...originalEnv, ...valid }; });

    afterEach(() => {
      delete require.cache[require.resolve('../dist/src/config.js')];
      process.env = originalEnv;
    });

    const load = () => {
      delete require.cache[require.resolve('../dist/src/config.js')];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../dist/src/config.js').loadConfig;
    };

    it('rejects missing DB_URL', () => {
      delete process.env.DB_URL;
      expect(() => load()()).toThrow('DB_URL is required');
    });

    it('rejects missing READER_DATABASE', () => {
      delete process.env.READER_DATABASE;
      expect(() => load()()).toThrow('READER_DATABASE is required');
    });

    it('rejects missing QUEUE_URL', () => {
      delete process.env.QUEUE_URL;
      expect(() => load()()).toThrow('QUEUE_URL is required');
    });

    it('rejects READER_POLL_INTERVAL_MS below 100ms', () => {
      process.env.READER_POLL_INTERVAL_MS = '50';
      expect(() => load()()).toThrow('READER_POLL_INTERVAL_MS must be at least 100ms');
    });

    it('accepts READER_MAX_READY of 0 to disable backpressure', () => {
      process.env.READER_MAX_READY = '0';
      expect(() => load()()).not.toThrow();
    });
  });

  // ── Configuration Loading ──────────────────────────────────────────────────

  describe('Configuration Loading', () => {
    const valid = {
      DB_URL: 'mongodb://localhost:27017/test',
      READER_DATABASE: 'test_reader',
      QUEUE_URL: 'amqp://localhost:5672',
      READER_POLL_INTERVAL_MS: '3000',
    };

    beforeEach(() => { process.env = { ...originalEnv, ...valid }; });

    afterEach(() => {
      delete require.cache[require.resolve('../dist/src/config.js')];
      process.env = originalEnv;
    });

    const load = () => {
      delete require.cache[require.resolve('../dist/src/config.js')];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../dist/src/config.js').loadConfig();
    };

    it('parses collection whitelist', () => {
      process.env.READER_COLLECTIONS = 'trades,orderBookL2,instrument';
      expect(load().collections).toEqual(['trades', 'orderBookL2', 'instrument']);
    });

    it('returns empty array for empty collection whitelist', () => {
      process.env.READER_COLLECTIONS = '';
      expect(load().collections).toEqual([]);
    });

    it('trims whitespace in collection names', () => {
      process.env.READER_COLLECTIONS = '  trades  ,  orderBookL2  ';
      expect(load().collections).toEqual(['trades', 'orderBookL2']);
    });

    it('defaults maxReady to 0', () => {
      expect(load().maxReady).toBe(0);
    });

    it('parses READER_MAX_READY', () => {
      process.env.READER_MAX_READY = '500000';
      expect(load().maxReady).toBe(500_000);
    });

    it('accepts READER_MAX_READY=0 to disable backpressure', () => {
      process.env.READER_MAX_READY = '0';
      expect(load().maxReady).toBe(0);
    });
  });

  // ── Collection Discovery ───────────────────────────────────────────────────

  describe('Collection Discovery', () => {
    const COLL_A = 'disc_test_a';
    const COLL_B = 'disc_test_b';

    beforeEach(async () => {
      await db.collection(COLL_A).insertOne({ x: 1 });
      await db.collection(COLL_B).insertOne({ x: 1 });
    });

    afterEach(async () => {
      await db.collection(COLL_A).drop().catch(() => {});
      await db.collection(COLL_B).drop().catch(() => {});
    });

    it('returns all non-system collections when whitelist is empty', async () => {
      const result = await getCollectionsToProcess(db, []);
      expect(result).toContain(COLL_A);
      expect(result).toContain(COLL_B);
    });

    it('excludes collections whose names start with _', async () => {
      const result = await getCollectionsToProcess(db, []);
      expect(result.every((n) => ! n.startsWith('_'))).toBe(true);
    });

    it('returns only whitelisted collections when whitelist is given', async () => {
      const result = await getCollectionsToProcess(db, [COLL_A]);
      expect(result).toEqual([COLL_A]);
    });
  });

  // ── State Serialization ────────────────────────────────────────────────────

  describe('State Serialization', () => {
    it('serialises Map to persisted format', () => {
      const states: Map<string, any> = new Map([
        ['trade', { collectionName: 'trade', bufferedIds: new Set(['1', '2', '3']), lastHighId: '3' }],
        ['quote', { collectionName: 'quote', bufferedIds: new Set(['10']), lastHighId: '10' }],
      ]);

      const result = collectionsStateToPersisted(states);

      expect(result.orderedIds.trade.lastHighId).toBe('3');
      expect(result.orderedIds.trade.bufferedIds).toEqual(expect.arrayContaining(['1', '2', '3']));
      expect(result.orderedIds.quote.lastHighId).toBe('10');
    });

    it('serialises null lastHighId as null', () => {
      const states: Map<string, any> = new Map([
        ['trade', { collectionName: 'trade', bufferedIds: new Set<string>(), lastHighId: null }],
      ]);

      expect(collectionsStateToPersisted(states).orderedIds.trade.lastHighId).toBeNull();
    });

    it('restores state from persisted format', () => {
      collectionStates.clear();

      restoreCollectionStatesFromPersisted({
        timestamp: new Date(),
        orderedIds: {
          trade: { bufferedIds: ['1', '2', '3'], lastHighId: '3' },
          quote: { bufferedIds: ['10'], lastHighId: '10' },
        },
      });

      expect(collectionStates.get('trade')!.lastHighId).toBe('3');
      expect(collectionStates.get('trade')!.bufferedIds.has('2')).toBe(true);
      expect(collectionStates.get('quote')!.lastHighId).toBe('10');
    });

    it('round-trips: serialise → restore recovers exact values', () => {
      const before: Map<string, any> = new Map([
        ['orderBookL2', { collectionName: 'orderBookL2', bufferedIds: new Set(['100', '200']), lastHighId: '200' }],
      ]);

      collectionStates.clear();
      restoreCollectionStatesFromPersisted(collectionsStateToPersisted(before));

      const state = collectionStates.get('orderBookL2')!;
      expect(state.lastHighId).toBe('200');
      expect(state.bufferedIds.has('100')).toBe(true);
      expect(state.bufferedIds.has('200')).toBe(true);
    });

    it('is a no-op when there are no orderedIds', () => {
      collectionStates.clear();
      restoreCollectionStatesFromPersisted({ timestamp: new Date(), orderedIds: {} });
      expect(collectionStates.size).toBe(0);
    });
  });

  // ── State Persistence (MongoDB round-trip) ─────────────────────────────────

  describe('State Persistence', () => {
    beforeEach(async () => {
      await db.collection('_reader_state').deleteMany({});
      collectionStates.clear();
    });

    it('returns empty orderedIds when no persisted state exists', async () => {
      const state = await getPersistedPollingState(db);
      expect(state.orderedIds).toEqual({});
    });

    it('saves and reads back persisted state', async () => {
      await updatePersistedPollingState(db, {
        _id: 'reader-state',
        timestamp: new Date(),
        orderedIds: { trade: { bufferedIds: ['5', '6'], lastHighId: '6' } },
      });

      const loaded = await getPersistedPollingState(db);
      expect(loaded.orderedIds.trade.lastHighId).toBe('6');
      expect(loaded.orderedIds.trade.bufferedIds).toContain('5');
    });

    it('overwrites existing state on subsequent updates', async () => {
      await updatePersistedPollingState(db, { _id: 'reader-state', timestamp: new Date(), orderedIds: { trade: { bufferedIds: ['1'], lastHighId: '1' } } });
      await updatePersistedPollingState(db, { _id: 'reader-state', timestamp: new Date(), orderedIds: { trade: { bufferedIds: ['1', '2'], lastHighId: '2' } } });

      const loaded = await getPersistedPollingState(db);
      expect(loaded.orderedIds.trade.lastHighId).toBe('2');
    });

    it('savePollingState persists in-memory state; loadPollingState restores it', async () => {
      collectionStates.set('instrument', {
        collectionName: 'instrument',
        bufferedIds: new Set(['42']),
        lastHighId: '42',
      });

      await savePollingState(db);
      collectionStates.clear();
      await loadPollingState(db);

      expect(collectionStates.has('instrument')).toBe(true);
      expect(collectionStates.get('instrument')!.lastHighId).toBe('42');
    });
  });

  // ── processCollection ──────────────────────────────────────────────────────

  describe('processCollection', () => {
    const COLL = 'poll_test';

    beforeEach(async () => {
      collectionStates.clear();
      await db.collection(COLL).drop().catch(() => {});
    });

    afterEach(async () => {
      await db.collection(COLL).drop().catch(() => {});
    });

    it('does nothing when the collection is empty', async () => {
      await db.createCollection(COLL);
      const published: unknown[] = [];

      await processCollection(db, COLL, async (_id, doc) => { published.push(doc); });

      expect(published).toHaveLength(0);
    });

    it('publishes all documents on first run', async () => {
      await db.collection(COLL).insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }] as any[]);
      const published: unknown[] = [];

      await processCollection(db, COLL, async (_id, doc) => { published.push(doc); });

      expect(published).toHaveLength(3);
    });

    it('publishes nothing when there are no new documents since last poll', async () => {
      await db.collection(COLL).insertMany([{ _id: 1 }, { _id: 2 }] as any[]);

      await processCollection(db, COLL, async () => {}); // first poll — establishes boundary

      const published: unknown[] = [];
      await processCollection(db, COLL, async (_id, doc) => { published.push(doc); });

      expect(published).toHaveLength(0);
    });

    it('publishes only new documents on subsequent polls', async () => {
      await db.collection(COLL).insertMany([{ _id: 1 }, { _id: 2 }] as any[]);
      await processCollection(db, COLL, async () => {});

      await db.collection(COLL).insertMany([{ _id: 3 }, { _id: 4 }] as any[]);

      const published: any[] = [];
      await processCollection(db, COLL, async (_id, doc) => { published.push(doc); });

      expect(published).toHaveLength(2);
      expect(published.map((d) => d._id)).toEqual(expect.arrayContaining([3, 4]));
    });

    it('updates in-memory state with the new high id after processing', async () => {
      await db.collection(COLL).insertMany([{ _id: 10 }, { _id: 20 }] as any[]);

      await processCollection(db, COLL);

      const state = collectionStates.get(COLL)!;
      expect(state).toBeDefined();
      expect(String(state.lastHighId)).toBe('20');
      expect(state.bufferedIds.size).toBeGreaterThan(0);
    });

    it('updates lastHighId incrementally during first-run scan (regression: toArray OOM on large collections)', async () => {
      const docs = Array.from({ length: 50 }, (_, i) => ({ _id: i + 1 }));
      await db.collection(COLL).insertMany(docs as any[]);

      const stateSnapshots: (string | null)[] = [];

      await processCollection(db, COLL, async (_id, _doc) => {
        const state = collectionStates.get(COLL);
        stateSnapshots.push(state?.lastHighId != null ? String(state.lastHighId) : null);
      });

      // With cursor-based streaming, lastHighId is updated after each
      // onPublish call. During onPublish for doc N, lastHighId = (N-1)'s _id.
      // The first publish sees null (fresh state).
      //
      // If the old toArray() code were still in use, ALL snapshots would be
      // null because lastHighId was only assigned after the entire loop.
      expect(stateSnapshots).toHaveLength(50);
      expect(stateSnapshots[0]).toBeNull();
      expect(stateSnapshots[1]).toBe('1');
      expect(stateSnapshots[49]).toBe('49');

      // Final state has the collection's actual high id
      expect(String(collectionStates.get(COLL)!.lastHighId)).toBe('50');
    });

    it('handles multiple successive polls with growing data correctly', async () => {
      const ids: number[] = [];
      const collect = async (_id: string, doc: any) => { ids.push(doc._id); };

      await db.collection(COLL).insertMany([{ _id: 1 }, { _id: 2 }] as any[]);
      await processCollection(db, COLL, collect);
      expect(ids).toEqual(expect.arrayContaining([1, 2]));

      ids.length = 0;
      await db.collection(COLL).insertOne({ _id: 3 } as any);
      await processCollection(db, COLL, collect);
      expect(ids).toEqual([3]);

      ids.length = 0;
      await processCollection(db, COLL, collect); // no new docs
      expect(ids).toHaveLength(0);
    });
  });
});
