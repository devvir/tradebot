/**
 * Reading okx's instrument listing into the catalog's vocabulary.
 *
 * **Nothing here builds a URL.** okx cannot be listed and its patterns are not
 * derived: they are seeded as literal strings — see `database/migrations/seeds`
 * — and generation substitutes a date and a symbol into whatever the series
 * carries. What is left is the translation the *listing* needs, since that is
 * the one okx surface still read at runtime.
 *
 * **`symbol` is the venue's name and the pattern takes the archive's.** They are
 * not always the same string: a futures family is served as
 * `<name>-futureschain` and an option family as `<name>-optionchain`, while the
 * plain name is *the spot pair of the same name*. That suffix is a constant of
 * the shape, so it lives in the pattern rather than beside the symbol.
 */

/**
 * Okx's own words for a market, in the catalog's.
 *
 * Okx shouts them, and its `SWAP` is what everyone else calls a perpetual.
 */
export const MARKET_OF: Record<string, string> = {
  SPOT:    'spot',
  SWAP:    'perp',
  FUTURES: 'future',
  OPTION:  'option',
};

/**
 * Whether okx lists this name only as a test pair.
 *
 * **The venue does not say so itself.** `XTESTA-USDT` and `XTESTA-USDC` come
 * back from `api/v5/public/instruments` with `state: 'live'` — okx documents a
 * `test` state and does not use it for these — while its full listing,
 * `priapi/v5/broker/public/trade-data/instruments`, omits them entirely. So the
 * state field cannot be filtered on, and the two sources disagree about whether
 * they exist.
 *
 * They publish nothing. Left in, each becomes a series per shape that is probed
 * for ever and never answers.
 *
 * Matched on the base rather than the pair, because the quote varies and the
 * base is what okx names them by: `XTESTA-*` in spot and margin, `TEST002-*`
 * among the futures families the catalog has held.
 */
export const isTestPair = (symbol: string): boolean =>
  /^X?TEST/.test(symbol.split('-')[0] ?? '');
