import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, validateConfig } from '../src/config';

describe('Archivist Config utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Set required env vars for all tests
      RABBITMQ_URL: 'amqp://guest:guest@rabbitmq:5672',
      MONGODB_URL: 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin',
      ARCHIVIST_EXCHANGE: 'ex.archive',
      ARCHIVIST_QUEUE: 'q.archive',
      ARCHIVIST_BATCH_SIZE: '100',
      ARCHIVIST_BATCH_TIMEOUT_MS: '5000',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load config from environment variables', () => {
      process.env.RABBITMQ_URL = 'amqp://test:pass@localhost:5672';
      process.env.MONGODB_URL = 'mongodb://user:pass@localhost:27017/testdb';
      process.env.ARCHIVIST_BATCH_SIZE = '50';
      process.env.ARCHIVIST_BATCH_TIMEOUT_MS = '3000';

      const config = loadConfig();

      expect(config.rabbitmqUrl).toBe('amqp://test:pass@localhost:5672');
      expect(config.mongodbUrl).toBe('mongodb://user:pass@localhost:27017/testdb');
      expect(config.batchSize).toBe(50);
      expect(config.batchTimeoutMs).toBe(3000);
    });

    it('should parse numeric environment variables correctly', () => {
      process.env.ARCHIVIST_BATCH_SIZE = '250';
      process.env.ARCHIVIST_BATCH_TIMEOUT_MS = '10000';

      const config = loadConfig();

      expect(config.batchSize).toBe(250);
      expect(config.batchTimeoutMs).toBe(10000);
    });

    it('should throw when RABBITMQ_URL is missing', () => {
      delete process.env.RABBITMQ_URL;
      expect(() => loadConfig()).toThrow('RABBITMQ_URL is required');
    });

    it('should throw when MONGODB_URL is missing', () => {
      delete process.env.MONGODB_URL;
      expect(() => loadConfig()).toThrow('MONGODB_URL is required');
    });

    it('should throw when ARCHIVIST_EXCHANGE is missing', () => {
      delete process.env.ARCHIVIST_EXCHANGE;
      expect(() => loadConfig()).toThrow('ARCHIVIST_EXCHANGE is required');
    });

    it('should throw when ARCHIVIST_QUEUE is missing', () => {
      delete process.env.ARCHIVIST_QUEUE;
      expect(() => loadConfig()).toThrow('ARCHIVIST_QUEUE is required');
    });

    it('should throw when ARCHIVIST_BATCH_SIZE is missing', () => {
      delete process.env.ARCHIVIST_BATCH_SIZE;
      expect(() => loadConfig()).toThrow('ARCHIVIST_BATCH_SIZE must be a positive number');
    });

    it('should throw when ARCHIVIST_BATCH_TIMEOUT_MS is missing', () => {
      delete process.env.ARCHIVIST_BATCH_TIMEOUT_MS;
      expect(() => loadConfig()).toThrow('ARCHIVIST_BATCH_TIMEOUT_MS must be a positive number');
    });
  });

  describe('validateConfig', () => {
    let config: ReturnType<typeof loadConfig>;

    beforeEach(() => {
      process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
      process.env.MONGODB_URL = 'mongodb://localhost:27017/testdb';
      process.env.ARCHIVIST_EXCHANGE = 'ex.archive';
      process.env.ARCHIVIST_QUEUE = 'q.archive';
      process.env.ARCHIVIST_BATCH_SIZE = '100';
      process.env.ARCHIVIST_BATCH_TIMEOUT_MS = '5000';
      config = loadConfig();
    });

    it('should not throw for valid config', () => {
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw if RABBITMQ_URL is missing', () => {
      config.rabbitmqUrl = '';
      expect(() => validateConfig(config)).toThrow('RABBITMQ_URL is required');
    });

    it('should throw if MONGODB_URL is missing', () => {
      config.mongodbUrl = '';
      expect(() => validateConfig(config)).toThrow('MONGODB_URL is required');
    });

    it('should throw if batchSize is 0 or negative', () => {
      config.batchSize = 0;
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_SIZE must be a positive number');

      config.batchSize = -1;
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_SIZE must be a positive number');
    });

    it('should throw if batchTimeoutMs is 0 or negative', () => {
      config.batchTimeoutMs = 0;
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_TIMEOUT_MS must be a positive number');

      config.batchTimeoutMs = -5000;
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_TIMEOUT_MS must be a positive number');
    });
  });
});
