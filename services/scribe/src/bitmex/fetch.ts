import { fetchOne, rowIterator } from './rows';
import type { FetchFilter, Row } from './rows';
import type { TableConfig } from '../types';

export type { FetchFilter };

export interface FetchService {
  oldest(table: TableConfig, filter?: FetchFilter): Promise<Row | null>;
  newest(table: TableConfig, filter?: FetchFilter): Promise<Row | null>;
  getRows(table: TableConfig, filter?: FetchFilter): AsyncIterable<Row>;
  getDay(table: TableConfig, date: string, filter?: FetchFilter): AsyncIterable<Row>;
}

export const createFetchService = (baseUrl: string): FetchService => ({
  oldest: (table, filter = {}) =>
    fetchOne(baseUrl, table.path, filter),

  newest: (table, filter = {}) =>
    fetchOne(baseUrl, table.path, { ...filter, reverse: true }),

  getRows: (table, filter = {}) =>
    rowIterator(baseUrl, table.path, table.maxStart, filter),

  getDay: (table, date, filter = {}) =>
    dayIterator(baseUrl, table, date, filter),
});

// ── Day iterator ─────────────────────────────────────────────────────────────

// BitMEX maps endTime to an absolute row-ID threshold rather than doing a
// timestamp comparison. Rows inserted late (sparse symbols backfilled after
// other symbols have advanced past midnight) carry row-IDs beyond that
// threshold even though their timestamps fall within the requested day. Using
// exactly T00:00:00.000Z as endTime therefore returns empty for such symbols.
// Fix: extend the fetch window by 24 h so those rows are included, then drop
// any row whose timestamp falls outside [startTime, endTime).
async function* dayIterator(
  baseUrl: string,
  table:   TableConfig,
  date:    string,
  filter:  FetchFilter,
): AsyncGenerator<Row> {
  const startIso = dateToIso(date);
  const endIso   = dateToIso(nextDay(date));
  const fetchEnd = dateToIso(nextDay(nextDay(date)));

  for await (const row of rowIterator(baseUrl, table.path, table.maxStart, {
    ...filter,
    startTime: startIso,
    endTime:   fetchEnd,
  })) {
    const ts = (row['timestamp'] ?? row['date']) as string | undefined;

    if (ts && ts >= endIso) return;

    yield row;
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

const dateToIso = (date: string): string => {
  const y = date.slice(0, 4);
  const m = date.slice(4, 6);
  const d = date.slice(6, 8);

  return `${y}-${m}-${d}T00:00:00.000Z`;
};

const nextDay = (date: string): string => {
  const y = parseInt(date.slice(0, 4));
  const m = parseInt(date.slice(4, 6)) - 1;
  const d = parseInt(date.slice(6, 8));

  return new Date(Date.UTC(y, m, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
};
