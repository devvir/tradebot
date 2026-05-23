import type { components } from '@devvir/bitmex-api/types';
import type { RedisClient } from '@devvir/service-kit';
import { logger } from '@devvir/service-kit';
import { withRetry } from './throttling';

type Instrument = components['schemas']['Instrument'];
type Symbols = { indices: string[]; inactive: Set<string> };

const PAGE_SIZE = 1000;

const INDICES_HASH = 'scribe:indices';

/**
 * Fetch all BitMEX indices ordered by their stable registration ID.
 *
 * The ID-to-symbol mapping lives in a Redis hash; any index newly seen on
 * BitMEX is assigned the next sequential ID, so order is preserved across
 * restarts and matches the historical registry that previously held it.
 */
export const getOrderedIndices = async (
  cache:   RedisClient,
  baseUrl: string,
): Promise<string[]> => {
  const { indices } = await fetchSymbols(baseUrl);
  const idMap       = await registerIndices(cache, indices);

  return [...indices].sort((a, b) => (idMap.get(a) ?? 0) - (idMap.get(b) ?? 0));
};

export const fetchSymbols = async (baseUrl: string): Promise<Symbols> => {
  const all: Instrument[] = [];

  await withRetry('fetchSymbols', async () => {
    all.length = 0;
    let start  = 0;

    while (true) {
      const url = `${baseUrl}/instrument?count=${PAGE_SIZE}&start=${start}&columns=symbol,state&reverse=false`;
      const res = await fetch(url);

      if (! res.ok)
        throw new Error(`Failed to fetch instrument list: HTTP ${res.status}`);

      const page = (await res.json()) as Instrument[];

      all.push(...page);

      if (page.length < PAGE_SIZE) break;

      start += PAGE_SIZE;
    }
  });

  const indices  = all.filter(i =>   i.symbol.startsWith('.')).map(i => i.symbol);
  const inactive = new Set(all.filter(i => i.state !== 'Open').map(i => i.symbol));

  logger.info({ indices: indices.length, inactive: inactive.size }, 'Symbol list loaded');

  return { indices, inactive };
};

// ── Private ──────────────────────────────────────────────────────────────────

const registerIndices = async (
  cache:   RedisClient,
  indices: string[],
): Promise<Map<string, number>> => {
  const existing = await cache.hGetAll(INDICES_HASH) as Record<string, string>;
  const idMap    = new Map<string, number>(
    Object.entries(existing).map(([sym, id]) => [sym, Number(id)]),
  );

  const fresh = indices.filter(s => ! idMap.has(s));

  let nextId = idMap.size > 0 ? Math.max(...idMap.values()) + 1 : 0;

  for (const symbol of fresh) {
    const id = nextId++;

    await cache.hSet(INDICES_HASH, symbol, String(id));
    idMap.set(symbol, id);
  }

  if (fresh.length > 0)
    logger.info({ added: fresh.length, total: idMap.size }, 'Registered new indices');

  return idMap;
};
