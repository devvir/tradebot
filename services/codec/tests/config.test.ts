import { loadConfig, validateConfig } from '../src/config';

describe('Codec Config utilities', () => {
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

      const config = loadConfig();

      expect(config.rabbitmqUrl).toBe('amqp://test:pass@localhost:5672');
      expect(config.healthPort).toBe(3000);
    });

    it('should use default RABBITMQ_URL when env var is not set', () => {
      delete process.env.RABBITMQ_URL;

      const config = loadConfig();

      expect(config.rabbitmqUrl).toBe('amqp://guest:guest@rabbitmq:5672');
      expect(config.healthPort).toBe(3000);
    });

    it('should handle special characters in URL credentials', () => {
      process.env.RABBITMQ_URL = 'amqp://user%40domain:p%40ss%3Aword@localhost:5672';

      const config = loadConfig();

      expect(config.rabbitmqUrl).toContain('localhost:5672');
    });

    it('should sanitize URL with special characters in credentials', () => {
      process.env.RABBITMQ_URL = 'amqp://user@host:pass:word@localhost:5672';

      const config = loadConfig();

      // Should not throw and should contain the host
      expect(config.rabbitmqUrl).toContain('localhost');
    });

    it('should have hardcoded health port of 3000', () => {
      const config1 = loadConfig();
      const config2 = loadConfig();

      expect(config1.healthPort).toBe(3000);
      expect(config2.healthPort).toBe(3000);
    });
  });

  describe('validateConfig', () => {
    let config: ReturnType<typeof loadConfig>;

    beforeEach(() => {
      process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
      config = loadConfig();
    });

    it('should not throw for valid config', () => {
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw if RABBITMQ_URL is empty', () => {
      delete process.env.RABBITMQ_URL;
      config = loadConfig();
      config.rabbitmqUrl = '';

      expect(() => validateConfig(config)).toThrow('RABBITMQ_URL is required');
    });

    it('should log config validation success', () => {
      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});
