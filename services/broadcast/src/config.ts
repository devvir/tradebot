import { randomUUID } from 'crypto';
import { logger } from '@devvir/service-kit';
import { redactCredentials, redactUrl, sanitizeUrl, channelPreset, type RealtimeChannelPreset } from '@tradebot/utils';
import { parsePools, expandChannels } from './pools';
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
  const preset = process.env.BROADCAST_FEED_PRESET ?? 'feed';
  const pools  = parsePools(process.env.BROADCAST_POOLS);

  const config: Config = {
    env: bitmexEnv,
    workerUuid: randomUUID(),
    rabbitmqUrl:  sanitizeUrl(process.env.QUEUE_URL || ''),
    realtimeWsUrl: BITMEX_WS_URLS.realtime[bitmexEnv],
    platformWsUrl: BITMEX_WS_URLS.platform[bitmexEnv],
    channels: expandChannels(channelPreset(preset as RealtimeChannelPreset), pools),
    pools,
    bouncerUrl:   process.env.BOUNCER_URL ?? '',
    bouncerToken: process.env.BOUNCER_TOKEN ?? '',
  };

  validateConfig(config);

  logger.info({
    ...config,
    preset,
    rabbitmqUrl:  redactUrl(config.rabbitmqUrl),
    bouncerToken: redactCredentials(config.bouncerToken),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.realtimeWsUrl) throw new Error('Failed to determine BitMEX realtime WS URL');
  if (! config.rabbitmqUrl) throw new Error('QUEUE_URL is required');
  if (! config.bouncerUrl)   throw new Error('BOUNCER_URL is required');
  if (! config.bouncerToken) throw new Error('BOUNCER_TOKEN is required');
};

const usesTestnet = () => [undefined, '', '1', 'on', 'true'].includes(
  process.env.BITMEX_TESTNET?.toLowerCase()
);

export default loadConfig();
