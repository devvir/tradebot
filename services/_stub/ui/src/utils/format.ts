/**
 * Display formatting shared by the widgets.
 *
 * Prices are printed with a fixed number of decimals chosen from the data on
 * screen (`priceDecimals`), so every value in one table or readout lines up and
 * an instrument quoted in fractions of a unit keeps its significant digits.
 */

/** Most decimals a price is ever printed with. */
export const MAX_PRICE_DECIMALS = 8;

/** Quote currency of a contract symbol, e.g. `XBTUSD` → `USD`, `ETHUSDT` → `USDT`. */
export function quoteCurrency(symbol: string): string {
  if (symbol.endsWith('USDT')) return 'USDT';
  if (symbol.endsWith('USD'))  return 'USD';
  if (symbol.endsWith('XBT'))  return 'XBT';
  return symbol.slice(-3);
}

/** `value` with exactly `decimals` fraction digits and en-US thousands separators. */
export function fmtPrice(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Fraction digits needed to print every one of `values` exactly: the largest
 * number of significant fraction digits among them, capped at
 * MAX_PRICE_DECIMALS. Binary floating-point noise (0.1 + 0.2) does not count
 * as a digit. Non-finite values are ignored; no values yields 0.
 */
export function priceDecimals(values: Iterable<number>): number {
  let decimals = 0;

  for (const v of values) {
    if (! Number.isFinite(v)) {
      continue;
    }

    while (decimals < MAX_PRICE_DECIMALS && ! hasAtMost(v, decimals)) {
      decimals++;
    }
  }

  return decimals;
}

/**
 * True when `v` has no significant digits beyond the first `decimals` fraction
 * digits, allowing a few units of rounding error in the last binary place.
 */
function hasAtMost(v: number, decimals: number): boolean {
  const scaled = Math.abs(v) * 10 ** decimals;

  return Math.abs(scaled - Math.round(scaled)) <= scaled * 64 * Number.EPSILON;
}
