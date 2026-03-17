import { logger } from '@devvir/service-kit';

/**
 * Fetch snapshot from the snapshots HTTP server
 */
export const fetchSnapshot = async (
  snapshotsUrl: string,
  table: string,
): Promise<unknown[] | null> => {
  try {
    const url = `${snapshotsUrl}/snapshot/${table}`;
    const res = await fetch(url);

    if (! res.ok) {
      logger.warn({ table, status: res.status }, 'Failed to fetch snapshot');
      return null;
    }

    const data = await res.json() as { data: unknown; keys: string[] };
    return Array.isArray(data.data) ? data.data : Array.from((data.data as Map<string, unknown>).values());
  } catch (err) {
    logger.error({ table, err }, 'Error fetching snapshot');
    return null;
  }
};

/**
 * Filter snapshot data by query parameters
 */
export const filterSnapshotData = (
  data: unknown[] | null,
  query: Record<string, unknown>,
): unknown[] => {
  if (! data) return [];

  let filtered = data;

  // Filter by symbol if provided
  if (query.symbol && typeof query.symbol === 'string') {
    filtered = filtered.filter((item: any) => item?.symbol === query.symbol);
  }

  // Limit count if provided
  if (query.count && typeof query.count === 'number') {
    filtered = filtered.slice(0, query.count);
  }

  return filtered;
};
