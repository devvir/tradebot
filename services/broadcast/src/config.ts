import { randomUUID } from 'crypto';
import { logger } from '@devvir/service-kit';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import { PLATFORM_CHANNELS, REALTIME_CHANNEL_PRESETS, type RealtimeChannelPreset } from './channels';
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

const loadConfig = (): Config => {
  const bitmexEnv = usesTestnet() ? 'testnet' : 'live';
  const preset = (process.env.BROADCAST_FEED_PRESET ?? 'feed') as RealtimeChannelPreset;

  const config: Config = {
    env: bitmexEnv,
    workerUuid: randomUUID(),
    rabbitmqUrl: sanitizeUrl(process.env.QUEUE_URL || ''),
    realtimeWsUrl: BITMEX_WS_URLS.realtime[bitmexEnv],
    platformWsUrl: BITMEX_WS_URLS.platform[bitmexEnv],
    realtimePreset: preset,
    realtimeChannels: REALTIME_CHANNEL_PRESETS[preset],
    platformChannels: PLATFORM_CHANNELS,
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.realtimeWsUrl) throw new Error('Failed to determine BitMEX realtime WS URL');
  if (! config.rabbitmqUrl) throw new Error('QUEUE_URL is required');
};

const usesTestnet = () => [undefined, '', '1', 'on', 'true'].includes(
  process.env.BITMEX_TESTNET?.toLowerCase()
);

export default loadConfig();
