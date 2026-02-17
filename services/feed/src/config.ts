import logger from './logger';
import type { Config, FeedRole } from './types';
export type { Config, FeedRole } from './types';

const BITMEX_WS_URLS = {
  live: 'wss://www.bitmex.com/realtime',
  testnet: 'wss://testnet.bitmex.com/realtime',
};

export const usesTestnet = () => [undefined, '', '1', 'on', 'true'].includes(
  process.env.BITMEX_TESTNET?.toLowerCase()
);

/**
 * Channels each role is allowed to handle.
 * Used to pre-filter the env-provided channel list per role.
 */
const ROLE_CHANNELS: Record<Exclude<FeedRole, 'NONE'>, string[]> = {
  GLOBAL: ['insurance', 'announcement', 'chat', 'publicNotifications', 'connected', 'instrument'],
  LOW_VOLUME_1: ['quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d'],
  LOW_VOLUME_2: ['tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d'],
  LOW_VOLUME_3: ['liquidation', 'funding', 'settlement'],
  HIGH_VOLUME: ['orderBookL2', 'quote', 'trade'],
  BITCOIN: ['orderBookL2', 'quote', 'trade'],
};

/**
 * Pre-filter resolved channels to only those this role handles.
 * NONE role handles any and all channels.
 */
export const filterChannelsByRole = (channels: string[], role: FeedRole): string[] => {
  if (role === 'NONE') return channels;
  return channels.filter((ch) => ROLE_CHANNELS[role].includes(ch));
};

/**
 * Pre-filter resolved symbols by role (if role !== 'NONE').
 */
export const filterSymbolsByRole = (symbols: string[], role: FeedRole): string[] => {
  switch (role) {
    case 'HIGH_VOLUME':
      return symbols.filter((s) => ! s.startsWith('XBT'));
    case 'BITCOIN':
      return symbols.filter((s) => s.startsWith('XBT'));
    default:
      return symbols;
  }
};

export const loadConfig = (): Config => {
  const env = usesTestnet() ? 'testnet' : 'live';
  const bitmexWsUrl = BITMEX_WS_URLS[env] || BITMEX_WS_URLS.live;
  const role = (process.env.FEED_ROLE || 'GLOBAL').toUpperCase() as FeedRole;

  logger.info(`BitMEX WebSocket: ${bitmexWsUrl}`);

  return {
    bitmexWsUrl,
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672',
    role,
    channels: process.env.FEED_CHANNELS?.split(',') || [],
    channelPatterns: [],
    symbols: process.env.FEED_SYMBOLS?.split(',') || [],
    symbolPatterns: [],
    healthPort: 3000,
    reconnectDelayMs: parseInt(process.env.FEED_RECONNECT_DELAY_MS || '5000', 10),
    maxReconnectDelayMs: parseInt(process.env.FEED_MAX_RECONNECT_DELAY_MS || '60000', 10),
    messageTtlMs: parseInt(process.env.FEED_MESSAGE_TTL || '1800000', 10),
    batchSizeChannels: 10,
    batchDelayMs: 3000,
  };
};

export const validateConfig = (config: Config): void => {
  if (! config.bitmexWsUrl) {
    throw new Error('Failed to determine BitMEX WebSocket URL');
  }
  if (! config.rabbitmqUrl) {
    throw new Error('RABBITMQ_URL is required');
  }

  logger.info({ config }, 'Configuration validated');
};
