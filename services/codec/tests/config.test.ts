import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Set required env vars for all tests
      RABBITMQ_URL: 'amqp://guest:guest@rabbitmq:5672',
      CODEC_INBOUND_EXCHANGE: 'ex.feed',
      CODEC_INBOUND_QUEUE: 'q.feed',
      CODEC_OUTBOUND_EXCHANGE: 'ex.archive',
      CODEC_OUTBOUND_QUEUE: 'q.archive',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('RabbitMQ URL', () => {
    it('should use provided RABBITMQ_URL', () => {
      process.env.RABBITMQ_URL = 'amqp://user:pass@broker:5672';
      const config = loadConfig();
      expect(config.rabbitmqUrl).toBe('amqp://user:pass@broker:5672');
    });

    it('should percent-encode special characters in credentials', () => {
      // @ in credentials must be encoded so the host can be parsed correctly
      process.env.RABBITMQ_URL = 'amqp://user%40host:pass@broker:5672';
      const config = loadConfig();
      expect(config.rabbitmqUrl).toContain('broker:5672');
      expect(config.rabbitmqUrl).not.toMatch(/user@host/);
    });
  });

  describe('Exchange and queue configuration', () => {
    it('should require CODEC_INBOUND_EXCHANGE', () => {
      delete process.env.CODEC_INBOUND_EXCHANGE;
      expect(() => loadConfig()).toThrow('CODEC_INBOUND_EXCHANGE is required');
    });

    it('should require CODEC_INBOUND_QUEUE', () => {
      delete process.env.CODEC_INBOUND_QUEUE;
      expect(() => loadConfig()).toThrow('CODEC_INBOUND_QUEUE is required');
    });

    it('should require CODEC_OUTBOUND_EXCHANGE', () => {
      delete process.env.CODEC_OUTBOUND_EXCHANGE;
      expect(() => loadConfig()).toThrow('CODEC_OUTBOUND_EXCHANGE is required');
    });

    it('should require CODEC_OUTBOUND_QUEUE', () => {
      delete process.env.CODEC_OUTBOUND_QUEUE;
      expect(() => loadConfig()).toThrow('CODEC_OUTBOUND_QUEUE is required');
    });
  });
});


