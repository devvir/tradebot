import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { Broker, keepAlive } from '@devvir/rabbitmq';

// Test infrastructure config — must match .env.testing values
const TEST_CONFIG = {
  MONGODB_USER: 'root',
  MONGODB_PASS: 'root',
  MONGODB_HOST: 'localhost',
  MONGODB_PORT: 27027,
  RABBITMQ_USER: 'guest',
  RABBITMQ_PASS: 'guest',
  RABBITMQ_AMQP_PORT: 56729,
};

describe('Unarchivist Service - Observable Behavior', () => {
  let mongoClient: MongoClient;
  let db: Db;
  let broker: Broker;
  const originalEnv = process.env;

  beforeAll(async () => {
    const mongoUrl = `mongodb://${TEST_CONFIG.MONGODB_USER}:${TEST_CONFIG.MONGODB_PASS}@${TEST_CONFIG.MONGODB_HOST}:${TEST_CONFIG.MONGODB_PORT}/test_unarchivist?authSource=admin`;
    const rabbitUrl = `amqp://${TEST_CONFIG.RABBITMQ_USER}:${TEST_CONFIG.RABBITMQ_PASS}@localhost:${TEST_CONFIG.RABBITMQ_AMQP_PORT}`;

    mongoClient = new MongoClient(mongoUrl);
    await mongoClient.connect();
    db = mongoClient.db();

    broker = await keepAlive(rabbitUrl);

    await db.collection('_unarchivist_state').deleteMany({});
  });

  afterAll(async () => {
    if (broker) {
      await broker.disconnect();
    }
    if (mongoClient) {
      await mongoClient.close();
    }
    process.env = originalEnv;
  });

  describe('Config Validation', () => {
    beforeEach(() => {
      process.env = {
        ...originalEnv,
        MONGODB_URL: 'mongodb://localhost:27017/test',
        RABBITMQ_URL: 'amqp://localhost:5672',
        UNARCHIVIST_EXCHANGE: 'ex.unarchivist',
        UNARCHIVIST_QUEUE: 'q.unarchivist',
        UNARCHIVIST_BATCH_SIZE: '100',
        UNARCHIVIST_POLL_INTERVAL_MS: '3000',
      };
    });

    afterEach(() => {
      // Clear require cache and reset environment variables
      delete require.cache[require.resolve('../dist/src/config.js')];
      process.env = originalEnv;
    });

    it('should reject invalid batch size', () => {
      delete require.cache[require.resolve('../dist/src/config.js')];

      expect(() => {
        process.env.UNARCHIVIST_BATCH_SIZE = '0';
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { loadConfig } = require('../dist/src/config.js');
        loadConfig();
      }).toThrow('UNARCHIVIST_BATCH_SIZE must be a positive number');
    });
  });



  describe('Configuration Loading', () => {
    beforeEach(() => {
      process.env = {
        ...originalEnv,
        MONGODB_URL: 'mongodb://localhost:27017/test',
        RABBITMQ_URL: 'amqp://localhost:5672',
        UNARCHIVIST_EXCHANGE: 'ex.unarchivist',
        UNARCHIVIST_QUEUE: 'q.unarchivist',
        UNARCHIVIST_BATCH_SIZE: '100',
        UNARCHIVIST_POLL_INTERVAL_MS: '3000',
      };
    });

    afterEach(() => {
      // Clear require cache and reset environment variables
      delete require.cache[require.resolve('../dist/src/config.js')];
      process.env = originalEnv;
    });

    it('should parse collection whitelist from env', () => {
      process.env.UNARCHIVIST_COLLECTIONS = 'trades,indexSymbols,instrument';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadConfig } = require('../dist/src/config.js');
      const config = loadConfig();

      expect(config.collections).toEqual(['trades', 'indexSymbols', 'instrument']);
    });

    it('should handle empty collection whitelist', () => {
      delete require.cache[require.resolve('../dist/src/config.js')];
      process.env.UNARCHIVIST_COLLECTIONS = '';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadConfig } = require('../dist/src/config.js');
      const config = loadConfig();

      expect(config.collections).toEqual([]);
    });

    it('should trim whitespace in collection names', () => {
      delete require.cache[require.resolve('../dist/src/config.js')];
      process.env.UNARCHIVIST_COLLECTIONS = '  trades  ,  indexSymbols  ';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadConfig } = require('../dist/src/config.js');
      const config = loadConfig();

      expect(config.collections).toEqual(['trades', 'indexSymbols']);
    });
  });
});
