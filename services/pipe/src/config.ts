import { logger } from '@devvir/service-kit';
import { sanitizeUrl, redactUrl } from '@tradebot/utils';
import parseBindings, { buildTopology, withDefaults } from './bindings';
import type { Config } from './types';

const loadConfig = (): Config => {
  const bindings = withDefaults(parseBindings(process.env.PIPE_BINDINGS || ''));

  const config: Config = {
    rabbitmqUrl: sanitizeUrl(process.env.QUEUE_URL || ''),
    topology: buildTopology(bindings),
    bindings,
  }

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('QUEUE_URL is required');
  if (! config.bindings.length) throw new Error('PIPE_BINDINGS is required');
};

export default loadConfig();
