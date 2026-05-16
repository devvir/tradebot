import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const tables = process.env.CLERK_TABLES ?? '';

  const config: Config = {
    queueUrl:        process.env.QUEUE_URL ?? '',
    vaultUrl:        process.env.VAULT_URL ?? '',
    tables:          tables.split(',').map(s => s.trim()).filter(Boolean),
    waitIf:          parseWaitIf(process.env.CLERK_WATCH_QUEUES ?? ''),
    fileConcurrency: parseInt(process.env.CLERK_FILE_CONCURRENCY ?? '6'),
    readBufferHigh:  parseInt(process.env.CLERK_READ_BUFFER_HIGH  ?? '100000'),
    readBufferLow:   parseInt(process.env.CLERK_READ_BUFFER_LOW   ?? '50000'),
  };

  if (! config.queueUrl)
    throw new Error('QUEUE_URL is required');

  if (! config.vaultUrl)
    throw new Error('VAULT_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

/**
 * Parses `queue1:limit1,queue2:limit2` into a `{ queue: limit }` record.
 */
const parseWaitIf = (raw: string): Record<string, number> => {
  const result: Record<string, number> = {};

  for (const pair of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [ name, limit ] = pair.split(':').map(s => s.trim());

    if (! name || ! limit || Number.isNaN(parseInt(limit, 10)))
      throw new Error(`Invalid CLERK_WATCH_QUEUES entry "${pair}" — expected "queue:limit"`);

    result[name] = parseInt(limit, 10);
  }

  return result;
};

export default loadConfig();
