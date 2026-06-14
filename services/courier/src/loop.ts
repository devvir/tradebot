import { logger } from '@devvir/service-kit';
import type { FetchClientHandle, RedisClient } from '@devvir/service-kit';
import config from './config';
import type { Table } from './types';
import { fetchAndStore, listVaultDates } from './download';

const redisKey   = (table: Table): string => `courier_${table}`;
const missingKey = (table: Table): string => `${redisKey(table)}:missing`;

const DEFAULT_START_DATE = '20141122';

// Fetches all dates not yet in vault for a given table, in chronological order.
// Two redis keys track progress: `courier_<table>` is the date we've checked
// through, `courier_<table>:missing` the dates we checked but S3 hadn't
// published yet (a permanent hole, or just the trailing edge). Both holes and
// the unchecked range up to yesterday are attempted every cycle, so a missing
// bucket never blocks later dates and is re-downloaded once it appears.
export const syncTable = async (vault: FetchClientHandle, table: Table, redis: RedisClient): Promise<void> => {
  const existing       = new Set(await listVaultDates(vault, table));
  const configStart    = config.startDate ?? DEFAULT_START_DATE;
  const checkedThrough = await redis.get(redisKey(table));
  const startDate      = checkedThrough ? nextDay(checkedThrough) : configStart;
  const yesterday      = yesterdayUTC();

  const knownMissing = await redis.sMembers(missingKey(table));
  const toFetch      = [...new Set([...knownMissing, ...dateRange(startDate, yesterday)])]
    .filter(d => d <= yesterday && ! existing.has(d))
    .sort();

  logger.info({ table, count: toFetch.length, startDate }, 'Downloading missing dates');

  const stillMissing: string[] = [];

  for (const date of toFetch) {
    const published = await fetchAndStore(vault, table, date);

    if (! published) {
      logger.info({ table, date }, 'Not yet published — will retry on next poll');
      stillMissing.push(date);
    }
  }

  /** Recreate the missing set each cycle so cleared holes drop off automatically. */
  await redis.set(redisKey(table), yesterday);
  await redis.del(missingKey(table));

  if (stillMissing.length > 0)
    await redis.sAdd(missingKey(table), stillMissing);
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
