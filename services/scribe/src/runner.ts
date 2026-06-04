import { logger } from '@devvir/service-kit';
import type { RedisClient } from '@devvir/service-kit';
import config from './config';
import { getOrderedIndices } from './utils/symbols';
import type { FetchService, FetchFilter } from './bitmex';
import { createBufferedWriter } from './vault';
import type { StoreService } from './vault';
import type { TableConfig } from './types';
import { probeNextDate, restoreProgress, saveProgress } from './probing';
import { sleep, todayUtc, nextDay } from './utils';

const FLUSH_THRESHOLD = 10_000;

interface Task {
  id:     string;
  filter: FetchFilter;
}

// ── Table loop ────────────────────────────────────────────────────────────────

export const processTable = async (
  table: TableConfig,
  fetch: FetchService,
  store: StoreService,
  cache: RedisClient,
): Promise<void> => {
  logger.info({ table: table.name }, 'Starting');

  const getTasksFn = () => getTasks(table, cache);
  const { initialDate, next, closedDates } = await restoreProgress(table, fetch, store, cache, getTasksFn);
  let currentDate = initialDate;

  while (true) {
    if (currentDate >= todayUtc()) {
      logger.info({ table: table.name, date: currentDate }, 'Caught up — waiting for tomorrow');
      await sleepUntilTomorrow();
    }

    if (closedDates.has(currentDate)) {
      logger.info({ table: table.name, date: currentDate }, 'Day already closed — skipping');
      currentDate = nextDay(currentDate);
      continue;
    }

    const tasks = await getTasks(table, cache);

    /**
     * Symbols with data: defer the Redis confirmation until after `closeFile`
     * so the day is all-or-nothing. A crash mid-loop leaves Redis untouched
     * for these symbols, so on restart the open .csv.gz.tmp gets wiped and
     * the whole day is re-fetched cleanly. Empty-day symbols save eagerly
     * via `probeNextDate` — they have no data in the open file to lose, and
     * persisting immediately spares the probe on restart.
     */
    const dataSymbols = new Set<string>();

    for (const { id, filter } of tasks) {
      if (! next.has(id)) next.set(id, currentDate); // new symbol: start from current date
      if (next.get(id)! > currentDate) continue;

      logger.info({ table: table.name, currentDate, id }, 'Processing day');

      const foundRows = await fetchAndWriteDay(filter, table, fetch, store, currentDate);

      if (foundRows) {
        next.set(id, nextDay(currentDate));
        dataSymbols.add(id);
      } else {
        next.set(id, await probeNextDate(table, fetch, cache, id, filter, currentDate));
      }
    }

    await store.closeFile(table.name, currentDate);

    for (const id of dataSymbols)
      await saveProgress(cache, table.name, id, next.get(id)!);

    logger.info({ table: table.name, date: currentDate }, 'Day closed');
    currentDate = nextDay(currentDate);
  }
};

// ── Day fetch ─────────────────────────────────────────────────────────────────

const fetchAndWriteDay = async (
  filter: FetchFilter,
  table:  TableConfig,
  fetch:  FetchService,
  store:  StoreService,
  currentDate: string,
): Promise<boolean> => {
  const writer = createBufferedWriter(store, table.name, currentDate, FLUSH_THRESHOLD);
  let   hasRows = false;

  for await (const row of fetch.getDay(table, currentDate, filter)) {
    hasRows = true;
    await writer.push(row);
  }

  await writer.close();

  return hasRows;
};

// ── Task helpers ──────────────────────────────────────────────────────────────

const getTasks = async (
  table: TableConfig,
  cache: RedisClient,
): Promise<Task[]> => {
  const filterClause = table.filter ? { filter: table.filter } : {};

  if (table.name !== 'compositeIndex') return [{
    id: 'default',
    filter: { count: table.count, ...filterClause },
  }];

  const indices = await getOrderedIndices(cache, config.bitmexRestUrl);

  return indices.map(symbol => ({
    id: symbol,
    filter: { symbol, count: table.count, ...filterClause },
  }));
};

// ── Private ──────────────────────────────────────────────────────────────────

const sleepUntilTomorrow = (): Promise<void> => {
  const now      = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return sleep(tomorrow.getTime() - now.getTime());
};
