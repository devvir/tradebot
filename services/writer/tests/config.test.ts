import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, validateConfig } from '../src/config';

describe('Writer Config utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      RABBITMQ_URL: 'amqp://guest:guest@rabbitmq:5672',
      MONGODB_URL: 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin',
      WRITER_PREFETCH: '100',
      WRITER_FLUSH_INTERVAL_MS: '50',
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
      expect(loadConfig().prefetch).toBe(250);
    });

    it('should parse WRITER_FLUSH_INTERVAL_MS correctly', () => {
      process.env.WRITER_FLUSH_INTERVAL_MS = '100';
      expect(loadConfig().flushIntervalMs).toBe(100);
    });

    it('should throw when RABBITMQ_URL is missing', () => {
      delete process.env.RABBITMQ_URL;
      expect(() => loadConfig()).toThrow('RABBITMQ_URL is required');
    });

    it('should throw when MONGODB_URL is missing', () => {
      delete process.env.MONGODB_URL;
      expect(() => loadConfig()).toThrow('MONGODB_URL is required');
    });

    it('should use default WRITER_PREFETCH of 500 when not set', () => {
      delete process.env.WRITER_PREFETCH;
      expect(loadConfig().prefetch).toBe(500);
    });

    it('should use default WRITER_FLUSH_INTERVAL_MS of 50 when not set', () => {
      delete process.env.WRITER_FLUSH_INTERVAL_MS;
      expect(loadConfig().flushIntervalMs).toBe(50);
    });
  });

  describe('validateConfig', () => {
    let config: ReturnType<typeof loadConfig>;

    beforeEach(() => {
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

    it('should throw if prefetch is lower than 50', () => {
      config.prefetch = 0;
      expect(() => validateConfig(config)).toThrow('WRITER_PREFETCH must be greater than 50');

      config.prefetch = -1;
      expect(() => validateConfig(config)).toThrow('WRITER_PREFETCH must be greater than 50');
    });

    it('should throw if flushIntervalMs is lower than 20', () => {
      config.flushIntervalMs = 0;
      expect(() => validateConfig(config)).toThrow('WRITER_FLUSH_INTERVAL_MS must be greater than 20');
    });
  });
});
