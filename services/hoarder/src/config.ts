import { randomUUID } from 'crypto';
import { logger } from '@devvir/service-kit';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import { VENUE_NAMES } from './venues';
import type { Config } from './types';

/**
 * `HOARDER_VENUES` selects which venues this instance collects, so one
 * deployment can take a single venue and another take all of them. It is the
 * only collection knob in the environment — *what* each venue subscribes to
 * lives in `venues/channels.ts`, since it changes rarely and never per host.
 */
const loadConfig = (): Config => {
  const config: Config = {
    workerUuid:  randomUUID(),
    rabbitmqUrl: sanitizeUrl(process.env.QUEUE_URL || ''),
    venues:      parseVenues(process.env.HOARDER_VENUES),
  };

  validateConfig(config);

  logger.info({ ...config, rabbitmqUrl: redactUrl(config.rabbitmqUrl) }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('QUEUE_URL is required');
  if (config.venues.length === 0) throw new Error('HOARDER_VENUES resolved to no venues');
};

const parseVenues = (raw: string | undefined): string[] => {
  const tokens = (raw ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const names  = tokens.length === 0 ? [...VENUE_NAMES] : tokens;

  for (const name of names) {
    if (! VENUE_NAMES.includes(name))
      throw new Error(`HOARDER_VENUES: unknown venue "${name}". Valid: ${VENUE_NAMES.join(', ')}`);
  }

  return [...new Set(names)];
};

export default loadConfig();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_loadConfig  = loadConfig;
export const _test_parseVenues = parseVenues;
