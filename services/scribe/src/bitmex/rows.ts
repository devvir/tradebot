import { logger } from '@devvir/service-kit';
import { waitIfNeeded, sleep } from '../utils/throttling';

const DEFAULT_PAGE_SIZE = 500;

export type Row = Record<string, unknown>;

export interface FetchFilter {
  symbol?:    string;
  startTime?: string;
  endTime?:   string;
  count?:     number;
  reverse?:   boolean;
}

// Returns the first matching row, or null.
export const fetchOne = async (
  baseUrl: string,
  path:    string,
  filter:  FetchFilter = {},
): Promise<Row | null> => {
  const url  = buildUrl(baseUrl, path, 0, 1, filter);
  const rows = await fetchWithRetry(url);

  return rows[0] ?? null;
};

// Streams rows from the BitMEX API, handling pagination and block transitions
// transparently. The caller sees a flat sequence of rows with no page boundaries.
//
// Block transitions: BitMEX silently caps the `start` offset per startTime bucket
// at an undocumented limit. When maxStart is set and start exceeds the threshold,
// blockStartTime advances to the last seen timestamp and start resets to 0.
export async function* rowIterator(
  baseUrl:  string,
  path:     string,
  maxStart: number | null,
  filter:   FetchFilter = {},
): AsyncGenerator<Row> {
  const pageSize     = filter.count ?? DEFAULT_PAGE_SIZE;

  let start          = 0;
  let blockStartTime = filter.startTime ?? null;

  while (true) {
    const url  = buildUrl(
      baseUrl, path, start, pageSize,
      { ...filter, startTime: blockStartTime ?? undefined },
    );

    const rows = await fetchWithRetry(url);

    if (rows.length === 0) return;

    for (const row of rows) yield row;

    start += rows.length;

    if (rows.length < pageSize) return;

    if (maxStart !== null && start > maxStart - pageSize) {
      const lastRow = rows[rows.length - 1]!;
      const lastTs  = (lastRow['timestamp'] ?? lastRow['date']) as string | undefined;

      if (lastTs) {
        blockStartTime = lastTs;
        start          = 0;
      }
    }
  }
}

// ── Private ───────────────────────────────────────────────────────────────────

const buildUrl = (
  baseUrl: string,
  path:    string,
  start:   number,
  count:   number,
  filter:  FetchFilter,
): string => {
  const params = new URLSearchParams({
    start:   String(start),
    count:   String(count),
    reverse: String(filter.reverse ?? false),
  });

  if (filter.symbol)    params.set('symbol',    filter.symbol);
  if (filter.startTime) params.set('startTime', filter.startTime);
  if (filter.endTime)   params.set('endTime',   filter.endTime);

  return `${baseUrl}${path}?${params}`;
};

const fetchWithRetry = async (url: string): Promise<Row[]> => {
  while (true) {
    try {
      const res = await fetch(url);

      await waitIfNeeded(res);

      if (res.ok) return (await res.json()) as Row[];
    } catch (err) {
      logger.warn({ err, url }, 'Network error — retrying in 3s');
      await sleep(3_000);
    }
  }
};
