import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

vi.mock('@tradebot/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('BitMEX endpoint selection', () => {
    it('should use live endpoints when BITMEX_TESTNET is false', () => {
      process.env.BITMEX_TESTNET = 'false';
      const config = loadConfig();
      expect(config.realtimeWsUrl).toBe('wss://www.bitmex.com/realtime');
      expect(config.platformWsUrl).toBe('wss://www.bitmex.com/realtimePlatform');
    });

    it('should use testnet endpoints when BITMEX_TESTNET is true', () => {
      process.env.BITMEX_TESTNET = 'true';
      const config = loadConfig();
      expect(config.realtimeWsUrl).toBe('wss://testnet.bitmex.com/realtime');
      expect(config.platformWsUrl).toBe('wss://testnet.bitmex.com/realtimePlatform');
    });

    it('should default to testnet when BITMEX_TESTNET not set', () => {
      delete process.env.BITMEX_TESTNET;
      const config = loadConfig();
      expect(config.realtimeWsUrl).toBe('wss://testnet.bitmex.com/realtime');
      expect(config.platformWsUrl).toBe('wss://testnet.bitmex.com/realtimePlatform');
    });
  });

  describe('Channel subscriptions', () => {
    it('should include required realtime channels', () => {
      const config = loadConfig();
      expect(config.realtimeChannels).toContain('instrument');
      expect(config.realtimeChannels).toContain('orderBookL2');
      expect(config.realtimeChannels).toContain('quote');
      expect(config.realtimeChannels).toContain('trade');
    });

    it('should include required platform channels', () => {
      const config = loadConfig();
      expect(config.platformChannels).toContain('announcement');
      expect(config.platformChannels).toContain('chat');
      expect(config.platformChannels).toContain('connected');
    });
  });

  describe('Connection settings', () => {
    it('should use default reconnect delay (5000ms)', () => {
      delete process.env.FEED_RECONNECT_DELAY_MS;
      const config = loadConfig();
      expect(config.connection.reconnectDelayMs).toBe(5000);
    });

    it('should parse reconnect delay from env', () => {
      process.env.FEED_RECONNECT_DELAY_MS = '10000';
      const config = loadConfig();
      expect(config.connection.reconnectDelayMs).toBe(10000);
    });

    it('should use default max reconnect delay (60000ms)', () => {
      delete process.env.FEED_MAX_RECONNECT_DELAY_MS;
      const config = loadConfig();
      expect(config.connection.maxReconnectDelayMs).toBe(60000);
    });

    it('should parse max reconnect delay from env', () => {
      process.env.FEED_MAX_RECONNECT_DELAY_MS = '120000';
      const config = loadConfig();
      expect(config.connection.maxReconnectDelayMs).toBe(120000);
    });
  });

  describe('RabbitMQ settings', () => {
    it('should use default RabbitMQ URL', () => {
      delete process.env.RABBITMQ_URL;
      const config = loadConfig();
      expect(config.queue.rabbitmqUrl).toBe('amqp://guest:guest@rabbitmq:5672');
    });

    it('should use custom RabbitMQ URL when provided', () => {
      process.env.RABBITMQ_URL = 'amqp://user:pass@broker:5672';
      const config = loadConfig();
      expect(config.queue.rabbitmqUrl).toBe('amqp://user:pass@broker:5672');
    });

    it('should use default message TTL (1800000ms = 30min)', () => {
      delete process.env.FEED_MESSAGE_TTL;
      const config = loadConfig();
      expect(config.queue.messageTtlMs).toBe(1800000);
    });

    it('should parse message TTL from env', () => {
      process.env.FEED_MESSAGE_TTL = '3600000';
      const config = loadConfig();
      expect(config.queue.messageTtlMs).toBe(3600000);
    });
  });
});
