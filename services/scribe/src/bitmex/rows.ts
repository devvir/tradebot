import { logger } from '@devvir/service-kit';
import { waitIfNeeded, sleep } from '../utils/throttling';
import { recordFetch } from './metrics';
import type { Row, FetchFilter } from './types';

const DEFAULT_PAGE_SIZE = 500;
const PAGES_PER_BATCH   = 10;

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
// Each iteration issues PAGES_PER_BATCH page fetches in parallel — a "mega-page"
// of pageSize × PAGES_PER_BATCH rows. Yields are in offset order, so output is
// byte-identical to a fully sequential iterator.
//
// Block transitions: BitMEX silently caps the `start` offset per startTime
// bucket at an undocumented limit. Two transitions handle this:
//
//   - Preemptive (full batch): when every page in the batch is full and start
//     is about to exceed `maxStart - pageSize`, advance blockStartTime to the
//     last seen timestamp and reset start to 0.
//
//   - Reactive (bug bypass): when at least one full page came back but a later
//     page in the batch was short or empty, the cap was hit mid-batch — same
//     transition. The batch boundary is the only thing that distinguishes
//     "bug struck mid-stream" (some full + some not) from "data ended" (first
//     page already short or empty), so the iterator returns in the latter
//     case to match the original single-page semantics.
//
// With PAGES_PER_BATCH = 1 the reactive path is unreachable (no later page
// can be incomplete) and the iterator behaves identically to the original.
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
    const inFlight: Promise<Row[]>[] = [];

    for (let i = 0; i < PAGES_PER_BATCH; i++) {
      const url = buildUrl(
        baseUrl, path, start + i * pageSize, pageSize,
        { ...filter, startTime: blockStartTime ?? undefined },
      );

      inFlight.push(fetchWithRetry(url));
    }

    const pages = await Promise.all(inFlight);

    let fullPages = 0;
    let totalRows = 0;
    let lastTs:   string | undefined;

    for (const rows of pages) {
      if (rows.length === 0) break;

      for (const row of rows) yield row;

      totalRows += rows.length;

      const lastRow = rows[rows.length - 1]!;
      const ts      = (lastRow['timestamp'] ?? lastRow['date']) as string | undefined;
      if (ts) lastTs = ts;

      if (rows.length < pageSize) break;

      fullPages++;
    }

    if (totalRows === 0) return;

    if (fullPages === PAGES_PER_BATCH) {
      start += PAGES_PER_BATCH * pageSize;

      if (maxStart !== null && start > maxStart - pageSize && lastTs) {
        blockStartTime = lastTs;
        start          = 0;
      }
    } else if (fullPages > 0 && lastTs) {
      blockStartTime = lastTs;
      start          = 0;
    } else {
      return;
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
  if (filter.filter)    params.set('filter',    JSON.stringify(filter.filter));

  return `${baseUrl}${path}?${params}`;
};

const fetchWithRetry = async (url: string): Promise<Row[]> => {
  while (true) {
    try {
      const res = await fetch(url);

      await waitIfNeeded(res);

      if (res.ok) {
        recordFetch(parseRemaining(res));
        return (await res.json()) as Row[];
      }
    } catch (err) {
      logger.warn({ err, url }, 'Network error — retrying in 3s');
      await sleep(3_000);
    }
  }
};

const parseRemaining = (res: Response): number | null => {
  const raw = res.headers.get('x-ratelimit-remaining');
  if (raw === null) return null;

  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};
