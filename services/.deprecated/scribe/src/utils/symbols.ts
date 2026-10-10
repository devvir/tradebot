import type { components } from '@devvir/bitmex-api/types';
import type { RedisClient, FetchClientHandle } from '@devvir/service-kit';
import { registry, logger } from '@devvir/service-kit';

type Instrument = components['schemas']['Instrument'];
type Symbols = { indices: string[]; trading: string[]; inactive: Set<string> };

const PAGE_SIZE = 1000;

const INDICES_HASH = 'scribe:indices';
const SYMBOLS_HASH = 'scribe:symbols';

/**
 * BitMEX `.`-prefixed reference indices, ordered by their stable registration
 * ID (see {@link orderByRegistry}).
 */
export const getOrderedIndices = async (
  cache:   RedisClient,
  baseUrl: string,
): Promise<string[]> => {
  const { indices } = await fetchSymbols(baseUrl);

  return orderByRegistry(cache, INDICES_HASH, indices);
};

/**
 * Trading symbols (everything not a `.`-prefixed reference index), ordered by
 * their stable registration ID (see {@link orderByRegistry}). All states are
 * included — inactive/expired contracts still carry order-book history worth
 * collecting.
 */
export const getTradingSymbols = async (
  cache:   RedisClient,
  baseUrl: string,
): Promise<string[]> => {
  const { trading } = await fetchSymbols(baseUrl);

  return orderByRegistry(cache, SYMBOLS_HASH, trading);
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
  const trading  = all.filter(i => ! i.symbol.startsWith('.')).map(i => i.symbol);
  const inactive = new Set(all.filter(i => i.state !== 'Open').map(i => i.symbol));

  logger.info({ indices: indices.length, trading: trading.length, inactive: inactive.size }, 'Symbol list loaded');

  return { indices, trading, inactive };
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

/**
 * Order a symbol list by a stable registration ID held in a Redis hash. Any
 * symbol newly seen on BitMEX is assigned the next sequential ID and appended,
 * so existing symbols never change position — order is preserved across restarts
 * even as the set grows. This makes a day's output reproducible: re-fetching it
 * later (e.g. to diff against a baseline when validating a change) yields a
 * byte-identical file even if symbols listed in between.
 */
const orderByRegistry = async (
  cache:   RedisClient,
  hashKey: string,
  symbols: string[],
): Promise<string[]> => {
  const idMap = await registerSymbols(cache, hashKey, symbols);

  return [...symbols].sort((a, b) => (idMap.get(a) ?? 0) - (idMap.get(b) ?? 0));
};

const registerSymbols = async (
  cache:   RedisClient,
  hashKey: string,
  symbols: string[],
): Promise<Map<string, number>> => {
  const existing = await cache.hGetAll(hashKey) as Record<string, string>;
  const idMap    = new Map<string, number>(
    Object.entries(existing).map(([sym, id]) => [sym, Number(id)]),
  );

  const fresh = symbols.filter(s => ! idMap.has(s));

  let nextId = idMap.size > 0 ? Math.max(...idMap.values()) + 1 : 0;

  for (const symbol of fresh) {
    const id = nextId++;

    await cache.hSet(hashKey, symbol, String(id));
    idMap.set(symbol, id);
  }

  if (fresh.length > 0)
    logger.info({ hashKey, added: fresh.length, total: idMap.size }, 'Registered new symbols');

  return idMap;
};
