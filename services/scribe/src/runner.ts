import { logger } from '@devvir/service-kit';
import type { RedisClient } from '@devvir/service-kit';
import { TABLES } from './utils/tables';
import { sleep } from './utils/throttling';
import type { FetchService, FetchFilter, Row } from './bitmex';
import type { StoreService } from './vault';
import type { TableConfig } from './types';
import { probeNextDate, restoreProgress, saveProgress, todayUtc, nextDay } from './probing';

const FLUSH_THRESHOLD = 1_000;

interface Task {
  id:     string;
  filter: FetchFilter;
}

export const runAllTables = async (
  fetch: FetchService,
  store: StoreService,
  cache: RedisClient,
  getIndices: () => Promise<string[]>,
): Promise<void> => {
  await Promise.all(TABLES.map(table => processTable(table, fetch, store, cache, getIndices)));
};

// ── Table loop ────────────────────────────────────────────────────────────────

const processTable = async (
  table:      TableConfig,
  fetch:      FetchService,
  store:      StoreService,
  cache:      RedisClient,
  getIndices: () => Promise<string[]>,
): Promise<void> => {
  logger.info({ table: table.name }, 'Starting');

  const getTasksFn = () => getTasks(table, getIndices);
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

    const tasks = await getTasks(table, getIndices);

    for (const { id, filter } of tasks) {
      if (! next.has(id)) next.set(id, currentDate); // new symbol: start from current date
      if (next.get(id)! > currentDate) continue;

      logger.info({ table: table.name, currentDate, id }, 'Processing day');

      const foundRows = await fetchAndWriteDay(filter, table, fetch, store, currentDate);

      const nextDate = foundRows
        ? nextDay(currentDate)
        : await probeNextDate(table, fetch, cache, id, filter, currentDate);

      next.set(id, nextDate);

      await saveProgress(cache, table.name, id, nextDate);
    }

    await store.closeFile(table.name, currentDate);
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
  const buffer: Row[] = [];
  let   hasRows = false;

  for await (const row of fetch.getDay(table, currentDate, filter)) {
    hasRows = true;
    buffer.push(row);

    if (buffer.length >= FLUSH_THRESHOLD)
      await store.writeRows(table.name, currentDate, buffer.splice(0));
  }

  if (buffer.length > 0)
    await store.writeRows(table.name, currentDate, buffer.splice(0));

  return hasRows;
};

// ── Task helpers ──────────────────────────────────────────────────────────────

const getTasks = async (
  table:      TableConfig,
  getIndices: () => Promise<string[]>,
): Promise<Task[]> => {
  if (table.name !== 'compositeIndex') return [{
    id: 'default',
    filter: { count: 500 },
  }];

  const indices = await getIndices();
  return indices.map(symbol => ({
    id: symbol,
    filter: { symbol, count: 1000 },
  }));
};

// ── Private ──────────────────────────────────────────────────────────────────

const sleepUntilTomorrow = (): Promise<void> => {
  const now      = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return sleep(tomorrow.getTime() - now.getTime());
};
