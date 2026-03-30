import { logger } from '@devvir/service-kit';
import { sanitizeUrl, redactUrl } from '@tradebot/utils';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    queueUrl: sanitizeUrl(process.env.QUEUE_URL ?? ''),
    prefetch: parseInt(process.env.ASSEMBLER_PREFETCH ?? '200'),
  };

  if (! config.queueUrl)
    throw new Error('QUEUE_URL is required');

  logger.info({
    ...config,
    queueUrl: redactUrl(config.queueUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
