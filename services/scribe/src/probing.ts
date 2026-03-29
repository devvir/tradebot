/**
 * Probing logic for discovering where symbol data starts and handling BitMEX's
 * row-ID-based startTime quirk. Extracted from runner to keep the main loop
 * focused on iteration and storage.
 */
import { logger } from '@devvir/service-kit';
import type { RedisClient } from '@devvir/service-kit';
import config from './config';
import type { FetchService, FetchFilter, Row } from './bitmex';
import type { StoreService } from './vault';
import type { TableConfig } from './types';

interface Task {
  id:     string;
  filter: FetchFilter;
}

const cacheKey = (table: string, id: string): string => `scribe_${table}_${id}`;

/**
 * Determines the next date to process for a symbol whose current day was empty.
 *
 * First tries a startTime-based probe (fast, one request). If that returns
 * nothing — which happens when BitMEX's row-ID threshold hides the data — falls
 * back to a reverse query without startTime to check whether the symbol has any
 * data past currentDate.
 */
export const probeNextDate = async (
  table:       TableConfig,
  fetch:       FetchService,
  cache:       RedisClient,
  id:          string,
  filter:      FetchFilter,
  currentDate: string,
): Promise<string> => {
  const probe    = await fetch.oldest(table, { ...filter, startTime: toIso(nextDay(currentDate)) });
  let   nextDate = rowDate(probe);

  // BitMEX maps startTime to a row-ID threshold, not a timestamp comparison.
  // Sparse symbols whose rows sit at high row-IDs return empty even when data
  // exists. Fall back to a reliable reverse query (no startTime) to decide
  // whether the symbol is truly exhausted or just hidden by the row-ID bug.
  if (! nextDate) {
    const last     = await fetch.newest(table, { symbol: filter.symbol });
    const lastDate = rowDate(last);

    if (lastDate && lastDate > currentDate) {
      const first     = await fetch.oldest(table, { symbol: filter.symbol });
      const firstDate = rowDate(first) ?? todayUtc();

      logger.info({ table: table.name, id, firstDate, lastDate }, 'Will start from first available date');
      nextDate = firstDate > currentDate ? firstDate : nextDay(currentDate);
    } else {
      logger.info({ table: table.name, id, lastDate }, 'Symbol exhausted');
      nextDate = todayUtc();
    }
  }

  await cache.set(cacheKey(table.name, id), nextDate);

  return nextDate;
};

// ── Cold start ───────────────────────────────────────────────────────────────

/**
 * Cleans up vault state, then builds the next-date map from cache where
 * available, falling back to a live probe only for tasks with no cached value.
 */
export const restoreProgress = async (
  table:    TableConfig,
  fetch:    FetchService,
  store:    StoreService,
  cache:    RedisClient,
  getTasks: () => Promise<Task[]>,
): Promise<{ initialDate: string; next: Map<string, string> }> => {
  const { resumeFrom } = await prepareTable(table.name, store);
  const tasks          = await getTasks();
  const next           = new Map<string, string>();
  let   initialDate    = resumeFrom ?? todayUtc();

  // Populate next from cache — avoids the 4000+ probe loop on restart.
  const uncached: typeof tasks = [];

  logger.info({ table: table.name, tasks: tasks.length }, 'Checking cache');

  for (const task of tasks) {
    const cached = await cache.get(cacheKey(table.name, task.id));

    if (cached) {
      next.set(task.id, cached);

      if (cached < initialDate) initialDate = cached;
    } else {
      uncached.push(task);
    }
  }

  logger.info({ table: table.name, cached: next.size, uncached: uncached.length }, 'Cache check done');

  // Never start before the vault's resume point — files before that are already
  // closed and must not be re-written. Cached dates from a previous interrupted
  // run may be earlier than resumeFrom; clamp them out.
  if (resumeFrom && initialDate < resumeFrom) initialDate = resumeFrom;

  // If resuming from vault history, skip probing uncached tasks — the main loop
  // will initialise them to initialDate on first encounter, same as before.
  if (resumeFrom) {
    logger.info({ table: table.name, resumeFrom, cached: next.size, uncached: uncached.length }, 'Resuming');
    return { initialDate, next };
  }

  // Cold start: probe only the tasks not found in cache.
  if (uncached.length > 0) {
    logger.info({ table: table.name, total: tasks.length, cached: next.size, probing: uncached.length }, 'Cold start — probing uncached tasks');

    for (const [i, { id, filter }] of uncached.entries()) {
      const startDate = rowDate(await fetch.oldest(table, filter)) ?? todayUtc();

      next.set(id, startDate);
      await cache.set(cacheKey(table.name, id), startDate);

      if (startDate < initialDate) initialDate = startDate;

      if ((i + 1) % 100 === 0)
        logger.info({ table: table.name, probed: i + 1, total: uncached.length }, 'Probing progress');
    }
  }

  logger.info({ table: table.name, initialDate }, 'Cold start probe complete');

  return { initialDate, next };
};

// ── Vault startup ────────────────────────────────────────────────────────────

const prepareTable = async (
  tableName: string,
  store:     StoreService,
): Promise<{ resumeFrom: string | null }> => {
  logger.info({ table: tableName }, 'Checking vault');

  const files = await store.listFiles(tableName);

  for (const [date, state] of Object.entries(files)) {
    if (state === 'open') {
      await store.deleteFile(tableName, date);
      logger.info({ table: tableName, date }, 'Deleted incomplete open file — will re-fetch');
    }
  }

  const lastClosed = Object.entries(files)
    .filter(([, s]) => s === 'closed')
    .map(([d]) => d)
    .sort()
    .at(-1) ?? null;

  if (lastClosed) {
    logger.info({ table: tableName, lastClosed }, 'Vault ready — resuming from next day');
  } else {
    logger.info({ table: tableName }, 'No existing vault files — will probe BitMEX for start date');
  }

  const vaultResume = lastClosed ? nextDay(lastClosed) : null;

  return { resumeFrom: max(vaultResume, config.startDate) };
};

const max = (a: string | null, b: string | null): string | null =>
  ! a ? b : ! b ? a : a > b ? a : b;

// ── Date helpers ─────────────────────────────────────────────────────────────

export const todayUtc = (): string =>
  new Date().toISOString().slice(0, 10).replace(/-/g, '');

export const nextDay = (date: string): string => {
  const y = parseInt(date.slice(0, 4));
  const m = parseInt(date.slice(4, 6)) - 1;
  const d = parseInt(date.slice(6, 8));

  return new Date(Date.UTC(y, m, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
};

const toIso = (date: string): string => {
  const y = date.slice(0, 4);
  const m = date.slice(4, 6);
  const d = date.slice(6, 8);

  return `${y}-${m}-${d}T00:00:00.000Z`;
};

const rowDate = (row: Row | null): string | null => {
  if (! row) return null;
  const ts = (row['timestamp'] ?? row['date']) as string | undefined;

  if (! ts || ts.length < 10) return null;

  return ts.slice(0, 10).replace(/-/g, '');
};
