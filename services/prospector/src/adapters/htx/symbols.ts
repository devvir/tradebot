/**
 * The old tree's joined names, dashed: `BTCUSDT` to `BTC-USDT`, `ADA200807` to
 * `ADA-USD-200807`. By rule over a closed set of quotes, never by lookup — see
 * `docs/venues/HTX.md`.
 */
export const dashed = (market: string, symbol: string): string => {
  if (market === 'spot') return split(symbol) ?? symbol;

  /** A coin-margined dated contract names its base and expiry alone: the quote is `USD`. */
  const dated = market === 'future' ? DATED.exec(symbol) : null;

  return dated ? `${dated[1]}-USD-${dated[2]}` : symbol;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** `ADA200807`, and never a symbol that already carries its quote. */
const DATED = /^([A-Z0-9]+?)(\d{6})$/;

/** Every currency `data/` quotes a spot pair in, longest first so that the match cannot stop early. */
const QUOTES = [
  'EUROC', 'USDT', 'USDC', 'USDD', 'USD1', 'TUSD', 'HUSD',
  'ARS', 'BRL', 'BTC', 'EOS', 'ETH', 'EUR', 'GBP', 'HPT', 'IDR',
  'JPY', 'KRW', 'RUB', 'THB', 'TRX', 'TRY', 'UAH', 'USD', 'UST',
  'HT',
].sort((a, b) => b.length - a.length);

/** The longest quote a name ends in, where something is left in front of it. */
const split = (symbol: string): string | null => {
  for (const quote of QUOTES)
    if (symbol.length > quote.length && symbol.endsWith(quote))
      return `${symbol.slice(0, -quote.length)}-${quote}`;

  return null;
};
