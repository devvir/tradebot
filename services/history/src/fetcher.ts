import { logger } from '@devvir/service-kit';
import { PAGE_SIZE } from './utils/tables.js';
import { waitIfNeeded, sleep } from './utils/throttling.js';

interface FetchPageParams {
  baseUrl: string;
  path: string;
  symbol: string | null;
  start: number;
  startTime?: string;
}

export const fetchPage = async ({ baseUrl, path, symbol, start, startTime }: FetchPageParams): Promise<Record<string, unknown>[]> => {
  const url = buildUrl(baseUrl, path, symbol, start, startTime);
  const res = await fetchWithRetry(url);

  return (await res.json()) as Record<string, unknown>[];
};

export const fetchFirstTimestamp = async (baseUrl: string, path: string, symbol: string | null): Promise<string | null> => {
  const url = buildUrl(baseUrl, path, symbol, 0, undefined, 1);
  const res = await fetchWithRetry(url);

  const rows = (await res.json()) as Record<string, unknown>[];
  if (rows.length === 0) return null;

  const row = rows[0];
  return (row['timestamp'] as string) ?? (row['date'] as string) ?? null;
};

const fetchWithRetry = async (url: string): Promise<Response> => {
  while (true) {
    try {
      const res = await fetch(url);

      await waitIfNeeded(res);

      if (res.ok) return res;
    } catch (err) {
      logger.warn({ err, url }, 'Network error — sleeping 3s');
      await sleep(3_000);
    }
  }
};

const buildUrl = (
  baseUrl: string,
  path: string,
  symbol: string | null,
  start: number,
  startTime?: string,
  count = PAGE_SIZE
): string => {
  const params = new URLSearchParams({
    start: String(start),
    count: String(count),
    reverse: 'false',
  });

  if (symbol) params.set('symbol', symbol);
  if (startTime) params.set('startTime', startTime);

  return `${baseUrl}${path}?${params}`;
};
