// Pending Review
import logger from './logger';

export interface Config {
  bitmexWsUrl: string;
  rabbitmqUrl: string;
  channels: string[];
  channelPatterns: string[];
  symbols: string[];
  symbolPatterns: string[];
  healthPort: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
  messageTtlMs: number;
}

const BITMEX_WS_URLS = {
  live: 'wss://www.bitmex.com/realtime',
  testnet: 'wss://testnet.bitmex.com/realtime',
};

export const usesTestnet = () => [undefined, '', '1', 'on', 'true'].includes(
  process.env.BITMEX_TESTNET?.toLowerCase()
)

export const loadConfig = (): Config => {
  const env = usesTestnet() ? 'testnet' : 'live';
  const bitmexWsUrl = BITMEX_WS_URLS[env] || BITMEX_WS_URLS.live;

  logger.info(`BitMEX WebSocket: ${bitmexWsUrl}`);

  return {
    bitmexWsUrl,
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
    channels: (process.env.FEED_CHANNELS || 'trade,orderBookL2_25').split(','),
    channelPatterns: [],
    symbols: (process.env.FEED_SYMBOLS || 'XBTUSD').split(','),
    symbolPatterns: [],
    healthPort: 3000,
    reconnectDelayMs: parseInt(process.env.FEED_RECONNECT_DELAY_MS || '5000', 10),
    maxReconnectDelayMs: parseInt(process.env.FEED_MAX_RECONNECT_DELAY_MS || '60000', 10),
    messageTtlMs: parseInt(process.env.FEED_MESSAGE_TTL || '1800000', 10),
  };
};

export const validateConfig = (config: Config): void => {
  if (! config.bitmexWsUrl) {
    throw new Error('Failed to determine BitMEX WebSocket URL');
  }
  if (! config.rabbitmqUrl) {
    throw new Error('RABBITMQ_URL is required');
  }
  if (config.channelPatterns.length === 0) {
    throw new Error('At least one channel pattern must be configured');
  }
  if (config.symbolPatterns.length === 0) {
    throw new Error('At least one symbol pattern must be configured');
  }
  logger.info({ config }, 'Configuration validated');
};
