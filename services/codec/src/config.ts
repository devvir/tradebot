import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import { Config } from './types';

export const codecStrategies = (process.env.CODEC_STRATEGY || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(s => !! s);

export const codecStrategy = {
  passthru: () => codecStrategies.length === 0,
  encode: () => codecStrategies.includes('encode'),
  binary: () => codecStrategies.includes('binary'),
} as const;

export const loadConfig = (): Config => {
  const config = {
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || ''),
    inboundExchange: process.env.CODEC_INBOUND_EXCHANGE || '',
    inboundQueue: process.env.CODEC_INBOUND_QUEUE || '',
    outboundExchange: process.env.CODEC_OUTBOUND_EXCHANGE || '',
    outboundQueue: process.env.CODEC_OUTBOUND_QUEUE || '',
    prefetch: parseInt(process.env.CODEC_PREFETCH || '0', 10),
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (! config.inboundExchange) throw new Error('CODEC_INBOUND_EXCHANGE is required');
  if (! config.inboundQueue) throw new Error('CODEC_INBOUND_QUEUE is required');
  if (! config.outboundExchange) throw new Error('CODEC_OUTBOUND_EXCHANGE is required');
  if (! config.outboundQueue) throw new Error('CODEC_OUTBOUND_QUEUE is required');
};
