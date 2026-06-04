import type { components } from '@devvir/bitmex-api/types';
import type { RedisClient, FetchClientHandle } from '@devvir/service-kit';
import { registry, logger } from '@devvir/service-kit';

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
  let start = 0;

  while (true) {
    const url  = `${baseUrl}/instrument?count=${PAGE_SIZE}&start=${start}&columns=symbol,state&reverse=false`;
    const page = (await client().get<Instrument[]>(url)) ?? [];

    all.push(...page);

    if (page.length < PAGE_SIZE) break;

    start += PAGE_SIZE;
  }

  const indices  = all.filter(i =>   i.symbol.startsWith('.')).map(i => i.symbol);
  const inactive = new Set(all.filter(i => i.state !== 'Open').map(i => i.symbol));

  logger.info({ indices: indices.length, inactive: inactive.size }, 'Symbol list loaded');

  return { indices, inactive };
};

// ── Private ──────────────────────────────────────────────────────────────────

let bitmex: FetchClientHandle | null = null;

/** Anonymous BitMEX client (retries on 429/5xx) for the one-off symbol-list fetch. */
const client = (): FetchClientHandle =>
  (bitmex ??= registry.get('scribe').clients.create({
    type:    'fetch',
    name:    'bitmex-symbols',
    retryOn: [429, 502, 503, 504],
  }) as FetchClientHandle);

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
