import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
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
      rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || ''),
      messageTtlMs: parseInt(process.env.BROADCAST_MESSAGE_TTL || '0'),
    },
    connection: {
      reconnectDelayMs: parseInt(process.env.BROADCAST_RECONNECT_DELAY_MS || '0'),
      maxReconnectDelayMs: parseInt(process.env.BROADCAST_MAX_RECONNECT_DELAY_MS || '0'),
    },
  };

  validateConfig(config);

  logger.info({ ...config, queue: {
    ...config.queue,
    rabbitmqUrl: redactUrl(config.queue.rabbitmqUrl),
  } }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.realtimeWsUrl) throw new Error('Failed to determine BitMEX realtime WS URL');
  if (! config.queue.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (config.queue.messageTtlMs <= 0) throw new Error('BROADCAST_MESSAGE_TTL must be a positive number');
  if (config.connection.reconnectDelayMs <= 0) throw new Error('BROADCAST_RECONNECT_DELAY_MS must be a positive number');
  if (config.connection.maxReconnectDelayMs <= 0) throw new Error('BROADCAST_MAX_RECONNECT_DELAY_MS must be a positive number');
};

const usesTestnet = () => [undefined, '', '1', 'on', 'true'].includes(
  process.env.BITMEX_TESTNET?.toLowerCase()
);
