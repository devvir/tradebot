import logger from '@tradebot/logger';
import { redactedUrl } from '@tradebot/utils';
import type { Config } from './types';

export const BITMEX_WS_URLS = {
  realtime: {
    live: 'wss://www.bitmex.com/realtime',
    testnet: 'wss://testnet.bitmex.com/realtime',
  },
  platform: {
    live: 'wss://www.bitmex.com/realtimePlatform',
    testnet: 'wss://testnet.bitmex.com/realtimePlatform',
  },
} as const;

/**
 * BitMEX WebSocket Channel Definitions
 * Source: https://www.bitmex.com/app/wsAPI
 */

export const REALTIME_CHANNELS = [
  'instrument',
  'orderBookL2',
  'quote',
  'trade',
  'liquidation',
  'settlement',
  'funding',
  'insurance',
] as const;

export const PLATFORM_CHANNELS = [
  'announcement',
  'chat',
  'connected',
  'publicNotifications',
] as const;

export const loadConfig = (): Config => {
  const bitmexEnv = usesTestnet() ? 'testnet' : 'live';

  const config: Config = {
    env: bitmexEnv,
    realtimeWsUrl: BITMEX_WS_URLS.realtime[bitmexEnv],
    platformWsUrl: BITMEX_WS_URLS.platform[bitmexEnv],
    realtimeChannels: REALTIME_CHANNELS,
    platformChannels: PLATFORM_CHANNELS,
    queue: {
      rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672',
      messageTtlMs: parseInt(process.env.FEED_MESSAGE_TTL || '1800000', 10),
    },
    connection: {
      reconnectDelayMs: parseInt(process.env.FEED_RECONNECT_DELAY_MS || '5000', 10),
      maxReconnectDelayMs: parseInt(process.env.FEED_MAX_RECONNECT_DELAY_MS || '60000', 10),
    },
  };

  validateConfig(config);

  const safeConfig = {
    ...config,
    queue: {
      ...config.queue,
      rabbitmqUrl: redactedUrl(config.queue.rabbitmqUrl),
    },
  };
  logger.info(safeConfig, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.realtimeWsUrl) throw new Error('Failed to determine BitMEX realtime WS URL');
  if (! config.queue.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
};

const usesTestnet = () => [undefined, '', '1', 'on', 'true'].includes(
  process.env.BITMEX_TESTNET?.toLowerCase()
);
