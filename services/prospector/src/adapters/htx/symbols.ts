/**
 * The old tree's names for instruments, in the spelling everything else uses.
 *
 * **`data/` joins the two halves of a name and `historical_data/` separates
 * them** — `BTCUSDT` against `BTC-USDT`, `ADA200807` against `ADA-USD-200807` —
 * so the same contract arrives under two names and its history splits in half at
 * the migration. The dashed form is canonical: it is what htx's own instrument
 * listing answers, what the offered tree writes, and what a person searches for.
 *
 * **Recovered by rule, never by looking the symbol up.** The joined form is
 * ambiguous in principle — `USDTRUB` is `USDT`/`RUB` or `USD`/`TRUB` depending
 * on what you believe is a currency — so the split needs a set of quotes to
 * match against, and matching the *longest* suffix is what makes it right rather
 * than lucky.
 *
 * **The set below is closed and complete.** `data/` stopped on 2026-08-04 and
 * htx has announced it will not resume, so the symbols it holds are all the
 * symbols it will ever hold: 2,309 spot pairs, every one of which this covers.
 * Nothing here consults the offered tree or the live listing — a rule that did
 * would change its mind as instruments come and go, and re-spell yesterday's
 * archive on a venue's whim.
 */
export const dashed = (market: string, symbol: string): string => {
  if (market === 'spot') return split(symbol) ?? symbol;

  /**
   * The coin-margined dated contracts, which name a contract by its base and
   * expiry alone — the offered tree spells the same thing `ADA-USD-200807`. They
   * settle in the coin against USD, so the quote is not a guess.
   *
   * The USDT-margined expiries reach here already dashed, from `linear-swap`,
   * and are left exactly as they are.
   */
  const dated = market === 'future' ? DATED.exec(symbol) : null;

  return dated ? `${dated[1]}-USD-${dated[2]}` : symbol;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** `ADA200807`, and never a symbol that already carries its quote. */
const DATED = /^([A-Z0-9]+?)(\d{6})$/;

/**
 * Every currency `data/` quotes a spot pair in, longest first so that the match
 * cannot stop early.
 *
 * **Read off the archive rather than chosen.** Each is a suffix that actually
 * occurs, and the two that look like mistakes are not: `USD1` is a stablecoin in
 * its own right, so `BTCUSD1` is not `BTCUSD` with a stray digit, and `EUROC` is
 * why `BTCEUROC` must not settle for the `EUR` inside it.
 */
const QUOTES = [
  'EUROC', 'USDT', 'USDC', 'USDD', 'USD1', 'TUSD', 'HUSD',
  'ARS', 'BRL', 'BTC', 'EOS', 'ETH', 'EUR', 'GBP', 'HPT', 'IDR',
  'JPY', 'KRW', 'RUB', 'THB', 'TRX', 'TRY', 'UAH', 'USD', 'UST',
  'HT',
].sort((a, b) => b.length - a.length);

/**
 * **The longest quote this name ends in**, and nothing if it ends in none.
 *
 * A base of nothing is not a split: `USDT` alone would otherwise become an empty
 * instrument quoted in itself.
 */
const split = (symbol: string): string | null => {
  for (const quote of QUOTES)
    if (symbol.length > quote.length && symbol.endsWith(quote))
      return `${symbol.slice(0, -quote.length)}-${quote}`;

  return null;
};
