/**
 * Okx's instrument listing, in the catalog's words. Nothing here builds a URL:
 * okx's patterns are seeded, and a chain's suffix belongs to the pattern.
 */

/** Okx's words for a market, in the catalog's: its `SWAP` is a perpetual. */
export const MARKET_OF: Record<string, string> = {
  SPOT:    'spot',
  SWAP:    'perp',
  FUTURES: 'future',
  OPTION:  'option',
};

/**
 * Whether okx lists a name only as a test pair. By its base, since okx marks them
 * no other way — see `docs/venues/OKX.md`.
 */
export const isTestPair = (symbol: string): boolean =>
  /^X?TEST/.test(symbol.split('-')[0] ?? '');
