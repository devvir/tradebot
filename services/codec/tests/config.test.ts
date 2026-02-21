import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('RabbitMQ URL', () => {
    it('should use default when RABBITMQ_URL not set', () => {
      delete process.env.RABBITMQ_URL;
      const config = loadConfig();
      expect(config.rabbitmqUrl).toBe('amqp://guest:guest@rabbitmq:5672');
    });

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
});


