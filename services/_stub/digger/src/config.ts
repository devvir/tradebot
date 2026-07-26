import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;

  const n = Number(raw);

  return Number.isFinite(n) ? n : fallback;
};

/** `DIGGER_START_TIME` — ISO-8601 or epoch ms. Undefined when unset. */
const parseStartTime = (raw: string | undefined): number | undefined => {
  if (! raw) return undefined;

  const asNumber = Number(raw);

  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;

  const ms = Date.parse(raw);

  if (Number.isFinite(ms)) return ms;

  throw new Error(`DIGGER_START_TIME is not a valid ISO date or epoch ms: ${raw}`);
};

const loadConfig = (): Config => {
  const config: Config = {
    startTime:       parseStartTime(process.env.DIGGER_START_TIME),
    wsPort:          num(process.env.DIGGER_WS_PORT,      80),
    restPort:        num(process.env.DIGGER_REST_PORT,    8000),
    controlPort:     num(process.env.DIGGER_CONTROL_PORT, 8001),
    providerWsUrl:   process.env.PROVIDER_WS_URL   ?? '',
    providerRestUrl: process.env.PROVIDER_REST_URL ?? '',
    batchSize:       num(process.env.DIGGER_BATCH_SIZE,    1_000),
    lowWatermark:    num(process.env.DIGGER_LOW_WATERMARK, 5_000),
    drainBatch:      num(process.env.DIGGER_DRAIN_BATCH,     256),
    bpHigh:          num(process.env.DIGGER_BP_HIGH, 4_000_000),
    bpLow:           num(process.env.DIGGER_BP_LOW, 1_000_000),
  };

  if (! config.providerWsUrl)   throw new Error('PROVIDER_WS_URL is required');
  if (! config.providerRestUrl) throw new Error('PROVIDER_REST_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
