import { vi, describe, beforeEach, afterEach } from 'vitest';
import { loadConfig, validateConfig } from '../src/config';

vi.mock('@tradebot/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

describe('Archivist Config utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
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
      // healthPort is hardcoded to 3000
      expect(config.healthPort).toBe(3000);
    });

    it('should use default values when env vars are not set', () => {
      delete process.env.RABBITMQ_URL;
      delete process.env.MONGODB_URL;
      delete process.env.ARCHIVIST_BATCH_SIZE;
      delete process.env.ARCHIVIST_BATCH_TIMEOUT_MS;
      delete process.env.RABBITMQ_HOST;
      delete process.env.MONGODB_HOST;

      const config = loadConfig();

      // Defaults use service names: 'rabbitmq' and 'mongodb' (not 'localhost')
      expect(config.rabbitmqUrl).toBe('amqp://guest:guest@rabbitmq:5672');
      expect(config.mongodbUrl).toContain('mongodb://');
      expect(config.mongodbUrl).toContain('mongodb');
      expect(config.batchSize).toBe(100);
      expect(config.batchTimeoutMs).toBe(5000);
    });

    it('should parse numeric environment variables correctly', () => {
      process.env.ARCHIVIST_BATCH_SIZE = '250';
      process.env.ARCHIVIST_BATCH_TIMEOUT_MS = '10000';

      const config = loadConfig();

      expect(config.batchSize).toBe(250);
      expect(config.batchTimeoutMs).toBe(10000);
      expect(config.healthPort).toBe(3000);
    });
  });

  describe('validateConfig', () => {
    let config: ReturnType<typeof loadConfig>;

    beforeEach(() => {
      process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
      process.env.MONGODB_URL = 'mongodb://localhost:27017/testdb';
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
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_SIZE must be greater than 0');

      config.batchSize = -1;
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_SIZE must be greater than 0');
    });

    it('should throw if batchTimeoutMs is 0 or negative', () => {
      config.batchTimeoutMs = 0;
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_TIMEOUT_MS must be greater than 0');

      config.batchTimeoutMs = -5000;
      expect(() => validateConfig(config)).toThrow('ARCHIVIST_BATCH_TIMEOUT_MS must be greater than 0');
    });
  });
});
