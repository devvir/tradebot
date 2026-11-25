import { randomUUID } from 'crypto';
import { logger } from '@devvir/service-kit';
import { redactUrl } from '@tradebot/utils';
import { VENUE_NAMES } from './venues';
import type { Config } from './types';

/**
 * `HOARDER_VENUES` selects which venues this instance collects, so one
 * deployment can take a single venue and another take all of them. It is the
 * only collection knob in the environment — *what* each venue subscribes to
 * lives in `venues/channels.ts`, since it changes rarely and never per host.
 *
 * `QUEUE_URL` must be set; the broker connection reads it from the environment
 * itself, so it is checked here and logged with its credentials redacted, but
 * not kept in the config.
 */
const loadConfig = (): Config => {
  const queueUrl = process.env.QUEUE_URL ?? '';

  if (! queueUrl) throw new Error('QUEUE_URL is required');

  const config: Config = {
    workerUuid: randomUUID(),
    venues:     parseVenues(process.env.HOARDER_VENUES),
  };

  if (config.venues.length === 0) throw new Error('HOARDER_VENUES resolved to no venues');

  logger.info({ ...config, queueUrl: redactUrl(queueUrl) }, 'Configuration loaded and validated!');

  return config;
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
