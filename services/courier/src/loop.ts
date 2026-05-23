import { logger } from '@devvir/service-kit';
import type { FetchClientHandle, RedisClient } from '@devvir/service-kit';
import config from './config';
import type { Table } from './types';
import { fetchAndStore, listVaultDates } from './download';

const redisKey = (table: Table): string => `courier_${table}`;

const DEFAULT_START_DATE = '20141122';

// Fetches all dates not yet in vault for a given table, in chronological order.
// Redis stores the last successfully downloaded date; next run resumes from the
// day after.
export const syncTable = async (vault: FetchClientHandle, table: Table, redis: RedisClient): Promise<void> => {
  const existing       = new Set(await listVaultDates(vault, table));
  const configStart    = config.startDate ?? DEFAULT_START_DATE;
  const lastSuccessful = await redis.get(redisKey(table));
  const startDate      = lastSuccessful ? nextDay(lastSuccessful) : configStart;
  const needed         = dateRange(startDate, yesterdayUTC());
  const missing        = needed.filter(d => ! existing.has(d));

  if (missing.length === 0) {
    logger.info({ table }, 'No new dates to download');
    return;
  }

  logger.info({ table, count: missing.length, startDate }, 'Downloading missing dates');

  for (const date of missing) {
    const published = await fetchAndStore(vault, table, date);

    /** Not yet published on S3 — stop here; later dates won't be published either. */
    if (! published) {
      logger.info({ table, date }, 'Not yet published — will retry on next poll');
      break;
    }

    await redis.set(redisKey(table), date);
  }
};

// ── Polling ───────────────────────────────────────────────────────────────────

export const scheduleNextPoll = (vault: FetchClientHandle, tables: Table[], redis: RedisClient): void => {
  logger.info('All files downloaded, will rescan soon');

  setTimeout(async () => {
    logger.info('Checking for new files');

    for (const table of tables)
      await syncTable(vault, table, redis).catch(err => logger.error({ err }, 'Sync error'));

    scheduleNextPoll(vault, tables, redis);
  }, 60 * 60 * 1000); // 1 hour
};

// ── Date utilities ─────────────────────────────────────────────────────────────

const yesterdayUTC = (): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);

  return toYMD(d);
};

const nextDay = (ymd: string): string => {
  const d = fromYMD(ymd);
  d.setUTCDate(d.getUTCDate() + 1);

  return toYMD(d);
};

const dateRange = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const d   = fromYMD(from);
  const end = fromYMD(to);

  while (d <= end) {
    dates.push(toYMD(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return dates;
};

const toYMD = (d: Date): string =>
  d.toISOString().slice(0, 10).replace(/-/g, '');

const fromYMD = (ymd: string): Date =>
  new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
