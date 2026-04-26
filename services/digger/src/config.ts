import { randomUUID } from 'crypto';
import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    workerUuid:         randomUUID(),
    database:           process.env.DB_DATABASE        ?? '',
    bufferLowWatermark: Number(process.env.DIGGER_LOW_WATERMARK ?? 5_000),
    bufferBatchSize:    Number(process.env.DIGGER_BATCH_SIZE    ?? 1_000),
    waitIfQueues:       parseWaitIfQueues(process.env.DIGGER_WAIT_IF),
    startTime:          parseStartTime(process.env.DIGGER_START_TIME),
  };

  validateConfig(config);

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.database) throw new Error('DB_DATABASE is required');
};

/**
 * Parse `DIGGER_WAIT_IF` into the `waitIf` map expected by exchange.publish().
 *
 * Format: `queueA:10000,queueB:5000` (queue name : max ready+unacked depth).
 * Returns undefined when unset so the publisher omits the option entirely.
 */
const parseWaitIfQueues = (raw: string | undefined): Record<string, number> | undefined => {
  if (! raw) return undefined;

  const result: Record<string, number> = {};

  for (const entry of raw.split(',')) {
    const [name, depth] = entry.split(':').map(s => s.trim());

    if (name && depth && Number.isFinite(Number(depth))) {
      result[name] = Number(depth);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

/**
 * Parse `DIGGER_START_TIME` into an epoch-ms number.
 *
 * Accepts ISO-8601 (`2019-01-01T00:00:00Z`) or epoch ms (`1546300800000`).
 * Returns undefined when unset so the clock stays null at boot — subscriptions
 * then return 400 until `POST /set-clock` is called explicitly.
 */
const parseStartTime = (raw: string | undefined): number | undefined => {
  if (! raw) return undefined;

  const asNumber = Number(raw);

  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;

  const ms = Date.parse(raw);

  if (Number.isFinite(ms)) return ms;

  throw new Error(`DIGGER_START_TIME is not a valid ISO date or epoch ms: ${raw}`);
};

export default loadConfig();

// ── Test-only ─────────────────────────────────────────────────────────────────

export const _test_parseWaitIfQueues = parseWaitIfQueues;
export const _test_parseStartTime    = parseStartTime;
