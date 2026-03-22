import { logger } from '@devvir/service-kit';
import { TABLES } from '../utils/tables.js';
import type { HistoryState } from './state.js';

interface VerifyParams {
  baseUrl: string;
  states: Map<string, HistoryState>;
}

export const verifyFirstTimestamps = async ({ baseUrl, states }: VerifyParams): Promise<void> => {
  const failures: string[] = [];

  for (const table of TABLES) {
    // Re-use the same symbol sets that would be used at runtime.
    // We don't have the full symbol list at this point, so we iterate over
    // whatever sub-tables exist in the state map for this table.
    const prefix = `${table.name}:`;
    const subTableIds = [...states.keys()].filter(
      (id) => id === table.name || id.startsWith(prefix)
    );

    for (const id of subTableIds) {
      const state = states.get(id)!;
      if (! state.firstTimestamp) continue;

      const symbol = id.includes(':') ? id.split(':').slice(1).join(':') : null;
      const current = await fetchFirstTimestamp(baseUrl, table.path, symbol);

      if (current === null) {
        logger.warn({ subTable: id }, 'Could not fetch firstTimestamp for verification (empty or error); skipping');
        continue;
      }

      if (current !== state.firstTimestamp) {
        failures.push(
          `${id}: recorded firstTimestamp=${state.firstTimestamp}, current=${current}`
        );
      }
    }
  }

  if (failures.length > 0) {
    const message = [
      'FATAL: BitMEX pagination offset drift detected.',
      'The following sub-tables have a different first record than when they were last fetched.',
      'This likely means BitMEX pruned historical data, which invalidates _seq-based ordering.',
      'Manual intervention is required: inspect, drop, and re-fetch the affected collections.',
      ...failures.map((f) => `  - ${f}`),
    ].join('\n');

    logger.fatal(message);
    throw new Error(message);
  }

  logger.info({ checked: states.size }, 'firstTimestamp verification passed');
};

const fetchFirstTimestamp = async (
  baseUrl: string,
  path: string,
  symbol: string | null
): Promise<string | null> => {
  try {
    const params = new URLSearchParams({ start: '0', count: '1', reverse: 'false' });
    if (symbol) params.set('symbol', symbol);

    const res = await fetch(`${baseUrl}${path}?${params}`);
    if (! res.ok) return null;

    const rows = (await res.json()) as Record<string, unknown>[];
    if (rows.length === 0) return null;

    const row = rows[0];
    return (row['timestamp'] as string) ?? (row['date'] as string) ?? null;
  } catch {
    return null;
  }
};
