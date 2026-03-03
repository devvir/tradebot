// Pending Review
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, validateConfig } from '../src/config';

describe('Writer Config utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Set required env vars for all tests
      RABBITMQ_URL: 'amqp://guest:guest@rabbitmq:5672',
      MONGODB_URL: 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin',
      WRITER_PREFETCH: '100',
      WRITER_BATCH_SIZE: '100',
      WRITER_FLUSH_INTERVAL_MS: '50',
      DATABASE_COLLECT: 'tradebot_collect',
      DATABASE_ARCHIVE: 'tradebot_archive',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load config from environment variables', () => {
      process.env.RABBITMQ_URL = 'amqp://test:pass@localhost:5672';
      process.env.MONGODB_URL = 'mongodb://user:pass@localhost:27017/testdb';
      process.env.WRITER_PREFETCH = '50';

      const config = loadConfig();

      expect(config.rabbitmqUrl).toBe('amqp://test:pass@localhost:5672');
      expect(config.mongodbUrl).toBe('mongodb://user:pass@localhost:27017/testdb');
      expect(config.prefetch).toBe(50);
    });

    it('should parse WRITER_PREFETCH correctly', () => {
      process.env.WRITER_PREFETCH = '250';

      const config = loadConfig();

      expect(config.prefetch).toBe(250);
    });

    it('should throw when WRITER_BATCH_SIZE is missing', () => {
      delete process.env.WRITER_BATCH_SIZE;
      expect(() => loadConfig()).toThrow('WRITER_BATCH_SIZE must be a positive number');
    });

    it('should parse WRITER_BATCH_SIZE correctly', () => {
      process.env.WRITER_BATCH_SIZE = '50';
      const config = loadConfig();
      expect(config.insertBatchSize).toBe(50);
    });

    it('should throw when WRITER_FLUSH_INTERVAL_MS is missing', () => {
      delete process.env.WRITER_FLUSH_INTERVAL_MS;
      expect(() => loadConfig()).toThrow('WRITER_FLUSH_INTERVAL_MS must be a positive number');
    });

    it('should parse WRITER_FLUSH_INTERVAL_MS correctly', () => {
      process.env.WRITER_FLUSH_INTERVAL_MS = '100';
      const config = loadConfig();
      expect(config.flushIntervalMs).toBe(100);
    });

    it('should throw when RABBITMQ_URL is missing', () => {
      delete process.env.RABBITMQ_URL;
      expect(() => loadConfig()).toThrow('RABBITMQ_URL is required');
    });

    it('should throw when MONGODB_URL is missing', () => {
      delete process.env.MONGODB_URL;
      expect(() => loadConfig()).toThrow('MONGODB_URL is required');
    });

    it('should throw when WRITER_PREFETCH is missing', () => {
      delete process.env.WRITER_PREFETCH;
      expect(() => loadConfig()).toThrow('WRITER_PREFETCH must be a positive number');
    });

    it('should throw when DATABASE_ARCHIVE is missing', () => {
      delete process.env.DATABASE_ARCHIVE;
      expect(() => loadConfig()).toThrow('DATABASE_ARCHIVE is required');
    });

    it('should throw when DATABASE_COLLECT is missing', () => {
      delete process.env.DATABASE_COLLECT;
      expect(() => loadConfig()).toThrow('DATABASE_COLLECT is required');
    });

    it('should use custom dbArchive from DATABASE_ARCHIVE', () => {
      process.env.DATABASE_ARCHIVE = 'my_archive';
      const config = loadConfig();
      expect(config.dbArchive).toBe('my_archive');
    });

    it('should use custom dbCollect from DATABASE_COLLECT', () => {
      process.env.DATABASE_COLLECT = 'my_collect';
      const config = loadConfig();
      expect(config.dbCollect).toBe('my_collect');
    });
  });

  describe('validateConfig', () => {
    let config: ReturnType<typeof loadConfig>;

    beforeEach(() => {
      process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
      process.env.MONGODB_URL = 'mongodb://localhost:27017/testdb';
      process.env.WRITER_PREFETCH = '100';
      process.env.WRITER_BATCH_SIZE = '100';
      process.env.WRITER_FLUSH_INTERVAL_MS = '50';
      process.env.DATABASE_ARCHIVE = 'tradebot_archive';
      process.env.DATABASE_COLLECT = 'tradebot_collect';
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

    it('should throw if dbArchive is empty', () => {
      config.dbArchive = '';
      expect(() => validateConfig(config)).toThrow('DATABASE_ARCHIVE is required');
    });

    it('should throw if dbCollect is empty', () => {
      config.dbCollect = '';
      expect(() => validateConfig(config)).toThrow('DATABASE_COLLECT is required');
    });

    it('should throw if prefetch is 0 or negative', () => {
      config.prefetch = 0;
      expect(() => validateConfig(config)).toThrow('WRITER_PREFETCH must be a positive number');

      config.prefetch = -1;
      expect(() => validateConfig(config)).toThrow('WRITER_PREFETCH must be a positive number');
    });

    it('should throw if insertBatchSize is 0 or negative', () => {
      config.insertBatchSize = 0;
      expect(() => validateConfig(config)).toThrow('WRITER_BATCH_SIZE must be a positive number');
    });

    it('should throw if flushIntervalMs is 0 or negative', () => {
      config.flushIntervalMs = 0;
      expect(() => validateConfig(config)).toThrow('WRITER_FLUSH_INTERVAL_MS must be a positive number');
    });
  });
});
