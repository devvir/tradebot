import { randomUUID } from 'crypto';
import { logger } from '@devvir/service-kit';
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

const REALTIME_PRIMARY_CHANNELS = [
  'instrument',
  'orderBookL2',
  'quote',
  'trade',
] as const;

const REALTIME_SECONDARY_CHANNELS = [
  'liquidation',
  'settlement',
  'funding',
  'insurance',
] as const;

const REALTIME_REDUNDANT_CHANNELS = [
  'orderBookL2_25',
  'orderBook10',
  'quoteBin1m',
  'quoteBin5m',
  'quoteBin1h',
  'quoteBin1d',
  'tradeBin1m',
  'tradeBin5m',
  'tradeBin1h',
  'tradeBin1d',
] as const;

const REALTIME_CHANNELS = [
  ...REALTIME_PRIMARY_CHANNELS,
  ...REALTIME_SECONDARY_CHANNELS,
  ...REALTIME_REDUNDANT_CHANNELS,
] as const;

const PLATFORM_CHANNELS = [
  'announcement',
  'chat',
  'connected',
  'publicNotifications',
] as const;

const REALTIME_CHANNEL_PRESETS = {
  feed: REALTIME_CHANNELS,
  primary: REALTIME_PRIMARY_CHANNELS,
  secondary: REALTIME_SECONDARY_CHANNELS,
  redundant: REALTIME_REDUNDANT_CHANNELS,
  archive: [ ...REALTIME_PRIMARY_CHANNELS, ...REALTIME_SECONDARY_CHANNELS ],
} as const;

type RealtimeChannelPreset = keyof typeof REALTIME_CHANNEL_PRESETS;

export const loadConfig = (): Config => {
  const bitmexEnv = usesTestnet() ? 'testnet' : 'live';
  const preset = (process.env.BROADCAST_FEED_PRESET ?? 'feed') as RealtimeChannelPreset;

  const config: Config = {
    env: bitmexEnv,
    workerUuid: randomUUID(),
    realtimeWsUrl: BITMEX_WS_URLS.realtime[bitmexEnv],
    platformWsUrl: BITMEX_WS_URLS.platform[bitmexEnv],
    realtimePreset: preset,
    realtimeChannels: REALTIME_CHANNEL_PRESETS[preset],
    platformChannels: PLATFORM_CHANNELS,
    queue: {
      rabbitmqUrl: sanitizeUrl(process.env.QUEUE_URL || ''),
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
  if (! config.queue.rabbitmqUrl) throw new Error('QUEUE_URL is required');
  if (config.queue.messageTtlMs < 100) throw new Error('BROADCAST_MESSAGE_TTL must be at least 100ms');
  if (config.connection.reconnectDelayMs < 100) throw new Error('BROADCAST_RECONNECT_DELAY_MS must be at least 100ms');
  if (config.connection.maxReconnectDelayMs < 1000) throw new Error('BROADCAST_MAX_RECONNECT_DELAY_MS must be at least 1000ms');
};

const usesTestnet = () => [undefined, '', '1', 'on', 'true'].includes(
  process.env.BITMEX_TESTNET?.toLowerCase()
);

export default loadConfig();
