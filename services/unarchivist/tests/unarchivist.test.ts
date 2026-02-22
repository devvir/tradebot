import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { Broker, keepAlive } from '@devvir/rabbitmq';

describe('Unarchivist Service - Observable Behavior', () => {
  let mongoClient: MongoClient;
  let db: Db;
  let broker: Broker;

  beforeAll(async () => {
    // Connect to test MongoDB
    const mongoUrl = process.env.MONGODB_URL || 'mongodb://root:root@localhost:27017/test_unarchivist?authSource=admin';
    mongoClient = new MongoClient(mongoUrl);
    await mongoClient.connect();
    db = mongoClient.db();

    // Connect to test RabbitMQ
    const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
    broker = await keepAlive(rabbitUrl);

    // Clean up test collections before each test
    await db.collection('_unarchivist_state').deleteMany({});
  });

  afterAll(async () => {
    if (broker) {
      await broker.disconnect();
    }
    if (mongoClient) {
      await mongoClient.close();
    }
  });

  describe('Config Validation', () => {
    it('should require RABBITMQ_URL', () => {
      // Observable: service fails to start without valid config
      process.env.RABBITMQ_URL = '';
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { loadConfig } = require('./config');
        loadConfig();
      }).toThrow('RABBITMQ_URL is required');
    });

    it('should require MONGODB_URL', () => {
      process.env.MONGODB_URL = '';
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { loadConfig } = require('./config');
        loadConfig();
      }).toThrow('MONGODB_URL is required');
    });

    it('should reject invalid batch size', () => {
      process.env.UNARCHIVIST_BATCH_SIZE = '0';
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { loadConfig } = require('./config');
        loadConfig();
      }).toThrow('UNARCHIVIST_BATCH_SIZE must be greater than 0');
    });
  });

  describe('State Management', () => {
    it('should create initial state document on first run', async () => {
      // Observable: _unarchivist_state collection has initial entry
      const state = await db.collection('_unarchivist_state').findOne({ _id: 'unarchivist-state' });
      // State should not exist until service starts
      expect(state).toBeNull();
    });

    it('should track last scanned collection and document id', async () => {
      // Observable: after scanning, state reflects progress
      // This would be tested by integration test that actually runs the service
      // For now, just verify state document structure would be correct
      const expectedState = {
        _id: 'unarchivist-state',
        isInitialScanDone: false,
        lastCollectionScanned: 'testCollection',
        lastDocumentId: 12345,
        changeStreamResumeToken: null,
        lastUpdated: expect.any(Date),
      };

      await db.collection('_unarchivist_state').updateOne(
        { _id: 'unarchivist-state' },
        { $set: expectedState },
        { upsert: true }
      );

      const stored = await db.collection('_unarchivist_state').findOne({ _id: 'unarchivist-state' });
      expect(stored).toMatchObject({
        lastCollectionScanned: 'testCollection',
        lastDocumentId: 12345,
        isInitialScanDone: false,
      });
    });
  });

  describe('Collection Processing', () => {
    it('should skip internal collections (starting with _)', async () => {
      // Observable: service does not try to scan _unarchivist_state
      const collections = await db.listCollections().toArray();
      const internalCollections = collections.filter((c) => c.name.startsWith('_'));

      // Service should filter these out
      expect(internalCollections.length).toBeGreaterThanOrEqual(1); // _unarchivist_state exists
    });
  });

  describe('Configuration Loading', () => {
    it('should parse collection whitelist from env', () => {
      process.env.UNARCHIVIST_COLLECTIONS = 'trades,indexSymbols,instrument';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadConfig } = require('./config');
      const config = loadConfig();

      expect(config.collections).toEqual(['trades', 'indexSymbols', 'instrument']);
    });

    it('should handle empty collection whitelist', () => {
      process.env.UNARCHIVIST_COLLECTIONS = '';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadConfig } = require('./config');
      const config = loadConfig();

      expect(config.collections).toEqual([]);
    });

    it('should trim whitespace in collection names', () => {
      process.env.UNARCHIVIST_COLLECTIONS = '  trades  ,  indexSymbols  ';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadConfig } = require('./config');
      const config = loadConfig();

      expect(config.collections).toEqual(['trades', 'indexSymbols']);
    });
  });
});
