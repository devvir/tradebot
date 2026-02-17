import { loadConfig, validateConfig, usesTestnet } from '../src/config';

describe('Config utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BITMEX_TESTNET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('usesTestnet', () => {
    it('should use testnet by default when BITMEX_TESTNET is not set', () => {
      delete process.env.BITMEX_TESTNET;
      expect(usesTestnet()).toBe(true);
    });

    it('should use testnet when BITMEX_TESTNET is empty string', () => {
      process.env.BITMEX_TESTNET = '';
      expect(usesTestnet()).toBe(true);
    });

    it('should use testnet when BITMEX_TESTNET is "1"', () => {
      process.env.BITMEX_TESTNET = '1';
      expect(usesTestnet()).toBe(true);
    });

    it('should use testnet when BITMEX_TESTNET is "true"', () => {
      process.env.BITMEX_TESTNET = 'true';
      expect(usesTestnet()).toBe(true);
    });

    it('should use testnet when BITMEX_TESTNET is "on"', () => {
      process.env.BITMEX_TESTNET = 'on';
      expect(usesTestnet()).toBe(true);
    });

    it('should use live when BITMEX_TESTNET is "0"', () => {
      process.env.BITMEX_TESTNET = '0';
      expect(usesTestnet()).toBe(false);
    });

    it('should use live when BITMEX_TESTNET is "false"', () => {
      process.env.BITMEX_TESTNET = 'false';
      expect(usesTestnet()).toBe(false);
    });

    it('should use live when BITMEX_TESTNET is "off"', () => {
      process.env.BITMEX_TESTNET = 'off';
      expect(usesTestnet()).toBe(false);
    });
  });

  describe('loadConfig', () => {
    it('should load config from environment variables (live)', () => {
      process.env.BITMEX_TESTNET = '0'; // Force live mode
      process.env.RABBITMQ_URL = 'amqp://test:pass@localhost:5672';
      process.env.FEED_CHANNELS = 'trade,quote';
      process.env.FEED_SYMBOLS = 'XBTUSD,ETHUSD';
      process.env.FEED_PORT = '3001';

      const config = loadConfig();

      expect(config.bitmexWsUrl).toBe('wss://www.bitmex.com/realtime');
      expect(config.rabbitmqUrl).toBe('amqp://test:pass@localhost:5672');
      expect(config.channels).toEqual(['trade', 'quote']);
      expect(config.symbols).toEqual(['XBTUSD', 'ETHUSD']);
      expect(config.healthPort).toBe(3000);
    });

    it('should use testnet URL when BITMEX_TESTNET is enabled', () => {
      process.env.BITMEX_TESTNET = '1';
      const config = loadConfig();
      expect(config.bitmexWsUrl).toBe('wss://testnet.bitmex.com/realtime');
    });

    it('should use testnet URL by default when BITMEX_TESTNET is not set', () => {
      delete process.env.BITMEX_TESTNET;
      const config = loadConfig();
      expect(config.bitmexWsUrl).toBe('wss://testnet.bitmex.com/realtime');
    });

    it('should use default values when env vars are not set', () => {
      process.env.BITMEX_TESTNET = '0'; // Force live mode
      delete process.env.RABBITMQ_URL;
      delete process.env.FEED_CHANNELS;
      delete process.env.FEED_SYMBOLS;

      const config = loadConfig();

      expect(config.bitmexWsUrl).toBe('wss://www.bitmex.com/realtime');
      expect(config.rabbitmqUrl).toBe('amqp://guest:guest@rabbitmq:5672');
      expect(config.channels).toEqual([]);
      expect(config.symbols).toEqual([]);
    });

    it('should parse reconnect delay options', () => {
      process.env.FEED_RECONNECT_DELAY_MS = '2000';
      process.env.FEED_MAX_RECONNECT_DELAY_MS = '30000';

      const config = loadConfig();

      expect(config.reconnectDelayMs).toBe(2000);
      expect(config.maxReconnectDelayMs).toBe(30000);
    });

    it('should parse message TTL', () => {
      process.env.FEED_MESSAGE_TTL = '3600000';

      const config = loadConfig();

      expect(config.messageTtlMs).toBe(3600000);
    });
  });

  describe('validateConfig', () => {
    let config: ReturnType<typeof loadConfig>;

    beforeEach(() => {
      process.env.BITMEX_TESTNET = '0'; // Use live mode for validation tests
      process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
      process.env.FEED_CHANNELS = 'trade';
      process.env.FEED_SYMBOLS = 'XBTUSD';
      config = loadConfig();
      config.channelPatterns = config.channels;
      config.symbolPatterns = config.symbols;
    });

    it('should not throw for valid config', () => {
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw if bitmexWsUrl is missing', () => {
      config.bitmexWsUrl = '';
      expect(() => validateConfig(config)).toThrow('Failed to determine BitMEX WebSocket URL');
    });

    it('should throw if RABBITMQ_URL is missing', () => {
      config.rabbitmqUrl = '';
      expect(() => validateConfig(config)).toThrow('RABBITMQ_URL is required');
    });

    it('should not require channel patterns to be configured', () => {
      config.channelPatterns = [];
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should not require symbol patterns to be configured', () => {
      config.symbolPatterns = [];
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept wildcard patterns', () => {
      config.channelPatterns = ['*'];
      config.symbolPatterns = ['*'];
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept glob patterns', () => {
      config.channelPatterns = ['trade', 'quote*'];
      config.symbolPatterns = ['XBT*', 'ETH*'];
      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});
