import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Set required env vars for all tests
      RABBITMQ_URL: 'amqp://guest:guest@rabbitmq:5672',
      FEED_EXCHANGE: 'ex.feed',
      FEED_QUEUE: 'q.feed',
      FEED_MESSAGE_TTL: '1800000',
      FEED_RECONNECT_DELAY_MS: '5000',
      FEED_MAX_RECONNECT_DELAY_MS: '60000',
    };
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
    it('should parse reconnect delay from env', () => {
      process.env.FEED_RECONNECT_DELAY_MS = '10000';
      const config = loadConfig();
      expect(config.connection.reconnectDelayMs).toBe(10000);
    });

    it('should parse max reconnect delay from env', () => {
      process.env.FEED_MAX_RECONNECT_DELAY_MS = '120000';
      const config = loadConfig();
      expect(config.connection.maxReconnectDelayMs).toBe(120000);
    });
  });

  describe('RabbitMQ settings', () => {
    it('should use custom RabbitMQ URL when provided', () => {
      process.env.RABBITMQ_URL = 'amqp://user:pass@broker:5672';
      const config = loadConfig();
      expect(config.queue.rabbitmqUrl).toBe('amqp://user:pass@broker:5672');
    });

    it('should parse message TTL from env', () => {
      process.env.FEED_MESSAGE_TTL = '3600000';
      const config = loadConfig();
      expect(config.queue.messageTtlMs).toBe(3600000);
    });

    it('should require RABBITMQ_URL', () => {
      delete process.env.RABBITMQ_URL;
      expect(() => loadConfig()).toThrow('RABBITMQ_URL is required');
    });

    it('should require FEED_EXCHANGE', () => {
      delete process.env.FEED_EXCHANGE;
      expect(() => loadConfig()).toThrow('FEED_EXCHANGE is required');
    });

    it('should require FEED_QUEUE', () => {
      delete process.env.FEED_QUEUE;
      expect(() => loadConfig()).toThrow('FEED_QUEUE is required');
    });

    it('should require FEED_MESSAGE_TTL as a positive number', () => {
      delete process.env.FEED_MESSAGE_TTL;
      expect(() => loadConfig()).toThrow('FEED_MESSAGE_TTL must be a positive number');
    });

    it('should require FEED_RECONNECT_DELAY_MS as a positive number', () => {
      delete process.env.FEED_RECONNECT_DELAY_MS;
      expect(() => loadConfig()).toThrow('FEED_RECONNECT_DELAY_MS must be a positive number');
    });

    it('should require FEED_MAX_RECONNECT_DELAY_MS as a positive number', () => {
      delete process.env.FEED_MAX_RECONNECT_DELAY_MS;
      expect(() => loadConfig()).toThrow('FEED_MAX_RECONNECT_DELAY_MS must be a positive number');
    });
  });
});
