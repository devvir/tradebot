import { fetchOne, rowIterator } from './rows';
import { dateToIso, nextDay } from '../utils';
import type { Row, FetchFilter, FetchService } from './types';
import type { TableConfig } from '../types';

export const createFetchService = (baseUrl: string): FetchService => ({
  oldest: (table, filter = {}) =>
    fetchOne(baseUrl, table.path, filter),

  newest: (table, filter = {}) =>
    fetchOne(baseUrl, table.path, { ...filter, reverse: true }),

  getRows: (table, filter = {}) =>
    rowIterator(baseUrl, table.path, table.maxStart, table.tsField, filter),

  getDay: (table, date, filter = {}) =>
    dayIterator(baseUrl, table, date, filter),
});

// ── Day iterator ─────────────────────────────────────────────────────────────

// startTime/endTime, sort order and pagination all key off the table's operative
// clock — `logged` (insertion) for compositeIndex, `timestamp` otherwise (see
// tsField). The day is cut on that same field. BitMEX maps endTime to a row-ID
// threshold, so a row inserted late can fall beyond an exact-midnight endTime
// even when it belongs in the day; we over-fetch by 24 h and drop any row whose
// tsField lands in the next day. Cutting on the sort field makes the boundary
// `return` safe — the stream is monotonic in it.
async function* dayIterator(
  baseUrl: string,
  table:   TableConfig,
  date:    string,
  filter:  FetchFilter,
): AsyncGenerator<Row> {
  const startIso = dateToIso(date);
  const endIso   = dateToIso(nextDay(date));
  const fetchEnd = dateToIso(nextDay(nextDay(date)));

  for await (const row of rowIterator(baseUrl, table.path, table.maxStart, table.tsField, {
    ...filter,
    startTime: startIso,
    endTime:   fetchEnd,
  })) {
    const ts = (table.tsField ? row[table.tsField] : (row['timestamp'] ?? row['date'])) as string | undefined;

    if (ts && ts >= endIso) return;

    yield row;
  }
}
