import { logger } from '@devvir/service-kit';
import type { RedisClient } from '@devvir/service-kit';
import config from './config';
import { todayUtc, nextDay, dateToIso } from './utils';
import type { FetchService, FetchFilter, Row } from './bitmex';
import type { StoreService } from './vault';
import type { TableConfig } from './types';

interface Task {
  id:     string;
  filter: FetchFilter;
}

const cacheKey = (table: string, id: string): string => `scribe_${table}_${id}`;

export const saveProgress = async (
  cache: RedisClient,
  table: string,
  id:    string,
  date:  string,
): Promise<void> => {
  await cache.set(cacheKey(table, id), date);
};

export const probeNextDate = async (
  table:       TableConfig,
  fetch:       FetchService,
  cache:       RedisClient,
  id:          string,
  filter:      FetchFilter,
  currentDate: string,
): Promise<string> => {
  logger.info({ table: table.name, id }, 'Empty day — probing');

  let nextDate = await oldestDate(fetch, table, { ...filter, startTime: dateToIso(nextDay(currentDate)) });

  // BitMEX maps startTime to a row-ID threshold, not a timestamp comparison.
  // Sparse symbols whose rows sit at high row-IDs return empty even when data
  // exists. Fall back to a reverse query (no startTime) to decide whether the
  // symbol is truly exhausted or just hidden by the row-ID quirk.
  if (! nextDate) {
    const lastDate = await newestDate(fetch, table, { symbol: filter.symbol });

    if (lastDate && lastDate > currentDate) {
      const firstDate = await oldestDate(fetch, table, { symbol: filter.symbol }) ?? todayUtc();

      logger.info({ table: table.name, id, firstDate, lastDate }, 'Will start from first available date');
      nextDate = firstDate > currentDate ? firstDate : nextDay(currentDate);
    } else {
      logger.info({ table: table.name, id, lastDate }, 'Symbol exhausted');
      nextDate = todayUtc();
    }
  }

  await saveProgress(cache, table.name, id, nextDate);

  return nextDate;
};

// ── Cold start ───────────────────────────────────────────────────────────────

export const restoreProgress = async (
  table:    TableConfig,
  fetch:    FetchService,
  store:    StoreService,
  cache:    RedisClient,
  getTasks: () => Promise<Task[]>,
): Promise<{ initialDate: string; next: Map<string, string>; closedDates: Set<string> }> => {
  const closedDates = await collectClosedDates(table.name, store);
  const tasks       = await getTasks();
  const next        = new Map<string, string>();

  logger.info({ table: table.name, tasks: tasks.length }, 'Restoring progress');

  for (const task of tasks.values())
    next.set(task.id, await taskStartDate(table, fetch, cache, task, closedDates));

  const initialDate = [...next.values()].reduce((a, b) => (a < b ? a : b), todayUtc());

  logger.info({ table: table.name, initialDate }, 'Progress restored');

  return { initialDate, next, closedDates };
};

const taskStartDate = async (
  table:       TableConfig,
  fetch:       FetchService,
  cache:       RedisClient,
  task:        Task,
  closedDates: Set<string>,
): Promise<string> => {
  const today    = todayUtc();
  const cached   = await cache.get(cacheKey(table.name, task.id));
  const boundary = latest(config.startDate ?? null, cached);

  if (! boundary) {
    logger.info(`Checking start date for task ${task.id}`);

    const probed = await oldestDate(fetch, table, task.filter) ?? today;

    await saveProgress(cache, table.name, task.id, probed);

    return probed;
  }

  if (boundary >= today) return today;

  return firstUnclosed(boundary, closedDates);
};

// ── Vault startup ────────────────────────────────────────────────────────────

const collectClosedDates = async (
  tableName: string,
  store:     StoreService,
): Promise<Set<string>> => {
  const files = await store.listFiles(tableName);

  for (const [date, state] of Object.entries(files)) {
    if (state === 'open') {
      await store.deleteFile(tableName, date);
      logger.info({ table: tableName, date }, 'Deleted incomplete open file');
    }
  }

  return new Set(
    Object.entries(files)
      .filter(([, s]) => s === 'closed')
      .map(([d]) => d),
  );
};

// ── Date helpers ─────────────────────────────────────────────────────────────

const latest = (a: string | null, b: string | null): string | null => {
  if (! a) return b;
  if (! b) return a;

  return a > b ? a : b;
};

const firstUnclosed = (from: string, closedDates: Set<string>): string => {
  let date = from;

  while (closedDates.has(date)) date = nextDay(date);

  return date;
};

const oldestDate = async (fetch: FetchService, table: TableConfig, filter: FetchFilter): Promise<string | null> =>
  rowDate(await fetch.oldest(table, filter));

const newestDate = async (fetch: FetchService, table: TableConfig, filter: FetchFilter): Promise<string | null> =>
  rowDate(await fetch.newest(table, filter));

const rowDate = (row: Row | null): string | null => {
  if (! row) return null;
  const ts = (row['timestamp'] ?? row['date']) as string | undefined;

  if (! ts || ts.length < 10) return null;

  return ts.slice(0, 10).replace(/-/g, '');
};
